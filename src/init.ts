/**
 * Init (PRD §4.3, §4.1, Appendix A).
 *
 * - `initWorkspace` — `projects home init`: create the `.openworkspace/`
 *   marker and mint a workspace_id. config.toml carries only non-default
 *   values (the minted id and schema); everything else stays implicit.
 * - `initProject` — `projects init [<path>]` (path defaults to the cwd, with
 *   cli.ts guard rails): stamp the FULL skeleton — every
 *   designed primitive pre-created, plus the two orientation artifacts
 *   (_project/README.md per Appendix A, forum/README.md) and the committed
 *   git posture (_project/.gitignore, §6.1). No shape flags.
 *
 * Both are refuse-don't-overwrite: re-running against an existing target is a
 * ConflictError, never a silent restamp (hand edits are precious).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { ConflictError, NotFoundError } from "./lib/errors.js";
import { createExclusive, ensureDir, readTextIfExists, writeFileAtomic } from "./lib/fsatomic.js";
import { readTomlIfExists, writeToml } from "./lib/toml.js";
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

/** Appendix A — the `_project/README.md` stamped by init. VERBATIM from the PRD. */
export const PROJECT_README = `# _project/ — OpenWorkspace control plane

This directory holds this project's work-organization records, owned by
OpenWorkspace (\`projects\` CLI). The project's actual content lives at the
project root; agent configuration (CLAUDE.md, .claude/) also stays at the
root, outside this directory.

## The two rules that explain everything here

1. **Location encodes visibility and retention.** Live records sit directly
   in their primitive's directory; archived records sit in its \`archive/\`
   subdirectory; a project's lifecycle (active/dormant/archived) is encoded
   by where the *project folder* sits in the workspace — never by a field.
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
- \`project.toml\` — optional; declared facts (e.g. \`lifecycle = "dormant"\`) only.
- \`plans/current.md\` — the forward-looking plan, in prose. Complements
  tasks; never a duplicate checkbox list of them.
- \`tasks/\` — one file per task: \`task-<n> - <slug>.md\`.
  - **Status** lives in frontmatter: \`todo | doing | waiting | review |
    done\`. \`done\` requires a \`## Final Summary\` (one line suffices for a
    judgment call: "Decided: skip").
  - **Subtasks** use dotted IDs (\`task-36.7\`; parentage lives in the ID
    alone), flat in the same directory. Keep nesting ≤3 levels — if a
    child doesn't need its own status/notes, make it an Acceptance
    Criteria checkbox instead.
  - **Reminders are tasks.** Set \`hidden_until: <date>\` and the task stays
    out of default listings until then, then reappears for you to act on,
    re-hide (\`projects task hide <id> --until <date>\`), or close.
  - **Recurring tasks** set \`recur: <weekly|monthly|yearly|every-N-days>\`.
    \`projects task done\` on one completes the *occurrence*: it appends a
    completion line to \`## Log\` and advances \`hidden_until\` to the next
    occurrence — the record stays open. A recurring task is never
    \`status: done\`; to retire it, \`projects task recur <id> off\`, then
    close it normally.
- \`wiki/\` — the project's repository of substantive accumulated knowledge:
  research notes, reference pages, distilled findings, design docs. If the
  project learned something worth keeping, it goes here.
- \`decisions/\` — one short record per significant decision:
  \`decision-<n> - <slug>.md\`, Context / Decision / Consequences. Immutable
  once accepted; changing course means a new record plus \`superseded_by:\`
  on the old one. **Record decisions when they happen** —
  \`projects decision new "<title>"\` takes two minutes.
- \`automations/\` — scheduled-job definitions: a TOML manifest (cadence,
  declared target machines, secret *pointers* — never secret values),
  README, and program. Definitions are intent; nothing runs until
  \`projects automation apply\` is executed on a declared machine.
- \`forum/\` — coordination: announce presence (\`projects forum announce
  --doing "..."\`), check in on workstream threads, ask addressed questions
  (\`--to <participant>\`). One immutable file per message; never edit or
  delete another participant's files. Forum verbs always read and write
  the project's CANONICAL location (so agents in different git worktrees
  see each other) — never hand-edit \`forum/\` from inside a worktree.

Tool-created when needed: \`archive/\` (bulk preserved material, e.g.
migration imports; not tracked in git — durability rides the backup tier)
and \`dashboard/\` (dashboard config). There are deliberately no other
directories here; anything else (helper scripts, retrospectives, …) is
ordinary project content and belongs at the project root.

## Quick reference

    projects task create "title" [--parent 36] [--quadrant q2]
                                 [--hidden-until 2026-09-01] [--recur weekly]
    projects task list [--subtasks] [--hidden] [--all]
    projects task status <id> <todo|doing|waiting|review|done>
    projects decision new "title"
    projects forum announce --doing "..." · who · post <thread> "..." · inbox
    projects automation apply [--all] · status
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

/** plans/current.md stub — forward-looking prose, never a task mirror. */
export const PLAN_STUB = `# Current plan

Forward-looking prose: where this project is heading and why. Complements
the task records in ../tasks/ — never a duplicate checkbox list of them.
`;

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

/** The §4.3 skeleton, relative to _project/. Dirs end with "/". */
export const SKELETON_ENTRIES = [
  "README.md",
  ".gitignore",
  "id",
  "plans/",
  "plans/current.md",
  "tasks/",
  "wiki/",
  "decisions/",
  "automations/",
  "forum/",
  "forum/README.md",
  "forum/threads/",
  "forum/presence/",
] as const;

export interface InitProjectResult {
  projectRoot: string;
  uid: string;
}

/**
 * Stamp the full project skeleton at `dir` (creating the directory when
 * absent). Refuses when `dir` is already a project (write-once `_project/id`).
 * No shape flags: every designed primitive is pre-created (PRD §4.3).
 */
export function initProject(dir: string): InitProjectResult {
  const projectRoot = path.resolve(dir);
  const existingUid = readProjectUid(projectRoot);
  if (existingUid !== null) {
    throw new ConflictError(
      `already a project (uid ${existingUid}): ${projectRoot} — _project/id is write-once`,
    );
  }
  const p = path.join(projectRoot, "_project");
  ensureDir(p);

  const uid = crypto.randomUUID();
  // id first and exclusively: it is the project's identity claim; losing a
  // race to a concurrent init must not half-stamp two skeletons.
  createExclusive(path.join(p, "id"), uid + "\n");

  ensureDir(path.join(p, "plans"));
  ensureDir(path.join(p, "tasks"));
  ensureDir(path.join(p, "wiki"));
  ensureDir(path.join(p, "decisions"));
  ensureDir(path.join(p, "automations"));
  ensureDir(path.join(p, "forum", "threads"));
  ensureDir(path.join(p, "forum", "presence"));

  const stamp = (rel: string, content: string): void => {
    const target = path.join(p, rel);
    if (!fs.existsSync(target)) createExclusive(target, content);
  };
  stamp("README.md", PROJECT_README);
  stamp(".gitignore", PROJECT_GITIGNORE);
  stamp(path.join("plans", "current.md"), PLAN_STUB);
  stamp(path.join("forum", "README.md"), FORUM_README);

  return { projectRoot, uid };
}
