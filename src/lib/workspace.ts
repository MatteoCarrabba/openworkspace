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
import * as os from "node:os";
import * as path from "node:path";

import { ConfigError, NotFoundError } from "./errors.js";
import { configuredWorkspaceRoot } from "./locations.js";
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

// ---------------------------------------------------------------------------
// Project graph — typed `[[owns]]` edges (project-graph feature).
//
// The ownership edge is CANONICAL ON THE PARENT: a parent's
// `_project/project.toml` carries an additive `[[owns]]` array, one table per
// child. There is NO child-side `parent` key — a subproject "is" a subproject
// purely because some parent's `[[owns]]` points at it. Edge identity is by
// `ref` (a string the human wrote), not by UID, because a code/remote child
// may have no UID. The reader is forgiving (mirrors readDeclaredLifecycle): a
// malformed entry is collected as a non-fatal `problem`, never a throw — so a
// bad edge never blocks discovery.
//
// Backward-compat: smol-toml's parse() returns the whole document and every
// typed reader picks only its own named keys (readDeclaredLifecycle reads only
// `lifecycle`/`lifecycle_set`), so the currently-shipped dist/ tolerates a
// project.toml that ALSO carries `[[owns]]` — old code reads its lifecycle and
// ignores owns. (Accepted caveat: smol-toml's whole-doc rewrite drops comments;
// project.toml is a tool-owned declared-facts file, so `[[owns]]` inherits that
// posture, the same as `lifecycle`.)

export type OwnKind = "subproject" | "code" | "remote";

const OWN_KINDS = new Set<OwnKind>(["subproject", "code", "remote"]);

export interface OwnEdge {
  /** ws-relative path | absolute/~ path | remote URL — the human-written ref. */
  ref: string;
  kind: OwnKind;
  /** Optional display name. */
  name: string | null;
  /** Edge-resident lifecycle for code/remote children (metadata-only). */
  lifecycle: DeclaredLifecycle | null;
}

export interface OwnsResult {
  owns: OwnEdge[];
  /** Non-fatal; surfaced by doctor, never blocks discovery. */
  problems: string[];
}

/**
 * Read the `[[owns]]` edges from a project's `_project/project.toml`.
 *
 * Forgiving, like readDeclaredLifecycle: absent file / absent `owns` → empty;
 * an unparseable file or a malformed entry becomes a `problem` string, never a
 * throw. Each surviving entry must have a non-empty string `ref` and a `kind`
 * in {subproject, code, remote}; `name` and `lifecycle` are optional.
 */
export function readOwns(projectRoot: string): OwnsResult {
  const tomlPath = path.join(projectRoot, "_project", "project.toml");
  let raw: TomlTable;
  try {
    raw = readTomlIfExists(tomlPath);
  } catch (err) {
    return { owns: [], problems: [`unparseable project.toml: ${(err as Error).message}`] };
  }
  const rawOwns = raw["owns"];
  if (rawOwns === undefined) return { owns: [], problems: [] };
  if (!Array.isArray(rawOwns)) return { owns: [], problems: ["owns must be an array of tables"] };
  const owns: OwnEdge[] = [];
  const problems: string[] = [];
  for (const [i, entry] of rawOwns.entries()) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      problems.push(`owns[${i}] is not a table`);
      continue;
    }
    const e = entry as Record<string, unknown>;
    const ref = e["ref"];
    if (typeof ref !== "string" || ref === "") {
      problems.push(`owns[${i}] missing string ref`);
      continue;
    }
    const kind = e["kind"];
    if (typeof kind !== "string" || !OWN_KINDS.has(kind as OwnKind)) {
      problems.push(`owns[${i}] (${ref}) bad kind "${String(kind)}" (subproject|code|remote)`);
      continue;
    }
    const nm = e["name"];
    const lc = e["lifecycle"];
    const lifecycle =
      typeof lc === "string" && DECLARED_LIFECYCLES.has(lc as DeclaredLifecycle)
        ? (lc as DeclaredLifecycle)
        : null;
    if (lc !== undefined && lifecycle === null) {
      problems.push(`owns[${i}] (${ref}) bad lifecycle "${String(lc)}"`);
    }
    owns.push({
      ref,
      kind: kind as OwnKind,
      name: typeof nm === "string" && nm !== "" ? nm : null,
      lifecycle,
    });
  }
  return { owns, problems };
}

/**
 * Write the `[[owns]]` edges into `_project/project.toml`, read-modify-write to
 * PRESERVE every other key (lifecycle/lifecycle_set, P12 lossless). An empty
 * array SHEDS the key; if that leaves the document empty the file is removed —
 * exactly like writeDeclaredLifecycle's empty-doc branch.
 */
