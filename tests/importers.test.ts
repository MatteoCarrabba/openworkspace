/**
 * Importer tests (PRD §11 step 4) — run against the REAL legacy fixtures in
 * tests/fixtures/ (byte-precious: always copied into temp dirs, never
 * touched). Covers (a) tasks state fidelity, (b) reminders → tasks,
 * (c) dirchannels → forum, dry-run/apply parity, ID seeding above the legacy
 * max, and the hard idempotency requirement (apply twice → zero changes).
 */

import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import {
  ImportPlan,
  applyLegacyImport,
  executePlan,
  findLegacySources,
  planLegacyImport,
  renderPlan,
} from "../src/importers.js";
import { parseRecord, readRecord, serializeRecord } from "../src/lib/frontmatter.js";
import { createTask } from "../src/primitives/tasks.js";
import { FIXTURES_DIR, fixturePath, makeTmpStore, makeTmpWorkspace } from "./helpers.js";

// ---------------------------------------------------------------------------
// Staging helpers
// ---------------------------------------------------------------------------

const SYNTH_PROMOTED = `---
id: REMINDER-99
surface_on: 2026-06-20
surface_to: brief
status: promoted
created: 2026-06-04T10:00:00-07:00
created_by: agent
fired_at: 2026-06-20T08:00:00-07:00
promoted_to_task: TASK-140
recur: weekly
recur_until: null
---

# Synthetic promoted reminder

Body text for the synthetic promoted case (no promoted record exists in the
real corpus — this is the documented synthetic).

## then
Do the thing.
`;

const SYNTH_PENDING_DAILY = `---
id: REMINDER-98
surface_on: 2026-07-01
status: pending
created: 2026-06-04T10:00:00-07:00
recur: daily
---

# Synthetic daily reminder

Tests the daily → every-1-days recur mapping.
`;

interface Staged {
  root: string; // project root (colon-and-space path)
  uid: string;
  cleanup: () => void;
}

/** Stage the real fixture corpus as a legacy project (live `_tasks`/`_dirchannel`). */
function stageProject(options: { underArchiveStamp?: string } = {}): Staged {
  const tw = makeTmpWorkspace();
  const proj = tw.addProject("Imp: Proj A");
  const base =
    options.underArchiveStamp !== undefined
      ? path.join(proj.root, "_project", "archive", "legacy-imports", options.underArchiveStamp)
      : proj.root;

  // (a) tasks: everything live except task-1 (→ legacy archive) and
  // task-13 (→ legacy completed/) so both archived routes are exercised.
  const tasksDir = path.join(base, "_tasks", "tasks");
  const legacyArchive = path.join(base, "_tasks", "archive", "tasks");
  const legacyCompleted = path.join(base, "_tasks", "completed");
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.mkdirSync(legacyArchive, { recursive: true });
  fs.mkdirSync(legacyCompleted, { recursive: true });
  for (const name of fs.readdirSync(path.join(FIXTURES_DIR, "tasks"))) {
    if (!name.endsWith(".md")) continue;
    const src = fixturePath("tasks", name);
    const dest = name.startsWith("task-1 ")
      ? path.join(legacyArchive, name)
      : name.startsWith("task-13 ")
        ? path.join(legacyCompleted, name)
        : path.join(tasksDir, name);
    fs.copyFileSync(src, dest);
  }
  // tool internals that must be listed as skipped and left untouched
  fs.writeFileSync(path.join(base, "_tasks", "config.yml"), "projectName: legacy\n");
  fs.mkdirSync(path.join(base, "_tasks", ".locks"), { recursive: true });

  // (b) reminders: pending live, dismissed under _archived/, plus the two
  // synthetics (promoted + daily-recur pending).
  const remDir = path.join(base, "_tasks", "reminders");
  const remArchived = path.join(remDir, "_archived");
  fs.mkdirSync(remArchived, { recursive: true });
  for (const name of fs.readdirSync(path.join(FIXTURES_DIR, "reminders"))) {
    if (!name.endsWith(".md")) continue;
    const rec = readRecord(fixturePath("reminders", name));
    const dest = rec.data["status"] === "dismissed" ? remArchived : remDir;
    fs.copyFileSync(fixturePath("reminders", name), path.join(dest, name));
  }
  fs.writeFileSync(path.join(remArchived, "reminder-99 - 2026-06-20 - synthetic-promoted.md"), SYNTH_PROMOTED);
  fs.writeFileSync(path.join(remDir, "reminder-98 - 2026-07-01 - synthetic-daily.md"), SYNTH_PENDING_DAILY);

  // (c) dirchannel: the real fixture channels + tool-state files that must
  // be skipped untouched.
  const dch = path.join(base, "_dirchannel");
  fs.cpSync(fixturePath("dirchannel"), dch, { recursive: true });
  fs.writeFileSync(path.join(dch, "db.sqlite"), "not really sqlite");
  fs.writeFileSync(path.join(dch, "token"), "secret-token");
  fs.writeFileSync(path.join(dch, "claude-bridge.state.json"), "{}");

  return { root: proj.root, uid: proj.uid, cleanup: tw.cleanup };
}

