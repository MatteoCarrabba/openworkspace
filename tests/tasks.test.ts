/**
 * Tasks primitive tests (PRD §4.4). Everything runs in temp dirs via
 * makeTmpWorkspace/makeTmpStore — never the live workspace or ~/Library.
 *
 * `now` is always injected with the LOCAL-time Date constructor so the local
 * calendar date is deterministic regardless of the machine's timezone.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import { ConfigError, ConflictError, NotFoundError } from "../src/lib/errors.js";
import { appendToBody, readRecord, writeRecord } from "../src/lib/frontmatter.js";
import { MachineStore } from "../src/lib/machine.js";
import {
  TaskStateError,
  addNote,
  archiveTask,
  completeOccurrence,
  createTask,
  editField,
  getTask,
  hasFinalSummary,
  hideTask,
  listTasks,
  localDateOf,
  nextOccurrenceDate,
  parseInterval,
  setRecur,
  setStatus,
  showTask,
  slugFromTitle,
  tasksArchiveDir,
  tasksDir,
} from "../src/primitives/tasks.js";
import { makeTmpStore, makeTmpWorkspace } from "./helpers.js";

/** Local 09:00 on the given local calendar date — timezone-proof "today". */
function at(y: number, m: number, d: number): Date {
  return new Date(y, m - 1, d, 9, 0, 0);
}

interface Fixture {
  projectRoot: string;
  store: MachineStore;
  cleanup: () => void;
}

/** A project under a colon-and-space path (first-class per MODULES.md). */
function makeFixture(): Fixture {
  const ws = makeTmpWorkspace();
  const project = ws.addProject("Inbox:Outbox Staging/Tasky Project");
  const tmpStore = makeTmpStore();
  return {
    projectRoot: project.root,
    store: tmpStore.store,
    cleanup: () => {
      ws.cleanup();
      tmpStore.cleanup();
    },
  };
}

/** Give a task a Final Summary so `done` passes its guard. */
function writeFinalSummary(projectRoot: string, ref: string, text = "Done. Shipped."): void {
  const task = getTask(projectRoot, ref);
  const rec = readRecord(task.path);
  appendToBody(rec, `\n## Final Summary\n\n${text}\n`);
  writeRecord(task.path, rec);
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

test("create: sequential IDs, filename shape, frontmatter, template body", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  const now = at(2026, 6, 10);

  const t1 = createTask(fx.projectRoot, fx.store, { title: "Fix the frontmatter codec", now });
  const t2 = createTask(fx.projectRoot, fx.store, { title: "Second task", now });
  assert.equal(t1.id, "task-1");
  assert.equal(t2.id, "task-2");
  assert.equal(t1.filename, "task-1 - Fix-the-frontmatter-codec.md");
  assert.equal(path.dirname(t1.path), tasksDir(fx.projectRoot));
  assert.ok(fs.existsSync(t1.path));

  assert.equal(t1.title, "Fix the frontmatter codec");
  assert.equal(t1.status, "todo");
  assert.equal(t1.quadrant, null);
  assert.equal(t1.hiddenUntil, null);
  assert.equal(t1.recur, null);
  assert.equal(t1.created, "2026-06-10");
  assert.ok(/^2026-06-10T\d{2}:\d{2}:\d{2}Z$/.test(t1.updated ?? ""));
  assert.equal(t1.data["hidden_until"], null); // written explicitly, null default

  for (const section of [
    "## Description",
    "## Acceptance Criteria",
    "## Why this matters",
    "## Implementation Plan",
    "## Implementation Notes",
  ]) {
    assert.ok(t1.body.includes(section), `template missing ${section}`);
  }
  assert.ok(!t1.body.includes("## Final Summary"), "Final Summary is not pre-stamped");
});

