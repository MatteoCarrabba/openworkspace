/**
 * Forum — the coordination primitive (PRD §4.6, delivery semantics §6.3).
 *
 * Blackboard, not switchboard: threads are the only message home; one
 * immutable, uniquely named file per message (maildir borrow — identity in
 * the filename, atomic delivery, zero locks); presence is the `.plan` file;
 * inbox and recency are COMPUTED read-side, never stored.
 *
 * §6.3 rule: coordination rides the machine. EVERY verb here — reads AND
 * writes — resolves the project's canonical coordination home via
 * `resolveCanonicalProject`. Resolution failure is a loud ResolveError
 * (exit 2); there is no worktree-local fallback (that would split-brain the
 * forum).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { ConfigError, ConflictError, NotFoundError } from "../lib/errors.js";
import { createExclusive, ensureDir } from "../lib/fsatomic.js";
import {
  FrontmatterRecord,
  parseRecord,
  readRecord,
  serializeRecord,
  setBody,
  setFields,
  updateRecordFile,
  writeRecord,
} from "../lib/frontmatter.js";
import { MachineStore, machineId } from "../lib/machine.js";
import { resolveCanonicalProject } from "../lib/resolve.js";

// ---------------------------------------------------------------------------
// Context + identity

export interface ForumContext {
  /** Where the verb was invoked (worktree or canonical — resolution decides). */
  startDir: string;
  store: MachineStore;
  /** Identity environment (OW_ACTOR / USER). Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Injectable clock for tests. */
  now?: () => Date;
  /** Injectable message-suffix source for tests (4 chars [a-z0-9]). */
  rand?: () => string;
  /** Extra workspace roots for resolution (tests / already-open workspace). */
  extraWorkspaceRoots?: string[];
}

export const ACTOR_ENV = "OW_ACTOR";

// Participants land in filenames delimited by `--`; keep them parseable.
const ACTOR_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;

/** Identity chain (PRD §4.6): explicit param > OW_ACTOR > $USER. */
export function resolveActor(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = explicit ?? env[ACTOR_ENV] ?? env.USER;
  const actor = raw?.trim() ?? "";
  if (actor === "") {
    throw new ConfigError(
      "no participant identity: pass one explicitly (--as), set OW_ACTOR, or ensure $USER is set",
    );
  }
  if (!ACTOR_RE.test(actor) || actor.includes("--")) {
    throw new ConfigError(
      `invalid participant name "${actor}": use letters/digits/._@- and no "--"`,
    );
  }
  return actor;
}

function clock(ctx: ForumContext): Date {
  return (ctx.now ?? (() => new Date()))();
}

function actorEnv(ctx: ForumContext): NodeJS.ProcessEnv {
  return ctx.env ?? process.env;
}

// ---------------------------------------------------------------------------
// Canonical-home resolution (every verb routes through this)

export interface ForumPaths {
  uid: string;
  projectRoot: string; // canonical project root
  forumRoot: string;
  threadsDir: string;
  archiveDir: string;
  presenceDir: string;
}

function resolveForum(ctx: ForumContext): ForumPaths {
  const r = resolveCanonicalProject(ctx.startDir, ctx.store, {
    extraWorkspaceRoots: ctx.extraWorkspaceRoots,
  });
  const forumRoot = path.join(r.canonicalRoot, "_project", "forum");
  return {
    uid: r.uid,
    projectRoot: r.canonicalRoot,
    forumRoot,
    threadsDir: path.join(forumRoot, "threads"),
    archiveDir: path.join(forumRoot, "threads", "archive"),
    presenceDir: path.join(forumRoot, "presence"),
  };
}

// ---------------------------------------------------------------------------
// Shared formatting helpers

