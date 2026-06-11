/**
 * Machine identity + the machine-local store (PRD §4.8 last rows).
 *
 * Default location: ~/Library/Application Support/OpenWorkspace/ — NEVER in
 * the synced tree. Everything here is machine-local and rebuildable except
 * `machine-id` (stable identity) and activation records (the local act of
 * `automation apply`).
 *
 * Path injection: pass an explicit dir, or set OPENWORKSPACE_STORE_DIR.
 * Tests always inject a temp dir; nothing in this module touches the real
 * ~/Library when a dir is provided.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ConfigError, ConflictError } from "./errors.js";
import { appendSafe, createExclusive, ensureDir, readTextIfExists, writeFileAtomic } from "./fsatomic.js";

export const STORE_DIR_ENV = "OPENWORKSPACE_STORE_DIR";
export const MINT_SUFFIX_ENV = "OPENWORKSPACE_MINT_SUFFIX";

export interface MachineStore {
  dir: string;
}

export function defaultStoreDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[STORE_DIR_ENV];
  if (override !== undefined && override !== "") return path.resolve(override);
  return path.join(os.homedir(), "Library", "Application Support", "OpenWorkspace");
}

/** Open (creating if needed) the machine-local store. */
export function openMachineStore(dir?: string, env: NodeJS.ProcessEnv = process.env): MachineStore {
  const storeDir = dir !== undefined ? path.resolve(dir) : defaultStoreDir(env);
  ensureDir(storeDir);
  ensureDir(path.join(storeDir, "mint-locks"));
  ensureDir(path.join(storeDir, "activations"));
  return { dir: storeDir };
}

function defaultMachineId(): string {
  const host = os.hostname().split(".")[0] ?? "machine";
  const slug = host.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  const rand = crypto.randomBytes(2).toString("hex");
  return slug.length > 0 ? `${slug}-${rand}` : `machine-${rand}`;
}

/**
 * Stable machine identity: read `machine-id`, minting one on first use.
 * Write-once; concurrent first-callers converge on the winner's id.
 */
export function machineId(store: MachineStore): string {
  const idPath = path.join(store.dir, "machine-id");
  const existing = readTextIfExists(idPath);
  if (existing !== null && existing.trim() !== "") return existing.trim();
  const minted = defaultMachineId();
  try {
    createExclusive(idPath, minted + "\n");
    return minted;
  } catch (err) {
    if (err instanceof ConflictError) {
      const winner = readTextIfExists(idPath);
      if (winner !== null && winner.trim() !== "") return winner.trim();
    }
    throw err;
  }
}

// --- per-machine mint suffix (PRD §4.4: "Mini-minted records take a machine
// suffix"). Machine-local intent: the off-canonical machine declares its
// suffix ONCE (a `mint-suffix` file in the store, or the env override) and
// every CLI mint on that machine applies it automatically — the designed
// defense against cross-machine duplicate IDs under iCloud latency. The
// canonical machine leaves it unset and mints plain sequential IDs. ---

const MINT_SUFFIX_FILE = "mint-suffix";
const MINT_SUFFIX_RE = /^[a-z][a-z0-9-]*$/;

function validateMintSuffix(suffix: string): string {
  const trimmed = suffix.trim();
  if (!MINT_SUFFIX_RE.test(trimmed)) {
    throw new ConfigError(
      `invalid mint suffix "${suffix}": must match [a-z][a-z0-9-]* (e.g. "mini")`,
    );
  }
  return trimmed;
}

/**
 * The machine's minting suffix: env override first, else the store's
 * `mint-suffix` file. Null (the default) = plain sequential IDs.
 */
export function readMintSuffix(
  store: MachineStore,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const fromEnv = env[MINT_SUFFIX_ENV];
  if (fromEnv !== undefined && fromEnv.trim() !== "") return validateMintSuffix(fromEnv);
  const fromFile = readTextIfExists(path.join(store.dir, MINT_SUFFIX_FILE));
  if (fromFile !== null && fromFile.trim() !== "") return validateMintSuffix(fromFile);
  return null;
}

