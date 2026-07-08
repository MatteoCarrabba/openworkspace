/**
 * Automation Runtime v2 local run ledger.
 *
 * This module owns only machine-local runtime truth under MachineStore:
 * `automation-runs/<project_uid>--<name>/...`. It intentionally does not write
 * the synced `.openworkspace/machines/<machine>.toml` registry mirror; that is
 * a best-effort publication layer for runner/supervisor integration.
 *
 * Attempt and lease files are tool-owned TOML. Updates preserve unknown keys
 * by merging parsed TOML tables before whole-document atomic writes, but, like
 * lib/toml, they do not preserve comments or original formatting.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { ConfigError, ConflictError, NotFoundError } from "../lib/errors.js";
import { createExclusive, ensureDir } from "../lib/fsatomic.js";
import { MachineStore } from "../lib/machine.js";
import { TomlTable, readToml, stringifyToml, writeToml } from "../lib/toml.js";

export const ATTEMPT_STATUSES = [
  "starting",
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "skipped",
  "error",
  "abandoned",
] as const;

export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

export const TERMINAL_ATTEMPT_STATUSES = [
  "succeeded",
  "failed",
  "timed_out",
  "skipped",
  "error",
  "abandoned",
] as const;

export type TerminalAttemptStatus = (typeof TERMINAL_ATTEMPT_STATUSES)[number];

export const ATTEMPT_PHASES = [
  "created",
  "leasing",
  "resolving",
  "loading-manifest",
  "resolving-secrets",
  "spawning",
  "executing",
  "publishing",
  "finished",
] as const;

export type AttemptPhase = (typeof ATTEMPT_PHASES)[number];

export type AttemptTrigger = "calendar" | "supervisor" | "run-now" | (string & {});

export type LogPublishStatus = "pending" | "published" | "failed" | "skipped" | (string & {});

export interface AttemptOwner extends TomlTable {
  lease_token?: string;
  runner_pid?: number;
  child_pid?: number;
  child_pgid?: number;
  launch_label?: string;
  node_path?: string;
  runner_version?: string;
}

export interface AttemptCommand extends TomlTable {
  kind?: "script" | "codex" | "claude" | "agent" | "shell" | "other" | (string & {});
  argv0?: string;
  argv_hash?: string;
  env_keys?: string[];
  secret_keys?: string[];
}

export interface AttemptLogs extends TomlTable {
  local_path?: string;
  published_path?: string;
  publish_status?: LogPublishStatus;
}

export interface AttemptOutcome extends TomlTable {
  exit_code?: number;
  signal?: string;
  reason?: string;
}

/**
 * Provenance (phase 3, compute-plane cleanup): `machine_id` + `created_at`
 * ARE the origin_machine/origin_ts of this run — the executor that created
 * the attempt and when. `machine_id` (with `run_id`/`project_uid`/`name`) is
 * STRUCTURALLY pinned: `updateAttempt` always re-asserts it from the CURRENT
 * on-disk record, never from the incoming patch, so no later write (heartbeat,
 * phase transition, finish) can rewrite who ran this. `created_at` is pinned
 * by convention rather than by the same explicit re-assignment: every caller's
 * patch touches only its own concern (status/phase/updated_at/finished_at/…)
 * and never includes `created_at`, so `mergeTomlTables` never has an incoming
 * value to overwrite it with. Nothing further was needed here — this was
 * already correct; this comment documents it so it isn't mistaken for a gap.
 */
export interface AutomationAttempt extends TomlTable {
  schema: 1;
  run_id: string;
  project_uid: string;
  name: string;
  /** Origin machine (the executor that created this attempt). Immutable — see above. */
  machine_id: string;
  trigger: AttemptTrigger;
  status: AttemptStatus;
  phase: AttemptPhase;
  reason?: string;
  schedule?: string;
  scheduled_from?: string;
  scheduled_through?: string;
  scheduled_count?: number;
  /** Origin timestamp (when this attempt was created). Immutable — see above. */
  created_at: string;
  started_at?: string;
  updated_at: string;
  heartbeat_at?: string;
  timeout_seconds?: number;
  deadline_at?: string;
  finished_at?: string;
  owner?: AttemptOwner;
  command?: AttemptCommand;
  logs?: AttemptLogs;
  outcome?: AttemptOutcome;
}

