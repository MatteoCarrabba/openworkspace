#!/usr/bin/env node
/**
 * `projects` — the OpenWorkspace CLI (PRD §8).
 *
 * - node:util.parseArgs per subcommand with DECLARED flags only (strict mode;
 *   no greedy flag parsing — the v0.2 bug class).
 * - `--json` on every read (and on writes, for script callers).
 * - Errors print `error: <message>` to stderr; exit codes 0 / 1 / 2
 *   (2 = canonical resolution failure, never silently swallowed).
 * - Lib/primitive modules throw; ONLY this layer prints and exits.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";

import { doctorProjectReport, doctorWorkspace, DoctorReport } from "./doctor.js";
import { ImportPlan, applyLegacyImport, planLegacyImport, renderPlan } from "./importers.js";
import { initProject, initWorkspace, updateMachineRegistry } from "./init.js";
import { scanWorkspace, startDashboard } from "./dashboard/server.js";
import { ConfigError, ConflictError, NotFoundError, OwError, ResolveError } from "./lib/errors.js";
import {
  MachineStore,
  appendLifecycleIntent,
  machineId,
  openMachineStore,
  readMintSuffix,
  readRunnerNode,
  setMachineId,
  writeMintSuffix,
  writeRunnerNode,
  writeUidCacheEntry,
} from "./lib/machine.js";
import { isGitWorktree, registerWorkspaceIfCanonical, resolveCanonicalProject } from "./lib/resolve.js";
import { readToml } from "./lib/toml.js";
import {
  DeclaredLifecycle,
  MARKER_DIR,
  OwnEdge,
  OwnKind,
  ProjectInfo,
  Workspace,
  discoverProjects,
  effectiveLifecycle,
  findProjectRoot,
  findWorkspaceRoot,
  lifecycleOf,
  locationOfDeclared,
  openWorkspace,
  readDeclaredLifecycle,
  readOwns,
  readProjectUid,
  writeDeclaredLifecycle,
  writeOwns,
} from "./lib/workspace.js";
import {
  ResolvedOwn,
  buildOwnershipGraph,
  detectCycle,
  resolveOwnRef,
} from "./lib/owns.js";
import {
  adoptLocation,
  applyReconcile,
  reconcilePlan,
  renderPlan as renderReconcilePlan,
  revertLocation,
} from "./reconcile.js";
import * as decisions from "./primitives/decisions.js";
import * as forum from "./primitives/forum.js";
import * as tasks from "./primitives/tasks.js";
import * as automations from "./primitives/automations.js";
import { runAutomation } from "./runner.js";
import {
  SkillsEnv,
  SkillsFs,
  applySkillsSync,
  defaultSourceRoots,
  planSkillsSync,
  renderPlan as renderSkillsPlan,
} from "./skills.js";

// ---------------------------------------------------------------------------
// Plumbing

const USAGE = `projects — OpenWorkspace CLI

Workspace
  projects home init                      initialize the workspace marker here
  projects home list [--all] [--owner <ref>] [--json]   discover projects (live scan; --all includes shelves; --owner filters to a parent's subproject children)
  projects home scan [--json]             full workspace scan (projects + tasks + attention)
  projects home doctor [--json]           workspace + every project's invariant checks
  projects home mint-suffix [<suffix>|--clear]   this machine's ID suffix (e.g. "mini" → task-7-mini)
  projects home runner-node [<path>|--clear]     this machine's granted runner node binary (decision-1)
  projects home machine-id [<name>]       this machine's id — matched against manifests' machines = [...]

Projects
  projects init [<path>]                  stamp the full _project/ skeleton (default: the cwd)
  projects new <name> [--parent <ref>] [--kind subproject|code|remote]   create ./<name>/ and stamp the skeleton (--parent links it under a parent via [[owns]])
  projects show [--project <ref>] [--json]
  projects doctor [--project <ref>] [--json]
  projects rename <new-name> [--project <ref>]
  projects move <dest-dir> [--project <ref>]
  projects lifecycle <ref> --to <active|dormant|archived>   (metadata-primary: writes project.toml, then moves)
  projects reconcile [--all] [--apply] [--auto] [--json]            heal location⟷metadata drift (decision-2)
                     [--revert <ref>] [--adopt-location <ref>]      human tiebreak for ambiguous drift
    (dry-run default; --apply executes the plan except ambiguous rows; --auto = the glitch-certain class only)

Tasks (records ride the branch: writes are worktree-local)
  projects task create "title" [--parent <id>] [--quadrant qN] [--label L ...]
                       [--hidden-until YYYY-MM-DD] [--recur <weekly|monthly|yearly|every-N-days>]
  projects task list [--subtasks] [--hidden] [--all] [--json]
  projects task show <id> [--json]
  projects task edit <id> <field> <value>   (--clear to null the field)
  projects task note <id> "text" [--as <name>]
  projects task status <id> <todo|doing|waiting|review|done> [--force]
  projects task done <id> [--force]         (recurring: completes the occurrence)
  projects task hide <id> --until YYYY-MM-DD
  projects task recur <id> <interval|off>
  projects task archive <id>
  All task verbs take [--project <ref>] [--json].

Decisions
  projects decision new "title" [--expected "..."] · accept <id> · list [--status S]
                       show <id> · supersede <id> --by <id>     (+ --project, --json)

Project graph (typed [[owns]] edges, canonical on the parent)
  projects link add <child-ref> [--project <owner>] [--kind subproject|code|remote] [--name <n>] [--lifecycle <l>]
  projects link rm <child-ref> [--project <owner>]
  projects link list [--project <owner>] [--json]
  projects tree [--project <ref>] [--json]   show the ownership graph

Plan
  projects plan show [--project <ref>] [--json] · plan open

Forum (coordination rides the machine: always resolves the CANONICAL project)
  projects forum announce [--doing "..."] [--as <name>] · depart [--as <name>]
  projects forum who [--json] · list [--archived] [--json] · inbox [--as <name>] [--json]
  projects forum open "title" [--slug s] [--body "..."]
  projects forum post <thread> "body" [--kind K] [--to <name> ...] [--re <msg-id>] [--ref <id> ...]
  projects forum show <thread> [--since <ts>] [--json] · resolve <thread> · archive <thread>
  projects forum sweep [--json]           remove own-machine stale presence; propose thread archives

Automations (intent in the tree; activation is an explicit machine-local act)
  projects automation apply [<name>|--all] [--force]   compile cadence → LaunchAgent on THIS machine
  projects automation deactivate <name>                unload + remove this machine's activation
  projects automation list [--all]                     definitions (+ --all: every machine's registry)
  projects automation status                           activation records ↔ launchd ↔ tree drift report
  projects automation prune                            remove orphaned/undeclared activations here
  projects automation logs <name> [--machine M]        machine-partitioned run logs
  projects automation run-now <name>                   run once, through the runner path
  All automation verbs take [--project <ref>] [--json].

Skills (aggregate per-project Skills/ into .agents/skills/, install for the runtimes)
  projects skills sync [--dry-run|--apply] [--json]    discover → .agents/skills/ symlinks → ~/.claude + ~/.codex links; prune removed; update README section
    (dry-run default; --apply executes; sources stay canonical in their project, .agents/ is the index)

Dashboard
  projects dashboard dev [--port N] [--host H] [--allow-host H]... [--cache-ttl MS] [--config <path>]   read-only dashboard (foreground; localhost-only; scan cache off by default)
  projects dashboard open [--port N] [--host H] [--allow-host H]... [--cache-ttl MS] [--config <path>]  same, and open the browser

Import (PRD §11 — dry-run-first; apply executes exactly the rendered plan)
  projects import legacy [--dry-run|--apply] [<project-ref>|--all] [--json]
    (a) legacy Backlog.md tasks → native tasks (status fidelity; archived → tasks/archive/)
    (b) legacy reminders → tasks (surface_on → hidden_until; dismissed/promoted → archived)
    (c) dirchannels → forum (threads <date>--<channel>--<slug>; one maildir file per message)

Exit codes: 0 ok · 1 error · 2 canonical-resolution failure.
`;

function print(text: string): void {
  process.stdout.write(text.endsWith("\n") ? text : text + "\n");
}

function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function fail(message: string, exitCode = 1): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(exitCode);
}

type Spec = NonNullable<Parameters<typeof parseArgs>[0]>["options"];

/** Strict, declared-flags-only parse of the remaining argv. */
function parse(args: string[], options: Spec): { values: Record<string, unknown>; positionals: string[] } {
  try {
    const parsed = parseArgs({ args, options, allowPositionals: true, strict: true });
    return { values: parsed.values as Record<string, unknown>, positionals: parsed.positionals };
  } catch (err) {
    throw new ConfigError(err instanceof Error ? err.message : String(err));
  }
}

const FLAG_JSON: Spec = { json: { type: "boolean", default: false } };
const FLAG_PROJECT: Spec = { project: { type: "string" } };

function getStore(): MachineStore {
  return openMachineStore(undefined, process.env);
}

/**
 * Open the workspace containing `startDir` AND register it with the machine
 * store (worktree roots are never registered — resolve.ts guards). Every
 * workspace-routed command goes through this, so the canonical checkout is
 * resolvable after ANY command run from inside it — not only forum verbs
 * (PRD §6.4: UID-registry-first from day one).
 */
function openWorkspaceRegistered(startDir: string): Workspace {
  const ws = openWorkspace(startDir);
  registerWorkspaceIfCanonical(getStore(), ws.root);
  return ws;
}

/**
 * Resolve `--project <ref>` (path, workspace-relative path, unique directory
 * name, or UID) to a project root; default = walk-up from cwd.
 */
