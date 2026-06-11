# OpenWorkspace v1 — module contract

This file is the CONTRACT between the foundation (`src/lib/**`, built first) and the
downstream agents building primitives in parallel. Spec of record:
`Personal OS/_project/wiki/OPENWORKSPACE_PRD.md` — where this file and the PRD disagree,
the PRD wins.

## Ground rules

- **File ownership.** An agent touches ONLY its own files + its own tests:

  | Agent / concern | Owns (source) | Owns (tests) |
  |---|---|---|
  | foundation (done) | `src/lib/*.ts`, `tests/helpers.ts`, `tests/fixtures/**` | `tests/{fsatomic,frontmatter,toml,workspace,machine,resolve,ids}.test.ts` |
  | tasks | `src/primitives/tasks.ts` | `tests/tasks.test.ts` |
  | decisions | `src/primitives/decisions.ts` | `tests/decisions.test.ts` |
  | forum | `src/primitives/forum.ts` | `tests/forum.test.ts` |
  | automations | `src/primitives/automations.ts`, `src/runner.ts` | `tests/automations.test.ts`, `tests/runner.test.ts` |
  | importers | `src/importers.ts` | `tests/importers.test.ts` |
  | reconcile (decision-2) | `src/reconcile.ts` | `tests/reconcile.test.ts`, `tests/lifecycle-metadata.test.ts`, `tests/lifecycle-intent.test.ts` |
  | doctor | `src/doctor.ts` | `tests/doctor.test.ts` |
  | skills | `src/skills.ts` | `tests/skills.test.ts` |
  | dashboard | `src/dashboard/server.ts` | `tests/dashboard.test.ts` |
  | CLI / integrator | `src/cli.ts` | `tests/cli.test.ts` |

  Need a change in a lib module? Ask the integrator; do not edit it yourself.
- **Runtime deps:** ONLY `yaml` and `smol-toml`. Node >= 20. CommonJS output via
  `tsc` (`module: NodeNext`, no `"type": "module"`), compiled to `dist/`.
  No raw-.ts bins; the CLI entry is `dist/src/cli.js` (package `bin: projects`).
- **Build/test:** `npm run build` = `tsc`; `npm test` = `tsc && node --test "dist/tests/**/*.test.js"`.
  Test files must be named `*.test.ts` (the glob only picks up `*.test.js`).
- **Tests run against temp dirs only** (`os.tmpdir()`), NEVER the live `~/Documents`
  workspace and NEVER the real `~/Library`. Use the helpers below; anything
  machine-local is path-injectable (`openMachineStore(dir)` or
  `OPENWORKSPACE_STORE_DIR`).
- **No registry/state files.** Discovery and views are live scans. `.openworkspace/`
  is read-only to every module except explicit config/machine-registry writers.
- **Atomic writes only.** Every record write goes through `fsatomic` (or
  `frontmatter.writeRecord`, which wraps it). Forum messages use `createExclusive`.
- **No C3 naming in core** (PRD §0 boundary test): no `Brief.md`, `Today.md`, etc.
  in any `src/**` path, filename, or surface name.
- **No secrets on disk, ever.** Secret *pointers* (`<scheme>://<ref>`) only;
  resolver map comes from `workspace.config.secrets.resolvers` and ships empty.

## Error conventions

All lib errors extend `OwError` (`src/lib/errors.ts`):

```ts
class OwError extends Error { readonly code: string; readonly exitCode: number }
class NotFoundError extends OwError  // ENOTFOUND, exit 1
class ParseError    extends OwError  // EPARSE,    exit 1
class ConfigError   extends OwError  // ECONFIG,   exit 1
class ConflictError extends OwError  // ECONFLICT, exit 1
class ResolveError  extends OwError  // ERESOLVE,  exit 2  (canonical resolution failure)
class LockError     extends OwError  // ELOCK,     exit 1
```

Lib code throws; it never calls `process.exit` and never prints. Exit-code mapping
is reserved for the CLI layer: catch `OwError`, print `error: ${message}` to stderr,
exit with `err.exitCode`; unknown errors exit 1. Exit codes are 0/1/2 (PRD §8).
`ResolveError` is deliberately loud (PRD §6.3): NEVER catch it and fall back to
worktree-local writes.

