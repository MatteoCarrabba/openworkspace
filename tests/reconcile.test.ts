/**
 * decision-2 — the reconciler. Every test runs against a temp workspace + a
 * temp machine store; NEVER the live tree or the real ~/Library.
 *
 * Coverage:
 *  - lifecycle metadata round-trip is in lifecycle-metadata.test.ts
 *  - reconcile heals a dormant-metadata-at-top-level case (propose then apply)
 *  - same-id duplicate removal (identical) + conflict (differing) reporting
 *  - resurrected state-named subdir cleanup (empty + with records)
 *  - idempotency (second pass is a no-op)
 *  - a human-moved NON-GIT project with no intent → ambiguous (must NOT fight)
 *  - the git-repo tiebreaker (committed metadata reverts an iCloud glitch)
 *  - a non-git glitch with a metadata-pointing intent → auto-revert
 */

import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import { appendLifecycleIntent, lastRetired } from "../src/lib/machine.js";
import { discoverProjects, writeDeclaredLifecycle } from "../src/lib/workspace.js";
import {
  applyReconcile,
  classifyDrift,
  committedLifecycle,
  reconcilePlan,
} from "../src/reconcile.js";
import { makeTmpStore, makeTmpWorkspace } from "./helpers.js";

function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function git(args: string[], cwd: string): void {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
}

function writeTask(dir: string, name: string, content: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content);
}

const TASK_BODY = (id: string, updated: string) =>
  `---\nid: ${id}\nstatus: todo\nupdated: ${updated}\n---\n\n# ${id}\n`;

// ---------------------------------------------------------------------------
// Lifecycle drift — propose then apply (the motivating incident, healed)
// ---------------------------------------------------------------------------

test("reconcile heals dormant-metadata-at-top-level: revert (proposed then applied)", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);

  // A project sits at the TOP LEVEL (location = active) but its metadata
  // declares dormant — exactly the iCloud-resurrected-a-shelved-project shape.
  // The non-git tiebreaker: a local intent says the human last set it dormant.
  const p = tw.addProject("AutoSoft");
  writeDeclaredLifecycle(p.root, "dormant", "2026-06-11T00:00:00Z");
  appendLifecycleIntent(store, { uid: p.uid, to: "dormant", at: "2026-06-11T00:00:00Z", machine: "mbp" });

  // propose
  const plan = reconcilePlan(tw.ws, store);
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0]?.kind, "revert-location");
  assert.equal(plan.ambiguous.length, 0);
  // nothing moved yet (dry-run is pure)
  assert.ok(fs.existsSync(p.root), "propose did not move the folder");

  // apply
  const result = applyReconcile(plan, store);
  assert.equal(result.applied.length, 1);
  const expected = path.join(tw.root, "Dormant Projects", "AutoSoft");
  assert.ok(fs.existsSync(expected), "reconcile filed it into the shelf to match metadata");
  assert.ok(!fs.existsSync(p.root), "the top-level (forged) location is gone");
});

test("reconcile is idempotent: a second pass after healing is a no-op", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);

  const p = tw.addProject("AutoSoft");
  writeDeclaredLifecycle(p.root, "dormant", "2026-06-11T00:00:00Z");
  appendLifecycleIntent(store, { uid: p.uid, to: "dormant", at: "2026-06-11T00:00:00Z", machine: "mbp" });
  applyReconcile(reconcilePlan(tw.ws, store), store);

  const second = reconcilePlan(tw.ws, store);
  assert.equal(second.actions.length, 0, "no drift remains");
  assert.equal(second.ambiguous.length, 0);
  assert.equal(second.errors.length, 0);
});