function resolveProject(ref: string | undefined): { root: string; uid: string } {
  if (ref === undefined) {
    const found = findProjectRoot(process.cwd());
    if (found === null) {
      throw new NotFoundError(
        `not inside a project (no _project/id walking up from ${process.cwd()}); pass --project <ref>`,
      );
    }
    return found;
  }
  const asPath = path.resolve(process.cwd(), ref);
  const uidAtPath = readProjectUid(asPath);
  if (uidAtPath !== null) return { root: asPath, uid: uidAtPath };

  const root = (() => {
    try {
      return openWorkspaceRegistered(process.cwd());
    } catch {
      return null;
    }
  })();
  if (root !== null) {
    const all = discoverProjects(root, { all: true });
    const byRel = all.filter((p) => p.relPath === ref);
    const byName = all.filter((p) => path.basename(p.root) === ref);
    const byUid = all.filter((p) => p.uid === ref);
    for (const matches of [byRel, byUid, byName]) {
      if (matches.length === 1) {
        const m = matches[0] as ProjectInfo;
        return { root: m.root, uid: m.uid };
      }
      if (matches.length > 1) {
        throw new ConfigError(
          `project ref "${ref}" is ambiguous: ${matches.map((m) => m.relPath).join(", ")}`,
        );
      }
    }
  }
  throw new NotFoundError(`no project matching "${ref}"`);
}

/**
 * Best-effort extra mint-probe dirs: when invoked from a git worktree, the
 * next-ID probe must also see the canonical checkout's record dir (PRD §4.4).
 * Resolution failure is non-fatal here — task/decision writes are
 * worktree-local by design; the duplicate-ID doctor check is the backstop.
 */
function canonicalProbeDirs(projectRoot: string, store: MachineStore, sub: string): string[] {
  if (!isGitWorktree(projectRoot)) return [];
  try {
    const resolved = resolveCanonicalProject(projectRoot, store);
    if (resolved.canonicalRoot !== projectRoot) {
      return [path.join(resolved.canonicalRoot, "_project", sub)];
    }
  } catch (err) {
    if (err instanceof ResolveError) {
      process.stderr.write(
        `warn: minting from a worktree without a resolvable canonical checkout — ` +
          `ID probe is local-only (doctor's duplicate-ID check is the backstop)\n`,
      );
    } else {
      throw err;
    }
  }
  return [];
}

function printDoctorReport(rep: DoctorReport, json: boolean): never {
  if (json) {
    printJson(rep);
  } else if (rep.issues.length === 0) {
    print("doctor: no findings");
  } else {
    for (const issue of rep.issues) {
      const where = [issue.project, issue.file].filter((x) => x !== null).join(" ");
      print(`${issue.severity}: ${where !== "" ? where + ": " : ""}${issue.message}`);
    }
    print(`doctor: ${rep.errors} error(s), ${rep.warnings} warning(s)${rep.infos > 0 ? `, ${rep.infos} info` : ""}`);
  }
  process.exit(rep.errors > 0 ? 1 : 0);
}

function taskLine(t: tasks.TaskListEntry): string {
  const flags: string[] = [];
  if (t.hidden) flags.push(`hidden until ${t.hiddenUntil}`);
  if (t.recur !== null) flags.push(`recur ${t.recur}`);
  if (t.subtaskCount > 0) flags.push(`${t.subtaskCount} subtasks: ${t.subtaskDoneCount} done`);
  const indent = "  ".repeat(Math.max(0, t.parts.length - 1));
  const quadrant = t.quadrant !== null ? ` [${t.quadrant}]` : "";
  return `${indent}${t.id}  ${t.status}${quadrant}  ${t.title}${flags.length > 0 ? `  (${flags.join("; ")})` : ""}`;
}

// ---------------------------------------------------------------------------
// Command groups

function cmdHome(argv: string[]): void {
  const sub = argv[0];
  const rest = argv.slice(1);
  switch (sub) {
    case "init": {
      const { values } = parse(rest, FLAG_JSON);
      const result = initWorkspace(process.cwd());
      const store = getStore();
      // Seed the machine store so this checkout is canonically resolvable
      // from worktrees immediately (PRD §6.4), and heartbeat the synced
      // per-machine registry (§7.3). Both are idempotent.
      const registered = registerWorkspaceIfCanonical(store, result.root);
      updateMachineRegistry(result.root, machineId(store));
      if (values["json"] === true) printJson({ ...result, registered });
      else
        print(
          result.created
            ? `initialized workspace at ${result.root} (workspace_id ${result.workspaceId})`
            : `workspace already initialized at ${result.root} (workspace_id ${result.workspaceId})`,
        );
      return;
    }
    case "mint-suffix": {
      // The §4.4 machine-suffix knob: an off-canonical machine (e.g. the
      // Mini) declares its suffix once; every ID minted on it becomes
      // task-<n>-<suffix> — the designed defense against cross-machine
      // duplicate IDs under iCloud latency. Machine-local state, never synced.
      const { values, positionals } = parse(rest, {
        ...FLAG_JSON,
        clear: { type: "boolean", default: false },
      });
      const store = getStore();
      if (values["clear"] === true) {
        writeMintSuffix(store, null);
        if (values["json"] === true) printJson({ mintSuffix: null });
        else print("mint suffix cleared — this machine mints plain sequential IDs");
        return;
      }
      const suffix = positionals[0];
      if (suffix === undefined) {
        const current = readMintSuffix(store);
        if (values["json"] === true) printJson({ mintSuffix: current });
        else print(current === null ? "no mint suffix set (plain sequential IDs)" : `mint suffix: ${current}`);
        return;
      }
      writeMintSuffix(store, suffix);
      if (values["json"] === true) printJson({ mintSuffix: suffix });
      else print(`mint suffix set: IDs minted on this machine become task-<n>-${suffix}`);
      return;
    }
    case "runner-node": {
      // decision-1 (PRD §7.4): which node binary plists invoke the runner
      // with on THIS machine — a machine-local fact (P14), like mint-suffix.
      // v1 posture: a dedicated copy of the official nodejs.org pkg build
      // (Developer-ID-signed → stable TCC grant identity) at a fixed path
      // outside the tree, granted once per machine at bootstrap.
      const { values, positionals } = parse(rest, {
        ...FLAG_JSON,
        clear: { type: "boolean", default: false },
      });
      const store = getStore();
      if (values["clear"] === true) {
        writeRunnerNode(store, null);
        if (values["json"] === true) printJson({ runnerNode: null });
        else print("runner-node cleared — plists fall back to the node that runs apply (with a warning)");
        return;
      }
      const target = positionals[0];
      if (target === undefined) {
        const current = readRunnerNode(store);
        if (values["json"] === true) printJson({ runnerNode: current });
        else
          print(
            current === null
              ? "no runner-node configured (plists fall back to the node that runs apply)"
              : `runner-node: ${current}`,
          );
        return;
      }
      writeRunnerNode(store, target); // validates: exists, regular file, executable
      const resolved = readRunnerNode(store);
      if (values["json"] === true) printJson({ runnerNode: resolved });
      else print(`runner-node set: ${resolved} (re-run \`projects automation apply --all\` to regenerate plists)`);
      return;
    }
    case "machine-id": {
      // The machine's identity: minted lazily (hostname + 2 hex bytes), or
      // set explicitly here. It is what automation manifests' machines =
      // [...] declarations are matched against, and it keys the synced
      // registry file (.openworkspace/machines/<id>.toml) — setMachineId
      // renames that file in every known workspace.
      const { values, positionals } = parse(rest, FLAG_JSON);
      const store = getStore();
      const name = positionals[0];
      if (name === undefined) {
        const current = machineId(store); // mints on first read
        if (values["json"] === true) printJson({ machineId: current });
        else print(`machine-id: ${current}`);
        return;
      }
      const result = setMachineId(store, name);
      if (values["json"] === true) printJson(result);
      else
        print(
          result.old === result.new
            ? `machine-id unchanged: ${result.new}`
            : `machine-id set: ${result.old} → ${result.new} (manifests' machines = [...] now match "${result.new}")`,
        );
      return;
    }
    case "list": {
      const { values } = parse(rest, {
        ...FLAG_JSON,
        all: { type: "boolean", default: false },
        owner: { type: "string" },
      });
      const ws = openWorkspaceRegistered(process.cwd());
      let projects = discoverProjects(ws, { all: values["all"] === true });
      if (values["owner"] !== undefined) {
        // Filter to the subproject children declared by the owner's [[owns]].
        const owner = resolveProject(values["owner"] as string);
        const result = readOwns(owner.root);
        const childRoots = new Set(
          result.owns
            .map((e) => resolveOwnRef(ws, e))
            .filter((r) => r.localPath !== null)
            .map((r) => path.resolve(r.localPath as string)),
        );
        projects = projects.filter((p) => childRoots.has(path.resolve(p.root)));
      }
      if (values["json"] === true) printJson(projects);
      else if (projects.length === 0) print("no projects found");
      else
        for (const p of projects) {
          // decision-2: report the EFFECTIVE (metadata-as-truth) lifecycle; flag
          // when location disagrees (reconcile would heal it).
          const drift =
            locationOfDeclared(p.effectiveLifecycle) !== p.lifecycle
              ? `drift: at ${p.lifecycle}, reconcile`
              : null;
          const tags = [p.effectiveLifecycle, p.nestedUnder !== null ? "nested" : null, drift]
            .filter((x) => x !== null)
            .join(", ");
          print(`${p.relPath}  (${tags})  ${p.uid}`);
        }
      return;
    }
    case "scan": {
      const { values } = parse(rest, FLAG_JSON);
      const ws = openWorkspaceRegistered(process.cwd());
      const scan = scanWorkspace(ws);
      if (values["json"] === true) {
        printJson(scan);
      } else {
        print(`workspace ${scan.workspace.name} (${scan.workspace.root})`);
        print(
          `projects: ${scan.counts.active} active, ${scan.counts.dormant} dormant, ${scan.counts.archived} archived`,
        );
        print(
          `attention: ${scan.attention.waiting} waiting, ${scan.attention.review} in review, ` +
            `${scan.attention.unhiddenToday} unhidden today, ${scan.attention.doctorErrors} doctor finding(s)`,
        );
      }
      return;
    }
    case "doctor": {
      const { values } = parse(rest, FLAG_JSON);
      const ws = openWorkspaceRegistered(process.cwd());
      // The machine store rides along for the decision-1 runner-posture
      // checks (runner-node-unset / provenance / claude-grant-staleness);
      // OPENWORKSPACE_STORE_DIR keeps tests off the real ~/Library.
      printDoctorReport(doctorWorkspace(ws, { store: getStore() }), values["json"] === true);
      return;
    }
    default:
      throw new ConfigError(
        `unknown home subcommand: ${sub ?? "(none)"} (expected init|list|scan|doctor|mint-suffix|runner-node|machine-id)`,
      );
  }
}

