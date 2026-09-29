/**
 * `[projects] external_roots` — project roots OUTSIDE the workspace tree
 * (e.g. a git repo under ~/Code that is itself an OpenWorkspace project).
 *
 * Covers: config parsing, `~`/relative resolution, discovery (project root,
 * folder-of-projects root, nested projects), dedupe (in-tree overlap, repeated
 * entries, symlinked spellings), missing roots (doctor warns, nothing throws),
 * the linked-worktree guard (never discovered, never canonical), metadata-only
 * lifecycle (reconcile never moves an external project), skills sources, and
 * the CLI fallback that routes workspace commands run from inside an external
 * root to the workspace that lists it.
 */

import * as assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import { doctorWorkspace, externalRootIssues } from "../src/doctor.js";
import { ConfigError } from "../src/lib/errors.js";
import { registerWorkspace } from "../src/lib/machine.js";
import { findWorkspaceClaimingPath, resolveCanonicalProject } from "../src/lib/resolve.js";
import {
  MARKER_DIR,
  discoverProjects,
  expandHomePath,
  externalProjectRoots,
  findDuplicateUids,
  isLinkedWorktreeCheckout,
  lifecycleOf,
  loadWorkspaceConfig,
  openWorkspace,
  writeDeclaredLifecycle,
} from "../src/lib/workspace.js";
import { reconcilePlan } from "../src/reconcile.js";
import { SkillsFs, defaultSourceRoots } from "../src/skills.js";
import { makeTmpDir, makeTmpStore, rmrf } from "./helpers.js";

const CLI = path.resolve(__dirname, "..", "src", "cli.js");

function makeProject(dir: string, uid: string = crypto.randomUUID()): { root: string; uid: string } {
  fs.mkdirSync(path.join(dir, "_project"), { recursive: true });
  fs.writeFileSync(path.join(dir, "_project", "id"), uid + "\n");
  return { root: dir, uid };
}

function tomlString(s: string): string {
  return JSON.stringify(s); // a JSON string is a valid TOML basic string
}

/** A temp workspace whose config lists `roots` under [projects] external_roots. */
function makeWs(roots: string[]): { root: string; cleanup: () => void } {
  const root = makeTmpDir("ow-ext-ws-");
  fs.mkdirSync(path.join(root, MARKER_DIR));
  fs.writeFileSync(
    path.join(root, MARKER_DIR, "config.toml"),
    `schema = 2\n\n[projects]\nexternal_roots = [${roots.map(tomlString).join(", ")}]\n`,
  );
  return { root, cleanup: () => rmrf(root) };
}

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

const realFs: SkillsFs = {
  existsSync: fs.existsSync,
  readdirSync: (p, opts) => fs.readdirSync(p, opts),
  readFileSync: (p, enc) => fs.readFileSync(p, enc),
  lstatSync: fs.lstatSync,
  readlinkSync: fs.readlinkSync,
  symlinkSync: fs.symlinkSync,
  unlinkSync: fs.unlinkSync,
  mkdirSync: (p, opts) => {
    fs.mkdirSync(p, opts);
  },
};

// ---------------------------------------------------------------------------
// config

test("external_roots: absent ⇒ []; array of strings parsed as written; bad type is a ConfigError", (t) => {
  const plain = makeTmpDir("ow-ext-cfg-");
  t.after(() => rmrf(plain));
  fs.mkdirSync(path.join(plain, MARKER_DIR));
  assert.deepEqual(loadWorkspaceConfig(plain).projects.externalRoots, []);

  const ws = makeWs(["~/Code/repo", "../sibling", "/abs/path", ""]);
  t.after(ws.cleanup);
  // blank entries are dropped; the rest are kept verbatim (resolution is separate)
  assert.deepEqual(loadWorkspaceConfig(ws.root).projects.externalRoots, ["~/Code/repo", "../sibling", "/abs/path"]);

  const bad = makeTmpDir("ow-ext-bad-");
  t.after(() => rmrf(bad));
  fs.mkdirSync(path.join(bad, MARKER_DIR));
  fs.writeFileSync(path.join(bad, MARKER_DIR, "config.toml"), `[projects]\nexternal_roots = "~/Code"\n`);
  assert.throws(() => loadWorkspaceConfig(bad), ConfigError);
  fs.writeFileSync(path.join(bad, MARKER_DIR, "config.toml"), `[projects]\nexternal_roots = [1, 2]\n`);
  assert.throws(() => loadWorkspaceConfig(bad), ConfigError);
});