test("create: quadrant, labels, hidden_until, recur land in frontmatter; invalid inputs rejected", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  const now = at(2026, 6, 10);

  const task = createTask(fx.projectRoot, fx.store, {
    title: "Weekly review",
    quadrant: "q2",
    labels: ["routine", "review"],
    hiddenUntil: "2026-06-17",
    recur: "weekly",
    now,
  });
  assert.equal(task.quadrant, "q2");
  assert.deepEqual(task.labels, ["routine", "review"]);
  assert.equal(task.hiddenUntil, "2026-06-17");
  assert.equal(task.recur, "weekly");

  assert.throws(() => createTask(fx.projectRoot, fx.store, { title: "x", quadrant: "q5", now }), ConfigError);
  assert.throws(() => createTask(fx.projectRoot, fx.store, { title: "x", recur: "fortnightly", now }), ConfigError);
  assert.throws(() => createTask(fx.projectRoot, fx.store, { title: "x", recur: "every-0-days", now }), ConfigError);
  assert.throws(() => createTask(fx.projectRoot, fx.store, { title: "x", hiddenUntil: "2026-02-30", now }), ConfigError);
  assert.throws(() => createTask(fx.projectRoot, fx.store, { title: "x", hiddenUntil: "next week", now }), ConfigError);
  assert.throws(() => createTask(fx.projectRoot, fx.store, { title: "   ", now }), ConfigError);
});

test("create --parent: dotted IDs, parentage in the ID alone (no parent field ever)", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  const now = at(2026, 6, 10);

  const parent = createTask(fx.projectRoot, fx.store, { title: "Parent", now });
  const c1 = createTask(fx.projectRoot, fx.store, { title: "Child one", parent: "task-1", now });
  const c2 = createTask(fx.projectRoot, fx.store, { title: "Child two", parent: "1", now }); // bare ref
  const gc = createTask(fx.projectRoot, fx.store, { title: "Grandchild", parent: c1.id, now });

  assert.equal(parent.id, "task-1");
  assert.equal(c1.id, "task-1.1");
  assert.equal(c2.id, "task-1.2");
  assert.equal(gc.id, "task-1.1.1");
  assert.equal(c1.filename, "task-1.1 - Child-one.md");

  for (const task of [c1, c2, gc]) {
    assert.ok(!("parent" in task.data), `${task.id} has a parent field`);
    assert.ok(!("parent_task_id" in task.data), `${task.id} has a parent_task_id field`);
  }

  // children do not consume top-level numbers
  const next = createTask(fx.projectRoot, fx.store, { title: "Top again", now });
  assert.equal(next.id, "task-2");

  assert.throws(
    () => createTask(fx.projectRoot, fx.store, { title: "orphan", parent: "task-99", now }),
    NotFoundError,
  );
});

test("create: machine-suffixed minting still advances the shared sequence", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  const now = at(2026, 6, 10);
  createTask(fx.projectRoot, fx.store, { title: "laptop one", now });
  const mini = createTask(fx.projectRoot, fx.store, { title: "from the mini", machineSuffix: "mini", now });
  assert.equal(mini.id, "task-2-mini");
  const after = createTask(fx.projectRoot, fx.store, { title: "laptop two", now });
  assert.equal(after.id, "task-3");
});

test("slugFromTitle strips path hazards", () => {
  assert.equal(slugFromTitle("Fix a/b: the c\\d thing"), "Fix-a-b-the-c-d-thing");
  assert.equal(slugFromTitle("   "), "task");
});

// ---------------------------------------------------------------------------
// list / show
// ---------------------------------------------------------------------------

test("list: top-level only by default, with computed subtask rollups", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  const now = at(2026, 6, 10);

  createTask(fx.projectRoot, fx.store, { title: "Parent", now });
  createTask(fx.projectRoot, fx.store, { title: "c1", parent: "task-1", now });
  createTask(fx.projectRoot, fx.store, { title: "c2", parent: "task-1", now });
  createTask(fx.projectRoot, fx.store, { title: "gc", parent: "task-1.1", now });
  createTask(fx.projectRoot, fx.store, { title: "Loner", now });

  // leaf first: the open-children guard applies at every level
  for (const ref of ["task-1.1.1", "task-1.1"]) {
    writeFinalSummary(fx.projectRoot, ref);
    setStatus(fx.projectRoot, ref, "done", { now });
  }

  const entries = listTasks(fx.projectRoot, { now });
  assert.deepEqual(entries.map((e) => e.id), ["task-1", "task-2"]);
  const parent = entries[0];
  assert.ok(parent);
  assert.equal(parent.subtaskCount, 3); // all descendants, org-mode cookie style
  assert.equal(parent.subtaskDoneCount, 2);
  assert.equal(parent.isSubtask, false);

  const expanded = listTasks(fx.projectRoot, { subtasks: true, now });
  assert.deepEqual(
    expanded.map((e) => e.id),
    ["task-1", "task-1.1", "task-1.1.1", "task-1.2", "task-2"],
  );
  assert.equal(expanded.find((e) => e.id === "task-1.1")?.isSubtask, true);
});