## `src/lib/fsatomic.ts`

```ts
function ensureDir(dirPath: string): void
function writeFileAtomic(filePath: string, data: string | Buffer): void
    // temp-in-same-dir + fsync + rename; creates parents; cleans temp on failure
function createExclusive(filePath: string, data: string | Buffer): void
    // open(wx); ConflictError if the file exists (maildir-style identity writes)
function appendSafe(filePath: string, data: string): void
    // append-only, creates parents; single-writer files only (P15)
function readTextIfExists(filePath: string): string | null
function cleanStaleTempFiles(dirPath: string, olderThanMs?: number): string[]
    // removes only our `.{name}.ow-tmp-*` crash leftovers; returns removed paths
```

## `src/lib/frontmatter.ts` — the lossless codec (load-bearing)

```ts
interface FrontmatterRecord {
  data: Record<string, unknown>;  // plain-JS view ({} if absent/unparseable)
  body: string;                   // raw text after the closing ---
  doc: Document | null;           // parsed yaml Document — READ view only;
                                  // mutate via setFields/deleteFields (direct
                                  // doc edits do NOT affect serialization)
  errors: string[];               // YAML parse errors (forgiving read)
  hasFrontmatter: boolean;
  eol: "\n" | "\r\n";
  // internal: originalText, dirty
}
function parseRecord(text: string): FrontmatterRecord
function serializeRecord(rec: FrontmatterRecord): string
function setFields(rec: FrontmatterRecord, updates: Record<string, unknown>): void
function deleteFields(rec: FrontmatterRecord, keys: string[]): void
function setBody(rec: FrontmatterRecord, body: string): void
function appendToBody(rec: FrontmatterRecord, text: string): void   // for `## Log` lines
function readRecord(filePath: string): FrontmatterRecord
function writeRecord(filePath: string, rec: FrontmatterRecord): void          // atomic
function updateRecordFile(filePath: string, updates: Record<string, unknown>): FrontmatterRecord
```

Fidelity contract (tested against real legacy fixtures in `tests/fixtures/`):
unmodified parse→serialize is **byte-for-byte**; targeted `setFields` changes ONLY
the affected value's bytes (range-spliced via the Document's node ranges) — unknown
keys, comments (inline comments on the edited line included), key order, quoting,
block lists, folded `>-` scalars, CRLF, and EOF-terminated frontmatter all survive. Forgiving read / strict write:
records with YAML errors expose best-effort `data` and re-serialize their original
bytes, but any mutation throws `ParseError`. New keys append at the end of the
block. **Never hand-roll frontmatter manipulation in a primitive module.**
Note: `data` values are plain YAML-core types — dates stay strings; parse them
yourself (`hidden_until`, `created`, …).

## `src/lib/toml.ts`

```ts
type TomlTable = Record<string, unknown>
function parseToml(text: string, source?: string): TomlTable       // ParseError on bad TOML
function readToml(filePath: string): TomlTable
function readTomlIfExists(filePath: string): TomlTable             // missing file → {}
function stringifyToml(value: TomlTable): string
function writeToml(filePath: string, value: TomlTable): void       // atomic, whole-doc
```

Writes are whole-document and only for files the tool OWNS (machine registries,
activation records, config it stamped). Never rewrite a human-maintained TOML
file field-by-field — comments would be destroyed.

## `src/lib/workspace.ts` — the workspace contract (PRD §4.1)

```ts
const MARKER_DIR = ".openworkspace"
const DEFAULT_DORMANT = "Dormant Projects"; const DEFAULT_ARCHIVES = "Archives"
const DEFAULT_IGNORE = [".git","node_modules",".venv","venv","__pycache__",".obsidian"]
type Lifecycle = "active" | "dormant" | "archived"   // location-derivable view
type DeclaredLifecycle = Lifecycle  // = "active"|"dormant"|"archived" (ongoing dropped 2026-06-11)
interface WorkspaceConfig {
  schema: number; workspaceId: string | null;
  paths: { dormant: string; archives: string };
  discovery: { ignore: string[] };
  secrets: { resolvers: Record<string, string> };
}
interface Workspace { root: string; config: WorkspaceConfig }
interface ProjectInfo {
  root: string; relPath: string; uid: string; lifecycle: Lifecycle;  // location view
  nestedUnder: string | null;   // enclosing project root when nested
  // decision-2 (additive):
  effectiveLifecycle: DeclaredLifecycle;   // declared wins, else location — THE source of truth
  declaredLifecycle: DeclaredLifecycle | null;  // explicit project.toml value, else null
  lifecycleSetAt: string | null;           // lifecycle_set audit stamp
}
function findWorkspaceRoot(startDir: string): string | null    // walk-up for .openworkspace/
function loadWorkspaceConfig(rootDir: string): WorkspaceConfig // all keys optional + defaults
function openWorkspace(startDir: string): Workspace            // NotFoundError if no marker
function readProjectUid(dir: string): string | null            // _project/id, trimmed
function isProjectBoundary(dir: string): boolean
function findProjectRoot(startDir: string): { root: string; uid: string } | null  // walk-up
function lifecycleOf(ws: Workspace, projectRoot: string): Lifecycle   // location-derived VIEW
function locationOfDeclared(declared: DeclaredLifecycle): Lifecycle  // identity (vocabularies coincide)
function readDeclaredLifecycle(projectRoot): { lifecycle, setAt, problem }  // forgiving; unknown→null+problem
function writeDeclaredLifecycle(projectRoot, lifecycle, setAt): void // lossless; active sheds the key
function effectiveLifecycle(ws, projectRoot): DeclaredLifecycle      // declared-wins, location-fallback (TRUTH)
function discoverProjects(ws: Workspace, options?: { all?: boolean; maxDepth?: number }): ProjectInfo[]
function findDuplicateUids(projects: ProjectInfo[]): Map<string, string[]>
function findProjectByUid(ws: Workspace, uid: string): ProjectInfo | null  // live scan, shelves included
```

Semantics: a project = any dir with `_project/id`; nested projects are boundaries
and appear as their own entries; the workspace root itself is never a project;
shelf dirs (configured `paths.dormant`/`paths.archives`) are excluded from default
scans (`all: true` includes them); lifecycle's SOURCE OF TRUTH is the declared
`project.toml` field (`effectiveLifecycle`), with `lifecycleOf` (location) the
derived view — `reconcile` aligns them (decision-2). Primitive scanners
(tasks/forum/…) must NOT descend across a nested project boundary — use
`isProjectBoundary` when walking project content.

## `src/lib/machine.ts` — machine identity + machine-local store

```ts
const STORE_DIR_ENV = "OPENWORKSPACE_STORE_DIR"
interface MachineStore { dir: string }
function defaultStoreDir(env?: NodeJS.ProcessEnv): string
    // env override, else ~/Library/Application Support/OpenWorkspace
