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
 * - POST /api/project/reveal {project, target: "finder"|"obsidian"} opens the
 *   project's root in Finder or its Obsidian vault. Loopback-gated exactly
 *   like the task mutation endpoints (it spawns a process); the path is
 *   always resolved server-side from the project uid, never client-supplied.
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
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

import { FrontmatterRecord, readRecord } from "../lib/frontmatter.js";
import { ConfigError, NotFoundError, OwError } from "../lib/errors.js";
import { sha256Hex } from "../lib/fsatomic.js";
import { ParsedId, formatId, idFromFilename, parseId } from "../lib/ids.js";
import { STORE_DIR_ENV, defaultStoreDir } from "../lib/machine.js";
import { TomlTable, readTomlIfExists } from "../lib/toml.js";
import { TaskStateError, addNote, setFinalSummary, setStatus } from "../primitives/tasks.js";
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
  /** `<root>/.obsidian` exists — lets the client show an "Open in Obsidian" control. */
  hasObsidianVault: boolean;
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

/**
 * `hidden` / `unhiddenToday` are relative to the CURRENT instant, not to when
 * a file was last parsed. The warm model parses a file once and holds it
 * across many requests, so these two flags are re-derived from the stored
 * `hiddenUntil` string at every read using the request's `now` — the same
 * rule `readTaskFile` applies, just detached from disk I/O. An unparseable
 * `hiddenUntil` was already recorded as a doctor issue at parse time; here it
 * just leaves both flags false.
 */