test("external_roots: `~` expands to home, relative resolves against the workspace root, deduped", (t) => {
  const ws = makeWs(["~", "~/Code/repo", "../sibling", "/abs/path", "/abs/path/", "~other/x"]);
  t.after(ws.cleanup);
  const home = "/home/tester";
  assert.equal(expandHomePath("~", home), home);
  assert.equal(expandHomePath("~/a/b", home), "/home/tester/a/b");
  assert.equal(expandHomePath("~other/x", home), "~other/x"); // ~user is NOT expanded

  const w = openWorkspace(ws.root);
  const resolved = externalProjectRoots(w, home).map((e) => e.path);
  assert.deepEqual(resolved, [
    home,
    "/home/tester/Code/repo",
    path.resolve(ws.root, "..", "sibling"),
    "/abs/path", // "/abs/path/" dedupes onto it
    path.resolve(ws.root, "~other/x"),
  ]);
});

// ---------------------------------------------------------------------------
// discovery

test("discovery: an external project root is discovered (with nested projects) and relPath round-trips", (t) => {
  const ext = makeTmpDir("ow-ext-proj-");
  t.after(() => rmrf(ext));
  const repo = makeProject(path.join(ext, "My Repo"));
  const nested = makeProject(path.join(repo.root, "packages", "inner"));

  const ws = makeWs([repo.root]);
  t.after(ws.cleanup);
  const inTree = makeProject(path.join(ws.root, "Local Project"));
  const w = openWorkspace(ws.root);

  const all = discoverProjects(w, { all: true });
  assert.deepEqual(all.map((p) => p.uid).sort(), [inTree.uid, repo.uid, nested.uid].sort());
  const r = all.find((p) => p.uid === repo.uid);
  const n = all.find((p) => p.uid === nested.uid);
  const l = all.find((p) => p.uid === inTree.uid);
  assert.equal(r?.externalRoot, repo.root);
  assert.equal(r?.nestedUnder, null);
  assert.equal(r?.lifecycle, "active");
  assert.ok(r?.relPath.startsWith(".."));
  assert.equal(path.resolve(w.root, r?.relPath ?? ""), repo.root); // invariant
  assert.equal(n?.externalRoot, repo.root);
  assert.equal(n?.nestedUnder, repo.root);
  assert.equal(l?.externalRoot, null);

  // default (non --all) scans include external projects too; external:false opts out
  assert.equal(discoverProjects(w).length, 3);
  assert.deepEqual(
    discoverProjects(w, { all: true, external: false }).map((p) => p.uid),
    [inTree.uid],
  );
});

test("discovery: an external root may be a plain folder holding several projects", (t) => {
  const code = makeTmpDir("ow-ext-code-");
  t.after(() => rmrf(code));
  const a = makeProject(path.join(code, "a"));
  const b = makeProject(path.join(code, "group", "b"));
  fs.mkdirSync(path.join(code, "not-a-project", "deep"), { recursive: true });
  // a foreign git checkout (not a project) under the folder is not walked
  fs.mkdirSync(path.join(code, "clone", ".git"), { recursive: true });
  makeProject(path.join(code, "clone", "vendored")); // hidden inside the foreign checkout

  const ws = makeWs([code]);
  t.after(ws.cleanup);
  const found = discoverProjects(openWorkspace(ws.root), { all: true });
  assert.deepEqual(found.map((p) => p.uid).sort(), [a.uid, b.uid].sort());
  assert.ok(found.every((p) => p.externalRoot === code && p.nestedUnder === null));
});