function openMachineStore(dir?: string, env?: NodeJS.ProcessEnv): MachineStore
function machineId(store: MachineStore): string        // stable; minted once, write-once
function readUidCache(store: MachineStore): Record<string, string>          // uid → path
function writeUidCacheEntry(store: MachineStore, uid: string, canonicalPath: string): void
function dropUidCacheEntry(store: MachineStore, uid: string): void
function readKnownWorkspaces(store: MachineStore): string[]
function registerWorkspace(store: MachineStore, workspaceRoot: string): void  // idempotent
function readRunnerNode(store: MachineStore): string | null
function writeRunnerNode(store: MachineStore, nodePath: string | null): void
    // decision-1 (PRD §7.4): the granted runner's node binary on THIS machine —
    // a `runner-node` file in the store (mint-suffix pattern). Set validates
    // exists + regular file + executable; null clears. CLI: `projects home
    // runner-node`. Unset → plists fall back to process.execPath (apply warns).
interface LifecycleIntent { uid: string; to: string; at: string; machine: string }
function appendLifecycleIntent(store: MachineStore, intent: LifecycleIntent): void
function readLifecycleIntents(store: MachineStore): LifecycleIntent[]
function lastLifecycleIntent(store: MachineStore, uid: string): LifecycleIntent | null
    // decision-2: the NON-GIT tiebreaker substrate. Append-only JSONL
    // (lifecycle-intents.jsonl) recording every explicit `projects lifecycle`
    // command run on THIS machine — machine-local, OUTSIDE iCloud's reach, so
    // a drag (intent exists for the new location) is distinguishable from an
    // iCloud glitch (no local intent). Corrupt lines are skipped, never fatal.
