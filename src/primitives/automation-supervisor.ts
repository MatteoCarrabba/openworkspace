/**
 * Automation Runtime v2 supervisor tick.
 *
 * Short-lived and local-first: read machine-local activation records and the
 * bounded run-ledger state pointer, then recover only facts this machine owns.
 * Synced registry writes are best-effort mirrors, never the source of truth.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { recordRegistryRunOutcome } from "../init.js";
import { writeFileAtomic } from "../lib/fsatomic.js";
import {
  MachineStore,
  machineId,
  readRunnerNode,
} from "../lib/machine.js";
import {
  ActivationRecord,
  LaunchdAdapter,
  readActivationRecords,
} from "./automations.js";
import {
  AutomationAttempt,
  ComputedRunState,
  computeRunHealth,
  computeRunState,
  finishAttempt,
  readAttempt,
  readRunState,
  releaseLease,
} from "./automation-runs.js";

export type SupervisorFindingKind =
  | "direct-exec-unobservable"
  | "no-current-run"
  | "attempt-missing"
  | "active-run"
  | "overdue-run"
  | "abandoned-run";

export interface SupervisorFinding {
  kind: SupervisorFindingKind;
  project_uid: string;
  name: string;
  machine: string;
  run_id: string | null;
  state: ComputedRunState | null;
  detail: string;
}

export interface SupervisorSummary {
  machine: string;
  checked: number;
  abandoned: number;
  findings: SupervisorFinding[];
}

export interface SupervisorOptions {
  store: MachineStore;
  now?: Date;
  processAlive?: (pid: number) => boolean;
  publishRegistry?: boolean;
}

export const SUPERVISOR_LABEL = "com.openworkspace.supervisor";
export const DEFAULT_SUPERVISOR_INTERVAL_SECONDS = 300;

export interface SupervisorLaunchContext {
  store: MachineStore;
  launchd: LaunchdAdapter;
  nodePath?: string;
  cliPath?: string;
  intervalSeconds?: number;
}

export interface SupervisorApplyResult {
  action: "installed" | "regenerated" | "unchanged";
  label: string;
  plistPath: string;
  intervalSeconds: number;
  warnings: string[];
}

export interface SupervisorDeactivateResult {
  label: string;
  removedPlist: boolean;
  wasLoaded: boolean;
}

export interface SupervisorInstallStatus {
  label: string;
  plistPath: string;
  installed: boolean;
  loaded: boolean;
}

function isoStamp(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function xmlEscape(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function defaultSupervisorCliPath(): string {
  return path.resolve(__dirname, "..", "cli.js");
}

function supervisorNodePath(ctx: SupervisorLaunchContext): { path: string; fallback: boolean } {
  const configured = ctx.nodePath ?? readRunnerNode(ctx.store);
  if (configured !== null && configured !== undefined) return { path: configured, fallback: false };
  return { path: process.execPath, fallback: true };
}

export function supervisorPlistPath(ctx: SupervisorLaunchContext): string {
  return path.join(ctx.launchd.agentsDir, `${SUPERVISOR_LABEL}.plist`);
}

export function generateSupervisorPlist(ctx: SupervisorLaunchContext): string {
  const interval = ctx.intervalSeconds ?? DEFAULT_SUPERVISOR_INTERVAL_SECONDS;
  const node = supervisorNodePath(ctx).path;
  const cliPath = ctx.cliPath ?? defaultSupervisorCliPath();
  const args = [node, cliPath, "automation", "supervise"];
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `\t<key>Label</key><string>${SUPERVISOR_LABEL}</string>`,
    `\t<key>ProgramArguments</key>`,
    `\t<array>`,
    ...args.map((arg) => `\t\t<string>${xmlEscape(arg)}</string>`),
    `\t</array>`,
    `\t<key>RunAtLoad</key><true/>`,
    `\t<key>StartInterval</key><integer>${interval}</integer>`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
}

function runnerNodeFallbackWarning(nodePath: string): string {
  return (
    `no runner-node configured on this machine — the supervisor plist invokes the node that ran apply ` +
    `(${nodePath}); set a durable runner node with \`projects home runner-node <path>\` and re-apply the supervisor`
  );
}

export function applySupervisor(ctx: SupervisorLaunchContext): SupervisorApplyResult {
  const plistPath = supervisorPlistPath(ctx);
  const content = generateSupervisorPlist(ctx);
  const loaded = ctx.launchd.loadedLabels().includes(SUPERVISOR_LABEL);
  const existing = fs.existsSync(plistPath) ? fs.readFileSync(plistPath, "utf8") : null;
  const warnings: string[] = [];
  const node = supervisorNodePath(ctx);
  if (node.fallback) warnings.push(runnerNodeFallbackWarning(node.path));
  if (existing === content && loaded) {
    return {
      action: "unchanged",
      label: SUPERVISOR_LABEL,
      plistPath,
      intervalSeconds: ctx.intervalSeconds ?? DEFAULT_SUPERVISOR_INTERVAL_SECONDS,
      warnings,
    };
  }
  if (loaded) ctx.launchd.unload(plistPath, SUPERVISOR_LABEL);
  writeFileAtomic(plistPath, content);
  ctx.launchd.load(plistPath, SUPERVISOR_LABEL);
  return {
    action: existing === null ? "installed" : "regenerated",
    label: SUPERVISOR_LABEL,
    plistPath,
    intervalSeconds: ctx.intervalSeconds ?? DEFAULT_SUPERVISOR_INTERVAL_SECONDS,
    warnings,
  };
}

export function deactivateSupervisor(ctx: SupervisorLaunchContext): SupervisorDeactivateResult {
  const plistPath = supervisorPlistPath(ctx);
  const loaded = ctx.launchd.loadedLabels().includes(SUPERVISOR_LABEL);
  if (loaded) ctx.launchd.unload(plistPath, SUPERVISOR_LABEL);
  let removedPlist = false;
  try {
    fs.unlinkSync(plistPath);
    removedPlist = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return { label: SUPERVISOR_LABEL, removedPlist, wasLoaded: loaded };
}

export function supervisorInstallStatus(ctx: SupervisorLaunchContext): SupervisorInstallStatus {
  const plistPath = supervisorPlistPath(ctx);
  return {
    label: SUPERVISOR_LABEL,
    plistPath,
    installed: fs.existsSync(plistPath),
    loaded: ctx.launchd.loadedLabels().includes(SUPERVISOR_LABEL),
  };
}

function startedAt(attempt: AutomationAttempt): string {
  return attempt.started_at ?? attempt.created_at;
}

function registryLogPath(attempt: AutomationAttempt): string | undefined {
  const published = attempt.logs?.published_path;
  return typeof published === "string" && published !== "" ? published : undefined;
}

function finding(
  kind: SupervisorFindingKind,
  record: ActivationRecord,
  machine: string,
  runId: string | null,
  state: ComputedRunState | null,
  detail: string,
): SupervisorFinding {
  return {
    kind,
    project_uid: record.project_uid,
    name: record.name,
    machine,
    run_id: runId,
    state,
    detail,
  };
}

export function superviseLocalAutomations(options: SupervisorOptions): SupervisorSummary {
  const now = options.now ?? new Date();
  const processAlive = options.processAlive ?? defaultProcessAlive;
  const publishRegistry = options.publishRegistry ?? true;
  const machine = machineId(options.store);
  const findings: SupervisorFinding[] = [];
  let abandoned = 0;

  for (const { record } of readActivationRecords(options.store)) {
    if (record.direct_exec) {
      findings.push(
        finding(
          "direct-exec-unobservable",
          record,
          machine,
          null,
          "unobservable-direct-exec",
          "direct_exec automation bypasses the managed runner and has no local run ledger",
        ),
      );
      continue;
    }

    const state = readRunState(options.store, record.project_uid, record.name);
    const runId = state?.current_run_id ?? null;
    if (runId === null) {
      findings.push(
        finding(
          "no-current-run",
          record,
          machine,
          state?.latest_run_id ?? null,
          state === null ? null : "unknown",
          "no active local run recorded",
        ),
      );
      continue;
    }

    const attempt = readAttempt(options.store, record.project_uid, record.name, runId);
    if (attempt === null) {
      findings.push(
        finding(
          "attempt-missing",
          record,
          machine,
          runId,
          "unknown",
          "state.toml points at an attempt file that is missing",
        ),
      );
      continue;
    }

    const computed = computeRunState(attempt, now, processAlive);
    if (computed === "running") {
      findings.push(finding("active-run", record, machine, runId, computed, "run owner is still active"));
      continue;
    }
    if (computed === "overdue") {
      findings.push(finding("overdue-run", record, machine, runId, computed, "run exceeded its deadline"));
      continue;
    }
    if (computed !== "stuck") {
      findings.push(
        finding(
          "no-current-run",
          record,
          machine,
          runId,
          computed,
          `current run is already ${computed} (${computeRunHealth(computed)})`,
        ),
      );
      continue;
    }

    const finished = isoStamp(now);
    const reason = "managed runner owner is dead or stale; supervisor marked the attempt abandoned";
    finishAttempt({
      store: options.store,
      uid: record.project_uid,
      name: record.name,
      runId,
      status: "abandoned",
      now,
      reason,
      outcome: { reason },
      logs: { publish_status: registryLogPath(attempt) === undefined ? "skipped" : "published" },
    });
    const leaseToken = attempt.owner?.lease_token;
    if (typeof leaseToken === "string" && leaseToken !== "") {
      releaseLease({ store: options.store, uid: record.project_uid, name: record.name, token: leaseToken });
    }
    if (publishRegistry && record.workspace_root !== null) {
      recordRegistryRunOutcome(
        record.workspace_root,
        machine,
        {
          project_uid: record.project_uid,
          name: record.name,
          run_id: runId,
          started_at: startedAt(attempt),
          finished_at: finished,
          status: "abandoned",
          ...(registryLogPath(attempt) !== undefined ? { log: registryLogPath(attempt) } : {}),
        },
        now,
      );
    }
    abandoned += 1;
    findings.push(finding("abandoned-run", record, machine, runId, "stuck", reason));
  }

  return {
    machine,
    checked: findings.length,
    abandoned,
    findings,
  };
}
