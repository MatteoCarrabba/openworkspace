/**
 * The information map (OpenWorkspace decision-2): declared homes per
 * primitive in project.toml [map], rendered README/AGENTS sections, doctor
 * checks, the native commands' redirect behavior — and backward
 * compatibility for legacy projects (no [map]) that must keep working
 * exactly as before.
 */

import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import { scanWorkspace } from "../src/dashboard/server.js";
import { LEGACY_MAP_NOTICE, doctorProject, doctorWorkspace } from "../src/doctor.js";
import {
  FORUM_README,
  PLAN_STUB,
  PROJECT_GITIGNORE,
  initProject,
  initWorkspace,
  pruneEmptyStores,
} from "../src/init.js";
import {
  MAP_BEGIN,
  MAP_END,
  applyMapSection,
  checkMapDocs,
  nativeStoreState,
  readInfoMap,
  renderMapDocs,
  renderMapSection,
  writeMapEntry,
} from "../src/lib/infomap.js";
import { readOwns, writeDeclaredLifecycle, writeOwns, openWorkspace } from "../src/lib/workspace.js";
import * as tasks from "../src/primitives/tasks.js";
import { makeTmpDir, makeTmpStore, rmrf } from "./helpers.js";

const CLI = path.resolve(__dirname, "..", "src", "cli.js");

function run(args: string[], cwd: string, storeDir: string): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, OPENWORKSPACE_STORE_DIR: storeDir, OW_ACTOR: "map-test" },
  });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

/** A project exactly as the pre-decision-2 `projects init` stamped it (full skeleton, no project.toml). */
function legacySkeleton(dir: string): void {
  const p = path.join(dir, "_project");
  for (const d of ["plans", "tasks", "wiki", "decisions", "automations", "forum/threads", "forum/presence"]) {
    fs.mkdirSync(path.join(p, d), { recursive: true });
  }
  fs.writeFileSync(path.join(p, "id"), "legacy-uid-0001\n");
  fs.writeFileSync(path.join(p, ".gitignore"), PROJECT_GITIGNORE);
  fs.writeFileSync(path.join(p, "README.md"), "# _project/ — the pre-decision-2 orientation file\n");
  fs.writeFileSync(path.join(p, "plans", "current.md"), PLAN_STUB);
  fs.writeFileSync(path.join(p, "forum", "README.md"), FORUM_README);
}

function messages(dir: string): string[] {
  return doctorProject(dir).map((i) => `${i.severity}: ${i.message}`);
}

// ---------------------------------------------------------------------------
// Reading the map

test("infomap: a legacy project (no [map]) is all-native and unenforced", (t) => {
  const tmp = makeTmpDir();
  t.after(() => rmrf(tmp));
  legacySkeleton(tmp);
  const map = readInfoMap(tmp);
  assert.equal(map.declared, false);
  assert.deepEqual(
    map.entries.map((e) => [e.key, e.kind, e.source]),
    [
      ["tasks", "native", "legacy"],
      ["decisions", "native", "legacy"],
      ["wiki", "native", "legacy"],
      ["plans", "native", "legacy"],
      ["forum", "native", "legacy"],
    ],
  );
  // doctor: one info notice, no new warnings/errors (empty legacy stores are NOT flagged)
  assert.deepEqual(messages(tmp), [`info: ${LEGACY_MAP_NOTICE}`]);
  // a project.toml with only lifecycle/owns is still legacy
  writeDeclaredLifecycle(tmp, "dormant", null);
  assert.equal(readInfoMap(tmp).declared, false);
});