test("discovery: missing / non-dir / foreign-git external roots are skipped, never thrown; doctor WARNS", (t) => {
  const tmp = makeTmpDir("ow-ext-bad-roots-");
  t.after(() => rmrf(tmp));
  const file = path.join(tmp, "a-file");
  fs.writeFileSync(file, "x");
  const foreign = path.join(tmp, "foreign");
  fs.mkdirSync(path.join(foreign, ".git"), { recursive: true });
  const empty = path.join(tmp, "empty");
  fs.mkdirSync(empty);

  const ws = makeWs([path.join(tmp, "missing"), file, foreign, empty]);
  t.after(ws.cleanup);
  const w = openWorkspace(ws.root);
  assert.deepEqual(discoverProjects(w, { all: true }), []);

  const rep = doctorWorkspace(w);
  assert.equal(rep.errors, 0, JSON.stringify(rep.issues));
  const msgs = rep.issues.filter((i) => i.severity === "warn").map((i) => i.message);
  assert.ok(msgs.some((m) => /missing.*does not exist/.test(m)), msgs.join("\n"));
  assert.ok(msgs.some((m) => /a-file.*is not a directory/.test(m)), msgs.join("\n"));
  assert.ok(msgs.some((m) => /foreign.*git checkout that is not an OpenWorkspace project/.test(m)), msgs.join("\n"));
  assert.ok(msgs.some((m) => /empty.*contains no OpenWorkspace projects/.test(m)), msgs.join("\n"));
});

test("discovery: dedupe — an external root inside the tree, a repeated entry, and a symlinked spelling", (t) => {
  const ext = makeTmpDir("ow-ext-dedupe-");
  t.after(() => rmrf(ext));
  const repo = makeProject(path.join(ext, "repo"));
  const alias = path.join(ext, "alias");
  fs.symlinkSync(repo.root, alias);

  const ws = makeWs([]);
  t.after(ws.cleanup);
  const inTree = makeProject(path.join(ws.root, "Inside"));
  fs.writeFileSync(
    path.join(ws.root, MARKER_DIR, "config.toml"),
    `[projects]\nexternal_roots = [${[inTree.root, "Inside", repo.root, alias, repo.root + "/"].map(tomlString).join(", ")}]\n`,
  );
  const w = openWorkspace(ws.root);
  const all = discoverProjects(w, { all: true });
  assert.equal(all.length, 2, all.map((p) => p.root).join("\n"));
  assert.equal(findDuplicateUids(all).size, 0);
  // the in-tree copy wins (walked first): it stays an in-tree project
  assert.equal(all.find((p) => p.uid === inTree.uid)?.externalRoot, null);

  const issues = externalRootIssues(w, all);
  assert.ok(issues.every((i) => i.severity === "info"), JSON.stringify(issues));
  assert.ok(issues.some((i) => /inside the workspace tree — redundant/.test(i.message)));
});

test("worktree guard: a linked git worktree is never discovered from an external root, nor canonical", (t) => {
  if (!gitAvailable()) {
    t.skip("git not available");
    return;
  }
  const code = makeTmpDir("ow-ext-wt-");
  t.after(() => rmrf(code));
  const repo = makeProject(path.join(code, "repo"));
  git(["init", "-q", "-b", "main"], repo.root);
  git(["add", "-A"], repo.root);
  git(["commit", "-q", "-m", "init"], repo.root);
  const wt = path.join(code, "repo-wt");
  git(["worktree", "add", "-q", wt, "-b", "feature"], repo.root);
  assert.ok(fs.existsSync(path.join(wt, "_project", "id"))); // committed ⇒ present
  assert.equal(isLinkedWorktreeCheckout(wt), true);
  assert.equal(isLinkedWorktreeCheckout(repo.root), false);

  // (a) the folder holding both: only the main checkout is discovered
  const ws = makeWs([code]);
  t.after(ws.cleanup);
  const w = openWorkspace(ws.root);
  const all = discoverProjects(w, { all: true });
  assert.deepEqual(all.map((p) => p.root), [repo.root]);
  assert.equal(findDuplicateUids(all).size, 0);

  // (b) canonical resolution from inside the worktree lands on the main checkout
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);
  registerWorkspace(store, ws.root);
  const res = resolveCanonicalProject(wt, store);
  assert.equal(res.canonicalRoot, repo.root);
  assert.equal(res.inWorktree, true);

  // (c) listing the worktree itself: not discovered; doctor warns
  const ws2 = makeWs([wt]);
  t.after(ws2.cleanup);
  const w2 = openWorkspace(ws2.root);
  assert.deepEqual(discoverProjects(w2, { all: true }), []);
  const issues = externalRootIssues(w2, []);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.severity, "warn");
  assert.match(issues[0]?.message ?? "", /linked git worktree/);
});

