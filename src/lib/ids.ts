/**
 * Sequential ID minting (PRD §4.4 "IDs", §5.2).
 *
 * IDs: `task-<n>` / `decision-<n>` sequential per project; dotted subtask IDs
 * `<parent>.<n>`; Mini-minted records take a machine suffix (`task-7-mini`).
 *
 * Exclusivity: a MACHINE-LOCAL lock keyed by project UID, living in the App
 * Support store — a working-tree lockfile would be per-worktree and protect
 * nothing (PRD §6.3). The next-ID probe takes the max over every provided
 * tree path (e.g. the worktree's tasks dir AND the canonical tasks dir), so
 * branch-divergent trees can't re-issue an ID. The duplicate-ID doctor check
 * remains the cross-machine merge backstop.
 *
 * The `claim` callback runs while the lock is held and must create the record
 * file — otherwise two sequential minters would both probe the same max.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { ConfigError, LockError } from "./errors.js";
import { MachineStore, mintLocksDir } from "./machine.js";

export type IdPrefix = "task" | "decision";

const ID_RE = /^(task|decision)-(\d+(?:\.\d+)*)(?:-([a-z][a-z0-9-]*))?$/;

export interface ParsedId {
  prefix: IdPrefix;
  /** Numeric path, e.g. [36, 7] for task-36.7. */
  parts: number[];
  machineSuffix: string | null;
}

export function parseId(id: string): ParsedId | null {
  const m = ID_RE.exec(id);
  if (m === null) return null;
  const prefix = m[1] as IdPrefix;
  const parts = (m[2] as string).split(".").map((p) => Number.parseInt(p, 10));
  return { prefix, parts, machineSuffix: m[3] ?? null };
}

export function formatId(prefix: IdPrefix, parts: number[], machineSuffix?: string | null): string {
  const base = `${prefix}-${parts.join(".")}`;
  return machineSuffix != null && machineSuffix !== "" ? `${base}-${machineSuffix}` : base;
}

/** Extract the record ID from a filename like "task-36.7 - slug.md". */
export function idFromFilename(filename: string): ParsedId | null {
  const base = filename.endsWith(".md") ? filename.slice(0, -3) : filename;
  const idText = (base.split(" ")[0] ?? base).trim();
  return parseId(idText);
}

function scanIds(treePaths: string[], prefix: IdPrefix): ParsedId[] {
  const found: ParsedId[] = [];
  for (const dir of treePaths) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue; // a missing dir contributes nothing to the probe
    }
    for (const name of entries) {
      const parsed = idFromFilename(name);
      if (parsed !== null && parsed.prefix === prefix) found.push(parsed);
    }
  }
  return found;
}

/**
 * Next top-level number: max over `<prefix>-<n>` (top component, dotted IDs
 * count via their first component) across all tree paths, plus one.
 */
export function nextTopLevel(treePaths: string[], prefix: IdPrefix): number {
  let max = 0;
  for (const id of scanIds(treePaths, prefix)) {
    const first = id.parts[0];
    if (first !== undefined && first > max) max = first;
  }
  return max + 1;
}

/**
 * Next child number under `parentId` (e.g. "task-36" → next of task-36.<n>).
 */
export function nextChild(treePaths: string[], parentId: string): number {
  const parent = parseId(parentId);
  if (parent === null) throw new ConfigError(`invalid parent id: ${parentId}`);
  let max = 0;
  for (const id of scanIds(treePaths, parent.prefix)) {
    if (id.parts.length !== parent.parts.length + 1) continue;
    if (!parent.parts.every((p, i) => id.parts[i] === p)) continue;
    const last = id.parts[id.parts.length - 1];
    if (last !== undefined && last > max) max = last;
  }
  return max + 1;
}

// --- the machine-local mint lock ---

function lockPath(store: MachineStore, projectUid: string): string {
  // UIDs are uuid-shaped, but sanitize anyway: this becomes a dirname.
  const safe = projectUid.replace(/[^A-Za-z0-9._-]+/g, "_");
  return path.join(mintLocksDir(store), `${safe}.lock`);
}

function sleepSync(ms: number): void {
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
}

