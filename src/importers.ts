/**
 * Importers — `projects import legacy` (PRD §11 step 4; state fidelity §4.4;
 * forum target schema §4.6).
 *
 * Dry-run-first: `planLegacyImport` builds a plan object (one action per
 * record, rendered as per-record audit lines); `applyLegacyImport` executes
 * exactly that plan — every write is precomputed at plan time and lands via
 * createExclusive, so apply never improvises.
 *
 * What gets imported:
 *  (a) legacy Backlog.md tasks → native tasks (status mapped, parent_task_id
 *      normalized into the dotted ID, bodies byte-preserved, unknown
 *      frontmatter keys preserved; archived legacy records → tasks/archive/).
 *  (b) legacy reminders → tasks (surface_on → hidden_until; surfaced →
 *      live todo; dismissed → archived task keeping the closing-reasoning
 *      log line; promoted → archived with a cross-ref; fired_at folded into
 *      a `## Log` line). New IDs are minted ABOVE the legacy max, under the
 *      machine-store mint lock (the same seam every other minter uses).
 *  (c) dirchannels → forum (channels flatten into thread slugs
 *      `<date>--<channel>--<slug>`; meta.json → thread.md; every
 *      messages.jsonl line → one immutable maildir message file). pty logs,
 *      SQLite stores, tokens, bridge state: listed as skipped, left untouched.
 *
 * Idempotency is a hard requirement: a second apply produces zero changes —
 * tasks are keyed by their (preserved) IDs, reminder-born tasks by an
 * `imported_from:` frontmatter key, forum threads/messages by their
 * deterministic names (message rand4 is a hash of the legacy message ULID).
 * An ID hit must additionally be VERIFIED as this import (same ID-carrying
 * filename or byte-equal content); a collision with a pre-existing native
 * task is a plan error, never a silent drop. Two sources planning the same
 * target in one run are deduped when byte-identical, errored otherwise.
 *
 * Legacy sources are read from the live `_tasks/` / `_dirchannel/` dirs when
 * present, else from the newest preserved `_project/archive/legacy-imports/`
 * snapshot. Sources are never modified.
 *
 * OUT OF SCOPE (manual migrating-agent work, PRD §11 step 4): the v0.2
 * review records → tasks and the finance proposals re-home. When legacy
 * `_project/reviews/` / `_project/proposals/` dirs exist they are listed as
 * audited skips so the migration checklist cannot miss them.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { ConfigError } from "./lib/errors.js";
import { createExclusive, ensureDir } from "./lib/fsatomic.js";
import {
  deleteFields,
  parseRecord,
  readRecord,
  serializeRecord,
  setBody,
  setFields,
} from "./lib/frontmatter.js";
import { formatId, idFromFilename, parseId, withMintLock } from "./lib/ids.js";
import { MachineStore } from "./lib/machine.js";
import { readProjectUid } from "./lib/workspace.js";
import { slugFromTitle, tasksArchiveDir, tasksDir } from "./primitives/tasks.js";

// ---------------------------------------------------------------------------
// Plan model
// ---------------------------------------------------------------------------

export type ImportActionKind =
  | "task" // legacy Backlog.md task → native task record
  | "reminder" // legacy reminder → native task record (new minted ID)
  | "forum-thread" // dirchannel thread meta.json → forum thread.md
  | "forum-message" // one messages.jsonl line → one maildir message file
  | "exists" // target already present — idempotent no-op
  | "skip"; // deliberately not imported, left untouched

export interface ImportAction {
  kind: ImportActionKind;
  /** Source path, relative to the project root. */
  source: string;
  /** Target path, relative to the project root (null for pure skips). */
  target: string | null;
  /** Human audit note, e.g. `status In Progress → doing`. */
  note: string;
  /** The exact bytes apply will write (absent for skip/exists). */
  write?: { content: string };
}

export interface LegacySources {
  /** The legacy `_tasks/` root (live or preserved archive), or null. */
  tasksRoot: string | null;
  /** The legacy `_dirchannel/` root (live or preserved archive), or null. */
  dirchannelRoot: string | null;
}

export interface ImportPlan {
  projectRoot: string;
  uid: string;
  sources: LegacySources;
  actions: ImportAction[];
  /** Plan-level errors. A plan with errors must not be applied. */
  errors: string[];
  counts: {
    tasks: number;
    reminders: number;
    threads: number;
    messages: number;
    skipped: number;
    existing: number;
  };
}

export interface ApplyResult {
  plan: ImportPlan;
  /** Absolute paths of every file written, in write order. */
  written: string[];
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function rel(projectRoot: string, abs: string): string {
  return path.relative(projectRoot, abs);
}

function listDirNames(dir: string): string[] {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Locate the legacy source dirs: the live `<root>/<name>` wins; otherwise the
 * newest `_project/archive/legacy-imports/<stamp>/<name>` (stamps sort
 * lexically — they are ISO timestamps).
 */
export function findLegacySources(projectRoot: string): LegacySources {
  const find = (name: string): string | null => {
    const live = path.join(projectRoot, name);
    if (isDir(live)) return live;
    const importsDir = path.join(projectRoot, "_project", "archive", "legacy-imports");
    const stamps = listDirNames(importsDir)
      .filter((d) => isDir(path.join(importsDir, d)))
      .reverse();
    for (const stamp of stamps) {
      const candidate = path.join(importsDir, stamp, name);
      if (isDir(candidate)) return candidate;
    }
    return null;
  };
  return { tasksRoot: find("_tasks"), dirchannelRoot: find("_dirchannel") };
}

/** Build a fresh record's text from fields + body through the codec. */
function recordText(fields: Record<string, unknown>, body: string): string {
  const rec = parseRecord("");
  const present: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) present[k] = v;
  }
  setFields(rec, present);
  let text = body;
  if (text.length > 0 && !text.endsWith("\n")) text += "\n";
  setBody(rec, text);
  return serializeRecord(rec);
}

