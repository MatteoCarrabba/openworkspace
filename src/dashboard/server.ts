/**
 * Dashboard v1 — read-only (PRD §9).
 *
 * - SECURE DEFAULT: binds 127.0.0.1 only and validates the Host header
 *   (localhost/127.0.0.1 only) as a DNS-rebinding defense. With NO host /
 *   allow-host configured this is unchanged.
 * - SERVABLE on a tailnet when the operator opts in: a configurable BIND HOST
 *   (`--host` / config `host`, default "127.0.0.1") lets it bind e.g. a
 *   Tailscale IP or 0.0.0.0, and a configurable ALLOWED-HOSTS set
 *   (`--allow-host` repeatable / config `allowed_hosts`) is ADDED to the
 *   default {localhost,127.0.0.1} so a tailnet name/IP (optionally with a
 *   :port) passes the Host check. Anything outside the (default ∪ configured)
 *   set is still rejected — the DNS-rebinding defense is intact, just
 *   extensible.
 * - GET /api/scan returns a live workspace scan: projects with lifecycle,
 *   tasks (dotted hierarchy + truthful rollups), attention counts. The HTTP
 *   scan is body-light for survey speed; task bodies load through /api/task.
 * - GET /api/task?project=<uid>&task=<id> returns one full task record for the
 *   detail pane.
 *   (waiting / review / tasks-unhidden-today / doctor error count).
 * - Zero stored state, zero mutation endpoints: GET/HEAD only, 405 otherwise.
 *
 * Doctor note (integrator): src/doctor.ts is the authority for invariant
 * checks (`projects doctor` / `home doctor`). The scan keeps its own
 * lightweight subset computed during the task walk (unparseable frontmatter,
 * done-with-recur, malformed hidden_until, duplicate task/project IDs) so a
 * dashboard request stays one cheap pass; the attention chip is a pointer to
 * run the real doctor, not a replacement for it. The seam remains
 * `collectDoctorIssues` if full delegation is ever wanted.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

import { FrontmatterRecord, readRecord } from "../lib/frontmatter.js";
import { ParsedId, formatId, idFromFilename, parseId } from "../lib/ids.js";
import { STORE_DIR_ENV, defaultStoreDir } from "../lib/machine.js";
import { TomlTable, readTomlIfExists } from "../lib/toml.js";
import {
  Lifecycle,
  MARKER_DIR,
  ProjectInfo,
  Workspace,
  discoverProjects,
  findDuplicateUids,
  findWorkspaceRoot,
  openWorkspace,
} from "../lib/workspace.js";
import { scanManifests } from "../primitives/automations.js";
import {
  automationStatePath,
  computeRunHealth,
  computeRunState,
  readAttempt,
} from "../primitives/automation-runs.js";
import type { MachineStore } from "../lib/machine.js";
import type { ComputedRunHealth, ComputedRunState } from "../primitives/automation-runs.js";

// ---------------------------------------------------------------------------
// Scan model

export const TASK_STATUSES = ["todo", "doing", "waiting", "review", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Most-attention-demanding first; rollups inherit the worst descendant. */
export const ATTENTION_ORDER: readonly TaskStatus[] = ["waiting", "review", "doing", "todo", "done"];

export interface ScanTask {
  id: string;
  file: string; // relative to the project root
  title: string;
  status: string; // raw value; closed-vocabulary enforcement belongs to doctor
  quadrant: string | null;
  labels: string[];
  recur: string | null;
  hiddenUntil: string | null;
  hidden: boolean; // hidden_until is in the future relative to scan time
  unhiddenToday: boolean; // hidden_until passed on the scan's calendar day
  created: string | null;
  updated: string | null;
  parentId: string | null; // derived purely from the dotted ID
  depth: number; // 0 = top-level
  body: string; // full in direct scans/detail endpoint; empty in body-light HTTP scans
  rollup: TaskRollup | null; // present only when the task has descendants
}

export interface TaskRollup {
  total: number; // descendant count
  done: number;
  status: string; // worst of self + descendants per ATTENTION_ORDER
}

export interface DoctorIssue {
  project: string | null; // project relPath; null = workspace-level
  file: string | null;
  message: string;
}

export interface ScanProject {
  uid: string;
  relPath: string;
  name: string;
  lifecycle: Lifecycle;
  nestedUnder: string | null;
  tasks: ScanTask[];
  taskCounts: { total: number; done: number; hidden: number };
}

export interface ScanResult {
  generatedAt: string;
  workspace: { root: string; name: string; workspaceId: string | null };
  counts: { active: number; dormant: number; archived: number; all: number };
  attention: { waiting: number; review: number; unhiddenToday: number; doctorErrors: number };
  projects: ScanProject[];
  doctor: { errors: DoctorIssue[] };
}

export interface TaskDetailResult {
  generatedAt: string;
  workspace: { root: string; name: string; workspaceId: string | null };
  project: { uid: string; relPath: string; name: string; lifecycle: Lifecycle };
  task: ScanTask;
}

// ---------------------------------------------------------------------------
// Automations scan model (§7.3 / §8.2 — "which automations exist, and WHICH
// ARE ACTIVE AND WHERE"). Read-only: the synced per-machine registries
// (.openworkspace/machines/<id>.toml) joined against each project's declared
// automation manifests. The only machine-local read is a bounded state.toml →
// single attempt lookup for this host's latest run, when that pointer exists.

/** One machine's view of an automation, drawn from its synced registry. */
export interface AutomationMachineState {
  machineId: string;
  /** Heartbeat ISO timestamp of the registry (when it last published), or null. */
  heartbeat: string | null;
  /** Whole minutes since the heartbeat, or null when unparseable/absent. */
  staleMinutes: number | null;
  /** This machine's registry lists an activation for this automation. */
  activated: boolean;
  /** This machine DECLARES this automation in its manifest `machines = [...]`. */
  declared: boolean;
  /** The activation's recorded schedule string (registry copy), or null. */
  schedule: string | null;
  /** Latest run outcome on this machine, from [last_runs], or null. */
  lastRun: { status: string; finishedAt: string | null; startedAt: string | null; exitCode: number | null } | null;
}

