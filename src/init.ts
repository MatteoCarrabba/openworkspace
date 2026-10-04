/**
 * Init (PRD §4.3, §4.1, Appendix A).
 *
 * - `initWorkspace` — `projects home init`: create the `.openworkspace/`
 *   marker and mint a workspace_id. config.toml carries only non-default
 *   values (the minted id and schema); everything else stays implicit.
 * - `initProject` — `projects init [<path>]` (path defaults to the cwd, with
 *   cli.ts guard rails): stamp the identity (`_project/id`), the orientation
 *   README, the committed git posture (_project/.gitignore, §6.1) and the
 *   information map (`project.toml` `[map]`, decision-2), then render the
 *   map into the project's README.md / AGENTS.md. Native stores are NOT
 *   pre-created: the map declares which primitives are homed natively, and
 *   each store is created by its first write (nothing scaffolded empty).
 *
 * Both are refuse-don't-overwrite: re-running against an existing target is a
 * ConflictError, never a silent restamp (hand edits are precious).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { ConfigError, ConflictError, NotFoundError } from "./lib/errors.js";
import { createExclusive, ensureDir, readTextIfExists, writeFileAtomic } from "./lib/fsatomic.js";
import {
  CORE_PRIMITIVES,
  CorePrimitive,
  DEFAULT_RENDER_TO,
  EntrySpec,
  PLAN_STUB,
  buildInfoMap,
  ensureMapDeclared,
  readInfoMap,
  renderMapDocs,
  serializeEntrySpec,
  validateSpec,
  writeMapEntry,
} from "./lib/infomap.js";
import {
  MAP_ONLY_CANDIDATES,
  PROJECT_TOML_REL,
  folderProjectUid,
  readMapOnlyDoc,
} from "./lib/projectdoc.js";
import { TomlTable, readTomlIfExists, writeToml } from "./lib/toml.js";
import { CONFIG_FILE, MARKER_DIR, readProjectUid } from "./lib/workspace.js";

// ---------------------------------------------------------------------------
// Stamped artifacts
// ---------------------------------------------------------------------------

/**
 * §6.1 — the committed git posture, stamped at init, checked by doctor.
 *
 * The bulk-archive pattern is ANCHORED (`/archive/`, i.e. `_project/archive/`
 * only): the PRD's example stanza shows an unanchored `archive/`, but per
 * gitignore semantics that would also ignore `tasks/archive/` and
 * `forum/threads/archive/` — directly contradicting §4.8 ("`_project/tasks/**`
 * (incl. `archive/`) … committed") and §11.4 ("archived records get committed
 * homes"). The §4.8 table wins; the stanza is anchored.
 */
export const PROJECT_GITIGNORE = `# OpenWorkspace git posture — stamped by \`projects init\`; doctor checks it.
forum/presence/
automations/*/logs/
/archive/
`;

/**
 * The `_project/README.md` stamped by init. Originally PRD Appendix A
 * verbatim; reframed by OpenWorkspace decision-2 (2026-10-03): the
 * information map comes first, native stores are optional and per-primitive.
 */