test("non-git glitch with a metadata-pointing intent → auto-revert (intent-glitch)", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);

  // "Habits" DECLARES dormant and the last local intent ALSO says dormant; the
  // folder nonetheless sits at the TOP LEVEL → iCloud moved it → the intent
  // matches the metadata, nothing points at the location → glitch → revert it
  // back into Dormant Projects/.
  const p = tw.addProject("Habits");
  writeDeclaredLifecycle(p.root, "dormant", "2026-06-11T00:00:00Z");
  appendLifecycleIntent(store, { uid: p.uid, to: "dormant", at: "2026-06-11T00:00:00Z", machine: "mbp" });

  const plan = reconcilePlan(tw.ws, store);
  assert.equal(plan.actions[0]?.kind, "revert-location");
  applyReconcile(plan, store);
  assert.ok(
    fs.existsSync(path.join(tw.root, "Dormant Projects", "Habits")),
    "reverted back into Dormant Projects/",
  );
});

// ---------------------------------------------------------------------------
// BUG 1 — intent retirement: reconcile must NEVER fight a human.
//
// A once-acted intent must stop being glitch-evidence once the system has
// OBSERVED its convergence. Otherwise a stale dormant@T0 intent votes "glitch"
// forever, and a later human re-activation (a silent Finder drag, no command)
// gets silently yanked back to the shelf — fighting the user, unattended under
// --auto. The discriminator is OBSERVED CONVERGENCE: a fresh glitch (revert
// before any converged observation) keeps the intent live → auto-heal; a stale
// drag (convergence observed, THEN a drag weeks later) finds the intent retired
// → propose-only.
// ---------------------------------------------------------------------------

test("BUG 1: stale dormant intent → human re-activation drag is PROPOSE, not auto-revert (reconcile does not fight)", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);

  // T0: the human ran `lifecycle Proj --to dormant`. The command stamps the
  // declared truth, appends the intent, and moves the folder into the shelf.
  // All three converged: declared=dormant, located=dormant, intent=dormant@T0.
  const p = tw.addProject(path.join("Dormant Projects", "Proj"));
  writeDeclaredLifecycle(p.root, "dormant", "2026-05-01T00:00:00Z");
  appendLifecycleIntent(store, { uid: p.uid, to: "dormant", at: "2026-05-01T00:00:00Z", machine: "mbp" });

  // A reconcile pass while converged (declared==located) OBSERVES the
  // convergence and retires the intent through its ts. This is the no-op apply
  // the Mini runs routinely. Nothing in the tree changes.
  const beforeChildren = fs.readdirSync(path.join(tw.root, "Dormant Projects"));
  const converged = reconcilePlan(tw.ws, store);
  assert.equal(converged.actions.length, 0, "converged: no drift to act on");
  assert.deepEqual(converged.convergedIntents, { [p.uid]: "2026-05-01T00:00:00Z" }, "convergence observed for the uid");
  applyReconcile(converged, store);
  assert.equal(lastRetired(store, p.uid), "2026-05-01T00:00:00Z", "intent retired through its ts on observed convergence");
  assert.deepEqual(
    fs.readdirSync(path.join(tw.root, "Dormant Projects")),
    beforeChildren,
    "the converged observation pass mutates the tree not at all",
  );

  // Weeks later the human RE-ACTIVATES by dragging the folder back to top level
  // in Finder — NO command, so NO new intent. declared=dormant, located=active,
  // and the only intent (dormant@T0) is now RETIRED. The stale intent must NOT
  // vote glitch → reconcile must PROPOSE (ambiguous), never auto-revert.
  const top = path.join(tw.root, "Proj");
  fs.renameSync(p.root, top);

  const plan = reconcilePlan(tw.ws, store);
  assert.equal(plan.actions.length, 0, "no auto-action: the retired intent is not glitch-evidence");
  assert.equal(plan.ambiguous.length, 1, "the drift is surfaced as ambiguous (propose-only)");
  assert.equal(plan.ambiguous[0]?.project, "Proj");

  // --auto must NOT move it either (ambiguous rows are never in `actions`).
  applyReconcile(plan, store, { auto: true });
  assert.ok(fs.existsSync(top), "the human's re-activation is respected; reconcile did not yank it back");
  assert.ok(!fs.existsSync(p.root), "not silently re-shelved");
});

