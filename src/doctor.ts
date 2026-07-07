/**
 * Doctor — the enforced invariants (PRD §10).
 *
 * Doctor PROPOSES; it never auto-commits, auto-executes, or mutates anything.
 * Every check here is a pure read of the live tree. Severity:
 *   error — a schema invariant is violated (CLI exits 1 when any exist)
 *   warn  — hygiene / propose-an-action findings (exit stays 0)
 *
 * Implemented: workspace checks (shelf paths, duplicate UIDs, shelf-as-project,
 * sync-conflict artifacts INCLUDING under .git/,
 * secret schemes without resolvers, machine-registry heartbeat staleness,
 * stale git-worktree registrations, doc-currency over the shipped skill) and
 * project checks (state-named subdirs under any primitive, duplicate record
 * IDs, unparseable frontmatter, done-without-Final-Summary, done parent with
 * open children, dotted-ID orphans, legacy parent_task_id disagreement,
 * hidden_until/recur validity, done-with-recur, recurrence lag,
 * superseded-without-pointer, forum structure, resolved-thread archive
 * proposals (>30d), unanswered-question aging, automation manifest
 * validation as findings (incl. the §7.5 bare-secret hard error, reserved
 * Runtime v2 policy warnings, and direct_exec managed-runner semantics
 * warnings), [signature] path existence,
 * declared-vs-activated placement drift + orphaned activations (read from
 * the synced per-machine registries; a present-but-INVALID manifest is
 * reported as such, never misdiagnosed as a deleted definition),
 * git-posture reconciliation — stamp presence (anchored /archive/; the
 * unanchored legacy pattern gets an anchoring proposal),
 * tracked-but-should-be-ignored, _project/id git-ignored, doc-currency over
 * the stamped orientation READMEs), and the decision-1 runner-posture checks
 * (runner-node-unset / runner-node-provenance / claude-grant-staleness —
 * machine-local, best-effort, run only when a MachineStore is provided;
 * system binaries sit behind the injectable ExecFn seam).
 *
 * Not yet implemented (deferred, see README "Status"): the
 * aging-untracked-forum-message commit sweep proposal (needs git-tracking
 * introspection of the canonical forum).
 */

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { checkDocCurrency } from "./lib/clisurface.js";
import { readRecord } from "./lib/frontmatter.js";
import { formatId, idFromFilename, parseId } from "./lib/ids.js";
import { MachineStore, readRunnerNode } from "./lib/machine.js";
import { readTomlIfExists } from "./lib/toml.js";
import {
  DEFAULT_ARCHIVES,
  DEFAULT_DORMANT,
  ProjectInfo,
  Workspace,
  discoverProjects,
  findDuplicateUids,
  findWorkspaceRoot,
  readDeclaredLifecycle,
  readProjectUid,
} from "./lib/workspace.js";
import { buildOwnershipGraph, detectCycle } from "./lib/owns.js";
import { reconcilePlan } from "./reconcile.js";
import { readActivationRecords, scanManifests, validateManifest } from "./primitives/automations.js";
import { hasFinalSummary, nextOccurrenceDate, parseInterval } from "./primitives/tasks.js";

export type DoctorSeverity = "error" | "warn" | "info";

export interface DoctorIssue {
  severity: DoctorSeverity;
  /** Project relPath (or root path when no workspace context); null = workspace-level. */
  project: string | null;
  /** Path relative to the project root / workspace root; null when not file-specific. */
  file: string | null;
  message: string;
}

export interface DoctorReport {
  issues: DoctorIssue[];
  errors: number;
  warnings: number;
  /** Best-effort probes that could not run ("unverifiable") — never failures. */
  infos: number;
}

function report(issues: DoctorIssue[]): DoctorReport {
  return {
    issues,
    errors: issues.filter((i) => i.severity === "error").length,
    warnings: issues.filter((i) => i.severity === "warn").length,
    infos: issues.filter((i) => i.severity === "info").length,
  };
}

function listDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Run git for a read-only query; null on any failure (no git / not a repo). */
function gitText(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

function tableHas(table: unknown, key: string): boolean {
  return table !== null && typeof table === "object" && !Array.isArray(table) &&
    Object.prototype.hasOwnProperty.call(table, key);
}

// Retention/aging thresholds. The PRD pins the 30-day resolved-thread archive
// proposal and the 7-day presence sweep (§4.6) but leaves "aging" unanswered
// questions and heartbeat staleness unquantified; both default to 7 days here
// (defaults favor silence, §2.2) — exported so callers can disagree.
export const RESOLVED_THREAD_ARCHIVE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
export const QUESTION_AGING_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
export const HEARTBEAT_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Project checks
// ---------------------------------------------------------------------------

const STATE_NAMES = new Set([
  "todo", "doing", "waiting", "review", "done", "open", "closed", "draft",
  "accepted", "rejected", "superseded", "resolved", "dismissed", "promoted",
  "active", "blocked", "pending", "in-progress", "complete", "completed",
]);

const TASK_STATUSES = new Set(["todo", "doing", "waiting", "review", "done"]);

interface TaskRecordView {
  id: string | null;
  parts: number[] | null;
  suffix: string | null;
  rel: string;
  status: string | null;
  recur: string | null;
  hiddenUntil: string | null;
  parentTaskId: string | null;
  body: string;
  yamlErrors: string[];
  archived: boolean;
}

function readTasksIn(dir: string, relDir: string, archived: boolean): TaskRecordView[] {
  const out: TaskRecordView[] = [];
  for (const ent of listDir(dir)) {
    if (!ent.isFile() || !ent.name.endsWith(".md")) continue;
    const parsed = idFromFilename(ent.name);
    if (parsed === null || parsed.prefix !== "task") continue;
    const rec = readRecord(path.join(dir, ent.name));
    const d = rec.data;
    const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
    out.push({
      id: formatId("task", parsed.parts, parsed.machineSuffix),
      parts: parsed.parts,
      suffix: parsed.machineSuffix,
      rel: path.join(relDir, ent.name),
      status: str(d["status"]),
      recur: str(d["recur"]),
      hiddenUntil: str(d["hidden_until"]),
      parentTaskId: str(d["parent_task_id"]),
      body: rec.body,
      yamlErrors: rec.errors,
      archived,
    });
  }
  return out;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function localToday(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** All project-level checks for one project root. */
export function doctorProject(
  projectRoot: string,
  options: { relPath?: string; now?: Date } = {},
): DoctorIssue[] {
  const project = options.relPath ?? projectRoot;
  const now = options.now ?? new Date();
  const issues: DoctorIssue[] = [];
  const err = (file: string | null, message: string) =>
    issues.push({ severity: "error", project, file, message });
  const warn = (file: string | null, message: string) =>
    issues.push({ severity: "warn", project, file, message });

  const p = path.join(projectRoot, "_project");

  // --- state-named subdirs under any primitive (error; PRD §4.3/§10) ---
  // wiki/ is exempt from BOTH checks: subfolder organization is mandated
  // there (rev 5), and a wiki subfolder named e.g. "open-problems" is content,
  // not state. forum/'s own structure (threads/, presence/) is expected; an
  // automation may have any name, so only the state-named check applies there.
  const FLAT_PRIMITIVES = new Set(["tasks", "decisions"]);
  const EXPECTED_SUBDIRS: Record<string, Set<string>> = { forum: new Set(["threads", "presence"]) };
  for (const primitive of ["tasks", "decisions", "plans", "automations", "forum"]) {
    const dir = path.join(p, primitive);
    for (const ent of listDir(dir)) {
      if (!ent.isDirectory() || ent.name === "archive") continue;
      if (EXPECTED_SUBDIRS[primitive]?.has(ent.name) === true) continue;
      if (STATE_NAMES.has(ent.name.toLowerCase())) {
        err(
          path.join("_project", primitive, ent.name),
          `state-named subdirectory under ${primitive}/ — state lives in frontmatter, never in location`,
        );
      } else if (FLAT_PRIMITIVES.has(primitive)) {
        warn(
          path.join("_project", primitive, ent.name),
          `unexpected subdirectory under ${primitive}/ (only archive/ belongs here)`,
        );
      }
    }
  }

  // --- tasks ---
  const tasksDir = path.join(p, "tasks");
  const tasks = [
    ...readTasksIn(tasksDir, path.join("_project", "tasks"), false),
    ...readTasksIn(
      path.join(tasksDir, "archive"),
      path.join("_project", "tasks", "archive"),
      true,
    ),
  ];

  const byId = new Map<string, TaskRecordView[]>();
  for (const t of tasks) {
    if (t.id === null) continue;
    const list = byId.get(t.id);
    if (list === undefined) byId.set(t.id, [t]);
    else list.push(t);
  }
  for (const [id, list] of byId) {
    if (list.length > 1) {
      err(null, `duplicate task id ${id}: ${list.map((t) => t.rel).join(", ")}`);
    }
  }

  for (const t of tasks) {
    if (t.yamlErrors.length > 0) {
      err(t.rel, `unparseable frontmatter: ${t.yamlErrors[0] ?? "YAML error"}`);
      continue; // remaining field checks would be noise on a broken record
    }
    if (t.status !== null && !TASK_STATUSES.has(t.status)) {
      err(t.rel, `unknown status "${t.status}" (expected todo|doing|waiting|review|done)`);
    }
    if (t.status === "done" && !hasFinalSummary(t.body)) {
      err(t.rel, `${t.id}: done without a non-empty ## Final Summary`);
    }
    if (t.status === "done" && t.recur !== null) {
      err(t.rel, `${t.id}: status done with recur set — complete the occurrence or retire the recurrence first`);
    }
    if (t.recur !== null) {
      const interval = parseInterval(t.recur);
      if (interval === null) {
        err(t.rel, `${t.id}: malformed recur interval "${t.recur}" (expected weekly|monthly|yearly|every-N-days)`);
      } else if (t.hiddenUntil !== null && DATE_RE.test(t.hiddenUntil)) {
        // lagging more than one interval behind now (warn, propose advance)
        const today = localToday(now);
        const oneAhead = nextOccurrenceDate(t.hiddenUntil, interval, t.hiddenUntil);
        if (oneAhead < today) {
          warn(
            t.rel,
            `${t.id}: recurring task lags more than one ${t.recur} interval behind ` +
              `(hidden_until ${t.hiddenUntil}); propose advancing to ${nextOccurrenceDate(t.hiddenUntil, interval, today)}`,
          );
        }
      }
    }
    if (t.hiddenUntil !== null && !DATE_RE.test(t.hiddenUntil)) {
      err(t.rel, `${t.id}: unparseable hidden_until "${t.hiddenUntil}" (expected YYYY-MM-DD)`);
    }
    if (t.parentTaskId !== null && t.parts !== null && t.parts.length > 1) {
      const fromId = formatId("task", t.parts.slice(0, -1), null);
      const declared = parseId(
        t.parentTaskId.startsWith("task-") ? t.parentTaskId : `task-${t.parentTaskId}`,
      );
      const declaredId = declared !== null ? formatId("task", declared.parts, null) : t.parentTaskId;
      if (declaredId !== fromId) {
        err(t.rel, `${t.id}: legacy parent_task_id (${t.parentTaskId}) disagrees with the dotted ID (parent ${fromId})`);
      }
    }
  }

  // dotted-ID orphans + done parent with open children (live records only)
  const liveIds = new Set(tasks.filter((t) => !t.archived && t.id !== null).map((t) => t.id as string));
  for (const t of tasks) {
    if (t.archived || t.parts === null || t.parts.length < 2) continue;
    const parentId = formatId("task", t.parts.slice(0, -1), t.suffix);
    const parentIdNoSuffix = formatId("task", t.parts.slice(0, -1), null);
    if (!liveIds.has(parentId) && !liveIds.has(parentIdNoSuffix)) {
      warn(t.rel, `${t.id}: dotted-ID orphan — no live parent ${parentIdNoSuffix}`);
    }
  }
  for (const t of tasks) {
    if (t.archived || t.status !== "done" || t.parts === null) continue;
    const open = tasks.filter(
      (c) =>
        !c.archived &&
        c.parts !== null &&
        c.parts.length > (t.parts as number[]).length &&
        (t.parts as number[]).every((v, i) => (c.parts as number[])[i] === v) &&
        c.status !== "done",
    );
    if (open.length > 0) {
      warn(t.rel, `${t.id}: done with open descendants (${open.map((o) => o.id).join(", ")})`);
    }
  }

  // --- decisions ---
  const decisionsDir = path.join(p, "decisions");
  const decisionIds = new Map<string, string[]>();
  for (const ent of listDir(decisionsDir)) {
    if (!ent.isFile() || !ent.name.endsWith(".md")) continue;
    const parsed = idFromFilename(ent.name);
    if (parsed === null || parsed.prefix !== "decision") continue;
    const rel = path.join("_project", "decisions", ent.name);
    const id = formatId("decision", parsed.parts, parsed.machineSuffix);
    const list = decisionIds.get(id);
    if (list === undefined) decisionIds.set(id, [rel]);
    else list.push(rel);
    if (parsed.parts.length > 1) {
      warn(rel, `${id}: dotted decision ID — decisions have no subtask concept`);
    }
    const rec = readRecord(path.join(decisionsDir, ent.name));
    if (rec.errors.length > 0) {
      err(rel, `unparseable frontmatter: ${rec.errors[0] ?? "YAML error"}`);
      continue;
    }
    const by = rec.data["superseded_by"];
    if (rec.data["status"] === "superseded" && (typeof by !== "string" || by === "")) {
      err(rel, `${id}: superseded without a resolving superseded_by pointer`);
    }
  }
  for (const [id, rels] of decisionIds) {
    if (rels.length > 1) err(null, `duplicate decision id ${id}: ${rels.join(", ")}`);
  }

  // --- forum ---
  const forumDir = path.join(p, "forum");
  const forbidden: string[] = [];
  const walkForum = (dir: string, rel: string, depth: number): void => {
    if (depth > 4) return;
    for (const ent of listDir(dir)) {
      const entRel = path.join(rel, ent.name);
      if (ent.isFile() && (ent.name === "messages.jsonl" || ent.name.endsWith(".sqlite") || ent.name.endsWith(".db"))) {
        forbidden.push(entRel);
      }
      if (ent.isDirectory()) walkForum(path.join(dir, ent.name), entRel, depth + 1);
    }
  };
  walkForum(forumDir, path.join("_project", "forum"), 0);
  for (const f of forbidden) {
    err(f, "legacy message store under forum/ (messages.jsonl / SQLite) — the forum is one file per message");
  }

  const threadsDir = path.join(forumDir, "threads");
  const slugCount = new Map<string, string[]>();
  const threadDirs: Array<{ dir: string; rel: string }> = [];
  for (const ent of listDir(threadsDir)) {
    if (!ent.isDirectory() || ent.name === "archive") continue;
    threadDirs.push({ dir: path.join(threadsDir, ent.name), rel: path.join("_project", "forum", "threads", ent.name) });
  }
  for (const ent of listDir(path.join(threadsDir, "archive"))) {
    if (!ent.isDirectory()) continue;
    threadDirs.push({
      dir: path.join(threadsDir, "archive", ent.name),
      rel: path.join("_project", "forum", "threads", "archive", ent.name),
    });
  }
  const MESSAGE_FILE_RE = /^\d{8}T\d{6}Z--.+--[a-z0-9]{4}\.md$/;
  for (const { dir, rel } of threadDirs) {
    const name = path.basename(dir);
    const sep = name.indexOf("--");
    const slug = sep > 0 ? name.slice(sep + 2) : name;
    const list = slugCount.get(slug);
    if (list === undefined) slugCount.set(slug, [rel]);
    else list.push(rel);

    const meta = path.join(dir, "thread.md");
    if (!fs.existsSync(meta)) {
      err(rel, "thread without a thread.md");
    } else {
      const rec = readRecord(meta);
      if (rec.errors.length > 0) {
        err(path.join(rel, "thread.md"), `thread.md unparseable: ${rec.errors[0] ?? "YAML error"}`);
      }
    }
    for (const ent of listDir(dir)) {
      if (!ent.isFile() || !MESSAGE_FILE_RE.test(ent.name)) continue;
      const rec = readRecord(path.join(dir, ent.name));
      if (typeof rec.data["from"] !== "string" || typeof rec.data["ts"] !== "string") {
        err(path.join(rel, ent.name), "forum message missing from/ts frontmatter");
      }
    }
  }
  for (const [slug, rels] of slugCount) {
    if (rels.length > 1) warn(null, `duplicate thread slug "${slug}": ${rels.join(", ")}`);
  }

  // forum retention + coordination aging (live threads only; PRD §4.6/§10)
  const stampMs = (filename: string): number | null => {
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z--/.exec(filename);
    if (m === null) return null;
    return Date.UTC(+(m[1] as string), +(m[2] as string) - 1, +(m[3] as string), +(m[4] as string), +(m[5] as string), +(m[6] as string));
  };
  for (const { dir, rel } of threadDirs) {
    if (rel.includes(`${path.sep}archive${path.sep}`)) continue; // archived: retention satisfied
    const metaPath = path.join(dir, "thread.md");
    if (!fs.existsSync(metaPath)) continue; // already an error above
    const meta = readRecord(metaPath);
    const messages = listDir(dir)
      .filter((e) => e.isFile() && MESSAGE_FILE_RE.test(e.name))
      .map((e) => e.name)
      .sort();
    const lastMessageMs = messages.length > 0 ? stampMs(messages[messages.length - 1] as string) : null;

    if (meta.data["status"] === "resolved") {
      // resolved thread untouched > 30 days → PROPOSE archive (never executed)
      const resolvedAt =
        typeof meta.data["resolved"] === "string" ? Date.parse(meta.data["resolved"]) : Number.NaN;
      const openedAt =
        typeof meta.data["opened"] === "string" ? Date.parse(meta.data["opened"]) : Number.NaN;
      const touched = [lastMessageMs ?? Number.NaN, resolvedAt, openedAt].filter((ms) => !Number.isNaN(ms));
      const lastTouched = touched.length > 0 ? Math.max(...touched) : null;
      if (lastTouched !== null && now.getTime() - lastTouched > RESOLVED_THREAD_ARCHIVE_AFTER_MS) {
        warn(
          rel,
          `resolved thread untouched for >30 days — propose \`projects forum archive ${path.basename(dir)}\``,
        );
      }
      continue; // resolved = thread-level "dealt with"; question aging below is open-only
    }

    // unanswered `to:` questions aging in an open thread (feeds the Brief)
    const answered = new Set<string>();
    const questions: Array<{ id: string; to: string[]; ms: number | null }> = [];
    for (const name of messages) {
      const rec = readRecord(path.join(dir, name));
      const re = rec.data["re"];
      if (rec.data["kind"] === "answer" && typeof re === "string") answered.add(re);
      if (rec.data["kind"] === "question") {
        const toRaw = rec.data["to"];
        const to =
          typeof toRaw === "string"
            ? [toRaw]
            : Array.isArray(toRaw)
              ? toRaw.filter((x): x is string => typeof x === "string")
              : [];
        if (to.length > 0) questions.push({ id: name.slice(0, -3), to, ms: stampMs(name) });
      }
    }
    for (const q of questions) {
      if (answered.has(q.id)) continue;
      if (q.ms !== null && now.getTime() - q.ms > QUESTION_AGING_AFTER_MS) {
        warn(
          path.join(rel, `${q.id}.md`),
          `unanswered question to ${q.to.join(", ")} aging >7 days in an open thread`,
        );
      }
    }
  }

  const presenceDir = path.join(forumDir, "presence");
  for (const ent of listDir(presenceDir)) {
    if (!ent.isFile() || !ent.name.endsWith(".md")) continue;
    const sep = ent.name.indexOf("--");
    if (sep <= 0) continue;
    const fnMachine = ent.name.slice(0, sep);
    const rec = readRecord(path.join(presenceDir, ent.name));
    const declared = rec.data["machine"];
    if (typeof declared === "string" && declared !== fnMachine) {
      warn(
        path.join("_project", "forum", "presence", ent.name),
        `presence filename machine (${fnMachine}) disagrees with frontmatter (${declared})`,
      );
    }
  }

  // --- git posture stamp (§6.1; propose, never execute) ---
  const gitignorePath = path.join(p, ".gitignore");
  const gi = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf8") : null;
  if (gi === null) {
    warn(path.join("_project", ".gitignore"), "missing git-posture stamp — propose `projects init`-style .gitignore (forum/presence/, automations/*/logs/, /archive/)");
  } else {
    const wanted = ["forum/presence/", "automations/*/logs/", "/archive/"];
    const missing = wanted.filter((w) => !gi.includes(w));
    if (missing.length > 0) {
      warn(path.join("_project", ".gitignore"), `git-posture stamp incomplete — missing: ${missing.join(", ")}`);
    }
    // The UNANCHORED `archive/` pattern (the pre-fix stamp / the PRD §6.1
    // example verbatim) git-ignores tasks/archive/ and forum/threads/archive/
    // at any depth — archived records silently fall out of git, violating
    // §4.8/§11.4 ("archived records get committed homes"). Propose anchoring.
    const unanchored = gi
      .split(/\r?\n/)
      .some((line) => line.trim() === "archive/");
    if (unanchored) {
      warn(
        path.join("_project", ".gitignore"),
        "git-posture stamp has an UNANCHORED `archive/` pattern — it also ignores tasks/archive/ and " +
          "forum/threads/archive/ (committed retention homes, §4.8); propose replacing it with `/archive/`",
      );
    }
  }

  // --- automation manifests (PRD §7/§10) ---
  // Validation errors ARE doctor findings (validation as enforcement, R3):
  // bare secret values (§7.5 hard error), schedule/run shape, cron syntax,
  // missing declared machines, name drift — all from the one validator that
  // also gates `apply`. The resolver-coverage check stays workspace-level
  // (it needs the resolver map). Valid manifests additionally get their
  // [signature] file/directory paths existence-checked (annotation in the
  // manifest; the path is relative to the WORKSPACE root, falling back to
  // the project root outside any workspace).
  const sigBase = findWorkspaceRoot(projectRoot) ?? projectRoot;
  for (const ent of listDir(path.join(p, "automations"))) {
    if (!ent.isDirectory()) continue;
    const manifestPath = path.join(p, "automations", ent.name, "automation.toml");
    if (!fs.existsSync(manifestPath)) continue;
    const manifestRel = path.join("_project", "automations", ent.name, "automation.toml");
    let raw: Record<string, unknown>;
    try {
      raw = readTomlIfExists(manifestPath);
    } catch {
      err(manifestRel, "unparseable automation.toml");
      continue;
    }
    const { manifest, problems, warnings: manifestWarnings } = validateManifest(raw, { dirName: ent.name });
    for (const prob of problems) err(manifestRel, prob.message);
    for (const w of manifestWarnings) warn(manifestRel, w.message);
    if (manifest !== null) {
      // Runtime v2 distinguishes provider-neutral payload kind from scheduler
      // semantics. skip/catch-up basics are managed-runner semantics; the
      // reserved policies below are accepted in manifests but not supported by
      // the current runner/scheduler.
      if (manifest.schedule.missPolicy === "fail-loud" || manifest.schedule.missPolicy === "coalesce") {
        warn(
          manifestRel,
          `miss_policy = "${manifest.schedule.missPolicy}" is reserved for Automation Runtime v2 ` +
            `and is not currently enforced by the managed runner`,
        );
      }
      if (manifest.run.overlapPolicy === "queue" || manifest.run.overlapPolicy === "coalesce" || manifest.run.overlapPolicy === "fail-loud") {
        warn(
          manifestRel,
          `[run] overlap_policy = "${manifest.run.overlapPolicy}" is reserved for Automation Runtime v2 ` +
            `and is not currently enforced by the managed runner (current support is skip or allow with max_concurrency)`,
        );
      }
      if (manifest.run.directExec) {
        if (tableHas(raw["schedule"], "misfire_grace_seconds")) {
          warn(
            manifestRel,
            "[schedule] misfire_grace_seconds is managed-runner catch-up semantics and has no effect with direct_exec = true",
          );
        }
        if (tableHas(raw["schedule"], "max_catch_up")) {
          warn(
            manifestRel,
            "[schedule] max_catch_up is managed-runner catch-up semantics and has no effect with direct_exec = true",
          );
        }
        if (tableHas(raw["run"], "max_concurrency")) {
          warn(
            manifestRel,
            "[run] max_concurrency is managed-runner overlap semantics and has no effect with direct_exec = true",
          );
        }
      }
      for (const sig of [...manifest.signature.inputs, ...manifest.signature.outputs]) {
        if ((sig.type === "file" || sig.type === "directory") && sig.path !== null) {
          if (!fs.existsSync(path.resolve(sigBase, sig.path))) {
            warn(manifestRel, `[signature] path missing: ${sig.path} (${sig.name})`);
          }
        }
      }
    }
  }

  // --- git-posture reconciliation (§6.1; propose, never execute) ---
  // Only meaningful inside a git repo; quietly skipped otherwise.
  if (gitText(["rev-parse", "--is-inside-work-tree"], projectRoot)?.trim() === "true") {
    // _project/id itself git-ignored → the project never made the allowlist
    try {
      execFileSync("git", ["check-ignore", "-q", "--", "_project/id"], {
        cwd: projectRoot,
        stdio: "ignore",
      });
      warn(
        path.join("_project", "id"),
        "_project/id is git-ignored — the project is not tracked; propose adding the root .gitignore allowlist stanza",
      );
    } catch {
      // exit 1 = not ignored (good); exit 128 = no git context — both fine
    }
    // tracked files matching the stamped should-ignore patterns
    const tracked = gitText(["ls-files", "--", "_project"], projectRoot);
    if (tracked !== null) {
      const shouldIgnore = [
        /^_project\/forum\/presence\//,
        /^_project\/automations\/[^/]+\/logs\//,
        /^_project\/archive\//,
      ];
      for (const file of tracked.split("\n")) {
        if (file !== "" && shouldIgnore.some((re) => re.test(file))) {
          warn(file, "tracked but should be ignored per the git-posture stamp — propose `git rm --cached`");
        }
      }
    }
  }

  // --- doc-currency over the stamped orientation artifacts (R2/R3, §10) ---
  for (const relDoc of ["README.md", path.join("forum", "README.md")]) {
    const docPath = path.join(p, relDoc);
    const text = fs.existsSync(docPath) ? fs.readFileSync(docPath, "utf8") : null;
    if (text === null) continue;
    for (const f of checkDocCurrency(text)) {
      warn(path.join("_project", relDoc), `doc-currency: ${f.reason} (\`${f.snippet}\`)`);
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Workspace checks
// ---------------------------------------------------------------------------

/**
 * "name 2.md" beside "name.md" — the macOS/iCloud duplicate pattern.
 *
 * `.git/` is scanned DESPITE being in the discovery ignore list (PRD §5.5 /
 * §10, revision 3): the workspace repo's .git sits inside iCloud Drive, so
 * conflict artifacts under it corrupt git itself — the one place the scan
 * matters most. The ignore list still bounds everything else (node_modules…).
 */
function conflictArtifacts(root: string, ignore: Set<string>): string[] {
  const found: string[] = [];
  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > 8) return;
    const entries = listDir(dir);
    const names = new Set(entries.map((e) => e.name));
    for (const ent of entries) {
      const entRel = rel === "" ? ent.name : path.join(rel, ent.name);
      if (ent.isFile()) {
        const m = /^(.*) \d+(\.[A-Za-z0-9]+)?$/.exec(ent.name);
        if (m !== null && names.has(`${m[1]}${m[2] ?? ""}`)) found.push(entRel);
        if (/conflicted copy/i.test(ent.name)) found.push(entRel);
      } else if (ent.isDirectory()) {
        if (ent.name !== ".git" && ignore.has(ent.name)) continue;
        walk(path.join(dir, ent.name), entRel, depth + 1);
      }
    }
  };
  walk(root, "", 0);
  return found;
}

/** Scan automations manifests for secret-pointer schemes without resolvers. */
function unresolvedSecretSchemes(ws: Workspace, projects: ProjectInfo[]): DoctorIssue[] {
  const issues: DoctorIssue[] = [];
  const resolvers = ws.config.secrets.resolvers;
  for (const proj of projects) {
    const autoDir = path.join(proj.root, "_project", "automations");
    for (const ent of listDir(autoDir)) {
      if (!ent.isDirectory()) continue;
      const manifestPath = path.join(autoDir, ent.name, "automation.toml");
      if (!fs.existsSync(manifestPath)) continue;
      let manifest: Record<string, unknown>;
      try {
        manifest = readTomlIfExists(manifestPath);
      } catch {
        continue; // unparseable manifest is the automation phase's concern
      }
      const secrets = manifest["secrets"];
      if (secrets === null || typeof secrets !== "object") continue;
      for (const value of Object.values(secrets as Record<string, unknown>)) {
        if (typeof value !== "string") continue;
        const m = /^([a-z][a-z0-9+.-]*):\/\//.exec(value);
        if (m !== null && resolvers[m[1] as string] === undefined) {
          issues.push({
            severity: "warn",
            project: proj.relPath,
            file: path.join("_project", "automations", ent.name, "automation.toml"),
            message: `secret scheme "${m[1]}" has no resolver in workspace config (secrets.resolvers)`,
          });
        }
      }
    }
  }
  return issues;
}

/**
 * Automation placement drift + orphaned activations (PRD §7.1/§10), read
 * purely from the synced tree: manifests declare intent (`machines = [...]`);
 * each machine's `.openworkspace/machines/<id>.toml` reports its activations.
 * Both drift directions are checkable from any machine with no access to
 * another machine's App Support store — declared-but-not-activated (the
 * manifest names a machine whose registry shows nothing) and
 * activated-but-undeclared (a registry shows an activation the manifest no
 * longer declares), plus orphans (a registry activation whose project UID
 * resolves nowhere in this workspace). Warnings: doctor proposes
 * (`apply` / `deactivate` / `prune`), never executes.
 */
export function automationPlacementIssues(ws: Workspace, projects: ProjectInfo[]): DoctorIssue[] {
  const issues: DoctorIssue[] = [];
  const byUid = new Map(projects.map((proj) => [proj.uid, proj]));

  // machine-id → its registry's activations
  const machinesDir = path.join(ws.root, ".openworkspace", "machines");
  const registries = new Map<string, Array<{ project_uid: string; name: string }>>();
  for (const ent of listDir(machinesDir)) {
    if (!ent.isFile() || !ent.name.endsWith(".toml")) continue;
    const machine = ent.name.slice(0, -5);
    let reg: Record<string, unknown>;
    try {
      reg = readTomlIfExists(path.join(machinesDir, ent.name));
    } catch {
      continue; // unparseable registry already warned by the heartbeat check
    }
    const activations: Array<{ project_uid: string; name: string }> = [];
    if (Array.isArray(reg["activations"])) {
      for (const a of reg["activations"]) {
        if (a !== null && typeof a === "object" && !Array.isArray(a)) {
          const t = a as Record<string, unknown>;
          if (typeof t["project_uid"] === "string" && typeof t["name"] === "string") {
            activations.push({ project_uid: t["project_uid"], name: t["name"] });
          }
        }
      }
    }
    registries.set(machine, activations);
  }

  // manifests → declared placement, indexed by (uid, name)
  const declared = new Map<string, string[]>(); // `${uid}--${name}` → machines
  // present-but-INVALID definitions: their validation errors come from
  // doctorProject, but they must NOT be misdiagnosed below as "definition is
  // gone from the tree" (deactivating over a manifest typo is the wrong cure).
  const presentInvalid = new Set<string>(); // `${uid}--${name}`
  for (const proj of projects) {
    for (const entry of scanManifests(proj.root)) {
      if (entry.manifest === null) {
        presentInvalid.add(`${proj.uid}--${entry.name}`);
        continue; // validation errors come from doctorProject
      }
      const m = entry.manifest;
      declared.set(`${proj.uid}--${m.name}`, m.machines);
      const manifestRel = path.join("_project", "automations", entry.name, "automation.toml");
      for (const machine of m.machines) {
        const acts = registries.get(machine);
        const active = acts?.some((a) => a.project_uid === proj.uid && a.name === m.name) === true;
        if (!active) {
          issues.push({
            severity: "warn",
            project: proj.relPath,
            file: manifestRel,
            message:
              acts === undefined
                ? `placement drift: "${m.name}" declares machine "${machine}" which has no registry — run \`projects automation apply ${m.name}\` there`
                : `placement drift: "${m.name}" declared for "${machine}" but its registry shows no activation — run \`projects automation apply ${m.name}\` there`,
          });
        }
      }
    }
  }

  // registries → manifests: undeclared activations + orphans
  for (const [machine, activations] of registries) {
    for (const a of activations) {
      const proj = byUid.get(a.project_uid);
      if (proj === undefined) {
        issues.push({
          severity: "warn",
          project: null,
          file: path.join(".openworkspace", "machines", `${machine}.toml`),
          message: `orphaned activation: "${a.name}" on "${machine}" references project UID ${a.project_uid}, which resolves nowhere in this workspace — \`projects automation prune\` there`,
        });
        continue;
      }
      const machines = declared.get(`${a.project_uid}--${a.name}`);
      if (machines === undefined) {
        if (presentInvalid.has(`${a.project_uid}--${a.name}`)) {
          issues.push({
            severity: "warn",
            project: proj.relPath,
            file: path.join("_project", "automations", a.name, "automation.toml"),
            message: `active automation "${a.name}" on "${machine}" has a present-but-INVALID manifest — every fire will fail until automation.toml is fixed (the validation errors are listed above); do NOT deactivate`,
          });
          continue;
        }
        issues.push({
          severity: "warn",
          project: proj.relPath,
          file: path.join(".openworkspace", "machines", `${machine}.toml`),
          message: `orphaned activation: "${a.name}" is active on "${machine}" but its definition is gone from the tree — \`projects automation deactivate ${a.name}\` there`,
        });
      } else if (!machines.includes(machine)) {
        issues.push({
          severity: "warn",
          project: proj.relPath,
          file: path.join("_project", "automations", a.name, "automation.toml"),
          message: `placement drift: "${a.name}" is active on "${machine}" but machines = [${machines.map((x) => `"${x}"`).join(", ")}] — deactivate there or declare it`,
        });
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Runner posture + grant staleness (decision-1, PRD §7.4)
// ---------------------------------------------------------------------------

/** Injectable seam over system binaries (codesign, sqlite3). Tests fake it. */
export interface ExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
}
export type ExecFn = (cmd: string, args: string[]) => ExecResult;

/** The real seam: spawnSync against the system binary, never throwing. */
export function realExec(cmd: string, args: string[]): ExecResult {
  const result = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error !== undefined) return { status: null, stdout: "", stderr: result.error.message };
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

export interface RunnerPostureOptions {
  /** This machine's store — activations + the configured runner-node. */
  store: MachineStore;
  exec?: ExecFn;
  /** Override for tests; default = the real user TCC database. */
  tccDbPath?: string;
  /** Override for tests; default = ~/.local/bin/claude. */
  claudeBinPath?: string;
}

const TCC_QUERY =
  "SELECT client FROM access WHERE service = 'kTCCServiceSystemPolicyDocumentsFolder' " +
  "AND client_type = 1 AND auth_value = 2 AND client LIKE '%claude%';";

/**
 * decision-1 (PRD §7.4) posture checks — workspace-level, MACHINE-LOCAL
 * facts (this machine's activations, runner-node, TCC state). All
 * best-effort: a probe that cannot run emits an info-level "unverifiable"
 * finding, never an error.
 *
 *  - runner-node-unset: automations are activated here but no runner-node is
 *    configured → plists invoke whatever node ran apply (not a durable grant
 *    identity) → warn.
 *  - runner-node-provenance: the configured runner-node lives in a Homebrew
 *    Cellar, or `codesign -dv --verbose=2` fails / shows an ad-hoc or
 *    non-Developer-ID identity → warn (the TCC grant breaks on every update;
 *    decision-1 calls for the official nodejs.org pkg build).
 *  - claude-grant-staleness: claude's Documents-folder grant is path-keyed
 *    per VERSION; resolve the current claude version from the
 *    ~/.local/bin/claude symlink target and check the TCC db (via sqlite3)
 *    for a path-keyed allow row matching it. No matching row → warn
 *    (re-seed needed — one supervised prompt). Unreadable db / no version →
 *    info "unverifiable".
 */
export function runnerPostureIssues(options: RunnerPostureOptions): DoctorIssue[] {
  const issues: DoctorIssue[] = [];
  const exec = options.exec ?? realExec;
  const push = (severity: DoctorSeverity, message: string) =>
    issues.push({ severity, project: null, file: null, message });

  const activations = readActivationRecords(options.store);
  const runnerNode = readRunnerNode(options.store);

  // (a) runner-node-unset — only meaningful where something is activated
  if (activations.length > 0 && runnerNode === null) {
    push(
      "warn",
      "runner-node-unset: automations are activated on this machine but no runner-node is configured — " +
        "plists fall back to the current node, which is not a durable TCC grant identity; " +
        "configure `projects home runner-node <path>` (decision-1: the official nodejs.org pkg build " +
        "at a fixed path) and re-apply",
    );
  }

  // (b) runner-node-provenance — checks the CONFIGURED binary's grant identity
  if (runnerNode !== null) {
    if (runnerNode.includes(`${path.sep}Cellar${path.sep}`)) {
      push(
        "warn",
        `runner-node-provenance: ${runnerNode} is a Homebrew Cellar path — Homebrew node builds are ` +
          "ad-hoc-signed and move on every upgrade, so the TCC grant breaks on update; decision-1 " +
          "calls for a dedicated copy of the official nodejs.org pkg build at a fixed path",
      );
    } else {
      const res = exec("codesign", ["-dv", "--verbose=2", runnerNode]);
      // codesign writes its details to stderr; combine for parsing.
      const out = `${res.stdout}\n${res.stderr}`;
      const adhoc = /Signature=adhoc/.test(out) || /flags=0x[0-9a-f]+\s*\(adhoc\)/i.test(out);
      const stableAuthority = /^Authority=(Developer ID|Software Signing|Apple)/m.test(out);
      if (res.status !== 0) {
        push(
          "warn",
          `runner-node-provenance: \`codesign -dv\` failed for ${runnerNode} (unsigned or unreadable) — ` +
            "an unsigned binary has no stable TCC grant identity; use the official nodejs.org pkg build (decision-1)",
        );
      } else if (adhoc || !stableAuthority) {
        push(
          "warn",
          `runner-node-provenance: ${runnerNode} has an ad-hoc/unstable signature (no Developer ID ` +
            "Authority) — the TCC grant breaks on update; decision-1 calls for the official nodejs.org pkg build",
        );
      }
    }
  }

  // (c) claude-grant-staleness — only meaningful where automations fire
  if (activations.length > 0) {
    const claudeBin = options.claudeBinPath ?? path.join(os.homedir(), ".local", "bin", "claude");
    let target: string | null = null;
    try {
      target = fs.realpathSync(claudeBin);
    } catch {
      target = null; // no claude installed here: nothing to go stale
    }
    if (target !== null) {
      const version = /\d+\.\d+\.\d+/.exec(target)?.[0] ?? null;
      const db =
        options.tccDbPath ??
        path.join(os.homedir(), "Library", "Application Support", "com.apple.TCC", "TCC.db");
      const res = exec("sqlite3", ["-readonly", db, TCC_QUERY]);
      if (res.status !== 0) {
        push(
          "info",
          "claude-grant-staleness: unverifiable — sqlite3 could not read the user TCC db " +
            `(${db}); the path-keyed Documents-folder grant cannot be checked from here`,
        );
      } else if (version === null) {
        push(
          "info",
          `claude-grant-staleness: unverifiable — cannot extract a version segment from the claude ` +
            `binary target (${target})`,
        );
      } else {
        const rows = res.stdout.split("\n").filter((line) => line.trim() !== "");
        if (!rows.some((row) => row.includes(version))) {
          push(
            "warn",
            `claude-grant-staleness: no path-keyed Documents-folder grant matches the current claude ` +
              `(${version}) — the grant is path-keyed per version and has gone stale on update ` +
              "(decision-1); re-seed with one supervised Documents-folder prompt",
          );
        }
      }
    }
  }

  return issues;
}

export interface DoctorWorkspaceOptions {
  now?: Date;
  /** When provided, the decision-1 runner-posture checks run against it. */
  store?: MachineStore;
  exec?: ExecFn;
  tccDbPath?: string;
  claudeBinPath?: string;
}

/**
 * Project-graph invariants over the `[[owns]]` edges (project-graph feature).
 * All five are workspace-level (they need cross-project edge data):
 *   a. dangling edge        — a subproject/path ref that resolves to nothing
 *   b. cycle                — an ownership loop over in-ws projects
 *   c. parent/child disagreement — physical FS nesting with no declared edge
 *   d. duplicate ownership  — one SUBPROJECT child owned by >1 parent (code/
 *      remote children may be shared, so they are exempt)
 *   e. ~/code name collision — two DISTINCT kind:"code" children (different
 *      resolved identities) sharing a bare name (the same shared child is fine)
 * Plus: malformed-edge parse problems surface as warnings.
 */
function ownsGraphIssues(ws: Workspace, all: ProjectInfo[]): DoctorIssue[] {
  const issues: DoctorIssue[] = [];
  const graph = buildOwnershipGraph(ws);

  // malformed-edge parse problems → warn (already prefixed with owner relPath)
  for (const p of graph.problems) {
    issues.push({
      severity: "warn",
      project: null,
      file: path.join("_project", "project.toml"),
      message: `malformed owns edge: ${p}`,
    });
  }

  // (a) dangling edge: missing always; not-a-project only for kind:"subproject"
  //     (a bare repo for kind:"code" is the EXPECTED healthy state). Remote is
  //     never flagged (no FS to check).
  for (const node of graph.nodes) {
    for (const e of node.edges) {
      const dangling =
        e.status === "missing" ||
        (e.status === "not-a-project" && e.edge.kind === "subproject");
      if (dangling) {
        issues.push({
          severity: "error",
          project: node.owner.relPath,
          file: path.join("_project", "project.toml"),
          message: `${node.owner.relPath}: dangling owns edge — ${e.edge.ref} (${e.edge.kind}) resolves to ${e.status}`,
        });
      }
    }
  }

  // (b) cycle: directed adjacency over in-ws nodes (owner relPath → child
  //     relPaths where a UID is present). Emit once.
  const adj = new Map<string, string[]>();
  const ensure = (k: string): string[] => {
    let l = adj.get(k);
    if (l === undefined) {
      l = [];
      adj.set(k, l);
    }
    return l;
  };
  for (const node of graph.nodes) {
    ensure(node.owner.relPath);
    for (const e of node.edges) {
      if (e.uid !== null && e.localPath !== null) {
        ensure(node.owner.relPath).push(path.relative(ws.root, e.localPath));
      }
    }
  }
  const cycle = detectCycle(adj);
  if (cycle !== null) {
    issues.push({
      severity: "error",
      project: null,
      file: null,
      message: `ownership cycle: ${cycle.join(" -> ")}`,
    });
  }

  // (c) parent/child disagreement: a project physically nested under another
  //     (ProjectInfo.nestedUnder) where the enclosing project declares NO owns
  //     edge to it. Nesting without a declared edge → warn.
  const ownedRoots = new Map<string, Set<string>>(); // owner root → set of child roots (resolved)
  for (const node of graph.nodes) {
    const set = new Set<string>();
    for (const e of node.edges) {
      if (e.localPath !== null) set.add(path.resolve(e.localPath));
    }
    ownedRoots.set(path.resolve(node.owner.root), set);
  }
  for (const child of all) {
    if (child.nestedUnder === null) continue;
    const parentRoot = path.resolve(child.nestedUnder);
    const declared = ownedRoots.get(parentRoot);
    if (declared === undefined || !declared.has(path.resolve(child.root))) {
      const parent = all.find((p) => path.resolve(p.root) === parentRoot);
      const parentRel = parent !== undefined ? parent.relPath : child.nestedUnder;
      issues.push({
        severity: "warn",
        project: child.relPath,
        file: null,
        message: `${child.relPath}: physically nested under ${parentRel} but no owns edge declares it`,
      });
    }
  }

  // (d) duplicate ownership — SUBPROJECTS ONLY. Per the project-graph design,
  //     code/remote children MAY be multiply-owned (shared across parents is
  //     legal and intended); only `subproject` children are single-owner. So a
  //     child is flagged only when >1 parent owns it via a `subproject` edge.
  //     (Aggregations de-dupe shared children by identity elsewhere; sharing is
  //     not itself a violation for code/remote.)
  const subprojectOwners = new Map<string, string[]>(); // child uid → owner relPaths (subproject edges only)
  for (const node of graph.nodes) {
    for (const e of node.edges) {
      if (e.uid === null || e.edge.kind !== "subproject") continue;
      const list = subprojectOwners.get(e.uid);
      if (list === undefined) subprojectOwners.set(e.uid, [node.owner.relPath]);
      else list.push(node.owner.relPath);
    }
  }
  for (const [uid, owners] of subprojectOwners) {
    if (owners.length > 1) {
      // Resolve the child's relPath for the message.
      const child = all.find((p) => p.uid === uid);
      const childRel = child !== undefined ? child.relPath : uid;
      issues.push({
        severity: "error",
        project: null,
        file: null,
        message: `${childRel}: owned by multiple parents (${owners.join(", ")})`,
      });
    }
  }

  // (e) ~/code name collision — keyed on resolved child IDENTITY, not the bare
  //     name. The SAME code child (same resolved path / URL) referenced by
  //     multiple parents is LEGAL and silent — sharing is intended. A genuine
  //     collision is TWO DISTINCT children (different resolved identities)
  //     sharing the same display name; only that is flagged.
  const codeNameIdentities = new Map<string, Set<string>>(); // bare name → set of distinct child identities
  for (const node of graph.nodes) {
    for (const e of node.edges) {
      if (e.edge.kind !== "code") continue;
      const bare = e.edge.name ?? path.basename(e.localPath ?? e.edge.ref);
      const identity = e.localPath !== null ? path.resolve(e.localPath) : e.edge.ref;
      let set = codeNameIdentities.get(bare);
      if (set === undefined) {
        set = new Set<string>();
        codeNameIdentities.set(bare, set);
      }
      set.add(identity);
    }
  }
  for (const [name, identities] of codeNameIdentities) {
    if (identities.size > 1) {
      issues.push({
        severity: "error",
        project: null,
        file: null,
        message: `code-child name collision: ${name} used by ${[...identities].join(", ")}`,
      });
    }
  }

  return issues;
}

/** Workspace-level checks only (no per-project recursion). */
export function doctorWorkspaceOnly(
  ws: Workspace,
  projects?: ProjectInfo[],
  options: DoctorWorkspaceOptions = {},
): DoctorIssue[] {
  const issues: DoctorIssue[] = [];
  const all = projects ?? discoverProjects(ws, { all: true });

  // shelf paths resolve (a renamed shelf must fail loudly)
  const shelves: Array<{ rel: string; def: string }> = [
    { rel: ws.config.paths.dormant, def: DEFAULT_DORMANT },
    { rel: ws.config.paths.archives, def: DEFAULT_ARCHIVES },
  ];
  for (const shelf of shelves) {
    const abs = path.resolve(ws.root, shelf.rel);
    const exists = fs.existsSync(abs) && fs.statSync(abs).isDirectory();
    if (!exists && shelf.rel !== shelf.def) {
      issues.push({
        severity: "error",
        project: null,
        file: shelf.rel,
        message: `dangling shelf path: configured "${shelf.rel}" does not exist`,
      });
    }
    if (exists && readProjectUid(abs) !== null) {
      issues.push({
        severity: "error",
        project: null,
        file: shelf.rel,
        message: `shelf root initialized as a project (has _project/id): ${shelf.rel}`,
      });
    }
  }

  // duplicate project UIDs (iCloud copy / merge backstop)
  for (const [uid, roots] of findDuplicateUids(all)) {
    issues.push({
      severity: "error",
      project: null,
      file: null,
      message: `duplicate project uid ${uid}: ${roots.join(", ")}`,
    });
  }

  // ----- project graph: [[owns]] edge invariants (project-graph feature) -----
  // The edge is canonical on the parent; the graph is built fresh from the live
  // tree + declarations. Doctor proposes, never mutates.
  issues.push(...ownsGraphIssues(ws, all));

  // decision-2: declared-lifecycle validity + location⟷metadata drift. The
  // metadata is the source of truth; location is a derived view. Doctor REPORTS
  // drift and points at `reconcile` (it never heals — doctor proposes, §10).
  //  - an unknown declared lifecycle value → error (a schema invariant).
  //  - effective metadata ≠ location, with auto-safe healing → warn (run reconcile).
  //  - ambiguous drift (no tombstone-honest tiebreak) → info (needs a human).
  for (const proj of all) {
    const declared = readDeclaredLifecycle(proj.root);
    if (declared.problem !== null) {
      issues.push({
        severity: "error",
        project: proj.relPath,
        file: path.join("_project", "project.toml"),
        message: `declared lifecycle invalid: ${declared.problem}`,
      });
    }
  }
  // The drift detection shares the reconcile planner (so "what doctor warns
  // about" and "what reconcile fixes" can never diverge). It needs the
  // machine-local store for the intent-log tiebreaker, so — like the runner
  // posture checks — it runs only when a store is provided.
  if (options.store !== undefined) {
    const plan = reconcilePlan(ws, options.store);
    const lifecycleActions = plan.actions.filter(
      (a) => a.kind === "revert-location" || a.kind === "heal-metadata",
    );
    if (lifecycleActions.length > 0) {
      issues.push({
        severity: "warn",
        project: null,
        file: null,
        message: `location/metadata lifecycle drift on ${lifecycleActions.length} project(s) — run \`projects reconcile\``,
      });
    }
    const recordActions = plan.actions.filter(
      (a) => a.kind !== "revert-location" && a.kind !== "heal-metadata",
    );
    if (recordActions.length > 0) {
      issues.push({
        severity: "warn",
        project: null,
        file: null,
        message: `${recordActions.length} resurrected/duplicate record artifact(s) (iCloud copy/ghost-dir) — run \`projects reconcile\``,
      });
    }
    for (const amb of plan.ambiguous) {
      issues.push({
        severity: "info",
        project: amb.project,
        file: null,
        message: `ambiguous lifecycle drift (metadata=${amb.declared}, location=${amb.located}) — ${amb.suggestion}`,
      });
    }
    for (const e of plan.errors) {
      issues.push({ severity: "error", project: null, file: null, message: `reconcile: ${e}` });
    }
  }

  // sync-conflict artifacts (duplicate-suffix files beside their original)
  for (const rel of conflictArtifacts(ws.root, new Set(ws.config.discovery.ignore))) {
    issues.push({
      severity: "error",
      project: null,
      file: rel,
      message: "sync-conflict artifact (duplicate-suffixed copy beside the original) — reconcile by hand, never auto-merge",
    });
  }

  // machine-registry heartbeat staleness (.openworkspace/machines/<id>.toml)
  const machinesDir = path.join(ws.root, ".openworkspace", "machines");
  const nowMs = (options.now ?? new Date()).getTime();
  for (const ent of listDir(machinesDir)) {
    if (!ent.isFile() || !ent.name.endsWith(".toml")) continue;
    const rel = path.join(".openworkspace", "machines", ent.name);
    let reg: Record<string, unknown>;
    try {
      reg = readTomlIfExists(path.join(machinesDir, ent.name));
    } catch {
      issues.push({ severity: "warn", project: null, file: rel, message: "unparseable machine registry file" });
      continue;
    }
    const hb = reg["heartbeat"];
    const hbMs = typeof hb === "string" ? Date.parse(hb) : hb instanceof Date ? hb.getTime() : Number.NaN;
    if (Number.isNaN(hbMs)) {
      issues.push({ severity: "warn", project: null, file: rel, message: "machine registry has no parseable heartbeat" });
    } else if (nowMs - hbMs > HEARTBEAT_STALE_AFTER_MS) {
      const days = Math.floor((nowMs - hbMs) / 86_400_000);
      issues.push({
        severity: "warn",
        project: null,
        file: rel,
        message: `machine registry heartbeat stale (${days} days) — the machine may be down or out of sync`,
      });
    }
  }

  // stale `git worktree` registrations (propose prune; §6.3 also wants
  // worktrees OUTSIDE the workspace root)
  const porcelain = gitText(["worktree", "list", "--porcelain"], ws.root);
  if (porcelain !== null) {
    // realpath both sides: git reports resolved paths (/private/var vs /var)
    const wsReal = (() => {
      try {
        return fs.realpathSync(ws.root);
      } catch {
        return path.resolve(ws.root);
      }
    })();
    const blocks = porcelain.split("\n\n").filter((b) => b.trim() !== "");
    for (const block of blocks.slice(1)) {
      // first block = the main checkout
      const m = /^worktree (.+)$/m.exec(block);
      if (m === null) continue;
      const wtPath = m[1] as string;
      const prunable = /^prunable\b/m.test(block);
      if (prunable || !fs.existsSync(wtPath)) {
        issues.push({
          severity: "warn",
          project: null,
          file: null,
          message: `stale git worktree registration (${wtPath}) — propose \`git worktree prune\``,
        });
      } else if (!path.relative(wsReal, wtPath).startsWith("..")) {
        issues.push({
          severity: "warn",
          project: null,
          file: null,
          message: `git worktree inside the workspace root (${wtPath}) — worktrees live outside the synced tree (PRD §6.3)`,
        });
      }
    }
  }

  // doc-currency over the shipped using-openworkspace skill (R2/R3, §10) —
  // the skill ships with the package; the per-project stamped READMEs are
  // checked in doctorProject.
  const skillPath = path.resolve(__dirname, "..", "..", "skills", "using-openworkspace", "SKILL.md");
  if (fs.existsSync(skillPath)) {
    const text = fs.readFileSync(skillPath, "utf8");
    for (const f of checkDocCurrency(text)) {
      issues.push({
        severity: "warn",
        project: null,
        file: skillPath,
        message: `doc-currency: ${f.reason} (\`${f.snippet}\`)`,
      });
    }
  }

  issues.push(...unresolvedSecretSchemes(ws, all));
  issues.push(...automationPlacementIssues(ws, all));

  // decision-1 runner posture (machine-local; only when a store is provided —
  // callers without one, e.g. pure-tree checks, skip these by construction)
  if (options.store !== undefined) {
    issues.push(
      ...runnerPostureIssues({
        store: options.store,
        ...(options.exec !== undefined ? { exec: options.exec } : {}),
        ...(options.tccDbPath !== undefined ? { tccDbPath: options.tccDbPath } : {}),
        ...(options.claudeBinPath !== undefined ? { claudeBinPath: options.claudeBinPath } : {}),
      }),
    );
  }
  return issues;
}

/** The full doctor pass: workspace checks + every project's checks. */
export function doctorWorkspace(ws: Workspace, options: DoctorWorkspaceOptions = {}): DoctorReport {
  const projects = discoverProjects(ws, { all: true });
  const issues = doctorWorkspaceOnly(ws, projects, options);
  for (const proj of projects) {
    issues.push(...doctorProject(proj.root, { relPath: proj.relPath, now: options.now }));
  }
  return report(issues);
}

/** Doctor for one project (CLI `projects doctor`). */
export function doctorProjectReport(
  projectRoot: string,
  options: { relPath?: string; now?: Date } = {},
): DoctorReport {
  return report(doctorProject(projectRoot, options));
}