test("list: hidden_until in the future excluded by default; --hidden/--all show it tagged", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  const now = at(2026, 6, 10);

  createTask(fx.projectRoot, fx.store, { title: "Visible", now });
  createTask(fx.projectRoot, fx.store, { title: "Hidden", hiddenUntil: "2026-07-01", now });
  createTask(fx.projectRoot, fx.store, { title: "Unhid today", hiddenUntil: "2026-06-10", now });
  createTask(fx.projectRoot, fx.store, { title: "Unhid long ago", hiddenUntil: "2026-01-01", now });

  const def = listTasks(fx.projectRoot, { now });
  assert.deepEqual(def.map((e) => e.title), ["Visible", "Unhid today", "Unhid long ago"]);
  assert.ok(def.every((e) => e.hidden === false));

  const withHidden = listTasks(fx.projectRoot, { hidden: true, now });
  assert.equal(withHidden.length, 4);
  assert.equal(withHidden.find((e) => e.title === "Hidden")?.hidden, true);

  // pure read-time filter: the same task reappears when the date passes
  const later = listTasks(fx.projectRoot, { now: at(2026, 7, 1) });
  assert.ok(later.some((e) => e.title === "Hidden" && e.hidden === false));

  const all = listTasks(fx.projectRoot, { all: true, now });
  assert.equal(all.length, 4);
});

test("list: archive dir and non-task files never load", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  const now = at(2026, 6, 10);

  createTask(fx.projectRoot, fx.store, { title: "Live", now });
  const archived = createTask(fx.projectRoot, fx.store, { title: "Old", now });
  archiveTask(fx.projectRoot, archived.id);
  fs.writeFileSync(path.join(tasksDir(fx.projectRoot), "README.md"), "# not a task\n");

  const entries = listTasks(fx.projectRoot, { all: true, now });
  assert.deepEqual(entries.map((e) => e.id), ["task-1"]);
});

test("show: full subtree, ID-sorted", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  const now = at(2026, 6, 10);

  createTask(fx.projectRoot, fx.store, { title: "Parent", now });
  createTask(fx.projectRoot, fx.store, { title: "c1", parent: "task-1", now });
  createTask(fx.projectRoot, fx.store, { title: "gc", parent: "task-1.1", now });
  createTask(fx.projectRoot, fx.store, { title: "c2", parent: "task-1", now });
  createTask(fx.projectRoot, fx.store, { title: "Unrelated", now });

  const { task, subtree } = showTask(fx.projectRoot, "1");
  assert.equal(task.id, "task-1");
  assert.deepEqual(subtree.map((s) => s.id), ["task-1.1", "task-1.1.1", "task-1.2"]);

  assert.throws(() => showTask(fx.projectRoot, "task-42"), NotFoundError);
  assert.throws(() => showTask(fx.projectRoot, "decision-1"), ConfigError);
});

// ---------------------------------------------------------------------------
// edit-field / note
// ---------------------------------------------------------------------------

test("editField: validates known fields, guards id/status, passes unknown keys, bumps updated", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  const now = at(2026, 6, 10);
  const created = createTask(fx.projectRoot, fx.store, { title: "Editable", now });

  const later = at(2026, 6, 11);
  const edited = editField(fx.projectRoot, "task-1", "quadrant", "q1", { now: later });
  assert.equal(edited.quadrant, "q1");
  assert.notEqual(edited.updated, created.updated);
  assert.equal(edited.filename, created.filename); // filename is stable; IDs don't churn

  const titled = editField(fx.projectRoot, "task-1", "title", "Renamed", { now: later });
  assert.equal(titled.title, "Renamed");

  const custom = editField(fx.projectRoot, "task-1", "milestone", "phase-2", { now: later });
  assert.equal(custom.data["milestone"], "phase-2");

  assert.throws(() => editField(fx.projectRoot, "task-1", "id", "task-9"), ConfigError);
  assert.throws(() => editField(fx.projectRoot, "task-1", "status", "done"), ConfigError);
  assert.throws(() => editField(fx.projectRoot, "task-1", "quadrant", "urgent"), ConfigError);
  assert.throws(() => editField(fx.projectRoot, "task-1", "hidden_until", "soon"), ConfigError);
  assert.throws(() => editField(fx.projectRoot, "task-1", "labels", "not-an-array"), ConfigError);
});

