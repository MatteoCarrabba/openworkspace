#!/usr/bin/env node
/**
 * The automation runner — the fire-time half of late binding (PRD §7.1).
 *
 * The LaunchAgent plist hands this process ONLY a project UID + automation
 * name. At fire time the runner:
 *   1. resolves UID → canonical project path (machine-local cache → bounded
 *      rescan of known workspaces; loud ResolveError when orphaned),
 *   2. loads + validates the manifest from the live tree (logic edits need
 *      no re-apply — the tree is read fresh on every run),
 *   3. honors on_dormant_project (movement signals lifecycle, extended into
 *      the automation layer),
 *   4. resolves [secrets] pointers through the workspace-configured scheme
 *      resolvers (§7.5) — resolver stdout becomes an ENV value for the child;
 *      nothing is ever written to disk,
 *   5. runs the command with cwd = the canonical project root,
 *   6. writes the machine-partitioned log
 *      (_project/automations/<name>/logs/<machine>/<stamp>.log) + retention,
 *   7. appends the outcome to THIS machine's synced registry file (P15).
 *
 * §7.4 TCC seam (deferred spike): the exec path is isolated in `execute()`.
 * The spike will decide whether TCC/FDA attribution survives this runner
 * spawning (or exec'ing) the program; until then `direct_exec = true` in the
 * manifest bypasses the runner entirely (the plist's ProgramArguments is the
 * command itself — generatePlist in primitives/automations.ts) as the
 * documented baked-path fallback. No real TCC work is attempted here.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";

import { recordRegistryRunOutcome } from "./init.js";
import { ConfigError, OwError } from "./lib/errors.js";
import { ensureDir, writeFileAtomic } from "./lib/fsatomic.js";
import { MachineStore, machineId, openMachineStore } from "./lib/machine.js";
import { findWorkspaceRoot, lifecycleOf, loadWorkspaceConfig } from "./lib/workspace.js";
import {
  AutomationManifest,
  loadManifest,
  resolveUidToCanonical,
} from "./primitives/automations.js";

/** Logs kept per machine per automation; older ones are reaped after a run. */
export const LOG_RETENTION = 20;

export type RunStatus = "ok" | "failed" | "skipped-dormant" | "error";

export interface RunOutcome {
  uid: string;
  name: string;
  machine: string;
  status: RunStatus;
  exitCode: number | null;
  logPath: string | null;
  startedAt: string;
  finishedAt: string;
}