export interface StoredLease extends TomlTable {
  schema: 1;
  project_uid: string;
  name: string;
  machine_id: string;
  lease_token: string;
  acquired_at: string;
  updated_at: string;
  expires_at: string;
  run_id?: string;
  runner_pid?: number;
}

export interface AutomationRunLedgerState extends TomlTable {
  schema: 1;
  project_uid: string;
  name: string;
  machine_id: string;
  latest_run_id?: string;
  latest_status?: AttemptStatus;
  latest_phase?: AttemptPhase;
  latest_updated_at?: string;
  latest_finished_at?: string;
  current_run_id?: string;
  last_terminal_run_id?: string;
  schedule_cursor?: string;
  pending_count?: number;
}

export type ComputedRunState =
  | "pending-first-run"
  | "running"
  | "overdue"
  | "stuck"
  | "missed"
  | "unknown"
  | "unobservable-direct-exec"
  | TerminalAttemptStatus;

export type ComputedRunHealth = "ok" | "attention" | "critical" | "unknown";

export const DEFAULT_HEARTBEAT_STALE_SECONDS = 10 * 60;

function automationRunKey(uid: string, name: string): string {
  return `${uid}--${name}`;
}

export function automationRunDir(store: MachineStore, uid: string, name: string): string {
  return path.join(store.dir, "automation-runs", automationRunKey(uid, name));
}

export function automationAttemptsDir(store: MachineStore, uid: string, name: string): string {
  return path.join(automationRunDir(store, uid, name), "attempts");
}

/** Machine-local logs for this activation; human-facing published logs live in the project tree. */
export function automationLocalLogsDir(store: MachineStore, uid: string, name: string): string {
  return path.join(automationRunDir(store, uid, name), "logs");
}

export function automationStatePath(store: MachineStore, uid: string, name: string): string {
  return path.join(automationRunDir(store, uid, name), "state.toml");
}

export function automationLeasePath(store: MachineStore, uid: string, name: string): string {
  return path.join(automationRunDir(store, uid, name), "lease.toml");
}

export function automationAttemptPath(store: MachineStore, uid: string, name: string, runId: string): string {
  return path.join(automationAttemptsDir(store, uid, name), `${runId}.toml`);
}

function isTable(v: unknown): v is TomlTable {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isStatus(v: unknown): v is AttemptStatus {
  return typeof v === "string" && (ATTEMPT_STATUSES as readonly string[]).includes(v);
}

function isTerminalStatus(v: AttemptStatus): v is TerminalAttemptStatus {
  return (TERMINAL_ATTEMPT_STATUSES as readonly string[]).includes(v);
}

function isPhase(v: unknown): v is AttemptPhase {
  return typeof v === "string" && (ATTEMPT_PHASES as readonly string[]).includes(v);
}

function requireString(raw: TomlTable, key: string, filePath: string): string {
  const value = raw[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`invalid automation run record ${filePath}: ${key} must be a non-empty string`);
  }
  return value;
}

function optionalString(raw: TomlTable, key: string, filePath: string): string | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new ConfigError(`invalid automation run record ${filePath}: ${key} must be a string`);
  }
  return value;
}

function optionalNumber(raw: TomlTable, key: string, filePath: string): number | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ConfigError(`invalid automation run record ${filePath}: ${key} must be a number`);
  }
  return value;
}

function optionalTable<T extends TomlTable>(raw: TomlTable, key: string, filePath: string): T | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (!isTable(value)) {
    throw new ConfigError(`invalid automation run record ${filePath}: ${key} must be a TOML table`);
  }
  return value as T;
}