test("note: appends to ## Log, creating the section once and keeping order", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  const now = at(2026, 6, 10);
  createTask(fx.projectRoot, fx.store, { title: "Logged", now });

  const first = addNote(fx.projectRoot, "task-1", "first note", { now });
  assert.match(first.body, /## Log\n\n- \d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z — first note\n/);

  const second = addNote(fx.projectRoot, "task-1", "second note", { now: at(2026, 6, 11), actor: "claude-a3f" });
  assert.equal(second.body.match(/## Log/g)?.length, 1, "Log section created exactly once");
  const firstIdx = second.body.indexOf("first note");
  const secondIdx = second.body.indexOf("second note");
  assert.ok(firstIdx !== -1 && secondIdx > firstIdx, "notes append in order");
  assert.ok(second.body.includes("second note (claude-a3f)"));
  assert.ok(second.body.includes("## Implementation Notes"), "other sections survive");

  assert.throws(() => addNote(fx.projectRoot, "task-1", "   "), ConfigError);
});

// ---------------------------------------------------------------------------
// status transitions
// ---------------------------------------------------------------------------

test("status: done requires a non-empty ## Final Summary", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  const now = at(2026, 6, 10);
  createTask(fx.projectRoot, fx.store, { title: "Closable", now });

  assert.equal(setStatus(fx.projectRoot, "task-1", "doing", { now }).status, "doing");
  assert.throws(() => setStatus(fx.projectRoot, "task-1", "done", { now }), TaskStateError);

  // an empty heading is not a summary
  const task = getTask(fx.projectRoot, "task-1");
  const rec = readRecord(task.path);
  appendToBody(rec, "\n## Final Summary\n\n\n");
  writeRecord(task.path, rec);
  assert.throws(() => setStatus(fx.projectRoot, "task-1", "done", { now }), TaskStateError);

  writeFinalSummary(fx.projectRoot, "task-1", "Decided: skip."); // one line suffices (PRD)
  assert.equal(setStatus(fx.projectRoot, "task-1", "done", { now }).status, "done");

  assert.throws(
    () => setStatus(fx.projectRoot, "task-1", "blocked" as never, { now }),
    ConfigError,
  );
});

test("hasFinalSummary: heading must exist with non-blank content", () => {
  assert.equal(hasFinalSummary("## Final Summary\n\nDone.\n"), true);
  assert.equal(hasFinalSummary("## Final Summary\n\n## Log\n\n- x\n"), false);
  assert.equal(hasFinalSummary("## Final Summary\n   \n"), false);
  assert.equal(hasFinalSummary("no summary here"), false);
});

test("status: done on a parent with open descendants requires force; doneness counts", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  const now = at(2026, 6, 10);
  createTask(fx.projectRoot, fx.store, { title: "Parent", now });
  createTask(fx.projectRoot, fx.store, { title: "c1", parent: "task-1", now });
  createTask(fx.projectRoot, fx.store, { title: "gc", parent: "task-1.1", now });
  writeFinalSummary(fx.projectRoot, "task-1");

  assert.throws(() => setStatus(fx.projectRoot, "task-1", "done", { now }), /open subtasks.*task-1\.1/);

  // closing the direct child but not the grandchild still blocks (any depth)
  writeFinalSummary(fx.projectRoot, "task-1.1");
  assert.throws(() => setStatus(fx.projectRoot, "task-1.1", "done", { now }), TaskStateError);
  writeFinalSummary(fx.projectRoot, "task-1.1.1");
  setStatus(fx.projectRoot, "task-1.1.1", "done", { now });
  setStatus(fx.projectRoot, "task-1.1", "done", { now });
  assert.equal(setStatus(fx.projectRoot, "task-1", "done", { now }).status, "done");
});