export interface RunnerOptions {
  uid: string;
  name: string;
  store: MachineStore;
  /** Base environment for resolvers and the child; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  extraWorkspaceRoots?: string[];
}

function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function iso(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Resolve one secret pointer through its scheme's resolver command (§7.5).
 * The resolver template is whitespace-split into argv tokens; `{ref}` is
 * substituted per-token AFTER the split, so a ref containing spaces stays a
 * single argument. The resolved value exists only in this process's memory
 * and the child's environment — never on disk, never in a log.
 */
function resolveSecret(
  key: string,
  pointer: string,
  resolvers: Record<string, string>,
  env: NodeJS.ProcessEnv,
): string {
  const m = /^([a-z][a-z0-9+.-]*):\/\//.exec(pointer);
  if (m === null) {
    throw new ConfigError(`[secrets] ${key}: not a <scheme>://<ref> pointer (${pointer})`);
  }
  const scheme = m[1] as string;
  const template = resolvers[scheme];
  if (template === undefined) {
    throw new ConfigError(
      `[secrets] ${key}: no resolver for scheme "${scheme}" — map it in ` +
        `.openworkspace/config.toml [secrets.resolvers]`,
    );
  }
  const tokens = template
    .trim()
    .split(/\s+/)
    .map((t) => t.replaceAll("{ref}", pointer));
  const cmd = tokens[0];
  if (cmd === undefined) throw new ConfigError(`[secrets] ${key}: empty resolver command for scheme "${scheme}"`);
  const result = spawnSync(cmd, tokens.slice(1), { encoding: "utf8", env });
  if (result.error !== undefined) {
    throw new ConfigError(`[secrets] ${key}: resolver failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new ConfigError(
      `[secrets] ${key}: resolver exited ${result.status ?? "by signal"}: ${result.stderr.trim()}`,
    );
  }
  return result.stdout.replace(/\n+$/, "");
}

/** Own-machine log retention: keep the newest LOG_RETENTION .log files. */
export function applyLogRetention(machineLogDir: string, keep = LOG_RETENTION): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(machineLogDir).filter((f) => f.endsWith(".log"));
  } catch {
    return [];
  }
  names.sort(); // UTC-stamp filenames: lexical = chronological
  const removed: string[] = [];
  for (const name of names.slice(0, Math.max(0, names.length - keep))) {
    fs.unlinkSync(path.join(machineLogDir, name));
    removed.push(name);
  }
  return removed;
}

/**
 * §7.4 seam: the one place a program is executed on the runner path. The TCC
 * spike swaps the strategy here (spawn vs exec vs FDA-granted runner) without
 * touching resolution, logging, or registry bookkeeping.
 */
function execute(
  manifest: AutomationManifest,
  cwd: string,
  env: NodeJS.ProcessEnv,
): { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean } {
  const [cmd, ...args] = manifest.run.command;
  const result = spawnSync(cmd as string, args, {
    cwd,
    env,
    encoding: "utf8",
    ...(manifest.run.timeoutSeconds !== null ? { timeout: manifest.run.timeoutSeconds * 1000 } : {}),
    // SIGKILL, not SIGTERM: the timeout is a last-resort runaway killer, and our
    // canonical leaf (`claude --print`) ignores SIGTERM — with SIGTERM the timeout
    // fires but the child survives and spawnSync blocks forever on the open pipe
    // (observed: a briefing-cycle run hung ~13h past its 30-min timeout, silently
    // blocking every subsequent hourly fire). SIGKILL cannot be caught or ignored.
    killSignal: "SIGKILL",
  });
  if (result.error !== undefined && (result.error as NodeJS.ErrnoException).code !== "ETIMEDOUT") {
    throw new ConfigError(`failed to start ${manifest.run.command[0] ?? "?"}: ${result.error.message}`);
  }
  return {
    exitCode: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    timedOut: result.error !== undefined,
  };
}

/** Run one automation end to end. Also the `run-now` code path (PRD §7.1). */
export function runAutomation(options: RunnerOptions): RunOutcome {
  const { uid, name, store } = options;
  const env = options.env ?? process.env;
  const nowFn = options.now ?? (() => new Date());
  const started = nowFn();
  const machine = machineId(store);

  // 1. UID → canonical (loud ResolveError, exit 2 — never a guess)
  const canonicalRoot = resolveUidToCanonical(uid, store, options.extraWorkspaceRoots ?? []);

  const workspaceRoot = findWorkspaceRoot(canonicalRoot);
  const config = workspaceRoot !== null ? loadWorkspaceConfig(workspaceRoot) : null;

  const logDir = path.join(canonicalRoot, "_project", "automations", name, "logs", machine);
  const logPath = path.join(logDir, `${stamp(started)}.log`);
  // `header` must work BEFORE the manifest loads: a manifest-load failure is
  // itself a logged + registry-recorded outcome (§7.1 pins the contract).
  let loadedManifest: AutomationManifest | null = null;
  const header = (status: string, extra: string[]): string =>
    [
      `# automation: ${name}`,
      `# project_uid: ${uid}`,
      `# machine: ${machine}`,
      `# started: ${iso(started)}`,
      `# command: ${loadedManifest !== null ? loadedManifest.run.command.join(" ") : "(manifest unavailable)"}`,
      ...extra,
      `# status: ${status}`,
      ``,
    ].join("\n");

  const finish = (status: RunStatus, exitCode: number | null, body: string, extra: string[] = []): RunOutcome => {
    const finished = nowFn();
    ensureDir(logDir);
    writeFileAtomic(logPath, header(status, extra) + body);
    applyLogRetention(logDir);
    if (workspaceRoot !== null) {
      recordRegistryRunOutcome(
        workspaceRoot,
        machine,
        {
          project_uid: uid,
          name,
          started_at: iso(started),
          finished_at: iso(finished),
          status,
          ...(exitCode !== null ? { exit_code: exitCode } : {}),
          log: path.relative(workspaceRoot, logPath),
        },
        finished,
      );
    }
    return {
      uid,
      name,
      machine,
      status,
      exitCode,
      logPath,
      startedAt: iso(started),
      finishedAt: iso(finished),
    };
  };

  // 2. the manifest, read fresh from the live tree. A missing/invalid
  // manifest still honors the runner's contract: the failure is written to
  // the machine-partitioned log and recorded as an error outcome in the
  // registry BEFORE the error propagates — otherwise a corrupted manifest
  // silently kills a scheduled automation behind a fresh heartbeat and a
  // registry forever showing the last successful run.
  let manifest: AutomationManifest;
  try {
    manifest = loadManifest(canonicalRoot, name);
    loadedManifest = manifest;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    finish("error", null, `manifest load failed: ${message}\n`);
    throw err;
  }

  // 3. lifecycle: a non-active project with on_dormant_project = "stop" skips
  if (workspaceRoot !== null && manifest.onDormantProject === "stop") {
    const ws = { root: workspaceRoot, config: config ?? loadWorkspaceConfig(workspaceRoot) };
    const lifecycle = lifecycleOf(ws, canonicalRoot);
    if (lifecycle !== "active") {
      return finish("skipped-dormant", null, `project is ${lifecycle}; on_dormant_project = "stop"\n`);
    }
  }

  // 4. secrets → child ENV only (§7.5); a resolution failure is logged +
  // recorded as an error outcome, then thrown (the caller maps exit codes)
  const secretEnv: Record<string, string> = {};
  try {
    for (const [key, pointer] of Object.entries(manifest.secrets)) {
      secretEnv[key] = resolveSecret(key, pointer, config?.secrets.resolvers ?? {}, env);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    finish("error", null, `secret resolution failed: ${message}\n`);
    throw err;
  }
  const secretKeys = Object.keys(secretEnv);
  const staticEnvKeys = Object.keys(manifest.run.env);

  // 5–7. execute (the §7.4 seam), log, retain, record. Child env precedence:
  // runner base env < [run] env (static, non-secret) < resolved [secrets].
  const result = execute(manifest, canonicalRoot, { ...env, ...manifest.run.env, ...secretEnv });
  const ok = result.exitCode === 0;
  const body =
    `--- stdout ---\n${result.stdout}` +
    `--- stderr ---\n${result.stderr}` +
    `--- exit: ${result.exitCode ?? "none"}${result.timedOut ? " (timed out)" : ""} ---\n`;
  return finish(ok ? "ok" : "failed", result.exitCode, body, [
    `# secrets: ${secretKeys.length > 0 ? secretKeys.join(", ") : "(none)"} (env-only, values never logged)`,
    `# env: ${staticEnvKeys.length > 0 ? staticEnvKeys.join(", ") : "(none)"} (static)`,
  ]);
}

// ---------------------------------------------------------------------------
// launchd entry point: `node dist/src/runner.js --uid <uid> --name <name>`
// ---------------------------------------------------------------------------

export function main(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: { uid: { type: "string" }, name: { type: "string" } },
    strict: true,
  });
  if (values.uid === undefined || values.name === undefined) {
    process.stderr.write("usage: runner --uid <project-uid> --name <automation>\n");
    return 1;
  }
  const store = openMachineStore(undefined, process.env);
  const outcome = runAutomation({ uid: values.uid, name: values.name, store });
  process.stdout.write(
    `${outcome.name}: ${outcome.status}` +
      `${outcome.exitCode !== null ? ` (exit ${outcome.exitCode})` : ""}` +
      `${outcome.logPath !== null ? ` — ${outcome.logPath}` : ""}\n`,
  );
  return outcome.status === "ok" || outcome.status === "skipped-dormant" ? 0 : 1;
}

if (require.main === module) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    if (err instanceof OwError) {
      process.stderr.write(`error: ${err.message}\n`);
      process.exit(err.exitCode);
    }
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