function mintLocksDir(store: MachineStore): string
function activationsDir(store: MachineStore): string
function activationRecordPath(store: MachineStore, projectUid: string, name: string): string
    // <store>/activations/<uid>--<name>.toml — automations agent writes these (TOML)
```

EVERY caller must accept an injected store (or env) so tests never touch the real
`~/Library`. The Mini can hand-place `machine-id` (e.g. the file containing `mini`).
The UID cache and workspace list are rebuildable JSON — corrupt reads as empty.

## `src/lib/resolve.ts` — UID-anchored canonical resolution (PRD §6.3/§6.4)

```ts
interface ResolveResult {
  uid: string;
  canonicalRoot: string;   // project root in the canonical workspace checkout
  localRoot: string;       // where resolution started (may equal canonicalRoot)
  fromCache: boolean;
  inWorktree: boolean;     // HINT only (git rev-parse --git-dir vs --git-common-dir)
}
function isGitWorktree(dir: string): boolean   // false when git missing / not a repo
function isGitRepo(dir: string): boolean        // decision-2: is the Tier-1 tiebreaker available?
function gitShowAtHead(repoDir: string, repoRelPath: string): string | null  // committed bytes (iCloud can't forge)
function resolveCanonicalProject(startDir: string, store: MachineStore,
    options?: { extraWorkspaceRoots?: string[] }): ResolveResult
```

Chain: walk-up `_project/id` → UID → cache (verified against the target's
`_project/id`) → bounded rescan of known workspaces → verify → cache. Resolution
is UID-registry-FIRST; git is never used to find canonical. Failure throws
`ResolveError` (exit 2) — never silently falls back (split-brain forum).

**Forum/presence/automation-apply verbs MUST route writes AND reads through
`resolveCanonicalProject`. Task/decision/plan/wiki writes stay worktree-local**
(records ride the branch; coordination rides the machine — PRD §6.3).
Workspaces self-register on any resolution that starts inside one.

## `src/reconcile.ts` — heal location⟷metadata drift (decision-2)

```ts
type DriftDriver = "git-glitch" | "git-drag" | "intent-glitch" | "intent-drag" | "ambiguous"
function committedLifecycle(projectRoot): DeclaredLifecycle | null   // Tier-1: git show HEAD:project.toml
function classifyDrift(projectRoot, declared, located, store, uid): {
  driver: DriftDriver;
  resolution: "revert-location" | "heal-metadata" | "propose";   // the §4 safety asymmetry
  evidence: string;
}
function reconcilePlan(ws, store): ReconcilePlan        // PURE READ (dry-run); actions + ambiguous + errors
function renderPlan(plan, { mode }): string[]
function applyReconcile(plan, store, { auto? }): ApplyResult  // executes; --auto = glitch-certain class only
function revertLocation(ws, store, root, uid, declared): ConfirmResult  // human "this is a glitch"
function adoptLocation(ws, store, root, uid): ConfirmResult             // human "this is a real drag"
```

The keystone: **state has one home — the file's CONTENT; location is a derived,
reconciled view.** When content and location disagree, content wins UNLESS a
tombstone-honest signal proves the location change was a real human act (then
content is healed forward). The drag-vs-glitch tiebreaker layers: committed git
(Tier 1) → machine-local intent-log (Tier 2) → propose-only (Tier 3, the
irreducible case — never act, never fight the user). **Safety asymmetry:**
auto-apply only undoes glitches (`revert-location`); adopting a bare location
into metadata (`heal-metadata` from no proof) needs git-proof or a human flag.
Records heal narrowly (NOT field-as-truth, deferred): same-ID dedup (loser →
`_project/archive/reconcile/<stamp>/`, reversible) + ghost state-named-subdir
cleanup (`tasks/archive/`, `forum/threads/archive/` whitelisted). Differing
copies are NEVER auto-merged — reported as errors. Doctor REPORTS this drift
(shares `reconcilePlan`, so "what doctor warns" and "what reconcile fixes" can't
diverge); reconcile HEALS it. Worktrees and nested projects are skipped for the
lifecycle axis. Mirrors importers' plan/apply/render shape.

## `src/skills.ts` — cross-project skill aggregation + install (`projects skills sync`)

```ts
interface SkillMeta { name: string; description: string }
function parseSkillFrontmatter(text: string): { name: string | null; description: string | null }
function readSkillMeta(env: SkillsEnv, skillDir: string): SkillMeta
interface SkillsFs { existsSync; readdirSync; readFileSync; lstatSync; readlinkSync;
                     symlinkSync; unlinkSync; mkdirSync }   // injected subset of node:fs