export type AutomationDriftKind = "declared-not-activated" | "activated-undeclared";

export interface AutomationDrift {
  kind: AutomationDriftKind;
  machineId: string;
  detail: string;
}

export type AutomationLocalRunUnavailableReason =
  | "state-file-missing"
  | "state-file-invalid"
  | "state-file-missing-run-id"
  | "attempt-missing"
  | "attempt-invalid"
  | "direct-exec-unobservable";

export interface AutomationLocalRun {
  source: "state-file" | "attempt";
  runId: string | null;
  state: ComputedRunState;
  health: ComputedRunHealth;
  status: string | null;
  phase: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  heartbeatAt: string | null;
  finishedAt: string | null;
  reason: string | null;
}

export interface ScanAutomation {
  /** Stable key: `<project relPath>/<name>`. */
  key: string;
  name: string;
  project: { uid: string; relPath: string; name: string; lifecycle: Lifecycle };
  /** Declared placement intent (manifest `machines`); empty when invalid/absent. */
  declaredMachines: string[];
  schedule: string | null;
  /** Manifest [run].kind, descriptive only. */
  kind: string | null;
  missPolicy: string | null;
  misfireGraceSeconds: number | null;
  maxCatchUp: number | null;
  overlapPolicy: string | null;
  maxConcurrency: number | null;
  /** Manifest validity — an invalid manifest hard-fails every fire. */
  valid: boolean;
  problems: string[];
  /** Latest known local machine run state, if a single cheap state pointer exists. */
  localRunState: ComputedRunState;
  localRunHealth: ComputedRunHealth;
  localRun: AutomationLocalRun | null;
  localRunUnavailable: AutomationLocalRunUnavailableReason | null;
  /** Per-machine state, one entry per machine that declares OR activates it. */
  machines: AutomationMachineState[];
  /** Machine ids where this automation is actually activated (registry-observed). */
  activatedOn: string[];
  /** Placement drift, the way doctor surfaces it. */
  drift: AutomationDrift[];
}

/** One machine's synced registry, parsed for the automations view. */
export interface ScanMachineRegistry {
  machineId: string;
  heartbeat: string | null;
  staleMinutes: number | null;
  /** Count of activations recorded in this machine's registry. */
  activationCount: number;
}

export interface AutomationsScanResult {
  generatedAt: string;
  workspace: { root: string; name: string; workspaceId: string | null };
  machines: ScanMachineRegistry[];
  automations: ScanAutomation[];
  /** Flattened drift across all automations — the doctor-style attention list. */
  drift: Array<AutomationDrift & { automation: string; project: string }>;
}

// ---------------------------------------------------------------------------
// Task scanning

function asStringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function asLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

/** YAML-core dates stay strings (lib contract); parse them ourselves. */
function parseDate(raw: string): Date | null {
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : new Date(ms);
}

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface ParsedTaskFile {
  task: ScanTask;
  parsed: ParsedId | null;
  issues: DoctorIssue[];
}

function readTaskFile(
  projectRelPath: string,
  projectRoot: string,
  fileName: string,
  now: Date,
  includeBody: boolean,
): ParsedTaskFile | null {
  const filePath = path.join(projectRoot, "_project", "tasks", fileName);
  const relFile = path.join("_project", "tasks", fileName);
  let rec: FrontmatterRecord;
  try {
    rec = readRecord(filePath);
  } catch {
    return null; // unreadable file (race with deletion); skip
  }
  const issues: DoctorIssue[] = [];
  for (const err of rec.errors) {
    issues.push({ project: projectRelPath, file: relFile, message: `unparseable frontmatter: ${err}` });
  }

  const data = rec.data;
  const fromName = idFromFilename(fileName);
  const declaredId = asStringOrNull(data["id"]);
  const parsed = fromName ?? (declaredId ? parseId(declaredId) : null);
  const id = parsed
    ? formatId(parsed.prefix, parsed.parts, parsed.machineSuffix)
    : (declaredId ?? fileName.replace(/\.md$/, ""));

  const status = asStringOrNull(data["status"]) ?? "todo";
  const recur = asStringOrNull(data["recur"]);
  if (status === "done" && recur !== null) {
    issues.push({
      project: projectRelPath,
      file: relFile,
      message: `${id}: status done with recur set — complete the occurrence or retire the recurrence`,
    });
  }

  const hiddenUntilRaw = asStringOrNull(data["hidden_until"]);
  let hidden = false;
  let unhiddenToday = false;
  if (hiddenUntilRaw !== null) {
    const date = parseDate(hiddenUntilRaw);
    if (date === null) {
      issues.push({ project: projectRelPath, file: relFile, message: `${id}: unparseable hidden_until "${hiddenUntilRaw}"` });
    } else if (date.getTime() > now.getTime()) {
      hidden = true;
    } else if (utcDay(date) === utcDay(now)) {
      unhiddenToday = true;
    }
  }

  const parentId =
    parsed && parsed.parts.length > 1
      ? formatId(parsed.prefix, parsed.parts.slice(0, -1), parsed.machineSuffix)
      : null;

  const task: ScanTask = {
    id,
    file: relFile,
    title: asStringOrNull(data["title"]) ?? id,
    status,
    quadrant: asStringOrNull(data["quadrant"]),
    labels: asLabels(data["labels"]),
    recur,
    hiddenUntil: hiddenUntilRaw,
    hidden,
    unhiddenToday,
    created: asStringOrNull(data["created"]),
    updated: asStringOrNull(data["updated"]),
    parentId,
    depth: parsed ? parsed.parts.length - 1 : 0,
    body: includeBody ? rec.body : "",
    rollup: null,
  };
  return { task, parsed, issues };
}