test("BUG 1 regression-guard: a FRESH glitch (no convergence ever observed) still auto-heals", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);

  // Same starting shape — declared=dormant, intent=dormant@T0 — but iCloud
  // reverts the move (folder appears at top level) BEFORE any reconcile pass
  // ever observed convergence. The intent is therefore NOT retired → it is live
  // glitch-evidence → auto-revert back to the shelf. This is the asymmetry that
  // makes retirement safe: it only neutralizes intents whose convergence we saw.
  const p = tw.addProject("Proj"); // already at top level (the "glitch")
  writeDeclaredLifecycle(p.root, "dormant", "2026-05-01T00:00:00Z");
  appendLifecycleIntent(store, { uid: p.uid, to: "dormant", at: "2026-05-01T00:00:00Z", machine: "mbp" });
  assert.equal(lastRetired(store, p.uid), null, "no convergence observed → intent un-retired");

  const plan = reconcilePlan(tw.ws, store);
  assert.equal(plan.actions[0]?.kind, "revert-location", "live intent → glitch → auto-revert");
  assert.equal(plan.ambiguous.length, 0);
  applyReconcile(plan, store, { auto: true });
  assert.ok(fs.existsSync(path.join(tw.root, "Dormant Projects", "Proj")), "fresh glitch reverted under --auto");
});

// ---------------------------------------------------------------------------
// The hard case: human-moved NON-GIT project, no intent → ambiguous
// ---------------------------------------------------------------------------

test("benign: dragging an UNDECLARED project to a shelf is auto-consistent (no drift, no fight)", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);

  // The human dragged "Writing" into Dormant Projects/ in Finder, and the
  // project declares NO lifecycle. effectiveLifecycle falls back to location
  // ⇒ dormant, which AGREES with where it sits — there is simply no drift. The
  // human's drag is respected automatically; the metadata view tracks it.
  const p = tw.addProject(path.join("Dormant Projects", "Writing"));
  const plan = reconcilePlan(tw.ws, store);
  assert.equal(plan.actions.length, 0);
  assert.equal(plan.ambiguous.length, 0, "no declaration to contradict location → nothing to reconcile");
  applyReconcile(plan, store);
  assert.ok(fs.existsSync(p.root), "left exactly where the human put it");
});

test("human-moved non-git project that DECLARED a contradicting state, no intent → ambiguous (no fighting the user)", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);

  // "Health" declares dormant in its metadata, but the human then dragged it
  // back out to the TOP LEVEL in Finder. No command ran, so there is no local
  // intent and no git. declared=dormant but location=active. This is
  // byte-identical to an iCloud glitch — the reconciler MUST refuse to guess
  // (propose both fixes), never yank it back.
  const p = tw.addProject("Health");
  writeDeclaredLifecycle(p.root, "dormant", "2026-06-01T00:00:00Z");

  const plan = reconcilePlan(tw.ws, store);
  assert.equal(plan.actions.length, 0, "nothing is auto-applied for an unprovable drift");
  assert.equal(plan.ambiguous.length, 1);
  assert.equal(plan.ambiguous[0]?.project, "Health");
  assert.match(plan.ambiguous[0]?.suggestion ?? "", /--to active/);
  assert.match(plan.ambiguous[0]?.suggestion ?? "", /--revert/);

  applyReconcile(plan, store);
  assert.ok(fs.existsSync(p.root), "the human's drag is respected; reconcile did not fight it");
});

// ---------------------------------------------------------------------------
// The git-repo tiebreaker (committed metadata is tombstone-honest)
// ---------------------------------------------------------------------------

test("git tiebreaker: committed project.toml reverts an iCloud glitch (git-glitch)", { skip: !gitAvailable() }, (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);

  // Build the project as a git repo whose COMMITTED metadata says dormant.
  const p = tw.addProject(path.join("Dormant Projects", "Tracked"));
  writeDeclaredLifecycle(p.root, "dormant", "2026-06-11T00:00:00Z");
  git(["init"], p.root);
  git(["add", "-A"], p.root);
  git(["commit", "-m", "committed dormant"], p.root);

  // committedLifecycle reads the tombstone-honest value
  assert.equal(committedLifecycle(p.root), "dormant");

  // Now iCloud "resurrects" it to the top level (location ⇒ active) WITHOUT a
  // commit. The working-tree project.toml still says dormant, location says
  // active. Git proves dormant is real → revert location.
  const top = path.join(tw.root, "Tracked");
  fs.renameSync(p.root, top);

  const plan = reconcilePlan(tw.ws, store);
  const lifecycleAction = plan.actions.find((a) => a.kind === "revert-location");
  assert.ok(lifecycleAction !== undefined, "git-proof drift produces a revert");
  assert.match(lifecycleAction.note, /committed project\.toml/);
  applyReconcile(plan, store);
  assert.ok(fs.existsSync(path.join(tw.root, "Dormant Projects", "Tracked")), "reverted to the committed state");
});

