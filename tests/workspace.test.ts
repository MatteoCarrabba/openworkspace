import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import { NotFoundError } from "../src/lib/errors.js";
import {
  DEFAULT_IGNORE,
  discoverProjects,
  findDuplicateUids,
  findProjectByUid,
  findProjectRoot,
  findWorkspaceRoot,
  lifecycleOf,
  loadWorkspaceConfig,
  openWorkspace,
  readProjectUid,
} from "../src/lib/workspace.js";
import { makeTmpDir, makeTmpWorkspace, rmrf } from "./helpers.js";

test("findWorkspaceRoot walks up from deep inside; null outside any workspace", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const deep = path.join(tw.root, "Some Project", "src", "deep");
  fs.mkdirSync(deep, { recursive: true });
  assert.equal(findWorkspaceRoot(deep), tw.root);

  const outside = makeTmpDir();
  t.after(() => rmrf(outside));
  assert.equal(findWorkspaceRoot(outside), null);
  assert.throws(() => openWorkspace(outside), NotFoundError);
});

test("openWorkspace: no locations.toml (or an empty config dir) falls back to walk-up, unchanged", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const configDir = makeTmpDir("ow-config-dir-"); // exists, but no locations.toml inside
  t.after(() => rmrf(configDir));
  const env = { OPENWORKSPACE_CONFIG_DIR: configDir };

  const deep = path.join(tw.root, "Some Project", "src", "deep");
  fs.mkdirSync(deep, { recursive: true });
  const ws = openWorkspace(deep, env);
  assert.equal(ws.root, tw.root);

  // Same outside-any-workspace failure as with no env override at all.
  const outside = makeTmpDir();
  t.after(() => rmrf(outside));
  assert.throws(() => openWorkspace(outside, env), NotFoundError);
});

test("openWorkspace: locations.toml with a localfs store wins over walk-up — runs from anywhere", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  tw.addProject("Some Project");

  const configDir = makeTmpDir("ow-config-dir-");
  t.after(() => rmrf(configDir));
  fs.writeFileSync(
    path.join(configDir, "locations.toml"),
    ['[[stores]]', 'name = "personal"', 'driver = "localfs"', `path = "${tw.root}"`, ""].join("\n"),
  );
  const env = { OPENWORKSPACE_CONFIG_DIR: configDir };

  // A cwd/startDir that is nowhere near the workspace — config alone resolves it.
  const elsewhere = makeTmpDir("ow-elsewhere-");
  t.after(() => rmrf(elsewhere));
  const ws = openWorkspace(elsewhere, env);
  assert.equal(ws.root, tw.root);
  assert.deepEqual(
    discoverProjects(ws).map((p) => p.relPath),
    ["Some Project"],
  );
});

test("openWorkspace: configured store missing its .openworkspace marker is a clear error, not a silent fallback", (t) => {
  const notAWorkspace = makeTmpDir("ow-not-a-workspace-");
  t.after(() => rmrf(notAWorkspace));
  const configDir = makeTmpDir("ow-config-dir-");
  t.after(() => rmrf(configDir));
  fs.writeFileSync(
    path.join(configDir, "locations.toml"),
    ['[[stores]]', 'name = "broken"', 'driver = "localfs"', `path = "${notAWorkspace}"`, ""].join("\n"),
  );
  const env = { OPENWORKSPACE_CONFIG_DIR: configDir };
  assert.throws(() => openWorkspace(notAWorkspace, env), NotFoundError);
});

test("config: absent file means all defaults", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const cfg = tw.ws.config;
  assert.equal(cfg.schema, 2);
  assert.equal(cfg.workspaceId, null);
  assert.equal(cfg.paths.dormant, "Dormant Projects");
  assert.equal(cfg.paths.archives, "Archives");
  assert.deepEqual(cfg.discovery.ignore, DEFAULT_IGNORE);
  assert.deepEqual(cfg.secrets.resolvers, {});
});