interface SkillsEnv { ws; claudeSkillsDir: string | null; codexSkillsDir: string | null;
                      sourceRoots: string[]; readmePath: string | null; fs: SkillsFs }
function defaultSourceRoots(env: Pick<SkillsEnv, "ws" | "fs">): string[]
interface DiscoveredSkill { name: string; description: string; source: string }
interface DiscoverResult { skills: DiscoveredSkill[]; collisions: Map<string, string[]> }
function discoverSkills(env: SkillsEnv): DiscoverResult
type LinkActionKind = "create" | "update" | "prune" | "ok"
interface LinkAction { kind; link; target: string | null; layer: "agents"|"claude"|"codex"; current? }
interface SkillsPlan { skills; collisions; actions: LinkAction[]; readme: ReadmePlan | null }
interface ReadmePlan { path; changed: boolean; nextContent: string }
const README_BEGIN; const README_END                         // HTML-comment section markers
function renderReadmeSection(skills: DiscoveredSkill[]): string
function applyReadmeSection(current: string, skills: DiscoveredSkill[]): string  // idempotent replace-or-append
function planSkillsSync(env: SkillsEnv): SkillsPlan           // PURE — reads only
interface ApplyResult { applied: LinkAction[]; refusals: {action; reason}[]; readmeWritten: boolean }
function applySkillsSync(env: SkillsEnv, plan: SkillsPlan): ApplyResult
function renderPlan(plan: SkillsPlan, mode: "dry-run" | "apply"): string[]
```

A **pure planner** (`planSkillsSync`, reads only) + **applier** (`applySkillsSync`)
over an injected `SkillsEnv` — cli.ts (`cmdSkills`) supplies the real paths; tests
pass temp dirs (all three runtime/readme dirs are env-overridable —
`OPENWORKSPACE_CLAUDE_SKILLS_DIR` / `OPENWORKSPACE_CODEX_SKILLS_DIR` /
`OPENWORKSPACE_SKILLS_README` — so a real run is the only thing that touches the real
`~/.claude`/`~/.codex`). Three symlink layers: `agents` (`<ws>/.agents/skills/<name>`
→ canonical source, source of truth stays in the project), then `claude`/`codex`
(`<runtime>/skills/<name>` → the **aggregate**, so `.agents/` is the single hub). A
skill = a dir directly under a source root containing `SKILL.md`; name collisions are
first-root-wins and the loser is recorded. **Targets are stored relative to the link's
dir** (move/rename-safe) and paths are **opaque strings** (never shelled out — spaces
and `:` work). Managed entries are **only symlinks**: a non-symlink occupant (a real
`*-workspace` dir) is **refused, never clobbered** (in the applier; `cmdSkills` exits 1
if any link was refused). The README section is markered + idempotent (byte-identical
on an unchanged set), written via `writeFileAtomic`. The skills frontmatter reader is a
tiny tolerant scalar/block-scalar reader — deliberately NOT the lossless codec (it only
reads two fields and never writes a `SKILL.md` back).

## `src/dashboard/server.ts` — read-only dashboard (PRD §9): Projects + Automations

```ts
const DEFAULT_ALLOWED_HOSTS = ["localhost", "127.0.0.1"]  // the secure default set
const DEFAULT_BIND_HOST = "127.0.0.1"                      // secure default bind
function buildAllowedHosts(extra?: readonly string[]): Set<string>  // default ∪ configured (normalized)
function hostAllowed(hostHeader: string | undefined, allowed?: Set<string>): boolean  // DNS-rebinding defense
interface DashboardOptions { workspaceRoot: string; now?: () => Date;
  indexHtmlPath?: string; allowedHosts?: readonly string[] }   // allowedHosts ADDED to the default