export const PROJECT_README = `# _project/ — OpenWorkspace control plane

This directory holds this project's OpenWorkspace records (\`projects\` CLI).
The project's actual content lives at the project root; agent configuration
(CLAUDE.md, AGENTS.md, .claude/) also stays at the root.

## First: where does this project's information live?

OpenWorkspace's job is to make every project say where each kind of its
information canonically lives — the task tracker, the decision log, the
knowledge base, plans, the coordination channel, and anything else worth
finding (credentials vault, data stores, …). That **information map** is
declared in \`project.toml\` under \`[map]\` and rendered into a generated
"Where information lives" section of the project's README.md and AGENTS.md.

    projects map show                      # the map, with each home's state
    projects map set tasks <url> --system "GitHub Issues" --locator owner/repo
    projects map set wiki native           # use OpenWorkspace's own file store
    projects map set forum none            # this project doesn't use one
    projects map render                    # re-render the README/AGENTS sections
    projects doctor                        # checks the map and the rendered sections

Each core primitive — tasks, decisions, wiki, plans, forum — is homed
**à la carte**: an OpenWorkspace native store here, an external system
(a URL, a system name plus a locator, or a repo path), or "none". When a
primitive lives elsewhere, the native command prints where instead of
writing here (\`projects task create\` exits 3 with the pointer).

## The two rules for native records

1. **Location encodes visibility and retention.** Live records sit directly
   in their store's directory; archived records sit in its \`archive/\`
   subdirectory. A project's lifecycle is declared in \`project.toml\`.
2. **Frontmatter encodes workflow state.** A task's \`status:\` (and a
   decision's, a thread's) lives in YAML frontmatter, edited in place.
   Never encode state by moving a record between subdirectories; never
   duplicate a fact in both places.

Everything is plain Markdown + YAML frontmatter (TOML for config). Edit
records with the CLI when one exists, or directly in a text editor —
\`projects doctor\` checks the invariants either way. **Preserve frontmatter
keys you don't recognize.**

## What lives here

- \`id\` — stable project UUID. Never edit; survives renames and moves.
- \`.gitignore\` — this project's git posture (stamped at init; doctor checks
  it). Ignored material here may still be canonical (synced, backed up) —
  **never run \`git clean -fdx\` in this workspace.**
- \`project.toml\` — declared facts: the \`[map]\`, \`lifecycle\`, \`[[owns]]\` edges.

Native stores exist only for the primitives the map homes here, and each is
created by its first write — never scaffolded empty:

- \`tasks/\` — one file per task: \`task-<n> - <slug>.md\`. Status in
  frontmatter (\`todo | doing | waiting | review | done\`; \`done\` needs a
  \`## Final Summary\`). Subtasks use dotted IDs (\`task-36.7\`). Reminders
  are tasks with \`hidden_until: <date>\`; recurring tasks set
  \`recur: <weekly|monthly|yearly|every-N-days>\`.
- \`decisions/\` — one short record per significant decision:
  \`decision-<n> - <slug>.md\`, Context / Decision / Consequences. Immutable
  once accepted; changing course means a new record plus \`superseded_by:\`.
- \`wiki/\` — substantive accumulated knowledge: research notes, reference
  pages, distilled findings, design docs.
- \`plans/current.md\` — the forward-looking plan, in prose.
- \`forum/\` — agent coordination: presence, workstream threads, addressed
  questions. One immutable file per message. Forum verbs always use the
  project's CANONICAL location — never hand-edit \`forum/\` from a worktree.
- \`automations/\` — scheduled-job definitions (not part of the map):
  nothing runs until \`projects automation apply\` on a declared machine.

Tool-created when needed: \`archive/\` (bulk preserved material; not tracked
in git) and \`dashboard/\` (dashboard config). Anything else is ordinary
project content and belongs at the project root.

## Quick reference

    projects map show · set <key> <home> · unset <key> · render · adopt
    projects task create "title" [--parent 36] [--quadrant q2]
    projects task list [--subtasks] [--hidden] [--all]
    projects decision new "title"
    projects forum announce --doing "..." · who · post <thread> "..." · inbox
    projects doctor

## What never lives here

No manifests, no status dashboards, no cached aggregate state: every view
is computed from these files at read time. No secrets — use secret
pointers (\`<scheme>://…\`) resolved at run time. No state-named
subdirectories (\`todo/\`, \`accepted/\`, …).

Validate with \`projects doctor\`.
`;

