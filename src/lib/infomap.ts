/**
 * The information map (OpenWorkspace decision-2, 2026-10-03; task-9).
 *
 * OpenWorkspace's default purpose is to make every project declare WHERE each
 * kind of project information canonically lives — its task tracker, decision
 * log, knowledge base, plans, coordination channel, plus free-form extras
 * (credentials vault, data stores, …). The native file-based stores under
 * `_project/` are one option per primitive, chosen à la carte, never the
 * default expectation.
 *
 * The map is machine-readable in `_project/project.toml` under `[map]`, and
 * rendered into a generated, marker-delimited "Where information lives"
 * section of the project's README.md and AGENTS.md (idempotent; hand-written
 * text around the block is never touched).
 *
 *     [map]
 *     render_to = ["README.md", "AGENTS.md"]   # optional; this is the default
 *     wiki = "native"                          # shorthand: native | none | <url> | <path>
 *     forum = "none"
 *
 *     [map.tasks]                              # an external pointer
 *     system = "GitHub Issues"
 *     url = "https://github.com/acme/widget/issues"
 *     locator = "acme/widget"
 *
 *     [map.decisions]
 *     system = "repo"
 *     path = "docs/decisions"                  # relative to the project root, or ~/…
 *
 *     [map.credentials]                        # an extra (any other key)
 *     system = "1Password"
 *     locator = "vault Acme"
 *
 * Backward compatibility: a project.toml WITHOUT a `[map]` table is a legacy
 * project — every primitive is treated as native, exactly as before, and
 * nothing is enforced (doctor only notes the map is missing). Inside a
 * declared map, an undeclared core primitive whose native store already
 * exists still counts as native (inferred), so declaring a map never breaks
 * an existing store.
 *
 * Reads are forgiving (problems are collected, never thrown), like the other
 * project.toml readers. Writes are read-modify-write of the whole tool-owned
 * document, preserving every other key (lifecycle, [[owns]], …).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ConfigError } from "./errors.js";
import { readTextIfExists, writeFileAtomic } from "./fsatomic.js";
import { TomlTable, readTomlIfExists, writeToml } from "./toml.js";

// ---------------------------------------------------------------------------
// Vocabulary

/** The core primitives — each has an optional native `_project/` store. */
export const CORE_PRIMITIVES = ["tasks", "decisions", "wiki", "plans", "forum"] as const;
export type CorePrimitive = (typeof CORE_PRIMITIVES)[number];

export const PRIMITIVE_LABELS: Readonly<Record<CorePrimitive, string>> = {
  tasks: "Tasks & backlog",
  decisions: "Decisions",
  wiki: "Knowledge (wiki)",
  plans: "Plans",
  forum: "Coordination (forum)",
};

/** Each core primitive's native store, relative to `_project/`. */
export const NATIVE_STORE: Readonly<Record<CorePrimitive, string>> = {
  tasks: "tasks/",
  decisions: "decisions/",
  wiki: "wiki/",
  plans: "plans/current.md",
  forum: "forum/",
};

/** Reserved non-entry keys inside `[map]`. */
const RESERVED_KEYS = new Set(["render_to"]);

export const DEFAULT_RENDER_TO: readonly string[] = ["README.md", "AGENTS.md"];

/** plans/current.md stub — forward-looking prose, never a task mirror. */
export const PLAN_STUB = `# Current plan

Forward-looking prose: where this project is heading and why. Complements
the task records in ../tasks/ — never a duplicate checkbox list of them.
`;

export function isCorePrimitive(key: string): key is CorePrimitive {
  return (CORE_PRIMITIVES as readonly string[]).includes(key);
}

// ---------------------------------------------------------------------------
// Shapes

export type HomeKind = "native" | "external" | "none" | "undeclared";

/** How an entry's home was established. */
export type HomeSource = "declared" | "inferred" | "legacy" | "undeclared";

export interface MapEntry {
  key: string;
  core: boolean;
  label: string;
  kind: HomeKind;
  source: HomeSource;
  system: string | null;
  url: string | null;
  locator: string | null;
  path: string | null;
  note: string | null;
}

export interface InfoMap {
  /** project.toml carries a `[map]` table (map mode). False = legacy project. */
  declared: boolean;
  /** Core primitives first (fixed order), then extras in declaration order. */
  entries: MapEntry[];
  /** Docs the "Where information lives" block is rendered into (project-root-relative). */
  renderTo: string[];
  /** Non-fatal schema problems (surfaced by doctor as errors). */
  problems: string[];
}