test("infomap: shorthand + table entries parse; inference keeps existing stores native", (t) => {
  const tmp = makeTmpDir();
  t.after(() => rmrf(tmp));
  fs.mkdirSync(path.join(tmp, "_project", "decisions"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "_project", "decisions", "decision-1 - x.md"), "---\nid: decision-1\n---\n");
  fs.writeFileSync(
    path.join(tmp, "_project", "project.toml"),
    [
      'lifecycle = "dormant"',
      "[map]",
      'wiki = "https://docs.example.com/acme"',
      'forum = "none"',
      "[map.tasks]",
      'system = "GitHub Issues"',
      'url = "https://github.com/acme/widget/issues"',
      'locator = "acme/widget"',
      "[map.credentials]",
      'system = "1Password"',
      'locator = "vault Acme"',
      "",
    ].join("\n"),
  );
  const map = readInfoMap(tmp);
  assert.equal(map.declared, true);
  assert.deepEqual(map.problems, []);
  const byKey = Object.fromEntries(map.entries.map((e) => [e.key, e]));
  assert.equal(byKey["tasks"]?.kind, "external");
  assert.equal(byKey["tasks"]?.system, "GitHub Issues");
  assert.equal(byKey["decisions"]?.kind, "native"); // undeclared but the store exists
  assert.equal(byKey["decisions"]?.source, "inferred");
  assert.equal(byKey["wiki"]?.kind, "external");
  assert.equal(byKey["wiki"]?.system, "docs.example.com");
  assert.equal(byKey["plans"]?.kind, "undeclared");
  assert.equal(byKey["forum"]?.kind, "none");
  assert.equal(byKey["credentials"]?.core, false);
  assert.equal(byKey["credentials"]?.label, "Credentials");
  // core primitives first in fixed order, then extras
  assert.deepEqual(map.entries.map((e) => e.key), ["tasks", "decisions", "wiki", "plans", "forum", "credentials"]);
});

test("infomap: malformed entries are problems (doctor errors), never throws", (t) => {
  const tmp = makeTmpDir();
  t.after(() => rmrf(tmp));
  fs.mkdirSync(path.join(tmp, "_project"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "_project", "id"), "u\n");
  fs.writeFileSync(
    path.join(tmp, "_project", "project.toml"),
    '[map]\ntasks = "teamwork"\nvault = "native"\n[map.wiki]\nhome = "somewhere"\n[map.plans]\nnote = "x"\n',
  );
  const map = readInfoMap(tmp);
  assert.equal(map.problems.length, 4);
  const errs = doctorProject(tmp).filter((i) => i.severity === "error");
  assert.equal(errs.length, 4);
  assert.ok(errs.every((e) => /information map: map\./.test(e.message)));
});

// ---------------------------------------------------------------------------
// Writing + rendering

test("infomap: writeMapEntry preserves lifecycle and [[owns]]", (t) => {
  const tmp = makeTmpDir();
  t.after(() => rmrf(tmp));
  fs.mkdirSync(path.join(tmp, "_project"), { recursive: true });
  writeDeclaredLifecycle(tmp, "dormant", "2026-10-01T00:00:00Z");
  writeOwns(tmp, [{ ref: "~/Code/x", kind: "code", name: "x", lifecycle: null }]);
  writeMapEntry(tmp, "tasks", { kind: "external", system: "Teamwork", url: "https://acme.teamwork.com/app/projects/1" });
  writeMapEntry(tmp, "wiki", { kind: "native" });
  writeMapEntry(tmp, "plans", { kind: "none", note: "plans live in the tasks" });
  assert.equal(readOwns(tmp).owns.length, 1);
  const text = fs.readFileSync(path.join(tmp, "_project", "project.toml"), "utf8");
  assert.match(text, /^lifecycle = "dormant"$/m);
  assert.match(text, /^wiki = "native"$/m);
  const map = readInfoMap(tmp);
  assert.equal(map.entries.find((e) => e.key === "plans")?.note, "plans live in the tasks");
  writeMapEntry(tmp, "wiki", null);
  assert.equal(readInfoMap(tmp).entries.find((e) => e.key === "wiki")?.kind, "undeclared");
  assert.throws(() => writeMapEntry(tmp, "vault", { kind: "native" }), /no native store/);
  assert.throws(() => writeMapEntry(tmp, "render_to", { kind: "none" }), /invalid map key/);
});