function recomputeHiddenFlags(task: ScanTask, now: Date): void {
  if (task.hiddenUntil === null) return;
  const date = parseDate(task.hiddenUntil);
  if (date === null) return;
  task.hidden = date.getTime() > now.getTime();
  task.unhiddenToday = !task.hidden && utcDay(date) === utcDay(now);
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

/** Narrow shape `compareTasks` actually needs — lets the warm model sort its
 *  in-memory file entries (which carry more fields) without a repack. */
interface SortableTaskFile {
  task: Pick<ScanTask, "id">;
  parsed: ParsedId | null;
}

function compareTasks(a: SortableTaskFile, b: SortableTaskFile): number {
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

/** Per-project scan output, the shared unit `assembleScanResult` folds into a
 *  `ScanResult` — produced by a live disk walk (`scanWorkspace`) OR read
 *  straight out of the warm in-memory model (`WarmModel.scan`). */
interface ProjectScanData {
  info: ProjectInfo;
  tasks: ScanTask[];
  issues: DoctorIssue[];
}

/**
 * Assemble a `ScanResult` from already-computed per-project data. Pulled out
 * of `scanWorkspace` so the warm model (Phase 1b) can produce the identical
 * wire shape from in-memory tasks instead of a disk walk, with zero drift
 * between the two code paths.
 */
function assembleScanResult(ws: Workspace, now: Date, projectData: readonly ProjectScanData[]): ScanResult {
  const taskIssues: DoctorIssue[] = [];
  const projects: ScanProject[] = [];

  for (const { info, tasks, issues } of projectData) {
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
      // Cheap: one stat per project per scan, no directory walk.
      hasObsidianVault: fs.existsSync(path.join(info.root, ".obsidian")),
    });
  }

  const errors = collectDoctorIssues(
    projectData.map((p) => p.info),
    taskIssues,
  );

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

export function scanWorkspace(
  ws: Workspace,
  now: Date = new Date(),
  options: { includeTaskBodies?: boolean } = {},
): ScanResult {
  const infos = discoverProjects(ws, { all: true });
  const projectData: ProjectScanData[] = infos.map((info) => {
    const { tasks, issues } = scanProjectTasks(info, now, { includeBodies: options.includeTaskBodies ?? true });
    return { info, tasks, issues };
  });
  return assembleScanResult(ws, now, projectData);
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
// Warm read model (Phase 1b) — a task/scan cache that never goes cold.
//
// The old ScanCache invalidated its ENTIRE built ScanResult on every write and
// re-walked the whole tree (synchronously at TTL 0, or on the next background
// tick otherwise). This model instead:
//   - builds once at server start (one unavoidable full disk walk, same cost
//     as the old cold cache's first request);
//   - is updated WRITE-THROUGH: a mutation re-reads only the ONE file it just
//     changed and folds it back in — no invalidation, no re-walk;
//   - is kept current for out-of-band edits (hand edits, another process, a
//     sync client) by fs.watch on each project's tasks/ dir, reconciling only
//     the touched file(s) by content hash;
//   - self-heals with a slow, unref'd periodic full rebuild in case a watcher
//     never started (FileProvider paths can throw) or drops an event — belt
//     and suspenders, not the primary mechanism.
//
// Everything here is derived and in-memory: closing the server (or just
// letting it die) leaves no state anywhere; the next start rebuilds the same
// model from the same files. SQLite / persistence is explicitly deferred.

/** One parsed task file, as held by the model. */
interface ModelTaskFile {
  task: ScanTask; // always carries the full body; readers strip it for /api/scan
  parsed: ParsedId | null;
  issues: DoctorIssue[]; // this file's own doctor issues (not the project-wide duplicate-id check)
  hash: string; // sha256 of the raw file bytes — change detection AND self-echo suppression
}

interface ModelProject {
  info: ProjectInfo;
  tasksDir: string;
  files: Map<string, ModelTaskFile>; // fileName -> parsed file
  idToFile: Map<string, string>; // task id -> fileName (best-effort; duplicates keep the last-seen file)
}

/** Read + parse + hash exactly one task file. Null on a read race (deleted
 *  between the caller's readdir and this read) — same "skip it" contract
 *  `readTaskFile` already uses for that case. */
function readModelTaskFile(info: ProjectInfo, fileName: string, now: Date): ModelTaskFile | null {
  const filePath = path.join(info.root, "_project", "tasks", fileName);
  let raw: Buffer;
  try {
    raw = fs.readFileSync(filePath);
  } catch {
    return null;
  }
  const parsedFile = readTaskFile(info.relPath, info.root, fileName, now, true);
  if (parsedFile === null) return null;
  return { task: parsedFile.task, parsed: parsedFile.parsed, issues: parsedFile.issues, hash: sha256Hex(raw) };
}

function buildModelProject(info: ProjectInfo, now: Date): ModelProject {
  const tasksDir = path.join(info.root, "_project", "tasks");
  const files = new Map<string, ModelTaskFile>();
  const idToFile = new Map<string, string>();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(tasksDir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const file = readModelTaskFile(info, entry.name, now);
    if (file === null) continue;
    files.set(entry.name, file);
    idToFile.set(file.task.id, entry.name);
  }
  return { info, tasksDir, files, idToFile };
}

/**
 * Re-read exactly ONE task file and fold it into the project's model — the
 * write-through / watcher-reconcile primitive. A file that no longer exists
 * (deleted, or a transient read race) drops its entry. Returns false when the
 * content hash is UNCHANGED from what the model already has: this is what
 * makes self-echo suppression and duplicate-event debouncing "just happen" —
 * the write-through call already stored the post-write hash, so the fs.watch
 * event this same write provokes finds nothing new to do.
 */
function reconcileModelFile(mp: ModelProject, fileName: string, now: Date): boolean {
  const prior = mp.files.get(fileName);
  const filePath = path.join(mp.tasksDir, fileName);
  let raw: Buffer;
  try {
    raw = fs.readFileSync(filePath);
  } catch {
    if (prior === undefined) return false;
    mp.files.delete(fileName);
    if (mp.idToFile.get(prior.task.id) === fileName) mp.idToFile.delete(prior.task.id);
    return true;
  }
  const hash = sha256Hex(raw);
  if (prior !== undefined && prior.hash === hash) return false; // unchanged — self-echo or a duplicate event
  const parsedFile = readTaskFile(mp.info.relPath, mp.info.root, fileName, now, true);
  if (parsedFile === null) return false; // raced with a deletion between the two reads above
  if (prior !== undefined && mp.idToFile.get(prior.task.id) === fileName) mp.idToFile.delete(prior.task.id);
  mp.files.set(fileName, { task: parsedFile.task, parsed: parsedFile.parsed, issues: parsedFile.issues, hash });
  mp.idToFile.set(parsedFile.task.id, fileName);
  return true;
}

/** One project's tasks, assembled from the model — no disk I/O. Clones every
 *  task (never mutates the stored copy) so hidden-flag recompute and rollups
 *  computed for THIS read never leak into what the model holds for the next
 *  one. */
function projectView(mp: ModelProject, includeBodies: boolean, now: Date): { tasks: ScanTask[]; issues: DoctorIssue[] } {
  const entries = [...mp.files.values()];
  entries.sort(compareTasks);

  const tasks = entries.map((f): ScanTask => {
    const clone: ScanTask = { ...f.task, body: includeBodies ? f.task.body : "" };
    recomputeHiddenFlags(clone, now);
    return clone;
  });
  computeRollups(tasks);

  const issues: DoctorIssue[] = [];
  for (const f of entries) issues.push(...f.issues);
  const seen = new Map<string, string>();
  for (const f of entries) {
    const prior = seen.get(f.task.id);
    if (prior !== undefined) {
      issues.push({ project: mp.info.relPath, file: f.task.file, message: `duplicate task id ${f.task.id} (also in ${prior})` });
    } else {
      seen.set(f.task.id, f.task.file);
    }
  }
  return { tasks, issues };
}

/** Debounce window: coalesce a burst of fs.watch events (e.g. temp-file
 *  create + fsync + rename, all for ONE atomic write) into a single
 *  reconcile pass per project. */
const WATCH_DEBOUNCE_MS = 75;

/** Self-heal interval: a slow, unref'd full rebuild that never blocks a
 *  request and never crashes the process — the backstop for a watcher that
 *  failed to start or silently dropped an event. */
const PERIODIC_RECONCILE_MS = 30_000;

/** OpenWorkspace's own atomic-write temp files (`fsatomic.ts`) — never real
 *  task content, always ignore them in a watch callback. */
function isOwnTempFile(fileName: string): boolean {
  return /^\..*\.ow-tmp-\d+-[0-9a-f]{8}$/.test(fileName);
}

/** One change to the warm model, as pushed to /events subscribers. `task` is
 *  null when a reconcile couldn't resolve which task id was affected (e.g. a
 *  file deleted before its id could be recovered) — clients should treat that
 *  as "something in this project changed" and just refresh. */
export interface ModelChangeEvent {
  project: string; // project uid
  task: string | null; // task id, when known
}

export class WarmModel {
  private readonly ws: Workspace;
  private readonly nowFn: () => Date;
  private projects: ModelProject[] = [];
  private byUid = new Map<string, ModelProject>();
  private watchers: fs.FSWatcher[] = [];
  private pendingByProject = new Map<string, Set<string>>(); // uid -> pending filenames
  private debounceTimers = new Map<string, NodeJS.Timeout>(); // uid -> debounce timer
  private periodicHandle: NodeJS.Timeout | null = null;
  private closed = false;
  // Batch 3 (SSE): a change fires from write-through OR a watch-reconciled
  // file — never from the periodic self-heal rebuild (that's a backstop, not
  // a signal a client should react to). No listener cap: connections are
  // capped where they're accepted (the /events route), not here.
  private readonly emitter = new EventEmitter();

  constructor(ws: Workspace, nowFn: () => Date, options: { watch?: boolean } = {}) {
    this.ws = ws;
    this.nowFn = nowFn;
    this.emitter.setMaxListeners(0);
    this.rebuildFull();
    if (options.watch !== false) this.startWatching();
    this.startPeriodicReconcile();
  }

  /** Subscribe to change events (write-through or fs.watch reconcile). Returns
   *  an unsubscribe function. Used by the /events SSE route. */
  onChange(listener: (event: ModelChangeEvent) => void): () => void {
    this.emitter.on("change", listener);
    return () => this.emitter.off("change", listener);
  }

  private emitChange(projectUid: string, taskId: string | null): void {
    this.emitter.emit("change", { project: projectUid, task: taskId } satisfies ModelChangeEvent);
  }

  private rebuildFull(): void {
    const now = this.nowFn();
    const infos = discoverProjects(this.ws, { all: true });
    this.projects = infos.map((info) => buildModelProject(info, now));
    this.byUid = new Map(this.projects.map((p) => [p.info.uid, p]));
  }

  scan(includeBodies: boolean): ScanResult {
    const now = this.nowFn();
    const projectData: ProjectScanData[] = this.projects.map((mp) => {
      const { tasks, issues } = projectView(mp, includeBodies, now);
      return { info: mp.info, tasks, issues };
    });
    return assembleScanResult(this.ws, now, projectData);
  }

  taskDetail(projectUid: string, taskId: string): TaskDetailResult | null {
    const mp = this.byUid.get(projectUid);
    if (mp === undefined) return null;
    const now = this.nowFn();
    const { tasks } = projectView(mp, true, now);
    const task = tasks.find((t) => t.id === taskId);
    if (task === undefined) return null;
    return {
      generatedAt: now.toISOString(),
      workspace: { root: this.ws.root, name: path.basename(this.ws.root), workspaceId: this.ws.config.workspaceId },
      project: {
        uid: mp.info.uid,
        relPath: mp.info.relPath,
        name: path.basename(mp.info.relPath),
        lifecycle: mp.info.lifecycle,
      },
      task,
    };
  }

  /**
   * Write-through: call right after a mutation's library write has already
   * landed on disk. Re-reads ONLY that one task file and records its new hash
   * so the fs.watch event the write itself provokes is a no-op (self-echo
   * suppression — see `reconcileModelFile`). Never touches any other file.
   */
  writeThrough(projectUid: string, taskId: string): void {
    const mp = this.byUid.get(projectUid);
    if (mp === undefined) return;
    const now = this.nowFn();
    const known = mp.idToFile.get(taskId);
    if (known !== undefined) {
      reconcileModelFile(mp, known, now);
      this.emitChange(projectUid, taskId);
      return;
    }
    // Unknown task id (shouldn't happen for an existing-task mutation, but a
    // stale idToFile after an out-of-band rename would land here) — a
    // per-project rebuild is still bounded to this one project's tasks dir,
    // never the whole workspace.
    const rebuilt = buildModelProject(mp.info, now);
    this.projects = this.projects.map((p) => (p.info.uid === projectUid ? rebuilt : p));
    this.byUid.set(projectUid, rebuilt);
    this.emitChange(projectUid, taskId);
  }

  private startWatching(): void {
    for (const mp of this.projects) {
      this.watchProject(mp);
    }
  }

  private watchProject(mp: ModelProject): void {
    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(mp.tasksDir, { persistent: false });
    } catch {
      // Missing tasks/ dir (no tasks yet) or a FileProvider path that refuses
      // to be watched — the periodic reconcile is the fallback for this
      // project; never crash the server over it.
      return;
    }
    watcher.on("error", () => {
      // FileProvider paths can throw mid-watch; drop this one watcher and let
      // the periodic reconcile keep this project current.
      try {
        watcher.close();
      } catch {
        // already gone
      }
    });
    watcher.on("change", (_eventType, filename) => {
      if (filename === null) return; // platform didn't supply one — periodic reconcile covers it
      const name = filename.toString();
      if (!name.endsWith(".md") || isOwnTempFile(name)) return;
      this.scheduleReconcile(mp.info.uid, name);
    });
    this.watchers.push(watcher);
  }

  private scheduleReconcile(uid: string, fileName: string): void {
    let pending = this.pendingByProject.get(uid);
    if (pending === undefined) this.pendingByProject.set(uid, (pending = new Set()));
    pending.add(fileName);

    const existing = this.debounceTimers.get(uid);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => this.flushReconcile(uid), WATCH_DEBOUNCE_MS);
    timer.unref?.();
    this.debounceTimers.set(uid, timer);
  }

  private flushReconcile(uid: string): void {
    this.debounceTimers.delete(uid);
    const pending = this.pendingByProject.get(uid);
    this.pendingByProject.delete(uid);
    if (pending === undefined || this.closed) return;
    const mp = this.byUid.get(uid);
    if (mp === undefined) return;
    const now = this.nowFn();
    for (const fileName of pending) {
      const prior = mp.files.get(fileName);
      const changed = reconcileModelFile(mp, fileName, now);
      if (!changed) continue; // self-echo or a duplicate event — nothing to tell subscribers
      const current = mp.files.get(fileName);
      // Prefer the post-reconcile id; fall back to the pre-reconcile id for a
      // delete (current is gone by then) so subscribers still learn WHICH
      // task's file changed rather than getting a bare project-only event.
      this.emitChange(uid, current?.task.id ?? prior?.task.id ?? null);
    }
  }

  private startPeriodicReconcile(): void {
    const timer = setInterval(() => {
      try {
        this.rebuildFull();
      } catch {
        // Never let a self-heal pass crash the server; the model just stays
        // as it was until the next tick or the next watch event.
      }
    }, PERIODIC_RECONCILE_MS);
    timer.unref?.();
    this.periodicHandle = timer;
  }

  /** Stop every watcher and timer. Idempotent; safe to call on server close. */
  close(): void {
    this.closed = true;
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        // already closed
      }
    }
    this.watchers = [];
    for (const t of this.debounceTimers.values()) clearTimeout(t);
    this.debounceTimers.clear();
    this.pendingByProject.clear();
    if (this.periodicHandle !== null) {
      clearInterval(this.periodicHandle);
      this.periodicHandle = null;
    }
    this.emitter.removeAllListeners();
  }
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
   * In-MEMORY scan cache TTL, in milliseconds, for `/api/automations` ONLY.
   * (`/api/scan` and `/api/task` are served from the warm read model — see the
   * "Warm read model" section above — which is always current and has no TTL
   * to configure.) The first `/api/automations` request builds the scan
   * (slow on a large workspace), caches it in process with the timestamp it
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
  /**
   * Hard-disable the mutation layer (decision-1). When true the server behaves
   * exactly like read-only v1: any POST is 405. Default: writes ENABLED, but
   * still gated to loopback connections + loopback Host + same-origin, so a
   * tailnet-served instance never accepts writes from a peer.
   */
  readOnly?: boolean;
  /** Injectable process launcher for /api/project/reveal (tests stub this so
   *  they never actually spawn `open`). Default: `defaultProcessOpener`. */
  processOpener?: ProcessOpener;
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

  /** Drop the cached scan so the next get() rebuilds against the live tree.
   *  Called after a mutation so a write is reflected immediately, not after TTL. */
  invalidate(): void {
    this.cached = null;
  }

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

