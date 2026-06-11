/**
 * Decisions primitive (PRD §4.5).
 *
 * Flat `_project/decisions/`, one record per significant decision, ADR-style:
 * filename `decision-<n> - <slug>.md`, frontmatter
 * `status: draft | accepted | superseded` + `superseded_by:`, body
 * Context / Decision / Consequences (optional "Expected:" line).
 *
 * Lifecycle: draft → accepted → superseded. **Immutable once accepted** —
 * changing course is a NEW record that supersedes the old one. The only
 * sanctioned mutation of an accepted record is the supersede stamp
 * (status + superseded_by); every other edit path refuses at the API level.
 *
 * Decision writes are WORKTREE-LOCAL (records ride the branch, PRD §6.3) —
 * no canonical resolution here. ID minting goes through the machine-local
 * mint lock; callers in a worktree should pass the canonical decisions dir
 * via `extraTreePaths` so the next-ID probe sees both trees.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { ConfigError, ConflictError, NotFoundError } from "../lib/errors.js";
import { createExclusive, ensureDir } from "../lib/fsatomic.js";
import {
  FrontmatterRecord,
  readRecord,
  setBody,
  setFields,
  writeRecord,
} from "../lib/frontmatter.js";
import { formatId, idFromFilename, mintId, parseId } from "../lib/ids.js";
import { MachineStore } from "../lib/machine.js";
import { readProjectUid } from "../lib/workspace.js";

export type DecisionStatus = "draft" | "accepted" | "superseded";

export interface Decision {
  id: string;
  title: string;
  status: DecisionStatus;
  date: string;
  supersededBy: string | null;
  filename: string;
  filePath: string;
  /** Full frontmatter as parsed (unknown keys included). */
  data: Record<string, unknown>;
  body: string;
}

export function decisionsDir(projectRoot: string): string {
  return path.join(projectRoot, "_project", "decisions");
}

// --- creation ---

export interface NewDecisionOptions {
  title: string;
  /** ISO date stamped into frontmatter; defaults to today (local). */
  date?: string;
  /** Optional Mauboussin "Expected:" line under ## Consequences. */
  expected?: string;
  /** Off-laptop minting suffix (e.g. "mini"). */
  machineSuffix?: string;
  /**
   * Extra dirs feeding the next-ID probe (e.g. the canonical checkout's
   * decisions dir when creating from a git worktree).
   */
  extraTreePaths?: string[];
}