test("infomap: rendering is idempotent and leaves hand-written text alone", (t) => {
  const tmp = makeTmpDir();
  t.after(() => rmrf(tmp));
  fs.mkdirSync(path.join(tmp, "_project"), { recursive: true });
  const intro = "# Widget\n\nHand-written intro.\n";
  const outro = "\n## Development\n\nnpm test\n";
  fs.writeFileSync(path.join(tmp, "README.md"), intro);
  writeMapEntry(tmp, "tasks", { kind: "external", system: "GitHub Issues", url: "https://github.com/a/b/issues" });

  const first = renderMapDocs(tmp);
  assert.deepEqual(first.map((r) => [r.file, r.created, r.changed]), [
    ["README.md", false, true],
    ["AGENTS.md", true, true],
  ]);
  // hand-written text after the block survives a re-render byte-for-byte
  fs.appendFileSync(path.join(tmp, "README.md"), outro);
  const before = fs.readFileSync(path.join(tmp, "README.md"), "utf8");
  assert.ok(before.startsWith(intro));
  assert.deepEqual(renderMapDocs(tmp).map((r) => r.changed), [false, false]);
  assert.equal(fs.readFileSync(path.join(tmp, "README.md"), "utf8"), before);
  assert.deepEqual(checkMapDocs(tmp).map((d) => d.state), ["ok", "ok"]);

  // a map change makes the docs stale; re-render replaces only the block
  writeMapEntry(tmp, "forum", { kind: "none" });
  assert.deepEqual(checkMapDocs(tmp).map((d) => d.state), ["stale", "stale"]);
  renderMapDocs(tmp);
  const after = fs.readFileSync(path.join(tmp, "README.md"), "utf8");
  assert.ok(after.startsWith(intro) && after.endsWith(outro), "text around the block preserved");
  assert.match(after, /\*\*Coordination \(forum\):\*\* not used/);
  assert.equal(after.split(MAP_BEGIN).length, 2, "exactly one block");
  assert.equal(after.split(MAP_END).length, 2);

  // pure function: applying the same section twice is a fixed point
  const section = renderMapSection(readInfoMap(tmp));
  assert.equal(applyMapSection(after, section), after);
});

test("infomap: render_to overrides the target docs", (t) => {
  const tmp = makeTmpDir();
  t.after(() => rmrf(tmp));
  fs.mkdirSync(path.join(tmp, "_project"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "_project", "project.toml"), '[map]\nrender_to = ["CLAUDE.md"]\ntasks = "native"\n');
  assert.deepEqual(renderMapDocs(tmp).map((r) => r.file), ["CLAUDE.md"]);
  assert.ok(!fs.existsSync(path.join(tmp, "README.md")));
});

// ---------------------------------------------------------------------------
// Doctor