function attemptFromToml(raw: TomlTable, filePath: string): AutomationAttempt {
  if (raw["schema"] !== 1) {
    throw new ConfigError(`invalid automation attempt ${filePath}: schema must be 1`);
  }
  const status = raw["status"];
  if (!isStatus(status)) {
    throw new ConfigError(`invalid automation attempt ${filePath}: status must be one of ${ATTEMPT_STATUSES.join(", ")}`);
  }
  const phase = raw["phase"];
  if (!isPhase(phase)) {
    throw new ConfigError(`invalid automation attempt ${filePath}: phase must be one of ${ATTEMPT_PHASES.join(", ")}`);
  }

  const attempt: AutomationAttempt = {
    ...raw,
    schema: 1,
    run_id: requireString(raw, "run_id", filePath),
    project_uid: requireString(raw, "project_uid", filePath),
    name: requireString(raw, "name", filePath),
    machine_id: requireString(raw, "machine_id", filePath),
    trigger: requireString(raw, "trigger", filePath),
    status,
    phase,
    created_at: requireString(raw, "created_at", filePath),
    updated_at: requireString(raw, "updated_at", filePath),
  };

  for (const key of ["reason", "schedule", "scheduled_from", "scheduled_through", "started_at", "heartbeat_at", "deadline_at", "finished_at"]) {
    const value = optionalString(raw, key, filePath);
    if (value !== undefined) attempt[key] = value;
  }
  for (const key of ["scheduled_count", "timeout_seconds"]) {
    const value = optionalNumber(raw, key, filePath);
    if (value !== undefined) attempt[key] = value;
  }
  const owner = optionalTable<AttemptOwner>(raw, "owner", filePath);
  if (owner !== undefined) attempt.owner = owner;
  const command = optionalTable<AttemptCommand>(raw, "command", filePath);
  if (command !== undefined) attempt.command = command;
  const logs = optionalTable<AttemptLogs>(raw, "logs", filePath);
  if (logs !== undefined) attempt.logs = logs;
  const outcome = optionalTable<AttemptOutcome>(raw, "outcome", filePath);
  if (outcome !== undefined) attempt.outcome = outcome;
  return attempt;
}

function leaseFromToml(raw: TomlTable, filePath: string): StoredLease {
  if (raw["schema"] !== 1) {
    throw new ConfigError(`invalid automation lease ${filePath}: schema must be 1`);
  }
  const lease: StoredLease = {
    ...raw,
    schema: 1,
    project_uid: requireString(raw, "project_uid", filePath),
    name: requireString(raw, "name", filePath),
    machine_id: requireString(raw, "machine_id", filePath),
    lease_token: requireString(raw, "lease_token", filePath),
    acquired_at: requireString(raw, "acquired_at", filePath),
    updated_at: requireString(raw, "updated_at", filePath),
    expires_at: requireString(raw, "expires_at", filePath),
  };
  const runId = optionalString(raw, "run_id", filePath);
  if (runId !== undefined) lease.run_id = runId;
  const runnerPid = optionalNumber(raw, "runner_pid", filePath);
  if (runnerPid !== undefined) lease.runner_pid = runnerPid;
  return lease;
}