test("status: force closes a parent over open children", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  const now = at(2026, 6, 10);
  createTask(fx.projectRoot, fx.store, { title: "Parent", now });
  createTask(fx.projectRoot, fx.store, { title: "child", parent: "task-1", now });
  writeFinalSummary(fx.projectRoot, "task-1");
  const done = setStatus(fx.projectRoot, "task-1", "done", { force: true, now });
  assert.equal(done.status, "done");
  assert.equal(getTask(fx.projectRoot, "task-1.1").status, "todo"); // status never rolls up
});

test("status: done with recur set is an error pointing at occurrence completion", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  const now = at(2026, 6, 10);
  createTask(fx.projectRoot, fx.store, { title: "Standing", recur: "weekly", hiddenUntil: "2026-06-10", now });
  writeFinalSummary(fx.projectRoot, "task-1");
  assert.throws(() => setStatus(fx.projectRoot, "task-1", "done", { now }), /recurring/);

  // retire-then-close is the sanctioned path
  setRecur(fx.projectRoot, "task-1", "off", { now });
  const closed = setStatus(fx.projectRoot, "task-1", "done", { now });
  assert.equal(closed.status, "done");
  assert.ok(!("recur" in closed.data), "recur off deletes the field");
});

// ---------------------------------------------------------------------------
// recurrence
// ---------------------------------------------------------------------------

test("completeOccurrence: PRD-shape log line, hidden_until advances one period, status untouched", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  const now = at(2026, 6, 17);
  createTask(fx.projectRoot, fx.store, {
    title: "Weekly review",
    recur: "weekly",
    hiddenUntil: "2026-06-17",
    now,
  });

  const { task, next } = completeOccurrence(fx.projectRoot, "task-1", { now, actor: "claude-a3f" });
  assert.equal(next, "2026-06-24");
  assert.equal(task.hiddenUntil, "2026-06-24");
  assert.equal(task.status, "todo");
  assert.equal(task.recur, "weekly");
  assert.match(
    task.body,
    /^- \d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z — completed \(claude-a3f\); next 2026-06-24$/m,
  );
});

test("completeOccurrence: fast-forwards past many missed periods, on-grid (no drift, no catch-up pile)", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  const now = at(2026, 6, 10);
  // anchored ~70 weeks in the past
  createTask(fx.projectRoot, fx.store, {
    title: "Long overdue weekly",
    recur: "weekly",
    hiddenUntil: "2025-02-10",
    now,
  });

  const { next } = completeOccurrence(fx.projectRoot, "task-1", { now });
  // strictly future, within one period of today, and on the Monday grid of the anchor
  assert.equal(next, "2026-06-15");
  const anchorMs = Date.UTC(2025, 1, 10);
  const nextMs = Date.UTC(2026, 5, 15);
  assert.equal(((nextMs - anchorMs) / 86_400_000) % 7, 0, "stays on the anchor grid");
});

test("completeOccurrence: every-N-days fast-forward stays on grid", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  const now = at(2026, 6, 10);
  createTask(fx.projectRoot, fx.store, {
    title: "Every 10 days",
    recur: "every-10-days",
    hiddenUntil: "2026-01-01",
    now,
  });
  const { next } = completeOccurrence(fx.projectRoot, "task-1", { now });
  assert.equal(next, "2026-06-20"); // 2026-01-01 + 17*10 days, first grid point after 06-10
});

test("completeOccurrence: monthly clamps to short months without drifting off the anchor day", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  // anchor on the 31st
  const jan = at(2026, 2, 15);
  createTask(fx.projectRoot, fx.store, {
    title: "Monthly on the 31st",
    recur: "monthly",
    hiddenUntil: "2026-01-31",
    now: jan,
  });
  const feb = completeOccurrence(fx.projectRoot, "task-1", { now: jan });
  assert.equal(feb.next, "2026-02-28"); // clamped

  const mar = completeOccurrence(fx.projectRoot, "task-1", { now: at(2026, 3, 1) });
  assert.equal(mar.next, "2026-03-31"); // anchor day restored — schedule-anchored, no drift
});

