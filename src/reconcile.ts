/**
 * Reconcile — heal location ⟷ metadata drift (decision-2: metadata-as-truth).
 *
 * THE PROBLEM. The tree is synced laptop⟷Mini by iCloud Drive, which has no
 * tombstone-honest delete model (last-writer-wins over file existence + a
 * ~30-day deleted-bytes reservoir). iCloud can RESURRECT a deleted directory
 * or REVERT a move from a stale offline copy. For a movement-as-state design
 * that is fatal: a move/delete that SIGNALS state gets silently undone.
 *
 * THE FIX. State has exactly one home — the file's CONTENT (frontmatter /
 * `project.toml`), which syncs safely as content. LOCATION becomes a DERIVED,
 * RECONCILED VIEW of that content. When content and location disagree, content
 * wins — UNLESS a tombstone-honest signal proves the location change was a real
 * human act, in which case content is healed forward to match. iCloud
 * resurrecting a delete or reverting a move is then COSMETIC drift a reconcile
 * pass heals, not state corruption. There is ONE source of truth (the
 * metadata); location is a maintained view.
 *
 * THE HARD SUB-PROBLEM (drag vs. glitch). A human dragging a project into
 * `Dormant Projects/` in Finder, and iCloud spuriously moving the same folder,
 * are the SAME observable event (location changed) but require OPPOSITE
 * responses (human drag ⇒ heal metadata to dormant; iCloud glitch ⇒ revert
 * location to what metadata says). The tiebreaker must be something iCloud
 * cannot forge. `classifyDrift` resolves it in three tiers:
 *   1. committed git (where a project is a repo) — `git show HEAD:project.toml`;
 *      iCloud cannot author a commit.
 *   2. the machine-local intent-log (the common non-git case) — append-only
 *      JSONL in ~/Library/Application Support, outside iCloud's reach.
 *   3. the irreducible case (silent Finder-drag, no command, no local intent) —
 *      byte-identical to a glitch; PROPOSE-ONLY, never act. The dangerous
 *      failure is fighting the user, so we refuse to guess.
 *
 * THE SAFETY ASYMMETRY. Reconcile auto-heals only in the glitch-certain
 * direction (revert-location, backed by git or local-intent-on-metadata).
 * Adopting a bare location into metadata (rewriting declared lifecycle from a
 * location with no proof) requires git-proof or an explicit human flag. We
 * undo glitches; we never silently overrule a human.
 *
 * Records (retention) heal narrowly, NOT via field-as-truth (that is deferred):
 * same-ID duplicates (the iCloud copy/merge shape) and resurrected state-named
 * subdirs (the ghost-dir shape) are cleaned; `tasks/archive/` and
 * `forum/threads/archive/` are whitelisted and never touched.
 *
 * Like the importers: PLAN (pure read, the dry-run default) then APPLY
 * (executes exactly the rendered plan); both logged per-action.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { ensureDir } from "./lib/fsatomic.js";
import { readRecord } from "./lib/frontmatter.js";
import { formatId, idFromFilename } from "./lib/ids.js";
import {
  MachineStore,
  appendLifecycleIntent,
  lastLifecycleIntent,
  lastRetired,
  machineId,
  retireLifecycleIntents,
  writeUidCacheEntry,
} from "./lib/machine.js";
import { gitShowAtHead, isGitRepo, isGitWorktree } from "./lib/resolve.js";
import {
  DeclaredLifecycle,
  Lifecycle,
  ProjectInfo,
  Workspace,
  discoverProjects,
  lifecycleOf,
  locationOfDeclared,
  writeDeclaredLifecycle,
} from "./lib/workspace.js";

// ---------------------------------------------------------------------------
// Drift classification (the drag-vs-glitch tiebreaker)
// ---------------------------------------------------------------------------

export type DriftDriver =
  | "git-glitch" // committed metadata disagrees with location → location is forged
  | "git-drag" // committed metadata MATCHES location → the human moved + committed
  | "intent-glitch" // local intent matches metadata, none for location → glitch
  | "intent-drag" // local intent matches the LOCATION → the human dragged here
  | "ambiguous"; // no tombstone-honest evidence either way → propose only

export interface DriftClassification {
  driver: DriftDriver;
  /** The healing action implied by the driver + the safety asymmetry. */
  resolution: "revert-location" | "heal-metadata" | "propose";
  /** Human-readable evidence trail (for the plan/audit lines). */
  evidence: string;
}