// ---------------------------------------------------------------------------
// Write path (decision-1): a narrow, loopback-gated mutation layer. Every
// mutation routes through the tasks library (single writer) so record
// invariants — Final Summary for done, no done-with-open-children, valid
// transitions — hold by construction; the server never hand-edits a file.

/** POST paths the mutation layer serves, each 1:1 with a library verb. */
export const MUTATION_PATHS: ReadonlySet<string> = new Set([
  "/api/task/status",
  "/api/task/done",
  "/api/task/note",
]);

/** The reveal endpoint's path — spawns a process, so it rides the exact same
 *  loopback write-gate as MUTATION_PATHS even though it isn't a task verb. */
export const REVEAL_PATH = "/api/project/reveal";

const LOOPBACK_ADDRS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);

/**
 * A write is served ONLY from a genuine loopback connection with a loopback
 * Host header — independent of any `--allow-host` tailnet read config — plus a
 * same-origin (CSRF) check. Tailnet peers get reads, never writes.
 */
export function writeConnectionAllowed(req: http.IncomingMessage): boolean {
  const remote = req.socket.remoteAddress ?? "";
  if (!LOOPBACK_ADDRS.has(remote)) return false;
  if (!hostAllowed(req.headers.host, new Set(LOOPBACK_HOSTS))) return false;
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== "" && origin !== "null") {
    let host: string;
    try {
      host = new URL(origin).hostname.toLowerCase();
    } catch {
      return false;
    }
    if (!LOOPBACK_HOSTS.has(host)) return false;
  }
  const site = req.headers["sec-fetch-site"];
  if (typeof site === "string" && site !== "same-origin" && site !== "same-site" && site !== "none") {
    return false;
  }
  return true;
}