test("completeOccurrence: yearly Feb-29 anchor clamps in non-leap years, fast-forwards years", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  const now = at(2026, 6, 10);
  createTask(fx.projectRoot, fx.store, {
    title: "Leap-day yearly",
    recur: "yearly",
    hiddenUntil: "2024-02-29",
    now,
  });
  const { next } = completeOccurrence(fx.projectRoot, "task-1", { now });
  assert.equal(next, "2027-02-28"); // 2025/2026 boundaries already past; clamp 29 → 28
});

test("completeOccurrence: idempotent-ish under repeat — the date does not run away", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  const now = at(2026, 6, 17);
  createTask(fx.projectRoot, fx.store, {
    title: "Weekly",
    recur: "weekly",
    hiddenUntil: "2026-06-17",
    now,
  });

  const first = completeOccurrence(fx.projectRoot, "task-1", { now, actor: "a" });
  const second = completeOccurrence(fx.projectRoot, "task-1", { now, actor: "b" });
  const third = completeOccurrence(fx.projectRoot, "task-1", { now, actor: "c" });
  assert.equal(first.next, "2026-06-24");
  assert.equal(second.next, "2026-06-24", "repeat completion does not skip a period");
  assert.equal(third.next, "2026-06-24");
  // ...but each completion is still recorded (idempotent-ISH)
  const logLines = third.task.body.match(/^- .*— completed/gm) ?? [];
  assert.equal(logLines.length, 3);
});

test("completeOccurrence: non-recurring task rejected; hidden_until null anchors on created", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  const now = at(2026, 6, 10);
  createTask(fx.projectRoot, fx.store, { title: "Plain", now });
  assert.throws(() => completeOccurrence(fx.projectRoot, "task-1", { now }), TaskStateError);

  createTask(fx.projectRoot, fx.store, { title: "Born recurring", recur: "weekly", now });
  const { next } = completeOccurrence(fx.projectRoot, "task-2", { now });
  assert.equal(next, "2026-06-17"); // created 06-10 + 1 week, strictly future
});

test("completeOccurrence: malformed recur on disk (hand-edited) is a loud error", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  const now = at(2026, 6, 10);
  const task = createTask(fx.projectRoot, fx.store, { title: "Mangled", recur: "weekly", now });
  const rec = readRecord(task.path);
  // simulate a hand-edit the codec can't be blamed for
  writeRecord(task.path, (() => {
    const text = fs.readFileSync(task.path, "utf8").replace("recur: weekly", "recur: fortnightly");
    fs.writeFileSync(task.path, text);
    return readRecord(task.path);
  })());
  void rec;
  assert.throws(() => completeOccurrence(fx.projectRoot, "task-1", { now }), /malformed recur interval/);
});

test("nextOccurrenceDate + parseInterval exported for the doctor", () => {
  assert.deepEqual(parseInterval("every-3-days"), { unit: "days", n: 3 });
  assert.equal(parseInterval("every--3-days"), null);
  assert.equal(nextOccurrenceDate("2026-01-31", { unit: "months", n: 1 }, "2026-02-28"), "2026-03-31");
  assert.equal(nextOccurrenceDate("2026-06-20", { unit: "days", n: 7 }, "2026-06-10"), "2026-06-20"); // future anchor is itself next
});

// ---------------------------------------------------------------------------
// hide / recur / archive
// ---------------------------------------------------------------------------

test("hide: sets hidden_until and drops the task from default listings", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  const now = at(2026, 6, 10);
  createTask(fx.projectRoot, fx.store, { title: "Tickler", now });

  const hidden = hideTask(fx.projectRoot, "task-1", "2026-07-01", { now });
  assert.equal(hidden.hiddenUntil, "2026-07-01");
  assert.equal(listTasks(fx.projectRoot, { now }).length, 0);
  assert.equal(listTasks(fx.projectRoot, { hidden: true, now }).length, 1);

  assert.throws(() => hideTask(fx.projectRoot, "task-1", "July 1st", { now }), ConfigError);
});

test("recur: set, change, retire", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  const now = at(2026, 6, 10);
  createTask(fx.projectRoot, fx.store, { title: "Becomes standing", now });

  assert.equal(setRecur(fx.projectRoot, "task-1", "monthly", { now }).recur, "monthly");
  assert.equal(setRecur(fx.projectRoot, "task-1", "every-14-days", { now }).recur, "every-14-days");
  assert.throws(() => setRecur(fx.projectRoot, "task-1", "hourly", { now }), ConfigError);

  const off = setRecur(fx.projectRoot, "task-1", "off", { now });
  assert.equal(off.recur, null);
  assert.ok(!("recur" in off.data));
});