export function writeOwns(projectRoot: string, owns: OwnEdge[]): void {
  const tomlPath = path.join(projectRoot, "_project", "project.toml");
  const raw: TomlTable = readTomlIfExists(tomlPath);

  if (owns.length === 0) {
    delete raw["owns"];
  } else {
    raw["owns"] = owns.map((o) => ({
      ref: o.ref,
      kind: o.kind,
      ...(o.name ? { name: o.name } : {}),
      ...(o.lifecycle ? { lifecycle: o.lifecycle } : {}),
    }));
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
  /**
   * `[skills] bundled_dir`: override where OpenWorkspace's own bundled skills
   * are read from (relative paths resolve against the workspace root). null ⇒
   * the installed package's `skills/` dir; "" ⇒ disable bundled discovery.
   */
  skills: { bundledDir: string | null };
  /**
   * `[projects] external_roots`: extra project roots OUTSIDE the workspace
   * tree (e.g. a git repo that is itself an OpenWorkspace project and lives
   * under `~/Code`). Kept exactly as written; `externalProjectRoots` resolves
   * them (`~` ⇒ home dir, relative ⇒ against the workspace root).
   */
  projects: { externalRoots: string[] };
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
  /**
   * The resolved `[projects] external_roots` entry this project was found
   * under, or null for a project inside the workspace tree. For an external
   * project `relPath` is still `path.relative(ws.root, root)` (so it starts
   * with `..`) — the invariant `path.resolve(ws.root, relPath) === root` holds
   * for every project.
   */
  externalRoot: string | null;
}

export function defaultConfig(): WorkspaceConfig {
  return {
    schema: 2,
    workspaceId: null,
    paths: { dormant: DEFAULT_DORMANT, archives: DEFAULT_ARCHIVES },
    discovery: { ignore: [...DEFAULT_IGNORE] },
    secrets: { resolvers: {} },
    skills: { bundledDir: null },
    projects: { externalRoots: [] },
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
  const skills = raw["skills"];
  if (skills !== undefined && typeof skills === "object" && skills !== null) {
    const k = skills as Record<string, unknown>;
    if (k["bundled_dir"] !== undefined) config.skills.bundledDir = asString(k["bundled_dir"], "skills.bundled_dir");
  }
  const projectsTable = raw["projects"];
  if (projectsTable !== undefined && typeof projectsTable === "object" && projectsTable !== null) {
    const pt = projectsTable as Record<string, unknown>;
    const ext = pt["external_roots"];
    if (ext !== undefined) {
      if (!Array.isArray(ext) || ext.some((x) => typeof x !== "string")) {
        throw new ConfigError("config key projects.external_roots must be an array of strings");
      }
      config.projects.externalRoots = (ext as string[]).filter((x) => x.trim() !== "");
    }
  }
  return config;
}

/**
 * Open the workspace containing `startDir`; throws NotFoundError if none.
 *
 * Resolution order (phase 2 — location externalized from config):
 *  1. `~/.config/openworkspace/locations.toml` (or `OPENWORKSPACE_CONFIG_DIR`):
 *     if it exists and names a `localfs` store, that store's `path` IS the
 *     workspace root — `startDir` is not consulted at all. This is what lets
 *     `projects` run from anywhere, not only from inside the tree.
 *  2. Otherwise, fall back to today's behavior unchanged: walk up from
 *     `startDir` looking for `.openworkspace/`.
 * An absent or malformed locations.toml is indistinguishable from "no
 * config" (see `locations.ts`), so behavior with no config file is exactly
 * today's — this is intentionally conservative on a core resolution path.
 */
export function openWorkspace(startDir: string, env: NodeJS.ProcessEnv = process.env): Workspace {
  const configured = configuredWorkspaceRoot(env);
  if (configured !== null) {
    const marker = path.join(configured, MARKER_DIR);
    let st: fs.Stats | null = null;
    try {
      st = fs.statSync(marker);
    } catch {
      st = null;
    }
    if (st === null || !st.isDirectory()) {
      throw new NotFoundError(
        `configured workspace store "${configured}" has no ${MARKER_DIR}/ marker ` +
          `(check locations.toml — see \`projects locations list\`)`,
      );
    }
    return { root: configured, config: loadWorkspaceConfig(configured) };
  }

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

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * True when `p` lies inside `parent` (or is `parent`), comparing real paths so
 * symlinked spellings (/var vs /private/var, a symlinked ~/Code) agree.
 */
export function isWithinPath(p: string, parent: string): boolean {
  const a = realpathOrSelf(p);
  const b = realpathOrSelf(parent);
  return a === b || isUnder(a, b);
}

/**
 * Expand a leading `~` (`~` alone or `~/…`) to the home dir. `~user` forms are
 * NOT expanded (left as a relative path) — keep the config portable and simple.
 */
export function expandHomePath(p: string, home: string = os.homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

export interface ExternalRoot {
  /** The entry exactly as written in `[projects] external_roots`. */
  configured: string;
  /** Absolute path: `~` expanded, relative entries resolved against ws.root. */
  path: string;
}

/**
 * The workspace's `[projects] external_roots`, resolved and deduped (by
 * resolved path). Pure: no existence checks — discovery skips a missing root
 * silently and doctor reports it.
 */
export function externalProjectRoots(ws: Workspace, home: string = os.homedir()): ExternalRoot[] {
  const out: ExternalRoot[] = [];
  const seen = new Set<string>();
  for (const configured of ws.config.projects?.externalRoots ?? []) {
    const abs = path.resolve(ws.root, expandHomePath(configured, home));
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push({ configured, path: abs });
  }
  return out;
}

/** True when `p` is outside the workspace tree (location carries no lifecycle there). */
export function isOutsideWorkspace(ws: Workspace, p: string): boolean {
  const abs = path.resolve(p);
  const root = path.resolve(ws.root);
  if (abs === root || isUnder(abs, root)) return false; // fast path: no syscalls
  return !isWithinPath(abs, root);
}

/**
 * Cheap, spawn-free linked-worktree check for discovery: a linked git worktree
 * has a `.git` FILE whose `gitdir:` points into `<common>/.git/worktrees/…`
 * (a submodule's points into `.git/modules/…` and is not a worktree). The
 * authoritative git-based check (`resolve.ts#isGitWorktree`) still vetoes
 * canonical candidates; this one keeps worktrees out of external discovery
 * without forking git per directory.
 */
export function isLinkedWorktreeCheckout(dir: string): boolean {
  let text: string;
  try {
    const gitPath = path.join(dir, ".git");
    if (!fs.lstatSync(gitPath).isFile()) return false;
    text = fs.readFileSync(gitPath, "utf8");
  } catch {
    return false;
  }
  const m = /^gitdir:\s*(.+)$/m.exec(text);
  if (m === null || m[1] === undefined) return false;
  return /[\\/]worktrees[\\/][^\\/]+[\\/]?$/.test(m[1].trim());
}

/**
 * Lifecycle from location: under a shelf path → dormant/archived, else active.
 *
 * Outside the workspace tree (an `[projects] external_roots` project) location
 * carries NO lifecycle signal — there is no shelf to be under — so the view
 * mirrors the declared metadata (absent ⇒ active). Location and metadata then
 * never "drift" for an external project, so neither `projects lifecycle` nor
 * `reconcile` ever moves one: its lifecycle is metadata-only.
 */
export function lifecycleOf(ws: Workspace, projectRoot: string): Lifecycle {
  const abs = path.resolve(projectRoot);
  if (isOutsideWorkspace(ws, abs)) return readDeclaredLifecycle(abs).lifecycle ?? "active";
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
  /**
   * Include projects under `[projects] external_roots`. Default true. (The
   * shelves flag does not apply to them: an external project has no shelf
   * location; its lifecycle is its declared metadata.)
   */
  external?: boolean;
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
 *
 * External roots (`[projects] external_roots`) are then walked the same way,
 * each from its own root: an entry may be a project (e.g. a repo that is
 * itself an OpenWorkspace project) or a plain folder holding projects; nested
 * projects under it are found as usual. Missing roots are skipped silently
 * (doctor reports them). Guards: a linked git worktree is never discovered
 * from an external root (the root itself or any dir under it — a worktree of
 * a project repo carries the committed `_project/id` and would otherwise
 * surface as a duplicate UID and poison canonical resolution), a foreign git
 * checkout root is skipped, and every project is deduped by real path, so an
 * external root that overlaps the tree or another external root (or is a
 * symlink to one) never yields the same project twice.
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
  // Real paths of discovered project roots — populated only when external
  // roots are walked (the in-tree walk alone cannot visit a dir twice).
  let seenReal: Set<string> | null = null;

  const walk = (
    dir: string,
    depth: number,
    enclosingProject: string | null,
    externalRoot: string | null,
  ): void => {
    if (depth > maxDepth) return;
    if (externalRoot === null && !includeShelves && shelves.some((s) => s === dir)) return;
    if (externalRoot !== null && isLinkedWorktreeCheckout(dir)) return;

    const uid = externalRoot === null && dir === ws.root ? null : readProjectUid(dir);
    let enclosing = enclosingProject;
    if (uid !== null) {
      const real = seenReal !== null ? realpathOrSelf(dir) : null;
      if (seenReal !== null && real !== null && seenReal.has(real)) return; // already found
      if (seenReal !== null && real !== null) seenReal.add(real);
      const declared = readDeclaredLifecycle(dir);
      const located: Lifecycle =
        externalRoot === null ? lifecycleOf(ws, dir) : (declared.lifecycle ?? "active");
      projects.push({
        root: dir,
        relPath: path.relative(ws.root, dir),
        uid,
        lifecycle: located,
        nestedUnder: enclosingProject,
        effectiveLifecycle: declared.lifecycle ?? located,
        declaredLifecycle: declared.lifecycle,
        lifecycleSetAt: declared.setAt,
        externalRoot,
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
      walk(child, depth + 1, enclosing, externalRoot);
    }
  };

  walk(path.resolve(ws.root), 0, null, null);

  if (options.external !== false) {
    const externals = externalProjectRoots(ws);
    if (externals.length > 0) {
      seenReal = new Set(projects.map((p) => realpathOrSelf(p.root)));
      for (const ext of externals) {
        let st: fs.Stats;
        try {
          st = fs.statSync(ext.path);
        } catch {
          continue; // missing root: doctor warns, discovery never crashes
        }
        if (!st.isDirectory()) continue;
        if (isForeignGitWorktree(ext.path)) continue; // a code checkout, not a project
        walk(ext.path, 0, null, ext.path);
      }
    }
  }
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
