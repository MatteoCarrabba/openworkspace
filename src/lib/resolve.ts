/**
 * UID-anchored canonical resolution (PRD §6.3 / §6.4).
 *
 * Authoritative chain: walk-up `_project/id` → UID → resolver (machine-local
 * cache → bounded rescan of known workspaces) → VERIFY the resolved tree's
 * `_project/id` matches. Resolution is UID-registry-first BY CONSTRUCTION:
 * git is consulted only as a worktree *hint* (the "find the main worktree via
 * git" shortcut works today and breaks at the per-project repo split).
 *
 * Failure is loud: ResolveError (exit code 2). A silent fallback to
 * worktree-local writes would create a split-brain forum — the worst
 * available outcome — so it never happens here.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { ResolveError } from "./errors.js";
import {
  MachineStore,
  dropUidCacheEntry,
  readKnownWorkspaces,
  readUidCache,
  registerWorkspace,
  writeUidCacheEntry,
} from "./machine.js";
import {
  Workspace,
  findProjectByUid,
  findProjectRoot,
  findWorkspaceRoot,
  loadWorkspaceConfig,
  readProjectUid,
} from "./workspace.js";

export interface ResolveResult {
  uid: string;
  /** The project's canonical root in the canonical workspace checkout. */
  canonicalRoot: string;
  /** The local project root the resolution started from (may equal canonical). */
  localRoot: string;
  /** True when the canonical path came straight from the UID cache. */
  fromCache: boolean;
  /** HINT only: the start dir sits in a linked git worktree. */
  inWorktree: boolean;
}

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * True when `dir` is inside a git work tree. Used by reconcile to decide
 * whether the Tier-1 (committed-metadata) tiebreaker is even available.
 */
export function isGitRepo(dir: string): boolean {
  return git(["rev-parse", "--is-inside-work-tree"], dir) === "true";
}

/**
 * Read the committed-at-HEAD bytes of a repo-relative path (decision-2 Tier-1
 * tiebreaker). `git show HEAD:<path>` — iCloud cannot author a commit, so a
 * value read here is tombstone-honest. Returns null when not a repo, the path
 * is untracked, or git is unavailable.
 */
export function gitShowAtHead(repoDir: string, repoRelPath: string): string | null {
  // git wants forward slashes regardless of platform
  const posix = repoRelPath.split(path.sep).join("/");
  return git(["show", `HEAD:${posix}`], repoDir);
}

/**
 * Detect a linked git worktree: `--git-dir` differs from `--git-common-dir`.
 * Used two ways: as a diagnostics hint on the START dir, and as a hard
 * DISQUALIFIER on candidate canonical roots and workspace registrations — a
 * linked worktree of the workspace repo carries the committed
 * `.openworkspace/` marker and `_project/id` (§4.8), so without this guard a
 * worktree would self-seed the registry and silently resolve as "canonical"
 * (the §6.3 split-brain). Returns false when git is unavailable or the dir is
 * not a repo — never an input to where canonical lives, only a veto.
 */
export function isGitWorktree(dir: string): boolean {
  const gitDir = git(["rev-parse", "--git-dir"], dir);
  if (gitDir === null) return false;
  const commonDir = git(["rev-parse", "--git-common-dir"], dir);
  if (commonDir === null) return false;
  // Realpath both sides before comparing: git mixes absolute (resolved) and
  // cwd-relative answers — e.g. from a subdir of a MAIN checkout, --git-dir
  // is absolute while --git-common-dir is relative, and under a symlinked
  // path (/var vs /private/var on macOS) the naive string compare would call
  // the main checkout a worktree.
  const real = (p: string): string => {
    const abs = path.resolve(dir, p);
    try {
      return fs.realpathSync(abs);
    } catch {
      return abs;
    }
  };
  return real(gitDir) !== real(commonDir);
}

/**
 * Register a workspace root with the machine store UNLESS it sits inside a
 * linked git worktree (a worktree checkout of the workspace repo contains the
 * committed marker but is never the canonical home — registering it would
 * poison every future resolution). All registration paths (init, openWorkspace
 * routing, resolution) go through this guard.
 */
