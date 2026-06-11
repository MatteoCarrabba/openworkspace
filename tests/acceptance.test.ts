/**
 * PRD acceptance checks (integrator-owned). Everything runs in temp dirs.
 *
 * 1. No registry/manifest/state file is created anywhere by any operation —
 *    the tree is the database (PRD §1, principle 2/8).
 * 2. Duplicate `_project/id` is reported (doctor; iCloud + merge backstop).
 * 3. A state-named subdir under tasks/ is flagged by doctor (PRD §4.3/§10).
 * 4. `projects init` output matches the Appendix A / §4.3 skeleton exactly.
 * 5. A worktree-shaped forum post lands in the CANONICAL tree (PRD §6.3) —
 *    simulated with a second checkout dir + injected resolution.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import { doctorProject, doctorWorkspace } from "../src/doctor.js";
import { FORUM_README, PROJECT_GITIGNORE, PROJECT_README, initProject, initWorkspace } from "../src/init.js";
import { discoverProjects, openWorkspace } from "../src/lib/workspace.js";
import * as decisions from "../src/primitives/decisions.js";
import * as forum from "../src/primitives/forum.js";
import * as tasks from "../src/primitives/tasks.js";
import { makeTmpDir, makeTmpStore, makeTmpWorkspace, rmrf } from "./helpers.js";

/** Recursive listing of relative paths; directories get a trailing "/". */
function treeOf(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const entRel = rel === "" ? ent.name : `${rel}/${ent.name}`;
      if (ent.isDirectory()) {
        out.push(entRel + "/");
        walk(path.join(dir, ent.name), entRel);
      } else {
        out.push(entRel);
      }
    }
  };
  walk(root, "");
  return out.sort();
}

// ---------------------------------------------------------------------------
// 4. init output matches the §4.3 skeleton exactly
// ---------------------------------------------------------------------------

test("acceptance: projects init stamps exactly the Appendix A / §4.3 skeleton", (t) => {
  const tmp = makeTmpDir();
  t.after(() => rmrf(tmp));
  const projectDir = path.join(tmp, "Colon: And Space Project");

  const { uid } = initProject(projectDir);
  assert.match(uid, /^[0-9a-f-]{36}$/);

  assert.deepEqual(treeOf(path.join(projectDir, "_project")), [
    ".gitignore",
    "README.md",
    "automations/",
    "decisions/",
    "forum/",
    "forum/README.md",
    "forum/presence/",
    "forum/threads/",
    "id",
    "plans/",
    "plans/current.md",
    "tasks/",
    "wiki/",
  ]);

  // Orientation artifacts are part of the schema deliverable, stamped verbatim.
  assert.equal(fs.readFileSync(path.join(projectDir, "_project", "README.md"), "utf8"), PROJECT_README);
  assert.equal(fs.readFileSync(path.join(projectDir, "_project", ".gitignore"), "utf8"), PROJECT_GITIGNORE);
  assert.equal(fs.readFileSync(path.join(projectDir, "_project", "forum", "README.md"), "utf8"), FORUM_README);
  assert.ok(PROJECT_README.includes("## The two rules that explain everything here"));
  assert.ok(FORUM_README.includes("## Arrival protocol"));
  assert.equal(fs.readFileSync(path.join(projectDir, "_project", "id"), "utf8"), uid + "\n");

  // No C3 naming anywhere in the stamped artifacts (PRD §0 boundary test).
  for (const artifact of [PROJECT_README, FORUM_README, PROJECT_GITIGNORE]) {
    assert.ok(!/Brief\.md|Today\.md|C2\/|Matteo/.test(artifact), "stamped artifact names a C3 artifact");
  }

  // Re-init refuses: _project/id is write-once.
  assert.throws(() => initProject(projectDir), /already a project/);

  // A freshly stamped project is doctor-clean.
  const issues = doctorProject(projectDir);
  assert.deepEqual(issues.map((i) => i.message), []);
});

test("acceptance: home init mints a workspace_id and writes only non-defaults", (t) => {
  const tmp = makeTmpDir();
  t.after(() => rmrf(tmp));

  const first = initWorkspace(tmp);
  assert.equal(first.created, true);
  const configPath = path.join(tmp, ".openworkspace", "config.toml");
  const config = fs.readFileSync(configPath, "utf8");
  assert.match(config, /^schema = 2$/m);
  assert.match(config, new RegExp(`^workspace_id = "${first.workspaceId}"$`, "m"));
  assert.ok(!config.includes("[paths]"), "defaults are implicit, not stamped");
  assert.ok(!config.includes("[discovery]"));

  // idempotent: the second run keeps the same id and changes nothing
  const second = initWorkspace(tmp);
  assert.equal(second.workspaceId, first.workspaceId);
  assert.equal(fs.readFileSync(configPath, "utf8"), config);

  // marker contents: the config file + the (empty) per-machine registry home
  // (§4.1) — no project registry, no caches. Machine registry FILES appear
  // only via `projects home init` on a machine (§7.3), never from the library.
  assert.deepEqual(treeOf(path.join(tmp, ".openworkspace")), ["config.toml", "machines/"]);
});