/**
 * Append one bullet line at the end of a `## Log` body section (created at
 * the end of the body on demand) — mirrors the tasks primitive's semantics.
 */
function appendLogLine(body: string, line: string): string {
  const m = /^##[ \t]+Log[ \t]*\r?$/m.exec(body);
  if (m === null) {
    let prefix = body;
    if (prefix.length > 0 && !prefix.endsWith("\n")) prefix += "\n";
    if (prefix.length > 0) prefix += "\n";
    return `${prefix}## Log\n\n${line}\n`;
  }
  const lineEnd = body.indexOf("\n", m.index);
  const contentStart = lineEnd === -1 ? body.length : lineEnd + 1;
  const restOf = body.slice(contentStart);
  const next = restOf.search(/^#{1,6}[ \t]/m);
  const sectionEnd = next === -1 ? body.length : contentStart + next;
  const section = body.slice(contentStart, sectionEnd).replace(/\s+$/, "");
  const after = body.slice(sectionEnd);
  const newSection =
    (section.length > 0 ? section + "\n" : "\n") + line + "\n" + (after.length > 0 ? "\n" : "");
  return body.slice(0, contentStart) + newSection + after;
}

function appendSection(body: string, heading: string, text: string): string {
  let prefix = body;
  if (prefix.length > 0 && !prefix.endsWith("\n")) prefix += "\n";
  if (prefix.length > 0) prefix += "\n";
  return `${prefix}## ${heading}\n\n${text}\n`;
}

// ---------------------------------------------------------------------------
// (a) Legacy Backlog.md tasks → native tasks
// ---------------------------------------------------------------------------

/** Legacy Backlog.md status vocabulary → native (PRD §4.4). */
const LEGACY_STATUS_MAP: Readonly<Record<string, string>> = {
  "to do": "todo",
  "in progress": "doing",
  "final review": "review",
  done: "done",
  // already-native values pass through (re-runs over half-migrated trees)
  todo: "todo",
  doing: "doing",
  waiting: "waiting",
  review: "review",
};

interface TaskTransform {
  nativeId: string;
  targetName: string;
  content: string;
  note: string;
}

function transformLegacyTask(
  filePath: string,
  relSource: string,
  errors: string[],
): TaskTransform | null {
  const rec = readRecord(filePath);
  if (rec.errors.length > 0) {
    errors.push(`${relSource}: unparseable frontmatter (${rec.errors[0] ?? "YAML error"})`);
    return null;
  }
  const rawId = rec.data["id"];
  const parsed = typeof rawId === "string" ? parseId(rawId.trim().toLowerCase()) : null;
  if (parsed === null || parsed.prefix !== "task") {
    errors.push(`${relSource}: missing or unparseable legacy id (${String(rawId)})`);
    return null;
  }
  const nativeId = formatId("task", parsed.parts, parsed.machineSuffix);

  const rawStatus = rec.data["status"];
  const mapped =
    typeof rawStatus === "string" ? LEGACY_STATUS_MAP[rawStatus.trim().toLowerCase()] : undefined;
  if (mapped === undefined) {
    errors.push(`${relSource}: unknown legacy status "${String(rawStatus)}"`);
    return null;
  }

  // parent_task_id → dotted ID (parentage lives in the ID alone; error on
  // disagreement — PRD §4.4).
  const noteParts: string[] = [`status ${String(rawStatus)} → ${mapped}`];
  const toDelete: string[] = [];
  const rawParent = rec.data["parent_task_id"];
  if (typeof rawParent === "string" && rawParent.trim() !== "") {
    const parentText = rawParent.trim().toLowerCase();
    const declared = parseId(parentText.startsWith("task-") ? parentText : `task-${parentText}`);
    if (parsed.parts.length < 2) {
      errors.push(
        `${relSource}: parent_task_id (${rawParent}) disagrees with the un-dotted id ${nativeId}`,
      );
      return null;
    }
    const fromId = formatId("task", parsed.parts.slice(0, -1), null);
    const declaredId = declared !== null ? formatId("task", declared.parts, null) : parentText;
    if (declaredId !== fromId) {
      errors.push(
        `${relSource}: parent_task_id (${rawParent}) disagrees with the dotted id ${nativeId} (parent ${fromId})`,
      );
      return null;
    }
    toDelete.push("parent_task_id");
    noteParts.push(`parent_task_id normalized into dotted id`);
  } else if (rawParent === null) {
    toDelete.push("parent_task_id");
  }

  const updates: Record<string, unknown> = {};
  if (typeof rawId === "string" && rawId !== nativeId) updates["id"] = nativeId;
  if (rawStatus !== mapped) updates["status"] = mapped;

  const rawQuadrant = rec.data["quadrant"];
  if (typeof rawQuadrant === "string" && /^Q[1-4]$/.test(rawQuadrant)) {
    updates["quadrant"] = rawQuadrant.toLowerCase();
  }

  // created_date / updated_date → the native created / updated fields
  // (values kept verbatim — state fidelity; everything else is preserved as
  // unknown keys).
  if (typeof rec.data["created_date"] === "string" && rec.data["created"] === undefined) {
    updates["created"] = rec.data["created_date"];
    toDelete.push("created_date");
  }
  if (typeof rec.data["updated_date"] === "string" && rec.data["updated"] === undefined) {
    updates["updated"] = rec.data["updated_date"];
    toDelete.push("updated_date");
  }

  if (Object.keys(updates).length > 0) setFields(rec, updates);
  if (toDelete.length > 0) deleteFields(rec, toDelete);

  // Keep the legacy filename when it already carries the native id; rebuild
  // it otherwise.
  const sourceName = path.basename(filePath);
  const fnParsed = idFromFilename(sourceName);
  const targetName =
    fnParsed !== null && formatId("task", fnParsed.parts, fnParsed.machineSuffix) === nativeId
      ? sourceName
      : `${nativeId} - ${slugFromTitle(typeof rec.data["title"] === "string" ? (rec.data["title"] as string) : nativeId)}.md`;

  return { nativeId, targetName, content: serializeRecord(rec), note: noteParts.join("; ") };
}

// ---------------------------------------------------------------------------
// (b) Legacy reminders → tasks
// ---------------------------------------------------------------------------

/** Legacy reminder recur vocabulary → native task intervals. */
const LEGACY_RECUR_MAP: Readonly<Record<string, string>> = {
  daily: "every-1-days",
  weekly: "weekly",
  monthly: "monthly",
  yearly: "yearly",
};

function mapLegacyRecur(raw: unknown): { recur?: string; error?: string } {
  if (raw === null || raw === undefined || raw === "") return {};
  if (typeof raw !== "string") return { error: `unmappable recur value ${String(raw)}` };
  const mapped = LEGACY_RECUR_MAP[raw.trim().toLowerCase()];
  if (mapped !== undefined) return { recur: mapped };
  if (/^every-[1-9]\d*-days$/.test(raw.trim())) return { recur: raw.trim() };
  return { error: `unmappable recur value "${raw}"` };
}

function titleFromBody(body: string, fallback: string): string {
  const m = /^#(?!#)[ \t]+(.+?)[ \t]*\r?$/m.exec(body);
  return m !== null ? (m[1] as string) : fallback;
}

/** The closing-reasoning line of a dismissed reminder's `## Log`, if any. */
function dismissalReasoning(body: string): string | null {
  const m = /^-[ \t]+(.*dismissed.*)$/im.exec(body);
  return m !== null ? (m[1] as string).trim() : null;
}

interface ReminderTransform {
  /** Normalized legacy id, e.g. `reminder-12` — the idempotency key. */
  legacyId: string;
  legacyStatus: "pending" | "surfaced" | "dismissed" | "promoted";
  /** Archived target (dismissed/promoted) vs live (pending). */
  archived: boolean;
  title: string;
  fields: Record<string, unknown>; // sans `id` (minted later)
  body: string;
  note: string;
}

function transformLegacyReminder(
  filePath: string,
  relSource: string,
  errors: string[],
): ReminderTransform | null {
  const rec = readRecord(filePath);
  if (rec.errors.length > 0) {
    errors.push(`${relSource}: unparseable frontmatter (${rec.errors[0] ?? "YAML error"})`);
    return null;
  }
  const d = rec.data;
  const rawLegacyId =
    typeof d["id"] === "string" ? d["id"].trim().toLowerCase() : path.basename(filePath).split(" ")[0];
  if (rawLegacyId === undefined || !/^reminder-\d+$/.test(rawLegacyId)) {
    errors.push(`${relSource}: missing or unparseable legacy reminder id (${String(d["id"])})`);
    return null;
  }
  const legacyId = rawLegacyId;

  const rawStatus = typeof d["status"] === "string" ? d["status"].trim().toLowerCase() : "";
  if (
    rawStatus !== "pending" &&
    rawStatus !== "surfaced" &&
    rawStatus !== "dismissed" &&
    rawStatus !== "promoted"
  ) {
    errors.push(`${relSource}: unknown legacy reminder status "${String(d["status"])}"`);
    return null;
  }

  const recurMapped = mapLegacyRecur(d["recur"]);
  if (recurMapped.error !== undefined) {
    errors.push(`${relSource}: ${recurMapped.error}`);
    return null;
  }

  const title = titleFromBody(rec.body, slugFromTitle(path.basename(filePath, ".md")));
  let body = rec.body;
  const noteParts: string[] = [];

  // fired_at → a `## Log` line (the surfacing event survives as history).
  const firedAt = d["fired_at"];
  if (typeof firedAt === "string" && firedAt !== "") {
    body = appendLogLine(body, `- ${firedAt} — fired (legacy reminder surfacing)`);
    noteParts.push("fired_at folded into ## Log");
  }

  const surfaceOn = typeof d["surface_on"] === "string" ? d["surface_on"] : null;

  const fields: Record<string, unknown> = { title };
  let archived = false;
  if (rawStatus === "pending") {
    fields["status"] = "todo";
    fields["hidden_until"] = surfaceOn;
    noteParts.unshift(`pending → todo${surfaceOn !== null ? `, hidden until ${surfaceOn}` : ""}`);
  } else if (rawStatus === "surfaced") {
    // Legacy vocabulary (REMINDERS_DESIGN): fired and awaiting action — a
    // live todo whose surface date already passed (hidden_until in the past
    // means it shows in default listings, which is exactly right).
    fields["status"] = "todo";
    fields["hidden_until"] = surfaceOn;
    noteParts.unshift("surfaced → todo (already fired; awaiting action)");
  } else if (rawStatus === "dismissed") {
    // Archived task; the closing-reasoning log line is preserved in the body
    // and becomes the one-line Final Summary (PRD §4.4: for a nudge closed
    // with a judgment call, one line suffices).
    archived = true;
    fields["status"] = "done";
    fields["hidden_until"] = surfaceOn;
    const reasoning =
      dismissalReasoning(rec.body) ?? "Dismissed as a legacy reminder (no closing log line found).";
    body = appendSection(body, "Final Summary", reasoning);
    noteParts.unshift("dismissed → archived done (closing-reasoning log line preserved)");
  } else {
    // promoted → archived task cross-referencing the promoted-to task.
    archived = true;
    fields["status"] = "done";
    fields["hidden_until"] = surfaceOn;
    const rawPromoted = d["promoted_to_task"];
    const promotedRef =
      typeof rawPromoted === "string" && rawPromoted.trim() !== ""
        ? rawPromoted.trim().toLowerCase().replace(/^(?!task-)/, "task-").replace(/^task-task-/, "task-")
        : null;
    const crossRef =
      promotedRef !== null
        ? `Promoted to ${promotedRef} — the work continued there (legacy reminder ${legacyId}).`
        : `Promoted to a task — cross-reference lost in the legacy record (legacy reminder ${legacyId}).`;
    body = appendSection(body, "Final Summary", crossRef);
    if (promotedRef !== null) fields["promoted_to_task"] = promotedRef;
    noteParts.unshift(`promoted → archived done (cross-ref ${promotedRef ?? "unknown"})`);
  }

  if (recurMapped.recur !== undefined) {
    if (archived) {
      // A closed (dismissed/promoted) reminder's recurrence is retired with
      // it — `done` with `recur:` set is a doctor error by design (§4.4).
      noteParts.push(`recur ${String(d["recur"])} retired (record closed by import)`);
    } else {
      fields["recur"] = recurMapped.recur;
      if (d["recur"] !== recurMapped.recur) {
        noteParts.push(`recur ${String(d["recur"])} → ${recurMapped.recur}`);
      }
    }
  }
  if (d["created"] !== undefined && d["created"] !== null) fields["created"] = d["created"];

  // Preserve the rest of the legacy frontmatter (unknown keys are first-class).
  for (const key of ["surface_to", "created_by", "created_by_detail", "recur_until"]) {
    const v = d[key];
    if (v !== undefined && v !== null) fields[key] = v;
  }
  fields["imported_from"] = legacyId; // the idempotency key

  return {
    legacyId,
    legacyStatus: rawStatus,
    archived,
    title,
    fields,
    body,
    note: noteParts.join("; "),
  };
}

// ---------------------------------------------------------------------------
// (c) dirchannels → forum
// ---------------------------------------------------------------------------

const FORUM_KINDS = new Set(["note", "checkin", "question", "answer", "handoff", "system"]);

const RAND_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Deterministic rand4 stand-in: hashed from the legacy message ULID. */
function hash4(text: string): string {
  const digest = crypto.createHash("sha256").update(text).digest();
  let out = "";
  for (let i = 0; i < 4; i++) out += RAND_CHARS[(digest[i] as number) % RAND_CHARS.length];
  return out;
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Participants land in maildir filenames delimited by `--`; keep them safe. */
function sanitizeParticipant(from: string): string {
  const safe = from.replace(/[^A-Za-z0-9._@-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  return safe === "" ? "unknown" : safe;
}

function stampFromTs(ts: string): string | null {
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString().slice(0, 19).replace(/[-:]/g, "") + "Z";
}

interface LegacyThreadMeta {
  id: string;
  channel: string;
  title: string;
  owner: string | null;
  status: string;
  started_at: string | null;
  last_activity_at: string | null;
  closed_at: string | null;
  mode: string | null;
}

function readThreadMeta(metaPath: string, relSource: string, errors: string[]): LegacyThreadMeta | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  } catch (err) {
    errors.push(`${relSource}: unreadable thread meta.json (${err instanceof Error ? err.message : String(err)})`);
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const str = (k: string): string | null => (typeof obj[k] === "string" ? (obj[k] as string) : null);
  const id = str("id");
  const channel = str("channel");
  if (id === null || channel === null) {
    errors.push(`${relSource}: thread meta.json missing id/channel`);
    return null;
  }
  return {
    id,
    channel,
    title: str("title") ?? id,
    owner: str("owner"),
    status: str("status") ?? "active",
    started_at: str("started_at"),
    last_activity_at: str("last_activity_at"),
    closed_at: str("closed_at"),
    mode: str("mode"),
  };
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/** Read every native task record's `imported_from:` (the reminder idempotency keys). */
function readImportedFromKeys(dirs: string[]): Set<string> {
  const out = new Set<string>();
  for (const dir of dirs) {
    for (const name of listDirNames(dir)) {
      if (!name.endsWith(".md")) continue;
      const p = path.join(dir, name);
      if (!isFile(p)) continue;
      try {
        const rec = readRecord(p);
        const v = rec.data["imported_from"];
        if (typeof v === "string") out.add(v.trim().toLowerCase());
      } catch {
        // unreadable record: the doctor's problem, not the importer's
      }
    }
  }
  return out;
}

interface NativeTaskRecord {
  /** Filename of the existing native record (the ID-carrying name). */
  name: string;
  /** Absolute path (live tasks/ or tasks/archive/). */
  abs: string;
}

function nativeTaskRecords(dirs: string[]): Map<string, NativeTaskRecord> {
  const out = new Map<string, NativeTaskRecord>();
  for (const dir of dirs) {
    for (const name of listDirNames(dir)) {
      const parsed = idFromFilename(name);
      if (parsed !== null && parsed.prefix === "task") {
        out.set(formatId("task", parsed.parts, parsed.machineSuffix), { name, abs: path.join(dir, name) });
      }
    }
  }
  return out;
}

function maxTopLevel(ids: Iterable<string>): number {
  let max = 0;
  for (const id of ids) {
    const parsed = parseId(id);
    const first = parsed?.parts[0];
    if (first !== undefined && first > max) max = first;
  }
  return max;
}

/** Build the full dry-run plan. Pure read — never writes anything. */
export function planLegacyImport(projectRoot: string): ImportPlan {
  const uid = readProjectUid(projectRoot);
  if (uid === null) {
    throw new ConfigError(`not a project (no _project/id): ${projectRoot}`);
  }
  const sources = findLegacySources(projectRoot);
  const actions: ImportAction[] = [];
  const errors: string[] = [];

  const liveDir = tasksDir(projectRoot);
  const archiveDir = tasksArchiveDir(projectRoot);
  const relLive = rel(projectRoot, liveDir);
  const relArchive = rel(projectRoot, archiveDir);

  const existingRecords = nativeTaskRecords([liveDir, archiveDir]);
  const existingIds = new Set(existingRecords.keys());
  const importedFrom = readImportedFromKeys([liveDir, archiveDir]);
  const plannedIds = new Set<string>();

  // ----- (a) tasks -----
  if (sources.tasksRoot !== null) {
    const taskSources: Array<{ dir: string; archived: boolean }> = [
      { dir: path.join(sources.tasksRoot, "tasks"), archived: false },
      { dir: path.join(sources.tasksRoot, "completed"), archived: true },
      { dir: path.join(sources.tasksRoot, "archive", "tasks"), archived: true },
    ];
    for (const { dir, archived } of taskSources) {
      for (const name of listDirNames(dir)) {
        const src = path.join(dir, name);
        if (!isFile(src) || !name.endsWith(".md")) continue;
        const relSource = rel(projectRoot, src);
        const t = transformLegacyTask(src, relSource, errors);
        if (t === null) continue;
        const targetDirRel = archived ? relArchive : relLive;
        const target = path.join(targetDirRel, t.targetName);
        const existing = existingRecords.get(t.nativeId);
        if (existing !== undefined) {
          // Idempotency must verify the ID hit IS this import — a native task
          // minted before migration can collide with a legacy ID, and calling
          // that "already imported" silently drops a legacy record. Evidence
          // accepted: same ID-carrying filename (a re-run, possibly edited or
          // archived since), or byte-equal content. Anything else is an error.
          let existingText: string | null = null;
          try {
            existingText = fs.readFileSync(existing.abs, "utf8");
          } catch {
            existingText = null;
          }
          if (existing.name === t.targetName || existingText === t.content) {
            actions.push({ kind: "exists", source: relSource, target, note: `${t.nativeId} already imported` });
          } else {
            errors.push(
              `${relSource}: legacy id ${t.nativeId} collides with a pre-existing native record ` +
                `${rel(projectRoot, existing.abs)} that is NOT this import — re-id one of them before importing`,
            );
          }
          continue;
        }
        if (plannedIds.has(t.nativeId)) {
          errors.push(`${relSource}: duplicate legacy task id ${t.nativeId}`);
          continue;
        }
        plannedIds.add(t.nativeId);
        actions.push({
          kind: "task",
          source: relSource,
          target,
          note: `${t.note}${archived ? "; archived legacy record → tasks/archive/" : ""}`,
          write: { content: t.content },
        });
      }
    }

    // ----- (b) reminders -----
    const reminderTransforms: Array<{ relSource: string; t: ReminderTransform }> = [];
    for (const dir of [
      path.join(sources.tasksRoot, "reminders"),
      path.join(sources.tasksRoot, "reminders", "_archived"),
    ]) {
      for (const name of listDirNames(dir)) {
        const src = path.join(dir, name);
        if (!isFile(src) || !name.endsWith(".md")) continue;
        const relSource = rel(projectRoot, src);
        const t = transformLegacyReminder(src, relSource, errors);
        if (t !== null) reminderTransforms.push({ relSource, t });
      }
    }
    // Deterministic mint order: by legacy reminder number.
    reminderTransforms.sort((a, b) => {
      const na = Number(a.t.legacyId.split("-")[1]);
      const nb = Number(b.t.legacyId.split("-")[1]);
      return na - nb || a.t.legacyId.localeCompare(b.t.legacyId);
    });
    // Seed ABOVE the legacy max: existing native ids + everything this plan
    // is about to import.
    let nextId = Math.max(maxTopLevel(existingIds), maxTopLevel(plannedIds)) + 1;
    for (const { relSource, t } of reminderTransforms) {
      if (importedFrom.has(t.legacyId)) {
        actions.push({ kind: "exists", source: relSource, target: null, note: `${t.legacyId} already imported` });
        continue;
      }
      const id = formatId("task", [nextId], null);
      nextId += 1;
      const target = path.join(t.archived ? relArchive : relLive, `${id} - ${slugFromTitle(t.title)}.md`);
      actions.push({
        kind: "reminder",
        source: relSource,
        target,
        note: `${t.legacyId} → ${id}; ${t.note}`,
        write: { content: recordText({ id, ...t.fields }, t.body) },
      });
    }

    // Non-imported legacy `_tasks/` content: listed, left untouched. Every
    // record-shaped class gets an HONEST per-file audit line (R6/§11.4);
    // only true tool internals (.locks, config.yml, …) stay coarse.
    const skipFilesUnder = (dir: string, note: string): void => {
      for (const name of listDirNames(dir)) {
        const p = path.join(dir, name);
        if (isDir(p)) {
          skipFilesUnder(p, note);
        } else {
          actions.push({ kind: "skip", source: rel(projectRoot, p), target: null, note });
        }
      }
    };

    // drafts/: user-authored draft tasks in the legacy Backlog.md layout —
    // no native home (drafts were retired); each file is audited.
    skipFilesUnder(
      path.join(sources.tasksRoot, "drafts"),
      "legacy draft task — drafts have no native home; not imported, left untouched",
    );

    // archive/ beyond archive/tasks/ (e.g. archive/drafts/): records that
    // would otherwise be invisible to the audit — listed per file.
    const archiveRoot = path.join(sources.tasksRoot, "archive");
    for (const name of listDirNames(archiveRoot)) {
      if (name === "tasks") continue;
      const p = path.join(archiveRoot, name);
      const note =
        "legacy archived record outside archive/tasks/ — not imported, left untouched (migrate by hand if it matters)";
      if (isDir(p)) skipFilesUnder(p, note);
      else actions.push({ kind: "skip", source: rel(projectRoot, p), target: null, note });
    }

    const handled = new Set(["tasks", "completed", "archive", "reminders", "drafts"]);
    for (const name of listDirNames(sources.tasksRoot)) {
      if (handled.has(name)) continue;
      actions.push({
        kind: "skip",
        source: rel(projectRoot, path.join(sources.tasksRoot, name)),
        target: null,
        note: "legacy tasks-tool internals — not imported, left untouched",
      });
    }
  }

  // PRD §11 step-4 items OUTSIDE `import legacy` scope (manual migrating-agent
  // work): v0.2 review records → tasks; finance proposals re-home. List the
  // legacy dirs as audited skips so the migration checklist cannot miss them.
  for (const legacyDir of ["reviews", "proposals"]) {
    const abs = path.join(projectRoot, "_project", legacyDir);
    if (!isDir(abs)) continue;
    const note = `legacy v0.2 ${legacyDir} record — outside \`import legacy\` scope; migrate by hand per PRD §11 step 4 (${legacyDir === "reviews" ? "review records → tasks" : "proposals re-home"})`;
    let listed = false;
    const walkLegacy = (dir: string): void => {
      for (const name of listDirNames(dir)) {
        const p = path.join(dir, name);
        if (isDir(p)) walkLegacy(p);
        else {
          actions.push({ kind: "skip", source: rel(projectRoot, p), target: null, note });
          listed = true;
        }
      }
    };
    walkLegacy(abs);
    if (!listed) {
      actions.push({ kind: "skip", source: rel(projectRoot, abs), target: null, note });
    }
  }

  // ----- (c) dirchannels → forum -----
  if (sources.dirchannelRoot !== null) {
    planDirchannel(projectRoot, sources.dirchannelRoot, actions, errors);
  }

  // Intra-plan duplicate-target guard: planning checks each target against
  // the FILESYSTEM, but two source records can plan the identical target in
  // one run (e.g. a duplicated messages.jsonl line after an iCloud
  // merge/append glitch — same id+ts ⇒ same deterministic filename). Without
  // this pass an error-free plan would crash mid-apply on createExclusive,
  // violating "apply executes exactly that plan". Identical duplicates are
  // deduped (second becomes an idempotent no-op); same-target-different-
  // content is a plan error.
  const plannedTargets = new Map<string, ImportAction>();
  const dedupedActions: ImportAction[] = [];
  for (const a of actions) {
    if (a.target === null || a.write === undefined) {
      dedupedActions.push(a);
      continue;
    }
    const prior = plannedTargets.get(a.target);
    if (prior === undefined) {
      plannedTargets.set(a.target, a);
      dedupedActions.push(a);
    } else if (prior.write !== undefined && prior.write.content === a.write.content) {
      dedupedActions.push({
        kind: "exists",
        source: a.source,
        target: a.target,
        note: `duplicate of ${prior.source} (identical content) — deduped, written once`,
      });
    } else {
      errors.push(
        `${a.source}: planned target ${a.target} collides with ${prior.source} but the content differs — resolve the source duplication by hand`,
      );
    }
  }
  actions.length = 0;
  actions.push(...dedupedActions);

  const counts = { tasks: 0, reminders: 0, threads: 0, messages: 0, skipped: 0, existing: 0 };
  for (const a of actions) {
    if (a.kind === "task") counts.tasks += 1;
    else if (a.kind === "reminder") counts.reminders += 1;
    else if (a.kind === "forum-thread") counts.threads += 1;
    else if (a.kind === "forum-message") counts.messages += 1;
    else if (a.kind === "skip") counts.skipped += 1;
    else counts.existing += 1;
  }
  return { projectRoot, uid, sources, actions, errors, counts };
}

function planDirchannel(
  projectRoot: string,
  dirchannelRoot: string,
  actions: ImportAction[],
  errors: string[],
): void {
  const threadsDirAbs = path.join(projectRoot, "_project", "forum", "threads");
  const threadsRel = rel(projectRoot, threadsDirAbs);

  // Everything at the dirchannel root that is not channels/ is tool state
  // (SQLite, tokens, bridge state, pty plumbing): listed as skipped.
  for (const name of listDirNames(dirchannelRoot)) {
    if (name === "channels") continue;
    actions.push({
      kind: "skip",
      source: rel(projectRoot, path.join(dirchannelRoot, name)),
      target: null,
      note: "dirchannel tool state (sqlite/token/bridge/pty plumbing) — not imported, left untouched",
    });
  }

  const channelsDir = path.join(dirchannelRoot, "channels");
  const usedNames = new Set<string>();
  for (const channel of listDirNames(channelsDir)) {
    const channelDir = path.join(channelsDir, channel);
    if (!isDir(channelDir)) continue;
    for (const name of listDirNames(channelDir)) {
      if (name === "threads") continue;
      actions.push({
        kind: "skip",
        source: rel(projectRoot, path.join(channelDir, name)),
        target: null,
        note: "channel metadata — channels flatten into thread slugs",
      });
    }
    const chThreads = path.join(channelDir, "threads");
    for (const ulid of listDirNames(chThreads)) {
      const threadDir = path.join(chThreads, ulid);
      if (!isDir(threadDir)) continue;
      planDirchannelThread(projectRoot, threadDir, channel, threadsRel, usedNames, actions, errors);
    }
  }
}

function planDirchannelThread(
  projectRoot: string,
  threadDir: string,
  channel: string,
  threadsRel: string,
  usedNames: Set<string>,
  actions: ImportAction[],
  errors: string[],
): void {
  const metaPath = path.join(threadDir, "meta.json");
  const relMeta = rel(projectRoot, metaPath);
  if (!isFile(metaPath)) {
    errors.push(`${rel(projectRoot, threadDir)}: dirchannel thread without meta.json`);
    return;
  }
  const meta = readThreadMeta(metaPath, relMeta, errors);
  if (meta === null) return;

  // <date>--<channel>--<slug> (channels flatten into the thread name).
  const date = meta.started_at !== null ? meta.started_at.slice(0, 10) : "0000-00-00";
  const slug = slugify(meta.title) !== "" ? slugify(meta.title) : meta.id.toLowerCase();
  let name = `${date}--${channel}--${slug}`;
  for (let n = 2; usedNames.has(name); n++) name = `${date}--${channel}--${slug}-${n}`;
  usedNames.add(name);

  // Idempotency: an already-imported thread may live in threads/ or have been
  // archived since — both count as "exists".
  const liveTarget = path.join(projectRoot, threadsRel, name);
  const archivedTarget = path.join(projectRoot, threadsRel, "archive", name);
  const existingDir = isDir(liveTarget) ? liveTarget : isDir(archivedTarget) ? archivedTarget : null;
  const targetDirAbs = existingDir ?? liveTarget;
  const targetDirRel = rel(projectRoot, targetDirAbs);

  // done | errored → resolved; active → open (§4.6 vocabulary).
  const resolvedStatus = meta.status === "active" ? "open" : "resolved";
  const resolvedAt =
    resolvedStatus === "resolved" ? meta.closed_at ?? meta.last_activity_at ?? undefined : undefined;
  const threadFields: Record<string, unknown> = {
    title: meta.title,
    status: resolvedStatus,
    opened: meta.started_at ?? undefined,
    by: meta.owner ?? undefined,
    resolved: resolvedAt,
    legacy_id: meta.id,
    legacy_channel: channel,
    legacy_status: meta.status,
    legacy_mode: meta.mode ?? undefined,
  };
  const threadMdRel = path.join(targetDirRel, "thread.md");
  if (existingDir !== null && isFile(path.join(targetDirAbs, "thread.md"))) {
    actions.push({ kind: "exists", source: relMeta, target: threadMdRel, note: `thread ${name} already imported` });
  } else {
    actions.push({
      kind: "forum-thread",
      source: relMeta,
      target: threadMdRel,
      note: `${meta.status} → ${resolvedStatus}`,
      write: { content: recordText(threadFields, "") },
    });
  }

  // messages.jsonl → one immutable maildir file per line.
  const jsonlPath = path.join(threadDir, "messages.jsonl");
  const relJsonl = rel(projectRoot, jsonlPath);
  if (isFile(jsonlPath)) {
    const lines = fs.readFileSync(jsonlPath, "utf8").split("\n").filter((l) => l.trim() !== "");
    lines.forEach((line, idx) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        errors.push(`${relJsonl}:${idx + 1}: unparseable JSONL line`);
        return;
      }
      const msgId = typeof msg["id"] === "string" ? (msg["id"] as string) : `${meta.id}-${idx}`;
      const ts = typeof msg["ts"] === "string" ? (msg["ts"] as string) : null;
      const stamp = ts !== null ? stampFromTs(ts) : null;
      if (stamp === null) {
        errors.push(`${relJsonl}:${idx + 1}: missing or unparseable ts`);
        return;
      }
      const from = typeof msg["from"] === "string" ? (msg["from"] as string) : "unknown";
      const legacyKind = typeof msg["kind"] === "string" ? (msg["kind"] as string) : "text";
      // text → note; vocabulary kinds pass through; anything else collapses
      // to system with the original preserved in legacy_kind.
      const kind = legacyKind === "text" ? "note" : FORUM_KINDS.has(legacyKind) ? legacyKind : "system";
      const collapsed = kind === "system" && legacyKind !== "system";
      const rawBody = msg["body"];
      const body = typeof rawBody === "string" ? rawBody : JSON.stringify(rawBody, null, 2);
      const filename = `${stamp}--${sanitizeParticipant(from)}--${hash4(msgId)}.md`;
      const targetRel = path.join(targetDirRel, filename);
      if (isFile(path.join(projectRoot, targetRel))) {
        actions.push({ kind: "exists", source: `${relJsonl}:${idx + 1}`, target: targetRel, note: `message ${msgId} already imported` });
        return;
      }
      const fields: Record<string, unknown> = {
        from,
        kind,
        ts,
        legacy_id: msgId,
        legacy_kind: collapsed ? legacyKind : undefined,
        legacy_meta: msg["meta"] !== undefined ? msg["meta"] : undefined,
      };
      actions.push({
        kind: "forum-message",
        source: `${relJsonl}:${idx + 1}`,
        target: targetRel,
        note: `kind ${legacyKind} → ${kind}${collapsed ? " (original kind preserved in legacy_kind)" : ""}`,
        write: { content: recordText(fields, body) },
      });
    });
  }

  // Anything else in the thread dir (pty logs etc.): skipped, untouched.
  for (const name of listDirNames(threadDir)) {
    if (name === "meta.json" || name === "messages.jsonl") continue;
    actions.push({
      kind: "skip",
      source: rel(projectRoot, path.join(threadDir, name)),
      target: null,
      note: "dirchannel thread extra (pty log / attachment plumbing) — not imported, left untouched",
    });
  }
}

// ---------------------------------------------------------------------------
// Rendering + apply
// ---------------------------------------------------------------------------

/** Per-record audit lines (the dry-run output; apply prints the same plan). */
export function renderPlan(plan: ImportPlan, options: { mode?: "dry-run" | "apply" } = {}): string[] {
  const lines: string[] = [];
  const mode = options.mode ?? "dry-run";
  lines.push(`import legacy (${mode}): ${plan.projectRoot}`);
  lines.push(
    `  sources: tasks=${plan.sources.tasksRoot ?? "(none)"} dirchannel=${plan.sources.dirchannelRoot ?? "(none)"}`,
  );
  for (const a of plan.actions) {
    const arrow = a.target !== null ? ` → ${a.target}` : "";
    lines.push(`  ${a.kind.padEnd(13)} ${a.source}${arrow}  [${a.note}]`);
  }
  for (const e of plan.errors) lines.push(`  error: ${e}`);
  const c = plan.counts;
  lines.push(
    `summary: ${c.tasks} task(s), ${c.reminders} reminder(s), ${c.threads} thread(s), ` +
      `${c.messages} message(s); ${c.existing} already present, ${c.skipped} skipped, ${plan.errors.length} error(s)`,
  );
  return lines;
}

/** Execute exactly the given plan. Throws ConfigError when the plan has errors. */
export function executePlan(plan: ImportPlan): ApplyResult {
  if (plan.errors.length > 0) {
    throw new ConfigError(
      `refusing to apply a plan with ${plan.errors.length} error(s):\n` + plan.errors.join("\n"),
    );
  }
  const written: string[] = [];
  for (const a of plan.actions) {
    if (a.write === undefined || a.target === null) continue;
    const abs = path.join(plan.projectRoot, a.target);
    ensureDir(path.dirname(abs));
    createExclusive(abs, a.write.content); // idempotent plans never re-plan an existing target
    written.push(abs);
  }
  return { plan, written };
}

/**
 * Plan + apply in one motion. Planning and the reminder ID assignment happen
 * UNDER the project's machine-local mint lock (the same seam `task create`
 * mints through), so a concurrent minter can't be issued an ID this import is
 * about to claim.
 */
export function applyLegacyImport(projectRoot: string, store: MachineStore): ApplyResult {
  const uid = readProjectUid(projectRoot);
  if (uid === null) {
    throw new ConfigError(`not a project (no _project/id): ${projectRoot}`);
  }
  return withMintLock(store, uid, () => executePlan(planLegacyImport(projectRoot)));
}
