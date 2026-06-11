/**
 * The workspace contract (PRD §4.1).
 *
 * A workspace is a directory containing `.openworkspace/`. The entire
 * contract: root marker, two shelf paths, ignore list, schema version,
 * workspace id, secret-resolver map. Everything else is just a directory.
 *
 * There is NO registry file: discovery is always a live walk of the tree
 * (principle 8 / "the tree is the database").
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { ConfigError, NotFoundError } from "./errors.js";
import { TomlTable, readTomlIfExists, writeToml } from "./toml.js";

export const MARKER_DIR = ".openworkspace";
export const CONFIG_FILE = "config.toml";

export const DEFAULT_DORMANT = "Dormant Projects";
export const DEFAULT_ARCHIVES = "Archives";
export const DEFAULT_IGNORE = [
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".obsidian",
];

export type Lifecycle = "active" | "dormant" | "archived";

/**
 * The lifecycle vocabulary a project may DECLARE in `_project/project.toml`
 * (decision-2, metadata-as-truth). It is exactly the location-derivable
 * `Lifecycle`: active | dormant | archived (Matteo dropped `ongoing`
 * 2026-06-11 — an "ongoing" project is just an active one the human chooses
 * never to archive; the active-project cap is C3's concern, not the tool's).
 *
 * Kept as a distinct alias of `Lifecycle` so decision-2's metadata-as-truth
 * code paths read intent-clearly even though the two vocabularies now coincide.
 */
export type DeclaredLifecycle = Lifecycle;

const DECLARED_LIFECYCLES = new Set<DeclaredLifecycle>([
  "active",
  "dormant",
  "archived",
]);

/** Map a declared lifecycle to the location-comparable `Lifecycle` (identity). */
export function locationOfDeclared(declared: DeclaredLifecycle): Lifecycle {
  return declared;
}

export interface DeclaredLifecycleResult {
  /** The validated declared value, or null when none/invalid is declared. */
  lifecycle: DeclaredLifecycle | null;
  /** The `lifecycle_set` audit timestamp, or null. */
  setAt: string | null;
  /** A non-fatal validation problem (e.g. an unknown enum value), or null. */
  problem: string | null;
}

/**
 * Read the DECLARED lifecycle from `_project/project.toml` (decision-2).
 *
 * Forgiving, like `readOngoing`: an absent file / absent key reads as null
 * (⇒ caller falls back to location); an unparseable file or an unknown
 * lifecycle value reads as null WITH a `problem` string so doctor can surface
 * it, never as a discovery blocker.
 */
export function readDeclaredLifecycle(projectRoot: string): DeclaredLifecycleResult {
  const tomlPath = path.join(projectRoot, "_project", "project.toml");
  let raw: TomlTable;
  try {
    raw = readTomlIfExists(tomlPath);
  } catch (err) {
    return { lifecycle: null, setAt: null, problem: `unparseable project.toml: ${(err as Error).message}` };
  }
  const value = raw["lifecycle"];
  const setRaw = raw["lifecycle_set"];
  const setAt =
    typeof setRaw === "string" && setRaw !== ""
      ? setRaw
      : setRaw instanceof Date
        ? setRaw.toISOString()
        : null;
  if (value === undefined) return { lifecycle: null, setAt, problem: null };
  if (typeof value !== "string" || !DECLARED_LIFECYCLES.has(value as DeclaredLifecycle)) {
    return {
      lifecycle: null,
      setAt,
      problem: `unknown lifecycle "${String(value)}" (expected active|dormant|archived)`,
    };
  }
  return { lifecycle: value as DeclaredLifecycle, setAt, problem: null };
}

/**
 * Write the DECLARED lifecycle into `_project/project.toml` (decision-2),
 * read-modify-write to PRESERVE every other key (P12 lossless). Writing
 * `active` SHEDS the key (absent ⇒ active, P17); if that leaves the document
 * empty the file is removed entirely.
 *
 * NB: smol-toml's whole-document writer does not preserve comments — but
 * project.toml is a tool-owned declared-facts file (no hand comments), the
 * same posture as the config/registry files writeToml already owns.
 */