/** Set (or with null, clear) this machine's minting suffix. */
export function writeMintSuffix(store: MachineStore, suffix: string | null): void {
  const filePath = path.join(store.dir, MINT_SUFFIX_FILE);
  if (suffix === null) {
    try {
      fs.unlinkSync(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    return;
  }
  writeFileAtomic(filePath, validateMintSuffix(suffix) + "\n");
}

// --- runner-node: the granted runner's node binary (decision-1, PRD §7.4).
// A MACHINE-LOCAL fact (P14): which node executes the runner under launchd on
// THIS machine — v1 is a dedicated copy of the official nodejs.org pkg build
// (Developer-ID-signed → stable TCC grant identity) at a fixed path outside
// the tree, granted once per machine at bootstrap. Same pattern as the
// mint-suffix file: one small file in the store, set via
// `projects home runner-node`. Unset = plists fall back to the node that ran
// `apply` (process.execPath) — apply warns and doctor warns, because that
// fallback is not a durable grant identity. ---

const RUNNER_NODE_FILE = "runner-node";

/** The configured runner-node path, or null when unset (fallback posture). */
export function readRunnerNode(store: MachineStore): string | null {
  const fromFile = readTextIfExists(path.join(store.dir, RUNNER_NODE_FILE));
  if (fromFile !== null && fromFile.trim() !== "") return fromFile.trim();
  return null;
}

/**
 * Set (or with null, clear) this machine's runner-node. Setting validates the
 * path: it must exist, be a regular file, and be executable — a typo here
 * would otherwise surface only as a silent launchd spawn failure.
 */
export function writeRunnerNode(store: MachineStore, nodePath: string | null): void {
  const filePath = path.join(store.dir, RUNNER_NODE_FILE);
  if (nodePath === null) {
    try {
      fs.unlinkSync(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    return;
  }
  const abs = path.resolve(nodePath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new ConfigError(`runner-node path does not exist: ${abs}`);
  }
  if (!stat.isFile()) {
    throw new ConfigError(`runner-node path is not a regular file: ${abs}`);
  }
  try {
    fs.accessSync(abs, fs.constants.X_OK);
  } catch {
    throw new ConfigError(`runner-node path is not executable: ${abs}`);
  }
  writeFileAtomic(filePath, abs + "\n");
}

// --- UID → canonical-path cache (rebuildable; resolve.ts verifies on read) ---

const UID_CACHE_FILE = "uid-cache.json";

export function readUidCache(store: MachineStore): Record<string, string> {
  const text = readTextIfExists(path.join(store.dir, UID_CACHE_FILE));
  if (text === null) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    }
  } catch {
    // corrupt cache is rebuildable: treat as empty
  }
  return {};
}

export function writeUidCacheEntry(store: MachineStore, uid: string, canonicalPath: string): void {
  const cache = readUidCache(store);
  cache[uid] = canonicalPath;
  writeFileAtomic(path.join(store.dir, UID_CACHE_FILE), JSON.stringify(cache, null, 2) + "\n");
}

export function dropUidCacheEntry(store: MachineStore, uid: string): void {
  const cache = readUidCache(store);
  if (!(uid in cache)) return;
  delete cache[uid];
  writeFileAtomic(path.join(store.dir, UID_CACHE_FILE), JSON.stringify(cache, null, 2) + "\n");
}

// --- known workspace roots (seeds bounded rescans in resolve.ts) ---

const WORKSPACES_FILE = "workspaces.json";

export function readKnownWorkspaces(store: MachineStore): string[] {
  const text = readTextIfExists(path.join(store.dir, WORKSPACES_FILE));
  if (text === null) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    // rebuildable
  }
  return [];
}

export function registerWorkspace(store: MachineStore, workspaceRoot: string): void {
  const abs = path.resolve(workspaceRoot);
  const known = readKnownWorkspaces(store);
  if (known.includes(abs)) return;
  known.push(abs);
  writeFileAtomic(path.join(store.dir, WORKSPACES_FILE), JSON.stringify(known, null, 2) + "\n");
}

// --- lifecycle intent-log (decision-2: the non-git tiebreaker substrate) ---
//
// Append-only JSONL recording every EXPLICIT lifecycle command run on THIS
// machine. It lives in the machine-local store (~/Library/Application Support)
// — OUTSIDE the iCloud-synced tree, so iCloud cannot forge, revert, or
// resurrect a line. This is what lets reconcile tell a human drag (an intent
// line exists for the new location) from an iCloud glitch (no local intent
// for the observed move): the same observable, opposite responses, with a
// tiebreaker iCloud cannot author. Where a project is a git repo, committed
// `project.toml` is the stronger (Tier-1) tiebreaker; this log is the Tier-2
// fallback for the common non-git project.

const LIFECYCLE_INTENTS_FILE = "lifecycle-intents.jsonl";

export interface LifecycleIntent {
  /** Project UID the intent applies to. */
  uid: string;
  /** The lifecycle the human DECLARED (active|dormant|archived). */
  to: string;
  /** ISO-8601 timestamp of the command. */
  at: string;
  /** The machine the command ran on (machineId). */
  machine: string;
}

function lifecycleIntentsPath(store: MachineStore): string {
  return path.join(store.dir, LIFECYCLE_INTENTS_FILE);
}

/**
 * Append one lifecycle intent line. Single-writer-per-machine append (P15):
 * the file is partitioned by machine implicitly (each machine has its own
 * store), so a plain append is safe.
 */
export function appendLifecycleIntent(store: MachineStore, intent: LifecycleIntent): void {
  appendSafe(lifecycleIntentsPath(store), JSON.stringify(intent) + "\n");
}

/** Read all lifecycle intents from this machine's log (oldest → newest). */
export function readLifecycleIntents(store: MachineStore): LifecycleIntent[] {
  const text = readTextIfExists(lifecycleIntentsPath(store));
  if (text === null) return [];
  const out: LifecycleIntent[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const obj = JSON.parse(line) as unknown;
      if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
        const t = obj as Record<string, unknown>;
        if (
          typeof t["uid"] === "string" &&
          typeof t["to"] === "string" &&
          typeof t["at"] === "string" &&
          typeof t["machine"] === "string"
        ) {
          out.push({ uid: t["uid"], to: t["to"], at: t["at"], machine: t["machine"] });
        }
      }
    } catch {
      // a corrupt line is skipped (the log is best-effort evidence, never state)
    }
  }
  return out;
}