// ---------------------------------------------------------------------------
// 1. no registry/manifest file created anywhere by any operation
// ---------------------------------------------------------------------------

test("acceptance: a full operation battery writes records only — no registry/manifest/state files", (t) => {
  const tmp = makeTmpDir();
  t.after(() => rmrf(tmp));
  const tmpStore = makeTmpStore();
  t.after(tmpStore.cleanup);

  initWorkspace(tmp);
  const projectDir = path.join(tmp, "Proj A");
  initProject(projectDir);
  const ws = openWorkspace(tmp);

  // battery: tasks, decisions, forum, scans, doctor
  const task = tasks.createTask(projectDir, tmpStore.store, { title: "First" });
  tasks.createTask(projectDir, tmpStore.store, { title: "Child", parent: task.id });
  tasks.setStatus(projectDir, task.id, "doing");
  tasks.listTasks(projectDir, { all: true });
  const d1 = decisions.newDecision(projectDir, tmpStore.store, { title: "Choose codec" });
  decisions.acceptDecision(projectDir, d1.id);
  decisions.listDecisions(projectDir);
  const ctx: forum.ForumContext = {
    startDir: projectDir,
    store: tmpStore.store,
    env: { OW_ACTOR: "claude-acc" },
  };
  forum.announce(ctx, { plan: "acceptance battery" });
  forum.openThread(ctx, { title: "Battery thread" });
  forum.post(ctx, "battery-thread", { body: "hello" });
  forum.who(ctx);
  forum.inbox(ctx);
  discoverProjects(ws, { all: true });
  doctorWorkspace(ws);

  const tree = treeOf(tmp);

  // The marker dir holds the config + the empty machines/ registry home —
  // nothing project-registered, listed, or cached.
  assert.deepEqual(
    tree.filter((p) => p.startsWith(".openworkspace/")),
    [".openworkspace/", ".openworkspace/config.toml", ".openworkspace/machines/"],
  );

  // No state/registry/manifest-shaped file anywhere in the workspace.
  const forbidden = /(registry|manifest|index\.(json|toml|md)|\.cache|\.sqlite|\.db|status\.(json|toml))$/i;
  const offenders = tree.filter((p) => forbidden.test(p));
  assert.deepEqual(offenders, []);

  // Every file written lives where the schema says records live.
  const files = tree.filter((p) => !p.endsWith("/"));
  for (const f of files) {
    assert.ok(
      f === ".openworkspace/config.toml" || f.startsWith("Proj A/_project/"),
      `unexpected write outside the schema: ${f}`,
    );
  }

  // ...and discovery/doctor/list are pure reads: snapshot is stable across them.
  const before = treeOf(tmp);
  discoverProjects(ws, { all: true });
  doctorWorkspace(ws);
  tasks.listTasks(projectDir, { all: true });
  forum.listThreads(ctx);
  assert.deepEqual(treeOf(tmp), before);
});

// ---------------------------------------------------------------------------
// 2. duplicate _project/id reported
// ---------------------------------------------------------------------------

test("acceptance: duplicate project uid is a doctor error", (t) => {
  const wsFix = makeTmpWorkspace();
  t.after(wsFix.cleanup);
  wsFix.addProject("Proj One", "uid-dup");
  wsFix.addProject("Proj Two", "uid-dup");

  const report = doctorWorkspace(wsFix.ws);
  const dup = report.issues.filter((i) => /duplicate project uid uid-dup/.test(i.message));
  assert.equal(dup.length, 1);
  assert.equal(dup[0]?.severity, "error");
  assert.ok(report.errors >= 1);
});

// ---------------------------------------------------------------------------
// 3. state-named subdir under tasks/ flagged
// ---------------------------------------------------------------------------

test("acceptance: state-named subdirectory under tasks/ is a doctor error", (t) => {
  const tmp = makeTmpDir();
  t.after(() => rmrf(tmp));
  const projectDir = path.join(tmp, "Stateful");
  initProject(projectDir);
  fs.mkdirSync(path.join(projectDir, "_project", "tasks", "todo"));
  fs.mkdirSync(path.join(projectDir, "_project", "tasks", "archive")); // allowed

  const issues = doctorProject(projectDir);
  const flagged = issues.filter((i) => /state-named subdirectory/.test(i.message));
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0]?.severity, "error");
  assert.match(flagged[0]?.file ?? "", /tasks[/\\]todo/);
  assert.ok(!issues.some((i) => /archive/.test(i.file ?? "") && /subdirectory/.test(i.message)));
});

// ---------------------------------------------------------------------------
// 5. worktree-shaped forum post lands in the canonical tree
// ---------------------------------------------------------------------------

