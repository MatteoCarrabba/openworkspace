import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import { ResolveError } from "../src/lib/errors.js";
import { readKnownWorkspaces, readUidCache, writeUidCacheEntry } from "../src/lib/machine.js";
import { isGitWorktree, registerWorkspaceIfCanonical, resolveCanonicalProject } from "../src/lib/resolve.js";
import { makeTmpDir, makeTmpStore, makeTmpWorkspace, rmrf } from "./helpers.js";

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

test("resolution from inside the canonical workspace returns the local root and self-registers", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);

  const p = tw.addProject("Personal OS");
  const deep = path.join(p.root, "src", "lib");
  fs.mkdirSync(deep, { recursive: true });

  const result = resolveCanonicalProject(deep, store);
  assert.equal(result.uid, p.uid);
  assert.equal(result.canonicalRoot, p.root);
  assert.equal(result.localRoot, p.root);
  assert.equal(result.fromCache, false);
  // workspace registered + cache seeded for next time
  const again = resolveCanonicalProject(deep, store);
  assert.equal(again.fromCache, true);
  assert.equal(readUidCache(store)[p.uid], p.root);
});

test("UID-registry-first: a project dir OUTSIDE the workspace resolves to canonical via the registry", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);

  const canonical = tw.addProject("My Project");
  // a detached copy with the same _project/id, outside any workspace —
  // the worktree shape, minus git (resolution must not depend on git)
  const elsewhere = makeTmpDir("openworkspace-worktree-");
  t.after(() => rmrf(elsewhere));
  const copyRoot = path.join(elsewhere, "My Project");
  fs.mkdirSync(path.join(copyRoot, "_project"), { recursive: true });
  fs.writeFileSync(path.join(copyRoot, "_project", "id"), canonical.uid + "\n");

  const result = resolveCanonicalProject(copyRoot, store, {
    extraWorkspaceRoots: [tw.root],
  });
  assert.equal(result.canonicalRoot, canonical.root);
  assert.equal(result.localRoot, copyRoot);
});

test("stale cache entry (project moved) is ignored and repaired by rescan", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);

  const p = tw.addProject("Mover");
  writeUidCacheEntry(store, p.uid, path.join(tw.root, "Old Location That Is Gone"));
  const result = resolveCanonicalProject(p.root, store);
  assert.equal(result.fromCache, false);
  assert.equal(result.canonicalRoot, p.root);
  assert.equal(readUidCache(store)[p.uid], p.root, "cache repaired");
});

test("cache entry pointing at a dir with a DIFFERENT uid is rejected (verify step)", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);

  const a = tw.addProject("Project A");
  const b = tw.addProject("Project B");
  writeUidCacheEntry(store, a.uid, b.root); // poisoned cache
  const result = resolveCanonicalProject(a.root, store);
  assert.equal(result.canonicalRoot, a.root, "must not trust an unverified cache hit");
});

test("unresolvable UID errors loudly with exit code 2 — never a silent fallback", (t) => {
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);
  const orphan = makeTmpDir("openworkspace-orphan-");
  t.after(() => rmrf(orphan));
  fs.mkdirSync(path.join(orphan, "_project"), { recursive: true });
  fs.writeFileSync(path.join(orphan, "_project", "id"), "uid-with-no-home\n");

  assert.throws(
    () => resolveCanonicalProject(orphan, store),
    (err: unknown) => err instanceof ResolveError && err.exitCode === 2,
  );
});

test("not inside a project at all → ResolveError", (t) => {
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);
  const dir = makeTmpDir();
  t.after(() => rmrf(dir));
  assert.throws(() => resolveCanonicalProject(dir, store), ResolveError);
});

