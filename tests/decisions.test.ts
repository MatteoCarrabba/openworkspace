import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import { ConfigError, ConflictError, NotFoundError } from "../src/lib/errors.js";
import {
  Decision,
  acceptDecision,
  decisionsDir,
  listDecisions,
  newDecision,
  showDecision,
  supersedeDecision,
  updateDecision,
} from "../src/primitives/decisions.js";
import { TmpStore, TmpWorkspace, makeTmpStore, makeTmpWorkspace } from "./helpers.js";

interface Env {
  ws: TmpWorkspace;
  storeBox: TmpStore;
  projectRoot: string;
}

// Spaces and a colon in the project path: first-class per test conventions.
function makeEnv(relPath = "Active Work/Demo: Project"): Env {
  const ws = makeTmpWorkspace();
  const storeBox = makeTmpStore();
  const { root } = ws.addProject(relPath);
  return { ws, storeBox, projectRoot: root };
}

function cleanupEnv(env: Env): void {
  env.ws.cleanup();
  env.storeBox.cleanup();
}

function mint(env: Env, title: string, extra: Partial<Parameters<typeof newDecision>[2]> = {}): Decision {
  return newDecision(env.projectRoot, env.storeBox.store, { title, ...extra });
}

test("new stamps the full template", (t) => {
  const env = makeEnv();
  t.after(() => cleanupEnv(env));

  const d = mint(env, "Adopt maildir for forum messages", { date: "2026-06-10" });

  assert.equal(d.id, "decision-1");
  assert.equal(d.status, "draft");
  assert.equal(d.title, "Adopt maildir for forum messages");
  assert.equal(d.date, "2026-06-10");
  assert.equal(d.supersededBy, null);
  assert.equal(d.filename, "decision-1 - Adopt maildir for forum messages.md");
  assert.equal(path.dirname(d.filePath), decisionsDir(env.projectRoot));

  const raw = fs.readFileSync(d.filePath, "utf8");
  assert.ok(raw.startsWith("---\n"));
  assert.match(raw, /^id: decision-1$/m);
  assert.match(raw, /^status: draft$/m);
  assert.match(raw, /^date: 2026-06-10$/m);
  assert.match(raw, /^superseded_by: null$/m);
  // body sections, in order
  const ctx = raw.indexOf("## Context");
  const dec = raw.indexOf("## Decision");
  const con = raw.indexOf("## Consequences");
  assert.ok(ctx > 0 && dec > ctx && con > dec);
});