test("doctor: map-mode checks — homes, empty stores, leftover records, pointers, docs", (t) => {
  const tmp = makeTmpDir();
  t.after(() => rmrf(tmp));
  legacySkeleton(tmp); // every store present; only tasks gets content
  fs.writeFileSync(path.join(tmp, "_project", "tasks", "task-1 - a.md"), "---\nid: task-1\nstatus: todo\n---\n");
  writeMapEntry(tmp, "tasks", { kind: "external", system: "GitHub Issues", url: "https://github.com/a/b/issues" });
  writeMapEntry(tmp, "decisions", { kind: "external", system: "repo", path: "docs/adr" }); // missing path
  writeMapEntry(tmp, "wiki", { kind: "external", system: "Wiki", url: "https://" }); // malformed URL
  writeMapEntry(tmp, "plans", { kind: "native" });
  writeMapEntry(tmp, "notes", { kind: "external", system: "Notion" }); // a system but no where

  const msgs = messages(tmp);
  const has = (re: RegExp) => assert.ok(msgs.some((m) => re.test(m)), `expected ${re} in:\n${msgs.join("\n")}`);
  has(/^warn: Coordination \(forum\): no declared home; inferred native from the existing _project\/forum\//);
  has(/^warn: Tasks & backlog home is GitHub Issues .* still holds 1 record\(s\)/);
  has(/^warn: empty native store \(the home is repo/); // decisions/ empty, homed elsewhere
  has(/^warn: empty native store \(native stores are created on first write\)/); // plans stub only
  has(/^warn: information map: map\.decisions: path does not exist: docs\/adr/);
  has(/^warn: information map: map\.wiki: url (is not well-formed|has no host)/);
  has(/^warn: information map: map\.notes: names a system \(Notion\) but no url, locator or path/);
  has(/^warn: file missing — run `projects map render`/);
  assert.ok(!msgs.some((m) => m.startsWith("error:")), msgs.join("\n"));

  // fixing the docs clears exactly the doc findings
  renderMapDocs(tmp);
  assert.ok(!messages(tmp).some((m) => /projects map render/.test(m)));
  // a hand edit inside the block is "stale"
  const readme = path.join(tmp, "README.md");
  fs.writeFileSync(readme, fs.readFileSync(readme, "utf8").replace("GitHub Issues", "GitLab"));
  assert.ok(messages(tmp).some((m) => /README\.md|section is stale/.test(m)));
});

test("doctor: workspace aggregates legacy projects into ONE info line — no new errors or warnings", (t) => {
  const tmp = makeTmpDir();
  t.after(() => rmrf(tmp));
  initWorkspace(tmp);
  for (const name of ["Old A", "Old B"]) {
    const dir = path.join(tmp, name);
    legacySkeleton(dir);
    fs.writeFileSync(path.join(dir, "_project", "id"), `uid-${name.replace(" ", "")}\n`);
  }
  const ws = openWorkspace(tmp);
  const rep = doctorWorkspace(ws);
  assert.equal(rep.errors, 0);
  assert.equal(rep.warnings, 0);
  const infos = rep.issues.filter((i) => i.severity === "info");
  assert.equal(infos.length, 1);
  assert.match(infos[0]?.message ?? "", /^2 project\(s\) declare no information map/);
});

// ---------------------------------------------------------------------------
// Pruning the old skeleton

test("pruneEmptyStores removes only stub-only stores", (t) => {
  const tmp = makeTmpDir();
  t.after(() => rmrf(tmp));
  legacySkeleton(tmp);
  fs.writeFileSync(path.join(tmp, "_project", "wiki", "notes.md"), "real content\n");
  fs.writeFileSync(path.join(tmp, "_project", "plans", "current.md"), PLAN_STUB + "\nWe ship in Q4.\n");
  assert.deepEqual(pruneEmptyStores(tmp, { dryRun: true }), [
    "_project/tasks/",
    "_project/decisions/",
    "_project/forum/",
    "_project/automations/",
  ]);
  assert.ok(fs.existsSync(path.join(tmp, "_project", "tasks")), "dry run writes nothing");
  pruneEmptyStores(tmp);
  for (const gone of ["tasks", "decisions", "forum", "automations"]) {
    assert.ok(!fs.existsSync(path.join(tmp, "_project", gone)), gone);
  }
  assert.equal(nativeStoreState(tmp, "wiki"), "populated");
  assert.equal(nativeStoreState(tmp, "plans"), "populated");
});

// ---------------------------------------------------------------------------
// CLI

function cliFixture(t: { after: (fn: () => void) => void }): { root: string; storeDir: string } {
  const root = makeTmpDir("ow-map-ws-");
  const storeDir = makeTmpDir("ow-map-store-");
  t.after(() => {
    rmrf(root);
    rmrf(storeDir);
  });
  assert.equal(run(["home", "init"], root, storeDir).status, 0);
  return { root, storeDir };
}

test("cli: a primitive homed externally redirects — reads print the pointer, creates exit 3 and write nothing", (t) => {
  const { root, storeDir } = cliFixture(t);
  const made = run(
    ["new", "Widget", "--native", "wiki", "--home", "tasks=https://github.com/acme/widget/issues", "--home", "forum=none"],
    root,
    storeDir,
  );
  assert.equal(made.status, 0, made.stderr);
  assert.match(made.stdout, /rendered into README\.md, AGENTS\.md/);
  assert.match(made.stdout, /no declared home yet for: decisions, plans/);
  const proj = path.join(root, "Widget");
  assert.ok(!fs.existsSync(path.join(proj, "_project", "tasks")), "nothing scaffolded");
  assert.ok(!fs.existsSync(path.join(proj, "_project", "wiki")), "native stores appear on first write");

  const create = run(["task", "create", "Fix it"], proj, storeDir);
  assert.equal(create.status, 3, create.stderr);
  assert.match(create.stderr, /Tasks & backlog for Widget live in GitHub Issues — https:\/\/github\.com\/acme\/widget\/issues/);
  assert.doesNotMatch(create.stderr, /^error:/);
  assert.ok(!fs.existsSync(path.join(proj, "_project", "tasks")), "no native file written");

  const list = run(["task", "list"], proj, storeDir);
  assert.equal(list.status, 0);
  assert.match(list.stdout, /live in GitHub Issues/);
  const listJson = run(["task", "list", "--json"], proj, storeDir);
  assert.equal(listJson.status, 0);
  assert.deepEqual(JSON.parse(listJson.stdout), []); // JSON shape unchanged for scripts
  assert.match(listJson.stderr, /live in GitHub Issues/);

  // forum = none: posting refuses, presence is a quiet no-op
  assert.equal(run(["forum", "open", "Thread"], proj, storeDir).status, 3);
  const announce = run(["forum", "announce", "--doing", "x"], proj, storeDir);
  assert.equal(announce.status, 0);
  assert.match(announce.stdout, /declares no coordination \(forum\) home/);
  assert.ok(!fs.existsSync(path.join(proj, "_project", "forum")));

  // an UNDECLARED primitive still writes natively (with a nudge) — scripts keep working
  const dec = run(["decision", "new", "Use TOML"], proj, storeDir);
  assert.equal(dec.status, 0, dec.stderr);
  assert.match(dec.stderr, /declares no home for decisions; writing to the native store/);
  assert.equal(readInfoMap(proj).entries.find((e) => e.key === "decisions")?.source, "inferred");

  // the plan is undeclared and absent: plan show keeps its old not-found behavior
  assert.equal(run(["plan", "show"], proj, storeDir).status, 1);
  assert.equal(run(["map", "set", "plans", "none"], proj, storeDir).status, 0);
  const plan = run(["plan", "show"], proj, storeDir);
  assert.equal(plan.status, 0);
  assert.match(plan.stdout, /declares no plans home/);
});

test("cli: map set/show/unset/render keep project.toml and the docs in step", (t) => {
  const { root, storeDir } = cliFixture(t);
  assert.equal(run(["new", "Gadget"], root, storeDir).status, 0);
  const proj = path.join(root, "Gadget");
  fs.writeFileSync(path.join(proj, "README.md"), "# Gadget\n\nOur gadget.\n");

  const set = run(
    ["map", "set", "tasks", "--system", "Teamwork", "--url", "https://acme.teamwork.com/app/projects/42", "--locator", "Gadget"],
    proj,
    storeDir,
  );
  assert.equal(set.status, 0, set.stderr);
  assert.match(set.stdout, /map\.tasks → Teamwork — https:\/\/acme\.teamwork\.com\/app\/projects\/42 · Gadget/);
  assert.match(set.stdout, /rendered into README\.md, AGENTS\.md/);
  const readme = fs.readFileSync(path.join(proj, "README.md"), "utf8");
  assert.ok(readme.startsWith("# Gadget\n\nOur gadget.\n"));
  assert.match(readme, /- \*\*Tasks & backlog:\*\* Teamwork — <https:\/\/acme\.teamwork\.com\/app\/projects\/42> · `Gadget`/);

  assert.equal(run(["map", "set", "vault", "--system", "1Password", "--locator", "vault Acme", "--label", "Credentials"], proj, storeDir).status, 0);
  for (const k of ["decisions", "wiki", "plans"]) assert.equal(run(["map", "set", k, "native"], proj, storeDir).status, 0);
  assert.equal(run(["map", "set", "forum", "none"], proj, storeDir).status, 0);
  assert.equal(run(["map", "set", "vault", "native"], proj, storeDir).status, 1); // extras have no native store

  const show = run(["map", "show", "--json"], proj, storeDir);
  const view = JSON.parse(show.stdout) as { declared: boolean; entries: Array<{ key: string; kind: string; store: string | null }> };
  assert.equal(view.declared, true);
  assert.deepEqual(view.entries.map((e) => [e.key, e.kind]), [
    ["tasks", "external"],
    ["decisions", "native"],
    ["wiki", "native"],
    ["plans", "native"],
    ["forum", "none"],
    ["vault", "external"],
  ]);
  const doctor = run(["doctor"], proj, storeDir);
  assert.equal(doctor.status, 0);
  assert.match(doctor.stdout, /doctor: no findings/);

  // render is idempotent from the CLI too
  const render = run(["map", "render"], proj, storeDir);
  assert.match(render.stdout, /README\.md: unchanged\nAGENTS\.md: unchanged/);

  assert.equal(run(["map", "unset", "vault"], proj, storeDir).status, 0);
  assert.doesNotMatch(fs.readFileSync(path.join(proj, "AGENTS.md"), "utf8"), /1Password/);

  // projects show includes the map
  const projShow = run(["show"], proj, storeDir);
  assert.match(projShow.stdout, /Where information lives — Gadget/);
});

test("cli: map adopt converts a legacy project — dry-run first, then --apply --prune-empty", (t) => {
  const { root, storeDir } = cliFixture(t);
  const proj = path.join(root, "Legacy");
  legacySkeleton(proj);
  const store = makeTmpStore();
  t.after(store.cleanup);
  tasks.createTask(proj, store.store, { title: "Existing work" });
  fs.writeFileSync(path.join(proj, "README.md"), "# Legacy\n");

  // legacy: task create still works natively, no nudge
  const legacyCreate = run(["task", "create", "Another"], proj, storeDir);
  assert.equal(legacyCreate.status, 0, legacyCreate.stderr);
  assert.equal(legacyCreate.stderr, "");

  const before = fs.readdirSync(path.join(proj, "_project")).sort();
  const dry = run(["map", "adopt", "--prune-empty"], proj, storeDir);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /would declare tasks = native/);
  assert.match(dry.stdout, /would remove empty store _project\/wiki\//);
  assert.match(dry.stdout, /still to decide .*: decisions, wiki, plans, forum/);
  assert.deepEqual(fs.readdirSync(path.join(proj, "_project")).sort(), before, "dry run writes nothing");
  assert.ok(!fs.existsSync(path.join(proj, "_project", "project.toml")));

  const apply = run(["map", "adopt", "--apply", "--prune-empty"], proj, storeDir);
  assert.equal(apply.status, 0, apply.stderr);
  assert.deepEqual(fs.readdirSync(path.join(proj, "_project")).sort(), [".gitignore", "README.md", "id", "project.toml", "tasks"]);
  const map = readInfoMap(proj);
  assert.equal(map.declared, true);
  assert.equal(map.entries.find((e) => e.key === "tasks")?.source, "declared");
  assert.ok(fs.readFileSync(path.join(proj, "README.md"), "utf8").startsWith("# Legacy\n"));
  // the remaining doctor findings are exactly the four undecided homes
  const findings = doctorProject(proj).map((i) => i.message.replace(/:.*$/, ""));
  assert.deepEqual(findings, ["Decisions", "Knowledge (wiki)", "Plans", "Coordination (forum)"]);
  // and existing records are untouched and still usable
  const list = run(["task", "list", "--json"], proj, storeDir);
  assert.equal((JSON.parse(list.stdout) as unknown[]).length, 2);
});

// ---------------------------------------------------------------------------
// Dashboard

test("dashboard: the scan carries the declared map (null for legacy projects)", (t) => {
  const tmp = makeTmpDir();
  t.after(() => rmrf(tmp));
  initWorkspace(tmp);
  legacySkeleton(path.join(tmp, "Old"));
  initProject(path.join(tmp, "New"), {
    native: ["wiki"],
    homes: { tasks: { kind: "external", system: "GitHub Issues", url: "https://github.com/a/b/issues" } },
  });
  const scan = scanWorkspace(openWorkspace(tmp));
  const byName = Object.fromEntries(scan.projects.map((p) => [p.name, p]));
  assert.equal(byName["Old"]?.map, null);
  const tasksHome = byName["New"]?.map?.find((e) => e.key === "tasks");
  assert.equal(tasksHome?.kind, "external");
  assert.equal(tasksHome?.url, "https://github.com/a/b/issues");
});