test("git tiebreaker: committed metadata MATCHING location → heal-metadata (git-drag)", { skip: !gitAvailable() }, (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);

  // The human moved "Moved" into Dormant Projects/ AND committed that with the
  // metadata declaring dormant. Then the WORKING-TREE metadata got scrambled to
  // a contradicting state (archived — e.g. an iCloud content revert of the toml
  // only). Committed (dormant) MATCHES the location (dormant); the working-tree
  // declaration (archived) is the stale/forged one → heal the in-tree metadata
  // forward to match the committed+located truth.
  const p = tw.addProject(path.join("Dormant Projects", "Moved"));
  writeDeclaredLifecycle(p.root, "dormant", "2026-06-11T00:00:00Z");
  git(["init"], p.root);
  git(["add", "-A"], p.root);
  git(["commit", "-m", "committed dormant at dormant location"], p.root);

  // Working-tree metadata scrambled to archived (contradicts the dormant
  // location) but NOT committed:
  writeDeclaredLifecycle(p.root, "archived", null);

  const plan = reconcilePlan(tw.ws, store);
  const heal = plan.actions.find((a) => a.kind === "heal-metadata");
  assert.ok(heal !== undefined, "committed-matches-location yields a metadata heal");
  applyReconcile(plan, store);
  const text = fs.readFileSync(path.join(p.root, "_project", "project.toml"), "utf8");
  assert.match(text, /lifecycle = "dormant"/, "declared metadata healed forward to match the committed+located truth");
});

test("classifyDrift returns ambiguous when not a tracked repo and no intent exists", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);
  const p = tw.addProject(path.join("Dormant Projects", "Lonely"));
  const cls = classifyDrift(p.root, "active", "dormant", store, p.uid);
  assert.equal(cls.driver, "ambiguous");
  assert.equal(cls.resolution, "propose");
});

// ---------------------------------------------------------------------------
// Record healing — same-ID duplicates
// ---------------------------------------------------------------------------

test("same-ID duplicate (identical content) → loser archived reversibly, winner kept", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);
  const p = tw.addProject("Proj");
  const tasksDir = path.join(p.root, "_project", "tasks");
  const body = TASK_BODY("task-50", "2026-06-10");
  // the iCloud-copy shape: "x.md" and "x 2.md", byte-identical
  writeTask(tasksDir, "task-50 - thing.md", body);
  writeTask(tasksDir, "task-50 - thing 2.md", body);

  const plan = reconcilePlan(tw.ws, store);
  const dedup = plan.actions.filter((a) => a.kind === "dedup-record");
  assert.equal(dedup.length, 1, "one loser proposed for archival");
  assert.equal(plan.errors.length, 0);

  applyReconcile(plan, store);
  assert.ok(fs.existsSync(path.join(tasksDir, "task-50 - thing.md")), "the shorter-named original is kept");
  assert.ok(!fs.existsSync(path.join(tasksDir, "task-50 - thing 2.md")), "the copy left the live dir");
  // archived reversibly under _project/archive/reconcile/<stamp>/tasks/
  const archiveRoot = path.join(p.root, "_project", "archive", "reconcile");
  const stamps = fs.readdirSync(archiveRoot);
  assert.equal(stamps.length, 1);
  assert.ok(
    fs.existsSync(path.join(archiveRoot, stamps[0] as string, "tasks", "task-50 - thing 2.md")),
    "loser is recoverable, not hard-deleted",
  );
});