function stateFromToml(raw: TomlTable, filePath: string): AutomationRunLedgerState {
  if (raw["schema"] !== 1) {
    throw new ConfigError(`invalid automation run state ${filePath}: schema must be 1`);
  }
  const state: AutomationRunLedgerState = {
    ...raw,
    schema: 1,
    project_uid: requireString(raw, "project_uid", filePath),
    name: requireString(raw, "name", filePath),
    machine_id: requireString(raw, "machine_id", filePath),
  };
  const latestRunId = optionalString(raw, "latest_run_id", filePath);
  if (latestRunId !== undefined) state.latest_run_id = latestRunId;
  const latestStatus = raw["latest_status"];
  if (latestStatus !== undefined) {
    if (!isStatus(latestStatus)) {
      throw new ConfigError(
        `invalid automation run state ${filePath}: latest_status must be one of ${ATTEMPT_STATUSES.join(", ")}`,
      );
    }
    state.latest_status = latestStatus;
  }
  const latestPhase = raw["latest_phase"];
  if (latestPhase !== undefined) {
    if (!isPhase(latestPhase)) {
      throw new ConfigError(
        `invalid automation run state ${filePath}: latest_phase must be one of ${ATTEMPT_PHASES.join(", ")}`,
      );
    }
    state.latest_phase = latestPhase;
  }
  for (const key of [
    "latest_updated_at",
    "latest_finished_at",
    "current_run_id",
    "last_terminal_run_id",
    "schedule_cursor",
  ]) {
    const value = optionalString(raw, key, filePath);
    if (value !== undefined) state[key] = value;
  }
  const pendingCount = optionalNumber(raw, "pending_count", filePath);
  if (pendingCount !== undefined) state.pending_count = pendingCount;
  return state;
}

function readTomlOrNull(filePath: string): TomlTable | null {
  try {
    return readToml(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function cleanTomlValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter((item) => item !== undefined).map((item) => cleanTomlValue(item));
  if (!isTable(value)) return value;
  const out: TomlTable = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined) continue;
    out[k] = cleanTomlValue(v);
  }
  return out;
}

function cleanTomlTable(value: TomlTable): TomlTable {
  return cleanTomlValue(value) as TomlTable;
}