function compareTasks(a: ParsedTaskFile, b: ParsedTaskFile): number {
  const pa = a.parsed?.parts ?? null;
  const pb = b.parsed?.parts ?? null;
  if (pa && pb) {
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      const da = pa[i] ?? -1;
      const db = pb[i] ?? -1;
      if (da !== db) return da - db;
    }
    return (a.parsed?.machineSuffix ?? "").localeCompare(b.parsed?.machineSuffix ?? "");
  }
  if (pa) return -1;
  if (pb) return 1;
  return a.task.id.localeCompare(b.task.id);
}

function computeRollups(tasks: ScanTask[]): void {
  const children = new Map<string, ScanTask[]>();
  const byId = new Map<string, ScanTask>();
  for (const t of tasks) byId.set(t.id, t);
  for (const t of tasks) {
    if (t.parentId !== null && byId.has(t.parentId)) {
      let list = children.get(t.parentId);
      if (!list) children.set(t.parentId, (list = []));
      list.push(t);
    }
  }
  const rank = (s: string): number => {
    const i = ATTENTION_ORDER.indexOf(s as TaskStatus);
    return i === -1 ? ATTENTION_ORDER.length : i;
  };
  const descend = (t: ScanTask): ScanTask[] => {
    const out: ScanTask[] = [];
    for (const c of children.get(t.id) ?? []) {
      out.push(c, ...descend(c));
    }
    return out;
  };
  for (const t of tasks) {
    const desc = descend(t);
    if (desc.length === 0) continue;
    let worst = t.status;
    let done = 0;
    for (const d of desc) {
      if (d.status === "done") done++;
      if (rank(d.status) < rank(worst)) worst = d.status;
    }
    t.rollup = { total: desc.length, done, status: worst };
  }
}

function scanProjectTasks(
  info: ProjectInfo,
  now: Date,
  options: { includeBodies?: boolean } = {},
): { tasks: ScanTask[]; issues: DoctorIssue[] } {
  const includeBodies = options.includeBodies ?? true;
  const tasksDir = path.join(info.root, "_project", "tasks");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(tasksDir, { withFileTypes: true });
  } catch {
    return { tasks: [], issues: [] };
  }
  const parsedFiles: ParsedTaskFile[] = [];
  const issues: DoctorIssue[] = [];
  for (const entry of entries) {
    // archive/ is retention, not a live listing; subdirs are never scanned.
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const result = readTaskFile(info.relPath, info.root, entry.name, now, includeBodies);
    if (result === null) continue;
    parsedFiles.push(result);
    issues.push(...result.issues);
  }
  parsedFiles.sort(compareTasks);

  const seen = new Map<string, string>();
  for (const { task } of parsedFiles) {
    const prior = seen.get(task.id);
    if (prior !== undefined) {
      issues.push({ project: info.relPath, file: task.file, message: `duplicate task id ${task.id} (also in ${prior})` });
    } else {
      seen.set(task.id, task.file);
    }
  }

  const tasks = parsedFiles.map((p) => p.task);
  computeRollups(tasks);
  return { tasks, issues };
}

// ---------------------------------------------------------------------------
// Doctor stand-in (seam for the real src/doctor.ts — see header note)