test("same-ID duplicate with DIFFERING content → error (never auto-merged)", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);
  const p = tw.addProject("Proj");
  const tasksDir = path.join(p.root, "_project", "tasks");
  writeTask(tasksDir, "task-50 - a.md", TASK_BODY("task-50", "2026-06-10"));
  writeTask(tasksDir, "task-50 - b.md", TASK_BODY("task-50", "2026-06-11")); // differing

  const plan = reconcilePlan(tw.ws, store);
  assert.equal(plan.actions.filter((a) => a.kind === "dedup-record").length, 0);
  assert.equal(plan.errors.length, 1);
  assert.match(plan.errors[0] ?? "", /DIFFERING copies/);
});

// ---------------------------------------------------------------------------
// BUG 2 — dedup archive-target collision must never half-apply.
//
// A flat same-id duplicate and a ghost-dir same-id duplicate that share a
// BASENAME previously resolved to the SAME archive target. moveDir refuses to
// overwrite and would THROW at apply time AFTER the first move already landed —
// a half-applied state. The plan must either (a) give them distinct targets and
// apply both, or (b) report a plan error and apply NOTHING — never half.
// ---------------------------------------------------------------------------

test("BUG 2: flat + ghost-dir same-id duplicates sharing a basename → distinct targets, both applied, no half-apply", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);
  const p = tw.addProject("Proj");
  const tasksDir = path.join(p.root, "_project", "tasks");
  const body = TASK_BODY("task-50", "2026-06-10");

  // Flat pair (iCloud-copy shape): winner + loser, identical content.
  writeTask(tasksDir, "task-50 - thing.md", body);
  writeTask(tasksDir, "task-50 - thing 2.md", body);
  // Ghost-dir copy with the SAME basename as the flat loser AND identical
  // content → also a dedup loser. Pre-fix this collided on the archive target.
  writeTask(path.join(tasksDir, "todo"), "task-50 - thing 2.md", body);

  const plan = reconcilePlan(tw.ws, store);
  const dedup = plan.actions.filter((a) => a.kind === "dedup-record");
  // either distinct-target dedups (preferred), or a plan error — never a
  // duplicate destination silently left to throw mid-apply.
  const dests = dedup.map((a) => a.to);
  const distinct = new Set(dests);
  assert.equal(distinct.size, dests.length, "no two dedup actions share a destination");
  assert.equal(plan.errors.length, 0, "with unique targets there is nothing to escalate");
  assert.equal(dedup.length, 2, "both the flat loser and the ghost loser are deduped");

  applyReconcile(plan, store);
  // both losers left the live dirs; the winner stays; nothing half-applied.
  assert.ok(fs.existsSync(path.join(tasksDir, "task-50 - thing.md")), "winner kept");
  assert.ok(!fs.existsSync(path.join(tasksDir, "task-50 - thing 2.md")), "flat loser archived");
  assert.ok(!fs.existsSync(path.join(tasksDir, "todo", "task-50 - thing 2.md")), "ghost loser archived");
  // both recoverable under the reconcile archive (distinct homes).
  const archiveRoot = path.join(p.root, "_project", "archive", "reconcile");
  const stamp = fs.readdirSync(archiveRoot)[0] as string;
  const archived: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else archived.push(full);
    }
  };
  walk(path.join(archiveRoot, stamp));
  assert.equal(archived.length, 2, "both losers recoverable, not hard-deleted, no clobber");
});