/** Forum orientation: schema + arrival protocol (PRD §4.3 / §4.6). */
export const FORUM_README = `# forum/ — coordination blackboard

The forum is a blackboard, not a switchboard: threads are the only message
home; participants are decoupled in time and identity; history is the point
(messages are never edited or deleted, read-state is reader-local).

## Layout

    forum/
      README.md
      presence/                      # EPHEMERAL — gitignored
        <machine>--<participant>.md  # sole writer = that session
      threads/
        <YYYY-MM-DD>--<slug>/
          thread.md                  # status: open|resolved; touched only at open/resolve
          <UTCstamp>--<participant>--<rand4>.md   # one immutable file per message
        archive/

Message frontmatter: \`from\`, \`kind: note|checkin|question|answer|handoff|system\`,
\`ts\`, optional \`to:\` / \`re:\` / \`refs: [task-141]\` / \`machine:\`. Thread recency
is computed from the lexically-last message filename — never stored.

## Arrival protocol

1. \`projects forum announce --doing "<one line of intent>"\` — write your
   presence file (re-announce to heartbeat; \`depart\` when done).
2. \`projects forum who\` — see who else is here (presence ⋈ open-thread
   recency) and \`projects forum list\` for the open threads.
3. \`projects forum inbox\` — unanswered questions addressed to you.
4. Post into the relevant thread (\`projects forum post <thread> "..."\`), or
   open a new one per workstream (\`projects forum open "<title>"\`). Address
   questions with \`--to <participant>\`; answer with \`--kind answer --re <id>\`.

## Rules

- One immutable, uniquely-named file per message. Never edit or delete
  another participant's files. Sweeps touch own-machine presence only.
- Forum verbs always resolve to the project's CANONICAL location — from a
  git worktree, the CLI reads and writes the canonical tree (a worktree's
  forum/ is a stale branch snapshot). Never hand-edit forum/ in a worktree.
- Cross-project coordination belongs in the coordinating project's forum —
  the project is the channel.
`;

/** plans/current.md stub — now defined with the information map (store-emptiness checks). */
export { PLAN_STUB };

// ---------------------------------------------------------------------------
// projects home init
// ---------------------------------------------------------------------------

export interface InitWorkspaceResult {
  root: string;
  markerDir: string;
  workspaceId: string;
  created: boolean; // false when the marker already existed (id ensured only)
}

/**
 * Initialize (or complete) a workspace at `dir`: create `.openworkspace/`
 * and mint a workspace_id. config.toml is written with only the non-default
 * keys (schema + the minted workspace_id); shelf paths, ignore list, and the
 * resolver map stay implicit until someone declares a non-default value.
 * Idempotent: an existing marker with an id is left untouched.
 */
export function initWorkspace(dir: string): InitWorkspaceResult {
  const root = path.resolve(dir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new NotFoundError(`not a directory: ${root}`);
  }
  const markerDir = path.join(root, MARKER_DIR);
  const configPath = path.join(markerDir, CONFIG_FILE);
  const existed = fs.existsSync(markerDir);
  ensureDir(markerDir);
  ensureDir(path.join(markerDir, "machines")); // §4.1: the synced per-machine registry home

  const existing = readTextIfExists(configPath);
  if (existing !== null) {
    const m = /^\s*workspace_id\s*=\s*"([^"]+)"/m.exec(existing);
    if (m !== null) {
      return { root, markerDir, workspaceId: m[1] as string, created: !existed };
    }
    // Existing hand-maintained config without an id: prepend the minted id at
    // the top (top-level keys must precede any [table] header; prepending is
    // always valid TOML and preserves the human's comments byte-for-byte).
    // Atomic (PRD §5.1): this is the one path that rewrites a human's file —
    // a torn write here would truncate the workspace contract.
    const workspaceId = crypto.randomUUID();
    writeFileAtomic(configPath, `workspace_id = "${workspaceId}"\n` + existing);
    return { root, markerDir, workspaceId, created: !existed };
  }

  const workspaceId = crypto.randomUUID();
  createExclusive(configPath, `schema = 2\nworkspace_id = "${workspaceId}"\n`);
  return { root, markerDir, workspaceId, created: true };
}