function createDashboardServer(options: DashboardOptions): http.Server  // serves /api/scan + /api/automations
function startDashboard(options: DashboardOptions & { port?: number; host?: string }): Promise<RunningDashboard>
function scanWorkspace(ws: Workspace, now?: Date): ScanResult   // live scan: projects, tasks, rollups, attention
function scanAutomations(ws: Workspace, now?: Date): AutomationsScanResult  // declared×activated×last-run×drift join
// AutomationsScanResult: { generatedAt; workspace; machines: ScanMachineRegistry[];
//   automations: ScanAutomation[]; drift: (AutomationDrift & {automation;project})[] }
// AutomationDriftKind = "declared-not-activated" | "activated-undeclared"
```

**Two views, one read-only server.** `GET /api/scan` (Projects) is unchanged.
`GET /api/automations` is **new** — same security/cache posture as `/api/scan`
(Host-header DNS-rebinding defense, GET/HEAD-only → 405 otherwise, localhost-or-
configured-host bound, and the same `ScanCache` — now made generic `ScanCache<T>`).
`scanAutomations` joins three **read-only** live-tree sources with no `launchctl` /
App-Support reads: **declared machines** (`_project/automations/<name>/automation.toml`
`machines = [...]` via the manifest scan; invalid manifests reported, not thrown),
**activated-where** (the synced per-machine registries `.openworkspace/machines/<id>.toml`
`[[activations]]`), and **last-run + heartbeat staleness** (that machine's
`[last_runs."<uid>--<name>"]` outcome + `heartbeat` age). For each automation it walks
the **union of declared ∪ activating machines** and computes drift the way `doctor`
does — `declared-not-activated` and `activated-undeclared` (incl. an invalid manifest
whose declared set is empty) — attached per-automation and flattened into the top-level
`drift[]` with automation+project context. The `index.html` viewer (plain JS, no build
step) adds a URL-persisted top-level view switch (`?view=automations`), a machine-
registry freshness strip, per-automation cards (schedule, project+lifecycle, activated-
vs-declared, per-machine state/last-run/heartbeat pills), and a URL-persisted "Drift
only" filter (`?autofilter=drift`).

**SECURE DEFAULT, opt-in tailnet serving.** With no `host`/`allowedHosts`, it binds
`127.0.0.1` and accepts only `localhost`/`127.0.0.1` in the `Host` header — unchanged.
To serve over a tailnet the operator sets a **bind host** (`startDashboard({host})`,
CLI `--host`, config `host`; default `127.0.0.1` — e.g. a Tailscale IP or `0.0.0.0`)
and an **allowed-hosts** set (`allowedHosts`, CLI repeatable `--allow-host`, config
`allowed_hosts` array) that is *added to* the secure default via `buildAllowedHosts`
(entries are normalized: lowercased, IPv6 brackets stripped, a trailing `:port`
dropped — so `host.ts.net` and `host.ts.net:7777` both match). `hostAllowed` still
rejects anything outside the (default ∪ configured) set; the DNS-rebinding defense is
intact, just extensible. The server stays strictly read-only (GET/HEAD; 405 otherwise;
no mutation routes) — exposing it exposes a viewer, not a write surface. The CLI
(`cmdDashboard`) threads `--host`/`--allow-host` and the `host`/`allowed_hosts` config
keys (flags outrank config: `--host` over `host`, `--allow-host` APPENDS to
`allowed_hosts`).

## `src/lib/ids.ts` — sequential ID minting (PRD §4.4 "IDs", §5.2)

```ts
type IdPrefix = "task" | "decision"
interface ParsedId { prefix: IdPrefix; parts: number[]; machineSuffix: string | null }
function parseId(id: string): ParsedId | null            // task-36 | task-36.7 | task-7-mini
function formatId(prefix: IdPrefix, parts: number[], machineSuffix?: string | null): string
function idFromFilename(filename: string): ParsedId | null  // "task-36.7 - slug.md"
function nextTopLevel(treePaths: string[], prefix: IdPrefix): number
function nextChild(treePaths: string[], parentId: string): number
function withMintLock<T>(store: MachineStore, projectUid: string, fn: () => T,
    options?: { timeoutMs?: number; staleMs?: number; retryDelayMs?: number }): T