export function collectDoctorIssues(projects: ProjectInfo[], perProjectIssues: DoctorIssue[]): DoctorIssue[] {
  const issues = [...perProjectIssues];
  for (const [uid, paths] of findDuplicateUids(projects)) {
    issues.push({ project: null, file: null, message: `duplicate project uid ${uid}: ${paths.join(", ")}` });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Workspace scan

export function scanWorkspace(
  ws: Workspace,
  now: Date = new Date(),
  options: { includeTaskBodies?: boolean } = {},
): ScanResult {
  const infos = discoverProjects(ws, { all: true });
  const taskIssues: DoctorIssue[] = [];
  const projects: ScanProject[] = [];

  for (const info of infos) {
    const { tasks, issues } = scanProjectTasks(info, now, { includeBodies: options.includeTaskBodies ?? true });
    taskIssues.push(...issues);
    projects.push({
      uid: info.uid,
      relPath: info.relPath,
      name: path.basename(info.relPath),
      lifecycle: info.lifecycle,
      nestedUnder: info.nestedUnder,
      tasks,
      taskCounts: {
        total: tasks.length,
        done: tasks.filter((t) => t.status === "done").length,
        hidden: tasks.filter((t) => t.hidden).length,
      },
    });
  }

  const errors = collectDoctorIssues(infos, taskIssues);

  let waiting = 0;
  let review = 0;
  let unhiddenToday = 0;
  for (const p of projects) {
    if (p.lifecycle !== "active") continue; // shelved work never demands attention
    for (const t of p.tasks) {
      if (t.hidden) continue;
      if (t.status === "waiting") waiting++;
      if (t.status === "review") review++;
      if (t.unhiddenToday) unhiddenToday++;
    }
  }

  return {
    generatedAt: now.toISOString(),
    workspace: {
      root: ws.root,
      name: path.basename(ws.root),
      workspaceId: ws.config.workspaceId,
    },
    counts: {
      active: projects.filter((p) => p.lifecycle === "active").length,
      dormant: projects.filter((p) => p.lifecycle === "dormant").length,
      archived: projects.filter((p) => p.lifecycle === "archived").length,
      all: projects.length,
    },
    attention: { waiting, review, unhiddenToday, doctorErrors: errors.length },
    projects,
    doctor: { errors },
  };
}

export function taskDetail(
  ws: Workspace,
  projectUid: string,
  taskId: string,
  now: Date = new Date(),
): TaskDetailResult | null {
  const info = discoverProjects(ws, { all: true }).find((p) => p.uid === projectUid);
  if (info === undefined) return null;
  const { tasks } = scanProjectTasks(info, now, { includeBodies: true });
  const task = tasks.find((t) => t.id === taskId);
  if (task === undefined) return null;
  return {
    generatedAt: now.toISOString(),
    workspace: {
      root: ws.root,
      name: path.basename(ws.root),
      workspaceId: ws.config.workspaceId,
    },
    project: {
      uid: info.uid,
      relPath: info.relPath,
      name: path.basename(info.relPath),
      lifecycle: info.lifecycle,
    },
    task,
  };
}

// ---------------------------------------------------------------------------
// Automations scan — synced registries × declared manifests (read-only).

function isTable(v: unknown): v is TomlTable {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function tomlString(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v instanceof Date) return v.toISOString();
  return null;
}

/** A machine registry, parsed once for the automations view. */
interface ParsedRegistry {
  machineId: string;
  heartbeat: string | null;
  staleMinutes: number | null;
  /** key `<uid>--<name>` → activation schedule (registry copy). */
  activations: Map<string, string>;
  /** key `<uid>--<name>` → latest run outcome. */
  lastRuns: Map<string, AutomationMachineState["lastRun"]>;
}

function activationKey(uid: string, name: string): string {
  return `${uid}--${name}`;
}

const COMPUTED_RUN_STATES: readonly ComputedRunState[] = [
  "pending-first-run",
  "running",
  "overdue",
  "stuck",
  "missed",
  "unknown",
  "unobservable-direct-exec",
  "succeeded",
  "failed",
  "timed_out",
  "skipped",
  "error",
  "abandoned",
];

const COMPUTED_RUN_HEALTHS: readonly ComputedRunHealth[] = ["ok", "attention", "critical", "unknown"];

export interface AutomationsScanOptions {
  /** Injected in tests; production defaults to OPENWORKSPACE_STORE_DIR or the platform default. */
  machineStore?: MachineStore;
  machineStoreDir?: string;
}

interface LocalRunRead {
  state: ComputedRunState;
  health: ComputedRunHealth;
  run: AutomationLocalRun | null;
  unavailable: AutomationLocalRunUnavailableReason | null;
}

function isComputedRunState(value: unknown): value is ComputedRunState {
  return typeof value === "string" && (COMPUTED_RUN_STATES as readonly string[]).includes(value);
}

function isComputedRunHealth(value: unknown): value is ComputedRunHealth {
  return typeof value === "string" && (COMPUTED_RUN_HEALTHS as readonly string[]).includes(value);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function machineStoreForScan(options: AutomationsScanOptions): MachineStore {
  return options.machineStore ?? { dir: path.resolve(options.machineStoreDir ?? defaultStoreDir()) };
}

function firstString(raw: TomlTable, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

function nestedString(raw: TomlTable, tables: readonly string[], keys: readonly string[]): string | null {
  for (const tableKey of tables) {
    const table = raw[tableKey];
    if (!isTable(table)) continue;
    const value = firstString(table, keys);
    if (value !== null) return value;
  }
  return null;
}

function runIdFromState(raw: TomlTable): string | null {
  return (
    firstString(raw, ["run_id", "latest_run_id", "last_run_id", "current_run_id"]) ??
    nestedString(raw, ["latest_run", "last_run", "current_run"], ["run_id", "id"])
  );
}

function directRunStateFromState(raw: TomlTable): ComputedRunState | null {
  for (const value of [raw["run_state"], raw["state"], raw["computed_state"]]) {
    if (isComputedRunState(value)) return value;
  }
  for (const tableKey of ["latest_run", "last_run", "current_run"]) {
    const table = raw[tableKey];
    if (!isTable(table)) continue;
    for (const value of [table["run_state"], table["state"], table["computed_state"]]) {
      if (isComputedRunState(value)) return value;
    }
  }
  return null;
}

function directRunHealthFromState(raw: TomlTable): ComputedRunHealth | null {
  for (const value of [raw["run_health"], raw["health"], raw["computed_health"]]) {
    if (isComputedRunHealth(value)) return value;
  }
  for (const tableKey of ["latest_run", "last_run", "current_run"]) {
    const table = raw[tableKey];
    if (!isTable(table)) continue;
    for (const value of [table["run_health"], table["health"], table["computed_health"]]) {
      if (isComputedRunHealth(value)) return value;
    }
  }
  return null;
}

function localRunFromStateFile(raw: TomlTable, runId: string | null, state: ComputedRunState): AutomationLocalRun {
  const health = directRunHealthFromState(raw) ?? computeRunHealth(state);
  return {
    source: "state-file",
    runId,
    state,
    health,
    status: asStringOrNull(raw["status"]),
    phase: asStringOrNull(raw["phase"]),
    startedAt: tomlString(raw["started_at"]),
    updatedAt: tomlString(raw["updated_at"]),
    heartbeatAt: tomlString(raw["heartbeat_at"]),
    finishedAt: tomlString(raw["finished_at"]),
    reason: asStringOrNull(raw["reason"]),
  };
}

function unknownLocalRun(unavailable: AutomationLocalRunUnavailableReason): LocalRunRead {
  return { state: "unknown", health: "unknown", run: null, unavailable };
}

function readLocalRun(
  store: MachineStore,
  uid: string,
  name: string,
  now: Date,
  directExec: boolean,
): LocalRunRead {
  const statePath = automationStatePath(store, uid, name);
  try {
    if (!fs.statSync(statePath).isFile()) return unknownLocalRun("state-file-missing");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      if (directExec) {
        const state: ComputedRunState = "unobservable-direct-exec";
        return {
          state,
          health: computeRunHealth(state),
          run: null,
          unavailable: "direct-exec-unobservable",
        };
      }
      return unknownLocalRun("state-file-missing");
    }
    return unknownLocalRun("state-file-invalid");
  }

  let raw: TomlTable;
  try {
    raw = readTomlIfExists(statePath);
  } catch {
    return unknownLocalRun("state-file-invalid");
  }

  const runId = runIdFromState(raw);
  const directState = directRunStateFromState(raw);
  if (runId === null) {
    if (directState !== null) {
      const run = localRunFromStateFile(raw, null, directState);
      return { state: run.state, health: run.health, run, unavailable: null };
    }
    return unknownLocalRun("state-file-missing-run-id");
  }

  try {
    const attempt = readAttempt(store, uid, name, runId);
    if (attempt === null) {
      if (directState !== null) {
        const run = localRunFromStateFile(raw, runId, directState);
        return { state: run.state, health: run.health, run, unavailable: null };
      }
      return unknownLocalRun("attempt-missing");
    }
    const state = computeRunState(attempt, now, pidAlive);
    const health = computeRunHealth(state);
    const run: AutomationLocalRun = {
      source: "attempt",
      runId: attempt.run_id,
      state,
      health,
      status: attempt.status,
      phase: attempt.phase,
      startedAt: attempt.started_at ?? null,
      updatedAt: attempt.updated_at,
      heartbeatAt: attempt.heartbeat_at ?? null,
      finishedAt: attempt.finished_at ?? null,
      reason: attempt.reason ?? null,
    };
    return { state, health, run, unavailable: null };
  } catch {
    if (directState !== null) {
      const run = localRunFromStateFile(raw, runId, directState);
      return { state: run.state, health: run.health, run, unavailable: null };
    }
    return unknownLocalRun("attempt-invalid");
  }
}

function readMachineRegistries(ws: Workspace, now: Date): ParsedRegistry[] {
  const machinesDir = path.join(ws.root, MARKER_DIR, "machines");
  let files: string[];
  try {
    files = fs.readdirSync(machinesDir).filter((f) => f.endsWith(".toml")).sort();
  } catch {
    return [];
  }
  const nowMs = now.getTime();
  const out: ParsedRegistry[] = [];
  for (const file of files) {
    const fallbackId = file.slice(0, -5);
    let raw: TomlTable;
    try {
      raw = readTomlIfExists(path.join(machinesDir, file));
    } catch {
      out.push({ machineId: fallbackId, heartbeat: null, staleMinutes: null, activations: new Map(), lastRuns: new Map() });
      continue;
    }
    const heartbeat = tomlString(raw["heartbeat"]);
    const hbMs = heartbeat !== null ? Date.parse(heartbeat) : Number.NaN;
    const activations = new Map<string, string>();
    if (Array.isArray(raw["activations"])) {
      for (const a of raw["activations"]) {
        if (!isTable(a) || typeof a["project_uid"] !== "string" || typeof a["name"] !== "string") continue;
        activations.set(activationKey(a["project_uid"], a["name"]), tomlString(a["schedule"]) ?? "");
      }
    }
    const lastRuns = new Map<string, AutomationMachineState["lastRun"]>();
    if (isTable(raw["last_runs"])) {
      for (const [key, v] of Object.entries(raw["last_runs"] as TomlTable)) {
        if (!isTable(v)) continue;
        lastRuns.set(key, {
          status: typeof v["status"] === "string" ? v["status"] : "unknown",
          finishedAt: tomlString(v["finished_at"]),
          startedAt: tomlString(v["started_at"]),
          exitCode: typeof v["exit_code"] === "number" ? v["exit_code"] : null,
        });
      }
    }
    out.push({
      machineId: typeof raw["machine_id"] === "string" ? raw["machine_id"] : fallbackId,
      heartbeat,
      staleMinutes: Number.isNaN(hbMs) ? null : Math.max(0, Math.floor((nowMs - hbMs) / 60_000)),
      activations,
      lastRuns,
    });
  }
  return out;
}

/**
 * Scan automations across the workspace. For each declared automation we join:
 *  - DECLARED machines: the manifest `machines = [...]` placement intent;
 *  - ACTIVATED-where: which machines' synced registries actually list it;
 *  - LAST-RUN: that machine's `[last_runs]` outcome for `<uid>--<name>`;
 *  - STALENESS: each machine's heartbeat age (how long since it published).
 * Placement drift (declared-but-not-activated / activated-but-undeclared) is
 * computed the way doctor surfaces it — a report, never a control plane.
 */
export function scanAutomations(
  ws: Workspace,
  now: Date = new Date(),
  options: AutomationsScanOptions = {},
): AutomationsScanResult {
  const registries = readMachineRegistries(ws, now);
  const byMachine = new Map(registries.map((r) => [r.machineId, r]));
  const infos = discoverProjects(ws, { all: true });
  const localStore = machineStoreForScan(options);

  const automations: ScanAutomation[] = [];
  const flatDrift: AutomationsScanResult["drift"] = [];

  for (const info of infos) {
    for (const entry of scanManifests(info.root)) {
      const manifest = entry.manifest;
      const declaredMachines = entry.manifest?.machines ?? [];
      const uid = info.uid;
      const key = activationKey(uid, entry.name);
      const localRun = readLocalRun(localStore, uid, entry.name, now, manifest?.run.directExec ?? false);

      // Union of machines that DECLARE this automation and machines whose
      // registry ACTIVATES it — so the view shows placement everywhere it lives.
      const relevant = new Set<string>(declaredMachines);
      for (const reg of registries) if (reg.activations.has(key)) relevant.add(reg.machineId);

      const machineStates: AutomationMachineState[] = [];
      const activatedOn: string[] = [];
      const drift: AutomationDrift[] = [];
      for (const mid of [...relevant].sort()) {
        const reg = byMachine.get(mid);
        const activated = reg?.activations.has(key) ?? false;
        const declared = declaredMachines.includes(mid);
        if (activated) activatedOn.push(mid);
        machineStates.push({
          machineId: mid,
          heartbeat: reg?.heartbeat ?? null,
          staleMinutes: reg?.staleMinutes ?? null,
          activated,
          declared,
          schedule: activated ? reg!.activations.get(key) ?? null : null,
          lastRun: reg?.lastRuns.get(key) ?? null,
        });
        if (declared && !activated) {
          const d: AutomationDrift = {
            kind: "declared-not-activated",
            machineId: mid,
            detail:
              reg === undefined
                ? `declared for "${mid}" but that machine has no synced registry — apply there`
                : `declared for "${mid}" but its registry shows no activation — apply there`,
          };
          drift.push(d);
        } else if (activated && !declared) {
          const d: AutomationDrift = {
            kind: "activated-undeclared",
            machineId: mid,
            detail: `activated on "${mid}" but the manifest does not declare it — deactivate there or declare`,
          };
          drift.push(d);
        }
      }

      for (const d of drift) {
        flatDrift.push({ ...d, automation: entry.name, project: info.relPath });
      }

      automations.push({
        key: `${info.relPath}/${entry.name}`,
        name: entry.name,
        project: { uid, relPath: info.relPath, name: path.basename(info.relPath), lifecycle: info.lifecycle },
        declaredMachines,
        schedule: entry.manifest !== null ? scheduleSummaryOf(entry.manifest) : null,
        kind: manifest?.run.kind ?? null,
        missPolicy: manifest?.schedule.missPolicy ?? null,
        misfireGraceSeconds: manifest?.schedule.misfireGraceSeconds ?? null,
        maxCatchUp: manifest?.schedule.maxCatchUp ?? null,
        overlapPolicy: manifest?.run.overlapPolicy ?? null,
        maxConcurrency: manifest?.run.maxConcurrency ?? null,
        valid: entry.manifest !== null,
        problems: entry.problems.map((p) => p.message),
        localRunState: localRun.state,
        localRunHealth: localRun.health,
        localRun: localRun.run,
        localRunUnavailable: localRun.unavailable,
        machines: machineStates,
        activatedOn,
        drift,
      });
    }
  }

  automations.sort((a, b) => a.key.localeCompare(b.key));

  return {
    generatedAt: now.toISOString(),
    workspace: { root: ws.root, name: path.basename(ws.root), workspaceId: ws.config.workspaceId },
    machines: registries.map((r) => ({
      machineId: r.machineId,
      heartbeat: r.heartbeat,
      staleMinutes: r.staleMinutes,
      activationCount: r.activations.size,
    })),
    automations,
    drift: flatDrift,
  };
}

/** Local schedule summary (avoids importing the verb module's helper by name). */
function scheduleSummaryOf(manifest: { schedule: { cron: string | null; calendar: unknown[] } }): string {
  if (manifest.schedule.cron !== null) return `cron ${manifest.schedule.cron}`;
  const n = manifest.schedule.calendar.length;
  return `calendar_interval (${n} entr${n === 1 ? "y" : "ies"})`;
}

// ---------------------------------------------------------------------------
// HTTP server

/** The secure default allowlist — always present, never removable. */
export const DEFAULT_ALLOWED_HOSTS: readonly string[] = ["localhost", "127.0.0.1"];

/**
 * Normalize a configured allow-host entry to a comparable hostname: lowercased,
 * IPv6 brackets stripped, and any trailing `:port` removed (so an operator can
 * pass either "host.ts.net" or "host.ts.net:7777"). Returns null when the
 * entry has no usable host part.
 */
function normalizeHostEntry(entry: string): string | null {
  let host = entry.trim().toLowerCase();
  if (host === "") return null;
  if (host.startsWith("[")) {
    const close = host.indexOf("]");
    if (close === -1) return null;
    host = host.slice(1, close);
  } else {
    const colon = host.indexOf(":");
    if (colon !== -1) {
      // a bare IPv6 (multiple colons, unbracketed) has no clean host:port split;
      // require it to be bracketed → reject here.
      if (host.indexOf(":", colon + 1) !== -1) return null;
      host = host.slice(0, colon);
    }
  }
  return host === "" ? null : host;
}

/** Build the effective allowlist: the secure default ∪ any configured hosts. */
export function buildAllowedHosts(extra: readonly string[] = []): Set<string> {
  const set = new Set<string>(DEFAULT_ALLOWED_HOSTS);
  for (const e of extra) {
    const h = normalizeHostEntry(e);
    if (h !== null) set.add(h);
  }
  return set;
}

/**
 * Host-header validation — the DNS-rebinding defense. Missing header fails.
 * `allowed` defaults to the secure {localhost,127.0.0.1} set; callers pass an
 * extended set (default ∪ configured allow-hosts) to permit a tailnet name/IP.
 */
export function hostAllowed(
  hostHeader: string | undefined,
  allowed: Set<string> = new Set(DEFAULT_ALLOWED_HOSTS),
): boolean {
  if (!hostHeader) return false;
  const host = normalizeHostEntry(hostHeader);
  if (host === null) return false; // bare/unbracketed IPv6 or empty — not allowed
  return allowed.has(host);
}

function findIndexHtml(): string | null {
  // tsc does not copy .html into dist; resolve dist-adjacent first, then the
  // source tree relative to dist/src/dashboard/. Integrator may add a copy step.
  const candidates = [
    path.join(__dirname, "index.html"),
    path.resolve(__dirname, "..", "..", "..", "src", "dashboard", "index.html"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export interface DashboardOptions {
  workspaceRoot: string;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
  /** Override the index.html location (tests / packaging). */
  indexHtmlPath?: string;
  /**
   * Extra Host-header values to allow ON TOP of the secure default
   * {localhost,127.0.0.1} — e.g. a tailnet name "host.tailnet.ts.net" or a
   * tailnet IP, optionally with a :port suffix. Empty/absent ⇒ default-only.
   */
  allowedHosts?: readonly string[];
  /**
   * In-MEMORY scan cache TTL, in milliseconds. The first `/api/scan` builds the
   * scan (slow on a large workspace), caches it in process with the timestamp it
   * was actually built at, and serves that cached result for subsequent requests
   * within the TTL. When the TTL has elapsed, a request serves the still-recent
   * cached scan immediately and triggers a single background rebuild (so no
   * request ever blocks on the slow walk once the cache is warm).
   *
   * This is a rebuildable in-process cache, NOT a state file — nothing is
   * written to disk; the live tree stays the source of truth. The cached scan's
   * `generatedAt` always reflects when that scan was built, never request time,
   * so the dashboard's freshness contract stays honest.
   *
   * `0` (the default) DISABLES caching: every request rebuilds against the live
   * tree, identical to the pre-cache behavior. The foreground `dashboard dev`
   * local case keeps this fully-fresh default; long-lived served instances (the
   * Mini) set a small positive TTL (~15000ms is the documented suggestion).
   */
  cacheTtlMs?: number;
  /**
   * Production dashboard scans run in a child process so a sync filesystem stall
   * in a FileProvider-backed workspace cannot freeze the HTTP server itself.
   * Tests that inject `now` default to in-process scans for deterministic clocks.
   */
  useScanWorker?: boolean;
  /** Kill a scan child after this many milliseconds. Default: 20000. */
  scanTimeoutMs?: number;
  /** Optional machine-local store dir; read-only, and mainly injected by tests. */
  machineStoreDir?: string;
}

/** A built scan plus the wall-clock instant it was built at. */
interface CachedScan<T> {
  result: T;
  builtAt: number; // ms epoch, from the injected clock
}

/**
 * Short-TTL, stale-while-revalidate scan cache for one dashboard server.
 *
 * - `get()` returns a cached scan when one exists and is younger than the TTL.
 * - When the cached scan is older than the TTL it is still returned
 *   immediately (stale-but-recent) and a single background rebuild is kicked
 *   off; concurrent expiries coalesce into one rebuild.
 * - With `ttlMs <= 0` the cache is disabled: every `get()` rebuilds synchronously.
 *
 * The cache never invents a timestamp — `result.generatedAt` is whatever the
 * builder stamped at build time, so freshness shown to the user is truthful.
 */
class ScanCache<T> {
  private cached: CachedScan<T> | null = null;
  private refreshing = false;

  constructor(
    private readonly build: () => Promise<T>,
    private readonly nowMs: () => number,
    private readonly ttlMs: number,
  ) {}

  async get(): Promise<T> {
    // Caching disabled: always fresh.
    if (this.ttlMs <= 0) return await this.build();

    const now = this.nowMs();
    if (this.cached === null) {
      // Cold cache: build synchronously (the one unavoidable slow request).
      this.cached = { result: await this.build(), builtAt: now };
      return this.cached.result;
    }

    const age = now - this.cached.builtAt;
    if (age >= this.ttlMs) {
      // Stale-but-recent: serve the cached scan now, rebuild in the background.
      this.refreshInBackground();
    }
    return this.cached.result;
  }

  private refreshInBackground(): void {
    if (this.refreshing) return; // coalesce concurrent expiries into one rebuild
    this.refreshing = true;
    // Defer off the request path; a synchronous build here would still block
    // the triggering request, defeating stale-while-revalidate.
    setImmediate(() => {
      try {
        void this.build()
          .then((built) => {
            this.cached = { result: built, builtAt: this.nowMs() };
          })
          .catch(() => {
            // Keep serving the last good scan; a transient build failure (e.g. a
            // mid-walk file race) must not poison the cache. Next expiry retries.
          })
          .finally(() => {
            this.refreshing = false;
          });
      } catch {
        // Keep serving the last good scan; a transient build failure (e.g. a
        // mid-walk file race) must not poison the cache. Next expiry retries.
        this.refreshing = false;
      }
    });
  }
}

class ScanTimeoutError extends Error {}

function scanChildPath(): string {
  return path.join(__dirname, "scan-child.js");
}

function runScanChild<T>(
  kind: "scan" | "automations" | "task",
  options: DashboardOptions,
  now: Date,
  extraArgs: string[] = [],
): Promise<T> {
  return new Promise((resolve, reject) => {
    const env =
      options.machineStoreDir === undefined
        ? process.env
        : { ...process.env, [STORE_DIR_ENV]: options.machineStoreDir };
    const child = spawn(process.execPath, [scanChildPath(), kind, options.workspaceRoot, now.toISOString(), ...extraArgs], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.scanTimeoutMs ?? 20_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new ScanTimeoutError(`${kind} scan timed out after ${options.scanTimeoutMs ?? 20_000}ms`));
        return;
      }
      let payload: { ok: boolean; result?: T; error?: string };
      try {
        payload = JSON.parse(stdout) as { ok: boolean; result?: T; error?: string };
      } catch {
        reject(new Error(`${kind} scan child produced invalid JSON${stderr ? `: ${stderr.trim()}` : ""}`));
        return;
      }
      if (code !== 0 || !payload.ok) {
        reject(new Error(payload.error ?? stderr.trim() ?? `${kind} scan child exited ${code ?? "by signal"}`));
        return;
      }
      resolve(payload.result as T);
    });
  });
}

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

export function createDashboardServer(options: DashboardOptions): http.Server {
  const now = options.now ?? (() => new Date());
  const allowed = buildAllowedHosts(options.allowedHosts ?? []);
  const ttlMs = options.cacheTtlMs ?? 0;
  const useScanWorker = options.useScanWorker ?? options.now === undefined;

  // Build a scan against the LIVE tree, stamping generatedAt at build time. The
  // cache stores whatever this returns; it never rewrites the timestamp.
  const buildScan = async (): Promise<ScanResult> => {
    if (useScanWorker) return await runScanChild<ScanResult>("scan", options, now());
    const ws = openWorkspace(options.workspaceRoot); // live tree, every build
    return scanWorkspace(ws, now(), { includeTaskBodies: false });
  };
  const scanCache = new ScanCache<ScanResult>(buildScan, () => now().getTime(), ttlMs);

  // The automations view shares the same stale-while-revalidate posture: it is
  // another read-only scan over the live tree (synced registries × manifests).
  const buildAutomations = async (): Promise<AutomationsScanResult> => {
    if (useScanWorker) return await runScanChild<AutomationsScanResult>("automations", options, now());
    const ws = openWorkspace(options.workspaceRoot);
    return scanAutomations(ws, now(), { machineStoreDir: options.machineStoreDir });
  };
  const automationsCache = new ScanCache<AutomationsScanResult>(
    buildAutomations,
    () => now().getTime(),
    ttlMs,
  );

  return http.createServer((req, res) => {
    if (!hostAllowed(req.headers.host, allowed)) {
      sendJson(res, 403, { error: "forbidden: host header not allowed" });
      return;
    }
    // v1 is strictly read-only: no mutation endpoints exist, any non-read
    // method is rejected outright.
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("allow", "GET, HEAD");
      sendJson(res, 405, { error: "method not allowed: dashboard v1 is read-only" });
      return;
    }

    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;

    if (pathname === "/" || pathname === "/index.html") {
      const htmlPath = options.indexHtmlPath ?? findIndexHtml();
      if (htmlPath === null || !fs.existsSync(htmlPath)) {
        sendJson(res, 500, { error: "index.html not found" });
        return;
      }
      const html = fs.readFileSync(htmlPath);
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": html.length,
        "cache-control": "no-store",
      });
      res.end(req.method === "HEAD" ? undefined : html);
      return;
    }

    if (pathname === "/api/scan") {
      void (async () => {
        try {
        // Cache-aware: cold/disabled ⇒ fresh synchronous build; warm-within-TTL
        // ⇒ cached scan; expired ⇒ stale-but-recent now + background rebuild.
          sendJson(res, 200, await scanCache.get());
        } catch (err) {
          sendJson(res, err instanceof ScanTimeoutError ? 504 : 500, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();
      return;
    }

    if (pathname === "/api/task") {
      const project = url.searchParams.get("project");
      const task = url.searchParams.get("task");
      if (project === null || task === null || project === "" || task === "") {
        sendJson(res, 400, { error: "missing project or task query parameter" });
        return;
      }
      void (async () => {
        try {
          const detail = useScanWorker
            ? await runScanChild<TaskDetailResult | null>("task", options, now(), [project, task])
            : (() => {
                const ws = openWorkspace(options.workspaceRoot);
                return taskDetail(ws, project, task, now());
              })();
        if (detail === null) {
          sendJson(res, 404, { error: "task not found" });
        } else {
          sendJson(res, 200, detail);
        }
        } catch (err) {
          sendJson(res, err instanceof ScanTimeoutError ? 504 : 500, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();
      return;
    }

    if (pathname === "/api/automations") {
      void (async () => {
        try {
        // Same read-only, stale-while-revalidate posture as /api/scan.
          sendJson(res, 200, await automationsCache.get());
        } catch (err) {
          sendJson(res, err instanceof ScanTimeoutError ? 504 : 500, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();
      return;
    }

    sendJson(res, 404, { error: "not found" });
  });
}

export interface RunningDashboard {
  server: http.Server;
  port: number;
  url: string;
  close: () => Promise<void>;
}

/** Default bind host — the secure loopback default (unchanged when unset). */
export const DEFAULT_BIND_HOST = "127.0.0.1";

/** Format a host for a URL — bracket bare IPv6, leave names/IPv4 as-is. */
function urlHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export function startDashboard(
  options: DashboardOptions & { port?: number; host?: string },
): Promise<RunningDashboard> {
  const server = createDashboardServer(options);
  const bindHost = options.host ?? DEFAULT_BIND_HOST;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, bindHost, () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error("unexpected server address"));
        return;
      }
      resolve({
        server,
        port: addr.port,
        url: `http://${urlHost(bindHost)}:${addr.port}/`,
        close: () =>
          new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });
  });
}

// Minimal direct entry; the CLI (`projects dashboard dev`) owns the real launcher.
if (require.main === module) {
  const root = findWorkspaceRoot(process.cwd());
  if (root === null) {
    process.stderr.write("error: no workspace found (missing .openworkspace marker)\n");
    process.exit(1);
  }
  const portArg = process.argv.indexOf("--port");
  const port = portArg !== -1 ? Number(process.argv[portArg + 1]) : 0;
  const hostArg = process.argv.indexOf("--host");
  const host = hostArg !== -1 ? process.argv[hostArg + 1] : undefined;
  const ttlArg = process.argv.indexOf("--cache-ttl");
  const ttlRaw = ttlArg !== -1 ? Number(process.argv[ttlArg + 1]) : 0;
  const cacheTtlMs = Number.isNaN(ttlRaw) ? 0 : ttlRaw;
  const allowedHosts: string[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === "--allow-host" && process.argv[i + 1] !== undefined) {
      allowedHosts.push(process.argv[i + 1]!);
    }
  }
  startDashboard({ workspaceRoot: root, port: Number.isNaN(port) ? 0 : port, host, allowedHosts, cacheTtlMs })
    .then((running) => process.stdout.write(`dashboard: ${running.url}\n`))
    .catch((err) => {
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