/**
 * §7.3 — this machine's file in the synced registry
 * (`.openworkspace/machines/<machine-id>.toml`): one per machine, SOLE writer
 * = that machine (P15), ignored-but-synced. Three writers share this file —
 * `projects home init` (identity + heartbeat), `automation apply`/`deactivate`
 * (the activations list), and the runner (last-run outcomes) — all on THIS
 * machine, all through `patchMachineRegistry`, so the single-writer property
 * holds across machines while every write also refreshes the heartbeat
 * (a write IS a liveness proof). Reporting, never a control plane.
 *
 * VESTIGIAL-CANDIDATE (hub phase): the heartbeat stamp is peer-liveness
 * machinery — it lets OTHER machines infer this one is alive by reading its
 * synced file. A single-executor hub has no peers to prove liveness to this
 * way; see `_project/wiki/compute-plane-vestigial-catalog.md` §1 before
 * touching this. Not removed here — still functioning and depended on by the
 * live laptop automations.
 */
export function patchMachineRegistry(
  workspaceRoot: string,
  machineId: string,
  mutate: (existing: Record<string, unknown>) => Record<string, unknown>,
  now: Date = new Date(),
): string {
  const machinesDir = path.join(path.resolve(workspaceRoot), MARKER_DIR, "machines");
  ensureDir(machinesDir);
  const filePath = path.join(machinesDir, `${machineId}.toml`);
  let existing: Record<string, unknown> = {};
  try {
    existing = readTomlIfExists(filePath);
  } catch {
    // unreadable registry (a doctor warn): this machine owns the file — rewrite
  }
  writeToml(filePath, {
    ...mutate(existing),
    machine_id: machineId,
    heartbeat: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
  });
  return filePath;
}

/** Identity + heartbeat refresh (idempotent; `projects home init`). */
export function updateMachineRegistry(
  workspaceRoot: string,
  machineId: string,
  now: Date = new Date(),
): string {
  return patchMachineRegistry(workspaceRoot, machineId, (existing) => existing, now);
}

/** One activation as rendered into the synced registry (§7.3). */
export interface RegistryActivation {
  project_uid: string;
  name: string;
  label: string;
  applied_at: string;
  schedule: string;
}

function isTable(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function activationsOf(existing: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(existing["activations"])) return [];
  return existing["activations"].filter(isTable);
}

/** `automation apply` records (or refreshes) one activation. Own machine only. */
export function recordRegistryActivation(
  workspaceRoot: string,
  machineId: string,
  activation: RegistryActivation,
  now: Date = new Date(),
): string {
  return patchMachineRegistry(
    workspaceRoot,
    machineId,
    (existing) => {
      const kept = activationsOf(existing).filter(
        (a) => !(a["project_uid"] === activation.project_uid && a["name"] === activation.name),
      );
      kept.push({ ...activation });
      kept.sort((a, b) => String(a["label"]).localeCompare(String(b["label"])));
      return { ...existing, activations: kept };
    },
    now,
  );
}

/** `automation deactivate`/`prune` drops one activation. Own machine only. */
export function removeRegistryActivation(
  workspaceRoot: string,
  machineId: string,
  projectUid: string,
  name: string,
  now: Date = new Date(),
): string {
  return patchMachineRegistry(
    workspaceRoot,
    machineId,
    (existing) => {
      const kept = activationsOf(existing).filter(
        (a) => !(a["project_uid"] === projectUid && a["name"] === name),
      );
      const next = { ...existing };
      if (kept.length > 0) next["activations"] = kept;
      else delete next["activations"];
      return next;
    },
    now,
  );
}

/** One run's outcome, keyed `<uid>--<name>` under [last_runs] (latest only). */
export interface RegistryRunOutcome {
  project_uid: string;
  name: string;
  run_id?: string;
  started_at: string;
  finished_at: string;
  status: string;
  exit_code?: number;
  log?: string;
}

/** The runner appends its outcome to ITS OWN machine file (P15). */
export function recordRegistryRunOutcome(
  workspaceRoot: string,
  machineId: string,
  outcome: RegistryRunOutcome,
  now: Date = new Date(),
): string {
  return patchMachineRegistry(
    workspaceRoot,
    machineId,
    (existing) => {
      const lastRuns = isTable(existing["last_runs"]) ? { ...existing["last_runs"] } : {};
      const entry: Record<string, unknown> = {
        started_at: outcome.started_at,
        finished_at: outcome.finished_at,
        status: outcome.status,
      };
      if (outcome.run_id !== undefined) entry["run_id"] = outcome.run_id;
      if (outcome.exit_code !== undefined) entry["exit_code"] = outcome.exit_code;
      if (outcome.log !== undefined) entry["log"] = outcome.log;
      lastRuns[`${outcome.project_uid}--${outcome.name}`] = entry;
      return { ...existing, last_runs: lastRuns };
    },
    now,
  );
}

