/**
 * `projects skills sync` — discover, aggregate, and install agent skills.
 *
 * The problem it solves: agent skills (a directory containing `SKILL.md`) are
 * authored where they belong — next to the project that owns them
 * (`<Project>/Skills/<name>/`, plus OpenWorkspace's own `skills/<name>/`). But
 * the agent runtimes (Claude Code, Codex) each want skills under a single
 * directory. The legacy approach scattered one symlink per skill from
 * `~/.claude/skills/<name>` straight into each project — N projects × M
 * runtimes of bookkeeping, with nothing that lists the installed set.
 *
 * This command makes ONE aggregated hub the source of installation truth:
 *
 *   1. DISCOVER every skill SOURCE across the workspace (source of truth stays
 *      in the project — never moved or copied).
 *   2. AGGREGATE them under `<workspace>/.agents/skills/<name>` — each a SYMLINK
 *      to the canonical source. `.agents/` is the index, not a second copy.
 *   3. INSTALL for each runtime by symlinking the runtime's skill dir entry to
 *      the `.agents/skills/<name>` aggregate (Claude Code + Codex).
 *   4. SYNC on every run: add new skills, repoint changed/moved sources, and
 *      PRUNE links whose source disappeared. Symlinks always point at the
 *      current source, so a moved project self-heals on the next sync.
 *   5. Update a marked section of the workspace top-level README listing the
 *      installed skills (name + one-line description), idempotently.
 *
 * Everything here is a PURE PLANNER over an injected `SkillsEnv` (paths +
 * fs surface). cli.ts supplies the real env; tests supply temp dirs. No write
 * happens unless `apply` is set — `planSkillsSync` only reads.
 *
 * Symlink discipline (P-spaces/colons safe): all link targets are computed as
 * paths RELATIVE to the link's own directory so the aggregate survives the
 * workspace being moved/renamed, and every path is handled as an opaque string
 * (spaces and `:` in `Inbox:Outbox`-style names never get shell-interpreted —
 * we never shell out). Writes go through the fsatomic symlink helpers.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { writeFileAtomic } from "./lib/fsatomic.js";
import {
  Workspace,
  discoverProjects,
} from "./lib/workspace.js";

// ---------------------------------------------------------------------------
// Frontmatter (minimal) — name + description from a SKILL.md
//
// We deliberately do NOT reuse the lossless frontmatter codec here: we only
// READ two scalar fields, the values can be YAML block scalars (`>-`) spanning
// several lines (see the real SKILL.md corpus), and we must never write a
// SKILL.md back. A tiny tolerant reader is the right tool.

export interface SkillMeta {
  /** `name:` from frontmatter, else the directory name. */
  name: string;
  /** `description:` collapsed to one line, else "". */
  description: string;
}

/** Collapse internal whitespace/newlines to single spaces and trim. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Extract `name` and `description` from SKILL.md frontmatter text. Tolerant:
 * supports inline scalars (`description: foo`), quoted scalars, and YAML block
 * scalars (`>-`, `|`, `>` …) whose continuation lines are more-indented than
 * the key. Returns null values when a field is absent.
 */
export function parseSkillFrontmatter(text: string): { name: string | null; description: string | null } {
  // Isolate the leading `---` … `---` block (LF or CRLF). Absent ⇒ no fields.
  const norm = text.replace(/\r\n/g, "\n");
  if (!norm.startsWith("---\n")) return { name: null, description: null };
  const end = norm.indexOf("\n---", 4);
  if (end === -1) return { name: null, description: null };
  const block = norm.slice(4, end + 1); // include trailing newline of last line
  const lines = block.split("\n");

  const read = (key: string): string | null => {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      const m = new RegExp(`^${key}:\\s*(.*)$`).exec(line);
      if (m === null) continue;
      const inline = (m[1] as string).trim();
      // Block scalar indicator (>-, |, |- , >, etc.) ⇒ gather indented body.
      if (/^[|>][+-]?\s*$/.test(inline)) {
        const body: string[] = [];
        for (let j = i + 1; j < lines.length; j++) {
          const l = lines[j] as string;
          if (l.trim() === "") {
            body.push("");
            continue;
          }
          if (/^\s+/.test(l)) {
            body.push(l.trim());
            continue;
          }
          break; // dedent to column 0 ⇒ next key
        }
        return oneLine(body.join(" "));
      }
      // Inline scalar — strip surrounding quotes if present.
      const unq = inline.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
      return oneLine(unq);
    }
    return null;
  };

  return { name: read("name"), description: read("description") };
}