test("acceptance: forum verbs from a second checkout land in the canonical tree", (t) => {
  // canonical workspace + project
  const tmpStore = makeTmpStore();
  t.after(tmpStore.cleanup);
  const canonicalWs = makeTmpDir("ow-canonical-");
  t.after(() => rmrf(canonicalWs));
  initWorkspace(canonicalWs);
  const canonicalProject = path.join(canonicalWs, "Shared Proj");
  const { uid } = initProject(canonicalProject);

  // a worktree-shaped second checkout OUTSIDE the workspace: same committed
  // _project/id, its own (stale) forum dirs
  const worktree = makeTmpDir("ow-worktree-");
  t.after(() => rmrf(worktree));
  const wtProject = path.join(worktree, "Shared Proj");
  fs.mkdirSync(path.join(wtProject, "_project", "forum", "threads"), { recursive: true });
  fs.mkdirSync(path.join(wtProject, "_project", "forum", "presence"), { recursive: true });
  fs.writeFileSync(path.join(wtProject, "_project", "id"), uid + "\n");

  const ctx: forum.ForumContext = {
    startDir: wtProject,
    store: tmpStore.store,
    env: { OW_ACTOR: "claude-wt" },
    // injected resolution: the canonical workspace is known to this machine
    extraWorkspaceRoots: [canonicalWs],
  };

  const info = forum.openThread(ctx, { title: "Cross worktree" });
  const message = forum.post(ctx, "cross-worktree", { body: "from the worktree" });
  forum.announce(ctx, { plan: "in a worktree" });

  const canonicalThreads = path.join(canonicalProject, "_project", "forum", "threads");
  const wtThreads = path.join(wtProject, "_project", "forum", "threads");

  // thread + message + presence all live in CANONICAL...
  assert.ok(info.dir.startsWith(canonicalThreads), `thread dir not canonical: ${info.dir}`);
  assert.ok(message.file.startsWith(canonicalThreads), `message not canonical: ${message.file}`);
  assert.ok(fs.existsSync(message.file));
  assert.equal(fs.readdirSync(path.join(canonicalProject, "_project", "forum", "presence")).length, 1);

  // ...and the worktree's own forum stayed untouched (no split brain)
  assert.deepEqual(fs.readdirSync(wtThreads), []);
  assert.deepEqual(fs.readdirSync(path.join(wtProject, "_project", "forum", "presence")), []);

  // reads route canonical too: the worktree context SEES the message
  const shown = forum.showThread(ctx, "cross-worktree");
  assert.equal(shown.messages.length, 1);
  assert.equal(shown.messages[0]?.from, "claude-wt");

  // and an unresolvable UID is loud (exit-2 error class), never a local write
  const orphan = makeTmpDir("ow-orphan-");
  t.after(() => rmrf(orphan));
  const orphanProject = path.join(orphan, "Orphan");
  fs.mkdirSync(path.join(orphanProject, "_project"), { recursive: true });
  fs.writeFileSync(path.join(orphanProject, "_project", "id"), "no-such-uid\n");
  const freshStore = makeTmpStore();
  t.after(freshStore.cleanup);
  assert.throws(
    () =>
      forum.post(
        { startDir: orphanProject, store: freshStore.store, env: { OW_ACTOR: "x" } },
        "anything",
        { body: "nope" },
      ),
    (err: unknown) => (err as { exitCode?: number }).exitCode === 2,
  );
});

// ---------------------------------------------------------------------------
// Regression: completing a hand-maintained config preserves it byte-for-byte
// (and goes through the atomic writer — PRD §5.1 "always")
// ---------------------------------------------------------------------------

test("acceptance: home init on a hand-maintained config prepends the id and keeps every human byte", (t) => {
  const tmp = makeTmpDir();
  t.after(() => rmrf(tmp));
  fs.mkdirSync(path.join(tmp, ".openworkspace"));
  const handConfig = [
    "# my workspace — hand-tuned; comments are precious",
    'schema = 2',
    "",
    "[paths]",
    'dormant = "Shelf/Dormant"   # note the rename',
    "",
    "[secrets.resolvers]",
    'op = "op read {ref}"',
    "",
  ].join("\n");
  const configPath = path.join(tmp, ".openworkspace", "config.toml");
  fs.writeFileSync(configPath, handConfig);

  const result = initWorkspace(tmp);
  const after = fs.readFileSync(configPath, "utf8");
  assert.equal(
    after,
    `workspace_id = "${result.workspaceId}"\n` + handConfig,
    "minted id prepended; the human's text (comments, tables, order) verbatim",
  );
  // no temp residue from the atomic write
  assert.deepEqual(fs.readdirSync(path.dirname(configPath)).filter((n) => n.includes("ow-tmp")), []);
  // idempotent: a re-run keeps the same id and the same bytes
  assert.equal(initWorkspace(tmp).workspaceId, result.workspaceId);
  assert.equal(fs.readFileSync(configPath, "utf8"), after);
});