test("archive: moves the file (and its whole subtree) to tasks/archive/", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  const now = at(2026, 6, 10);
  createTask(fx.projectRoot, fx.store, { title: "Parent", now });
  createTask(fx.projectRoot, fx.store, { title: "child", parent: "task-1", now });
  createTask(fx.projectRoot, fx.store, { title: "Stays", now });

  const moved = archiveTask(fx.projectRoot, "task-1");
  assert.equal(moved.length, 2);
  for (const p of moved) {
    assert.equal(path.dirname(p), tasksArchiveDir(fx.projectRoot));
    assert.ok(fs.existsSync(p));
  }
  assert.deepEqual(listTasks(fx.projectRoot, { all: true, now }).map((e) => e.id), ["task-2"]);
  assert.throws(() => getTask(fx.projectRoot, "task-1"), NotFoundError);

  // archived IDs keep feeding the mint probe — IDs are citations and never
  // churn (PRD §4.4: an archived task-1 must not be re-minted; the duplicate-ID
  // doctor check is the backstop, not the first line of defense).
  const fresh = createTask(fx.projectRoot, fx.store, { title: "Parent", now });
  assert.equal(fresh.id, "task-3");
});

test("archive: name collision in archive/ is a ConflictError, nothing half-moves", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  const now = at(2026, 6, 10);
  const a = createTask(fx.projectRoot, fx.store, { title: "Same", now });
  // simulate an already-occupied archive slot (e.g. an iCloud-duplicated copy)
  fs.mkdirSync(tasksArchiveDir(fx.projectRoot), { recursive: true });
  fs.copyFileSync(a.path, path.join(tasksArchiveDir(fx.projectRoot), a.filename));
  assert.throws(() => archiveTask(fx.projectRoot, a.id), ConflictError);
  assert.ok(fs.existsSync(a.path), "live file untouched after refused archive");
});

// ---------------------------------------------------------------------------
// fidelity & robustness
// ---------------------------------------------------------------------------

test("mutations preserve unknown keys, comments, and key order (lossless codec end-to-end)", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  const now = at(2026, 6, 10);
  const dir = tasksDir(fx.projectRoot);
  fs.mkdirSync(dir, { recursive: true });
  const handWritten = [
    "---",
    "id: task-9",
    "title: Hand-made record",
    "status: todo  # triaged 2026-06-01",
    "quadrant: q3",
    "labels:",
    "  - legacy",
    "milestone: phase-e   # unknown key, must survive",
    "hidden_until: null",
    "created: 2026-06-01",
    "updated: 2026-06-01T10:00:00Z",
    "---",
    "",
    "## Description",
    "",
    "Original prose stays put.",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "task-9 - Hand-made-record.md"), handWritten);

  setStatus(fx.projectRoot, "task-9", "doing", { now });
  addNote(fx.projectRoot, "task-9", "touched twice", { now });

  const text = fs.readFileSync(path.join(dir, "task-9 - Hand-made-record.md"), "utf8");
  assert.ok(text.includes("status: doing  # triaged 2026-06-01"), "inline comment survives the edit");
  assert.ok(text.includes("milestone: phase-e   # unknown key, must survive"));
  assert.ok(text.includes("Original prose stays put."));
  assert.ok(text.indexOf("title:") < text.indexOf("status:"), "key order preserved");
  assert.match(text, /## Log\n\n- .*touched twice/);
});

test("records with broken YAML are readable but refuse mutation", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  const now = at(2026, 6, 10);
  const dir = tasksDir(fx.projectRoot);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "task-3 - broken.md"),
    "---\nid: task-3\ntitle: [unclosed\n---\nbody\n",
  );

  const listed = listTasks(fx.projectRoot, { all: true, now });
  assert.equal(listed.length, 1, "forgiving read still lists it");
  assert.ok((listed[0]?.errors.length ?? 0) > 0);
  assert.throws(() => setStatus(fx.projectRoot, "task-3", "doing", { now }), /YAML errors/);
});