function actionsOf(plan: ImportPlan, kind: string) {
  return plan.actions.filter((a) => a.kind === kind);
}

function findTaskFile(dir: string, idPrefix: string): string {
  const hit = fs.readdirSync(dir).find((n) => n.startsWith(`${idPrefix} `));
  assert.ok(hit !== undefined, `no file starting with "${idPrefix} " in ${dir}`);
  return path.join(dir, hit);
}

/** content-hash snapshot of a whole tree (for the idempotency proof). */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else out.set(path.relative(dir, p), crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"));
    }
  };
  walk(dir);
  return out;
}

// ---------------------------------------------------------------------------
// (a) tasks — state fidelity
// ---------------------------------------------------------------------------

test("import(a): legacy statuses map To Do/In Progress/Done/Final Review → todo/doing/done/review", (t) => {
  const st = stageProject();
  t.after(st.cleanup);
  const plan = planLegacyImport(st.root);
  assert.deepEqual(plan.errors, []);

  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);
  applyLegacyImport(st.root, store);

  const live = path.join(st.root, "_project", "tasks");
  const expectations: Array<[string, string]> = [
    ["task-103", "todo"], // To Do
    ["task-127", "done"], // Done
  ];
  for (const [id, status] of expectations) {
    const rec = readRecord(findTaskFile(live, id));
    assert.equal(rec.data["status"], status, id);
    assert.equal(rec.data["id"], id, `${id}: id normalized to native lowercase`);
  }
  // the fixture corpus carries one In Progress and one Final Review record
  const all = fs.readdirSync(live).filter((n) => n.endsWith(".md"));
  const statuses = all.map((n) => readRecord(path.join(live, n)).data["status"]);
  assert.ok(statuses.includes("doing"), "In Progress → doing");
  assert.ok(statuses.includes("review"), "Final Review → review");
  // native vocabulary only — nothing legacy survives
  for (const s of statuses) {
    assert.ok(["todo", "doing", "waiting", "review", "done"].includes(String(s)), String(s));
  }
});

test("import(a): archived legacy records (archive/tasks + completed) land in tasks/archive/", (t) => {
  const st = stageProject();
  t.after(st.cleanup);
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);
  applyLegacyImport(st.root, store);

  const archive = path.join(st.root, "_project", "tasks", "archive");
  const task1 = readRecord(findTaskFile(archive, "task-1"));
  assert.equal(task1.data["status"], "done"); // was Done in _tasks/archive/tasks/
  const task13 = readRecord(findTaskFile(archive, "task-13"));
  assert.equal(task13.data["status"], "todo"); // was To Do in _tasks/completed/
});

test("import(a): bodies byte-preserved; unknown keys preserved; created/updated mapped", (t) => {
  const st = stageProject();
  t.after(st.cleanup);
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);
  applyLegacyImport(st.root, store);

  const srcName = fs
    .readdirSync(path.join(FIXTURES_DIR, "tasks"))
    .find((n) => n.startsWith("task-13 ")) as string;
  const src = readRecord(fixturePath("tasks", srcName));
  const out = readRecord(findTaskFile(path.join(st.root, "_project", "tasks", "archive"), "task-13"));

  assert.equal(out.body, src.body, "body byte-preserved through the codec");
  // unknown legacy keys preserved verbatim
  assert.deepEqual(out.data["labels"], ["agent-task"]);
  assert.equal(out.data["priority"], "low");
  assert.equal(out.data["ordinal"], 13000);
  assert.deepEqual(out.data["dependencies"], []);
  // created_date/updated_date → the native created/updated, values verbatim
  assert.equal(out.data["created"], src.data["created_date"]);
  assert.equal(out.data["updated"], src.data["updated_date"]);
  assert.equal(out.data["created_date"], undefined);
  assert.equal(out.data["updated_date"], undefined);
  // quadrant lowercased to the native vocabulary
  assert.equal(out.data["quadrant"], "q4");
});