/** Seed resolution state for a fresh project: register its workspace, warm the UID cache. */
function seedProjectResolution(projectRoot: string, uid: string): void {
  const store = getStore();
  if (!isGitWorktree(projectRoot)) writeUidCacheEntry(store, uid, projectRoot);
  const wsRoot = findWorkspaceRoot(projectRoot);
  if (wsRoot !== null) registerWorkspaceIfCanonical(store, wsRoot);
}

/**
 * Guard rails for `projects init` WITHOUT a path: defaulting to the cwd is an
 * inference, so it gets checks the explicit form does not — the cwd must sit
 * inside a workspace, and must be neither the workspace root itself nor a
 * configured shelf root (doctor flags shelf-as-project as an error; refusing
 * up front is cheaper). `initProject`'s own already-a-project refusal still
 * applies on top. Explicit-path behavior is unchanged (projects outside any
 * workspace remain legal — `projects show` reports their lifecycle as null).
 */
function guardCwdInitTarget(dir: string): void {
  const wsRoot = findWorkspaceRoot(dir);
  if (wsRoot === null) {
    throw new ConfigError(
      `refusing to initialize ${dir}: not inside a workspace (no ${MARKER_DIR}/ marker walking up). ` +
        `Pass a path explicitly: projects init <path>`,
    );
  }
  if (dir === wsRoot) {
    throw new ConfigError(
      `refusing to initialize the workspace root as a project: ${wsRoot} — ` +
        `use \`projects new "Name"\` to create a project inside it`,
    );
  }
  const ws = openWorkspace(dir);
  const shelves = [ws.config.paths.dormant, ws.config.paths.archives].map((rel) =>
    path.resolve(ws.root, rel),
  );
  if (shelves.includes(dir)) {
    throw new ConfigError(`refusing to initialize a shelf root as a project: ${dir}`);
  }
}

function cmdInit(argv: string[]): void {
  const { values, positionals } = parse(argv, FLAG_JSON);
  const target = positionals[0];
  let dir: string;
  if (target !== undefined) {
    dir = path.resolve(process.cwd(), target);
  } else {
    dir = process.cwd();
    guardCwdInitTarget(dir);
  }
  const result = initProject(dir);
  seedProjectResolution(result.projectRoot, result.uid);
  if (values["json"] === true) printJson(result);
  else print(`initialized project at ${result.projectRoot} (uid ${result.uid})`);
}

function cmdNew(argv: string[]): void {
  const { values, positionals } = parse(argv, {
    ...FLAG_JSON,
    parent: { type: "string" },
    kind: { type: "string" },
  });
  const name = positionals[0];
  if (name === undefined || name.trim() === "") throw new ConfigError('usage: projects new "Name"');
  const result = initProject(path.resolve(process.cwd(), name));

  // --parent: write the [[owns]] edge ON THE PARENT (the edge is parent-
  // canonical). The child's ref is its ws-relative path from ws.root, so it
  // round-trips through resolveOwnRef.
  let parentRoot: string | null = null;
  if (values["parent"] !== undefined) {
    const kind = parseOwnKind(values["kind"]);
    const parent = resolveProject(values["parent"] as string);
    parentRoot = parent.root;
    const ws = findWorkspaceRoot(result.projectRoot);
    const childRef =
      ws !== null ? path.relative(ws, result.projectRoot) : result.projectRoot;
    const owns = readOwns(parent.root).owns;
    owns.push({ ref: childRef, kind, name: null, lifecycle: null });
    writeOwns(parent.root, owns);
  }

  seedProjectResolution(result.projectRoot, result.uid);
  if (values["json"] === true) printJson({ ...result, parent: parentRoot });
  else print(`created project ${name} at ${result.projectRoot} (uid ${result.uid})`);
}

function projectView(root: string, uid: string): Record<string, unknown> {
  const ws = (() => {
    try {
      return openWorkspace(root);
    } catch {
      return null;
    }
  })();
  const declared = readDeclaredLifecycle(root);
  return {
    root,
    uid,
    relPath: ws !== null ? path.relative(ws.root, root) : null,
    // decision-2: the effective (metadata-as-truth) lifecycle is the headline;
    // `locatedLifecycle` exposes the derived view so drift is visible.
    lifecycle: ws !== null ? effectiveLifecycle(ws, root) : declared.lifecycle,
    locatedLifecycle: ws !== null ? lifecycleOf(ws, root) : null,
    declaredLifecycle: declared.lifecycle,
    inWorktree: isGitWorktree(root),
  };
}

function cmdShow(argv: string[]): void {
  const { values } = parse(argv, { ...FLAG_JSON, ...FLAG_PROJECT });
  const { root, uid } = resolveProject(values["project"] as string | undefined);
  const view = projectView(root, uid);
  if (values["json"] === true) printJson(view);
  else {
    print(`${path.basename(root)}`);
    print(`  root:      ${root}`);
    print(`  uid:       ${uid}`);
    print(`  lifecycle: ${String(view["lifecycle"] ?? "unknown (outside any workspace)")}`);
  }
}

function cmdDoctor(argv: string[]): void {
  const { values } = parse(argv, { ...FLAG_JSON, ...FLAG_PROJECT });
  const { root } = resolveProject(values["project"] as string | undefined);
  printDoctorReport(doctorProjectReport(root), values["json"] === true);
}