export function writeDeclaredLifecycle(
  projectRoot: string,
  lifecycle: DeclaredLifecycle,
  setAt: string | null,
): void {
  const tomlPath = path.join(projectRoot, "_project", "project.toml");
  const raw: TomlTable = readTomlIfExists(tomlPath);

  if (lifecycle === "active") {
    delete raw["lifecycle"];
    delete raw["lifecycle_set"];
  } else {
    raw["lifecycle"] = lifecycle;
    if (setAt !== null) raw["lifecycle_set"] = setAt;
    else delete raw["lifecycle_set"];
  }

  if (Object.keys(raw).length === 0) {
    try {
      fs.unlinkSync(tomlPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    return;
  }
  writeToml(tomlPath, raw);
}

export interface WorkspaceConfig {
  schema: number;
  workspaceId: string | null;
  paths: { dormant: string; archives: string };
  discovery: { ignore: string[] };
  secrets: { resolvers: Record<string, string> };
}

export interface Workspace {
  /** Absolute path of the directory containing `.openworkspace/`. */
  root: string;
  config: WorkspaceConfig;
}

export interface ProjectInfo {
  /** Absolute project root (the directory containing `_project/`). */
  root: string;
  /** Path relative to the workspace root, "" never (root projects are relPath "name"). */
  relPath: string;
  uid: string;
  /**
   * Location-derived lifecycle (the VIEW). Kept for backward compatibility and
   * as the reconcile target; the SOURCE OF TRUTH is `effectiveLifecycle`.
   */
  lifecycle: Lifecycle;
  /** Absolute root of the enclosing project when nested, else null. */
  nestedUnder: string | null;
  // --- decision-2 metadata-as-truth (additive) ---
  /**
   * The effective lifecycle: declared `project.toml` value, else location.
   * THIS is the source of truth; `lifecycle` above is the derived view.
   */
  effectiveLifecycle: DeclaredLifecycle;
  /** The explicitly declared lifecycle (`project.toml`), or null when none. */
  declaredLifecycle: DeclaredLifecycle | null;
  /** The `lifecycle_set` audit timestamp, or null. */
  lifecycleSetAt: string | null;
}

export function defaultConfig(): WorkspaceConfig {
  return {
    schema: 2,
    workspaceId: null,
    paths: { dormant: DEFAULT_DORMANT, archives: DEFAULT_ARCHIVES },
    discovery: { ignore: [...DEFAULT_IGNORE] },
    secrets: { resolvers: {} },
  };
}

/**
 * Walk up from `startDir` looking for `.openworkspace/`. Returns the
 * workspace root, or null when no marker is found up to the fs root.
 */
export function findWorkspaceRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    const marker = path.join(dir, MARKER_DIR);
    let st: fs.Stats | null = null;
    try {
      st = fs.statSync(marker);
    } catch {
      st = null;
    }
    if (st !== null && st.isDirectory()) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function asString(value: unknown, key: string): string {
  if (typeof value !== "string") throw new ConfigError(`config key ${key} must be a string`);
  return value;
}

/**
 * Load `.openworkspace/config.toml`. Every key is optional; an absent file
 * means all defaults. Unknown keys are ignored on read (forgiving), never
 * rewritten.
 */
export function loadWorkspaceConfig(rootDir: string): WorkspaceConfig {
  const config = defaultConfig();
  const raw = readTomlIfExists(path.join(rootDir, MARKER_DIR, CONFIG_FILE));

  if (raw["schema"] !== undefined) {
    if (typeof raw["schema"] !== "number") throw new ConfigError("config key schema must be a number");
    config.schema = raw["schema"];
  }
  if (raw["workspace_id"] !== undefined) {
    config.workspaceId = asString(raw["workspace_id"], "workspace_id");
  }
  const paths = raw["paths"];
  if (paths !== undefined && typeof paths === "object" && paths !== null) {
    const p = paths as Record<string, unknown>;
    if (p["dormant"] !== undefined) config.paths.dormant = asString(p["dormant"], "paths.dormant");
    if (p["archives"] !== undefined) config.paths.archives = asString(p["archives"], "paths.archives");
  }
  const discovery = raw["discovery"];
  if (discovery !== undefined && typeof discovery === "object" && discovery !== null) {
    const d = discovery as Record<string, unknown>;
    if (d["ignore"] !== undefined) {
      if (!Array.isArray(d["ignore"]) || d["ignore"].some((x) => typeof x !== "string")) {
        throw new ConfigError("config key discovery.ignore must be an array of strings");
      }
      config.discovery.ignore = [...(d["ignore"] as string[])];
    }
  }
  const secrets = raw["secrets"];
  if (secrets !== undefined && typeof secrets === "object" && secrets !== null) {
    const s = secrets as Record<string, unknown>;
    const resolvers = s["resolvers"];
    if (resolvers !== undefined && typeof resolvers === "object" && resolvers !== null) {
      for (const [scheme, cmd] of Object.entries(resolvers as Record<string, unknown>)) {
        config.secrets.resolvers[scheme] = asString(cmd, `secrets.resolvers.${scheme}`);
      }
    }
  }
  return config;
}

/** Open the workspace containing `startDir`; throws NotFoundError if none. */
export function openWorkspace(startDir: string): Workspace {
  const root = findWorkspaceRoot(startDir);
  if (root === null) {
    throw new NotFoundError(
      `no workspace found: no ${MARKER_DIR}/ marker above ${path.resolve(startDir)}`,
    );
  }
  return { root, config: loadWorkspaceConfig(root) };
}

/** Read `_project/id` for a directory; null when it is not a project. */
export function readProjectUid(dir: string): string | null {
  try {
    const text = fs.readFileSync(path.join(dir, "_project", "id"), "utf8").trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/** True when `dir` is a project boundary (has `_project/id`). */
export function isProjectBoundary(dir: string): boolean {
  return readProjectUid(dir) !== null;
}

/**
 * True when `dir` is the working tree of a foreign git repo — it contains a
 * `.git` entry but is NOT an OpenWorkspace project. Such trees (a cloned repo,
 * a code checkout) hold no projects and can be enormous; the discovery walk
 * skips descending into them. A `.git` inside a real OpenWorkspace project is
 * fine — that's the workspace's own repo — so the project check wins.
 */
function isForeignGitWorktree(dir: string): boolean {
  if (readProjectUid(dir) !== null) return false;
  try {
    return fs.existsSync(path.join(dir, ".git"));
  } catch {
    return false;
  }
}

/** Walk up from `startDir` to the nearest enclosing project boundary. */
export function findProjectRoot(startDir: string): { root: string; uid: string } | null {
  let dir = path.resolve(startDir);
  for (;;) {
    const uid = readProjectUid(dir);
    if (uid !== null) return { root: dir, uid };
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function isUnder(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Lifecycle from location: under a shelf path → dormant/archived, else active. */
export function lifecycleOf(ws: Workspace, projectRoot: string): Lifecycle {
  const abs = path.resolve(projectRoot);
  const dormant = path.resolve(ws.root, ws.config.paths.dormant);
  const archives = path.resolve(ws.root, ws.config.paths.archives);
  if (isUnder(abs, dormant)) return "dormant";
  if (isUnder(abs, archives)) return "archived";
  return "active";
}

/**
 * The EFFECTIVE lifecycle (decision-2 — metadata-as-truth): the declared
 * `_project/project.toml` value wins; location is the seed/fallback when
 * nothing is declared.
 *
 * This is the ONE source of truth. `lifecycleOf` remains the location-derived
 * VIEW; `reconcile` aligns the two when they disagree.
 */
export function effectiveLifecycle(ws: Workspace, projectRoot: string): DeclaredLifecycle {
  const declared = readDeclaredLifecycle(projectRoot).lifecycle;
  return declared ?? lifecycleOf(ws, projectRoot);
}

export interface DiscoverOptions {
  /** Include the shelves (Dormant Projects / Archives). Default false. */
  all?: boolean;
  /** Safety bound on recursion depth from the workspace root. Default 12. */
  maxDepth?: number;
}

/**
 * Live-tree project discovery, bounded by the workspace root. Any directory
 * with `_project/id` is a project; nested projects are boundaries and are
 * discovered as their own entries (with `nestedUnder` set). Shelf paths are
 * excluded from the default scan; `all: true` includes them, with lifecycle
 * inferred from location.
 *
 * The walk respects `discovery.ignore`, skips the marker and `_project`
 * primitive dirs, and — for speed on a large real workspace — does NOT descend
 * into a foreign git checkout's working tree (a dir with `.git` that is not an
 * OpenWorkspace project). It DOES still descend into real projects so nested
 * projects are found. `maxDepth` bounds runaway recursion.
 */
export function discoverProjects(ws: Workspace, options: DiscoverOptions = {}): ProjectInfo[] {
  const includeShelves = options.all === true;
  const maxDepth = options.maxDepth ?? 12;
  const ignore = new Set(ws.config.discovery.ignore);
  const shelves = [
    path.resolve(ws.root, ws.config.paths.dormant),
    path.resolve(ws.root, ws.config.paths.archives),
  ];
  const projects: ProjectInfo[] = [];

  const walk = (dir: string, depth: number, enclosingProject: string | null): void => {
    if (depth > maxDepth) return;
    if (!includeShelves && shelves.some((s) => s === dir)) return;

    const uid = dir === ws.root ? null : readProjectUid(dir);
    let enclosing = enclosingProject;
    if (uid !== null) {
      const declared = readDeclaredLifecycle(dir);
      const located = lifecycleOf(ws, dir);
      projects.push({
        root: dir,
        relPath: path.relative(ws.root, dir),
        uid,
        lifecycle: located,
        nestedUnder: enclosingProject,
        effectiveLifecycle: declared.lifecycle ?? located,
        declaredLifecycle: declared.lifecycle,
        lifecycleSetAt: declared.setAt,
      });
      enclosing = dir;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (ignore.has(entry.name)) continue;
      if (entry.name === MARKER_DIR) continue;
      if (entry.name === "_project") continue; // primitives, never projects
      const child = path.join(dir, entry.name);
      // Don't walk a foreign git checkout's working tree (a cloned repo, a code
      // checkout that is not itself an OpenWorkspace project). These trees hold
      // no projects yet can be enormous — the single biggest cost when serving
      // a large real workspace (~Documents has ~20 nested git repos). A real
      // OpenWorkspace project that happens to carry `.git` is NOT skipped:
      // isForeignGitWorktree returns false for any dir with `_project/id`, so
      // the project boundary and any nested projects under it are still found.
      if (isForeignGitWorktree(child)) continue;
      walk(child, depth + 1, enclosing);
    }
  };

  walk(path.resolve(ws.root), 0, null);
  return projects;
}

/**
 * Duplicate-UID detection (iCloud copy / merge backstop, PRD §5.5).
 * Returns uid → project roots for every UID claimed by more than one project.
 */
export function findDuplicateUids(projects: ProjectInfo[]): Map<string, string[]> {
  const byUid = new Map<string, string[]>();
  for (const p of projects) {
    const list = byUid.get(p.uid);
    if (list === undefined) byUid.set(p.uid, [p.root]);
    else list.push(p.root);
  }
  const dupes = new Map<string, string[]>();
  for (const [uid, roots] of byUid) {
    if (roots.length > 1) dupes.set(uid, roots);
  }
  return dupes;
}

/** Find a project by UID via a live scan (shelves included). */
export function findProjectByUid(ws: Workspace, uid: string): ProjectInfo | null {
  const matches = discoverProjects(ws, { all: true }).filter((p) => p.uid === uid);
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new ConfigError(
      `duplicate project UID ${uid}: ${matches.map((m) => m.root).join(" and ")} — run doctor`,
    );
  }
  return matches[0] ?? null;
}