test("import(a): parent_task_id agreeing with the dotted ID is normalized away; disagreement is a plan error", (t) => {
  const st = stageProject();
  t.after(st.cleanup);
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);
  applyLegacyImport(st.root, store);

  const out = readRecord(findTaskFile(path.join(st.root, "_project", "tasks"), "task-18.2"));
  assert.equal(out.data["id"], "task-18.2");
  assert.equal(out.data["parent_task_id"], undefined, "parentage lives in the ID alone");

  // disagreement: parent_task_id that contradicts the dotted ID
  const st2 = stageProject();
  t.after(st2.cleanup);
  fs.writeFileSync(
    path.join(st2.root, "_tasks", "tasks", "task-50.2 - disagrees.md"),
    "---\nid: TASK-50.2\ntitle: Disagrees\nstatus: To Do\nparent_task_id: TASK-49\n---\n\nBody.\n",
  );
  const plan2 = planLegacyImport(st2.root);
  assert.ok(
    plan2.errors.some((e) => e.includes("task-50.2") && e.includes("disagrees")),
    plan2.errors.join("\n"),
  );
  // an un-dotted id with a declared parent is a disagreement too
  fs.writeFileSync(
    path.join(st2.root, "_tasks", "tasks", "task-51 - undotted-parent.md"),
    "---\nid: TASK-51\ntitle: Undotted\nstatus: To Do\nparent_task_id: TASK-49\n---\n\nBody.\n",
  );
  const plan3 = planLegacyImport(st2.root);
  assert.ok(plan3.errors.some((e) => e.includes("task-51")), plan3.errors.join("\n"));
  // a plan with errors refuses to apply
  assert.throws(() => executePlan(plan3), /refusing to apply/);
});

// ---------------------------------------------------------------------------
// (b) reminders → tasks
// ---------------------------------------------------------------------------

test("import(b): pending reminders become hidden tasks (surface_on → hidden_until) with IDs seeded above the legacy max", (t) => {
  const st = stageProject();
  t.after(st.cleanup);
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);
  const result = applyLegacyImport(st.root, store);
  assert.deepEqual(result.plan.errors, []);

  // legacy max top-level id in the fixture corpus is task-158 → reminders
  // (sorted by legacy number: 2, 5, 7, 9, 12, 98, 99) mint 159–165.
  const live = path.join(st.root, "_project", "tasks");
  const archive = path.join(live, "archive");

  const r7 = readRecord(findTaskFile(live, "task-161")); // REMINDER-7, pending, yearly
  assert.equal(r7.data["imported_from"], "reminder-7");
  assert.equal(r7.data["status"], "todo");
  assert.equal(r7.data["hidden_until"], "2027-05-01");
  assert.equal(r7.data["recur"], "yearly");
  assert.equal(r7.data["title"], "Rotate the Claude Code OAuth token for the Mini automations (expires ~2027-06-01)");
  // unknown legacy keys preserved on the new record
  assert.equal(r7.data["surface_to"], "brief");
  assert.equal(r7.data["created_by"], "agent");

  const r9 = readRecord(findTaskFile(live, "task-162")); // REMINDER-9, pending
  assert.equal(r9.data["imported_from"], "reminder-9");
  assert.equal(r9.data["hidden_until"], "2026-06-15");

  const r12 = readRecord(findTaskFile(live, "task-163")); // REMINDER-12, pending
  assert.equal(r12.data["imported_from"], "reminder-12");
  assert.equal(r12.data["hidden_until"], "2026-06-05");

  const r98 = readRecord(findTaskFile(live, "task-164")); // synthetic daily
  assert.equal(r98.data["recur"], "every-1-days", "daily → every-1-days recur mapping");

  // ID minting continues ABOVE everything imported (the mint-seam probe sees
  // the imported corpus: next top-level is 166).
  const minted = createTask(st.root, store, { title: "post-import task" });
  assert.equal(minted.id, "task-166");
  assert.ok(!fs.existsSync(path.join(archive, "nope")), "sanity");
});

test("import(b): dismissed reminders → archived done tasks keeping the closing-reasoning log line; fired_at folds into ## Log", (t) => {
  const st = stageProject();
  t.after(st.cleanup);
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);
  applyLegacyImport(st.root, store);

  const archive = path.join(st.root, "_project", "tasks", "archive");
  const r2 = readRecord(findTaskFile(archive, "task-159")); // REMINDER-2, dismissed
  assert.equal(r2.data["imported_from"], "reminder-2");
  assert.equal(r2.data["status"], "done");
  assert.equal(r2.data["recur"], undefined, "recurrence never lands on a closed record");
  // the original closing-reasoning log line is preserved in the body...
  assert.match(r2.body, /dismissed during C2 cleanup 2026-06-03/);
  // ...and becomes the one-line Final Summary (done needs one — §4.4)
  assert.match(r2.body, /## Final Summary\n\n.*dismissed during C2 cleanup/);
  // fired_at folded into a ## Log line
  assert.match(r2.body, /^- 2026-05-11T22:30:00-07:00 — fired \(legacy reminder surfacing\)$/m);
  // the surfacing date survives as hidden_until (state fidelity)
  assert.equal(r2.data["hidden_until"], "2026-05-10");
});