export interface LockOptions {
  /** Total time to keep retrying before LockError. Default 10s. */
  timeoutMs?: number;
  /** A lock older than this is considered crashed and is stolen. Default 30s. */
  staleMs?: number;
  /** Delay between acquisition attempts. Default 25ms. */
  retryDelayMs?: number;
}

/**
 * Run `fn` while holding the project's mint lock. Lock = mkdir (atomic on
 * every filesystem); stale locks (crashed holder) are stolen after staleMs.
 *
 * Stealing is RENAME-based, never rmdir: a waiter that judges the lock stale
 * renames the lock dir to a unique tombstone name and removes the tombstone.
 * rename(2) is atomic, so when several waiters race to steal, exactly one
 * rename succeeds — the losers get ENOENT and go back to mkdir. (An rmdir
 * steal would let a slow second stealer remove the FIRST stealer's freshly
 * re-acquired lock dir, producing two concurrent holders and duplicate IDs.)
 *
 * Known limit (accepted): the lock mtime is not refreshed while held, so a
 * claim that genuinely exceeds staleMs can still be judged stale. Claims are
 * one file create; staleMs (default 30s) is orders of magnitude above that,
 * and the duplicate-ID doctor check remains the backstop.
 */
export function withMintLock<T>(
  store: MachineStore,
  projectUid: string,
  fn: () => T,
  options: LockOptions = {},
): T {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const staleMs = options.staleMs ?? 30_000;
  const retryDelayMs = options.retryDelayMs ?? 25;
  const lock = lockPath(store, projectUid);
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      fs.mkdirSync(lock); // parent exists (openMachineStore made mint-locks/)
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let stale = false;
      try {
        stale = Date.now() - fs.statSync(lock).mtimeMs > staleMs;
      } catch {
        // holder released between mkdir and stat; retry immediately
        continue;
      }
      if (stale) {
        const tombstone = `${lock}.stale-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
        try {
          fs.renameSync(lock, tombstone); // atomic: only one stealer wins
          fs.rmdirSync(tombstone);
        } catch {
          // another waiter stole (or the holder released) first; re-contend
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new LockError(
          `timed out acquiring mint lock for project ${projectUid} (${lock})`,
        );
      }
      sleepSync(retryDelayMs);
    }
  }

  try {
    return fn();
  } finally {
    try {
      fs.rmdirSync(lock);
    } catch {
      // stolen as stale during a very long fn; nothing to release
    }
  }
}

export interface MintOptions {
  prefix: IdPrefix;
  /**
   * Directories whose filenames feed the next-ID probe. Pass BOTH the local
   * tree and the canonical tree when they differ (worktrees).
   */
  treePaths: string[];
  /** Mint a dotted child of this ID instead of a top-level ID. */
  parentId?: string;
  /** Machine-suffix variant (e.g. "mini") for off-laptop minting. */
  machineSuffix?: string;
  /**
   * Runs while the lock is held; MUST create the record file carrying the
   * minted ID so the next probe sees it. Required for collision safety.
   */
  claim: (id: string) => void;
  lock?: LockOptions;
}

/** Mint the next sequential ID for a project, exclusively, and claim it. */
export function mintId(store: MachineStore, projectUid: string, options: MintOptions): string {
  return withMintLock(
    store,
    projectUid,
    () => {
      let id: string;
      if (options.parentId !== undefined) {
        const parent = parseId(options.parentId);
        if (parent === null) throw new ConfigError(`invalid parent id: ${options.parentId}`);
        const n = nextChild(options.treePaths, options.parentId);
        // Parentage lives in the ID alone (PRD §4.4), so a dotted child must
        // compose the parent's FULL identity: a child of task-7-mini is
        // task-7.<n>-mini, never task-7.<n> (which would orphan it under a
        // nonexistent — or wrong — plain task-7). A suffixed minting machine
        // adds its own suffix only when the parent has none.
        const suffix = parent.machineSuffix ?? options.machineSuffix ?? null;
        id = formatId(parent.prefix, [...parent.parts, n], suffix);
      } else {
        const n = nextTopLevel(options.treePaths, options.prefix);
        id = formatId(options.prefix, [n], options.machineSuffix ?? null);
      }
      options.claim(id);
      return id;
    },
    options.lock,
  );
}
