/**
 * Tasks primitive (PRD §4.4) — including reminders (hidden_until) and
 * recurrence (standing records, never spawned copies).
 *
 * Storage: flat `_project/tasks/`, one file per task, workflow state in
 * frontmatter, `archive/` subdir for retention. Filenames carry the ID:
 * `task-<n>[.<m>][-<machine>] - <slug>.md`. Hierarchy is derived from the
 * dotted ID alone — no parent field is ever written.
 *
 * All writes go through the lossless frontmatter codec + atomic writes.
 * This module throws OwError subclasses and never prints / exits (CLI maps).
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { ConfigError, ConflictError, NotFoundError, OwError } from "../lib/errors.js";
import { createExclusive, ensureDir, sha256Hex } from "../lib/fsatomic.js";
import {
  FrontmatterRecord,
  deleteFields,
  parseRecord,
  readRecord,
  serializeRecord,
  setBody,
  setFields,
  writeRecord,
} from "../lib/frontmatter.js";
import { ParsedId, formatId, idFromFilename, mintId, parseId } from "../lib/ids.js";
import { MachineStore } from "../lib/machine.js";
import { readProjectUid } from "../lib/workspace.js";

/** Invalid task-state transition (done-with-recur, missing Final Summary, …). */
export class TaskStateError extends OwError {
  constructor(message: string) {
    super("ESTATE", message, 1);
  }
}

export const TASK_STATUSES = ["todo", "doing", "waiting", "review", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const ARCHIVE_DIRNAME = "archive";

export function tasksDir(projectRoot: string): string {
  return path.join(projectRoot, "_project", "tasks");
}

export function tasksArchiveDir(projectRoot: string): string {
  return path.join(tasksDir(projectRoot), ARCHIVE_DIRNAME);
}

// ---------------------------------------------------------------------------
// Calendar arithmetic (plain {y,m,d} triples — no Date timezone hazards).
// hidden_until is a calendar date; "today" is the local calendar date.
// ---------------------------------------------------------------------------

interface Ymd {
  y: number;
  m: number; // 1–12
  d: number;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Forgiving read: accepts a YYYY-MM-DD prefix (ISO datetimes included). */
function parseDateOnly(text: string): Ymd | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s]|$)/.exec(text.trim());
  if (m === null) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  return { y, m: mo, d };
}

function ymdString(v: Ymd): string {
  const mm = String(v.m).padStart(2, "0");
  const dd = String(v.d).padStart(2, "0");
  return `${v.y}-${mm}-${dd}`;
}

function compareYmd(a: Ymd, b: Ymd): number {
  return a.y - b.y || a.m - b.m || a.d - b.d;
}

function utcMs(v: Ymd): number {
  return Date.UTC(v.y, v.m - 1, v.d);
}