test("config: every key optional — partial config merges over defaults; unknown keys ignored", (t) => {
  const tw = makeTmpWorkspace(
    [
      'workspace_id = "11111111-2222-3333-4444-555555555555"',
      "",
      "[paths]",
      'dormant = "Shelf"',
      "",
      "[secrets.resolvers]",
      'op = "op read {ref}"',
      "",
      "[future_section]",
      'mystery = "ignored on read"',
      "",
    ].join("\n"),
  );
  t.after(tw.cleanup);
  const cfg = loadWorkspaceConfig(tw.root);
  assert.equal(cfg.workspaceId, "11111111-2222-3333-4444-555555555555");
  assert.equal(cfg.paths.dormant, "Shelf");
  assert.equal(cfg.paths.archives, "Archives", "unset key keeps default");
  assert.deepEqual(cfg.secrets.resolvers, { op: "op read {ref}" });
  assert.deepEqual(cfg.discovery.ignore, DEFAULT_IGNORE);
});

test("discovery: any dir with _project/id; spaces and colon dir names; ignores honored", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  tw.addProject("Personal OS");
  tw.addProject("Health and Fitness");
  // colon-in-name dir on the path to a project (the real Inbox:Outbox shape)
  tw.addProject(path.join("Inbox:Outbox", "Staged Project"));
  // not projects:
  fs.mkdirSync(path.join(tw.root, "Library", "papers"), { recursive: true });
  // a project hidden under an ignored dir must not be discovered
  const ignored = path.join(tw.root, "node_modules", "fake-project", "_project");
  fs.mkdirSync(ignored, { recursive: true });
  fs.writeFileSync(path.join(ignored, "id"), "should-not-appear\n");

  const found = discoverProjects(tw.ws);
  const rels = found.map((p) => p.relPath).sort();
  assert.deepEqual(rels, ["Health and Fitness", "Inbox:Outbox/Staged Project", "Personal OS"]);
  assert.ok(found.every((p) => p.lifecycle === "active"));
  assert.ok(found.every((p) => p.nestedUnder === null));
});

test("nested projects are boundaries: discovered as their own entries with nestedUnder set", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const outer = tw.addProject("Big Project");
  const inner = tw.addProject(path.join("Big Project", "Sub Effort"));
  const found = discoverProjects(tw.ws);
  const outerInfo = found.find((p) => p.uid === outer.uid);
  const innerInfo = found.find((p) => p.uid === inner.uid);
  assert.ok(outerInfo !== undefined && innerInfo !== undefined);
  assert.equal(outerInfo.nestedUnder, null);
  assert.equal(innerInfo.nestedUnder, outer.root);
});

test("discovery: finds all projects (incl. a 2-level-nested one under a shelf) but skips foreign git worktrees", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);

  // Top-level projects.
  tw.addProject("Personal OS");
  tw.addProject("Health and Fitness");

  // A project two levels under a shelf: Dormant Projects / Life Admin / Personal
  // Finance (the real workspace's `Dormant Projects/Life Admin/Personal Finance`).
  // The intermediate "Life Admin" is a plain dir, not a project.
  const nested = tw.addProject(path.join("Dormant Projects", "Life Admin", "Personal Finance"));

  // A nested project INSIDE another project must still be found (boundary walk).
  const inner = tw.addProject(path.join("Personal OS", "Sub Effort"));

  // A foreign git checkout at top level: a .git dir, content inside, NO project.
  // Its (huge) working tree must NOT be descended — and a project ID buried in
  // it must NOT be discovered.
  const repo = path.join(tw.root, "some-cloned-repo");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  const buried = path.join(repo, "vendor", "thing", "_project");
  fs.mkdirSync(buried, { recursive: true });
  fs.writeFileSync(path.join(buried, "id"), "buried-in-foreign-repo\n");

  const found = discoverProjects(tw.ws, { all: true });
  const rels = found.map((p) => p.relPath).sort();
  assert.deepEqual(rels, [
    "Dormant Projects/Life Admin/Personal Finance",
    "Health and Fitness",
    "Personal OS",
    "Personal OS/Sub Effort",
  ]);

  // The 2-level-nested shelf project is found with dormant lifecycle.
  assert.equal(found.find((p) => p.uid === nested.uid)?.lifecycle, "dormant");
  // The in-project nested project carries nestedUnder.
  assert.equal(found.find((p) => p.uid === inner.uid)?.nestedUnder?.endsWith("Personal OS"), true);
  // The project buried in the foreign git worktree was never descended into.
  assert.equal(found.some((p) => p.uid === "buried-in-foreign-repo"), false);
});