test("isGitWorktree: false for non-repos and main checkouts, true inside a linked worktree", (t) => {
  if (!gitAvailable()) {
    t.skip("git not available");
    return;
  }
  const plain = makeTmpDir();
  t.after(() => rmrf(plain));
  assert.equal(isGitWorktree(plain), false);

  const repo = makeTmpDir("openworkspace-repo-");
  t.after(() => rmrf(repo));
  git(["init", "-q"], repo);
  fs.writeFileSync(path.join(repo, "file.txt"), "x\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "init"], repo);
  assert.equal(isGitWorktree(repo), false, "main checkout is not a linked worktree");

  const wtParent = makeTmpDir("openworkspace-wt-");
  t.after(() => rmrf(wtParent));
  const wt = path.join(wtParent, "linked");
  git(["worktree", "add", "-q", wt, "-b", "agent-branch"], repo);
  assert.equal(isGitWorktree(wt), true);
});

test("worktree of a workspace project resolves forum-style verbs to canonical (hint set, registry decides)", (t) => {
  if (!gitAvailable()) {
    t.skip("git not available");
    return;
  }
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);

  const p = tw.addProject("Repo Project");
  git(["init", "-q"], p.root);
  git(["add", "."], p.root);
  git(["commit", "-q", "-m", "init"], p.root);

  // seed the registry the way real usage does: one command from canonical
  resolveCanonicalProject(p.root, store);

  const wtParent = makeTmpDir("openworkspace-wt2-");
  t.after(() => rmrf(wtParent));
  const wt = path.join(wtParent, "agent-a");
  git(["worktree", "add", "-q", wt, "-b", "agent-a"], p.root);

  const result = resolveCanonicalProject(wt, store);
  assert.equal(result.uid, p.uid);
  assert.equal(result.canonicalRoot, p.root, "writes land in the canonical checkout");
  assert.equal(result.localRoot, wt);
  assert.equal(result.inWorktree, true, "worktree detected as a hint");
});

// ---------------------------------------------------------------------------
// Regression: the §6.3 split-brain. A REAL linked worktree of the workspace
// repo carries the COMMITTED `.openworkspace/` marker and `_project/id`
// (§4.8) — the shape the original suite never built. Without the worktree
// guard, the worktree self-seeds the registry and resolves as "canonical".
// ---------------------------------------------------------------------------

test("regression: a real worktree (committed marker) never self-registers as canonical", (t) => {
  if (!gitAvailable()) {
    t.skip("git not available");
    return;
  }
  // canonical workspace = a git repo with the marker + a project COMMITTED
  // (config.toml present so git materializes `.openworkspace/` in worktrees)
  const tw = makeTmpWorkspace("schema = 2\n");
  t.after(tw.cleanup);
  const p = tw.addProject("Shared Proj");
  git(["init", "-q"], tw.root);
  git(["add", "."], tw.root);
  git(["commit", "-q", "-m", "init"], tw.root);

  const wtParent = makeTmpDir("openworkspace-wt3-");
  t.after(() => rmrf(wtParent));
  const wt = path.join(wtParent, "agent-a");
  git(["worktree", "add", "-q", wt, "-b", "agent-a"], tw.root);
  const wtProject = path.join(wt, "Shared Proj");
  assert.ok(fs.existsSync(path.join(wt, ".openworkspace")), "real worktree carries the committed marker");
  assert.ok(fs.existsSync(path.join(wtProject, "_project", "id")));

  // (a) fresh machine store, command runs FROM THE WORKTREE: the marker is
  // right there, but resolution must REFUSE (exit-2 class), not fall back —
  // and must not poison the registry or the UID cache with worktree paths.
  const fresh = makeTmpStore();
  t.after(fresh.cleanup);
  assert.throws(() => resolveCanonicalProject(wtProject, fresh.store), ResolveError);
  assert.deepEqual(readKnownWorkspaces(fresh.store), [], "worktree root was not registered");
  assert.equal(readUidCache(fresh.store)[p.uid], undefined, "uid cache not poisoned");

  // registerWorkspaceIfCanonical itself refuses worktree roots
  assert.equal(registerWorkspaceIfCanonical(fresh.store, wt), false);
  assert.deepEqual(readKnownWorkspaces(fresh.store), []);

  // (b) once the canonical checkout is known (any command run from it),
  // resolution from the worktree lands CANONICAL
  resolveCanonicalProject(p.root, fresh.store);
  const resolved = resolveCanonicalProject(wtProject, fresh.store);
  assert.equal(resolved.canonicalRoot, p.root);
  assert.equal(resolved.inWorktree, true);

  // (c) a poisoned cache entry from an older build (worktree path) is
  // dropped and re-resolved to canonical — canonical/worktree never invert
  writeUidCacheEntry(fresh.store, p.uid, wtProject);
  const repaired = resolveCanonicalProject(p.root, fresh.store);
  assert.equal(repaired.canonicalRoot, p.root);
  assert.equal(readUidCache(fresh.store)[p.uid], p.root, "poisoned entry repaired");
});