test("import(b): promoted reminder (synthetic — none in the real corpus) → archived task with a cross-ref", (t) => {
  const st = stageProject();
  t.after(st.cleanup);
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);
  applyLegacyImport(st.root, store);

  const archive = path.join(st.root, "_project", "tasks", "archive");
  const r99 = readRecord(findTaskFile(archive, "task-165")); // REMINDER-99
  assert.equal(r99.data["imported_from"], "reminder-99");
  assert.equal(r99.data["status"], "done");
  assert.equal(r99.data["promoted_to_task"], "task-140", "cross-ref normalized to the native id");
  assert.match(r99.body, /## Final Summary\n\nPromoted to task-140/);
  assert.equal(r99.data["recur"], undefined);
});

// ---------------------------------------------------------------------------
// (c) dirchannels → forum
// ---------------------------------------------------------------------------

test("import(c): channels flatten to <date>--<channel>--<slug>; meta.json → thread.md with done/errored → resolved", (t) => {
  const st = stageProject();
  t.after(st.cleanup);
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);
  applyLegacyImport(st.root, store);

  const threads = path.join(st.root, "_project", "forum", "threads");

  const open = readRecord(path.join(threads, "2026-05-23--general--first-test", "thread.md"));
  assert.equal(open.data["status"], "open"); // active → open
  assert.equal(open.data["title"], "First test");
  assert.equal(open.data["by"], "matteocarrabba@cli");
  assert.equal(open.data["opened"], "2026-05-23T13:34:20.836Z");
  assert.equal(open.data["legacy_id"], "01KSAGPFN4NFRWHC05X1GGCJ0F");
  assert.equal(open.data["legacy_channel"], "general");

  const done = readRecord(path.join(threads, "2026-05-23--agents--pty-test-echo", "thread.md"));
  assert.equal(done.data["status"], "resolved"); // done → resolved
  assert.equal(done.data["resolved"], "2026-05-23T13:34:32.143Z");
  assert.equal(done.data["legacy_status"], "done");
  assert.equal(done.data["legacy_mode"], "pty");

  const errored = readRecord(path.join(threads, "2026-05-23--agents--live-cat-session", "thread.md"));
  assert.equal(errored.data["status"], "resolved"); // errored → resolved
  assert.equal(errored.data["legacy_status"], "errored");
});

test("import(c): each messages.jsonl line → one maildir file; text → note; non-vocabulary kinds collapse to system keeping legacy_kind", (t) => {
  const st = stageProject();
  t.after(st.cleanup);
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);
  applyLegacyImport(st.root, store);

  const general = path.join(st.root, "_project", "forum", "threads", "2026-05-23--general--first-test");
  const msgFiles = fs
    .readdirSync(general)
    .filter((n) => n !== "thread.md")
    .sort();
  assert.equal(msgFiles.length, 2, "one file per JSONL line");
  const maildirRe = /^\d{8}T\d{6}Z--.+--[a-z0-9]{4}\.md$/;
  for (const f of msgFiles) assert.match(f, maildirRe, "maildir naming: <stamp>--<participant>--<rand4>.md");

  const recs = msgFiles.map((f) => readRecord(path.join(general, f)));
  const system = recs.find((r) => r.data["kind"] === "system");
  const note = recs.find((r) => r.data["kind"] === "note");
  assert.ok(system !== undefined && note !== undefined);
  assert.equal(note.data["from"], "matteocarrabba@cli");
  assert.equal(note.body.trim(), "dirchannels is live in Personal OS");
  assert.equal(note.data["legacy_kind"], undefined, "text → note is a clean mapping, not a collapse");
  assert.match(system.body, /"event": "thread_opened"/);

  // pty thread: command_output collapses to system with the original kind kept
  const pty = path.join(st.root, "_project", "forum", "threads", "2026-05-23--agents--pty-test-echo");
  const ptyRecs = fs
    .readdirSync(pty)
    .filter((n) => n !== "thread.md")
    .map((f) => readRecord(path.join(pty, f)));
  assert.equal(ptyRecs.length, 3);
  const collapsed = ptyRecs.find((r) => r.data["legacy_kind"] === "command_output");
  assert.ok(collapsed !== undefined, "command_output message present");
  assert.equal(collapsed.data["kind"], "system");
  assert.match(collapsed.body, /hello from pty thread/);
  for (const r of ptyRecs) assert.equal(typeof r.data["legacy_id"], "string");
});

test("import(c): sqlite/token/bridge-state and channel metadata are listed as skipped and left untouched", (t) => {
  const st = stageProject();
  t.after(st.cleanup);
  const plan = planLegacyImport(st.root);
  const skips = actionsOf(plan, "skip").map((a) => a.source);
  assert.ok(skips.some((s) => s.endsWith("db.sqlite")));
  assert.ok(skips.some((s) => s.endsWith("token")));
  assert.ok(skips.some((s) => s.endsWith("claude-bridge.state.json")));
  assert.ok(skips.some((s) => s.endsWith(path.join("general", "meta.json"))));
  assert.ok(skips.some((s) => s.endsWith("config.yml"))); // legacy _tasks internals too

  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);
  applyLegacyImport(st.root, store);
  assert.equal(fs.readFileSync(path.join(st.root, "_dirchannel", "token"), "utf8"), "secret-token");
  assert.ok(fs.existsSync(path.join(st.root, "_dirchannel", "db.sqlite")));
});