/**
 * Read the committed-at-HEAD declared lifecycle of a project's project.toml.
 * Tier-1 evidence: iCloud cannot author a commit. Returns:
 *   - the committed DeclaredLifecycle (or "active" when the committed toml has
 *     no lifecycle key — absent ⇒ active),
 *   - null when there is no git/HEAD evidence (untracked, not a repo, no HEAD).
 */
export function committedLifecycle(projectRoot: string): DeclaredLifecycle | null {
  if (!isGitRepo(projectRoot)) return null;
  const text = gitShowAtHead(projectRoot, path.join("_project", "project.toml"));
  if (text === null) return null; // untracked or no HEAD
  // minimal TOML scan for `lifecycle = "..."` — we only need this one key, and
  // we must not depend on the committed file being whole-document parseable.
  const m = /^\s*lifecycle\s*=\s*["']([a-z]+)["']/m.exec(text);
  const v = m?.[1];
  if (v === "active" || v === "dormant" || v === "archived") return v;
  return "active"; // committed toml exists but declares no lifecycle ⇒ active
}

/**
 * Classify a project's location/metadata drift into a healing decision
 * (decision-2 §4). `declared` is the effective declared lifecycle; `located`
 * is the location-derived lifecycle; they are known to disagree.
 */
export function classifyDrift(
  projectRoot: string,
  declared: DeclaredLifecycle,
  located: Lifecycle,
  store: MachineStore,
  uid: string,
): DriftClassification {
  // Tier 1 — committed git (tombstone-honest where present).
  const committed = committedLifecycle(projectRoot);
  if (committed !== null) {
    if (locationOfDeclared(committed) === located) {
      // committed metadata MATCHES the location → the human moved AND committed
      // the toml; the in-tree declared value is the stale one → heal metadata.
      return {
        driver: "git-drag",
        resolution: "heal-metadata",
        evidence: `committed project.toml lifecycle=${committed} matches location ${located} — human move (heal declared forward)`,
      };
    }
    // committed metadata disagrees with location → location is the forgery.
    return {
      driver: "git-glitch",
      resolution: "revert-location",
      evidence: `committed project.toml lifecycle=${committed} ≠ location ${located} — location is forged (iCloud); revert`,
    };
  }

  // Tier 2 — machine-local intent-log (the common non-git case).
  // An intent is live glitch-EVIDENCE only until its convergence was observed:
  // an intent at-or-before this uid's retirement high-water has been consumed
  // and carries NO evidence. This is what stops reconcile fighting a human who
  // re-activated a once-converged project by a silent Finder drag weeks later
  // (the dormant intent is long retired → fall through to ambiguous/propose),
  // while a FRESH glitch (no convergence ever observed → intent un-retired)
  // still auto-heals.
  const intent = lastLifecycleIntent(store, uid);
  const retiredThrough = lastRetired(store, uid);
  const intentIsLive = intent !== null && (retiredThrough === null || intent.at > retiredThrough);
  if (intent !== null && intentIsLive) {
    const intentLocated = locationOfDeclared(intent.to as DeclaredLifecycle);
    if (intentLocated === located) {
      // the last local intent points at the OBSERVED location → the human ran
      // the command on this machine and dragged/moved → heal metadata forward.
      return {
        driver: "intent-drag",
        resolution: "heal-metadata",
        evidence: `local intent to=${intent.to} (${intent.at}) matches location ${located} — human act on this machine`,
      };
    }
    if (locationOfDeclared(intent.to as DeclaredLifecycle) === locationOfDeclared(declared)) {
      // the last local intent matches the METADATA, nothing points at the
      // location → the folder moved with no local intent → glitch → revert.
      return {
        driver: "intent-glitch",
        resolution: "revert-location",
        evidence: `local intent to=${intent.to} matches metadata ${declared}, none for location ${located} — glitch; revert`,
      };
    }
  }

  // Tier 3 — irreducible: silent Finder-drag, no command, no local intent.
  // Byte-identical to a glitch; any automated choice is a coin flip and the
  // dangerous failure is fighting the user. Propose, never act.
  return {
    driver: "ambiguous",
    resolution: "propose",
    evidence: `no tombstone-honest evidence (not a tracked git repo; no local intent for ${uid}) — cannot tell drag from glitch`,
  };
}

// ---------------------------------------------------------------------------
// Record healing (retention-axis: dedup + ghost-dir cleanup, NOT field-truth)
// ---------------------------------------------------------------------------

const RECORD_PREFIXES = new Set(["task", "decision"]);

/** State-named subdir vocabulary (mirrors doctor's STATE_NAMES, minus archive). */
const STATE_NAMES = new Set([
  "todo", "doing", "waiting", "review", "done", "open", "closed", "draft",
  "accepted", "rejected", "superseded", "resolved", "dismissed", "promoted",
  "active", "blocked", "pending", "in-progress", "complete", "completed",
]);

function listDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function sha8(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 8);
}