function moveProjectDir(from: string, to: string, uid: string, store: MachineStore): void {
  if (fs.existsSync(to)) throw new ConfigError(`target already exists: ${to}`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
  writeUidCacheEntry(store, uid, to); // keep canonical resolution warm
}

function cmdRename(argv: string[]): void {
  const { values, positionals } = parse(argv, { ...FLAG_JSON, ...FLAG_PROJECT });
  const newName = positionals[0];
  if (newName === undefined || newName.includes(path.sep)) {
    throw new ConfigError("usage: projects rename <new-name> [--project <ref>] (a name, not a path — use move)");
  }
  const { root, uid } = resolveProject(values["project"] as string | undefined);
  const target = path.join(path.dirname(root), newName);
  moveProjectDir(root, target, uid, getStore());
  if (values["json"] === true) printJson({ root: target, uid });
  else print(`renamed to ${target} (uid ${uid} unchanged)`);
}

function cmdMove(argv: string[]): void {
  const { values, positionals } = parse(argv, { ...FLAG_JSON, ...FLAG_PROJECT });
  const dest = positionals[0];
  if (dest === undefined) throw new ConfigError("usage: projects move <dest-dir> [--project <ref>]");
  const { root, uid } = resolveProject(values["project"] as string | undefined);
  const target = path.join(path.resolve(process.cwd(), dest), path.basename(root));
  moveProjectDir(root, target, uid, getStore());
  if (values["json"] === true) printJson({ root: target, uid });
  else print(`moved to ${target} (uid ${uid} unchanged)`);
}

function cmdLifecycle(argv: string[]): void {
  const { values, positionals } = parse(argv, {
    ...FLAG_JSON,
    to: { type: "string" },
  });
  const ref = positionals[0];
  const to = values["to"] as string | undefined;
  if (ref === undefined || to === undefined || !["active", "dormant", "archived"].includes(to)) {
    throw new ConfigError("usage: projects lifecycle <ref> --to <active|dormant|archived>");
  }
  const declared = to as DeclaredLifecycle;
  const { root, uid } = resolveProject(ref);
  const ws = openWorkspaceRegistered(root);
  const store = getStore();
  const current = effectiveLifecycle(ws, root);
  if (current === declared) {
    print(`already ${declared}: ${root}`);
    return;
  }
  // decision-2: metadata-primary. State lives in CONTENT; location is a
  // maintained VIEW. Order so an interrupted run is recoverable: stamp the
  // declared truth + a local intent FIRST (the tombstone-honest record of "the
  // human asked for this"), then move the folder to match. If we crash after
  // the stamp but before the move, a later reconcile completes the move; if we
  // crash before the stamp, nothing changed.
  const now = new Date().toISOString();
  writeDeclaredLifecycle(root, declared, now);
  appendLifecycleIntent(store, { uid, to: declared, at: now, machine: machineId(store) });

  const targetLifecycle = locationOfDeclared(declared);
  const located = lifecycleOf(ws, root);
  let finalRoot = root;
  if (located !== targetLifecycle) {
    const target = path.join(destDirFor(ws, targetLifecycle), path.basename(root));
    moveProjectDir(root, target, uid, store);
    finalRoot = target;
  } else {
    // location already matches the target lifecycle: just keep the UID cache
    // warm at the unchanged path.
    writeUidCacheEntry(store, uid, root);
  }
  if (values["json"] === true) printJson({ root: finalRoot, uid, lifecycle: declared });
  else print(`${path.basename(finalRoot)}: ${current} → ${declared} (${finalRoot})`);
}

/** Destination dir for a (location-comparable) lifecycle — shared with reconcile. */
function destDirFor(ws: Workspace, lifecycle: "active" | "dormant" | "archived"): string {
  if (lifecycle === "active") return ws.root;
  return path.resolve(ws.root, lifecycle === "dormant" ? ws.config.paths.dormant : ws.config.paths.archives);
}

// --- reconcile (decision-2: heal location ⟷ metadata drift) ---

function cmdReconcile(argv: string[]): void {
  const { values, positionals } = parse(argv, {
    ...FLAG_JSON,
    all: { type: "boolean", default: false },
    apply: { type: "boolean", default: false },
    auto: { type: "boolean", default: false },
    revert: { type: "string" },
    "adopt-location": { type: "string" },
  });
  const ws = openWorkspaceRegistered(process.cwd());
  const store = getStore();

  // Single-project human confirmations short-circuit the plan loop: the human
  // has already supplied the tombstone-honest tiebreak the auto path lacks.
  const revertRef = values["revert"] as string | undefined;
  const adoptRef = values["adopt-location"] as string | undefined;
  if (revertRef !== undefined || adoptRef !== undefined) {
    if (revertRef !== undefined && adoptRef !== undefined) {
      throw new ConfigError("pass either --revert or --adopt-location, not both");
    }
    const ref = (revertRef ?? adoptRef) as string;
    const { root, uid } = resolveProject(ref);
    if (revertRef !== undefined) {
      const declared = readDeclaredLifecycle(root).lifecycle ?? lifecycleOf(ws, root);
      const result = revertLocation(ws, store, root, uid, declared);
      if (values["json"] === true) printJson(result);
      else
        print(
          result.movedTo === null
            ? `${ref}: already aligned with metadata (${result.to})`
            : `reverted ${ref}: location → ${result.to} (${result.movedTo})`,
        );
    } else {
      const result = adoptLocation(ws, store, root, uid);
      if (values["json"] === true) printJson(result);
      else print(`adopted location for ${ref}: declared lifecycle = ${result.to}`);
    }
    return;
  }

  const plan = reconcilePlan(ws, store);
  const apply = values["apply"] === true;

  if (!apply) {
    if (values["json"] === true) {
      printJson({
        mode: "dry-run",
        workspaceRoot: plan.workspaceRoot,
        actions: plan.actions.map(({ kind, project, from, to, note }) => ({ kind, project, from, to, note })),
        ambiguous: plan.ambiguous,
        errors: plan.errors,
      });
    } else {
      for (const line of renderReconcilePlan(plan, { mode: "dry-run" })) print(line);
    }
    process.exit(plan.errors.length > 0 ? 2 : 0);
  }

  const result = applyReconcile(plan, store, { auto: values["auto"] === true });
  if (values["json"] === true) {
    printJson({
      mode: values["auto"] === true ? "auto" : "apply",
      workspaceRoot: plan.workspaceRoot,
      applied: result.applied.map(({ kind, project, from, to, note }) => ({ kind, project, from, to, note })),
      skipped: result.skipped.map(({ kind, project, from, to, note }) => ({ kind, project, from, to, note })),
      ambiguous: plan.ambiguous,
      errors: plan.errors,
    });
  } else {
    for (const line of renderReconcilePlan(plan, { mode: values["auto"] === true ? "auto" : "apply" })) print(line);
    if (plan.errors.length > 0) {
      // Whole-plan refusal (applyReconcile mutates nothing when errors exist):
      // a half-applied plan is the failure we are guarding against.
      print(`refusing to apply: ${plan.errors.length} plan error(s) — NOTHING was applied`);
    } else {
      print(`applied: ${result.applied.length} action(s), ${result.skipped.length} skipped (not auto-safe)`);
    }
  }
  process.exit(plan.errors.length > 0 ? 2 : 0);
}

// --- tasks ---

function cmdTask(argv: string[]): void {
  const sub = argv[0];
  const rest = argv.slice(1);
  const common: Spec = { ...FLAG_JSON, ...FLAG_PROJECT };

  switch (sub) {
    case "create": {
      const { values, positionals } = parse(rest, {
        ...common,
        parent: { type: "string" },
        quadrant: { type: "string" },
        label: { type: "string", multiple: true },
        "hidden-until": { type: "string" },
        recur: { type: "string" },
      });
      const title = positionals[0];
      if (title === undefined) throw new ConfigError('usage: projects task create "title" [flags]');
      const { root } = resolveProject(values["project"] as string | undefined);
      const store = getStore();
      const task = tasks.createTask(root, store, {
        title,
        parent: values["parent"] as string | undefined,
        quadrant: values["quadrant"] as string | undefined,
        labels: values["label"] as string[] | undefined,
        hiddenUntil: values["hidden-until"] as string | undefined,
        recur: values["recur"] as string | undefined,
        machineSuffix: readMintSuffix(store) ?? undefined, // §4.4 off-canonical minting
        extraTreePaths: canonicalProbeDirs(root, store, "tasks"),
      });
      if (values["json"] === true) printJson(task);
      else print(`${task.id} created: ${task.path}`);
      return;
    }
    case "list": {
      const { values } = parse(rest, {
        ...common,
        subtasks: { type: "boolean", default: false },
        hidden: { type: "boolean", default: false },
        all: { type: "boolean", default: false },
      });
      const { root } = resolveProject(values["project"] as string | undefined);
      const entries = tasks.listTasks(root, {
        subtasks: values["subtasks"] === true,
        hidden: values["hidden"] === true,
        all: values["all"] === true,
      });
      if (values["json"] === true) printJson(entries);
      else if (entries.length === 0) print("no tasks");
      else for (const t of entries) print(taskLine(t));
      return;
    }
    case "show": {
      const { values, positionals } = parse(rest, common);
      const id = positionals[0];
      if (id === undefined) throw new ConfigError("usage: projects task show <id>");
      const { root } = resolveProject(values["project"] as string | undefined);
      const result = tasks.showTask(root, id);
      if (values["json"] === true) printJson(result);
      else {
        const t = result.task;
        print(`${t.id}  ${t.status}${t.quadrant !== null ? ` [${t.quadrant}]` : ""}  ${t.title}`);
        if (t.hiddenUntil !== null) print(`hidden_until: ${t.hiddenUntil}`);
        if (t.recur !== null) print(`recur: ${t.recur}`);
        print(`file: ${t.path}`);
        if (result.subtree.length > 0) {
          print(`subtasks:`);
          for (const s of result.subtree) print(`  ${s.id}  ${s.status}  ${s.title}`);
        }
        print("");
        print(t.body.trimEnd());
      }
      return;
    }
    case "edit": {
      const { values, positionals } = parse(rest, {
        ...common,
        clear: { type: "boolean", default: false },
      });
      const [id, field, rawValue] = positionals;
      if (id === undefined || field === undefined || (rawValue === undefined && values["clear"] !== true)) {
        throw new ConfigError("usage: projects task edit <id> <field> <value> (or --clear)");
      }
      const { root } = resolveProject(values["project"] as string | undefined);
      const value =
        values["clear"] === true
          ? null
          : field === "labels"
            ? (rawValue as string).split(",").map((s) => s.trim()).filter((s) => s !== "")
            : rawValue;
      const task = tasks.editField(root, id, field, value);
      if (values["json"] === true) printJson(task);
      else print(`${task.id} updated (${field})`);
      return;
    }
    case "note": {
      const { values, positionals } = parse(rest, { ...common, as: { type: "string" } });
      const [id, text] = positionals;
      if (id === undefined || text === undefined) throw new ConfigError('usage: projects task note <id> "text"');
      const { root } = resolveProject(values["project"] as string | undefined);
      const task = tasks.addNote(root, id, text, { actor: values["as"] as string | undefined });
      if (values["json"] === true) printJson(task);
      else print(`${task.id}: note logged`);
      return;
    }
    case "status": {
      const { values, positionals } = parse(rest, { ...common, force: { type: "boolean", default: false } });
      const [id, status] = positionals;
      if (id === undefined || status === undefined) {
        throw new ConfigError("usage: projects task status <id> <todo|doing|waiting|review|done> [--force]");
      }
      const { root } = resolveProject(values["project"] as string | undefined);
      const task = tasks.setStatus(root, id, status as tasks.TaskStatus, { force: values["force"] === true });
      if (values["json"] === true) printJson(task);
      else print(`${task.id}: ${task.status}`);
      return;
    }
    case "done": {
      const { values, positionals } = parse(rest, { ...common, force: { type: "boolean", default: false } });
      const id = positionals[0];
      if (id === undefined) throw new ConfigError("usage: projects task done <id> [--force]");
      const { root } = resolveProject(values["project"] as string | undefined);
      const current = tasks.getTask(root, id);
      if (current.recur !== null) {
        const result = tasks.completeOccurrence(root, id);
        if (values["json"] === true) printJson(result);
        else print(`${result.task.id}: occurrence completed; next ${result.next}`);
      } else {
        const task = tasks.setStatus(root, id, "done", { force: values["force"] === true });
        if (values["json"] === true) printJson(task);
        else print(`${task.id}: done`);
      }
      return;
    }
    case "hide": {
      const { values, positionals } = parse(rest, { ...common, until: { type: "string" } });
      const id = positionals[0];
      const until = values["until"] as string | undefined;
      if (id === undefined || until === undefined) {
        throw new ConfigError("usage: projects task hide <id> --until YYYY-MM-DD");
      }
      const { root } = resolveProject(values["project"] as string | undefined);
      const task = tasks.hideTask(root, id, until);
      if (values["json"] === true) printJson(task);
      else print(`${task.id}: hidden until ${until}`);
      return;
    }
    case "recur": {
      const { values, positionals } = parse(rest, common);
      const [id, interval] = positionals;
      if (id === undefined || interval === undefined) {
        throw new ConfigError("usage: projects task recur <id> <weekly|monthly|yearly|every-N-days|off>");
      }
      const { root } = resolveProject(values["project"] as string | undefined);
      const task = tasks.setRecur(root, id, interval);
      if (values["json"] === true) printJson(task);
      else print(`${task.id}: recur ${interval === "off" ? "retired" : interval}`);
      return;
    }
    case "archive": {
      const { values, positionals } = parse(rest, common);
      const id = positionals[0];
      if (id === undefined) throw new ConfigError("usage: projects task archive <id>");
      const { root } = resolveProject(values["project"] as string | undefined);
      const moved = tasks.archiveTask(root, id);
      if (values["json"] === true) printJson({ moved });
      else print(`archived ${moved.length} record(s) into tasks/archive/`);
      return;
    }
    default:
      throw new ConfigError(
        `unknown task subcommand: ${sub ?? "(none)"} (expected create|list|show|edit|note|status|done|hide|recur|archive)`,
      );
  }
}

// --- decisions ---

function cmdDecision(argv: string[]): void {
  const sub = argv[0];
  const rest = argv.slice(1);
  const common: Spec = { ...FLAG_JSON, ...FLAG_PROJECT };

  switch (sub) {
    case "new": {
      const { values, positionals } = parse(rest, { ...common, expected: { type: "string" }, date: { type: "string" } });
      const title = positionals[0];
      if (title === undefined) throw new ConfigError('usage: projects decision new "title"');
      const { root } = resolveProject(values["project"] as string | undefined);
      const store = getStore();
      const d = decisions.newDecision(root, store, {
        title,
        expected: values["expected"] as string | undefined,
        date: values["date"] as string | undefined,
        machineSuffix: readMintSuffix(store) ?? undefined, // §4.4 off-canonical minting
        extraTreePaths: canonicalProbeDirs(root, store, "decisions"),
      });
      if (values["json"] === true) printJson(d);
      else print(`${d.id} created (draft): ${d.filePath}`);
      return;
    }
    case "accept": {
      const { values, positionals } = parse(rest, common);
      const id = positionals[0];
      if (id === undefined) throw new ConfigError("usage: projects decision accept <id>");
      const { root } = resolveProject(values["project"] as string | undefined);
      const d = decisions.acceptDecision(root, id);
      if (values["json"] === true) printJson(d);
      else print(`${d.id}: accepted (now immutable; changing course = a new record)`);
      return;
    }
    case "list": {
      const { values } = parse(rest, { ...common, status: { type: "string" } });
      const { root } = resolveProject(values["project"] as string | undefined);
      const list = decisions.listDecisions(root, {
        status: values["status"] as decisions.DecisionStatus | undefined,
      });
      if (values["json"] === true) printJson(list);
      else if (list.length === 0) print("no decisions");
      else
        for (const d of list) {
          const sup = d.supersededBy !== null ? ` (superseded by ${d.supersededBy})` : "";
          print(`${d.id}  ${d.status}${sup}  ${d.date}  ${d.title}`);
        }
      return;
    }
    case "show": {
      const { values, positionals } = parse(rest, common);
      const id = positionals[0];
      if (id === undefined) throw new ConfigError("usage: projects decision show <id>");
      const { root } = resolveProject(values["project"] as string | undefined);
      const d = decisions.showDecision(root, id);
      if (values["json"] === true) printJson(d);
      else {
        print(`${d.id}  ${d.status}  ${d.date}  ${d.title}`);
        if (d.supersededBy !== null) print(`superseded_by: ${d.supersededBy}`);
        print(`file: ${d.filePath}`);
        print("");
        print(d.body.trimEnd());
      }
      return;
    }
    case "supersede": {
      const { values, positionals } = parse(rest, { ...common, by: { type: "string" } });
      const id = positionals[0];
      const by = values["by"] as string | undefined;
      if (id === undefined || by === undefined) {
        throw new ConfigError("usage: projects decision supersede <id> --by <id>");
      }
      const { root } = resolveProject(values["project"] as string | undefined);
      const d = decisions.supersedeDecision(root, id, by);
      if (values["json"] === true) printJson(d);
      else print(`${d.id}: superseded by ${d.supersededBy}`);
      return;
    }
    default:
      throw new ConfigError(
        `unknown decision subcommand: ${sub ?? "(none)"} (expected new|accept|list|show|supersede)`,
      );
  }
}

// --- link (project graph: typed [[owns]] edges, canonical on the parent) ---

const OWN_KIND_VALUES: ReadonlyArray<OwnKind> = ["subproject", "code", "remote"];

function parseOwnKind(value: unknown): OwnKind {
  if (value === undefined) return "subproject";
  if (typeof value !== "string" || !(OWN_KIND_VALUES as readonly string[]).includes(value)) {
    throw new ConfigError(`bad --kind "${String(value)}" (expected subproject|code|remote)`);
  }
  return value as OwnKind;
}

function parseEdgeLifecycle(value: unknown): DeclaredLifecycle | null {
  if (value === undefined) return null;
  if (value !== "active" && value !== "dormant" && value !== "archived") {
    throw new ConfigError(`bad --lifecycle "${String(value)}" (expected active|dormant|archived)`);
  }
  return value;
}

/** Render one resolved owns edge for `link list` / errors. */
function resolvedOwnLine(r: ResolvedOwn): string {
  const name = r.edge.name !== null ? ` "${r.edge.name}"` : "";
  const lc = r.lifecycle !== null ? ` [${r.lifecycle}]` : "";
  return `${r.edge.ref} (${r.edge.kind})${name} -> ${r.status}${lc}`;
}

function cmdLink(argv: string[]): void {
  const sub = argv[0];
  const rest = argv.slice(1);
  const common: Spec = { ...FLAG_JSON, ...FLAG_PROJECT };

  switch (sub) {
    case "add": {
      const { values, positionals } = parse(rest, {
        ...common,
        kind: { type: "string" },
        name: { type: "string" },
        lifecycle: { type: "string" },
      });
      const childRef = positionals[0];
      if (childRef === undefined || childRef.trim() === "") {
        throw new ConfigError("usage: projects link add <child-ref> [--project <owner>]");
      }
      const kind = parseOwnKind(values["kind"]);
      const lifecycle = parseEdgeLifecycle(values["lifecycle"]);
      const name = (values["name"] as string | undefined) ?? null;

      const owner = resolveProject(values["project"] as string | undefined);
      const result = readOwns(owner.root);
      if (result.owns.some((o) => o.ref === childRef)) {
        throw new ConflictError(`owns edge already exists: ${childRef} (owner ${owner.root})`);
      }

      const newEdge: OwnEdge = { ref: childRef, kind, name, lifecycle };

      // Self-link guard: resolve the child and reject if it IS the owner.
      const ws = (() => {
        try {
          return openWorkspaceRegistered(process.cwd());
        } catch {
          return null;
        }
      })();
      if (ws !== null) {
        const resolved = resolveOwnRef(ws, newEdge);
        if (resolved.uid !== null && resolved.uid === owner.uid) {
          throw new ConfigError(`refusing self-link: ${childRef} resolves to the owner itself`);
        }
      }

      // Cycle guard: would this edge create an ownership cycle? Build the graph
      // as it WOULD be (with the new edge appended) and detect a cycle.
      if (ws !== null) {
        const graph = buildOwnershipGraph(ws);
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
        // Add the prospective edge.
        const ownerRel = path.relative(ws.root, owner.root);
        const resolved = resolveOwnRef(ws, newEdge);
        if (resolved.uid !== null && resolved.localPath !== null) {
          ensure(ownerRel).push(path.relative(ws.root, resolved.localPath));
        }
        const cycle = detectCycle(adj);
        if (cycle !== null) {
          throw new ConfigError(`refusing edge — would create an ownership cycle: ${cycle.join(" -> ")}`);
        }
      }

      const owns = [...result.owns, newEdge];
      writeOwns(owner.root, owns);
      if (values["json"] === true) printJson({ owner: owner.root, edge: newEdge });
      else print(`linked: ${owner.root} owns ${childRef} (${kind})`);
      return;
    }
    case "rm": {
      const { values, positionals } = parse(rest, common);
      const childRef = positionals[0];
      if (childRef === undefined) throw new ConfigError("usage: projects link rm <child-ref> [--project <owner>]");
      const owner = resolveProject(values["project"] as string | undefined);
      const result = readOwns(owner.root);
      if (!result.owns.some((o) => o.ref === childRef)) {
        throw new NotFoundError(`no owns edge with ref "${childRef}" on ${owner.root}`);
      }
      const owns = result.owns.filter((o) => o.ref !== childRef);
      writeOwns(owner.root, owns);
      if (values["json"] === true) printJson({ owner: owner.root, removed: childRef });
      else print(`unlinked: ${owner.root} no longer owns ${childRef}`);
      return;
    }
    case "list": {
      const { values } = parse(rest, common);
      const owner = resolveProject(values["project"] as string | undefined);
      const result = readOwns(owner.root);
      const ws = (() => {
        try {
          return openWorkspaceRegistered(process.cwd());
        } catch {
          return null;
        }
      })();
      const resolved =
        ws !== null ? result.owns.map((e) => resolveOwnRef(ws, e)) : [];
      if (values["json"] === true) {
        printJson(ws !== null ? resolved : result.owns);
      } else if (result.owns.length === 0) {
        print("no owns edges");
      } else if (ws !== null) {
        for (const r of resolved) print(resolvedOwnLine(r));
      } else {
        for (const e of result.owns) print(`${e.ref} (${e.kind})`);
      }
      return;
    }
    default:
      throw new ConfigError(`unknown link subcommand: ${sub ?? "(none)"} (expected add|rm|list)`);
  }
}

// --- tree (project graph: render the ownership graph) ---

function cmdTree(argv: string[]): void {
  const { values } = parse(argv, { ...FLAG_JSON, ...FLAG_PROJECT });
  const ws = openWorkspaceRegistered(process.cwd());
  const graph = buildOwnershipGraph(ws);

  // Adjacency: owner relPath → its resolved edges. Also track which relPaths
  // are someone's child (in-ws), to compute the roots.
  const byRelPath = new Map<string, ResolvedOwn[]>();
  const childRelPaths = new Set<string>();
  for (const node of graph.nodes) {
    byRelPath.set(node.owner.relPath, node.edges);
    for (const e of node.edges) {
      if (e.uid !== null && e.localPath !== null) {
        childRelPaths.add(path.relative(ws.root, e.localPath));
      }
    }
  }
  const lifecycleByRelPath = new Map<string, DeclaredLifecycle>();
  for (const node of graph.nodes) lifecycleByRelPath.set(node.owner.relPath, node.owner.effectiveLifecycle);

  // Determine the subtree root(s).
  let rootRelPaths: string[];
  if (values["project"] !== undefined) {
    const proj = resolveProject(values["project"] as string);
    rootRelPaths = [path.relative(ws.root, proj.root)];
  } else {
    rootRelPaths = graph.nodes
      .filter((n) => !childRelPaths.has(n.owner.relPath))
      .map((n) => n.owner.relPath);
  }

  interface TreeNode {
    label: string;
    relPath: string | null; // in-ws project relPath, or null for code/remote leaves
    children: TreeNode[];
    cycle: boolean;
  }

  const buildNode = (relPath: string, visiting: Set<string>): TreeNode => {
    const lc = lifecycleByRelPath.get(relPath);
    const node: TreeNode = {
      label: `${relPath} (${lc ?? "?"})`,
      relPath,
      children: [],
      cycle: false,
    };
    if (visiting.has(relPath)) {
      node.cycle = true;
      node.label = `${relPath} (cycle)`;
      return node;
    }
    visiting.add(relPath);
    for (const e of byRelPath.get(relPath) ?? []) {
      if (e.uid !== null && e.localPath !== null) {
        node.children.push(buildNode(path.relative(ws.root, e.localPath), visiting));
      } else {
        // code/remote/missing leaf
        const name = e.edge.name !== null ? ` "${e.edge.name}"` : "";
        node.children.push({
          label: `${e.edge.ref} [${e.edge.kind}] (${e.status})${name}`,
          relPath: null,
          children: [],
          cycle: false,
        });
      }
    }
    visiting.delete(relPath);
    return node;
  };

  const roots = rootRelPaths.map((rp) => buildNode(rp, new Set<string>()));

  if (values["json"] === true) {
    printJson(roots);
    return;
  }
  if (roots.length === 0) {
    print("no projects found");
    return;
  }
  const render = (node: TreeNode, depth: number): void => {
    print(`${"  ".repeat(depth)}${node.label}`);
    for (const c of node.children) render(c, depth + 1);
  };
  for (const r of roots) render(r, 0);
}

// --- plan ---

function cmdPlan(argv: string[]): void {
  const sub = argv[0];
  const rest = argv.slice(1);
  const { values } = parse(rest, { ...FLAG_JSON, ...FLAG_PROJECT });
  const { root } = resolveProject(values["project"] as string | undefined);
  const planPath = path.join(root, "_project", "plans", "current.md");

  switch (sub) {
    case "show": {
      if (!fs.existsSync(planPath)) throw new NotFoundError(`no plan file: ${planPath}`);
      const content = fs.readFileSync(planPath, "utf8");
      if (values["json"] === true) printJson({ path: planPath, content });
      else print(content.trimEnd());
      return;
    }
    case "open": {
      const editor = process.env["VISUAL"] ?? process.env["EDITOR"];
      if (editor === undefined || editor === "") {
        print(planPath); // no editor configured: hand the path to the caller
        return;
      }
      const child = spawn(editor, [planPath], { stdio: "inherit" });
      child.on("exit", (code) => process.exit(code ?? 0));
      return;
    }
    default:
      throw new ConfigError(`unknown plan subcommand: ${sub ?? "(none)"} (expected show|open)`);
  }
}

// --- forum ---

function forumCtx(projectRef: string | undefined): forum.ForumContext {
  const { root } = resolveProject(projectRef);
  return { startDir: root, store: getStore() };
}

function cmdForum(argv: string[]): void {
  const sub = argv[0];
  const rest = argv.slice(1);
  const common: Spec = { ...FLAG_JSON, ...FLAG_PROJECT, as: { type: "string" } };

  switch (sub) {
    case "announce": {
      const { values } = parse(rest, { ...common, doing: { type: "string" } });
      const entry = forum.announce(forumCtx(values["project"] as string | undefined), {
        as: values["as"] as string | undefined,
        plan: values["doing"] as string | undefined,
      });
      if (values["json"] === true) printJson(entry);
      else print(`announced ${entry.participant}@${entry.machine}${entry.plan !== null ? `: ${entry.plan}` : ""}`);
      return;
    }
    case "depart": {
      const { values } = parse(rest, common);
      const removed = forum.depart(forumCtx(values["project"] as string | undefined), {
        as: values["as"] as string | undefined,
      });
      if (values["json"] === true) printJson({ removed });
      else print(removed ? "departed" : "no presence file to remove");
      return;
    }
    case "who": {
      const { values } = parse(rest, common);
      const entries = forum.who(forumCtx(values["project"] as string | undefined));
      if (values["json"] === true) printJson(entries);
      else if (entries.length === 0) print("nobody here");
      else
        for (const e of entries) {
          const plan = e.plan !== null ? `  — ${e.plan}` : "";
          const post = e.lastPost !== null ? `  (last post ${e.lastPost.ts} in ${e.lastPost.thread})` : "";
          print(`${e.participant}  [${e.staleness}]${plan}${post}`);
        }
      return;
    }
    case "open": {
      const { values, positionals } = parse(rest, { ...common, slug: { type: "string" }, body: { type: "string" } });
      const title = positionals[0];
      if (title === undefined) throw new ConfigError('usage: projects forum open "title"');
      const info = forum.openThread(forumCtx(values["project"] as string | undefined), {
        title,
        slug: values["slug"] as string | undefined,
        as: values["as"] as string | undefined,
        body: values["body"] as string | undefined,
      });
      if (values["json"] === true) printJson(info);
      else print(`opened thread ${info.name}`);
      return;
    }
    case "post": {
      const { values, positionals } = parse(rest, {
        ...common,
        kind: { type: "string" },
        to: { type: "string", multiple: true },
        re: { type: "string" },
        ref: { type: "string", multiple: true },
      });
      const [thread, body] = positionals;
      if (thread === undefined || body === undefined) {
        throw new ConfigError('usage: projects forum post <thread> "body" [flags]');
      }
      const message = forum.post(forumCtx(values["project"] as string | undefined), thread, {
        body,
        kind: values["kind"] as forum.MessageKind | undefined,
        as: values["as"] as string | undefined,
        to: values["to"] as string[] | undefined,
        re: values["re"] as string | undefined,
        refs: values["ref"] as string[] | undefined,
      });
      if (values["json"] === true) printJson(message);
      else print(`posted ${message.id} in ${message.thread}`);
      return;
    }
    case "show": {
      const { values, positionals } = parse(rest, { ...common, since: { type: "string" } });
      const thread = positionals[0];
      if (thread === undefined) throw new ConfigError("usage: projects forum show <thread>");
      const result = forum.showThread(forumCtx(values["project"] as string | undefined), thread, {
        since: values["since"] as string | undefined,
      });
      if (values["json"] === true) printJson(result);
      else {
        const t = result.thread;
        print(`${t.name}  [${t.status}${t.archived ? ", archived" : ""}]  ${t.title ?? ""}`);
        for (const m of result.messages) {
          const to = m.to.length > 0 ? ` → ${m.to.join(", ")}` : "";
          print(`\n--- ${m.ts}  ${m.from}  (${m.kind})${to}${m.re !== null ? `  re: ${m.re}` : ""}`);
          print(m.body.trimEnd());
        }
      }
      return;
    }
    case "list": {
      const { values } = parse(rest, { ...common, archived: { type: "boolean", default: false } });
      const threads = forum.listThreads(forumCtx(values["project"] as string | undefined), {
        includeArchived: values["archived"] === true,
      });
      if (values["json"] === true) printJson(threads);
      else if (threads.length === 0) print("no threads");
      else
        for (const t of threads) {
          const last = t.lastActivityAt !== null ? `  last ${t.lastActivityAt}` : "";
          print(`${t.name}  [${t.status}${t.archived ? ", archived" : ""}]  ${t.messageCount} msg${last}  ${t.title ?? ""}`);
        }
      return;
    }
    case "inbox": {
      const { values } = parse(rest, common);
      const items = forum.inbox(forumCtx(values["project"] as string | undefined), {
        as: values["as"] as string | undefined,
      });
      if (values["json"] === true) printJson(items);
      else if (items.length === 0) print("inbox empty");
      else
        for (const item of items) {
          print(`${item.thread} :: ${item.message.id} from ${item.message.from}`);
          print(`  ${item.message.body.trim().split("\n")[0] ?? ""}`);
        }
      return;
    }
    case "resolve": {
      const { values, positionals } = parse(rest, common);
      const thread = positionals[0];
      if (thread === undefined) throw new ConfigError("usage: projects forum resolve <thread>");
      const info = forum.resolveThread(forumCtx(values["project"] as string | undefined), thread);
      if (values["json"] === true) printJson(info);
      else print(`resolved ${info.name}`);
      return;
    }
    case "archive": {
      const { values, positionals } = parse(rest, common);
      const thread = positionals[0];
      if (thread === undefined) throw new ConfigError("usage: projects forum archive <thread>");
      const target = forum.archiveThread(forumCtx(values["project"] as string | undefined), thread);
      if (values["json"] === true) printJson({ archivedTo: target });
      else print(`archived to ${target}`);
      return;
    }
    case "sweep": {
      // §4.6 retention: removes OWN-MACHINE presence >7 days; PROPOSES (never
      // executes) archiving resolved threads untouched >30 days.
      const { values } = parse(rest, common);
      const result = forum.sweepForum(forumCtx(values["project"] as string | undefined));
      if (values["json"] === true) {
        printJson(result);
        return;
      }
      print(`swept ${result.presenceRemoved.length} stale own-machine presence file(s)`);
      for (const p of result.archiveProposals) {
        print(`propose: projects forum archive ${p.name}  (resolved, untouched >30 days)`);
      }
      return;
    }
    default:
      throw new ConfigError(
        `unknown forum subcommand: ${sub ?? "(none)"} (expected announce|depart|who|open|post|show|list|inbox|resolve|archive|sweep)`,
      );
  }
}

// --- import ---

function cmdImport(argv: string[]): void {
  const sub = argv[0];
  if (sub !== "legacy") {
    throw new ConfigError(`unknown import subcommand: ${sub ?? "(none)"} (expected legacy)`);
  }
  const { values, positionals } = parse(argv.slice(1), {
    ...FLAG_JSON,
    ...FLAG_PROJECT,
    "dry-run": { type: "boolean", default: false },
    apply: { type: "boolean", default: false },
    all: { type: "boolean", default: false },
  });
  if (values["dry-run"] === true && values["apply"] === true) {
    throw new ConfigError("pass either --dry-run or --apply, not both");
  }
  // Dry-run-first: the default mode is the plan; --apply executes exactly it.
  const apply = values["apply"] === true;
  const ref = positionals[0] ?? (values["project"] as string | undefined);
  if (values["all"] === true && ref !== undefined) {
    throw new ConfigError("pass either --all or a <project-ref>, not both");
  }

  let roots: string[];
  if (values["all"] === true) {
    const ws = openWorkspaceRegistered(process.cwd());
    roots = discoverProjects(ws, { all: true }).map((p) => p.root);
  } else {
    roots = [resolveProject(ref).root];
  }

  // Per-project failure isolation: a failing project (plan errors / a thrown
  // apply) must not prevent later projects from being attempted, and every
  // project's audit lines must be printed regardless — under --all, a single
  // bad project would otherwise hide the audit of already-applied ones.
  const results: Array<{ plan: ImportPlan; written: string[]; skippedApply: boolean }> = [];
  for (const root of roots) {
    const plan = planLegacyImport(root);
    if (apply && plan.errors.length === 0) {
      // applyLegacyImport re-plans under the project's mint lock and
      // executes exactly that plan; plan errors above already short-circuit.
      const r = applyLegacyImport(root, getStore());
      results.push({ plan: r.plan, written: r.written, skippedApply: false });
    } else {
      results.push({ plan, written: [], skippedApply: apply && plan.errors.length > 0 });
    }
  }

  const errorCount = results.reduce((n, r) => n + r.plan.errors.length, 0);
  const failing = results.filter((r) => r.plan.errors.length > 0);
  if (values["json"] === true) {
    // Externalize without the write payloads (the audit fields stay).
    printJson(
      results.map((r) => ({
        projectRoot: r.plan.projectRoot,
        uid: r.plan.uid,
        mode: apply ? "apply" : "dry-run",
        sources: r.plan.sources,
        actions: r.plan.actions.map(({ kind, source, target, note }) => ({ kind, source, target, note })),
        errors: r.plan.errors,
        counts: r.plan.counts,
        written: r.written,
      })),
    );
  } else {
    for (const r of results) {
      for (const line of renderPlan(r.plan, { mode: apply ? "apply" : "dry-run" })) print(line);
      if (r.skippedApply) {
        print(`refusing to apply ${r.plan.projectRoot}: ${r.plan.errors.length} plan error(s) — NOTHING was applied for this entire project`);
      } else if (apply) {
        print(`applied: ${r.written.length} file(s) written`);
      }
    }
  }
  if (errorCount > 0) {
    fail(
      `${errorCount} import plan error(s) in ${failing.length} of ${results.length} project(s) — ` +
        (apply
          ? `nothing was applied for the failing project(s) (whole-project refusal); the others were applied`
          : `nothing would be applied for the failing project(s) (whole-project refusal)`),
    );
  }
}

// --- automations (PRD §7: intent in the tree, machine-local activation) ---

/**
 * Adapter selection happens here, once: the OPENWORKSPACE_LAUNCHD_DIR env
 * override yields the file-backed fake (tests/CI never touch launchctl or
 * the real ~/Library/LaunchAgents); otherwise the real launchctl adapter.
 */
function automationCtx(projectRef: string | undefined): automations.AutomationContext {
  const { root } = resolveProject(projectRef);
  return {
    startDir: root,
    store: getStore(),
    launchd: automations.launchdFromEnv(process.env),
  };
}

function printStatusFindings(findings: automations.StatusFinding[]): void {
  if (findings.length === 0) {
    print("automation status: no drift");
    return;
  }
  for (const f of findings) {
    print(`${f.kind}  [${f.machine}]  ${f.name}: ${f.detail}`);
  }
}

function cmdAutomation(argv: string[]): void {
  const sub = argv[0];
  const rest = argv.slice(1);
  const common: Spec = { ...FLAG_JSON, ...FLAG_PROJECT };

  switch (sub) {
    case "apply": {
      const { values, positionals } = parse(rest, {
        ...common,
        all: { type: "boolean", default: false },
        force: { type: "boolean", default: false },
      });
      const name = positionals[0];
      const all = values["all"] === true;
      if ((name === undefined) === !all) {
        throw new ConfigError("usage: projects automation apply <name> | --all  (exactly one)");
      }
      const ctx = automationCtx(values["project"] as string | undefined);
      const summary = automations.apply(ctx, {
        ...(name !== undefined ? { name } : {}),
        all,
        force: values["force"] === true,
      });
      if (values["json"] === true) {
        printJson(summary);
        return;
      }
      for (const r of summary.applied) {
        print(`${r.name}: ${r.action} on ${r.machine}${r.forced ? " (FORCED — machine undeclared)" : ""}  (${r.label})`);
      }
      for (const s of summary.skippedUndeclared) print(`${s}: skipped (this machine not declared)`);
      for (const inv of summary.invalid) {
        print(`${inv.name}: INVALID manifest — ${inv.problems.map((p) => p.message).join("; ")}`);
      }
      for (const w of summary.warnings) print(`WARNING: ${w}`);
      if (summary.invalid.length > 0) process.exit(1);
      return;
    }
    case "deactivate": {
      const { values, positionals } = parse(rest, common);
      const name = positionals[0];
      if (name === undefined) throw new ConfigError("usage: projects automation deactivate <name>");
      const result = automations.deactivate(automationCtx(values["project"] as string | undefined), name);
      if (values["json"] === true) printJson(result);
      else
        print(
          result.removedPlist || result.removedRecord
            ? `deactivated ${result.name} (${result.label})`
            : `${result.name}: nothing to deactivate on this machine`,
        );
      return;
    }
    case "list": {
      const { values } = parse(rest, { ...common, all: { type: "boolean", default: false } });
      const ctx = automationCtx(values["project"] as string | undefined);
      if (values["all"] === true) {
        // §7.3: every machine's synced registry, with explicit staleness
        const machines = automations.listAllMachines(ctx);
        if (values["json"] === true) {
          printJson(machines);
          return;
        }
        if (machines.length === 0) {
          print("no machine registries (.openworkspace/machines/ is empty)");
          return;
        }
        for (const m of machines) {
          const stale =
            m.staleDays === null ? "no parseable heartbeat" : m.staleDays > 0 ? `stale ${m.staleDays}d` : "fresh";
          print(`${m.machineId}  heartbeat ${m.heartbeat ?? "—"} (${stale})`);
          for (const a of m.activations) print(`  ${a.name}  ${a.schedule}  (${a.project_uid})`);
          for (const r of m.lastRuns) print(`  last run ${r.key}: ${r.status}${r.finished_at !== null ? ` at ${r.finished_at}` : ""}`);
        }
        return;
      }
      const entries = automations.listAutomations(ctx);
      if (values["json"] === true) printJson(entries);
      else if (entries.length === 0) print("no automations defined");
      else
        for (const e of entries) {
          if (!e.valid) {
            print(`${e.name}  INVALID: ${e.problems.join("; ")}`);
          } else {
            print(`${e.name}  ${e.schedule ?? ""}  machines=[${e.machines.join(", ")}]  ${e.localState}`);
          }
        }
      return;
    }
    case "status": {
      const { values } = parse(rest, common);
      const findings = automations.status(automationCtx(values["project"] as string | undefined));
      if (values["json"] === true) printJson(findings);
      else printStatusFindings(findings);
      return;
    }
    case "prune": {
      const { values } = parse(rest, common);
      const result = automations.prune(automationCtx(values["project"] as string | undefined));
      if (values["json"] === true) printJson(result);
      else if (result.pruned.length === 0) print(`nothing to prune (${result.kept} activation(s) intact)`);
      else for (const p of result.pruned) print(`pruned ${p.name} (${p.project_uid}): ${p.reason}`);
      return;
    }
    case "logs": {
      const { values, positionals } = parse(rest, { ...common, machine: { type: "string" } });
      const name = positionals[0];
      if (name === undefined) throw new ConfigError("usage: projects automation logs <name> [--machine M]");
      const result = automations.logsFor(automationCtx(values["project"] as string | undefined), name, {
        machine: values["machine"] as string | undefined,
      });
      if (values["json"] === true) {
        printJson(result);
        return;
      }
      if (result.files.length === 0) {
        print(`no logs for ${name}`);
        return;
      }
      for (const f of result.files) print(`${f.machine}  ${f.path}`);
      if (result.latest !== null) {
        print("");
        print(`--- latest (${result.latest.machine}) ---`);
        print(result.latest.content.trimEnd());
      }
      return;
    }
    case "run-now": {
      const { values, positionals } = parse(rest, common);
      const name = positionals[0];
      if (name === undefined) throw new ConfigError("usage: projects automation run-now <name>");
      const { root, uid } = resolveProject(values["project"] as string | undefined);
      const wsRoot = findWorkspaceRoot(root);
      const outcome = runAutomation({
        uid,
        name,
        store: getStore(),
        ...(wsRoot !== null ? { extraWorkspaceRoots: [wsRoot] } : {}),
      });
      if (values["json"] === true) printJson(outcome);
      else
        print(
          `${outcome.name}: ${outcome.status}` +
            `${outcome.exitCode !== null ? ` (exit ${outcome.exitCode})` : ""}` +
            `${outcome.logPath !== null ? ` — ${outcome.logPath}` : ""}`,
        );
      if (outcome.status !== "ok" && outcome.status !== "skipped-dormant") process.exit(1);
      return;
    }
    default:
      throw new ConfigError(
        `unknown automation subcommand: ${sub ?? "(none)"} (expected apply|deactivate|list|status|prune|logs|run-now)`,
      );
  }
}

// --- skills (aggregate per-project Skills/ → .agents/skills/ → runtime dirs) ---

/**
 * Resolve a runtime skills dir from the environment. Honors test/CI overrides
 * so a real run NEVER touches the real ~/.claude or ~/.codex unless the user is
 * actually running it: OPENWORKSPACE_CLAUDE_SKILLS_DIR / _CODEX_SKILLS_DIR pin
 * the path (tests set these to temp dirs); otherwise the conventional home dir.
 */
function runtimeSkillsDir(envVar: string, homeRel: string[]): string | null {
  const override = process.env[envVar];
  if (override !== undefined && override !== "") return path.resolve(override);
  const home = process.env["HOME"];
  if (home === undefined || home === "") return null;
  return path.join(home, ...homeRel);
}

/**
 * Build the real `SkillsEnv` from the workspace + process environment. The fs
 * surface is plain node:fs (the planner only ever touches the workspace's
 * `.agents/`, the README, and the resolved runtime dirs — all real paths the
 * user owns). Source roots default to every project's `Skills/` + OpenWorkspace.
 */
function buildSkillsEnv(ws: Workspace): SkillsEnv {
  const realFs: SkillsFs = {
    existsSync: fs.existsSync,
    readdirSync: (p, opts) => fs.readdirSync(p, opts),
    readFileSync: (p, enc) => fs.readFileSync(p, enc),
    lstatSync: fs.lstatSync,
    readlinkSync: fs.readlinkSync,
    symlinkSync: fs.symlinkSync,
    unlinkSync: fs.unlinkSync,
    mkdirSync: (p, opts) => {
      fs.mkdirSync(p, opts);
    },
  };
  const base: Pick<SkillsEnv, "ws" | "fs"> = { ws, fs: realFs };
  const readmeOverride = process.env["OPENWORKSPACE_SKILLS_README"];
  const readmePath =
    readmeOverride !== undefined && readmeOverride !== ""
      ? path.resolve(readmeOverride)
      : path.join(ws.root, "README.md");
  return {
    ws,
    fs: realFs,
    claudeSkillsDir: runtimeSkillsDir("OPENWORKSPACE_CLAUDE_SKILLS_DIR", [".claude", "skills"]),
    codexSkillsDir: runtimeSkillsDir("OPENWORKSPACE_CODEX_SKILLS_DIR", [".codex", "skills"]),
    sourceRoots: defaultSourceRoots(base),
    readmePath,
  };
}

function cmdSkills(argv: string[]): void {
  const sub = argv[0];
  if (sub !== "sync") {
    throw new ConfigError(`unknown skills subcommand: ${sub ?? "(none)"} (expected sync)`);
  }
  const { values } = parse(argv.slice(1), {
    ...FLAG_JSON,
    "dry-run": { type: "boolean", default: false },
    apply: { type: "boolean", default: false },
  });
  if (values["dry-run"] === true && values["apply"] === true) {
    throw new ConfigError("pass either --dry-run or --apply, not both");
  }
  const apply = values["apply"] === true;
  const ws = openWorkspaceRegistered(process.cwd());
  const env = buildSkillsEnv(ws);
  const plan = planSkillsSync(env);
  const result = apply ? applySkillsSync(env, plan) : null;

  if (values["json"] === true) {
    printJson({
      mode: apply ? "apply" : "dry-run",
      skills: plan.skills,
      collisions: Object.fromEntries([...plan.collisions.entries()]),
      actions: plan.actions,
      readme:
        plan.readme === null
          ? null
          : { path: plan.readme.path, changed: plan.readme.changed },
      applied: result === null ? null : result.applied,
      refusals: result === null ? null : result.refusals,
      readmeWritten: result === null ? null : result.readmeWritten,
    });
  } else {
    for (const line of renderSkillsPlan(plan, apply ? "apply" : "dry-run")) print(line);
    if (result !== null) {
      print(`applied: ${result.applied.length} link change(s)${result.readmeWritten ? ", README updated" : ""}`);
      for (const r of result.refusals) print(`  refused: ${r.reason}`);
    }
  }
  if (result !== null && result.refusals.length > 0) {
    fail(`${result.refusals.length} link(s) refused (non-symlink occupant) — see above`);
  }
}

// --- dashboard ---

function cmdDashboard(argv: string[]): void {
  const sub = argv[0];
  if (sub !== "dev" && sub !== "open") {
    throw new ConfigError(`unknown dashboard subcommand: ${sub ?? "(none)"} (expected dev|open)`);
  }
  const { values } = parse(argv.slice(1), {
    port: { type: "string" },
    config: { type: "string" },
    host: { type: "string" },
    "allow-host": { type: "string", multiple: true },
    "cache-ttl": { type: "string" },
  });

  // §8/§9: per-workspace launch config (C3 owns its launcher). TOML keys:
  // `workspace` (path, resolved relative to the config file; default = walk-up
  // from cwd), `port` (number), `host` (bind-host string, default 127.0.0.1),
  // and `allowed_hosts` (array of strings ADDED to the secure default
  // {localhost,127.0.0.1}). The SECURE DEFAULT — loopback bind + loopback-only
  // Host check — is unchanged when none of host/allow-host are set anywhere.
  // Explicit flags outrank the config file: --port over `port`, --host over
  // `host`, and --allow-host APPENDS to `allowed_hosts`.
  let configWorkspace: string | null = null;
  let configPort: number | null = null;
  let configHost: string | null = null;
  let configCacheTtlMs: number | null = null;
  const configAllowedHosts: string[] = [];
  if (values["config"] !== undefined) {
    const configPath = path.resolve(process.cwd(), values["config"] as string);
    const cfg = readToml(configPath);
    if (typeof cfg["workspace"] === "string") {
      configWorkspace = path.resolve(path.dirname(configPath), cfg["workspace"]);
    }
    if (cfg["port"] !== undefined) {
      if (typeof cfg["port"] !== "number" || !Number.isInteger(cfg["port"])) {
        throw new ConfigError(`dashboard config key "port" must be an integer (${configPath})`);
      }
      configPort = cfg["port"];
    }
    if (cfg["host"] !== undefined) {
      if (typeof cfg["host"] !== "string") {
        throw new ConfigError(`dashboard config key "host" must be a string (${configPath})`);
      }
      configHost = cfg["host"];
    }
    if (cfg["allowed_hosts"] !== undefined) {
      if (!Array.isArray(cfg["allowed_hosts"]) || cfg["allowed_hosts"].some((x) => typeof x !== "string")) {
        throw new ConfigError(`dashboard config key "allowed_hosts" must be an array of strings (${configPath})`);
      }
      configAllowedHosts.push(...(cfg["allowed_hosts"] as string[]));
    }
    if (cfg["cache_ttl_ms"] !== undefined) {
      if (typeof cfg["cache_ttl_ms"] !== "number" || !Number.isInteger(cfg["cache_ttl_ms"]) || cfg["cache_ttl_ms"] < 0) {
        throw new ConfigError(`dashboard config key "cache_ttl_ms" must be a non-negative integer (${configPath})`);
      }
      configCacheTtlMs = cfg["cache_ttl_ms"];
    }
  }
  const ws = openWorkspaceRegistered(configWorkspace ?? process.cwd());
  const port = values["port"] !== undefined ? Number(values["port"]) : configPort ?? 0;
  if (Number.isNaN(port)) throw new ConfigError(`invalid --port: ${String(values["port"])}`);
  const host = (values["host"] as string | undefined) ?? configHost ?? undefined;
  const flagAllowHosts = (values["allow-host"] as string[] | undefined) ?? [];
  const allowedHosts = [...configAllowedHosts, ...flagAllowHosts];
  // In-memory scan-cache TTL (ms): --cache-ttl over `cache_ttl_ms`, default 0
  // (caching off ⇒ always fresh, the unchanged foreground `dashboard dev` case).
  let cacheTtlMs = configCacheTtlMs ?? 0;
  if (values["cache-ttl"] !== undefined) {
    const t = Number(values["cache-ttl"]);
    if (!Number.isInteger(t) || t < 0) {
      throw new ConfigError(`invalid --cache-ttl: ${String(values["cache-ttl"])} (expected a non-negative integer of ms)`);
    }
    cacheTtlMs = t;
  }
  void startDashboard({ workspaceRoot: ws.root, port, host, allowedHosts, cacheTtlMs })
    .then((running) => {
      print(`dashboard: ${running.url} (read-only; Ctrl-C to stop)`);
      if (sub === "open") spawn("open", [running.url], { stdio: "ignore", detached: true }).unref();
    })
    .catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
}

// ---------------------------------------------------------------------------
// Dispatch

export function main(argv: string[]): void {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
      process.stderr.write(USAGE);
      process.exit(1);
      break;
    case "help":
    case "--help":
    case "-h":
      print(USAGE);
      return;
    case "home":
      cmdHome(rest);
      return;
    case "init":
      cmdInit(rest);
      return;
    case "new":
      cmdNew(rest);
      return;
    case "show":
      cmdShow(rest);
      return;
    case "doctor":
      cmdDoctor(rest);
      return;
    case "rename":
      cmdRename(rest);
      return;
    case "move":
      cmdMove(rest);
      return;
    case "lifecycle":
      cmdLifecycle(rest);
      return;
    case "reconcile":
      cmdReconcile(rest);
      return;
    case "task":
      cmdTask(rest);
      return;
    case "decision":
      cmdDecision(rest);
      return;
    case "link":
      cmdLink(rest);
      return;
    case "tree":
      cmdTree(rest);
      return;
    case "plan":
      cmdPlan(rest);
      return;
    case "forum":
      cmdForum(rest);
      return;
    case "dashboard":
      cmdDashboard(rest);
      return;
    case "automation":
      cmdAutomation(rest);
      return;
    case "skills":
      cmdSkills(rest);
      return;
    case "import":
      cmdImport(rest);
      return;
    default:
      fail(`unknown command: ${command} — run \`projects help\``);
  }
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    if (err instanceof OwError) {
      process.stderr.write(`error: ${err.message}\n`);
      process.exit(err.exitCode);
    }
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