function mintId(store: MachineStore, projectUid: string, options: {
  prefix: IdPrefix; treePaths: string[]; parentId?: string; machineSuffix?: string;
  claim: (id: string) => void;       // REQUIRED: create the record file under the lock
  lock?: LockOptions;
}): string
```

The lock is machine-local, keyed by project UID (a working-tree lockfile is
per-worktree and protects nothing). The probe takes the max over ALL provided
tree paths — when minting from a worktree, pass BOTH the local tasks dir and the
canonical tasks dir. `claim` runs while the lock is held and must create the
file (use `createExclusive` or `writeFileAtomic`); the duplicate-ID doctor check
remains the cross-machine merge backstop. Filenames carry the ID:
`task-<n>[.<m>][-<machine>] - <slug>.md`.

## Test conventions + `tests/helpers.ts`

```ts
const FIXTURES_DIR: string                       // committed real legacy records
function fixturePath(...parts: string[]): string
function listFixtureFiles(subdir: string, ext?: string): string[]
function makeTmpDir(prefix?: string): string     // under os.tmpdir()
function rmrf(target: string): void
function makeTmpWorkspace(configToml?: string): {
  ws: Workspace; root: string;
  addProject(relPath: string, uid?: string): { root: string; uid: string };
  cleanup(): void;
}
function makeTmpStore(): { store: MachineStore; cleanup(): void }
```

- `node:test` + `node:assert/strict`; register cleanup with `t.after(...)`.
- Workspace-shaped tests use `makeTmpWorkspace`; anything touching the machine
  store uses `makeTmpStore`. Spaces and `:` in directory names are first-class —
  include at least one such path in any path-handling test you add.
- Fixtures under `tests/fixtures/` (`tasks/`, `reminders/`, `dirchannel/`) are
  REAL legacy records — byte-precious. Never edit them; copy into a temp dir if
  a test needs to mutate. Importer tests should run against these.

## `src/lib/clisurface.ts` — the CLI surface as data (doc-currency)

```ts
const CLI_SURFACE: Readonly<Record<string, ReadonlySet<string> | null>>  // command → subcommands
const RETIRED_PRIMITIVE_DIRS: readonly string[]   // reflections, scripts, cache, …
function checkDocCurrency(text: string): Array<{ snippet: string; reason: string }>
```

Pure functions consumed by the doctor's doc-currency check (PRD §10, R2/R3):
`projects …` references in CODE context (spans, fences, indented lines; shell
comments stripped) are validated against `CLI_SURFACE`; references to retired
`_project/<dir>/` vocabulary are flagged anywhere. Keep `CLI_SURFACE` in
lockstep with `cli.ts` dispatch — `tests/doctor.test.ts` asserts the shipped
orientation artifacts come out clean.

## Known gaps the integrator owns

*(Updated by the phase-2 fix pass, 2026-06-10.)*

- ~~`src/cli.ts`~~ — DONE: the full §8 surface lives in `src/cli.ts`, with
  automation and import verbs fully wired (no stubs remain); tests in
  `tests/cli.test.ts`. The integrator also owns `tests/acceptance.test.ts`.
  `import legacy --apply --all` isolates per-project failures: a failing
  project is refused whole (audit + refusal line still print), others apply.
- ~~`projects init` skeleton stamping~~ — DONE: `src/init.ts` (`initWorkspace`,
  `initProject`; Appendix A README, forum README, and the §6.1 `.gitignore`
  stamped verbatim); exact-skeleton check in `tests/acceptance.test.ts`.
- ~~doctor §10 subset gaps~~ — DONE except one item: heartbeat staleness,
  doc-currency, stale-worktree registrations, `.git/`-internal conflict scan,
  forum retention proposals, question aging, git-posture reconciliation
  (incl. the anchored `/archive/` stamp — the unanchored PRD §6.1 example
  pattern would ignore `tasks/archive/`; doctor proposes anchoring legacy
  stamps), automation-manifest validation findings (incl. the bare-secret
  hard error, the `timezone`-rejected-until-implemented error, and the
  `miss_policy`-not-enforced-at-fire-time warn), `[signature]` path checks,
  and placement drift + orphaned activations (read from the synced
  registries — `automationPlacementIssues`, which distinguishes
  present-but-INVALID manifests from genuinely-deleted definitions) all live
  in `src/doctor.ts` (tests in `tests/doctor.test.ts` + `tests/automations.test.ts`).
  The decision-1 runner-posture checks (2026-06-10) live there too:
  `runnerPostureIssues` — `runner-node-unset` / `runner-node-provenance`
  (Homebrew-Cellar path or `codesign -dv` without a Developer-ID Authority)
  / `claude-grant-staleness` (the `~/.local/bin/claude` symlink's version
  segment vs path-keyed TCC allow rows via `sqlite3`). Machine-local,
  best-effort: they run only when a `MachineStore` is passed in
  `DoctorWorkspaceOptions` (the CLI's `home doctor` passes it), system
  binaries sit behind the injectable `ExecFn` seam (`realExec` default;
  tests fake it with canned codesign/sqlite output), and an unreadable TCC
  db yields an **info**-severity "unverifiable" finding (`DoctorSeverity`
  now includes `"info"`; `DoctorReport.infos` counts them; only errors
  affect the exit code).
  Still pending: the aging-untracked-forum-message commit-sweep proposal.
- ~~`src/primitives/automations.ts` + `src/runner.ts`~~ — DONE (automations
  phase): manifest parse/validate, the §7.1-pinned cron union compiler
  (conformance test in `tests/automations.test.ts`), late-binding plists,
  `apply`/`deactivate`/`list`/`status`/`prune`/`logs`/`run-now`, the runner
  (UID→canonical at fire time, per-run §7.5 secret resolution env-only,
  machine-partitioned logs + retention, registry outcomes — including for
  manifest-load failures, which log + record an `error` outcome before
  rethrowing). `status` surfaces `manifest-invalid-active` (active here or
  per a remote registry while the manifest is present-but-invalid).
  `[schedule] timezone` is rejected until implemented; `miss_policy` is
  recorded for the supervise pass (runner = `skip`; doctor warns on more).
  launchctl sits behind the injectable `LaunchdAdapter` (`launchdFromEnv`;
  the `OPENWORKSPACE_LAUNCHD_DIR` override yields the file-backed fake —
  tests use it exclusively). The §7.4 TCC question is RESOLVED (decision-1,
  2026-06-10): plists invoke the runner with the machine-store-configured
  **runner-node** (`effectiveNodePath`: injected `ctx.nodePath` →
  `readRunnerNode(store)` → `process.execPath` fallback; apply/list/status
  share the one chain, and the fallback adds a warning to
  `ApplySummary.warnings`). The exec seam stays `runner.ts execute()`
  (spawn — leaves ride their own folder grants per the measurement);
  `direct_exec = true` is the documented hybrid fallback for claude jobs.
- ~~`src/importers.ts`~~ — DONE (importers phase): `projects import legacy`,
  dry-run-first with per-record audit lines; tasks/reminders/dirchannels per
  PRD §11 step 4 (incl. legacy `surfaced` reminders → live todo). Idempotency
  is *verified* (an ID hit must match by filename or byte-equal content — a
  collision with a pre-existing native task is a plan error), intra-plan
  duplicate targets are deduped-or-errored at plan time, and out-of-scope
  legacy material (`drafts/`, `archive/` beyond `tasks/`, v0.2
  `_project/reviews|proposals`) gets honest audited skips. The §11.4 manual
  items (review records → tasks; finance proposals re-home) and the
  re-migration itself remain migrating-agent work — see README "Status" for
  the pre-migration checklist (two real-corpus blockers to hand-fix).
- ~~The synced machine registry~~ — COMPLETE (`.openworkspace/machines/<id>.toml`,
  PRD §7.3): identity + heartbeat via `updateMachineRegistry`, activations via
  `recordRegistryActivation`/`removeRegistryActivation`, last-run outcomes via
  `recordRegistryRunOutcome` — all in `src/init.ts` on the shared
  `patchMachineRegistry` write path (sole writer = this machine, P15; every
  write refreshes the heartbeat).