function addDays(v: Ymd, n: number): Ymd {
  const t = new Date(utcMs(v) + n * 86_400_000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function diffDays(from: Ymd, to: Ymd): number {
  return Math.round((utcMs(to) - utcMs(from)) / 86_400_000);
}

/** Anchor-clamped: day-of-month restored from the anchor each step (no drift). */
function addMonthsClamped(anchor: Ymd, k: number): Ymd {
  const total = anchor.m - 1 + k;
  const y = anchor.y + Math.floor(total / 12);
  const m = ((total % 12) + 12) % 12 + 1;
  return { y, m, d: Math.min(anchor.d, daysInMonth(y, m)) };
}

function addYearsClamped(anchor: Ymd, k: number): Ymd {
  const y = anchor.y + k;
  return { y, m: anchor.m, d: Math.min(anchor.d, daysInMonth(y, anchor.m)) };
}

/** The local calendar date of `now` (the user's "today"). */
export function localDateOf(now: Date): string {
  return ymdString({ y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() });
}

function todayYmd(now: Date): Ymd {
  return { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() };
}

// ---------------------------------------------------------------------------
// Recurrence intervals (PRD §4.4): weekly | monthly | yearly | every-N-days
// ---------------------------------------------------------------------------

export interface RecurInterval {
  unit: "days" | "months" | "years";
  n: number;
}

export function parseInterval(text: string): RecurInterval | null {
  if (text === "weekly") return { unit: "days", n: 7 };
  if (text === "monthly") return { unit: "months", n: 1 };
  if (text === "yearly") return { unit: "years", n: 1 };
  const m = /^every-([1-9]\d*)-days$/.exec(text);
  if (m !== null) return { unit: "days", n: Number(m[1]) };
  return null;
}

/**
 * Schedule-anchored next occurrence: the smallest grid point
 * anchor + k*interval (k >= 0) STRICTLY after `today`. Fast-forwards past
 * any number of missed periods (no catch-up pile); an anchor already in the
 * future is itself the next occurrence (k = 0 — which is what makes repeated
 * occurrence completion idempotent-ish: the date does not run away).
 */
function nextOccurrenceYmd(anchor: Ymd, interval: RecurInterval, today: Ymd): Ymd {
  if (compareYmd(anchor, today) > 0) return anchor;
  if (interval.unit === "days") {
    const k = Math.floor(diffDays(anchor, today) / interval.n) + 1;
    return addDays(anchor, k * interval.n);
  }
  const step = interval.unit === "months" ? addMonthsClamped : addYearsClamped;
  // End-of-month anchor float: the stored anchor is hidden_until, which gets
  // CLAMPED when advanced into a short month (Jan 31 → Feb 28). To stay
  // schedule-anchored (no drift), an anchor on its month's last day is treated
  // as "day 31" so the next step restores the true anchor day (Feb 28 → Mar 31).
  // A virtual day like Feb 31 is safe: it only ever feeds Math.min() in the
  // clamped step functions. (Information-theoretic limit: a genuine 28th-of-Feb
  // monthly anchor is indistinguishable from a clamped 31st and floats too.)
  const base: Ymd =
    anchor.d === daysInMonth(anchor.y, anchor.m) ? { ...anchor, d: 31 } : anchor;
  // Estimate, then walk to the first strictly-future grid point. Clamping makes
  // the grid slightly non-arithmetic, so verify rather than trust the estimate.
  const span = interval.unit === "months" ? (today.y - anchor.y) * 12 + (today.m - anchor.m) : today.y - anchor.y;
  let k = Math.max(1, Math.floor(span / interval.n));
  while (k > 1 && compareYmd(step(base, (k - 1) * interval.n), today) > 0) k--;
  while (compareYmd(step(base, k * interval.n), today) <= 0) k++;
  return step(base, k * interval.n);
}

/** Exported for the doctor's "recurring task lagging > 1 interval" check. */
export function nextOccurrenceDate(anchorDate: string, interval: RecurInterval, todayDate: string): string {
  const anchor = parseDateOnly(anchorDate);
  const today = parseDateOnly(todayDate);
  if (anchor === null) throw new ConfigError(`unparseable anchor date: ${anchorDate}`);
  if (today === null) throw new ConfigError(`unparseable date: ${todayDate}`);
  return ymdString(nextOccurrenceYmd(anchor, interval, today));
}

// ---------------------------------------------------------------------------
// Record access
// ---------------------------------------------------------------------------

export interface Task {
  id: string;
  parts: number[];
  machineSuffix: string | null;
  path: string;
  filename: string;
  title: string;
  status: string;
  quadrant: string | null;
  labels: string[];
  hiddenUntil: string | null;
  recur: string | null;
  created: string | null;
  updated: string | null;
  /** Full raw frontmatter (unknown keys included). */
  data: Record<string, unknown>;
  body: string;
  /** YAML parse errors (forgiving read; mutations on such records throw). */
  errors: string[];
}

export interface TaskListEntry extends Task {
  /** True when hidden_until is in the future (only visible via --hidden/--all). */
  hidden: boolean;
  isSubtask: boolean;
  /** Computed rollup over ALL live descendants — display-only, never stored. */
  subtaskCount: number;
  subtaskDoneCount: number;
}

interface TaskFile {
  id: string;
  parsed: ParsedId;
  path: string;
  filename: string;
  rec: FrontmatterRecord;
  /**
   * sha256 of the exact bytes read from disk for `rec` (optimistic
   * concurrency, Phase 1a). touchAndWrite re-hashes the on-disk file
   * immediately before its atomic write and throws ConflictError on mismatch
   * rather than clobbering a concurrent writer (the CLI and Obsidian both
   * write task files).
   */
  contentHash: string;
}

function scanTaskFiles(projectRoot: string): TaskFile[] {
  const dir = tasksDir(projectRoot);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: TaskFile[] = [];
  for (const entry of entries) {
    // Subdirectories (archive/ included) never feed live views; no recursion,
    // so nested-project boundaries are never crossed either.
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const parsed = idFromFilename(entry.name);
    if (parsed === null || parsed.prefix !== "task") continue;
    const filePath = path.join(dir, entry.name);
    const rec = readRecord(filePath);
    out.push({
      id: formatId("task", parsed.parts, parsed.machineSuffix),
      parsed,
      path: filePath,
      filename: entry.name,
      rec,
      contentHash: sha256Hex(rec.originalText),
    });
  }
  return out;
}

function compareTaskFiles(a: TaskFile, b: TaskFile): number {
  const len = Math.max(a.parsed.parts.length, b.parsed.parts.length);
  for (let i = 0; i < len; i++) {
    const av = a.parsed.parts[i] ?? -1;
    const bv = b.parsed.parts[i] ?? -1;
    if (av !== bv) return av - bv;
  }
  return (a.parsed.machineSuffix ?? "").localeCompare(b.parsed.machineSuffix ?? "");
}

/** Accepts "36", "36.7", "task-36", "task-7-mini"; canonicalizes or throws. */
export function normalizeTaskRef(ref: string): string {
  const trimmed = ref.trim();
  let parsed = parseId(trimmed);
  if (parsed === null) parsed = parseId(`task-${trimmed}`);
  if (parsed === null || parsed.prefix !== "task") {
    throw new ConfigError(`not a task reference: ${ref}`);
  }
  return formatId("task", parsed.parts, parsed.machineSuffix);
}

function getTaskFile(projectRoot: string, ref: string): TaskFile {
  const id = normalizeTaskRef(ref);
  const found = scanTaskFiles(projectRoot).find((t) => t.id === id);
  if (found === undefined) throw new NotFoundError(`task not found: ${id}`);
  return found;
}

function toTask(tf: TaskFile): Task {
  const d = tf.rec.data;
  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  return {
    id: tf.id,
    parts: tf.parsed.parts,
    machineSuffix: tf.parsed.machineSuffix,
    path: tf.path,
    filename: tf.filename,
    title: typeof d["title"] === "string" ? (d["title"] as string) : "",
    status: typeof d["status"] === "string" ? (d["status"] as string) : "",
    quadrant: str(d["quadrant"]),
    labels: Array.isArray(d["labels"]) ? (d["labels"] as unknown[]).map(String) : [],
    hiddenUntil: str(d["hidden_until"]),
    recur: str(d["recur"]),
    created: d["created"] != null ? String(d["created"]) : null,
    updated: d["updated"] != null ? String(d["updated"]) : null,
    data: d,
    body: tf.rec.body,
    errors: tf.rec.errors,
  };
}

export function getTask(projectRoot: string, ref: string): Task {
  return toTask(getTaskFile(projectRoot, ref));
}

/**
 * Suffix-tolerant descendant test (matching the doctor's parentage
 * semantics): hierarchy is the numeric path; a machine-suffixed child
 * (task-1.2-mini, minted off-canonical under plain task-1) is still task-1's
 * descendant — rollups, the done-with-open-children guard, and archive
 * subtree moves must all see it. A suffixed ANCESTOR only owns same-suffix
 * children (mintId composes the parent's suffix into every child it mints).
 */
function isDescendantOf(candidate: ParsedId, ancestor: ParsedId): boolean {
  if (candidate.prefix !== ancestor.prefix) return false;
  if (ancestor.machineSuffix !== null && candidate.machineSuffix !== ancestor.machineSuffix) {
    return false;
  }
  if (candidate.parts.length <= ancestor.parts.length) return false;
  return ancestor.parts.every((p, i) => candidate.parts[i] === p);
}

function isHiddenAt(tf: TaskFile, today: Ymd): boolean {
  const raw = tf.rec.data["hidden_until"];
  if (typeof raw !== "string" || raw.length === 0) return false;
  const until = parseDateOnly(raw);
  if (until === null) return false; // unparseable → visible; doctor's to flag
  return compareYmd(until, today) > 0;
}

function isDoneStatus(status: unknown): boolean {
  return typeof status === "string" && status.toLowerCase() === "done";
}

// ---------------------------------------------------------------------------
// Timestamps & validation
// ---------------------------------------------------------------------------

/** `2026-06-17T09:00Z` — the PRD's Log-line timestamp shape. */
function isoMinute(now: Date): string {
  return now.toISOString().slice(0, 16) + "Z";
}

/** `2026-06-10T14:02:00Z` — the `updated:` field shape. */
function isoSecond(now: Date): string {
  return now.toISOString().slice(0, 19) + "Z";
}

function validateQuadrant(q: string): void {
  if (!/^q[1-4]$/.test(q)) throw new ConfigError(`invalid quadrant: ${q} (expected q1–q4)`);
}

function validateInterval(text: string): RecurInterval {
  const parsed = parseInterval(text);
  if (parsed === null) {
    throw new ConfigError(`malformed recur interval: ${text} (expected weekly|monthly|yearly|every-N-days)`);
  }
  return parsed;
}

function validateDateInput(text: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || parseDateOnly(text) === null) {
    throw new ConfigError(`invalid ${field} date: ${text} (expected YYYY-MM-DD)`);
  }
  return text;
}

// ---------------------------------------------------------------------------
// Body sections
// ---------------------------------------------------------------------------

const TEMPLATE_BODY = `## Description

## Acceptance Criteria

- [ ]

## Why this matters

## Implementation Plan

## Implementation Notes
`;

function findHeading(body: string, title: string): { start: number; contentStart: number } | null {
  const re = new RegExp(`^##[ \\t]+${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*\\r?$`, "m");
  const m = re.exec(body);
  if (m === null) return null;
  const lineEnd = body.indexOf("\n", m.index);
  return { start: m.index, contentStart: lineEnd === -1 ? body.length : lineEnd + 1 };
}

/**
 * True when ANY `## Final Summary` heading has non-blank content under it.
 * Humans and agents hand-edit: an abandoned empty heading earlier in the body
 * must not mask a filled one appended later.
 */
export function hasFinalSummary(body: string): boolean {
  const re = /^##[ \t]+Final Summary[ \t]*\r?$/gm;
  for (let m = re.exec(body); m !== null; m = re.exec(body)) {
    const lineEnd = body.indexOf("\n", m.index);
    const contentStart = lineEnd === -1 ? body.length : lineEnd + 1;
    const rest = body.slice(contentStart);
    const next = rest.search(/^#{1,6}[ \t]/m);
    const content = next === -1 ? rest : rest.slice(0, next);
    if (content.trim().length > 0) return true;
  }
  return false;
}

/** Append one bullet line at the end of the `## Log` section (created on demand). */
function appendLogLine(rec: FrontmatterRecord, line: string): void {
  const eol = rec.eol;
  const body = rec.body;
  const h = findHeading(body, "Log");
  if (h === null) {
    let prefix = body;
    if (prefix.length > 0 && !prefix.endsWith("\n")) prefix += eol;
    if (prefix.length > 0) prefix += eol; // blank line before the new heading
    setBody(rec, `${prefix}## Log${eol}${eol}${line}${eol}`);
    return;
  }
  const rest = body.slice(h.contentStart);
  const next = rest.search(/^#{1,6}[ \t]/m);
  const sectionEnd = next === -1 ? body.length : h.contentStart + next;
  const section = body.slice(h.contentStart, sectionEnd).replace(/\s+$/, "");
  const after = body.slice(sectionEnd);
  const newSection =
    (section.length > 0 ? section + eol : eol) + line + eol + (after.length > 0 ? eol : "");
  setBody(rec, body.slice(0, h.contentStart) + newSection + after);
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

export function slugFromTitle(title: string): string {
  const slug = title
    .replace(/[/\\:]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "");
  return slug.length > 0 ? slug : "task";
}

export interface CreateTaskOptions {
  title: string;
  /** Parent task ref — mints a dotted child ID. Parentage lives in the ID alone. */
  parent?: string;
  quadrant?: string;
  labels?: string[];
  hiddenUntil?: string;
  recur?: string;
  status?: TaskStatus;
  /** Replaces the standard section template when provided. */
  body?: string;
  /** For off-laptop minting (e.g. "mini"): task-7-mini. */
  machineSuffix?: string;
  /** Extra dirs feeding the next-ID probe (the canonical tasks dir, from a worktree). */
  extraTreePaths?: string[];
  now?: Date;
}

export function createTask(
  projectRoot: string,
  store: MachineStore,
  options: CreateTaskOptions,
): Task {
  const title = options.title.trim();
  if (title.length === 0) throw new ConfigError("task title must not be empty");
  if (options.quadrant !== undefined) validateQuadrant(options.quadrant);
  if (options.recur !== undefined) validateInterval(options.recur);
  if (options.hiddenUntil !== undefined) validateDateInput(options.hiddenUntil, "hidden_until");
  const status = options.status ?? "todo";
  if (!TASK_STATUSES.includes(status)) throw new ConfigError(`invalid status: ${status}`);

  const projectUid = readProjectUid(projectRoot);
  if (projectUid === null) {
    throw new ConfigError(`not a project (no _project/id): ${projectRoot}`);
  }

  const dir = tasksDir(projectRoot);
  ensureDir(dir);

  let parentId: string | undefined;
  if (options.parent !== undefined) {
    parentId = getTaskFile(projectRoot, options.parent).id; // NotFoundError if absent
  }

  const now = options.now ?? new Date();
  const slug = slugFromTitle(title);
  let createdPath = "";

  // The archive dir feeds the probe too: an archived task-50 must never be
  // re-minted (IDs are citations; they never churn).
  const id = mintId(store, projectUid, {
    prefix: "task",
    treePaths: [dir, tasksArchiveDir(projectRoot), ...(options.extraTreePaths ?? [])],
    parentId,
    machineSuffix: options.machineSuffix,
    claim: (mintedId) => {
      const rec = parseRecord("");
      const fields: Record<string, unknown> = { id: mintedId, title, status };
      if (options.quadrant !== undefined) fields["quadrant"] = options.quadrant;
      if (options.labels !== undefined && options.labels.length > 0) {
        fields["labels"] = options.labels;
      }
      fields["hidden_until"] = options.hiddenUntil ?? null;
      if (options.recur !== undefined) fields["recur"] = options.recur;
      fields["created"] = localDateOf(now);
      fields["updated"] = isoSecond(now);
      setFields(rec, fields);
      setBody(rec, options.body ?? TEMPLATE_BODY);
      createdPath = path.join(dir, `${mintedId} - ${slug}.md`);
      createExclusive(createdPath, serializeRecord(rec));
    },
  });

  const createdRec = readRecord(createdPath);
  return toTask({
    id,
    parsed: parseId(id) as ParsedId,
    path: createdPath,
    filename: path.basename(createdPath),
    rec: createdRec,
    contentHash: sha256Hex(createdRec.originalText),
  });
}

// ---------------------------------------------------------------------------
// list / show
// ---------------------------------------------------------------------------

export interface ListTasksOptions {
  /** Expand subtasks (default: top-level only with rollups). */
  subtasks?: boolean;
  /** Include tasks whose hidden_until is in the future, tagged. */
  hidden?: boolean;
  /** Everything live: subtasks + hidden. The archive never loads. */
  all?: boolean;
  now?: Date;
}

export function listTasks(projectRoot: string, options: ListTasksOptions = {}): TaskListEntry[] {
  const includeSubtasks = options.subtasks === true || options.all === true;
  const includeHidden = options.hidden === true || options.all === true;
  const today = todayYmd(options.now ?? new Date());
  const files = scanTaskFiles(projectRoot).sort(compareTaskFiles);

  const out: TaskListEntry[] = [];
  for (const tf of files) {
    const isSubtask = tf.parsed.parts.length > 1;
    if (isSubtask && !includeSubtasks) continue;
    const hidden = isHiddenAt(tf, today);
    if (hidden && !includeHidden) continue;
    const descendants = files.filter((other) => isDescendantOf(other.parsed, tf.parsed));
    out.push({
      ...toTask(tf),
      hidden,
      isSubtask,
      subtaskCount: descendants.length,
      subtaskDoneCount: descendants.filter((d) => isDoneStatus(d.rec.data["status"])).length,
    });
  }
  return out;
}

export interface TaskSubtree {
  task: Task;
  /** All live descendants, any depth, ID-sorted. */
  subtree: Task[];
}

export function showTask(projectRoot: string, ref: string): TaskSubtree {
  const tf = getTaskFile(projectRoot, ref);
  const subtree = scanTaskFiles(projectRoot)
    .filter((other) => isDescendantOf(other.parsed, tf.parsed))
    .sort(compareTaskFiles)
    .map(toTask);
  return { task: toTask(tf), subtree };
}

// ---------------------------------------------------------------------------
// mutations
// ---------------------------------------------------------------------------

/**
 * Optimistic-concurrency guard (Phase 1a): re-read the on-disk file right
 * before the write and compare it against the hash captured when `tf` was
 * read. A mismatch means another writer (the CLI, Obsidian, …) touched the
 * file in the window between our read and our write; we must not clobber
 * it, so this throws instead of proceeding. A file that vanished entirely
 * counts as "changed underneath us" too.
 */
function assertUnchangedOnDisk(tf: TaskFile): void {
  let current: string;
  try {
    current = fs.readFileSync(tf.path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ConflictError(`${tf.id}: file changed on disk since it was read — retry`);
    }
    throw err;
  }
  if (sha256Hex(current) !== tf.contentHash) {
    throw new ConflictError(`${tf.id}: file changed on disk since it was read — retry`);
  }
}

function touchAndWrite(tf: TaskFile, updates: Record<string, unknown>, now: Date): Task {
  setFields(tf.rec, { ...updates, updated: isoSecond(now) });
  assertUnchangedOnDisk(tf);
  writeRecord(tf.path, tf.rec);
  return toTask(tf);
}

/**
 * Set one frontmatter field. `id` is immutable and `status` must go through
 * setStatus (the transition guards live there). Known fields are validated;
 * unknown keys pass through (forgiving schema, P12). `value: null` clears
 * optional fields (`recur` is deleted outright — that's `recur off`).
 */
export function editField(
  projectRoot: string,
  ref: string,
  field: string,
  value: unknown,
  options: { now?: Date } = {},
): Task {
  const tf = getTaskFile(projectRoot, ref);
  const now = options.now ?? new Date();
  if (field === "id") throw new ConfigError("id is immutable (it is also the filename)");
  if (field === "status") throw new ConfigError("use the status verb — transitions are guarded");
  if (field === "updated") throw new ConfigError("updated is maintained by the tool");
  if (field === "quadrant" && value !== null) validateQuadrant(String(value));
  if (field === "recur") {
    if (value === null || value === "off") return setRecur(projectRoot, ref, "off", options);
    validateInterval(String(value));
  }
  if (field === "hidden_until" && value !== null) validateDateInput(String(value), "hidden_until");
  if (field === "labels" && value !== null) {
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
      throw new ConfigError("labels must be an array of strings");
    }
  }
  return touchAndWrite(tf, { [field]: value }, now);
}

/**
 * Append `text` under the task's `## Final Summary` section (created on demand),
 * so a subsequent `setStatus(…, "done")` satisfies the non-empty-summary
 * invariant. Body-writing lives in the library (single writer) so the dashboard
 * "check off" path never hand-edits the file. Appends a paragraph; never
 * rewrites prior summary content.
 */
export function setFinalSummary(
  projectRoot: string,
  ref: string,
  text: string,
  options: { now?: Date } = {},
): Task {
  const summary = text.trim();
  if (summary.length === 0) throw new ConfigError("final summary text must not be empty");
  const tf = getTaskFile(projectRoot, ref);
  const now = options.now ?? new Date();
  appendFinalSummary(tf.rec, summary);
  return touchAndWrite(tf, {}, now);
}

/** Append `text` under the `## Final Summary` heading (created on demand). */
function appendFinalSummary(rec: FrontmatterRecord, text: string): void {
  const eol = rec.eol;
  const body = rec.body;
  const h = findHeading(body, "Final Summary");
  if (h === null) {
    let prefix = body;
    if (prefix.length > 0 && !prefix.endsWith("\n")) prefix += eol;
    if (prefix.length > 0) prefix += eol; // blank line before the new heading
    setBody(rec, `${prefix}## Final Summary${eol}${eol}${text}${eol}`);
    return;
  }
  const rest = body.slice(h.contentStart);
  const next = rest.search(/^#{1,6}[ \t]/m);
  const sectionEnd = next === -1 ? body.length : h.contentStart + next;
  const section = body.slice(h.contentStart, sectionEnd).replace(/\s+$/, "");
  const after = body.slice(sectionEnd);
  const newSection =
    (section.length > 0 ? section + eol + eol : eol) + text + eol + (after.length > 0 ? eol : "");
  setBody(rec, body.slice(0, h.contentStart) + newSection + after);
}

/** Append a timestamped note line to the `## Log` body section. */
export function addNote(
  projectRoot: string,
  ref: string,
  text: string,
  options: { now?: Date; actor?: string } = {},
): Task {
  const note = text.trim();
  if (note.length === 0) throw new ConfigError("note text must not be empty");
  const tf = getTaskFile(projectRoot, ref);
  const now = options.now ?? new Date();
  const actor = options.actor;
  const line = actor !== undefined ? `- ${isoMinute(now)} — ${note} (${actor})` : `- ${isoMinute(now)} — ${note}`;
  appendLogLine(tf.rec, line);
  return touchAndWrite(tf, {}, now);
}

export interface SetStatusOptions {
  /** Allow closing a parent that still has open descendants. */
  force?: boolean;
  now?: Date;
}

export function setStatus(
  projectRoot: string,
  ref: string,
  status: TaskStatus,
  options: SetStatusOptions = {},
): Task {
  if (!TASK_STATUSES.includes(status)) {
    throw new ConfigError(`invalid status: ${status} (expected ${TASK_STATUSES.join("|")})`);
  }
  const tf = getTaskFile(projectRoot, ref);
  const now = options.now ?? new Date();

  if (status === "done") {
    const recur = tf.rec.data["recur"];
    if (typeof recur === "string" && recur.length > 0) {
      throw new TaskStateError(
        `${tf.id} is recurring (${recur}): \`done\` completes the occurrence ` +
          `(completeOccurrence); to close it for good, retire the recurrence first (recur ${tf.id} off)`,
      );
    }
    if (!hasFinalSummary(tf.rec.body)) {
      throw new TaskStateError(
        `${tf.id} cannot be done without a non-empty "## Final Summary" section`,
      );
    }
    const open = scanTaskFiles(projectRoot)
      .filter((other) => isDescendantOf(other.parsed, tf.parsed))
      .filter((other) => !isDoneStatus(other.rec.data["status"]));
    if (open.length > 0 && options.force !== true) {
      throw new TaskStateError(
        `${tf.id} has open subtasks (${open.map((o) => o.id).join(", ")}); close them or pass force`,
      );
    }
  }

  return touchAndWrite(tf, { status }, now);
}

export interface CompleteOccurrenceResult {
  task: Task;
  /** The new hidden_until (the next scheduled occurrence). */
  next: string;
}

/**
 * Complete one occurrence of a recurring task (PRD §4.4): append the
 * completion line to `## Log` and advance hidden_until to the next grid point
 * strictly in the future — schedule-anchored, fast-forwarding past any number
 * of missed periods. `status` is never touched.
 */
export function completeOccurrence(
  projectRoot: string,
  ref: string,
  options: { now?: Date; actor?: string } = {},
): CompleteOccurrenceResult {
  const tf = getTaskFile(projectRoot, ref);
  const recur = tf.rec.data["recur"];
  if (typeof recur !== "string" || recur.length === 0) {
    throw new TaskStateError(`${tf.id} is not recurring; close it with status done instead`);
  }
  const interval = validateInterval(recur);
  const now = options.now ?? new Date();
  const today = todayYmd(now);

  // Anchor = the standing schedule (hidden_until); a recurring task born
  // without one anchors on its created date, falling back to today.
  const rawAnchor =
    (typeof tf.rec.data["hidden_until"] === "string" ? (tf.rec.data["hidden_until"] as string) : null) ??
    (tf.rec.data["created"] != null ? String(tf.rec.data["created"]) : null);
  const anchor = (rawAnchor !== null ? parseDateOnly(rawAnchor) : null) ?? today;

  const next = ymdString(nextOccurrenceYmd(anchor, interval, today));
  const actor = options.actor ?? process.env["OW_ACTOR"] ?? process.env["USER"] ?? "unknown";
  appendLogLine(tf.rec, `- ${isoMinute(now)} — completed (${actor}); next ${next}`);
  const task = touchAndWrite(tf, { hidden_until: next }, now);
  return { task, next };
}

/** Hide a task from default listings until a date (the tickler verb). */
export function hideTask(
  projectRoot: string,
  ref: string,
  until: string,
  options: { now?: Date } = {},
): Task {
  validateDateInput(until, "hidden_until");
  const tf = getTaskFile(projectRoot, ref);
  return touchAndWrite(tf, { hidden_until: until }, options.now ?? new Date());
}

/** Set or retire (`"off"`) the recurrence interval. */
export function setRecur(
  projectRoot: string,
  ref: string,
  intervalOrOff: string,
  options: { now?: Date } = {},
): Task {
  const tf = getTaskFile(projectRoot, ref);
  const now = options.now ?? new Date();
  if (intervalOrOff === "off") {
    deleteFields(tf.rec, ["recur"]);
    return touchAndWrite(tf, {}, now);
  }
  validateInterval(intervalOrOff);
  return touchAndWrite(tf, { recur: intervalOrOff }, now);
}

// ---------------------------------------------------------------------------
// Body editing (DECISION-9): the dashboard's narrow body editor + interactive
// Acceptance-Criteria checkboxes. Task records only — routed through the same
// touchAndWrite (atomic write + optimistic-concurrency guard) as every other
// mutation, plus an EXPLICIT hash guard checked against the hash the caller
// last loaded (not just the read-to-write window assertUnchangedOnDisk covers)
// so a client editing a stale copy is refused rather than clobbering a
// concurrent edit.
// ---------------------------------------------------------------------------

/** Thrown when `expectedHash` is given and doesn't match the file as it
 *  stands right now — the client loaded a copy that's since changed. */
function assertExpectedHash(tf: TaskFile, expectedHash: string | undefined): void {
  if (expectedHash === undefined) return;
  if (expectedHash !== tf.contentHash) {
    throw new ConflictError(`${tf.id}: changed on disk since it was loaded — reload and retry`);
  }
}

export interface SetTaskBodyOptions {
  /** Hash the caller last loaded (from the /api/task response); a mismatch
   *  means the file changed underneath them, so this throws ConflictError
   *  rather than clobbering the concurrent edit. */
  expectedHash?: string;
  now?: Date;
}

/**
 * Replace a task's ENTIRE body, leaving frontmatter FIELDS untouched (only
 * the body changes) apart from the `updated:` timestamp that every
 * touchAndWrite call bumps — this is not a literal byte-for-byte write of
 * the frontmatter block. Faithful otherwise: writes exactly the body it's
 * given — the caller (the dashboard's plain-textarea editor) is responsible
 * for seeding the textarea with the full current body so a user's edit never
 * silently drops `## Final Summary` / `## Log` content.
 */
export function setTaskBody(
  projectRoot: string,
  ref: string,
  newBody: string,
  options: SetTaskBodyOptions = {},
): Task {
  const tf = getTaskFile(projectRoot, ref);
  assertExpectedHash(tf, options.expectedHash);
  const now = options.now ?? new Date();
  setBody(tf.rec, newBody);
  return touchAndWrite(tf, {}, now);
}

/** One `- [ ]` / `- [x]` (or `*`) checklist line found in a task's body. */
interface ChecklistItem {
  /** Offset of the single bracket-content char (` ` or `x`/`X`) to flip. */
  markerOffset: number;
  checked: boolean;
  /** Trimmed line text after the checkbox marker — the `text` match key. */
  text: string;
}

/** Matches ANY markdown checkbox list line (Acceptance Criteria is the only
 *  section the template puts these under, but the scan isn't section-scoped
 *  — it flips whichever single line the caller identifies). */
const CHECKLIST_ITEM_RE = /^([ \t]*[-*][ \t]+\[)([ xX])(\][ \t]*)(.*)$/gm;

function findChecklistItems(body: string): ChecklistItem[] {
  const out: ChecklistItem[] = [];
  for (const m of body.matchAll(CHECKLIST_ITEM_RE)) {
    const prefix = m[1] ?? "";
    const marker = m[2] ?? " ";
    const rest = m[4] ?? "";
    const markerOffset = (m.index ?? 0) + prefix.length;
    out.push({ markerOffset, checked: marker.toLowerCase() === "x", text: rest.trim() });
  }
  return out;
}

export interface ToggleChecklistItemOptions {
  /** Match by 0-based occurrence order among checklist lines in the body. */
  index?: number;
  /** Match by the (trimmed) text after the checkbox marker — first hit wins. */
  text?: string;
  checked: boolean;
  expectedHash?: string;
  now?: Date;
}

/**
 * Flip exactly one `- [ ]` <-> `- [x]` line in the body (surgical: only the
 * one marker character changes, every other byte of the body is untouched).
 * Identify the line by `index` (occurrence order) or `text` (trimmed line
 * content); exactly one of the two should be given. If a caller ever passes
 * BOTH, `index` wins and `text` is ignored — the dashboard client only ever
 * sends `index`, so this hasn't mattered in practice, but it's explicit here
 * in case `text`-keyed toggles are exposed to another caller later.
 */
export function toggleChecklistItem(
  projectRoot: string,
  ref: string,
  options: ToggleChecklistItemOptions,
): Task {
  if (options.index === undefined && options.text === undefined) {
    throw new ConfigError("toggleChecklistItem requires index or text");
  }
  const tf = getTaskFile(projectRoot, ref);
  assertExpectedHash(tf, options.expectedHash);
  const items = findChecklistItems(tf.rec.body);
  // index takes precedence over text when both are given — see docstring.
  const target =
    options.index !== undefined ? items[options.index] : items.find((it) => it.text === options.text);
  if (target === undefined) {
    throw new NotFoundError(`${tf.id}: no matching checklist item`);
  }
  const now = options.now ?? new Date();
  const body = tf.rec.body;
  const marker = options.checked ? "x" : " ";
  const newBody = body.slice(0, target.markerOffset) + marker + body.slice(target.markerOffset + 1);
  setBody(tf.rec, newBody);
  return touchAndWrite(tf, {}, now);
}

/**
 * Move a task to `tasks/archive/` (retention, committed). The whole live
 * subtree moves with it — archiving a parent must not strand dotted-ID
 * orphans in the live dir. Returns the new paths.
 *
 * This is unavoidably a multi-rename sequence (no cross-file transactions,
 * PRD §5.3), so order it for crash-recoverability: children move DEEPEST
 * FIRST and the parent moves LAST. Any interrupted prefix of that sequence
 * leaves the parent (and every un-moved ancestor) live, so re-running
 * `task archive <parent>` completes the move; parent-first would strand live
 * orphans whose parent is already archived — unfixable by re-running, since
 * the live scan can no longer find the parent ref.
 */
export function archiveTask(projectRoot: string, ref: string): string[] {
  const tf = getTaskFile(projectRoot, ref);
  const subtree = scanTaskFiles(projectRoot).filter((other) =>
    isDescendantOf(other.parsed, tf.parsed),
  );
  subtree.sort((a, b) => b.parsed.parts.length - a.parsed.parts.length); // deepest first
  const moves = [...subtree, tf]; // parent last
  const archive = tasksArchiveDir(projectRoot);
  ensureDir(archive);
  for (const m of moves) {
    const target = path.join(archive, m.filename);
    if (fs.existsSync(target)) {
      throw new ConflictError(`archive target already exists: ${target}`);
    }
  }
  const newPaths: string[] = [];
  for (const m of moves) {
    const target = path.join(archive, m.filename);
    fs.renameSync(m.path, target); // same dir tree → same filesystem → atomic
    newPaths.push(target);
  }
  return newPaths;
}