/** The pointer fields a caller can set for one entry. */
export interface EntrySpec {
  kind: "native" | "external" | "none";
  system?: string | null;
  url?: string | null;
  locator?: string | null;
  path?: string | null;
  note?: string | null;
  label?: string | null;
}

// ---------------------------------------------------------------------------
// Native store state

export type StoreState = "absent" | "empty" | "populated";

function listNames(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((n) => n !== ".DS_Store");
  } catch {
    return [];
  }
}

function hasFileDeep(dir: string, accept: (name: string) => boolean, depth = 0): boolean {
  if (depth > 6) return false;
  let ents: fs.Dirent[];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const ent of ents) {
    if (ent.name === ".DS_Store") continue;
    if (ent.isFile() && accept(ent.name)) return true;
    if (ent.isDirectory() && hasFileDeep(path.join(dir, ent.name), accept, depth + 1)) return true;
  }
  return false;
}

/**
 * Whether a core primitive's native store is absent, present-but-empty, or
 * holds content. "Empty" means it carries nothing a person wrote: an empty
 * directory, the untouched plan stub, a forum with no threads.
 */
export function nativeStoreState(projectRoot: string, primitive: CorePrimitive): StoreState {
  const p = path.join(projectRoot, "_project");
  switch (primitive) {
    case "tasks":
    case "decisions": {
      const dir = path.join(p, primitive);
      if (!fs.existsSync(dir)) return "absent";
      return hasFileDeep(dir, (n) => n.endsWith(".md")) ? "populated" : "empty";
    }
    case "wiki": {
      const dir = path.join(p, "wiki");
      if (!fs.existsSync(dir)) return "absent";
      return hasFileDeep(dir, () => true) ? "populated" : "empty";
    }
    case "plans": {
      const dir = path.join(p, "plans");
      if (!fs.existsSync(dir)) return "absent";
      const names = listNames(dir);
      if (names.length === 0) return "empty";
      const others = names.filter((n) => n !== "current.md");
      if (others.length > 0) return "populated";
      const text = readTextIfExists(path.join(dir, "current.md"));
      return text === null || text === PLAN_STUB ? "empty" : "populated";
    }
    case "forum": {
      const dir = path.join(p, "forum");
      if (!fs.existsSync(dir)) return "absent";
      const threads = path.join(dir, "threads");
      const live = listNames(threads).filter((n) => n !== "archive");
      const archived = listNames(path.join(threads, "archive"));
      return live.length > 0 || archived.length > 0 ? "populated" : "empty";
    }
  }
}