// ---------------------------------------------------------------------------
// projects init [<path>]
// ---------------------------------------------------------------------------

/**
 * What a FOLDER init stamps, relative to _project/. Native stores are
 * deliberately absent (decision-2): they appear on first write. A map-only
 * init (decision-3, the default without native stores) stamps no `_project/`
 * at all.
 */
export const SKELETON_ENTRIES = ["README.md", ".gitignore", "id", "project.toml"] as const;

export interface InitProjectOptions {
  /** Core primitives homed in OpenWorkspace's native stores. */
  native?: readonly CorePrimitive[];
  /** Other declared homes (external pointers or "none"), by map key. */
  homes?: Readonly<Record<string, EntrySpec>>;
  /**
   * Render the map into README.md / AGENTS.md (default true). A map-only
   * project's map LIVES in those docs, so `renderDocs: false` implies the
   * `_project/` folder form.
   */
  renderDocs?: boolean;
  /** Force the `_project/` folder form even with no native store (decision-3). */
  folder?: boolean;
}

export interface InitProjectResult {
  projectRoot: string;
  uid: string;
  /** Docs the map section was rendered into (project-root-relative). */
  rendered: string[];
  /** "map-only" (no `_project/`; the map lives in README.md/AGENTS.md) or "folder". */
  form: "folder" | "map-only";
}

/**
 * Stamp a project at `dir` (creating the directory when absent). Refuses when
 * `dir` is already a project (folder or map-only). Declares the information
 * map from `options` (undeclared primitives stay undeclared — doctor then asks
 * for a home) and renders it into the project docs.
 *
 * decision-3: with no native store requested the project is MAP-ONLY — no
 * `_project/` folder; its identity and map live in the README.md/AGENTS.md
 * block. A native store (`--native`, a `native` home), `folder: true` or
 * `renderDocs: false` gives the `_project/` folder form.
 */
export function initProject(dir: string, options: InitProjectOptions = {}): InitProjectResult {
  const projectRoot = path.resolve(dir);
  const existingUid = readProjectUid(projectRoot);
  if (existingUid !== null) {
    const where = folderProjectUid(projectRoot) !== null ? "_project/id is write-once" : "map-only: the uid is in its README/AGENTS map block";
    throw new ConflictError(`already a project (uid ${existingUid}): ${projectRoot} — ${where}`);
  }
  // Validate every requested home BEFORE touching disk.
  const specs: Array<[string, EntrySpec]> = [];
  for (const prim of options.native ?? []) specs.push([prim, { kind: "native" }]);
  for (const [key, spec] of Object.entries(options.homes ?? {})) specs.push([key, spec]);
  for (const [key, spec] of specs) validateSpec(key, spec);

  const wantsNative = specs.some(([, spec]) => spec.kind === "native");
  const folder =
    wantsNative ||
    options.folder === true ||
    options.renderDocs === false ||
    fs.existsSync(path.join(projectRoot, "_project"));
  if (!folder) return initMapOnlyProject(projectRoot, specs);

  const p = path.join(projectRoot, "_project");
  ensureDir(p);

  const uid = crypto.randomUUID();
  // id first and exclusively: it is the project's identity claim; losing a
  // race to a concurrent init must not half-stamp two skeletons.
  createExclusive(path.join(p, "id"), uid + "\n");

  const stamp = (rel: string, content: string): void => {
    const target = path.join(p, rel);
    if (!fs.existsSync(target)) createExclusive(target, content);
  };
  stamp("README.md", PROJECT_README);
  stamp(".gitignore", PROJECT_GITIGNORE);

  ensureMapDeclared(projectRoot);
  for (const [key, spec] of specs) writeMapEntry(projectRoot, key, spec);

  const rendered =
    options.renderDocs === false ? [] : renderMapDocs(projectRoot).map((r) => r.file);
  return { projectRoot, uid, rendered, form: "folder" };
}