// ---------------------------------------------------------------------------
// Plan mechanics, source discovery, idempotency
// ---------------------------------------------------------------------------

test("import: dry-run is a pure read (writes nothing) and renders per-record audit lines", (t) => {
  const st = stageProject();
  t.after(st.cleanup);
  const plan = planLegacyImport(st.root);
  assert.ok(!fs.existsSync(path.join(st.root, "_project", "tasks")), "plan never writes");
  assert.ok(!fs.existsSync(path.join(st.root, "_project", "forum")), "plan never writes");

  assert.equal(plan.counts.tasks, 12); // the full real-fixture task corpus
  assert.equal(plan.counts.reminders, 7);
  assert.equal(plan.counts.threads, 3);
  assert.ok(plan.counts.messages >= 10);

  const lines = renderPlan(plan);
  // one audit line per action (+ header, sources, summary)
  assert.equal(lines.length, plan.actions.length + 3);
  assert.ok(lines.some((l) => l.includes("status To Do → todo")));
  assert.ok(lines.some((l) => l.includes("surface") || l.includes("hidden until")));
  assert.match(lines[lines.length - 1] as string, /^summary: \d+ task\(s\)/);
});

test("import: apply executes exactly the plan (same actions, byte-identical writes)", (t) => {
  const st = stageProject();
  t.after(st.cleanup);
  const plan = planLegacyImport(st.root);
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);
  const result = applyLegacyImport(st.root, store);

  const planned = plan.actions.filter((a) => a.write !== undefined);
  assert.equal(result.written.length, planned.length);
  for (const a of planned) {
    const abs = path.join(st.root, a.target as string);
    assert.equal(fs.readFileSync(abs, "utf8"), a.write?.content, a.target ?? "");
  }
});

test("import: legacy sources are discovered in the preserved _project/archive/legacy-imports/<stamp>/ layout", (t) => {
  const stamp = "2026-06-09T02-08-03-239Z";
  const st = stageProject({ underArchiveStamp: stamp });
  t.after(st.cleanup);

  const sources = findLegacySources(st.root);
  assert.ok(sources.tasksRoot?.includes(stamp));
  assert.ok(sources.dirchannelRoot?.includes(stamp));

  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);
  const result = applyLegacyImport(st.root, store);
  assert.deepEqual(result.plan.errors, []);
  assert.ok(fs.existsSync(findTaskFile(path.join(st.root, "_project", "tasks"), "task-103")));
  assert.ok(
    fs.existsSync(path.join(st.root, "_project", "forum", "threads", "2026-05-23--general--first-test", "thread.md")),
  );
});

test("import: IDEMPOTENT — apply twice produces zero changes (proven by tree snapshot)", (t) => {
  const st = stageProject();
  t.after(st.cleanup);
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);

  const first = applyLegacyImport(st.root, store);
  assert.ok(first.written.length > 0);
  const before = snapshot(path.join(st.root, "_project"));

  const second = applyLegacyImport(st.root, store);
  assert.equal(second.written.length, 0, "second apply writes nothing");
  assert.equal(second.plan.counts.tasks, 0);
  assert.equal(second.plan.counts.reminders, 0);
  assert.equal(second.plan.counts.threads, 0);
  assert.equal(second.plan.counts.messages, 0);
  assert.ok(second.plan.counts.existing >= first.written.length, "every record reports as already present");

  const after = snapshot(path.join(st.root, "_project"));
  assert.deepEqual(after, before, "byte-identical tree after the second apply");
});

test("import: idempotency survives a forum thread having been archived since the first import", (t) => {
  const st = stageProject();
  t.after(st.cleanup);
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);
  applyLegacyImport(st.root, store);

  // a later sweep archived the resolved thread
  const threads = path.join(st.root, "_project", "forum", "threads");
  fs.mkdirSync(path.join(threads, "archive"), { recursive: true });
  fs.renameSync(
    path.join(threads, "2026-05-23--agents--pty-test-echo"),
    path.join(threads, "archive", "2026-05-23--agents--pty-test-echo"),
  );

  const second = applyLegacyImport(st.root, store);
  assert.equal(second.written.length, 0, "archived thread still counts as imported");
});

// ---------------------------------------------------------------------------
// CLI wiring
// ---------------------------------------------------------------------------

const CLI = path.resolve(__dirname, "..", "src", "cli.js");