/** Read a skill's metadata from its `SKILL.md` (env-injected fs). */
export function readSkillMeta(env: SkillsEnv, skillDir: string): SkillMeta {
  const dirName = path.basename(skillDir);
  let text: string;
  try {
    text = env.fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
  } catch {
    return { name: dirName, description: "" };
  }
  const fm = parseSkillFrontmatter(text);
  return {
    name: (fm.name ?? dirName) || dirName,
    description: fm.description ?? "",
  };
}

// ---------------------------------------------------------------------------
// Environment (injected — tests pass temp paths; cli.ts passes the real ones)

/**
 * The minimal fs surface the planner/applier needs. A subset of `node:fs`,
 * injected so tests can run against temp dirs (and so the planner never
 * accidentally touches a real home dir).
 */
export interface SkillsFs {
  existsSync: (p: string) => boolean;
  readdirSync: (p: string, opts: { withFileTypes: true }) => fs.Dirent[];
  readFileSync: (p: string, enc: "utf8") => string;
  lstatSync: (p: string) => fs.Stats;
  readlinkSync: (p: string) => string;
  symlinkSync: (target: string, link: string) => void;
  unlinkSync: (p: string) => void;
  mkdirSync: (p: string, opts: { recursive: true }) => void;
}

export interface SkillsEnv {
  /** The workspace (root + config). */
  ws: Workspace;
  /** Claude Code skill install dir (e.g. `~/.claude/skills`). null ⇒ skip. */
  claudeSkillsDir: string | null;
  /** Codex skill install dir (e.g. `~/.codex/skills`). null ⇒ skip. */
  codexSkillsDir: string | null;
  /** Source roots to scan for `<root>/<name>/SKILL.md`. */
  sourceRoots: string[];
  /** Path to the top-level README to maintain (markered section). null ⇒ skip. */
  readmePath: string | null;
  /** fs surface (real node:fs in prod; same node:fs against temp dirs in tests). */
  fs: SkillsFs;
}

/**
 * Default source roots for a workspace: every project's `Skills/` dir (active +
 * shelved, via a live scan) plus OpenWorkspace's own `skills/` dir. Only roots
 * that exist as directories are returned. Deduped, stable order.
 */
export function defaultSourceRoots(env: Pick<SkillsEnv, "ws" | "fs">): string[] {
  const { ws, fs: vfs } = env;
  const roots: string[] = [];
  const seen = new Set<string>();
  const add = (p: string): void => {
    const abs = path.resolve(p);
    if (seen.has(abs)) return;
    if (!isDir(vfs, abs)) return;
    seen.add(abs);
    roots.push(abs);
  };
  for (const proj of discoverProjects(ws, { all: true })) {
    add(path.join(proj.root, "Skills"));
  }
  // OpenWorkspace's own bundled skills (it may or may not be a discovered
  // project depending on where the marker lives — add unconditionally).
  add(path.join(ws.root, "Personal OS", "OpenWorkspace", "skills"));
  add(path.join(ws.root, "OpenWorkspace", "skills"));
  return roots;
}