/** Map-only init: the identity + map block, rendered into README.md and AGENTS.md. */
function initMapOnlyProject(projectRoot: string, specs: Array<[string, EntrySpec]>): InitProjectResult {
  ensureDir(projectRoot);
  const uid = crypto.randomUUID();
  const map: Record<string, unknown> = {};
  for (const [key, spec] of specs) map[key] = serializeEntrySpec(spec);
  const document: TomlTable = { map: orderMapKeys(map) };
  const info = buildInfoMap(projectRoot, document, { form: "map-only", source: mapOnlySourceFor(DEFAULT_RENDER_TO), uid });
  const rendered = renderMapDocs(projectRoot, { map: info }).map((r) => r.file);
  return { projectRoot, uid, rendered, form: "map-only" };
}

/**
 * The doc that carries a map-only project's source block: the first discovery
 * candidate (README.md, then AGENTS.md) among the render targets, else README.md.
 */
export function mapOnlySourceFor(renderTo: readonly string[]): string {
  const normalized = new Set(renderTo.map((r) => path.normalize(r)));
  return MAP_ONLY_CANDIDATES.find((c) => normalized.has(c)) ?? (MAP_ONLY_CANDIDATES[0] as string);
}

function orderMapKeys(map: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of CORE_PRIMITIVES) if (map[k] !== undefined) out[k] = map[k];
  for (const [k, v] of Object.entries(map)) if (!(k in out)) out[k] = v;
  return out;
}

// ---------------------------------------------------------------------------
// Converting between the two forms (decision-3)
// ---------------------------------------------------------------------------

export interface ToFolderResult {
  /** False when the project already had a `_project/` folder (nothing done). */
  converted: boolean;
  uid: string;
  /** Docs re-rendered (their blocks switch to the folder flavor). */
  rendered: string[];
}

/**
 * Give a map-only project its `_project/` folder — the moment its first native
 * store is enabled. The map moves VERBATIM from the README/AGENTS block into
 * `_project/project.toml` (which becomes the one source of truth), `_project/id`
 * keeps the same uid, and the docs are re-rendered in the folder flavor.
 * Idempotent: a folder project is left untouched.
 *
 * Crash-safe ordering: project.toml first, then id (the moment the folder
 * becomes authoritative), then the docs (a stale block is only cosmetic —
 * doctor flags it and `projects map render` fixes it).
 */
export function ensureProjectFolder(projectRoot: string, options: { dryRun?: boolean } = {}): ToFolderResult {
  const folderUid = folderProjectUid(projectRoot);
  if (folderUid !== null) return { converted: false, uid: folderUid, rendered: [] };
  const doc = readMapOnlyDoc(projectRoot);
  if (doc === null) throw new NotFoundError(`not a project (no _project/id and no map-only block): ${projectRoot}`);
  if (doc.problems.length > 0) {
    throw new ConfigError(`${doc.problems[0]} — fix the TOML block in ${doc.file} first (nothing written)`);
  }
  if (options.dryRun === true) {
    return { converted: true, uid: doc.uid, rendered: renderMapDocs(projectRoot, { dryRun: true }).map((r) => r.file) };
  }
  const raw: TomlTable = {};
  for (const [k, v] of Object.entries(doc.raw)) if (k !== "format" && k !== "uid") raw[k] = v;
  if (raw["map"] === undefined) raw["map"] = {};

  const p = path.join(projectRoot, "_project");
  ensureDir(p);
  writeToml(path.join(projectRoot, PROJECT_TOML_REL), raw);
  const stamp = (rel: string, content: string): void => {
    const target = path.join(p, rel);
    if (!fs.existsSync(target)) createExclusive(target, content);
  };
  stamp("README.md", PROJECT_README);
  stamp(".gitignore", PROJECT_GITIGNORE);
  createExclusive(path.join(p, "id"), doc.uid + "\n");
  const rendered = renderMapDocs(projectRoot).filter((r) => r.changed).map((r) => r.file);
  return { converted: true, uid: doc.uid, rendered };
}