function runCli(args: string[], cwd: string, storeDir: string) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, OPENWORKSPACE_STORE_DIR: storeDir, OW_ACTOR: "import-test" },
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

test("cli: projects import legacy — dry-run by default, --apply executes, idempotent re-apply, --json", (t) => {
  const st = stageProject();
  t.after(st.cleanup);
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);
  const storeDir = store.dir;

  // default = dry-run: renders the plan, writes nothing, exit 0
  const dry = runCli(["import", "legacy"], st.root, storeDir);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /import legacy \(dry-run\)/);
  assert.match(dry.stdout, /status To Do → todo/);
  assert.ok(!fs.existsSync(path.join(st.root, "_project", "tasks")));

  const applied = runCli(["import", "legacy", "--apply"], st.root, storeDir);
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /import legacy \(apply\)/);
  assert.match(applied.stdout, /applied: \d+ file\(s\) written/);
  assert.ok(fs.existsSync(path.join(st.root, "_project", "tasks")));

  const again = runCli(["import", "legacy", "--apply", "--json"], st.root, storeDir);
  assert.equal(again.status, 0, again.stderr);
  const parsed = JSON.parse(again.stdout) as Array<{ written: string[]; counts: { tasks: number } }>;
  assert.equal(parsed[0]?.written.length, 0, "CLI re-apply writes nothing");
  assert.equal(parsed[0]?.counts.tasks, 0);

  // flag discipline
  const both = runCli(["import", "legacy", "--dry-run", "--apply"], st.root, storeDir);
  assert.equal(both.status, 1);
  assert.match(both.stderr, /not both/);
  const badSub = runCli(["import", "frobnicate"], st.root, storeDir);
  assert.equal(badSub.status, 1);
  assert.match(badSub.stderr, /expected legacy/);
});

test("cli: import plan errors exit 1 and refuse to apply the failing records", (t) => {
  const st = stageProject();
  t.after(st.cleanup);
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);
  fs.writeFileSync(
    path.join(st.root, "_tasks", "tasks", "task-50.2 - disagrees.md"),
    "---\nid: TASK-50.2\ntitle: Disagrees\nstatus: To Do\nparent_task_id: TASK-49\n---\n\nBody.\n",
  );
  const dry = runCli(["import", "legacy"], st.root, store.dir);
  assert.equal(dry.status, 1);
  assert.match(dry.stdout, /error: .*task-50\.2/);

  const applied = runCli(["import", "legacy", "--apply"], st.root, store.dir);
  assert.equal(applied.status, 1);
  assert.match(applied.stdout, /refusing to apply .*NOTHING was applied for this entire project/);
  assert.match(applied.stderr, /nothing was applied for the failing project/);
  assert.ok(!fs.existsSync(path.join(st.root, "_project", "tasks")), "nothing applied on a failing plan");
});