test("new defaults date to today and supports the Expected line", (t) => {
  const env = makeEnv();
  t.after(() => cleanupEnv(env));

  const d = mint(env, "Try the new probe", { expected: "fewer collisions within a month" });
  assert.match(d.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(d.body, /## Consequences\n\nExpected: fewer collisions within a month\n/);
});

test("ids are sequential and dense across creations", (t) => {
  const env = makeEnv();
  t.after(() => cleanupEnv(env));

  const ids = ["a", "b", "c"].map((s) => mint(env, `Decision ${s}`).id);
  assert.deepEqual(ids, ["decision-1", "decision-2", "decision-3"]);
});

test("machine-suffixed minting still advances the shared sequence", (t) => {
  const env = makeEnv();
  t.after(() => cleanupEnv(env));

  mint(env, "From laptop");
  const onMini = mint(env, "From the Mini", { machineSuffix: "mini" });
  assert.equal(onMini.id, "decision-2-mini");
  assert.equal(mint(env, "Back on laptop").id, "decision-3");
});

test("slug strips path separators but keeps readable text", (t) => {
  const env = makeEnv();
  t.after(() => cleanupEnv(env));

  const d = mint(env, "Use a/b paths\\with care");
  assert.equal(d.filename, "decision-1 - Use a b paths with care.md");
  assert.equal(d.title, "Use a/b paths\\with care"); // frontmatter keeps the real title
});

test("new refuses a non-project directory", (t) => {
  const env = makeEnv();
  t.after(() => cleanupEnv(env));

  const notAProject = path.join(env.ws.root, "just-a-dir");
  fs.mkdirSync(notAProject);
  assert.throws(
    () => newDecision(notAProject, env.storeBox.store, { title: "nope" }),
    ConfigError,
  );
});

test("list returns records sorted by id with status filter; ignores strays", (t) => {
  const env = makeEnv();
  t.after(() => cleanupEnv(env));

  for (let i = 1; i <= 11; i++) mint(env, `Decision ${i}`);
  acceptDecision(env.projectRoot, "decision-3");
  fs.writeFileSync(path.join(decisionsDir(env.projectRoot), "notes.md"), "stray");
  fs.writeFileSync(path.join(decisionsDir(env.projectRoot), "task-1 - wrong kind.md"), "stray");

  const all = listDecisions(env.projectRoot);
  assert.equal(all.length, 11);
  // numeric order, not lexicographic (decision-2 before decision-11)
  assert.deepEqual(
    all.map((d) => d.id),
    Array.from({ length: 11 }, (_, i) => `decision-${i + 1}`),
  );
  assert.deepEqual(
    listDecisions(env.projectRoot, { status: "accepted" }).map((d) => d.id),
    ["decision-3"],
  );
  assert.equal(listDecisions(env.projectRoot, { status: "draft" }).length, 10);
});

test("list on a project with no decisions dir returns []", (t) => {
  const env = makeEnv();
  t.after(() => cleanupEnv(env));
  assert.deepEqual(listDecisions(env.projectRoot), []);
});

test("show resolves full ids and bare numbers; missing throws NotFound", (t) => {
  const env = makeEnv();
  t.after(() => cleanupEnv(env));

  mint(env, "Findable");
  assert.equal(showDecision(env.projectRoot, "decision-1").title, "Findable");
  assert.equal(showDecision(env.projectRoot, "1").title, "Findable");
  assert.throws(() => showDecision(env.projectRoot, "decision-99"), NotFoundError);
  assert.throws(() => showDecision(env.projectRoot, "totally-bogus"), ConfigError);
});

test("accept moves draft to accepted exactly once", (t) => {
  const env = makeEnv();
  t.after(() => cleanupEnv(env));

  mint(env, "To accept");
  const accepted = acceptDecision(env.projectRoot, "1");
  assert.equal(accepted.status, "accepted");
  assert.match(fs.readFileSync(accepted.filePath, "utf8"), /^status: accepted$/m);

  assert.throws(() => acceptDecision(env.projectRoot, "1"), ConflictError);
  assert.throws(() => acceptDecision(env.projectRoot, "99"), NotFoundError);
});

test("accept preserves hand-added frontmatter keys and body byte content", (t) => {
  const env = makeEnv();
  t.after(() => cleanupEnv(env));

  const d = mint(env, "Hand-annotated");
  // simulate a human edit: extra key with an inline comment + body content
  const handEdited = fs
    .readFileSync(d.filePath, "utf8")
    .replace("status: draft\n", "status: draft\nreviewed_by: matteo   # async\n")
    .replace("## Context\n", "## Context\n\nWe were here.\n");
  fs.writeFileSync(d.filePath, handEdited);

  acceptDecision(env.projectRoot, d.id);
  const after = fs.readFileSync(d.filePath, "utf8");
  assert.match(after, /^reviewed_by: matteo {3}# async$/m);
  assert.match(after, /We were here\./);
  assert.match(after, /^status: accepted$/m);
});

test("updateDecision edits drafts only", (t) => {
  const env = makeEnv();
  t.after(() => cleanupEnv(env));

  const d = mint(env, "Draft title");
  const updated = updateDecision(env.projectRoot, d.id, {
    title: "Sharper title",
    body: "\n## Context\n\nNow with content.\n\n## Decision\n\n## Consequences\n",
  });
  assert.equal(updated.title, "Sharper title");
  assert.match(updated.body, /Now with content\./);

  acceptDecision(env.projectRoot, d.id);
  assert.throws(
    () => updateDecision(env.projectRoot, d.id, { title: "Too late" }),
    ConflictError,
  );
  // file untouched by the refused edit
  assert.equal(showDecision(env.projectRoot, d.id).title, "Sharper title");
});

test("supersede stamps old record and points at the new one", (t) => {
  const env = makeEnv();
  t.after(() => cleanupEnv(env));

  mint(env, "Old way");
  mint(env, "New way");
  acceptDecision(env.projectRoot, "1");
  acceptDecision(env.projectRoot, "2");

  const old = supersedeDecision(env.projectRoot, "1", "2");
  assert.equal(old.status, "superseded");
  assert.equal(old.supersededBy, "decision-2");
  const raw = fs.readFileSync(old.filePath, "utf8");
  assert.match(raw, /^status: superseded$/m);
  assert.match(raw, /^superseded_by: decision-2$/m);
});

test("supersede refuses when the superseding record is missing", (t) => {
  const env = makeEnv();
  t.after(() => cleanupEnv(env));

  mint(env, "Standing");
  acceptDecision(env.projectRoot, "1");
  assert.throws(() => supersedeDecision(env.projectRoot, "1", "decision-7"), NotFoundError);
  assert.equal(showDecision(env.projectRoot, "1").status, "accepted"); // untouched
});

test("supersede refuses drafts, double-supersede, self, and missing old", (t) => {
  const env = makeEnv();
  t.after(() => cleanupEnv(env));

  mint(env, "Still a draft");
  mint(env, "Replacement");
  acceptDecision(env.projectRoot, "2");

  assert.throws(() => supersedeDecision(env.projectRoot, "1", "2"), ConflictError); // old is draft
  assert.throws(() => supersedeDecision(env.projectRoot, "2", "2"), ConflictError); // self
  assert.throws(() => supersedeDecision(env.projectRoot, "99", "2"), NotFoundError); // old missing

  mint(env, "Third way");
  acceptDecision(env.projectRoot, "3");
  // 2 was never accepted→superseded yet; do it, then refuse the second stamp
  acceptDecision(env.projectRoot, "1");
  supersedeDecision(env.projectRoot, "1", "2");
  assert.throws(() => supersedeDecision(env.projectRoot, "1", "3"), ConflictError);
  assert.equal(showDecision(env.projectRoot, "1").supersededBy, "decision-2"); // pointer kept
});

test("superseded records are immutable too", (t) => {
  const env = makeEnv();
  t.after(() => cleanupEnv(env));

  mint(env, "Old");
  mint(env, "New");
  acceptDecision(env.projectRoot, "1");
  acceptDecision(env.projectRoot, "2");
  supersedeDecision(env.projectRoot, "1", "2");

  assert.throws(() => updateDecision(env.projectRoot, "1", { title: "x" }), ConflictError);
  assert.throws(() => acceptDecision(env.projectRoot, "1"), ConflictError);
});

test("the decisions dir stays flat and scan writes nothing", (t) => {
  const env = makeEnv();
  t.after(() => cleanupEnv(env));

  mint(env, "One");
  mint(env, "Two");
  const dir = decisionsDir(env.projectRoot);
  const before = fs.readdirSync(dir).sort();
  listDecisions(env.projectRoot);
  showDecision(env.projectRoot, "1");
  assert.deepEqual(fs.readdirSync(dir).sort(), before);
  for (const name of before) {
    assert.ok(fs.statSync(path.join(dir, name)).isFile(), `${name} should be a flat file`);
  }
});