export interface ToMapOnlyPlan {
  /** True when the project can become map-only (no blockers). */
  eligible: boolean;
  /** Why not (each a human sentence). */
  blockers: string[];
  /** `_project/`-relative entries that would be removed (tool stamps, empty stores). */
  removes: string[];
  /** True when the project already is map-only. */
  alreadyMapOnly: boolean;
}

const STAMPED_README_HEADING = "# _project/ — OpenWorkspace control plane";
const GITIGNORE_STAMP_LINES = new Set(["forum/presence/", "automations/*/logs/", "/archive/", "archive/"]);

/** Plan `projects map adopt --map-only` (pure read). */
export function planToMapOnly(projectRoot: string): ToMapOnlyPlan {
  if (folderProjectUid(projectRoot) === null) {
    const already = readMapOnlyDoc(projectRoot) !== null;
    return {
      eligible: false,
      blockers: already ? [] : ["not an OpenWorkspace project"],
      removes: [],
      alreadyMapOnly: already,
    };
  }
  const blockers: string[] = [];
  const removes: string[] = [];
  const map = readInfoMap(projectRoot);
  for (const prob of map.problems) blockers.push(`information map problem: ${prob}`);
  if (!map.declared) {
    blockers.push("no [map] declared (legacy: every primitive is treated as native) — declare homes first (`projects map adopt --apply`, `projects map set`)");
  }
  const prunable = new Set(pruneEmptyStores(projectRoot, { dryRun: true }));
  for (const e of map.entries) {
    if (!e.core) continue;
    const prim = e.key as CorePrimitive;
    if (e.kind === "native" && e.source === "declared") {
      blockers.push(`${prim} is declared native — point it at its real home first (\`projects map set ${prim} <url>|none\`)`);
    }
  }
  const p = path.join(projectRoot, "_project");
  let names: string[] = [];
  try {
    names = fs.readdirSync(p);
  } catch {
    names = [];
  }
  for (const name of names.sort()) {
    const full = path.join(p, name);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (name === ".DS_Store") {
      removes.push(name);
      continue;
    }
    if (st.isDirectory()) {
      if (prunable.has(`_project/${name}/`)) removes.push(`${name}/`);
      else if (isEmptyTree(full)) removes.push(`${name}/`);
      else blockers.push(`_project/${name}/ still holds content — migrate it to its declared home (or keep the folder)`);
      continue;
    }
    if (!st.isFile()) {
      blockers.push(`_project/${name} is not a regular file`);
      continue;
    }
    if (name === "id" || name === "project.toml") {
      removes.push(name);
    } else if (name === "README.md") {
      const text = readTextIfExists(full) ?? "";
      if (text.startsWith(STAMPED_README_HEADING)) removes.push(name);
      else blockers.push("_project/README.md is not the stamped orientation file — move what it says somewhere else first");
    } else if (name === ".gitignore") {
      const lines = (readTextIfExists(full) ?? "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"));
      if (lines.every((l) => GITIGNORE_STAMP_LINES.has(l))) removes.push(name);
      else blockers.push("_project/.gitignore carries rules beyond the stamped git posture — review it first");
    } else {
      blockers.push(`_project/${name} is left in the folder — move or remove it first`);
    }
  }
  return { eligible: blockers.length === 0, blockers, removes, alreadyMapOnly: false };
}

function isEmptyTree(dir: string): boolean {
  let ents: fs.Dirent[];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const ent of ents) {
    if (ent.name === ".DS_Store" || ent.name === ".gitkeep") continue;
    if (ent.isDirectory() && isEmptyTree(path.join(dir, ent.name))) continue;
    return false;
  }
  return true;
}

export interface ToMapOnlyResult extends ToMapOnlyPlan {
  converted: boolean;
  uid: string | null;
  rendered: string[];
}