function localToday(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Filesystem-safe slug for the filename; the ID, not the slug, is identity. */
function slugify(title: string): string {
  const slug = title
    .replace(/[/\\\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .trim();
  return slug.length > 0 ? slug : "untitled";
}

function template(id: string, title: string, date: string, expected?: string): string {
  const expectedLine = expected !== undefined ? `Expected: ${expected}\n` : "";
  return [
    "---",
    `id: ${id}`,
    `title: ${JSON.stringify(title)}`,
    "status: draft",
    `date: ${date}`,
    "superseded_by: null",
    "---",
    "",
    "## Context",
    "",
    "## Decision",
    "",
    "## Consequences",
    "",
    expectedLine,
  ].join("\n");
}

/** Stamp a new draft decision record and return it. */
export function newDecision(
  projectRoot: string,
  store: MachineStore,
  options: NewDecisionOptions,
): Decision {
  const uid = readProjectUid(projectRoot);
  if (uid === null) {
    throw new ConfigError(`not a project (no _project/id): ${projectRoot}`);
  }
  const dir = decisionsDir(projectRoot);
  ensureDir(dir);
  const date = options.date ?? localToday();
  const slug = slugify(options.title);

  let filePath = "";
  const id = mintId(store, uid, {
    prefix: "decision",
    treePaths: [dir, ...(options.extraTreePaths ?? [])],
    machineSuffix: options.machineSuffix,
    claim: (minted) => {
      filePath = path.join(dir, `${minted} - ${slug}.md`);
      createExclusive(filePath, template(minted, options.title, date, options.expected));
    },
  });
  return loadDecision(filePath, id);
}

// --- reading ---

function asStatus(value: unknown): DecisionStatus {
  return value === "accepted" || value === "superseded" ? value : "draft";
}

function decisionFromRecord(filePath: string, id: string, rec: FrontmatterRecord): Decision {
  const data = rec.data;
  const supersededBy = data["superseded_by"];
  return {
    id,
    title: typeof data["title"] === "string" ? data["title"] : "",
    status: asStatus(data["status"]),
    date: typeof data["date"] === "string" ? data["date"] : String(data["date"] ?? ""),
    supersededBy: typeof supersededBy === "string" && supersededBy !== "" ? supersededBy : null,
    filename: path.basename(filePath),
    filePath,
    data,
    body: rec.body,
  };
}

function loadDecision(filePath: string, id: string): Decision {
  return decisionFromRecord(filePath, id, readRecord(filePath));
}

/** "7" → "decision-7"; full ids pass through. Throws on garbage. */
function normalizeId(idOrNumber: string): string {
  const text = idOrNumber.trim();
  const candidate = /^\d+(\.\d+)*$/.test(text) ? `decision-${text}` : text;
  const parsed = parseId(candidate);
  if (parsed === null || parsed.prefix !== "decision") {
    throw new ConfigError(`not a decision id: ${idOrNumber}`);
  }
  return formatId(parsed.prefix, parsed.parts, parsed.machineSuffix);
}

function findDecisionFile(projectRoot: string, id: string): string | null {
  const dir = decisionsDir(projectRoot);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of entries) {
    const parsed = idFromFilename(name);
    if (parsed === null || parsed.prefix !== "decision") continue;
    if (formatId(parsed.prefix, parsed.parts, parsed.machineSuffix) === id) {
      return path.join(dir, name);
    }
  }
  return null;
}

export interface ListDecisionsOptions {
  status?: DecisionStatus;
}

/** Live scan of the decisions dir, sorted by ID (numeric, suffixes last). */
export function listDecisions(
  projectRoot: string,
  options: ListDecisionsOptions = {},
): Decision[] {
  const dir = decisionsDir(projectRoot);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const decisions: Decision[] = [];
  for (const name of entries.sort()) {
    if (!name.endsWith(".md")) continue;
    const parsed = idFromFilename(name);
    if (parsed === null || parsed.prefix !== "decision") continue;
    const id = formatId(parsed.prefix, parsed.parts, parsed.machineSuffix);
    decisions.push(loadDecision(path.join(dir, name), id));
  }
  decisions.sort((a, b) => {
    const pa = parseId(a.id);
    const pb = parseId(b.id);
    if (pa === null || pb === null) return a.id.localeCompare(b.id);
    for (let i = 0; i < Math.max(pa.parts.length, pb.parts.length); i++) {
      const da = pa.parts[i] ?? -1;
      const db = pb.parts[i] ?? -1;
      if (da !== db) return da - db;
    }
    return (pa.machineSuffix ?? "").localeCompare(pb.machineSuffix ?? "");
  });
  return options.status !== undefined
    ? decisions.filter((d) => d.status === options.status)
    : decisions;
}

export function showDecision(projectRoot: string, idOrNumber: string): Decision {
  const id = normalizeId(idOrNumber);
  const filePath = findDecisionFile(projectRoot, id);
  if (filePath === null) throw new NotFoundError(`decision not found: ${id}`);
  return loadDecision(filePath, id);
}

// --- mutation (state machine: draft → accepted → superseded) ---

interface Loaded {
  id: string;
  filePath: string;
  rec: FrontmatterRecord;
  status: DecisionStatus;
}

function loadForMutation(projectRoot: string, idOrNumber: string): Loaded {
  const id = normalizeId(idOrNumber);
  const filePath = findDecisionFile(projectRoot, id);
  if (filePath === null) throw new NotFoundError(`decision not found: ${id}`);
  const rec = readRecord(filePath);
  return { id, filePath, rec, status: asStatus(rec.data["status"]) };
}

/** draft → accepted. Anything else refuses (accepted records are immutable). */
export function acceptDecision(projectRoot: string, idOrNumber: string): Decision {
  const loaded = loadForMutation(projectRoot, idOrNumber);
  if (loaded.status !== "draft") {
    throw new ConflictError(
      `cannot accept ${loaded.id}: status is "${loaded.status}" (only drafts are accepted)`,
    );
  }
  setFields(loaded.rec, { status: "accepted" });
  writeRecord(loaded.filePath, loaded.rec);
  return decisionFromRecord(loaded.filePath, loaded.id, loaded.rec);
}

export interface UpdateDecisionOptions {
  title?: string;
  body?: string;
}

/**
 * Edit a DRAFT's title/body. Refused for accepted and superseded records —
 * immutability is enforced here, not left to convention. The filename's slug
 * is creation-time cosmetic; a title edit does not rename the file (the ID is
 * the anchor; slug drift is doctor territory).
 */
export function updateDecision(
  projectRoot: string,
  idOrNumber: string,
  updates: UpdateDecisionOptions,
): Decision {
  const loaded = loadForMutation(projectRoot, idOrNumber);
  if (loaded.status !== "draft") {
    throw new ConflictError(
      `cannot edit ${loaded.id}: ${loaded.status} records are immutable ` +
        `(changing course is a new record — supersede instead)`,
    );
  }
  if (updates.title !== undefined) setFields(loaded.rec, { title: updates.title });
  if (updates.body !== undefined) setBody(loaded.rec, updates.body);
  writeRecord(loaded.filePath, loaded.rec);
  return decisionFromRecord(loaded.filePath, loaded.id, loaded.rec);
}

/**
 * Mark `oldId` superseded by `byId`. The superseding record MUST exist
 * (refuses otherwise); only ACCEPTED records can be superseded (a draft is
 * not a standing decision — edit or accept it; an already-superseded record
 * keeps its original pointer). This is the single sanctioned mutation of an
 * accepted record.
 */
export function supersedeDecision(
  projectRoot: string,
  oldIdOrNumber: string,
  byIdOrNumber: string,
): Decision {
  const byId = normalizeId(byIdOrNumber);
  const loaded = loadForMutation(projectRoot, oldIdOrNumber);
  if (byId === loaded.id) {
    throw new ConflictError(`a decision cannot supersede itself: ${byId}`);
  }
  if (findDecisionFile(projectRoot, byId) === null) {
    throw new NotFoundError(
      `cannot supersede ${loaded.id}: superseding decision ${byId} does not exist`,
    );
  }
  if (loaded.status === "superseded") {
    throw new ConflictError(
      `cannot supersede ${loaded.id}: already superseded by ` +
        `${String(loaded.rec.data["superseded_by"] ?? "unknown")}`,
    );
  }
  if (loaded.status !== "accepted") {
    throw new ConflictError(
      `cannot supersede ${loaded.id}: status is "draft" (edit or accept the draft instead)`,
    );
  }
  setFields(loaded.rec, { status: "superseded", superseded_by: byId });
  writeRecord(loaded.filePath, loaded.rec);
  return decisionFromRecord(loaded.filePath, loaded.id, loaded.rec);
}