test("BUG 2: two reverts colliding on one destination → plan error, apply is a whole-plan refusal (ZERO mutations)", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);

  // Two distinct projects whose folders share a BASENAME ("Dup"), each declaring
  // dormant with a metadata-pointing local intent, but located in DIFFERENT
  // non-dormant places (one in Archives/, one in a top-level subdir). Both
  // revert-location actions target Dormant Projects/Dup → a destination
  // collision. moveDir would refuse-and-throw after the first already moved, so
  // the planner escalates to a hard error and apply must mutate NOTHING.
  const c = tw.addProject(path.join("Archives", "Dup"));
  writeDeclaredLifecycle(c.root, "dormant", "2026-06-11T00:00:00Z");
  appendLifecycleIntent(store, { uid: c.uid, to: "dormant", at: "2026-06-11T00:00:00Z", machine: "mbp" });
  const d = tw.addProject(path.join("Elsewhere", "Dup"));
  writeDeclaredLifecycle(d.root, "dormant", "2026-06-11T00:00:00Z");
  appendLifecycleIntent(store, { uid: d.uid, to: "dormant", at: "2026-06-11T00:00:00Z", machine: "mbp" });

  const plan = reconcilePlan(tw.ws, store);
  const colliding = plan.errors.filter((e) => /colliding reconcile target/.test(e));
  assert.equal(colliding.length, 1, "the two reverts onto Dormant Projects/Dup are one escalated error");

  const result = applyReconcile(plan, store);
  assert.equal(result.applied.length, 0, "errors present → whole-plan refusal: nothing applied");
  assert.ok(fs.existsSync(c.root), "colliding source c untouched (no half-apply)");
  assert.ok(fs.existsSync(d.root), "colliding source d untouched (no half-apply)");
  assert.ok(!fs.existsSync(path.join(tw.root, "Dormant Projects", "Dup")), "neither revert landed");
});

// ---------------------------------------------------------------------------
// Record healing — resurrected state-named subdirs (ghost dirs)
// ---------------------------------------------------------------------------

test("resurrected EMPTY state-named subdir → removed", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);
  const p = tw.addProject("Proj");
  const ghost = path.join(p.root, "_project", "tasks", "todo");
  fs.mkdirSync(ghost, { recursive: true });

  const plan = reconcilePlan(tw.ws, store);
  assert.equal(plan.actions.filter((a) => a.kind === "remove-ghost-dir").length, 1);
  applyReconcile(plan, store);
  assert.ok(!fs.existsSync(ghost), "empty ghost dir removed");
});

test("resurrected state-named subdir WITH a record → rehomed flat, then dir removed", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);
  const p = tw.addProject("Proj");
  const tasksDir = path.join(p.root, "_project", "tasks");
  const ghost = path.join(tasksDir, "doing");
  writeTask(ghost, "task-7 - work.md", TASK_BODY("task-7", "2026-06-10"));

  const plan = reconcilePlan(tw.ws, store);
  assert.equal(plan.actions.filter((a) => a.kind === "rehome-ghost-record").length, 1);
  assert.equal(plan.actions.filter((a) => a.kind === "remove-ghost-dir-after").length, 1);

  applyReconcile(plan, store);
  assert.ok(fs.existsSync(path.join(tasksDir, "task-7 - work.md")), "record rehomed flat");
  assert.ok(!fs.existsSync(ghost), "ghost dir removed after rehoming");
});

test("tasks/archive/ is whitelisted — never touched by ghost-dir cleanup", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);
  const p = tw.addProject("Proj");
  const archive = path.join(p.root, "_project", "tasks", "archive");
  writeTask(archive, "task-3 - old.md", TASK_BODY("task-3", "2026-01-01"));

  const plan = reconcilePlan(tw.ws, store);
  assert.equal(plan.actions.length, 0, "archive/ is a legitimate retention home, left alone");
  assert.ok(fs.existsSync(path.join(archive, "task-3 - old.md")));
});

// ---------------------------------------------------------------------------
// Worktrees + nested projects don't shelve
// ---------------------------------------------------------------------------

test("nested projects are skipped for the lifecycle axis (they ride their parent)", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);
  tw.addProject("Outer");
  const inner = tw.addProject(path.join("Outer", "Inner"));
  writeDeclaredLifecycle(inner.root, "dormant", "2026-06-11T00:00:00Z");

  const plan = reconcilePlan(tw.ws, store);
  // the nested project declares dormant but must NOT be proposed for a move
  const innerActions = plan.actions.filter((a) => a.project === discoverProjects(tw.ws, { all: true }).find((x) => x.uid === inner.uid)?.relPath);
  assert.equal(innerActions.length, 0, "a nested project is never shelved by reconcile");
});