test("discovery: a workspace's OWN project carrying .git is still walked (not treated as foreign)", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const outer = tw.addProject("Repo Project");
  // The project itself is under version control.
  fs.mkdirSync(path.join(outer.root, ".git"), { recursive: true });
  // ...and contains a nested project — which must still be discovered.
  const inner = tw.addProject(path.join("Repo Project", "Nested"));
  const found = discoverProjects(tw.ws);
  assert.equal(found.some((p) => p.uid === outer.uid), true, "the project with .git is found");
  assert.equal(found.some((p) => p.uid === inner.uid), true, "its nested project is still found");
});

test("shelves excluded from default scans; --all includes them with lifecycle from location", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  tw.addProject("Active One");
  const dormant = tw.addProject(path.join("Dormant Projects", "AutoSoft"));
  const archived = tw.addProject(path.join("Archives", "Old Thing"));

  const defaults = discoverProjects(tw.ws);
  assert.deepEqual(defaults.map((p) => p.relPath), ["Active One"]);

  const all = discoverProjects(tw.ws, { all: true });
  const byUid = new Map(all.map((p) => [p.uid, p]));
  assert.equal(byUid.get(dormant.uid)?.lifecycle, "dormant");
  assert.equal(byUid.get(archived.uid)?.lifecycle, "archived");
  assert.equal(all.find((p) => p.relPath === "Active One")?.lifecycle, "active");
});

test("configured shelf paths drive both exclusion and lifecycle", (t) => {
  const tw = makeTmpWorkspace('[paths]\ndormant = "On Ice"\narchives = "Done & Dusted"\n');
  t.after(tw.cleanup);
  const iced = tw.addProject(path.join("On Ice", "Sleeper"));
  tw.addProject("Awake");
  assert.deepEqual(discoverProjects(tw.ws).map((p) => p.relPath), ["Awake"]);
  assert.equal(lifecycleOf(tw.ws, iced.root), "dormant");
  // the default-named dirs are now just directories
  const plain = tw.addProject(path.join("Dormant Projects", "Not Actually Dormant"));
  assert.equal(lifecycleOf(tw.ws, plain.root), "active");
});

test("a top-level project (formerly 'ongoing') is just active", (t) => {
  // Matteo dropped the `ongoing` lifecycle state 2026-06-11: an ongoing project
  // (e.g. Health and Fitness) is just an active one the human never archives.
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const p = tw.addProject("Health and Fitness");
  tw.addProject("Regular");
  const found = discoverProjects(tw.ws);
  assert.equal(found.find((x) => x.uid === p.uid)?.lifecycle, "active");
  assert.equal(found.find((x) => x.relPath === "Regular")?.lifecycle, "active");
});

test("duplicate-UID detection (the iCloud-copy / merge backstop)", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  tw.addProject("Original", "dupe-uid-1");
  tw.addProject("Original copy", "dupe-uid-1");
  tw.addProject("Innocent");
  const dupes = findDuplicateUids(discoverProjects(tw.ws));
  assert.equal(dupes.size, 1);
  assert.equal(dupes.get("dupe-uid-1")?.length, 2);
});

test("findProjectByUid scans live (shelves included) and returns null for unknown", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const shelved = tw.addProject(path.join("Archives", "Cold Case"));
  assert.equal(findProjectByUid(tw.ws, shelved.uid)?.root, shelved.root);
  assert.equal(findProjectByUid(tw.ws, "no-such-uid"), null);
});

test("readProjectUid / findProjectRoot walk-up", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const p = tw.addProject("My Project");
  assert.equal(readProjectUid(p.root), p.uid);
  assert.equal(readProjectUid(tw.root), null);
  const deep = path.join(p.root, "src", "nested");
  fs.mkdirSync(deep, { recursive: true });
  assert.deepEqual(findProjectRoot(deep), { root: p.root, uid: p.uid });
  assert.equal(findProjectRoot(tw.root), null);
});

test("no registry file is ever created by discovery", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  tw.addProject("P1");
  discoverProjects(tw.ws, { all: true });
  const markerEntries = fs.readdirSync(path.join(tw.root, ".openworkspace"));
  assert.deepEqual(markerEntries, [], "scan must not write anything into .openworkspace/");
});