/** Count of native records (best-effort) — used in "N records remain" messages. */
export function nativeRecordCount(projectRoot: string, primitive: CorePrimitive): number {
  const p = path.join(projectRoot, "_project");
  const countMd = (dir: string): number => {
    let n = 0;
    for (const name of listNames(dir)) {
      const full = path.join(dir, name);
      try {
        const st = fs.statSync(full);
        if (st.isFile() && name.endsWith(".md")) n++;
        else if (st.isDirectory() && name === "archive") n += countMd(full);
      } catch {
        // vanished mid-walk
      }
    }
    return n;
  };
  switch (primitive) {
    case "tasks":
    case "decisions":
      return countMd(path.join(p, primitive));
    case "wiki":
      return listNames(path.join(p, "wiki")).length;
    case "plans":
      return nativeStoreState(projectRoot, "plans") === "populated" ? listNames(path.join(p, "plans")).length : 0;
    case "forum": {
      const threads = path.join(p, "forum", "threads");
      return (
        listNames(threads).filter((n) => n !== "archive").length +
        listNames(path.join(threads, "archive")).length
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Read

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function titleCase(key: string): string {
  const words = key.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function looksLikeUrl(s: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^mailto:/i.test(s);
}

function looksLikePath(s: string): boolean {
  return s.startsWith("/") || s.startsWith("~") || s.startsWith("./") || s.startsWith("../") || s.includes("/");
}

/** Best-effort system name from a URL (display only). */
export function guessSystem(url: string): string | null {
  let host: string;
  let pathname: string;
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    pathname = u.pathname;
  } catch {
    return null;
  }
  if (host === "github.com") return /\/issues\/?$/.test(pathname) ? "GitHub Issues" : "GitHub";
  if (host.endsWith("teamwork.com")) return "Teamwork";
  if (host.endsWith("slack.com")) return "Slack";
  if (host === "docs.google.com" || host === "drive.google.com") return "Google Drive";
  if (host.endsWith("notion.so") || host.endsWith("notion.site")) return "Notion";
  if (host.endsWith("atlassian.net")) return "Atlassian";
  if (host.endsWith("linear.app")) return "Linear";
  return host;
}

function emptyEntry(key: string): MapEntry {
  return {
    key,
    core: isCorePrimitive(key),
    label: isCorePrimitive(key) ? PRIMITIVE_LABELS[key] : titleCase(key),
    kind: "undeclared",
    source: "undeclared",
    system: null,
    url: null,
    locator: null,
    path: null,
    note: null,
  };
}

/** Parse one raw `[map]` value into an entry (declared), collecting problems. */
function parseEntry(key: string, raw: unknown, problems: string[]): MapEntry | null {
  const e = emptyEntry(key);
  e.source = "declared";
  if (typeof raw === "string") {
    const v = raw.trim();
    if (v === "native" || v === "none") {
      e.kind = v;
    } else if (looksLikeUrl(v)) {
      e.kind = "external";
      e.url = v;
      e.system = guessSystem(v);
    } else if (looksLikePath(v)) {
      e.kind = "external";
      e.path = v;
    } else {
      problems.push(`map.${key}: "${raw}" is not native|none|<url>|<path> — use a [map.${key}] table for a named system`);
      return null;
    }
  } else if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const t = raw as Record<string, unknown>;
    e.system = str(t["system"]);
    e.url = str(t["url"]);
    e.locator = str(t["locator"]);
    e.path = str(t["path"]);
    e.note = str(t["note"]);
    const label = str(t["label"]);
    if (label !== null) e.label = label;
    const home = t["home"];
    const hasPointer = e.url !== null || e.locator !== null || e.path !== null || e.system !== null;
    if (home === undefined) {
      if (!hasPointer) {
        problems.push(`map.${key}: no home — set home = "native" | "none", or system/url/locator/path`);
        return null;
      }
      e.kind = "external";
    } else if (home === "native" || home === "none" || home === "external") {
      e.kind = home;
      if (home === "external" && !hasPointer) {
        problems.push(`map.${key}: home = "external" needs at least one of system/url/locator/path`);
        return null;
      }
    } else {
      problems.push(`map.${key}: unknown home "${String(home)}" (expected native|external|none)`);
      return null;
    }
    if (e.system === null && e.url !== null) e.system = guessSystem(e.url);
  } else {
    problems.push(`map.${key}: must be a string (native|none|<url>|<path>) or a table`);
    return null;
  }
  if (e.kind === "native" && !e.core) {
    problems.push(`map.${key}: "native" is only available for ${CORE_PRIMITIVES.join(", ")} — point "${key}" at its system`);
    return null;
  }
  return e;
}

/**
 * Read the effective information map of a project. Never throws: an
 * unparseable project.toml or malformed entries become `problems`.
 */
export function readInfoMap(projectRoot: string): InfoMap {
  const problems: string[] = [];
  let raw: TomlTable = {};
  try {
    raw = readTomlIfExists(path.join(projectRoot, "_project", "project.toml"));
  } catch (err) {
    problems.push(`unparseable project.toml: ${(err as Error).message}`);
  }
  const rawMap = raw["map"];
  const declared = rawMap !== undefined && rawMap !== null && typeof rawMap === "object" && !Array.isArray(rawMap);
  if (rawMap !== undefined && !declared) problems.push("map must be a table ([map])");
  const table = declared ? (rawMap as Record<string, unknown>) : {};

  let renderTo = [...DEFAULT_RENDER_TO];
  if (table["render_to"] !== undefined) {
    const rt = table["render_to"];
    if (Array.isArray(rt) && rt.every((x) => typeof x === "string")) renderTo = rt as string[];
    else problems.push("map.render_to must be an array of project-root-relative paths");
  }

  const declaredEntries = new Map<string, MapEntry>();
  for (const [key, value] of Object.entries(table)) {
    if (RESERVED_KEYS.has(key)) continue;
    const e = parseEntry(key, value, problems);
    if (e !== null) declaredEntries.set(key, e);
  }

  const entries: MapEntry[] = [];
  for (const prim of CORE_PRIMITIVES) {
    const d = declaredEntries.get(prim);
    if (d !== undefined) {
      entries.push(d);
      continue;
    }
    const e = emptyEntry(prim);
    if (!declared) {
      // Legacy project: everything native, exactly as before the map existed.
      e.kind = "native";
      e.source = "legacy";
    } else if (nativeStoreState(projectRoot, prim) !== "absent") {
      e.kind = "native";
      e.source = "inferred";
    }
    entries.push(e);
  }
  for (const [key, e] of declaredEntries) {
    if (!isCorePrimitive(key)) entries.push(e);
  }
  return { declared, entries, renderTo, problems };
}

export function entryOf(map: InfoMap, key: string): MapEntry | undefined {
  return map.entries.find((e) => e.key === key);
}

/** The effective home of one core primitive. */
export function homeOf(projectRoot: string, primitive: CorePrimitive): MapEntry {
  return entryOf(readInfoMap(projectRoot), primitive) as MapEntry;
}

// ---------------------------------------------------------------------------
// Write

const KEY_RE = /^[a-z][a-z0-9_-]*$/;

function serializeEntry(spec: EntrySpec): string | Record<string, string> {
  const hasDetail =
    !!spec.system || !!spec.url || !!spec.locator || !!spec.path || !!spec.note || !!spec.label;
  if (spec.kind !== "external" && !hasDetail) return spec.kind;
  const t: Record<string, string> = {};
  if (spec.kind !== "external") t["home"] = spec.kind;
  if (spec.label) t["label"] = spec.label;
  if (spec.system) t["system"] = spec.system;
  if (spec.url) t["url"] = spec.url;
  if (spec.locator) t["locator"] = spec.locator;
  if (spec.path) t["path"] = spec.path;
  if (spec.note) t["note"] = spec.note;
  return t;
}

/**
 * Parse a CLI home shorthand: `native` | `none` | `<url>` | `<path>`.
 * Returns a partial spec; explicit flags override its fields.
 */
export function parseHomeShorthand(value: string): EntrySpec {
  const v = value.trim();
  if (v === "native" || v === "none") return { kind: v };
  if (looksLikeUrl(v)) return { kind: "external", url: v, system: guessSystem(v) };
  if (looksLikePath(v)) return { kind: "external", path: v };
  throw new ConfigError(
    `"${value}" is not native|none|<url>|<path> — name a system with --system (and --url/--locator/--path)`,
  );
}

/** Validate a spec before writing (throws ConfigError). */
export function validateSpec(key: string, spec: EntrySpec): void {
  if (!KEY_RE.test(key) || RESERVED_KEYS.has(key)) {
    throw new ConfigError(`invalid map key "${key}" (lowercase letters, digits, _ or -; not ${[...RESERVED_KEYS].join(", ")})`);
  }
  if (spec.kind === "native" && !isCorePrimitive(key)) {
    throw new ConfigError(
      `"${key}" has no native store (only ${CORE_PRIMITIVES.join(", ")} do) — point it at its system with --system/--url/--locator/--path`,
    );
  }
  if (spec.kind === "external" && !spec.system && !spec.url && !spec.locator && !spec.path) {
    throw new ConfigError(`an external home for "${key}" needs at least one of --system/--url/--locator/--path`);
  }
}

/**
 * Declare (or with `spec === null`, remove) one entry, read-modify-write of
 * project.toml preserving every other key. Creates `[map]` if absent — the
 * act of declaring anything puts the project in map mode.
 */
export function writeMapEntry(projectRoot: string, key: string, spec: EntrySpec | null): void {
  if (spec !== null) validateSpec(key, spec);
  const tomlPath = path.join(projectRoot, "_project", "project.toml");
  const raw: TomlTable = readTomlIfExists(tomlPath);
  const existing = raw["map"];
  const map: Record<string, unknown> =
    existing !== null && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  if (spec === null) delete map[key];
  else map[key] = serializeEntry(spec);
  raw["map"] = orderedMap(map);
  writeToml(tomlPath, raw);
}

/** Ensure the project is in map mode (an empty `[map]` table) without declaring anything. */
export function ensureMapDeclared(projectRoot: string): void {
  const tomlPath = path.join(projectRoot, "_project", "project.toml");
  const raw: TomlTable = readTomlIfExists(tomlPath);
  const existing = raw["map"];
  if (existing !== null && typeof existing === "object" && !Array.isArray(existing)) return;
  raw["map"] = {};
  writeToml(tomlPath, raw);
}

/** Stable key order: render_to, core primitives (fixed order), then extras as declared. */
function orderedMap(map: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (map["render_to"] !== undefined) out["render_to"] = map["render_to"];
  // smol-toml emits plain keys before sub-tables regardless; order within each group is ours.
  for (const k of CORE_PRIMITIVES) if (map[k] !== undefined) out[k] = map[k];
  for (const [k, v] of Object.entries(map)) if (!(k in out)) out[k] = v;
  return out;
}

// ---------------------------------------------------------------------------
// Pointer checks (no network)

export function expandHome(p: string, home: string = os.homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

/** Resolve an entry's `path` pointer to an absolute path (relative = project root). */
export function resolvePointerPath(projectRoot: string, p: string): string {
  const expanded = expandHome(p);
  return path.isAbsolute(expanded) ? expanded : path.resolve(projectRoot, expanded);
}

/** Pointer problems for one entry: URL well-formedness, local path existence. */
export function pointerProblems(projectRoot: string, e: MapEntry): string[] {
  const out: string[] = [];
  if (e.kind !== "external") return out;
  if (e.url !== null) {
    try {
      const u = new URL(e.url);
      if ((u.protocol === "http:" || u.protocol === "https:") && u.hostname === "") {
        out.push(`map.${e.key}: url has no host: ${e.url}`);
      }
    } catch {
      out.push(`map.${e.key}: url is not well-formed: ${e.url}`);
    }
  }
  if (e.path !== null && !fs.existsSync(resolvePointerPath(projectRoot, e.path))) {
    out.push(`map.${e.key}: path does not exist: ${e.path}`);
  }
  if (e.url === null && e.locator === null && e.path === null) {
    out.push(`map.${e.key}: names a system (${e.system ?? "?"}) but no url, locator or path — say where in it`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Human-readable description

/** One line describing where an entry's information lives. */
export function describeHome(e: MapEntry): string {
  switch (e.kind) {
    case "native": {
      const store = e.core ? `\`_project/${NATIVE_STORE[e.key as CorePrimitive]}\`` : "";
      const how = e.source === "inferred" ? " (inferred from the existing store — declare it)" : "";
      const note = e.note !== null ? ` — ${e.note}` : "";
      return `OpenWorkspace native store ${store}${how}${note}`.replace(/\s+$/, "");
    }
    case "none":
      return `not used${e.note !== null ? ` — ${e.note}` : ""}`;
    case "undeclared":
      return `not yet declared — \`projects map set ${e.key} …\``;
    case "external": {
      const parts: string[] = [];
      const sys =
        e.system ??
        (e.path !== null ? (path.isAbsolute(expandHome(e.path)) ? "local path" : "in this project") : "external");
      parts.push(sys);
      const where: string[] = [];
      if (e.url !== null) where.push(`<${e.url}>`);
      if (e.locator !== null) where.push(`\`${e.locator}\``);
      if (e.path !== null) where.push(`\`${e.path}\``);
      let line = parts.join("");
      if (where.length > 0) line += ` — ${where.join(" · ")}`;
      if (e.note !== null) line += ` — ${e.note}`;
      return line;
    }
  }
}

/** Plain-text pointer (no Markdown) for CLI messages. */
export function pointerText(e: MapEntry): string {
  return describeHome(e).replace(/[`<>]/g, "");
}

/** The message a native command prints when the primitive's home is elsewhere. */
export function elsewhereMessage(e: MapEntry, projectName: string): string {
  const what = e.label.toLowerCase();
  switch (e.kind) {
    case "external":
      return `${e.label} for ${projectName} live in ${pointerText(e)} (declared in _project/project.toml [map]) — not in OpenWorkspace's native store.`;
    case "none":
      return `${projectName} declares no ${what} home ("none" in _project/project.toml [map]).`;
    case "undeclared":
      return (
        `${projectName} has no declared home for ${what} yet. Declare one: ` +
        `\`projects map set ${e.key} native\` (OpenWorkspace's file store) or ` +
        `\`projects map set ${e.key} <url> --system "<name>"\`.`
      );
    case "native":
      return `${e.label} for ${projectName} use the native store.`;
  }
}

// ---------------------------------------------------------------------------
// Rendering into README.md / AGENTS.md

export const MAP_BEGIN =
  "<!-- BEGIN openworkspace:information-map (generated by `projects map render` from _project/project.toml [map]; edit the map, not this block) -->";
export const MAP_END = "<!-- END openworkspace:information-map -->";

/** The managed block body (between, not including, the markers). */
export function renderMapSection(map: InfoMap): string {
  const lines: string[] = [];
  lines.push("## Where information lives");
  lines.push("");
  lines.push(
    "The canonical home of each kind of project information. Look here first, and record new information in its listed home — nowhere else.",
  );
  lines.push("");
  for (const e of map.entries) {
    lines.push(`- **${e.label}:** ${describeHome(e)}`);
  }
  lines.push("");
  lines.push("_Generated from `_project/project.toml` `[map]` by `projects map render`; `projects doctor` checks it stays current._");
  return lines.join("\n");
}

/**
 * Replace (or append) the managed block in a document's text. Idempotent:
 * same map ⇒ byte-identical output; text outside the markers is preserved.
 */
export function applyMapSection(current: string, section: string): string {
  const block = `${MAP_BEGIN}\n${section}\n${MAP_END}`;
  const beginIdx = current.indexOf(MAP_BEGIN);
  const endIdx = current.indexOf(MAP_END);
  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    let next = current.slice(0, beginIdx) + block + current.slice(endIdx + MAP_END.length);
    if (!next.endsWith("\n")) next += "\n";
    return next;
  }
  let base = current;
  if (base.length > 0 && !base.endsWith("\n")) base += "\n";
  if (base.length > 0 && !base.endsWith("\n\n")) base += "\n";
  return base + block + "\n";
}

/** Extract the managed block body from a document, or null when absent. */
export function extractMapSection(text: string): string | null {
  const beginIdx = text.indexOf(MAP_BEGIN);
  const endIdx = text.indexOf(MAP_END);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) return null;
  return text.slice(beginIdx + MAP_BEGIN.length, endIdx).replace(/^\n/, "").replace(/\n$/, "");
}

function docSkeleton(rel: string, projectName: string): string {
  return path.basename(rel).toUpperCase() === "AGENTS.MD"
    ? `# Agent instructions — ${projectName}\n\n`
    : `# ${projectName}\n\n`;
}

export interface RenderResult {
  file: string; // project-root-relative
  created: boolean;
  changed: boolean;
}

/**
 * Render the map block into every `render_to` doc (creating a missing doc
 * with a one-line title). Idempotent: an unchanged map writes nothing.
 */
export function renderMapDocs(
  projectRoot: string,
  options: { dryRun?: boolean; map?: InfoMap } = {},
): RenderResult[] {
  const map = options.map ?? readInfoMap(projectRoot);
  const section = renderMapSection(map);
  const name = path.basename(projectRoot);
  const results: RenderResult[] = [];
  for (const rel of map.renderTo) {
    const abs = path.resolve(projectRoot, rel);
    const current = readTextIfExists(abs);
    const base = current ?? docSkeleton(rel, name);
    const next = applyMapSection(base, section);
    const changed = current === null || next !== current;
    if (changed && options.dryRun !== true) writeFileAtomic(abs, next);
    results.push({ file: rel, created: current === null, changed });
  }
  return results;
}

export type DocState = "ok" | "missing-file" | "missing-section" | "stale";

/** Compare every render target against the map (pure read). */
export function checkMapDocs(projectRoot: string, map: InfoMap = readInfoMap(projectRoot)): Array<{ file: string; state: DocState }> {
  const want = renderMapSection(map);
  return map.renderTo.map((rel) => {
    const text = readTextIfExists(path.resolve(projectRoot, rel));
    if (text === null) return { file: rel, state: "missing-file" as const };
    const got = extractMapSection(text);
    if (got === null) return { file: rel, state: "missing-section" as const };
    return { file: rel, state: got === want ? ("ok" as const) : ("stale" as const) };
  });
}

// ---------------------------------------------------------------------------
// JSON view (CLI --json, dashboard)

export interface MapEntryView {
  key: string;
  label: string;
  core: boolean;
  kind: HomeKind;
  source: HomeSource;
  system: string | null;
  url: string | null;
  locator: string | null;
  path: string | null;
  note: string | null;
  /** Native store state (core primitives only; null for extras). */
  store: StoreState | null;
}

export function mapView(projectRoot: string, map: InfoMap = readInfoMap(projectRoot)): {
  declared: boolean;
  renderTo: string[];
  entries: MapEntryView[];
  problems: string[];
} {
  return {
    declared: map.declared,
    renderTo: map.renderTo,
    problems: map.problems,
    entries: map.entries.map((e) => ({
      key: e.key,
      label: e.label,
      core: e.core,
      kind: e.kind,
      source: e.source,
      system: e.system,
      url: e.url,
      locator: e.locator,
      path: e.path,
      note: e.note,
      store: e.core ? nativeStoreState(projectRoot, e.key as CorePrimitive) : null,
    })),
  };
}