export function registerWorkspaceIfCanonical(store: MachineStore, workspaceRoot: string): boolean {
  if (isGitWorktree(workspaceRoot)) return false;
  registerWorkspace(store, workspaceRoot);
  return true;
}

function verifyUidAt(root: string, uid: string): boolean {
  return readProjectUid(root) === uid;
}

/** A candidate canonical root is valid when the UID matches AND it is not worktree-resident. */
function verifyCanonicalCandidate(root: string, uid: string): boolean {
  return verifyUidAt(root, uid) && !isGitWorktree(root);
}

export interface ResolveOptions {
  /**
   * Extra workspace roots to consider beyond the store's known list (tests,
   * or a caller that already has a Workspace open).
   */
  extraWorkspaceRoots?: string[];
}

/**
 * Resolve the canonical project for `startDir`.
 *
 * 1. Walk up for `_project/id` → UID (committed, so present in any worktree).
 * 2. If startDir is inside a workspace (walk-up `.openworkspace/`), register
 *    that workspace with the store — the registry stays self-seeding. A
 *    workspace root inside a linked worktree is NEVER registered (the marker
 *    is committed, §4.8, so every real worktree carries one — registering it
 *    would make the worktree resolve as canonical: the §6.3 split brain).
 * 3. Cache lookup: candidate path must still carry the same UID and must not
 *    be worktree-resident, else ignore.
 * 4. Bounded rescan of every known workspace root for the UID; verify; cache.
 * 5. Nothing matched → loud ResolveError, exit code 2. Never fall back.
 */
export function resolveCanonicalProject(
  startDir: string,
  store: MachineStore,
  options: ResolveOptions = {},
): ResolveResult {
  const local = findProjectRoot(startDir);
  if (local === null) {
    throw new ResolveError(
      `not inside a project: no _project/id found walking up from ${path.resolve(startDir)}`,
    );
  }
  const { uid } = local;
  const inWorktree = isGitWorktree(local.root);

  const containingWorkspace = findWorkspaceRoot(startDir);
  if (containingWorkspace !== null) registerWorkspaceIfCanonical(store, containingWorkspace);
  for (const extra of options.extraWorkspaceRoots ?? []) registerWorkspaceIfCanonical(store, extra);

  // 3. cache, verified before trust (the cache is a rebuildable hint; a
  // worktree-resident entry is poison from an older build — drop it)
  const cached = readUidCache(store)[uid];
  if (cached !== undefined) {
    if (verifyCanonicalCandidate(cached, uid)) {
      return { uid, canonicalRoot: cached, localRoot: local.root, fromCache: true, inWorktree };
    }
    if (verifyUidAt(cached, uid)) dropUidCacheEntry(store, uid); // worktree-resident
  }

  // 4. bounded rescan of known workspaces (skipping worktree-resident roots —
  // they may linger from an older build's registrations)
  const roots = readKnownWorkspaces(store);
  for (const wsRoot of roots) {
    if (isGitWorktree(wsRoot)) continue;
    let ws: Workspace;
    try {
      ws = { root: wsRoot, config: loadWorkspaceConfig(wsRoot) };
    } catch {
      continue; // stale registration (workspace moved/deleted); skip
    }
    const found = findProjectByUid(ws, uid); // throws on duplicate UIDs
    if (found !== null && verifyCanonicalCandidate(found.root, uid)) {
      writeUidCacheEntry(store, uid, found.root);
      return {
        uid,
        canonicalRoot: found.root,
        localRoot: local.root,
        fromCache: false,
        inWorktree,
      };
    }
  }

  throw new ResolveError(
    `cannot resolve canonical location for project UID ${uid} (from ${local.root}): ` +
      `not in the UID cache and not found in any known workspace ` +
      `(${roots.length === 0 ? "none registered" : roots.join(", ")}). ` +
      `Refusing to fall back to worktree-local state. ` +
      `Run \`projects home init\` (or any workspace-routed command) from inside the ` +
      `canonical workspace checkout on this machine once to register it.`,
  );
}