function mergeTomlTables(base: TomlTable, patch: TomlTable): TomlTable {
  const out: TomlTable = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = out[key];
    if (isTable(current) && isTable(value)) {
      out[key] = mergeTomlTables(current, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function isoStamp(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function compactUtcStamp(d: Date): string {
  return isoStamp(d).replace(/[-:]/g, "");
}

function generatedRunId(now: Date, machine: string): string {
  const suffix = crypto.randomBytes(2).toString("hex");
  return `${compactUtcStamp(now)}--${machine}--p${process.pid}--${suffix}`;
}

function generatedLeaseToken(): string {
  return crypto.randomBytes(16).toString("hex");
}

export interface CreateAttemptInput {
  store: MachineStore;
  uid: string;
  name: string;
  machine: string;
  trigger: AttemptTrigger;
  now?: Date;
  status?: AttemptStatus;
  phase?: AttemptPhase;
  reason?: string;
  schedule?: string;
  scheduledFrom?: string;
  scheduledThrough?: string;
  scheduledCount?: number;
  startedAt?: string;
  heartbeatAt?: string;
  timeoutSeconds?: number;
  deadlineAt?: string;
  owner?: AttemptOwner;
  command?: AttemptCommand;
  logs?: AttemptLogs;
  extra?: TomlTable;
}

/**
 * Create the attempt record using only the machine-local store. The runner can
 * call this before resolving the project UID or reading the synced tree.
 */
export function createAttempt(input: CreateAttemptInput): AutomationAttempt {
  const now = input.now ?? new Date();
  const stamp = isoStamp(now);
  ensureDir(automationRunDir(input.store, input.uid, input.name));
  ensureDir(automationAttemptsDir(input.store, input.uid, input.name));
  ensureDir(automationLocalLogsDir(input.store, input.uid, input.name));

  for (let i = 0; i < 10; i++) {
    const runId = generatedRunId(now, input.machine);
    const attempt: AutomationAttempt = {
      ...(input.extra ?? {}),
      schema: 1,
      run_id: runId,
      project_uid: input.uid,
      name: input.name,
      machine_id: input.machine,
      trigger: input.trigger,
      status: input.status ?? "starting",
      phase: input.phase ?? "created",
      created_at: stamp,
      updated_at: stamp,
    };
    if (input.reason !== undefined) attempt.reason = input.reason;
    if (input.schedule !== undefined) attempt.schedule = input.schedule;
    if (input.scheduledFrom !== undefined) attempt.scheduled_from = input.scheduledFrom;
    if (input.scheduledThrough !== undefined) attempt.scheduled_through = input.scheduledThrough;
    if (input.scheduledCount !== undefined) attempt.scheduled_count = input.scheduledCount;
    if (input.startedAt !== undefined) attempt.started_at = input.startedAt;
    if (input.heartbeatAt !== undefined) attempt.heartbeat_at = input.heartbeatAt;
    if (input.timeoutSeconds !== undefined) attempt.timeout_seconds = input.timeoutSeconds;
    if (input.deadlineAt !== undefined) attempt.deadline_at = input.deadlineAt;
    if (input.owner !== undefined) attempt.owner = input.owner;
    if (input.command !== undefined) attempt.command = input.command;
    if (input.logs !== undefined) attempt.logs = input.logs;

    try {
      createExclusive(
        automationAttemptPath(input.store, input.uid, input.name, runId),
        stringifyToml(cleanTomlTable(attempt)),
      );
      updateRunStateFromAttempt(input.store, attempt);
      return attempt;
    } catch (err) {
      if (err instanceof ConflictError) continue;
      throw err;
    }
  }
  throw new ConflictError(`could not create a unique automation run id for ${input.uid}--${input.name}`);
}

export function readAttempt(store: MachineStore, uid: string, name: string, runId: string): AutomationAttempt | null {
  const filePath = automationAttemptPath(store, uid, name, runId);
  const raw = readTomlOrNull(filePath);
  if (raw === null) return null;
  return attemptFromToml(raw, filePath);
}

export function writeAttempt(store: MachineStore, attempt: AutomationAttempt): void {
  writeToml(
    automationAttemptPath(store, attempt.project_uid, attempt.name, attempt.run_id),
    cleanTomlTable(attempt),
  );
  updateRunStateFromAttempt(store, attempt);
}

export function readRunState(store: MachineStore, uid: string, name: string): AutomationRunLedgerState | null {
  const filePath = automationStatePath(store, uid, name);
  const raw = readTomlOrNull(filePath);
  if (raw === null) return null;
  return stateFromToml(raw, filePath);
}

export function writeRunState(store: MachineStore, state: AutomationRunLedgerState): void {
  writeToml(automationStatePath(store, state.project_uid, state.name), cleanTomlTable(state));
}

function clearOwnedStateFields(state: TomlTable): void {
  for (const key of [
    "latest_run_id",
    "latest_status",
    "latest_phase",
    "latest_updated_at",
    "latest_finished_at",
    "current_run_id",
    "last_terminal_run_id",
  ]) {
    delete state[key];
  }
}

export function updateRunStateFromAttempt(
  store: MachineStore,
  attempt: AutomationAttempt,
): AutomationRunLedgerState {
  const filePath = automationStatePath(store, attempt.project_uid, attempt.name);
  const existing = readTomlOrNull(filePath) ?? {};
  clearOwnedStateFields(existing);
  const state: AutomationRunLedgerState = {
    ...existing,
    schema: 1,
    project_uid: attempt.project_uid,
    name: attempt.name,
    machine_id: attempt.machine_id,
    latest_run_id: attempt.run_id,
    latest_status: attempt.status,
    latest_phase: attempt.phase,
    latest_updated_at: attempt.updated_at,
  };
  if (attempt.finished_at !== undefined) state.latest_finished_at = attempt.finished_at;
  if (isTerminalStatus(attempt.status)) state.last_terminal_run_id = attempt.run_id;
  else state.current_run_id = attempt.run_id;
  writeToml(filePath, cleanTomlTable(state));
  const reread = readRunState(store, attempt.project_uid, attempt.name);
  if (reread === null) throw new NotFoundError(`automation run state not found after write: ${filePath}`);
  return reread;
}

export type AttemptPatch = Partial<AutomationAttempt> & TomlTable;

export function updateAttempt(
  store: MachineStore,
  uid: string,
  name: string,
  runId: string,
  patch: AttemptPatch,
  now: Date = new Date(),
): AutomationAttempt {
  const current = readAttempt(store, uid, name, runId);
  if (current === null) {
    throw new NotFoundError(`automation attempt not found: ${automationAttemptPath(store, uid, name, runId)}`);
  }
  const patchWithUpdated: TomlTable = { ...patch };
  if (patchWithUpdated["updated_at"] === undefined) patchWithUpdated["updated_at"] = isoStamp(now);
  const merged = mergeTomlTables(current, patchWithUpdated);
  merged["schema"] = 1;
  merged["run_id"] = current.run_id;
  merged["project_uid"] = current.project_uid;
  merged["name"] = current.name;
  merged["machine_id"] = current.machine_id;
  writeToml(automationAttemptPath(store, uid, name, runId), cleanTomlTable(merged));
  const next = readAttempt(store, uid, name, runId);
  if (next === null) throw new NotFoundError(`automation attempt not found after write: ${runId}`);
  updateRunStateFromAttempt(store, next);
  return next;
}

export interface FinishAttemptInput {
  store: MachineStore;
  uid: string;
  name: string;
  runId: string;
  status: TerminalAttemptStatus;
  now?: Date;
  reason?: string;
  outcome?: AttemptOutcome;
  logs?: AttemptLogs;
}

export function finishAttempt(input: FinishAttemptInput): AutomationAttempt {
  const now = input.now ?? new Date();
  const stamp = isoStamp(now);
  const patch: AttemptPatch = {
    status: input.status,
    phase: "finished",
    updated_at: stamp,
    finished_at: stamp,
  };
  if (input.reason !== undefined) patch.reason = input.reason;
  if (input.outcome !== undefined) patch.outcome = input.outcome;
  if (input.logs !== undefined) patch.logs = input.logs;
  return updateAttempt(input.store, input.uid, input.name, input.runId, patch, now);
}

export function readLease(store: MachineStore, uid: string, name: string): StoredLease | null {
  const filePath = automationLeasePath(store, uid, name);
  const raw = readTomlOrNull(filePath);
  if (raw === null) return null;
  return leaseFromToml(raw, filePath);
}

export function writeLease(store: MachineStore, uid: string, name: string, lease: StoredLease): void {
  writeToml(automationLeasePath(store, uid, name), cleanTomlTable(lease));
}

function leaseExpiresAtMs(lease: StoredLease): number | null {
  const ms = Date.parse(lease.expires_at);
  return Number.isNaN(ms) ? null : ms;
}

export function leaseExpired(lease: StoredLease, now: Date): boolean {
  const expires = leaseExpiresAtMs(lease);
  return expires !== null && expires <= now.getTime();
}

export interface AcquireLeaseInput {
  store: MachineStore;
  uid: string;
  name: string;
  machine: string;
  now?: Date;
  ttlSeconds?: number;
  expiresAt?: Date;
  token?: string;
  runId?: string;
  runnerPid?: number;
  extra?: TomlTable;
}

export function acquireLease(input: AcquireLeaseInput): StoredLease {
  const now = input.now ?? new Date();
  const existing = readLease(input.store, input.uid, input.name);
  if (existing !== null && !leaseExpired(existing, now)) {
    throw new ConflictError(
      `automation lease is already held for ${input.uid}--${input.name} until ${existing.expires_at}`,
    );
  }

  let expiresAt: Date;
  if (input.expiresAt !== undefined) {
    expiresAt = input.expiresAt;
  } else {
    if (input.ttlSeconds === undefined || input.ttlSeconds <= 0) {
      throw new ConfigError("acquireLease requires expiresAt or a positive ttlSeconds");
    }
    expiresAt = new Date(now.getTime() + input.ttlSeconds * 1000);
  }

  const stamp = isoStamp(now);
  const lease: StoredLease = {
    ...(input.extra ?? {}),
    schema: 1,
    project_uid: input.uid,
    name: input.name,
    machine_id: input.machine,
    lease_token: input.token ?? generatedLeaseToken(),
    acquired_at: stamp,
    updated_at: stamp,
    expires_at: isoStamp(expiresAt),
  };
  if (input.runId !== undefined) lease.run_id = input.runId;
  if (input.runnerPid !== undefined) lease.runner_pid = input.runnerPid;

  const filePath = automationLeasePath(input.store, input.uid, input.name);
  ensureDir(path.dirname(filePath));
  if (existing === null) {
    try {
      createExclusive(filePath, stringifyToml(cleanTomlTable(lease)));
      return lease;
    } catch (err) {
      if (!(err instanceof ConflictError)) throw err;
      const winner = readLease(input.store, input.uid, input.name);
      if (winner !== null && !leaseExpired(winner, now)) {
        throw new ConflictError(
          `automation lease is already held for ${input.uid}--${input.name} until ${winner.expires_at}`,
        );
      }
    }
  }
  writeLease(input.store, input.uid, input.name, lease);
  return lease;
}

export function releaseLease(input: { store: MachineStore; uid: string; name: string; token: string }): boolean {
  const lease = readLease(input.store, input.uid, input.name);
  if (lease === null || lease.lease_token !== input.token) return false;
  try {
    fs.unlinkSync(automationLeasePath(input.store, input.uid, input.name));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

function dateMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function activeSinceMs(attempt: AutomationAttempt): number | null {
  return (
    dateMs(attempt.heartbeat_at) ??
    dateMs(attempt.updated_at) ??
    dateMs(attempt.started_at) ??
    dateMs(attempt.created_at)
  );
}

function liveOwnerPids(attempt: AutomationAttempt): number[] {
  const pids: number[] = [];
  const owner = attempt.owner;
  if (owner === undefined) return pids;
  for (const key of ["runner_pid", "child_pid"] as const) {
    const value = owner[key];
    if (typeof value === "number" && Number.isInteger(value) && value > 0 && !pids.includes(value)) {
      pids.push(value);
    }
  }
  return pids;
}

/**
 * Compute runtime state from an attempt record. `stuck` is derived, never
 * stored: dead owner PID or stale activity wins over the softer `overdue`
 * deadline state. Terminal attempt statuses map through unchanged.
 */
export function computeRunState(
  attempt: AutomationAttempt | null | undefined,
  now: Date,
  processAlive?: (pid: number) => boolean,
): ComputedRunState {
  if (attempt === null || attempt === undefined) return "pending-first-run";
  if (isTerminalStatus(attempt.status)) return attempt.status;
  if (attempt.status !== "starting" && attempt.status !== "running") return "unknown";

  let hasLiveOwnerPid = false;
  if (processAlive !== undefined) {
    for (const pid of liveOwnerPids(attempt)) {
      if (!processAlive(pid)) return "stuck";
      hasLiveOwnerPid = true;
    }
  }

  const lastActive = activeSinceMs(attempt);
  if (!hasLiveOwnerPid && lastActive !== null && now.getTime() - lastActive > DEFAULT_HEARTBEAT_STALE_SECONDS * 1000) {
    return "stuck";
  }

  const deadline = dateMs(attempt.deadline_at);
  if (deadline !== null && deadline <= now.getTime()) return "overdue";

  return "running";
}

export function computeRunHealth(state: ComputedRunState): ComputedRunHealth {
  switch (state) {
    case "running":
    case "succeeded":
    case "skipped":
      return "ok";
    case "stuck":
    case "abandoned":
      return "critical";
    case "unknown":
      return "unknown";
    default:
      return "attention";
  }
}