// sanity: the codec keeps a fixture byte-stable end-to-end (guards the
// byte-preservation claim at the importer level too)
test("import: unmodified fixture records round-trip byte-for-byte through the codec", () => {
  for (const subdir of ["tasks", "reminders"]) {
    for (const name of fs.readdirSync(path.join(FIXTURES_DIR, subdir))) {
      if (!name.endsWith(".md")) continue;
      const text = fs.readFileSync(fixturePath(subdir, name), "utf8");
      assert.equal(serializeRecord(parseRecord(text)), text, `${subdir}/${name}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Fix-pass regression tests
// ---------------------------------------------------------------------------

test("import(a): a legacy id colliding with a PRE-EXISTING native task is a loud plan error, never a false 'exists'", (t) => {
  // Regression: idempotency was keyed solely on the native ID being present
  // in _project/tasks/ filenames — a native task minted before migration
  // (the §11 step-5 cut-over window) silently swallowed the legacy record
  // under a factually false "already imported" audit line.
  const st = stageProject();
  t.after(st.cleanup);
  const nativeDir = path.join(st.root, "_project", "tasks");
  fs.mkdirSync(nativeDir, { recursive: true });
  fs.writeFileSync(
    path.join(nativeDir, "task-10 - some-native-work.md"),
    "---\nid: task-10\ntitle: Some native work\nstatus: todo\n---\n\nMinted via task create before migration.\n",
  );

  const plan = planLegacyImport(st.root);
  assert.ok(
    plan.errors.some((e) => /task-10 collides with a pre-existing native record/.test(e)),
    JSON.stringify(plan.errors),
  );
  assert.ok(
    !plan.actions.some((a) => a.kind === "exists" && /task-10 already imported/.test(a.note)),
    "the false 'already imported' line must be gone",
  );
  assert.throws(() => executePlan(plan), /refusing to apply/);
});

test("import(a): idempotency still holds after a post-import EDIT and after a post-import archive (same filename = same import)", (t) => {
  const st = stageProject();
  t.after(st.cleanup);
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);
  applyLegacyImport(st.root, store);

  const liveDir = path.join(st.root, "_project", "tasks");
  // post-import edit: flip a field (content no longer byte-equal)
  const edited = findTaskFile(liveDir, "task-10");
  fs.writeFileSync(edited, fs.readFileSync(edited, "utf8").replace("status: todo", "status: doing"));
  // post-import archive: move another record to tasks/archive/ keeping its name
  const moved = findTaskFile(liveDir, "task-103");
  fs.mkdirSync(path.join(liveDir, "archive"), { recursive: true });
  fs.renameSync(moved, path.join(liveDir, "archive", path.basename(moved)));

  const plan = planLegacyImport(st.root);
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.counts.tasks, 0, "no re-import of edited/archived records");
  const result = executePlan(plan);
  assert.equal(result.written.length, 0);
});

test("import(c): a duplicated messages.jsonl line (iCloud append glitch) is deduped at PLAN time — apply cannot crash mid-run", (t) => {
  const st = stageProject();
  t.after(st.cleanup);
  // duplicate the last line of a real thread's messages.jsonl (same id+ts ⇒
  // the same deterministic target filename)
  const jsonl = path.join(
    st.root,
    "_dirchannel",
    "channels",
    "general",
    "threads",
    "01KSAGPFN4NFRWHC05X1GGCJ0F",
    "messages.jsonl",
  );
  const lines = fs.readFileSync(jsonl, "utf8").split("\n").filter((l) => l.trim() !== "");
  fs.writeFileSync(jsonl, [...lines, lines[lines.length - 1]].join("\n") + "\n");

  const plan = planLegacyImport(st.root);
  assert.deepEqual(plan.errors, [], "identical duplicate is NOT an error");
  const deduped = plan.actions.filter((a) => /deduped, written once/.test(a.note));
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0]?.kind, "exists");
  // and the plan applies cleanly end to end (the old code threw ConflictError mid-apply)
  const result = executePlan(plan);
  assert.ok(result.written.length > 0);
});

test("import(c): same planned target with DIFFERENT content is a plan error (no improvised overwrite)", (t) => {
  const st = stageProject();
  t.after(st.cleanup);
  const jsonl = path.join(
    st.root,
    "_dirchannel",
    "channels",
    "general",
    "threads",
    "01KSAGPFN4NFRWHC05X1GGCJ0F",
    "messages.jsonl",
  );
  const lines = fs.readFileSync(jsonl, "utf8").split("\n").filter((l) => l.trim() !== "");
  const last = JSON.parse(lines[lines.length - 1] as string) as Record<string, unknown>;
  last["body"] = "DIVERGED COPY OF THE SAME MESSAGE ID";
  fs.writeFileSync(jsonl, [...lines, JSON.stringify(last)].join("\n") + "\n");

  const plan = planLegacyImport(st.root);
  assert.ok(
    plan.errors.some((e) => /collides with .* but the content differs/.test(e)),
    JSON.stringify(plan.errors),
  );
  assert.throws(() => executePlan(plan), /refusing to apply/);
});

test("import: audit completeness — drafts/ and archive/-beyond-tasks/ records get honest per-file skip lines", (t) => {
  const st = stageProject();
  t.after(st.cleanup);
  fs.mkdirSync(path.join(st.root, "_tasks", "drafts"), { recursive: true });
  fs.writeFileSync(
    path.join(st.root, "_tasks", "drafts", "task-60 - a-draft.md"),
    "---\nid: TASK-60\ntitle: A draft\nstatus: Draft\n---\n\nDraft body.\n",
  );
  fs.mkdirSync(path.join(st.root, "_tasks", "archive", "drafts"), { recursive: true });
  fs.writeFileSync(
    path.join(st.root, "_tasks", "archive", "drafts", "task-50 - archived-draft.md"),
    "---\nid: TASK-50\ntitle: Archived draft\n---\n\nBody.\n",
  );

  const plan = planLegacyImport(st.root);
  assert.deepEqual(plan.errors, []);
  const skips = plan.actions.filter((a) => a.kind === "skip");
  const draftSkip = skips.find((a) => /drafts[/\\]task-60/.test(a.source));
  assert.ok(draftSkip !== undefined, "live draft gets its own audit line");
  assert.match(draftSkip.note, /legacy draft task/);
  const archivedSkip = skips.find((a) => /archive[/\\]drafts[/\\]task-50/.test(a.source));
  assert.ok(archivedSkip !== undefined, "archive/drafts record is no longer invisible to the audit");
  assert.match(archivedSkip.note, /outside archive\/tasks\//);
  // neither is imported, and both source files are untouched
  assert.ok(!plan.actions.some((a) => a.kind === "task" && /task-(50|60)\b/.test(a.note)));
});

test("import: legacy v0.2 reviews/ and proposals/ dirs are listed as audited skips (manual §11.4 migration items)", (t) => {
  const st = stageProject();
  t.after(st.cleanup);
  fs.mkdirSync(path.join(st.root, "_project", "reviews", "done"), { recursive: true });
  fs.writeFileSync(path.join(st.root, "_project", "reviews", "done", "review-1.md"), "# Review 1\n");
  fs.mkdirSync(path.join(st.root, "_project", "proposals"), { recursive: true });
  fs.writeFileSync(path.join(st.root, "_project", "proposals", "rules-proposed.md"), "# Proposals\n");

  const plan = planLegacyImport(st.root);
  const reviewSkip = plan.actions.find((a) => a.kind === "skip" && /reviews[/\\]done[/\\]review-1\.md/.test(a.source));
  assert.ok(reviewSkip !== undefined, JSON.stringify(plan.actions.filter((a) => a.kind === "skip").map((a) => a.source)));
  assert.match(reviewSkip.note, /outside `import legacy` scope/);
  assert.match(reviewSkip.note, /review records → tasks/);
  const proposalSkip = plan.actions.find((a) => a.kind === "skip" && /proposals[/\\]rules-proposed\.md/.test(a.source));
  assert.ok(proposalSkip !== undefined);
  assert.match(proposalSkip.note, /proposals re-home/);
});

test("import(b): legacy 'surfaced' reminder status imports as a live todo (fired, awaiting action) — no loud error", (t) => {
  const st = stageProject();
  t.after(st.cleanup);
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);
  fs.writeFileSync(
    path.join(st.root, "_tasks", "reminders", "reminder-97 - 2026-06-01 - synthetic-surfaced.md"),
    "---\nid: REMINDER-97\nsurface_on: 2026-06-01\nstatus: surfaced\nfired_at: 2026-06-01T08:00:00-07:00\n---\n\n# Synthetic surfaced reminder\n\nIt fired; nobody acted yet.\n",
  );
  const result = applyLegacyImport(st.root, store);
  const action = result.plan.actions.find((a) => a.kind === "reminder" && /reminder-97/.test(a.note));
  assert.ok(action !== undefined, "surfaced reminder is imported, not errored");
  assert.match(action.note, /surfaced → todo/);
  const file = path.join(st.root, action.target as string);
  const rec = readRecord(file);
  assert.equal(rec.data["status"], "todo");
  assert.equal(rec.data["hidden_until"], "2026-06-01");
  assert.equal(rec.data["imported_from"], "reminder-97");
  assert.match(rec.body, /fired \(legacy reminder surfacing\)/);
  assert.ok(!(action.target as string).includes("archive"), "surfaced = live, not archived");
});

test("cli: --apply --all isolates a failing project — later projects still apply and every audit prints", (t) => {
  // Regression: applyLegacyImport threw on the first failing project, so
  // later projects were never attempted AND already-applied projects' audit
  // lines were never printed.
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);
  const fail = tw.addProject("AAA Failing");
  const ok = tw.addProject("ZZZ Healthy");
  // failing project: duplicate legacy task ids (the loud-refusal posture)
  fs.mkdirSync(path.join(fail.root, "_tasks", "tasks"), { recursive: true });
  fs.writeFileSync(
    path.join(fail.root, "_tasks", "tasks", "task-2 - dup.md"),
    "---\nid: TASK-2\ntitle: Dup\nstatus: To Do\n---\n\nA.\n",
  );
  fs.writeFileSync(
    path.join(fail.root, "_tasks", "tasks", "task-2 - dup 2.md"),
    "---\nid: TASK-2\ntitle: Dup\nstatus: To Do\n---\n\nDIVERGED.\n",
  );
  // healthy project: one clean legacy task
  fs.mkdirSync(path.join(ok.root, "_tasks", "tasks"), { recursive: true });
  fs.writeFileSync(
    path.join(ok.root, "_tasks", "tasks", "task-1 - fine.md"),
    "---\nid: TASK-1\ntitle: Fine\nstatus: To Do\n---\n\nOK.\n",
  );

  const result = runCli(["import", "legacy", "--apply", "--all"], tw.root, store.dir);
  assert.equal(result.status, 1, "plan errors still exit 1");
  // the healthy project WAS applied…
  assert.ok(fs.existsSync(path.join(ok.root, "_project", "tasks", "task-1 - fine.md")));
  // …the failing one was not…
  assert.ok(!fs.existsSync(path.join(fail.root, "_project", "tasks", "task-2 - dup.md")));
  // …and BOTH audits printed, with an honest whole-project refusal line
  assert.match(result.stdout, /AAA Failing/);
  assert.match(result.stdout, /ZZZ Healthy/);
  assert.match(result.stdout, /refusing to apply .*AAA Failing.*NOTHING was applied for this entire project/);
  assert.match(result.stderr, /1 of 2 project\(s\)/);
});