test("refs and paths: bare/dotted/suffixed refs resolve; colon-and-space project path works throughout", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  const now = at(2026, 6, 10);
  assert.ok(fx.projectRoot.includes("Inbox:Outbox Staging"));

  createTask(fx.projectRoot, fx.store, { title: "One", now });
  createTask(fx.projectRoot, fx.store, { title: "Sub", parent: "1", now });
  createTask(fx.projectRoot, fx.store, { title: "Mini", machineSuffix: "mini", now });

  assert.equal(getTask(fx.projectRoot, "1").id, "task-1");
  assert.equal(getTask(fx.projectRoot, "task-1.1").id, "task-1.1");
  assert.equal(getTask(fx.projectRoot, "1.1").id, "task-1.1");
  // suffixed minting advances the shared sequence: top-level next was 2
  assert.equal(getTask(fx.projectRoot, "2-mini").id, "task-2-mini");
  assert.throws(() => getTask(fx.projectRoot, "not an id"), ConfigError);
});

// ---------------------------------------------------------------------------
// Regressions: suffix-tolerant descendants + crash-recoverable archive order
// ---------------------------------------------------------------------------

test("regression: a machine-suffixed subtask is a real descendant — rollups, done guard, archive subtree", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);

  const parent = createTask(fx.projectRoot, fx.store, { title: "Parent" }); // task-1
  createTask(fx.projectRoot, fx.store, { title: "Plain child", parent: parent.id }); // task-1.1
  const miniChild = createTask(fx.projectRoot, fx.store, {
    title: "Mini child",
    parent: parent.id,
    machineSuffix: "mini",
  });
  assert.equal(miniChild.id, "task-1.2-mini", "suffixed dotted mint under a plain parent");

  // (1) rollups computed over descendants derived from IDs include it
  const listed = listTasks(fx.projectRoot);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.subtaskCount, 2, "the -mini child counts in the rollup");

  // (2) closing the parent with the -mini child open requires force
  writeFinalSummary(fx.projectRoot, parent.id);
  writeFinalSummary(fx.projectRoot, "task-1.1");
  setStatus(fx.projectRoot, "task-1.1", "done");
  assert.throws(
    () => setStatus(fx.projectRoot, parent.id, "done"),
    (err: unknown) => err instanceof TaskStateError && /task-1\.2-mini/.test((err as Error).message),
  );

  // (3) archiving the parent moves the WHOLE subtree — no stranded -mini orphan
  const moved = archiveTask(fx.projectRoot, parent.id);
  assert.equal(moved.length, 3);
  assert.deepEqual(
    fs.readdirSync(tasksDir(fx.projectRoot)).filter((n) => n.endsWith(".md")),
    [],
    "nothing stranded live",
  );

  // ...and a suffixed ANCESTOR still only owns same-suffix children
  const miniTop = createTask(fx.projectRoot, fx.store, { title: "Mini top", machineSuffix: "mini" });
  assert.equal(miniTop.id, "task-2-mini");
  createTask(fx.projectRoot, fx.store, { title: "Mini sub", parent: miniTop.id });
  const expanded = listTasks(fx.projectRoot, { all: true }).map((e) => e.id);
  assert.ok(expanded.includes("task-2.1-mini"), `child of a -mini parent stays -mini: ${expanded.join(",")}`);
});

test("regression: archive moves children deepest-first and the parent LAST (re-runnable if interrupted)", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);

  const parent = createTask(fx.projectRoot, fx.store, { title: "P" }); // task-1
  createTask(fx.projectRoot, fx.store, { title: "C", parent: parent.id }); // task-1.1
  createTask(fx.projectRoot, fx.store, { title: "GC", parent: "task-1.1" }); // task-1.1.1

  const moved = archiveTask(fx.projectRoot, parent.id);
  const order = moved.map((p) => path.basename(p).split(" ")[0]);
  // an interrupted prefix of this sequence always leaves the parent (and any
  // unmoved ancestor) LIVE, so `task archive task-1` can simply be re-run;
  // parent-first would strand live orphans whose parent ref no longer scans
  assert.deepEqual(order, ["task-1.1.1", "task-1.1", "task-1"]);
});