function isDir(vfs: SkillsFs, p: string): boolean {
  try {
    return vfs.lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Discovery

export interface DiscoveredSkill {
  /** Skill name (frontmatter `name:` or dir name) — the install key. */
  name: string;
  /** One-line description from frontmatter (may be ""). */
  description: string;
  /** Absolute canonical source dir (the `<root>/<name>/` holding SKILL.md). */
  source: string;
}

/**
 * Discover skills across `sourceRoots`. A skill is a directory DIRECTLY under a
 * source root that contains a `SKILL.md`. On a name collision across roots the
 * FIRST root wins (source-root order is precedence) and the loser is recorded.
 */
export interface DiscoverResult {
  skills: DiscoveredSkill[];
  /** name → the shadowed source paths that lost the collision (for warnings). */
  collisions: Map<string, string[]>;
}

export function discoverSkills(env: SkillsEnv): DiscoverResult {
  const byName = new Map<string, DiscoveredSkill>();
  const collisions = new Map<string, string[]>();
  for (const root of env.sourceRoots) {
    let entries: fs.Dirent[];
    try {
      entries = env.fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    // Stable order within a root: alphabetical by dir name.
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
    for (const dirName of dirs) {
      const skillDir = path.join(root, dirName);
      if (!env.fs.existsSync(path.join(skillDir, "SKILL.md"))) continue;
      const meta = readSkillMeta(env, skillDir);
      const existing = byName.get(meta.name);
      if (existing !== undefined) {
        const list = collisions.get(meta.name) ?? [];
        list.push(skillDir);
        collisions.set(meta.name, list);
        continue;
      }
      byName.set(meta.name, { name: meta.name, description: meta.description, source: skillDir });
    }
  }
  const skills = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { skills, collisions };
}

// ---------------------------------------------------------------------------
// Planning

export type LinkActionKind =
  | "create" // link absent → create it
  | "update" // link present but points elsewhere → repoint
  | "prune" // link present, source gone → remove it
  | "ok"; // link present and correct → no-op

export interface LinkAction {
  kind: LinkActionKind;
  /** The symlink path being managed. */
  link: string;
  /** Desired target (relative to the link's dir), or null for a prune. */
  target: string | null;
  /** Human label of which layer this link belongs to. */
  layer: "agents" | "claude" | "codex";
  /** The current link target if one exists (for update/prune context). */
  current?: string;
}

export interface SkillsPlan {
  skills: DiscoveredSkill[];
  collisions: Map<string, string[]>;
  actions: LinkAction[];
  /** README section update, or null when no README is managed/changed. */
  readme: ReadmePlan | null;
}

export interface ReadmePlan {
  path: string;
  /** True when the managed section would change. */
  changed: boolean;
  /** The new full file content (only meaningful when changed). */
  nextContent: string;
}

/** Relative target from a link to its destination, normalized. */
function relTarget(linkPath: string, dest: string): string {
  return path.relative(path.dirname(linkPath), dest);
}

/** Current symlink target (relative or absolute as stored), or null. */
function currentLinkTarget(vfs: SkillsFs, linkPath: string): string | null {
  try {
    const st = vfs.lstatSync(linkPath);
    if (!st.isSymbolicLink()) return null;
    return vfs.readlinkSync(linkPath);
  } catch {
    return null;
  }
}

/** Is `linkPath` a managed symlink (a symlink at all)? */
function isExistingSymlink(vfs: SkillsFs, linkPath: string): boolean {
  try {
    return vfs.lstatSync(linkPath).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * List the entries we currently manage in a skills dir: only symbolic links.
 * (Real dirs — e.g. `~/.claude/skills/contacts-annotate-workspace` — are NOT
 * ours and are never touched.)
 */
function managedLinksIn(vfs: SkillsFs, dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = vfs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (isExistingSymlink(vfs, full)) out.push(full);
  }
  return out;
}

/**
 * Plan link actions for ONE install layer (the `.agents/skills` aggregate, or a
 * runtime dir). `desired` maps name → absolute target dir the link must point
 * at. Existing managed symlinks not in `desired` are pruned.
 */
function planLayer(
  vfs: SkillsFs,
  layer: LinkAction["layer"],
  layerDir: string,
  desired: Map<string, string>,
): LinkAction[] {
  const actions: LinkAction[] = [];
  // Creates / updates / oks
  for (const [name, dest] of desired) {
    const link = path.join(layerDir, name);
    const want = relTarget(link, dest);
    const cur = currentLinkTarget(vfs, link);
    if (cur === null) {
      // Either absent, or a non-symlink occupies the path. If a non-symlink
      // sits there we still emit a create; the applier will refuse non-symlink
      // clobbers (safety), surfacing it loudly rather than silently.
      actions.push({ kind: "create", link, target: want, layer });
    } else if (cur === want) {
      actions.push({ kind: "ok", link, target: want, layer, current: cur });
    } else {
      actions.push({ kind: "update", link, target: want, layer, current: cur });
    }
  }
  // Prunes: managed symlinks whose name is no longer desired.
  for (const link of managedLinksIn(vfs, layerDir)) {
    const name = path.basename(link);
    if (desired.has(name)) continue;
    actions.push({ kind: "prune", link, target: null, layer, current: currentLinkTarget(vfs, link) ?? undefined });
  }
  return actions;
}

// ---------------------------------------------------------------------------
// README markered section

export const README_BEGIN = "<!-- BEGIN openworkspace:skills (managed by `projects skills sync`) -->";
export const README_END = "<!-- END openworkspace:skills -->";

/** Render the managed README section body (between, not including, markers). */
export function renderReadmeSection(skills: DiscoveredSkill[]): string {
  const lines: string[] = [];
  lines.push("### Installed agent skills");
  lines.push("");
  if (skills.length === 0) {
    lines.push("_None installed._");
  } else {
    for (const s of skills) {
      const desc = s.description.length > 0 ? ` — ${s.description}` : "";
      lines.push(`- **${s.name}**${desc}`);
    }
  }
  return lines.join("\n");
}

/**
 * Compute the next README content with the managed section replaced/inserted.
 * Idempotent: re-running with the same skills reproduces identical bytes.
 *
 * - If both markers exist, the body between them is replaced.
 * - If neither exists, the block is appended (with a separating blank line).
 * - A trailing newline is always ensured on the file.
 */
export function applyReadmeSection(current: string, skills: DiscoveredSkill[]): string {
  const section = renderReadmeSection(skills);
  const block = `${README_BEGIN}\n${section}\n${README_END}`;

  const beginIdx = current.indexOf(README_BEGIN);
  const endIdx = current.indexOf(README_END);
  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    const before = current.slice(0, beginIdx);
    const after = current.slice(endIdx + README_END.length);
    let next = before + block + after;
    if (!next.endsWith("\n")) next += "\n";
    return next;
  }
  // Append. Ensure one blank line of separation.
  let base = current;
  if (base.length > 0 && !base.endsWith("\n")) base += "\n";
  if (base.length > 0 && !base.endsWith("\n\n")) base += "\n";
  let next = base + block + "\n";
  if (!next.endsWith("\n")) next += "\n";
  return next;
}

function planReadme(env: SkillsEnv, skills: DiscoveredSkill[]): ReadmePlan | null {
  if (env.readmePath === null) return null;
  let current = "";
  try {
    current = env.fs.readFileSync(env.readmePath, "utf8");
  } catch {
    current = "";
  }
  const nextContent = applyReadmeSection(current, skills);
  return { path: env.readmePath, changed: nextContent !== current, nextContent };
}

/**
 * Build the full sync plan. PURE — reads only. The three link layers:
 *
 *   agents:  `.agents/skills/<name>` → canonical source
 *   claude:  `<claudeSkillsDir>/<name>` → `.agents/skills/<name>`
 *   codex:   `<codexSkillsDir>/<name>` → `.agents/skills/<name>`
 *
 * Runtime links point at the aggregate (not the source) so `.agents/` is the
 * single hub: re-pointing one aggregate link updates both runtimes' view.
 */
export function planSkillsSync(env: SkillsEnv): SkillsPlan {
  const { skills, collisions } = discoverSkills(env);

  const agentsDir = path.join(env.ws.root, ".agents", "skills");

  // Layer 1: aggregate → source
  const agentsDesired = new Map<string, string>();
  for (const s of skills) agentsDesired.set(s.name, s.source);
  const actions: LinkAction[] = planLayer(env.fs, "agents", agentsDir, agentsDesired);

  // Layers 2/3: runtime → aggregate
  const runtimeDesired = new Map<string, string>();
  for (const s of skills) runtimeDesired.set(s.name, path.join(agentsDir, s.name));

  if (env.claudeSkillsDir !== null) {
    actions.push(...planLayer(env.fs, "claude", env.claudeSkillsDir, runtimeDesired));
  }
  if (env.codexSkillsDir !== null) {
    actions.push(...planLayer(env.fs, "codex", env.codexSkillsDir, runtimeDesired));
  }

  return { skills, collisions, actions, readme: planReadme(env, skills) };
}

// ---------------------------------------------------------------------------
// Apply

export interface ApplyResult {
  /** Actions that resulted in a filesystem mutation. */
  applied: LinkAction[];
  /** Non-fatal refusals (e.g. a non-symlink occupied a link path). */
  refusals: Array<{ action: LinkAction; reason: string }>;
  /** True if the README was written. */
  readmeWritten: boolean;
}

/**
 * Execute a plan. Idempotent: `ok` actions are skipped. Link writes are
 * symlink-safe: a create/update unlinks any prior SYMLINK then symlinks the
 * relative target; a non-symlink occupant is REFUSED (never clobbered — those
 * are human/real dirs like `*-workspace`). Prunes remove only symlinks.
 */
export function applySkillsSync(env: SkillsEnv, plan: SkillsPlan): ApplyResult {
  const vfs = env.fs;
  const applied: LinkAction[] = [];
  const refusals: Array<{ action: LinkAction; reason: string }> = [];

  for (const action of plan.actions) {
    if (action.kind === "ok") continue;
    if (action.kind === "prune") {
      if (isExistingSymlink(vfs, action.link)) {
        vfs.unlinkSync(action.link);
        applied.push(action);
      }
      continue;
    }
    // create / update
    vfs.mkdirSync(path.dirname(action.link), { recursive: true });
    let occupant: fs.Stats | null = null;
    try {
      occupant = vfs.lstatSync(action.link);
    } catch {
      occupant = null;
    }
    if (occupant !== null) {
      if (!occupant.isSymbolicLink()) {
        refusals.push({
          action,
          reason: `refusing to replace non-symlink at ${action.link} (not managed by skills sync)`,
        });
        continue;
      }
      vfs.unlinkSync(action.link);
    }
    vfs.symlinkSync(action.target as string, action.link);
    applied.push(action);
  }

  let readmeWritten = false;
  if (plan.readme !== null && plan.readme.changed) {
    writeFileAtomic(plan.readme.path, plan.readme.nextContent);
    readmeWritten = true;
  }

  return { applied, refusals, readmeWritten };
}

// ---------------------------------------------------------------------------
// Rendering (human output)

export function renderPlan(plan: SkillsPlan, mode: "dry-run" | "apply"): string[] {
  const lines: string[] = [];
  lines.push(`skills sync (${mode}) — ${plan.skills.length} skill(s) discovered`);
  for (const s of plan.skills) {
    lines.push(`  • ${s.name}${s.description ? ` — ${s.description}` : ""}`);
  }
  for (const [name, shadowed] of plan.collisions) {
    lines.push(`  ! name collision "${name}": ignoring ${shadowed.join(", ")} (first source root wins)`);
  }
  const verbose = plan.actions.filter((a) => a.kind !== "ok");
  if (verbose.length === 0) {
    lines.push("  links: already in sync");
  } else {
    for (const a of verbose) {
      const arrow = a.target !== null ? ` -> ${a.target}` : "";
      lines.push(`  [${a.layer}] ${a.kind} ${a.link}${arrow}`);
    }
  }
  if (plan.readme !== null) {
    lines.push(plan.readme.changed ? `  README: section would update (${plan.readme.path})` : `  README: section up to date`);
  }
  return lines;
}