/** ISO-8601 UTC, second precision: 2026-06-10T14:02:31Z */
function isoUtc(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Compact UTC stamp for filenames: 20260610T140231Z */
function formatStamp(d: Date): string {
  return isoUtc(d).replace(/[-:]/g, "");
}

const STAMP_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;

function stampToMs(stamp: string): number | null {
  const m = STAMP_RE.exec(stamp);
  if (m === null) return null;
  const [, y, mo, d, h, mi, s] = m as unknown as [string, string, string, string, string, string, string];
  return Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
}

const RAND_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

function rand4(): string {
  const bytes = crypto.randomBytes(4);
  let out = "";
  for (let i = 0; i < 4; i++) out += RAND_CHARS[(bytes[i] as number) % RAND_CHARS.length];
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

/** Build a fresh record's full text from fields + body (no hand-rolled YAML). */
function recordText(fields: Record<string, unknown>, body: string): string {
  const rec = parseRecord("");
  const present: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null) present[k] = v;
  }
  setFields(rec, present);
  let text = body;
  if (text.length > 0 && !text.endsWith("\n")) text += "\n";
  setBody(rec, text);
  return serializeRecord(rec);
}

function asStringArray(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((x): x is string => typeof x === "string");
  return [];
}

function listDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Presence (PRD §4.6: announce = write own file; heartbeat = re-announce;
// depart = delete own file; staleness computed read-side; sweeps own-machine
// only)

export interface PresenceEntry {
  participant: string;
  machine: string;
  /** ISO timestamp of the last announce, null when unparseable. */
  announcedAt: string | null;
  /** The `.plan` body (free text), trimmed; null when empty. */
  plan: string | null;
  file: string;
}

function presenceFilePath(paths: ForumPaths, machine: string, actor: string): string {
  return path.join(paths.presenceDir, `${machine}--${actor}.md`);
}

/**
 * Announce presence (and heartbeat: re-announcing overwrites the same file —
 * this session is the sole writer of <machine>--<participant>.md).
 */
export function announce(
  ctx: ForumContext,
  options: { as?: string; plan?: string } = {},
): PresenceEntry {
  const paths = resolveForum(ctx);
  const actor = resolveActor(options.as, actorEnv(ctx));
  const machine = machineId(ctx.store);
  const ts = isoUtc(clock(ctx));
  const file = presenceFilePath(paths, machine, actor);
  // Sole-writer file: atomic replace (not wx) is the heartbeat semantics.
  const rec = parseRecord("");
  setFields(rec, { participant: actor, machine, ts });
  setBody(rec, options.plan !== undefined && options.plan !== "" ? options.plan.trimEnd() + "\n" : "");
  writeRecord(file, rec);
  return {
    participant: actor,
    machine,
    announcedAt: ts,
    plan: options.plan?.trim() || null,
    file,
  };
}

/** Delete own presence file. Returns false when it was already gone. */
export function depart(ctx: ForumContext, options: { as?: string } = {}): boolean {
  const paths = resolveForum(ctx);
  const actor = resolveActor(options.as, actorEnv(ctx));
  const file = presenceFilePath(paths, machineId(ctx.store), actor);
  try {
    fs.unlinkSync(file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

function readPresence(paths: ForumPaths): PresenceEntry[] {
  const out: PresenceEntry[] = [];
  for (const ent of listDir(paths.presenceDir)) {
    if (!ent.isFile() || !ent.name.endsWith(".md")) continue;
    const file = path.join(paths.presenceDir, ent.name);
    let rec: FrontmatterRecord;
    try {
      rec = readRecord(file);
    } catch {
      continue; // raced with a departing session
    }
    // Frontmatter is authoritative; the filename is a fallback.
    const sep = ent.name.indexOf("--");
    const fnMachine = sep > 0 ? ent.name.slice(0, sep) : null;
    const fnActor = sep > 0 ? ent.name.slice(sep + 2, -3) : null;
    const participant =
      typeof rec.data.participant === "string" ? rec.data.participant : fnActor;
    const machine = typeof rec.data.machine === "string" ? rec.data.machine : fnMachine;
    if (participant === null || machine === null) continue;
    const ts = typeof rec.data.ts === "string" && !Number.isNaN(Date.parse(rec.data.ts))
      ? rec.data.ts
      : null;
    const plan = rec.body.trim();
    out.push({ participant, machine, announcedAt: ts, plan: plan === "" ? null : plan, file });
  }
  return out;
}

export const PRESENCE_SWEEP_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // PRD: >7 days

/**
 * Sweep stale presence files — OWN-MACHINE ONLY (P15: sweeps never delete
 * another machine's files). Returns the removed paths.
 */
export function sweepPresence(
  ctx: ForumContext,
  options: { olderThanMs?: number } = {},
): string[] {
  const paths = resolveForum(ctx);
  const own = machineId(ctx.store);
  const cutoff = clock(ctx).getTime() - (options.olderThanMs ?? PRESENCE_SWEEP_AFTER_MS);
  const removed: string[] = [];
  for (const entry of readPresence(paths)) {
    if (entry.machine !== own) continue;
    let lastMs: number | null = entry.announcedAt !== null ? Date.parse(entry.announcedAt) : null;
    if (lastMs === null) {
      try {
        lastMs = fs.statSync(entry.file).mtimeMs;
      } catch {
        continue;
      }
    }
    if (lastMs < cutoff) {
      try {
        fs.unlinkSync(entry.file);
        removed.push(entry.file);
      } catch {
        // raced; fine
      }
    }
  }
  return removed;
}

export const THREAD_ARCHIVE_PROPOSAL_AFTER_MS = 30 * 24 * 60 * 60 * 1000; // PRD §4.6: >30 days

export interface SweepResult {
  /** Own-machine presence files actually removed (>7 days). */
  presenceRemoved: string[];
  /**
   * Resolved threads untouched >30 days — PROPOSED for `forum archive`,
   * never executed (PRD §4.6: the sweep *proposes* archive).
   */
  archiveProposals: ThreadInfo[];
}

/**
 * The §4.6 retention sweep: remove own-machine stale presence and propose
 * (only propose) archiving resolved threads untouched for >30 days.
 */
export function sweepForum(
  ctx: ForumContext,
  options: { presenceOlderThanMs?: number; archiveOlderThanMs?: number } = {},
): SweepResult {
  const presenceRemoved = sweepPresence(ctx, { olderThanMs: options.presenceOlderThanMs });
  const paths = resolveForum(ctx);
  const cutoff = clock(ctx).getTime() - (options.archiveOlderThanMs ?? THREAD_ARCHIVE_PROPOSAL_AFTER_MS);
  const archiveProposals: ThreadInfo[] = [];
  for (const dir of liveThreadDirs(paths)) {
    const info = threadInfoAt(dir, false);
    if (info.status !== "resolved") continue;
    const touched = [info.lastActivityAt, info.resolvedAt, info.openedAt]
      .map((ts) => (ts !== null ? Date.parse(ts) : Number.NaN))
      .filter((ms) => !Number.isNaN(ms));
    const lastTouched = touched.length > 0 ? Math.max(...touched) : null;
    if (lastTouched !== null && lastTouched < cutoff) archiveProposals.push(info);
  }
  return { presenceRemoved, archiveProposals };
}

// ---------------------------------------------------------------------------
// Threads

export type ThreadStatus = "open" | "resolved";

export interface ThreadInfo {
  /** Directory name: <YYYY-MM-DD>--<slug>. */
  name: string;
  dir: string;
  title: string | null;
  status: ThreadStatus;
  openedAt: string | null;
  openedBy: string | null;
  resolvedAt: string | null;
  archived: boolean;
  /** Recency computed from the lexically-last message filename (never stored). */
  lastActivityAt: string | null;
  messageCount: number;
}

const MESSAGE_FILE_RE = /^(\d{8}T\d{6}Z)--.+--[a-z0-9]{4}\.md$/;

function messageFilenames(threadDir: string): string[] {
  return listDir(threadDir)
    .filter((e) => e.isFile() && MESSAGE_FILE_RE.test(e.name))
    .map((e) => e.name)
    .sort(); // lexical order == chronological order (UTC stamp prefix)
}

function stampOf(filename: string): string {
  return filename.slice(0, filename.indexOf("--"));
}

function threadInfoAt(threadDir: string, archived: boolean): ThreadInfo {
  const name = path.basename(threadDir);
  let title: string | null = null;
  let status: ThreadStatus = "open";
  let openedAt: string | null = null;
  let openedBy: string | null = null;
  let resolvedAt: string | null = null;
  const metaPath = path.join(threadDir, "thread.md");
  if (fs.existsSync(metaPath)) {
    const rec = readRecord(metaPath); // forgiving read
    if (typeof rec.data.title === "string") title = rec.data.title;
    if (rec.data.status === "resolved") status = "resolved";
    if (typeof rec.data.opened === "string") openedAt = rec.data.opened;
    if (typeof rec.data.by === "string") openedBy = rec.data.by;
    if (typeof rec.data.resolved === "string") resolvedAt = rec.data.resolved;
  }
  const files = messageFilenames(threadDir);
  const lastFile = files.length > 0 ? files[files.length - 1] : undefined;
  const lastStamp = lastFile !== undefined ? stampOf(lastFile) : null;
  const lastMs = lastStamp !== null ? stampToMs(lastStamp) : null;
  return {
    name,
    dir: threadDir,
    title,
    status,
    openedAt,
    openedBy,
    resolvedAt,
    archived,
    lastActivityAt: lastMs !== null ? isoUtc(new Date(lastMs)) : null,
    messageCount: files.length,
  };
}

function liveThreadDirs(paths: ForumPaths): string[] {
  return listDir(paths.threadsDir)
    .filter((e) => e.isDirectory() && e.name !== "archive")
    .map((e) => path.join(paths.threadsDir, e.name))
    .sort();
}

function archivedThreadDirs(paths: ForumPaths): string[] {
  return listDir(paths.archiveDir)
    .filter((e) => e.isDirectory())
    .map((e) => path.join(paths.archiveDir, e.name))
    .sort();
}

/**
 * Find a thread by exact dir name or by slug (the part after `--`).
 * Ambiguous slug → ConflictError; nothing → NotFoundError.
 */
function findThreadDir(
  paths: ForumPaths,
  ref: string,
  options: { includeArchived?: boolean } = {},
): { dir: string; archived: boolean } {
  const live = liveThreadDirs(paths).map((dir) => ({ dir, archived: false }));
  const pool = options.includeArchived
    ? live.concat(archivedThreadDirs(paths).map((dir) => ({ dir, archived: true })))
    : live;
  const exact = pool.filter((c) => path.basename(c.dir) === ref);
  if (exact.length === 1 && exact[0] !== undefined) return exact[0];
  const bySlug = pool.filter((c) => {
    const name = path.basename(c.dir);
    const sep = name.indexOf("--");
    return sep > 0 && name.slice(sep + 2) === ref;
  });
  if (bySlug.length === 1 && bySlug[0] !== undefined) return bySlug[0];
  if (bySlug.length > 1) {
    throw new ConflictError(
      `thread reference "${ref}" is ambiguous: ${bySlug.map((c) => path.basename(c.dir)).join(", ")}`,
    );
  }
  throw new NotFoundError(`no thread matching "${ref}"`);
}

/**
 * Open a thread: atomic mkdir of <YYYY-MM-DD>--<slug>/ + exclusive thread.md.
 * Same-name collision is a clean ConflictError.
 */
export function openThread(
  ctx: ForumContext,
  options: { title: string; slug?: string; as?: string; body?: string },
): ThreadInfo {
  const paths = resolveForum(ctx);
  const actor = resolveActor(options.as, actorEnv(ctx));
  const slug = options.slug !== undefined ? slugify(options.slug) : slugify(options.title);
  if (slug === "") {
    throw new ConfigError(`cannot derive a slug from title "${options.title}"`);
  }
  const now = clock(ctx);
  const name = `${isoUtc(now).slice(0, 10)}--${slug}`;
  const threadDir = path.join(paths.threadsDir, name);
  ensureDir(paths.threadsDir);
  try {
    fs.mkdirSync(threadDir); // atomic creation = the thread's identity claim
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ConflictError(`thread already exists: ${name}`);
    }
    throw err;
  }
  createExclusive(
    path.join(threadDir, "thread.md"),
    recordText(
      { title: options.title, status: "open", opened: isoUtc(now), by: actor },
      options.body ?? "",
    ),
  );
  return threadInfoAt(threadDir, false);
}

/** List threads (live by default; archived included on request), oldest first. */
export function listThreads(
  ctx: ForumContext,
  options: { includeArchived?: boolean } = {},
): ThreadInfo[] {
  const paths = resolveForum(ctx);
  const out = liveThreadDirs(paths).map((d) => threadInfoAt(d, false));
  if (options.includeArchived) {
    out.push(...archivedThreadDirs(paths).map((d) => threadInfoAt(d, true)));
  }
  return out;
}

/**
 * Mark a thread resolved (thread.md is touched ONLY at open/resolve).
 * Already-resolved → ConflictError (the caller should know).
 */
export function resolveThread(ctx: ForumContext, threadRef: string): ThreadInfo {
  const paths = resolveForum(ctx);
  const found = findThreadDir(paths, threadRef);
  const metaPath = path.join(found.dir, "thread.md");
  if (!fs.existsSync(metaPath)) {
    throw new NotFoundError(`thread has no thread.md: ${found.dir}`);
  }
  const current = readRecord(metaPath);
  if (current.data.status === "resolved") {
    throw new ConflictError(`thread already resolved: ${path.basename(found.dir)}`);
  }
  updateRecordFile(metaPath, { status: "resolved", resolved: isoUtc(clock(ctx)) });
  return threadInfoAt(found.dir, found.archived);
}

/** Move a thread directory into threads/archive/. Returns the new path. */
export function archiveThread(ctx: ForumContext, threadRef: string): string {
  const paths = resolveForum(ctx);
  const found = findThreadDir(paths, threadRef);
  const name = path.basename(found.dir);
  ensureDir(paths.archiveDir);
  const target = path.join(paths.archiveDir, name);
  if (fs.existsSync(target)) {
    throw new ConflictError(`archive already contains a thread named ${name}`);
  }
  fs.renameSync(found.dir, target);
  return target;
}

// ---------------------------------------------------------------------------
// Messages (maildir borrow: one immutable uniquely-named file per message)

export const MESSAGE_KINDS = [
  "note",
  "checkin",
  "question",
  "answer",
  "handoff",
  "system",
] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export interface ForumMessage {
  /** Filename without .md — the message's identity. */
  id: string;
  file: string;
  thread: string;
  ts: string;
  from: string;
  kind: MessageKind;
  to: string[];
  re: string | null;
  refs: string[];
  machine: string | null;
  body: string;
}

function parseMessageFile(threadDir: string, filename: string): ForumMessage {
  const file = path.join(threadDir, filename);
  const rec = readRecord(file); // forgiving read
  const stampMs = stampToMs(stampOf(filename));
  const kind = MESSAGE_KINDS.includes(rec.data.kind as MessageKind)
    ? (rec.data.kind as MessageKind)
    : "note";
  return {
    id: filename.slice(0, -3),
    file,
    thread: path.basename(threadDir),
    ts:
      typeof rec.data.ts === "string" && !Number.isNaN(Date.parse(rec.data.ts))
        ? rec.data.ts
        : isoUtc(new Date(stampMs ?? 0)),
    from: typeof rec.data.from === "string" ? rec.data.from : "unknown",
    kind,
    to: asStringArray(rec.data.to),
    re: typeof rec.data.re === "string" ? rec.data.re : null,
    refs: asStringArray(rec.data.refs),
    machine: typeof rec.data.machine === "string" ? rec.data.machine : null,
    body: rec.body,
  };
}

function readMessages(threadDir: string): ForumMessage[] {
  return messageFilenames(threadDir).map((f) => parseMessageFile(threadDir, f));
}

export interface PostOptions {
  body: string;
  kind?: MessageKind;
  as?: string;
  to?: string | string[];
  /** Message id this replies to (filename without .md). */
  re?: string;
  /** Record references, e.g. ["task-141"]. */
  refs?: string[];
}

/**
 * Post an immutable message: <UTCstamp>--<participant>--<rand4>.md created
 * exclusively (identity in the filename — no locks, no minting). Lands in the
 * CANONICAL thread dir regardless of where it was invoked from.
 */
export function post(ctx: ForumContext, threadRef: string, options: PostOptions): ForumMessage {
  const paths = resolveForum(ctx);
  const actor = resolveActor(options.as, actorEnv(ctx));
  const kind = options.kind ?? "note";
  if (!MESSAGE_KINDS.includes(kind)) {
    throw new ConfigError(
      `invalid message kind "${kind}" (expected ${MESSAGE_KINDS.join(" | ")})`,
    );
  }
  const found = findThreadDir(paths, threadRef); // live threads only: no posting into archive
  const now = clock(ctx);
  const stamp = formatStamp(now);
  const to =
    options.to === undefined ? undefined : Array.isArray(options.to) && options.to.length === 1
      ? options.to[0]
      : options.to;
  const text = recordText(
    {
      from: actor,
      kind,
      ts: isoUtc(now),
      to,
      re: options.re,
      refs: options.refs !== undefined && options.refs.length > 0 ? options.refs : undefined,
      machine: machineId(ctx.store),
    },
    options.body,
  );
  const randFn = ctx.rand ?? rand4;
  const maxAttempts = 8;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const filename = `${stamp}--${actor}--${randFn()}.md`;
    const file = path.join(found.dir, filename);
    try {
      createExclusive(file, text);
      return parseMessageFile(found.dir, filename);
    } catch (err) {
      if (err instanceof ConflictError) continue; // same-second suffix collision: re-roll
      throw err;
    }
  }
  throw new ConflictError(
    `could not create a unique message file in ${found.dir} after ${maxAttempts} attempts`,
  );
}

export interface ShowResult {
  thread: ThreadInfo;
  messages: ForumMessage[];
}

/** Read a thread (archived threads are readable). `since` filters messages. */
export function showThread(
  ctx: ForumContext,
  threadRef: string,
  options: { since?: string | Date } = {},
): ShowResult {
  const paths = resolveForum(ctx);
  const found = findThreadDir(paths, threadRef, { includeArchived: true });
  let messages = readMessages(found.dir);
  if (options.since !== undefined) {
    const sinceMs =
      options.since instanceof Date ? options.since.getTime() : Date.parse(options.since);
    if (Number.isNaN(sinceMs)) {
      throw new ConfigError(`unparseable --since value: ${String(options.since)}`);
    }
    messages = messages.filter((m) => {
      const ms = stampToMs(stampOf(path.basename(m.file)));
      return ms !== null && ms >= sinceMs;
    });
  }
  return { thread: threadInfoAt(found.dir, found.archived), messages };
}

// ---------------------------------------------------------------------------
// Computed views: inbox + who

export interface InboxItem {
  thread: string;
  message: ForumMessage;
}

/**
 * Computed inbox: unanswered `question`s with `to: <me>`, across OPEN threads
 * (resolving a thread is the thread-level "dealt with" signal). A question is
 * answered when some message of kind `answer` has `re: <question id>`.
 */
export function inbox(ctx: ForumContext, options: { as?: string } = {}): InboxItem[] {
  const paths = resolveForum(ctx);
  const me = resolveActor(options.as, actorEnv(ctx));
  const items: InboxItem[] = [];
  for (const dir of liveThreadDirs(paths)) {
    const info = threadInfoAt(dir, false);
    if (info.status !== "open") continue;
    const messages = readMessages(dir);
    const answeredIds = new Set(
      messages.filter((m) => m.kind === "answer" && m.re !== null).map((m) => m.re as string),
    );
    for (const m of messages) {
      if (m.kind !== "question") continue;
      if (!m.to.includes(me)) continue;
      if (answeredIds.has(m.id)) continue;
      items.push({ thread: info.name, message: m });
    }
  }
  return items;
}

export type StalenessTier = "active" | "idle" | "stale";

// Read-side tiers (the PRD mandates only the 7-day sweep; these are display
// semantics): active < 1h, idle < 24h, stale otherwise.
export const ACTIVE_WITHIN_MS = 60 * 60 * 1000;
export const IDLE_WITHIN_MS = 24 * 60 * 60 * 1000;

function tierFor(lastSeenMs: number | null, nowMs: number): StalenessTier {
  if (lastSeenMs === null) return "stale";
  const age = nowMs - lastSeenMs;
  if (age < ACTIVE_WITHIN_MS) return "active";
  if (age < IDLE_WITHIN_MS) return "idle";
  return "stale";
}

export interface WhoEntry {
  participant: string;
  /** Machine of the freshest presence file; null when presence-less. */
  machine: string | null;
  announcedAt: string | null;
  plan: string | null;
  /** Most recent post in an OPEN thread (observed activity). */
  lastPost: { thread: string; id: string; ts: string } | null;
  /** max(announcedAt, lastPost) — the basis for the staleness tier. */
  lastSeenAt: string | null;
  staleness: StalenessTier;
}

/**
 * `who` = presence (declared intent) ⋈ open-thread recency (observed
 * activity). Full outer join on participant: someone posting without a
 * presence file still shows up; someone announced but silent shows up too.
 */
export function who(ctx: ForumContext): WhoEntry[] {
  const paths = resolveForum(ctx);
  const nowMs = clock(ctx).getTime();

  const byParticipant = new Map<string, WhoEntry>();
  const entryFor = (participant: string): WhoEntry => {
    let e = byParticipant.get(participant);
    if (e === undefined) {
      e = {
        participant,
        machine: null,
        announcedAt: null,
        plan: null,
        lastPost: null,
        lastSeenAt: null,
        staleness: "stale",
      };
      byParticipant.set(participant, e);
    }
    return e;
  };

  for (const p of readPresence(paths)) {
    const e = entryFor(p.participant);
    const ms = p.announcedAt !== null ? Date.parse(p.announcedAt) : null;
    const prevMs = e.announcedAt !== null ? Date.parse(e.announcedAt) : null;
    if (prevMs === null || (ms !== null && ms > prevMs)) {
      e.machine = p.machine;
      e.announcedAt = p.announcedAt;
      e.plan = p.plan;
    }
  }

  for (const dir of liveThreadDirs(paths)) {
    const info = threadInfoAt(dir, false);
    if (info.status !== "open") continue;
    for (const m of readMessages(dir)) {
      const ms = stampToMs(stampOf(path.basename(m.file)));
      if (ms === null) continue;
      const e = entryFor(m.from);
      const prev = e.lastPost !== null ? Date.parse(e.lastPost.ts) : null;
      if (prev === null || ms > prev) {
        e.lastPost = { thread: info.name, id: m.id, ts: isoUtc(new Date(ms)) };
      }
    }
  }

  const out = Array.from(byParticipant.values());
  for (const e of out) {
    const candidates = [
      e.announcedAt !== null ? Date.parse(e.announcedAt) : null,
      e.lastPost !== null ? Date.parse(e.lastPost.ts) : null,
    ].filter((x): x is number => x !== null && !Number.isNaN(x));
    const lastMs = candidates.length > 0 ? Math.max(...candidates) : null;
    e.lastSeenAt = lastMs !== null ? isoUtc(new Date(lastMs)) : null;
    e.staleness = tierFor(lastMs, nowMs);
  }
  out.sort((a, b) => a.participant.localeCompare(b.participant));
  return out;
}