/** The `updated:` frontmatter date of a record (content, NOT fs mtime). */
function updatedField(filePath: string): string | null {
  try {
    const rec = readRecord(filePath);
    const v = rec.data["updated"];
    return typeof v === "string" && v !== "" ? v : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Plan model
// ---------------------------------------------------------------------------

export type ReconcileActionKind =
  | "revert-location" // move a project folder back to where metadata says
  | "heal-metadata" // rewrite declared lifecycle to match a proven human move
  | "dedup-record" // archive a same-ID duplicate loser
  | "remove-ghost-dir" // delete an empty resurrected state-named subdir
  | "rehome-ghost-record" // move a record out of a state-named subdir, flat
  | "remove-ghost-dir-after"; // delete the now-empty subdir after rehoming

export interface ReconcileAction {
  kind: ReconcileActionKind;
  /** The project this action belongs to (relPath), or null at workspace scope. */
  project: string | null;
  /** Source path (absolute). */
  from: string;
  /** Target path (absolute), or null for pure metadata writes / removals. */
  to: string | null;
  /** Audit note. */
  note: string;
  /** @internal carried so apply doesn't re-derive: the project UID for cache warming. */
  uid?: string;
  /** @internal for heal-metadata: the lifecycle to declare. */
  declare?: DeclaredLifecycle;
  /** @internal for heal-metadata: project root to write the toml into. */
  projectRoot?: string;
}

export interface ReconcilePlan {
  workspaceRoot: string;
  actions: ReconcileAction[];
  /** Drift that needs a human (ambiguous) — surfaced, never auto-applied. */
  ambiguous: AmbiguousDrift[];
  /** Hard problems (e.g. conflicting record copies) — REPORT, never auto-fix. */
  errors: string[];
  /**
   * The CONVERGED-observation bookkeeping (decision-2 intent retirement): uids
   * observed with declared==located that have a local intent, mapped to the
   * latest intent ts to retire THROUGH. Computed during the pure-read scan but
   * only WRITTEN (to the machine-local retirement high-water) by applyReconcile
   * — so the dry-run stays a pure read of the tree and the store alike, and the
   * "observation" is the actual reconcile pass, not a preview.
   */
  convergedIntents: Record<string, string>;
}

export interface AmbiguousDrift {
  project: string;
  declared: DeclaredLifecycle;
  located: Lifecycle;
  evidence: string;
  /** The two commands the human picks between. */
  suggestion: string;
}

export interface ApplyResult {
  plan: ReconcilePlan;
  applied: ReconcileAction[];
  /** Actions skipped because they were not in the requested class (e.g. --auto). */
  skipped: ReconcileAction[];
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/** The destination dir for a target lifecycle (mirrors cmdLifecycle's mapping). */
function destDirFor(ws: Workspace, lifecycle: Lifecycle): string {
  if (lifecycle === "active") return ws.root;
  return path.resolve(ws.root, lifecycle === "dormant" ? ws.config.paths.dormant : ws.config.paths.archives);
}

/**
 * Build the reconcile plan for the whole workspace. Pure read — never writes.
 *
 * Per-project: classify lifecycle drift (location ≠ effective metadata) into a
 * heal action or an ambiguous report; then scan records for same-ID duplicates
 * and resurrected state-named subdirs.
 */
export function reconcilePlan(ws: Workspace, store: MachineStore): ReconcilePlan {
  const actions: ReconcileAction[] = [];
  const ambiguous: AmbiguousDrift[] = [];
  const errors: string[] = [];
  const convergedIntents: Record<string, string> = {};

  const projects = discoverProjects(ws, { all: true });
  for (const p of projects) {
    // Nested projects don't shelve (they ride their enclosing project); a
    // linked git worktree's location is never a lifecycle signal — never move
    // a worktree. Both are skipped for the lifecycle axis.
    const skipLifecycle = p.nestedUnder !== null || isGitWorktree(p.root);
    if (!skipLifecycle) {
      planLifecycleDrift(ws, store, p, actions, ambiguous, convergedIntents);
    }
    // Record healing always runs (it's location-as-state too, but per-record).
    planRecordHealing(ws, p, actions, errors);
  }

  // A planned revert-location OR dedup/rehome target that collides with another
  // planned action's `to` would make apply throw MID-STREAM (moveDir refuses to
  // overwrite), leaving a half-applied state. Validate the plan up front: any
  // duplicate destination is escalated to a hard error so the run exits 2 with
  // NOTHING applied (the §11 git-friendly / dry-run-validated-first posture).
  detectDestinationCollisions(actions, errors);

  return { workspaceRoot: ws.root, actions, ambiguous, errors, convergedIntents };
}

/**
 * Escalate any duplicate destination `to` path across all planned actions to a
 * plan error. Two actions resolving to the same target (e.g. a flat same-id
 * duplicate and a ghost-dir same-id duplicate sharing a basename → the same
 * reconcileArchiveDir target; or two reverts landing the same basename in a
 * shelf) cannot BOTH apply: moveDir refuses to overwrite and would throw after
 * the first already moved. Reporting it as an error means the whole run is
 * validated before any mutation, never half-applied.
 */
function detectDestinationCollisions(actions: ReconcileAction[], errors: string[]): void {
  const byDest = new Map<string, ReconcileAction[]>();
  for (const a of actions) {
    if (a.to === null) continue;
    const key = path.resolve(a.to);
    const list = byDest.get(key);
    if (list === undefined) byDest.set(key, [a]);
    else list.push(a);
  }
  for (const [dest, group] of byDest) {
    if (group.length < 2) continue;
    errors.push(
      `colliding reconcile target ${dest}: ${group.length} actions resolve to the same destination ` +
        `(${group.map((g) => `${g.kind} from ${path.basename(g.from)}`).join(", ")}) — ` +
        `refusing to apply ANY of them (would throw mid-stream and half-apply); resolve by hand`,
    );
  }
}

function planLifecycleDrift(
  ws: Workspace,
  store: MachineStore,
  p: ProjectInfo,
  actions: ReconcileAction[],
  ambiguous: AmbiguousDrift[],
  convergedIntents: Record<string, string>,
): void {
  const declared = p.effectiveLifecycle;
  const located = p.lifecycle;
  if (locationOfDeclared(declared) === located) {
    // CONVERGED: declared agrees with location. If a local intent exists for
    // this uid, its convergence is now observed — record it so applyReconcile
    // can retire intents through the latest intent ts. (Retirement is the live
    // bookkeeping that later distinguishes a stale human drag, which finds the
    // intent retired → propose-only, from a fresh glitch, which does not.)
    const intent = lastLifecycleIntent(store, p.uid);
    if (intent !== null) convergedIntents[p.uid] = intent.at;
    return; // aligned
  }

  const cls = classifyDrift(p.root, declared, located, store, p.uid);

  if (cls.resolution === "revert-location") {
    const targetDir = destDirFor(ws, locationOfDeclared(declared));
    const target = path.join(targetDir, path.basename(p.root));
    actions.push({
      kind: "revert-location",
      project: p.relPath,
      from: p.root,
      to: target,
      note: `${located} → ${declared} (metadata wins): ${cls.evidence}`,
      uid: p.uid,
    });
  } else if (cls.resolution === "heal-metadata") {
    actions.push({
      kind: "heal-metadata",
      project: p.relPath,
      from: path.join(p.root, "_project", "project.toml"),
      to: null,
      note: `declare ${located} (human move): ${cls.evidence}`,
      declare: located,
      projectRoot: p.root,
    });
  } else {
    ambiguous.push({
      project: p.relPath,
      declared,
      located,
      evidence: cls.evidence,
      suggestion:
        `If you moved it: \`projects lifecycle ${p.relPath} --to ${located}\`. ` +
        `If iCloud did: \`projects reconcile --revert ${p.relPath}\`.`,
    });
  }
}

interface RecordView {
  id: string;
  abs: string;
  name: string;
  updated: string | null;
  content: string;
}

/** Read every ID-carrying record directly in `dir` (non-recursive). */
function recordsIn(dir: string): RecordView[] {
  const out: RecordView[] = [];
  for (const ent of listDir(dir)) {
    if (!ent.isFile() || !ent.name.endsWith(".md")) continue;
    const parsed = idFromFilename(ent.name);
    if (parsed === null || !RECORD_PREFIXES.has(parsed.prefix)) continue;
    const abs = path.join(dir, ent.name);
    let content = "";
    try {
      content = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    out.push({
      id: formatId(parsed.prefix, parsed.parts, parsed.machineSuffix),
      abs,
      name: ent.name,
      updated: updatedField(abs),
      content,
    });
  }
  return out;
}

/** Reconcile-archive dir for a project, stamped per run for reversibility. */
function reconcileArchiveDir(projectRoot: string, stamp: string): string {
  return path.join(projectRoot, "_project", "archive", "reconcile", stamp);
}

/**
 * A dedup loser's archive target. Flat losers land directly under
 * `<stamp>/<primitive>/`; losers rescued out of a state-named GHOST DIR are
 * filed under `<stamp>/<primitive>/<ghost>/` so a flat duplicate and a ghost-dir
 * duplicate that share the same basename never resolve to the SAME destination
 * (which would make the second moveDir throw mid-apply and half-apply the run).
 * `ghost === null` ⇒ the flat home, preserving the original (un-nested) layout.
 */
function dedupArchiveTarget(
  projectRoot: string,
  stamp: string,
  primitive: string,
  loserName: string,
  ghost: string | null,
): string {
  const base = path.join(reconcileArchiveDir(projectRoot, stamp), primitive);
  return ghost === null ? path.join(base, loserName) : path.join(base, ghost, loserName);
}

function planRecordHealing(
  ws: Workspace,
  p: ProjectInfo,
  actions: ReconcileAction[],
  errors: string[],
): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const projectDir = path.join(p.root, "_project");

  // --- (a) same-ID duplicates in the flat record dirs (the iCloud-copy shape) ---
  // "task-50 - x.md" + "task-50 - x 2.md": group by parsed id, keep the winner
  // (git-tracked beats untracked is approximated by newest `updated:` — content,
  // not mtime, since iCloud scrambles mtime), archive the losers reversibly.
  for (const primitive of ["tasks", "decisions"]) {
    const dir = path.join(projectDir, primitive);
    const byId = new Map<string, RecordView[]>();
    for (const r of recordsIn(dir)) {
      const list = byId.get(r.id);
      if (list === undefined) byId.set(r.id, [r]);
      else list.push(r);
    }
    for (const [id, group] of byId) {
      if (group.length < 2) continue;
      // content-identical duplicates: keep one, archive the rest (cosmetic).
      const distinctContent = new Set(group.map((g) => g.content));
      if (distinctContent.size > 1) {
        // differing copies — NEVER auto-merge. Keep newest `updated:`, mark the
        // others as conflicts for human review (mirrors the project-UID posture).
        errors.push(
          `${p.relPath}: same-ID record ${id} has ${distinctContent.size} DIFFERING copies ` +
            `(${group.map((g) => path.basename(g.abs)).join(", ")}) — content differs; resolve by hand, never auto-merge`,
        );
        continue;
      }
      // identical content: deterministic winner = the shortest filename (the
      // un-suffixed original "x.md" over "x 2.md"); ties broken lexically.
      const sorted = [...group].sort(
        (a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name),
      );
      const losers = sorted.slice(1);
      for (const loser of losers) {
        const target = dedupArchiveTarget(p.root, stamp, primitive, loser.name, null);
        actions.push({
          kind: "dedup-record",
          project: p.relPath,
          from: loser.abs,
          to: target,
          note: `same-ID duplicate of ${id} (identical content) — archived (reversible) to _project/archive/reconcile/`,
        });
      }
    }
  }

  // --- (b) resurrected state-named subdirs (the ghost-dir shape) ---
  // tasks/todo/, decisions/accepted/ … : the dir NAME is redundant (status:
  // frontmatter carries the real state). Empty → remove; with records → rehome
  // flat (dedup-by-id against the parent) then remove. archive/ is whitelisted.
  for (const primitive of ["tasks", "decisions"]) {
    const dir = path.join(projectDir, primitive);
    const parentIds = new Set(recordsIn(dir).map((r) => r.id));
    for (const ent of listDir(dir)) {
      if (!ent.isDirectory() || ent.name === "archive") continue;
      if (!STATE_NAMES.has(ent.name.toLowerCase())) continue; // only state-named ghosts
      const ghostDir = path.join(dir, ent.name);
      const ghostRecords = recordsIn(ghostDir);
      const otherEntries = listDir(ghostDir).filter(
        (e) => !(e.isFile() && e.name.endsWith(".md") && idFromFilename(e.name) !== null),
      );
      if (ghostRecords.length === 0 && otherEntries.length === 0) {
        actions.push({
          kind: "remove-ghost-dir",
          project: p.relPath,
          from: ghostDir,
          to: null,
          note: `empty resurrected state-named subdir ${primitive}/${ent.name}/ — removed (state lives in frontmatter)`,
        });
        continue;
      }
      // non-empty: rehome each record flat unless it collides with the parent.
      let rehomedAll = true;
      for (const r of ghostRecords) {
        if (parentIds.has(r.id)) {
          // a same-ID record already sits flat — same content ⇒ this ghost copy
          // is a redundant dedup loser; differing ⇒ conflict (report).
          const flat = recordsIn(dir).find((x) => x.id === r.id);
          if (flat !== undefined && flat.content === r.content) {
            const target = dedupArchiveTarget(p.root, stamp, primitive, r.name, ent.name);
            actions.push({
              kind: "dedup-record",
              project: p.relPath,
              from: r.abs,
              to: target,
              note: `ghost ${primitive}/${ent.name}/${r.name} duplicates flat ${r.id} (identical) — archived (reversible) under ${ent.name}/`,
            });
          } else {
            errors.push(
              `${p.relPath}: ghost record ${primitive}/${ent.name}/${r.name} collides with flat ${r.id} ` +
                `but content differs — resolve by hand, never auto-merge`,
            );
            rehomedAll = false;
          }
          continue;
        }
        const target = path.join(dir, r.name);
        actions.push({
          kind: "rehome-ghost-record",
          project: p.relPath,
          from: r.abs,
          to: target,
          note: `rehome ${primitive}/${ent.name}/${r.name} flat — the dir name is redundant (status: in frontmatter)`,
        });
      }
      if (rehomedAll && otherEntries.length === 0) {
        actions.push({
          kind: "remove-ghost-dir-after",
          project: p.relPath,
          from: ghostDir,
          to: null,
          note: `remove now-empty state-named subdir ${primitive}/${ent.name}/ after rehoming`,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface RenderOptions {
  mode?: "dry-run" | "apply" | "auto";
}

/** Per-action audit lines (the dry-run output; apply prints the same plan). */
export function renderPlan(plan: ReconcilePlan, options: RenderOptions = {}): string[] {
  const mode = options.mode ?? "dry-run";
  const lines: string[] = [`reconcile (${mode}): ${plan.workspaceRoot}`];
  if (plan.actions.length === 0 && plan.ambiguous.length === 0 && plan.errors.length === 0) {
    lines.push("  no drift — location and metadata agree");
    return lines;
  }
  for (const a of plan.actions) {
    const arrow = a.to !== null ? ` → ${a.to}` : "";
    lines.push(`  ${a.kind.padEnd(22)} ${a.from}${arrow}  [${a.note}]`);
  }
  for (const amb of plan.ambiguous) {
    lines.push(
      `  ambiguous              ${amb.project}: metadata=${amb.declared} location=${amb.located}  [${amb.evidence}]`,
    );
    lines.push(`      ↳ ${amb.suggestion}`);
  }
  for (const e of plan.errors) lines.push(`  error: ${e}`);
  lines.push(
    `summary: ${plan.actions.length} action(s), ${plan.ambiguous.length} ambiguous (propose-only), ${plan.errors.length} error(s)`,
  );
  return lines;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * The AUTO-SAFE action classes — the only ones the Mini's
 * `reconcile --apply --auto` step executes unsupervised. Glitch-reverts
 * (backed by git/intent), empty-ghost removal, and git/identical dedup are
 * here; `heal-metadata` (adopting a location into metadata) is NOT — adopting
 * needs git-proof or a human flag (the §4 safety asymmetry: undo glitches,
 * never silently overrule a human).
 */
const AUTO_SAFE = new Set<ReconcileActionKind>([
  "revert-location",
  "dedup-record",
  "remove-ghost-dir",
  "rehome-ghost-record",
  "remove-ghost-dir-after",
]);

export interface ApplyOptions {
  /** Restrict to the auto-safe class (the Mini's mode). Default false. */
  auto?: boolean;
}

function moveDir(from: string, to: string): void {
  if (fs.existsSync(to)) {
    throw new Error(`reconcile: target already exists, refusing to overwrite: ${to}`);
  }
  ensureDir(path.dirname(to));
  fs.renameSync(from, to);
}

/**
 * Execute the plan. Ambiguous drift is NEVER applied (it's not in `actions`).
 * `--auto` further restricts to the glitch-certain class. Records the same
 * intent-log line a real lifecycle command would for any heal-metadata, so a
 * later pass on the same machine sees the heal as a human act, not new drift.
 */
export function applyReconcile(
  plan: ReconcilePlan,
  store: MachineStore,
  options: ApplyOptions = {},
): ApplyResult {
  const auto = options.auto === true;
  const applied: ReconcileAction[] = [];
  const skipped: ReconcileAction[] = [];
  const now = new Date().toISOString();
  const machine = machineId(store);

  // SAFETY GUARANTEE (BUG 2): a plan with hard errors — including a detected
  // colliding-destination — is applied as a WHOLE-PLAN REFUSAL: zero tree
  // mutations. This is what makes "the plan is validated before any mutation"
  // real at the library level (the CLI also exits 2). Without it, two actions
  // resolving to the same `to` would let the second moveDir throw AFTER the
  // first already moved — a half-applied state. Convergence retirement below is
  // pure machine-local bookkeeping (no tree mutation) and is harmless to skip
  // here too, so we return before it.
  if (plan.errors.length > 0) {
    return { plan, applied, skipped: [...plan.actions] };
  }

  // CONVERGED-observation retirement (decision-2): this apply pass IS the
  // observation that a uid's declared==located. Retire each converged uid's
  // intents through the latest intent ts, so a LATER human drag of a project
  // whose convergence we already saw finds its intent retired → propose-only
  // (reconcile won't fight the human). Done first and unconditionally (even in
  // --auto, even when there are no actions): retirement is the whole point of
  // running a no-op converged pass. Pure bookkeeping in the machine-local store.
  for (const [uid, throughTs] of Object.entries(plan.convergedIntents)) {
    retireLifecycleIntents(store, uid, throughTs);
  }

  for (const a of plan.actions) {
    if (auto && !AUTO_SAFE.has(a.kind)) {
      skipped.push(a);
      continue;
    }
    switch (a.kind) {
      case "revert-location": {
        if (a.to === null) break;
        moveDir(a.from, a.to);
        if (a.uid !== undefined) writeUidCacheEntry(store, a.uid, a.to);
        break;
      }
      case "heal-metadata": {
        if (a.declare === undefined || a.projectRoot === undefined) break;
        writeDeclaredLifecycle(a.projectRoot, a.declare, now);
        // Record the heal as a local intent so a re-run doesn't re-detect drift
        // (the declared value now matches the location, but logging keeps the
        // tiebreaker coherent across machines that later sync this content).
        const uid = a.uid;
        if (uid !== undefined) appendLifecycleIntent(store, { uid, to: a.declare, at: now, machine });
        break;
      }
      case "dedup-record":
      case "rehome-ghost-record": {
        if (a.to === null) break;
        moveDir(a.from, a.to);
        break;
      }
      case "remove-ghost-dir":
      case "remove-ghost-dir-after": {
        try {
          fs.rmdirSync(a.from);
        } catch (err) {
          // a non-empty dir here means a concurrent writer landed a record —
          // leave it; the next pass re-plans.
          if ((err as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw err;
        }
        break;
      }
    }
    applied.push(a);
  }
  return { plan, applied, skipped };
}

// ---------------------------------------------------------------------------
// Single-project human-confirmed operations (--revert / --adopt-location)
// ---------------------------------------------------------------------------

export interface ConfirmResult {
  uid: string;
  from: Lifecycle;
  to: DeclaredLifecycle;
  movedTo: string | null;
}

/**
 * Human confirms a drift is a GLITCH → move the folder back to where metadata
 * says (`--revert <ref>`). The metadata is authoritative; we realign location.
 */
export function revertLocation(
  ws: Workspace,
  store: MachineStore,
  projectRoot: string,
  uid: string,
  declared: DeclaredLifecycle,
): ConfirmResult {
  const located = lifecycleOf(ws, projectRoot);
  const targetLifecycle = locationOfDeclared(declared);
  if (located === targetLifecycle) {
    return { uid, from: located, to: declared, movedTo: null }; // already aligned
  }
  const target = path.join(destDirFor(ws, targetLifecycle), path.basename(projectRoot));
  moveDir(projectRoot, target);
  writeUidCacheEntry(store, uid, target);
  return { uid, from: located, to: declared, movedTo: target };
}

/**
 * Human confirms a drift is a real DRAG → write declared = location and log a
 * local intent (`--adopt-location <ref>`). This is the gated metadata-adoption
 * the auto path refuses to do without proof.
 */
export function adoptLocation(
  ws: Workspace,
  store: MachineStore,
  projectRoot: string,
  uid: string,
): ConfirmResult {
  const located = lifecycleOf(ws, projectRoot);
  const now = new Date().toISOString();
  writeDeclaredLifecycle(projectRoot, located, now);
  appendLifecycleIntent(store, { uid, to: located, at: now, machine: machineId(store) });
  return { uid, from: located, to: located, movedTo: null };
}