// ---------------------------------------------------------------------------
// lifecycle, skills

test("lifecycle: an external project's lifecycle is metadata-only — no drift, reconcile never moves it", (t) => {
  const ext = makeTmpDir("ow-ext-lc-");
  t.after(() => rmrf(ext));
  const repo = makeProject(path.join(ext, "repo"));
  const ws = makeWs([repo.root]);
  t.after(ws.cleanup);
  const w = openWorkspace(ws.root);

  assert.equal(lifecycleOf(w, repo.root), "active");
  writeDeclaredLifecycle(repo.root, "dormant", "2026-09-29T00:00:00Z");
  assert.equal(lifecycleOf(w, repo.root), "dormant"); // location has no signal outside the tree
  const info = discoverProjects(w, { all: true })[0];
  assert.equal(info?.lifecycle, "dormant");
  assert.equal(info?.effectiveLifecycle, "dormant");

  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);
  const plan = reconcilePlan(w, store);
  assert.deepEqual(plan.actions, []);
  assert.deepEqual(plan.ambiguous, []);
});

test("skills: an external project's Skills/ dir is a default source root", (t) => {
  const ext = makeTmpDir("ow-ext-skills-");
  t.after(() => rmrf(ext));
  const repo = makeProject(path.join(ext, "repo"));
  fs.mkdirSync(path.join(repo.root, "Skills", "ext-skill"), { recursive: true });
  const ws = makeWs([repo.root]);
  t.after(ws.cleanup);
  const roots = defaultSourceRoots({ ws: openWorkspace(ws.root), fs: realFs }, { bundledDir: null });
  assert.deepEqual(roots, [path.join(repo.root, "Skills")]);
});

// ---------------------------------------------------------------------------
// CLI routing from inside an external root

test("cli: workspace commands run from inside an external root route to the workspace that lists it", (t) => {
  const storeDir = makeTmpDir("ow-ext-cli-store-");
  t.after(() => rmrf(storeDir));
  const home = makeTmpDir("ow-ext-cli-home-");
  t.after(() => rmrf(home));
  const repo = makeProject(path.join(home, "Code", "repo"));
  // `~` in the config resolves against HOME in the child process
  const ws = makeWs(["~/Code/repo"]);
  t.after(ws.cleanup);
  makeProject(path.join(ws.root, "Local"));

  const run = (args: string[], cwd: string) =>
    spawnSync(process.execPath, [CLI, ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, HOME: home, OPENWORKSPACE_STORE_DIR: storeDir, OW_ACTOR: "cli-test" },
    });

  // Before the workspace is known to this machine: loud not-found, as before.
  const before = run(["home", "list", "--json"], repo.root);
  assert.notEqual(before.status, 0);

  // Any command inside the tree registers it; then the external root routes.
  assert.equal(run(["home", "list"], ws.root).status, 0);
  const list = run(["home", "list", "--json"], repo.root);
  assert.equal(list.status, 0, list.stderr);
  const projects = JSON.parse(list.stdout) as Array<{ uid: string; externalRoot: string | null }>;
  assert.equal(projects.length, 2);
  assert.ok(projects.some((p) => p.uid === repo.uid && p.externalRoot !== null));

  const show = run(["show", "--json"], repo.root);
  assert.equal(show.status, 0, show.stderr);
  assert.equal((JSON.parse(show.stdout) as { lifecycle: string }).lifecycle, "active");

  // lifecycle on an external project writes metadata only — the dir stays put
  const lc = run(["lifecycle", repo.root, "--to", "dormant"], ws.root);
  assert.equal(lc.status, 0, lc.stderr);
  assert.ok(fs.existsSync(path.join(repo.root, "_project", "id")));
  assert.equal(fs.existsSync(path.join(ws.root, "Dormant Projects", "repo")), false);

  const doctor = run(["home", "doctor"], repo.root);
  assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr);

  // the helper itself: a path outside every external root is not claimed
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);
  registerWorkspace(store, ws.root);
  assert.equal(findWorkspaceClaimingPath(store, path.join(home, "elsewhere")), null);
});