/**
 * Convert a folder project whose stores are all retired to map-only: the map
 * (and lifecycle, owns — everything in project.toml) plus the uid move into
 * the README/AGENTS block, then `_project/` is removed — only when nothing but
 * the tool's own stamps and empty stores is left in it. Refuses otherwise.
 *
 * Ordering: docs first (while the folder is still authoritative — a crash here
 * leaves a folder project with a stale-flavored block), then `_project/` (the
 * moment the block becomes authoritative).
 */
export function convertToMapOnly(projectRoot: string): ToMapOnlyResult {
  const plan = planToMapOnly(projectRoot);
  if (!plan.eligible) return { ...plan, converted: false, uid: null, rendered: [] };
  const uid = folderProjectUid(projectRoot) as string;
  const raw = readTomlIfExists(path.join(projectRoot, PROJECT_TOML_REL));
  if (raw["map"] === undefined) raw["map"] = {};
  const info0 = buildInfoMap(projectRoot, raw, { form: "map-only", source: "README.md", uid });
  const info = buildInfoMap(projectRoot, raw, { form: "map-only", source: mapOnlySourceFor(info0.renderTo), uid });
  // Stores that are about to be removed must not read as "inferred native".
  for (const e of info.entries) {
    if (e.core && e.source === "inferred") {
      e.kind = "undeclared";
      e.source = "undeclared";
    }
  }
  const rendered = renderMapDocs(projectRoot, { map: info }).filter((r) => r.changed).map((r) => r.file);
  fs.rmSync(path.join(projectRoot, "_project"), { recursive: true });
  return { ...plan, converted: true, uid, rendered };
}

// ---------------------------------------------------------------------------
// Pruning empty native stores (`projects map adopt --prune-empty`)
// ---------------------------------------------------------------------------

const IGNORABLE_FILES = new Set([".DS_Store", ".gitkeep"]);

/**
 * True when `dir` holds nothing a person wrote: only (nested) directories,
 * ignorable files, and files byte-equal to a known stamped stub.
 */
function onlyStubs(dir: string, stubs: ReadonlyMap<string, string>, rel = ""): boolean {
  let ents: fs.Dirent[];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const ent of ents) {
    const entRel = rel === "" ? ent.name : `${rel}/${ent.name}`;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (!onlyStubs(full, stubs, entRel)) return false;
    } else if (ent.isFile()) {
      if (IGNORABLE_FILES.has(ent.name)) continue;
      const stub = stubs.get(entRel);
      if (stub === undefined || readTextIfExists(full) !== stub) return false;
    } else {
      return false; // symlinks etc.: never prune
    }
  }
  return true;
}

/** The legacy skeleton's store dirs and their stamped stubs (relative to the store). */
const PRUNABLE_STORES: ReadonlyArray<{ rel: string; stubs: ReadonlyMap<string, string> }> = [
  { rel: "tasks", stubs: new Map() },
  { rel: "decisions", stubs: new Map() },
  { rel: "wiki", stubs: new Map() },
  { rel: "plans", stubs: new Map([["current.md", PLAN_STUB]]) },
  { rel: "forum", stubs: new Map([["README.md", FORUM_README]]) },
  { rel: "automations", stubs: new Map() },
];

/**
 * Remove the native store directories that hold nothing but the old
 * skeleton (empty dirs, the untouched plan stub, the stamped forum README).
 * Anything with real content is left untouched. Returns the removed
 * `_project/`-relative paths (or, with dryRun, what would be removed).
 */
export function pruneEmptyStores(projectRoot: string, options: { dryRun?: boolean } = {}): string[] {
  const removed: string[] = [];
  for (const store of PRUNABLE_STORES) {
    const dir = path.join(projectRoot, "_project", store.rel);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    if (!onlyStubs(dir, store.stubs)) continue;
    if (options.dryRun !== true) fs.rmSync(dir, { recursive: true });
    removed.push(`_project/${store.rel}/`);
  }
  return removed;
}