/** The most recent local intent for a UID, or null when none was ever recorded here. */
export function lastLifecycleIntent(store: MachineStore, uid: string): LifecycleIntent | null {
  let last: LifecycleIntent | null = null;
  for (const intent of readLifecycleIntents(store)) {
    if (intent.uid === uid) last = intent; // log is append-ordered → last wins
  }
  return last;
}

// --- intent RETIREMENT high-water (decision-2: "reconcile must never fight a
// human"). The intent-log is append-only glitch-EVIDENCE, but an intent is only
// live evidence UNTIL the system has OBSERVED CONVERGENCE (declared==located==
// intent.target) for that uid AFTER the intent. A fresh glitch (iCloud reverts
// the move before any converged observation) keeps the intent live → auto-heal
// still works. A stale human drag back (convergence was observed, THEN weeks
// later a Finder drag) finds the intent RETIRED → reconcile falls through to
// propose-only, never yanking the project back under the user.
//
// The high-water is a machine-local per-uid timestamp: "intents at-or-before
// this ts have been consumed (their convergence was observed) and carry NO
// glitch evidence." It lives in the machine store like the intent-log itself —
// OUTSIDE the synced tree, rebuildable bookkeeping (never a tree mutation).

const INTENT_RETIREMENT_FILE = "intent-retirement.json";

function intentRetirementPath(store: MachineStore): string {
  return path.join(store.dir, INTENT_RETIREMENT_FILE);
}

/** The full uid → retirement-high-water map (ISO-8601 timestamps). */
export function readIntentRetirement(store: MachineStore): Record<string, string> {
  const text = readTextIfExists(intentRetirementPath(store));
  if (text === null) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    }
  } catch {
    // corrupt high-water is rebuildable: treat as empty (no retirement)
  }
  return {};
}

/**
 * The retirement high-water for one UID, or null when none recorded. An intent
 * with `at <= lastRetired(uid)` has been consumed and is NO glitch evidence.
 */
export function lastRetired(store: MachineStore, uid: string): string | null {
  const map = readIntentRetirement(store);
  return map[uid] ?? null;
}

/**
 * Advance a UID's retirement high-water to `throughTs` (monotonic — never moves
 * backward). Called on the CONVERGED-observation path: when a reconcile pass
 * sees declared==located for a uid that has intents, every intent at-or-before
 * the latest intent ts is consumed. Idempotent; safe under repeated passes.
 */
export function retireLifecycleIntents(store: MachineStore, uid: string, throughTs: string): void {
  const map = readIntentRetirement(store);
  const current = map[uid];
  if (current !== undefined && current >= throughTs) return; // already at/ahead — monotonic
  map[uid] = throughTs;
  writeFileAtomic(intentRetirementPath(store), JSON.stringify(map, null, 2) + "\n");
}

// --- well-known store locations for other modules ---

/** Directory holding per-project-UID mint locks (ids.ts). */
export function mintLocksDir(store: MachineStore): string {
  return path.join(store.dir, "mint-locks");
}

/** Directory holding activation records written by `automation apply`. */
export function activationsDir(store: MachineStore): string {
  return path.join(store.dir, "activations");
}

/** Path of one activation record (one file per project-UID + automation name). */
export function activationRecordPath(store: MachineStore, projectUid: string, name: string): string {
  return path.join(activationsDir(store), `${projectUid}--${name}.toml`);
}

/** True when `dir` does not exist yet or contains no entries. */
export function storeIsEmpty(store: MachineStore): boolean {
  try {
    return fs.readdirSync(store.dir).length === 0;
  } catch {
    return true;
  }
}