function readJsonBody(req: http.IncomingMessage, limitBytes = 64 * 1024): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new ConfigError("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (raw === "") {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {});
      } catch {
        reject(new ConfigError("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/** uid → absolute project root, via the same discovery the read path uses. */
function projectRootForUid(workspaceRoot: string, uid: string): string | null {
  const ws = openWorkspace(workspaceRoot);
  const info = discoverProjects(ws, { all: true }).find((p) => p.uid === uid);
  return info === undefined ? null : path.join(ws.root, info.relPath);
}

// ---------------------------------------------------------------------------
// Reveal (Finder / Obsidian): the React client cannot spawn processes, so this
// is a narrow, loopback-gated endpoint (reuses the mutation write-gate below)
// that resolves a client-supplied uid to a project root SERVER-SIDE and shells
// out to macOS `open` — never to a client-supplied path, and never to any
// argv beyond a single resolved path or URI.

export type RevealTarget = "finder" | "obsidian";

/** Injectable process launcher — tests stub this so they never actually
 *  launch Finder/Obsidian. Always called with exactly one argument: a
 *  server-resolved absolute path or an `obsidian://` URI built from one. */
export type ProcessOpener = (args: readonly string[]) => void;

/** Default opener: macOS `open`, detached, output discarded. */
export const defaultProcessOpener: ProcessOpener = (args) => {
  spawn("open", args as string[], { stdio: "ignore", detached: true }).unref();
};

export interface RevealOutcome {
  status: number;
  body: { ok: true } | { error: string };
}

/**
 * Resolve `uid` to an absolute project root and shell out to `open`.
 * - "finder": `open <root>`.
 * - "obsidian": only when `<root>/.obsidian` exists (else 422); percent-encodes
 *   the root into an `obsidian://open?path=` URI.
 * Non-macOS is a hard 501 — never spawns. Unknown uid is 404, never a path
 * traversal risk since the path always comes from server-side discovery.
 */
export function revealProject(
  workspaceRoot: string,
  uid: string,
  target: string,
  opener: ProcessOpener,
): RevealOutcome {
  if (process.platform !== "darwin") {
    return { status: 501, body: { error: "reveal is only supported on macOS" } };
  }
  if (target !== "finder" && target !== "obsidian") {
    return { status: 400, body: { error: `invalid target: ${target || "(none)"} (expected finder|obsidian)` } };
  }
  const root = projectRootForUid(workspaceRoot, uid);
  if (root === null) {
    return { status: 404, body: { error: `project not found: ${uid}` } };
  }
  if (target === "finder") {
    opener([root]);
    return { status: 200, body: { ok: true } };
  }
  // target === "obsidian"
  if (!fs.existsSync(path.join(root, ".obsidian"))) {
    return { status: 422, body: { error: "not an Obsidian vault (no .obsidian directory)" } };
  }
  opener([`obsidian://open?path=${encodeURIComponent(root)}`]);
  return { status: 200, body: { ok: true } };
}

/** Map a library error to the HTTP status. Order matters: the most specific
 *  subclass first (TaskStateError/NotFoundError/ConfigError all extend OwError). */
export function mutationStatus(err: unknown): number {
  if (err instanceof TaskStateError) return 422; // invariant refused (e.g. no Final Summary)
  if (err instanceof NotFoundError) return 404;
  if (err instanceof ConfigError) return 400;
  if (err instanceof OwError) return 400;
  return 500;
}

/**
 * Apply one mutation through the library, then return the updated task detail
 * so the UI can repaint the row without a full refetch.
 */
export function applyMutation(
  pathname: string,
  body: Record<string, unknown>,
  options: DashboardOptions,
  now: () => Date,
): TaskDetailResult {
  const project = typeof body["project"] === "string" ? (body["project"] as string) : "";
  const task = typeof body["task"] === "string" ? (body["task"] as string) : "";
  if (project === "" || task === "") throw new ConfigError("missing project or task");
  const root = projectRootForUid(options.workspaceRoot, project);
  if (root === null) throw new NotFoundError(`project not found: ${project}`);
  const nowD = now();
  const force = body["force"] === true;

  switch (pathname) {
    case "/api/task/status": {
      const status = typeof body["status"] === "string" ? (body["status"] as string) : "";
      if (!TASK_STATUSES.includes(status as TaskStatus)) {
        throw new ConfigError(`invalid status: ${status || "(none)"} (expected ${TASK_STATUSES.join("|")})`);
      }
      setStatus(root, task, status as TaskStatus, { force, now: nowD });
      break;
    }
    case "/api/task/done": {
      // "Check off" = write the required Final Summary, THEN close — one library
      // pair so the done invariant is satisfied rather than tripping a 422.
      const summary = typeof body["summary"] === "string" ? (body["summary"] as string) : "";
      if (summary.trim() === "") throw new ConfigError("a Final Summary is required to mark a task done");
      setFinalSummary(root, task, summary, { now: nowD });
      setStatus(root, task, "done", { force, now: nowD });
      break;
    }
    case "/api/task/note": {
      const text = typeof body["text"] === "string" ? (body["text"] as string) : "";
      const actor = typeof body["actor"] === "string" && body["actor"] !== "" ? (body["actor"] as string) : "dashboard";
      addNote(root, task, text, { now: nowD, actor });
      break;
    }
    default:
      throw new NotFoundError(`unknown mutation: ${pathname}`);
  }

  const ws = openWorkspace(options.workspaceRoot);
  const detail = taskDetail(ws, project, task, nowD);
  if (detail === null) throw new NotFoundError("task not found after mutation");
  return detail;
}

export function createDashboardServer(options: DashboardOptions): http.Server {
  const now = options.now ?? (() => new Date());
  const allowed = buildAllowedHosts(options.allowedHosts ?? []);
  const ttlMs = options.cacheTtlMs ?? 0;
  const useScanWorker = options.useScanWorker ?? options.now === undefined;

  // Phase 1b: /api/scan and /api/task are served from a warm, incrementally
  // maintained in-memory model — see the "Warm read model" section above.
  // This replaces the old invalidate-and-cold-rebuild ScanCache for tasks: the
  // model is built once here (the one unavoidable full walk) and after that
  // reads never re-walk the tree, and a write never invalidates more than the
  // one file it touched. `useScanWorker`'s child-process isolation existed to
  // keep a slow FileProvider walk off the main thread; the warm model makes
  // that walk a one-time startup cost instead of a per-request one, so it is
  // bypassed here (the worker path is retained for `/api/automations`, which
  // this phase does not touch).
  const model = new WarmModel(openWorkspace(options.workspaceRoot), now);

  // The automations view keeps the prior stale-while-revalidate posture: it is
  // a separate, read-only scan over the live tree (synced registries ×
  // manifests) that no mutation in this phase writes through to.
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

  // Batch 3: SSE live-updates. Read-only (same Host-header gate as every GET
  // below) — it exposes the warm model's already-current state, it doesn't
  // add any new write surface. Bounded connection count so a runaway client
  // (or a misbehaving proxy) can't exhaust file descriptors.
  const MAX_SSE_CLIENTS = 64;
  const SSE_KEEPALIVE_MS = 20_000;
  const sseClients = new Set<http.ServerResponse>();

  const server = http.createServer((req, res) => {
    if (!hostAllowed(req.headers.host, allowed)) {
      sendJson(res, 403, { error: "forbidden: host header not allowed" });
      return;
    }

    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;

    // Write path (decision-1): loopback-gated mutations, routed through the
    // library. Read requests may come from the tailnet; writes may not. The
    // reveal endpoint spawns a process rather than writing a task, but shares
    // the exact same gate — process-spawning is at least as sensitive as a
    // file write.
    if (req.method === "POST" && (MUTATION_PATHS.has(pathname) || pathname === REVEAL_PATH)) {
      if (options.readOnly === true) {
        res.setHeader("allow", "GET, HEAD");
        sendJson(res, 405, { error: "method not allowed: dashboard is read-only" });
        return;
      }
      if (!writeConnectionAllowed(req)) {
        sendJson(res, 403, { error: "forbidden: writes are allowed from localhost only" });
        return;
      }
      if (!/application\/json/i.test(req.headers["content-type"] ?? "")) {
        sendJson(res, 415, { error: "content-type must be application/json" });
        return;
      }
      void (async () => {
        try {
          const body = await readJsonBody(req);
          if (pathname === REVEAL_PATH) {
            const project = typeof body["project"] === "string" ? (body["project"] as string) : "";
            const target = typeof body["target"] === "string" ? (body["target"] as string) : "";
            const outcome = revealProject(options.workspaceRoot, project, target, options.processOpener ?? defaultProcessOpener);
            sendJson(res, outcome.status, outcome.body);
            return;
          }
          const detail = applyMutation(pathname, body, options, now);
          // Write-through (Phase 1b): fold ONLY the mutated task back into the
          // warm model — no invalidation, no re-walk. Subsequent /api/scan and
          // /api/task requests see the change immediately.
          model.writeThrough(detail.project.uid, detail.task.id);
          sendJson(res, 200, detail);
        } catch (err) {
          sendJson(res, mutationStatus(err), {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();
      return;
    }

    // Everything else is strictly read-only: any other non-read method is
    // rejected outright.
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("allow", "GET, HEAD, POST");
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }

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

    if (pathname === "/events") {
      if (req.method === "HEAD") {
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
        res.end();
        return;
      }
      if (sseClients.size >= MAX_SSE_CLIENTS) {
        sendJson(res, 503, { error: "too many /events connections" });
        return;
      }
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        // "close", not "keep-alive": this socket carries exactly one long-lived
        // streaming response and is never reused for a second request. Framed
        // this way, `res.end()` at shutdown tears the socket down immediately
        // instead of leaving it idle-but-open for the keep-alive timeout,
        // which is what lets `server.close()` below actually resolve promptly.
        connection: "close",
      });
      res.write(": connected\n\n");
      sseClients.add(res);

      const unsubscribe = model.onChange((event) => {
        try {
          res.write(`data: ${JSON.stringify({ type: "changed", project: event.project, task: event.task })}\n\n`);
        } catch {
          // Write raced a half-closed socket; the 'close' listener below cleans up.
        }
      });

      const keepalive = setInterval(() => {
        try {
          res.write(":\n\n"); // comment line — keeps intermediaries/proxies from timing out the connection
        } catch {
          // ditto
        }
      }, SSE_KEEPALIVE_MS);
      keepalive.unref?.();

      let cleaned = false;
      const cleanup = (): void => {
        if (cleaned) return;
        cleaned = true;
        clearInterval(keepalive);
        unsubscribe();
        sseClients.delete(res);
      };
      req.on("close", cleanup);
      res.on("close", cleanup);
      res.on("error", cleanup);
      return;
    }

    if (pathname === "/api/scan") {
      try {
        // Warm model: an in-memory assembly, never a disk walk.
        sendJson(res, 200, model.scan(false));
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    if (pathname === "/api/task") {
      const project = url.searchParams.get("project");
      const task = url.searchParams.get("task");
      if (project === null || task === null || project === "" || task === "") {
        sendJson(res, 400, { error: "missing project or task query parameter" });
        return;
      }
      try {
        const detail = model.taskDetail(project, task);
        if (detail === null) {
          sendJson(res, 404, { error: "task not found" });
        } else {
          sendJson(res, 200, detail);
        }
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    if (pathname === "/api/automations") {
      void (async () => {
        try {
        // Unlike /api/scan, this view isn't backed by the warm model — it
        // keeps the original stale-while-revalidate ScanCache.
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

  // Stop every watcher/timer the model owns and end every open /events stream
  // as soon as `close()` is CALLED — not on the 'close' EVENT, which only
  // fires once every connection has already ended, and an open SSE stream
  // never ends on its own. Overriding `close` (rather than `once("close", …)`)
  // means the streams get torn down before Node waits for them, so the
  // returned close() actually resolves instead of hanging forever on a live
  // dashboard client.
  const nativeClose = server.close.bind(server);
  server.close = ((callback?: (err?: Error) => void) => {
    model.close();
    for (const client of sseClients) client.end();
    sseClients.clear();
    return nativeClose(callback);
  }) as typeof server.close;
  return server;
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
