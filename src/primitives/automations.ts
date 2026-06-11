/**
 * Automations — intent in the tree, activation machine-local (PRD §7, P14).
 *
 * The definition (`_project/automations/<name>/automation.toml` + README +
 * program) syncs and is committed; nothing runs until an explicit
 * `projects automation apply` on a declared machine compiles the cadence into
 * a LaunchAgent and records the activation in the App Support store. Syncing
 * never causes execution.
 *
 * Late binding (§7.1): the generated plist references the runner + project
 * UID + automation name — NEVER a filesystem path to the project and NEVER a
 * resolved secret. The runner (src/runner.ts) resolves UID → canonical path
 * at fire time, so project moves are transparent and logic edits need no
 * re-apply; only cadence/placement changes do.
 *
 * Cron semantics are PINNED to cron's documented behavior (§7.1): when both
 * day-of-month and day-of-week are restricted, the job fires when EITHER
 * matches (union/OR). launchd's StartCalendarInterval ANDs its keys, so the
 * compiler expresses the union as the concatenation of Day-restricted and
 * Weekday-restricted entry sets. (The v0.2 compiler implemented AND — a
 * confirmed bug; tests/automations.test.ts carries the conformance test.)
 *
 * launchctl + the LaunchAgents directory sit behind an injectable
 * LaunchdAdapter: the real implementation shells out to launchctl against
 * ~/Library/LaunchAgents; the file-backed fake (selected by the
 * OPENWORKSPACE_LAUNCHD_DIR env override) never touches launchd. Tests use
 * the fake exclusively.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { recordRegistryActivation, removeRegistryActivation } from "../init.js";
import { ConfigError, NotFoundError, ResolveError } from "../lib/errors.js";
import { ensureDir, readTextIfExists, writeFileAtomic } from "../lib/fsatomic.js";
import {
  MachineStore,
  activationRecordPath,
  activationsDir,
  machineId,
  readKnownWorkspaces,
  readRunnerNode,
  readUidCache,
  writeUidCacheEntry,
} from "../lib/machine.js";
import { isGitWorktree, resolveCanonicalProject } from "../lib/resolve.js";
import { TomlTable, readToml, readTomlIfExists, writeToml } from "../lib/toml.js";
import {
  MARKER_DIR,
  Workspace,
  findProjectByUid,
  findWorkspaceRoot,
  loadWorkspaceConfig,
  readProjectUid,
} from "../lib/workspace.js";

// ---------------------------------------------------------------------------
// Manifest schema (automation.toml) — forgiving read, strict write/apply
// ---------------------------------------------------------------------------

export type MissPolicy = "skip" | "catch-up" | "fail-loud";
export type OnDormantProject = "stop" | "continue";

/** One launchd StartCalendarInterval entry; absent key = wildcard. */
export interface CalendarEntry {
  Minute?: number;
  Hour?: number;
  Day?: number;
  Weekday?: number;
  Month?: number;
}

export interface SignatureEntry {
  name: string;
  type: string;
  /** Path relative to the WORKSPACE root for file/directory entries. */
  path: string | null;
}

export interface AutomationManifest {
  name: string;
  /** Declared placement intent (§7.1, terraform-style). */
  machines: string[];
  schedule: {
    cron: string | null;
    /** Normalized launchd entries (compiled from cron OR taken structured). */
    calendar: CalendarEntry[];
    /** Always null: `timezone` is REJECTED at validation until implemented. */
    timezone: string | null;
    /** Recorded for the supervise pass (§7.2); the runner behaves as "skip". */
    missPolicy: MissPolicy;
  };
  run: {
    command: string[];
    /** §7.4 TCC fallback: plist ProgramArguments = the command itself. */
    directExec: boolean;
    timeoutSeconds: number | null;
  };
  /** key → secret POINTER (<scheme>://<ref>); bare values never validate. */
  secrets: Record<string, string>;
  supervise: TomlTable;
  signature: { inputs: SignatureEntry[]; outputs: SignatureEntry[] };
  onDormantProject: OnDormantProject;
  raw: TomlTable;
}

export interface ManifestProblem {
  code: string;
  message: string;
}

const SECRET_POINTER_RE = /^[a-z][a-z0-9+.-]*:\/\/.+/;
const MISS_POLICIES = new Set<string>(["skip", "catch-up", "fail-loud"]);
const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

function isTable(v: unknown): v is TomlTable {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function stringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  if (!v.every((x): x is string => typeof x === "string")) return null;
  return v;
}

// --- cron compilation (§7.1, pinned union semantics) ---

interface CronFields {
  minute: number[] | null;
  hour: number[] | null;
  dom: number[] | null;
  month: number[] | null;
  dow: number[] | null;
}

function parseCronField(
  spec: string,
  fieldName: string,
  min: number,
  max: number,
  normalize?: (n: number) => number,
): number[] | null {
  if (spec === "*") return null;
  const values: number[] = [];
  for (const token of spec.split(",")) {
    if (!/^\d+$/.test(token)) {
      throw new ConfigError(
        `cron ${fieldName} field: unsupported token "${token}" — only numbers, comma-lists, ` +
          `and * are supported (use [schedule] calendar_interval for ranges/steps)`,
      );
    }
    const n = Number(token);
    if (n < min || n > max) {
      throw new ConfigError(`cron ${fieldName} field: ${n} out of range ${min}-${max}`);
    }
    const norm = normalize !== undefined ? normalize(n) : n;
    if (!values.includes(norm)) values.push(norm);
  }
  values.sort((a, b) => a - b);
  return values;
}

export function parseCron(expr: string): CronFields {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new ConfigError(
      `cron expression "${expr}" must have exactly 5 fields (minute hour day-of-month month day-of-week)`,
    );
  }
  return {
    minute: parseCronField(fields[0] as string, "minute", 0, 59),
    hour: parseCronField(fields[1] as string, "hour", 0, 23),
    dom: parseCronField(fields[2] as string, "day-of-month", 1, 31),
    month: parseCronField(fields[3] as string, "month", 1, 12),
    // 0 and 7 are both Sunday in cron; normalize to 0.
    dow: parseCronField(fields[4] as string, "day-of-week", 0, 7, (n) => (n === 7 ? 0 : n)),
  };
}

/**
 * Compile a 5-field cron expression into launchd StartCalendarInterval
 * entries. PINNED semantics per PRD §7.1: when BOTH day-of-month and
 * day-of-week are restricted, cron fires when EITHER matches — the compiler
 * emits the union (Day-keyed entries + Weekday-keyed entries). launchd ANDs
 * the keys within one entry, so the union must be expressed across entries,
 * never within one.
 */
export function compileCron(expr: string): CalendarEntry[] {
  const f = parseCron(expr);
  let base: CalendarEntry[] = [{}];
  const cross = (entries: CalendarEntry[], key: keyof CalendarEntry, values: number[] | null) => {
    if (values === null) return entries;
    const out: CalendarEntry[] = [];
    for (const e of entries) for (const v of values) out.push({ ...e, [key]: v });
    return out;
  };
  base = cross(base, "Minute", f.minute);
  base = cross(base, "Hour", f.hour);
  base = cross(base, "Month", f.month);

  if (f.dom === null && f.dow === null) return base;
  if (f.dom !== null && f.dow === null) return cross(base, "Day", f.dom);
  if (f.dom === null && f.dow !== null) return cross(base, "Weekday", f.dow);
  // Both restricted → union/OR (the conformance-tested paragraph).
  return [...cross(base, "Day", f.dom), ...cross(base, "Weekday", f.dow)];
}

const CALENDAR_KEYS: Record<string, keyof CalendarEntry> = {
  minute: "Minute",
  hour: "Hour",
  day: "Day",
  weekday: "Weekday",
  month: "Month",
};

function parseCalendarInterval(v: unknown): CalendarEntry[] {
  const tables = Array.isArray(v) ? v : [v];
  const out: CalendarEntry[] = [];
  for (const t of tables) {
    if (!isTable(t)) {
      throw new ConfigError("calendar_interval must be a table or array of tables");
    }
    const entry: CalendarEntry = {};
    for (const [key, value] of Object.entries(t)) {
      const mapped = CALENDAR_KEYS[key.toLowerCase()];
      if (mapped === undefined) {
        throw new ConfigError(
          `calendar_interval: unknown key "${key}" (expected minute|hour|day|weekday|month)`,
        );
      }
      if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new ConfigError(`calendar_interval: ${key} must be an integer`);
      }
      entry[mapped] = value;
    }
    out.push(entry);
  }
  return out;
}

/**
 * Validate a parsed automation.toml. Forgiving read (unknown keys pass
 * through in `raw`), strict apply: any problem blocks `apply` and surfaces as
 * a doctor finding. Returns the typed manifest when (and only when) clean.
 */
export function validateManifest(
  raw: TomlTable,
  options: { dirName: string },
): { manifest: AutomationManifest | null; problems: ManifestProblem[] } {
  const problems: ManifestProblem[] = [];
  const prob = (code: string, message: string) => problems.push({ code, message });

  // name: defaults to the directory name; a disagreeing declared name is drift
  let name = options.dirName;
  if (raw["name"] !== undefined) {
    if (typeof raw["name"] !== "string" || !NAME_RE.test(raw["name"])) {
      prob("name", `invalid name ${JSON.stringify(raw["name"])} (expected [a-z0-9][a-z0-9._-]*)`);
    } else if (raw["name"] !== options.dirName) {
      prob(
        "name-mismatch",
        `declared name "${raw["name"]}" disagrees with the directory name "${options.dirName}"`,
      );
    } else {
      name = raw["name"];
    }
  }

  // machines: declared placement intent — required (§7.1: part of the design)
  const machines = stringArray(raw["machines"]) ?? [];
  if (raw["machines"] === undefined || machines.length === 0) {
    prob("no-machines", "no declared machines (machines = [...]) — placement intent is part of the automation's design (PRD §7.1)");
  } else if (stringArray(raw["machines"]) === null) {
    prob("machines", "machines must be an array of strings");
  }

  // [schedule]: exactly one of cron | calendar_interval
  let cron: string | null = null;
  let calendar: CalendarEntry[] = [];
  let timezone: string | null = null;
  let missPolicy: MissPolicy = "skip";
  const schedule = raw["schedule"];
  if (!isTable(schedule)) {
    prob("no-schedule", "missing [schedule] table (cron or calendar_interval)");
  } else {
    const hasCron = schedule["cron"] !== undefined;
    const hasCal = schedule["calendar_interval"] !== undefined;
    if (hasCron === hasCal) {
      prob("schedule-shape", "[schedule] must declare exactly one of cron | calendar_interval");
    } else if (hasCron) {
      if (typeof schedule["cron"] !== "string") {
        prob("cron", "[schedule] cron must be a string");
      } else {
        cron = schedule["cron"];
        try {
          calendar = compileCron(cron);
        } catch (err) {
          prob("cron", err instanceof Error ? err.message : String(err));
        }
      }
    } else {
      try {
        calendar = parseCalendarInterval(schedule["calendar_interval"]);
      } catch (err) {
        prob("calendar_interval", err instanceof Error ? err.message : String(err));
      }
    }
    if (schedule["timezone"] !== undefined) {
      // No consumer exists: launchd's StartCalendarInterval fires in
      // machine-local time and the compiler does no TZ conversion. Accepting
      // the key would mean silently-local scheduling under a declared
      // timezone — reject loudly until the conversion is implemented.
      prob(
        "timezone",
        "[schedule] timezone is not implemented — launchd StartCalendarInterval fires in machine-LOCAL " +
          "time and no conversion is performed; remove the key and express the cadence in local time",
      );
    }
    if (schedule["miss_policy"] !== undefined) {
      if (typeof schedule["miss_policy"] !== "string" || !MISS_POLICIES.has(schedule["miss_policy"])) {
        prob("miss_policy", `invalid miss_policy ${JSON.stringify(schedule["miss_policy"])} (expected skip|catch-up|fail-loud)`);
      } else {
        missPolicy = schedule["miss_policy"] as MissPolicy;
      }
    }
  }

  // [run]
  let command: string[] = [];
  let directExec = false;
  let timeoutSeconds: number | null = null;
  const run = raw["run"];
  if (!isTable(run)) {
    prob("no-run", "missing [run] table (command = [...])");
  } else {
    const cmd = stringArray(run["command"]);
    if (cmd === null || cmd.length === 0) {
      prob("command", "[run] command must be a non-empty array of strings (never a shell string)");
    } else {
      command = cmd;
    }
    if (run["direct_exec"] !== undefined) {
      if (typeof run["direct_exec"] !== "boolean") prob("direct_exec", "[run] direct_exec must be a boolean");
      else directExec = run["direct_exec"];
    }
    if (run["timeout_seconds"] !== undefined) {
      if (typeof run["timeout_seconds"] !== "number" || run["timeout_seconds"] <= 0) {
        prob("timeout_seconds", "[run] timeout_seconds must be a positive number");
      } else {
        timeoutSeconds = run["timeout_seconds"];
      }
    }
  }

  // [secrets]: pointers only (§7.5) — a bare value is a hard error
  const secrets: Record<string, string> = {};
  const secretsRaw = raw["secrets"];
  if (secretsRaw !== undefined) {
    if (!isTable(secretsRaw)) {
      prob("secrets", "[secrets] must be a table of <scheme>://<ref> pointers");
    } else {
      for (const [key, value] of Object.entries(secretsRaw)) {
        if (isTable(value)) continue; // sub-table, not an entry
        if (typeof value !== "string" || !SECRET_POINTER_RE.test(value)) {
          prob(
            "bare-secret",
            `bare secret value under [secrets] (key "${key}") — secrets are pointers ` +
              `(<scheme>://<ref>) resolved at run time, never values on disk`,
          );
        } else {
          secrets[key] = value;
        }
      }
    }
  }
  if (directExec && Object.keys(secrets).length > 0) {
    prob(
      "direct-exec-secrets",
      "[secrets] cannot be combined with direct_exec = true — there is no runner in the " +
        "direct-exec path to resolve pointers, and resolved values never land in a plist",
    );
  }

  // [supervise]: pass-through table (the supervise pass is the consumer)
  let supervise: TomlTable = {};
  if (raw["supervise"] !== undefined) {
    if (!isTable(raw["supervise"])) prob("supervise", "[supervise] must be a table");
    else supervise = raw["supervise"];
  }

  // [signature]: typed inputs/outputs (annotation; doctor checks file paths)
  const parseSignatureSide = (side: "inputs" | "outputs"): SignatureEntry[] => {
    const sig = raw["signature"];
    if (!isTable(sig) || !isTable(sig[side])) return [];
    const entries: SignatureEntry[] = [];
    for (const [entryName, value] of Object.entries(sig[side] as TomlTable)) {
      if (!isTable(value) || typeof value["type"] !== "string") {
        prob("signature", `[signature.${side}] ${entryName}: each entry needs a type`);
        continue;
      }
      entries.push({
        name: entryName,
        type: value["type"],
        path: typeof value["path"] === "string" ? value["path"] : null,
      });
    }
    return entries;
  };
  const signature = { inputs: parseSignatureSide("inputs"), outputs: parseSignatureSide("outputs") };

  // on_dormant_project (top-level; legacy [lifecycle] location read for compat)
  let onDormantProject: OnDormantProject = "stop";
  const lifecycleTable = isTable(raw["lifecycle"]) ? raw["lifecycle"] : {};
  const odp = raw["on_dormant_project"] ?? lifecycleTable["on_dormant_project"];
  if (odp !== undefined) {
    if (odp !== "stop" && odp !== "continue") {
      prob("on_dormant_project", `invalid on_dormant_project ${JSON.stringify(odp)} (expected stop|continue)`);
    } else {
      onDormantProject = odp;
    }
  }

  if (problems.length > 0) return { manifest: null, problems };
  return {
    manifest: {
      name,
      machines,
      schedule: { cron, calendar, timezone, missPolicy },
      run: { command, directExec, timeoutSeconds },
      secrets,
      supervise,
      signature,
      onDormantProject,
      raw,
    },
    problems,
  };
}

export const MANIFEST_FILE = "automation.toml";

export function automationsDir(projectRoot: string): string {
  return path.join(projectRoot, "_project", "automations");
}

/** Load + validate one automation's manifest; ConfigError listing problems. */
export function loadManifest(projectRoot: string, name: string): AutomationManifest {
  const manifestPath = path.join(automationsDir(projectRoot), name, MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) {
    throw new NotFoundError(`no automation "${name}": missing ${manifestPath}`);
  }
  const raw = readToml(manifestPath);
  const { manifest, problems } = validateManifest(raw, { dirName: name });
  if (manifest === null) {
    throw new ConfigError(
      `invalid automation manifest ${manifestPath}:\n` + problems.map((p) => `  - ${p.message}`).join("\n"),
    );
  }
  return manifest;
}

export interface ManifestScanEntry {
  name: string;
  manifestPath: string;
  manifest: AutomationManifest | null;
  problems: ManifestProblem[];
}

/** Scan a project's automation definitions (forgiving: problems reported, not thrown). */
export function scanManifests(projectRoot: string): ManifestScanEntry[] {
  const dir = automationsDir(projectRoot);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: ManifestScanEntry[] = [];
  for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!ent.isDirectory()) continue;
    const manifestPath = path.join(dir, ent.name, MANIFEST_FILE);
    if (!fs.existsSync(manifestPath)) continue; // a dir without a manifest is not an automation
    try {
      const raw = readToml(manifestPath);
      const { manifest, problems } = validateManifest(raw, { dirName: ent.name });
      out.push({ name: ent.name, manifestPath, manifest, problems });
    } catch (err) {
      out.push({
        name: ent.name,
        manifestPath,
        manifest: null,
        problems: [{ code: "toml", message: err instanceof Error ? err.message : String(err) }],
      });
    }
  }
  return out;
}

export function scheduleSummary(manifest: AutomationManifest): string {
  return manifest.schedule.cron !== null
    ? `cron ${manifest.schedule.cron}`
    : `calendar_interval (${manifest.schedule.calendar.length} entr${manifest.schedule.calendar.length === 1 ? "y" : "ies"})`;
}

// ---------------------------------------------------------------------------
// Plist generation — late binding (§7.1): runner + UID + name, never a
// project path, never a secret
// ---------------------------------------------------------------------------

export function plistLabel(projectUid: string, name: string): string {
  return `com.openworkspace.${projectUid}.${name}`;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function calendarXml(entries: CalendarEntry[], indent: string): string {
  const ORDER: Array<keyof CalendarEntry> = ["Minute", "Hour", "Day", "Weekday", "Month"];
  const dict = (e: CalendarEntry, pad: string): string => {
    const lines = [`${pad}<dict>`];
    for (const key of ORDER) {
      const v = e[key];
      if (v !== undefined) lines.push(`${pad}\t<key>${key}</key><integer>${v}</integer>`);
    }
    lines.push(`${pad}</dict>`);
    return lines.join("\n");
  };
  if (entries.length === 1) return dict(entries[0] as CalendarEntry, indent);
  return [`${indent}<array>`, ...entries.map((e) => dict(e, indent + "\t")), `${indent}</array>`].join("\n");
}

export interface PlistOptions {
  projectUid: string;
  manifest: AutomationManifest;
  /** Path of the compiled runner entry (dist/src/runner.js). */
  runnerPath: string;
  /** Node executable to invoke the runner with. */
  nodePath: string;
  /**
   * direct_exec only (§7.4 documented exception): the baked working
   * directory. The normal path NEVER bakes a project path — the runner
   * late-binds UID → canonical at fire time.
   */
  workingDirectory?: string;
}

/**
 * Generate the LaunchAgent plist. Invariants (asserted by tests):
 *  - normal mode: ProgramArguments = [node, runner, --uid, <uid>, --name, <n>]
 *    — no project filesystem path anywhere in the document;
 *  - direct_exec mode: ProgramArguments = the manifest command verbatim, with
 *    the canonical project root baked as WorkingDirectory (the documented
 *    §7.4 TCC fallback — paths in this mode are the author's accepted cost);
 *  - NEVER a resolved secret in either mode (resolution is per-run, §7.5).
 */
export function generatePlist(options: PlistOptions): string {
  const { manifest, projectUid } = options;
  const label = plistLabel(projectUid, manifest.name);
  const args = manifest.run.directExec
    ? manifest.run.command
    : [options.nodePath, options.runnerPath, "--uid", projectUid, "--name", manifest.name];
  const lines: string[] = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `\t<key>Label</key>`,
    `\t<string>${xmlEscape(label)}</string>`,
    `\t<key>ProgramArguments</key>`,
    `\t<array>`,
    ...args.map((a) => `\t\t<string>${xmlEscape(a)}</string>`),
    `\t</array>`,
    `\t<key>StartCalendarInterval</key>`,
    calendarXml(manifest.schedule.calendar, "\t"),
  ];
  if (manifest.run.directExec && options.workingDirectory !== undefined) {
    lines.push(`\t<key>WorkingDirectory</key>`, `\t<string>${xmlEscape(options.workingDirectory)}</string>`);
  }
  lines.push(`</dict>`, `</plist>`, ``);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Launchd adapter — injectable seam over launchctl + ~/Library/LaunchAgents
// ---------------------------------------------------------------------------

export interface LaunchdAdapter {
  /** Where com.openworkspace.*.plist files live. */
  agentsDir: string;
  load(plistPath: string, label: string): void;
  unload(plistPath: string, label: string): void;
  loadedLabels(): string[];
}

export const LAUNCHD_DIR_ENV = "OPENWORKSPACE_LAUNCHD_DIR";

/**
 * The file-backed fake: plists land in `dir`, "loaded" state persists in
 * `.loaded.json`, every operation appends to `.ops.jsonl` (so tests can
 * assert reload behavior across CLI subprocesses). Never touches launchctl.
 */
export function fileFakeLaunchd(dir: string): LaunchdAdapter {
  ensureDir(dir);
  const statePath = path.join(dir, ".loaded.json");
  const opsPath = path.join(dir, ".ops.jsonl");
  const readState = (): Record<string, string> => {
    const text = readTextIfExists(statePath);
    if (text === null) return {};
    try {
      return JSON.parse(text) as Record<string, string>;
    } catch {
      return {};
    }
  };
  const writeState = (state: Record<string, string>): void => {
    writeFileAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
  };
  const op = (kind: string, label: string): void => {
    fs.appendFileSync(opsPath, JSON.stringify({ op: kind, label, ts: new Date().toISOString() }) + "\n");
  };
  return {
    agentsDir: dir,
    load(plistPath, label) {
      const state = readState();
      state[label] = plistPath;
      writeState(state);
      op("load", label);
    },
    unload(_plistPath, label) {
      const state = readState();
      delete state[label];
      writeState(state);
      op("unload", label);
    },
    loadedLabels() {
      return Object.keys(readState()).sort();
    },
  };
}

/** The real adapter: ~/Library/LaunchAgents + launchctl bootstrap/bootout. */
export function realLaunchd(): LaunchdAdapter {
  const agentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
  const launchctl = (args: string[]): string => {
    try {
      return execFileSync("launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      throw new ConfigError(`launchctl ${args[0]} failed: ${(e.stderr ?? e.message ?? "").trim()}`);
    }
  };
  const domain = (): string => `gui/${process.getuid?.() ?? 501}`;
  return {
    agentsDir,
    load(plistPath) {
      launchctl(["bootstrap", domain(), plistPath]);
    },
    unload(plistPath, label) {
      try {
        launchctl(["bootout", `${domain()}/${label}`]);
      } catch {
        // not loaded (or older launchd): fall back to legacy unload, best-effort
        try {
          execFileSync("launchctl", ["unload", plistPath], { stdio: "ignore" });
        } catch {
          // already gone
        }
      }
    },
    loadedLabels() {
      try {
        const out = execFileSync("launchctl", ["list"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        return out
          .split("\n")
          .map((line) => line.split("\t")[2] ?? "")
          .filter((label) => label.startsWith("com.openworkspace."));
      } catch {
        return [];
      }
    },
  };
}

/** Adapter selection: the env override (tests/CI) gets the file-backed fake. */
export function launchdFromEnv(env: NodeJS.ProcessEnv = process.env): LaunchdAdapter {
  const override = env[LAUNCHD_DIR_ENV];
  if (override !== undefined && override !== "") return fileFakeLaunchd(path.resolve(override));
  return realLaunchd();
}

// ---------------------------------------------------------------------------
// UID → canonical resolution FROM a UID (the runner has no start dir)
// ---------------------------------------------------------------------------

/**
 * Resolve a project UID to its canonical root with no starting directory:
 * verified cache hit → bounded rescan of known workspaces → loud
 * ResolveError. Same UID-registry-first chain as lib/resolve, §6.4.
 */
export function resolveUidToCanonical(
  uid: string,
  store: MachineStore,
  extraWorkspaceRoots: string[] = [],
): string {
  const cached = readUidCache(store)[uid];
  if (cached !== undefined && readProjectUid(cached) === uid && !isGitWorktree(cached)) {
    return cached;
  }
  const roots = [...new Set([...readKnownWorkspaces(store), ...extraWorkspaceRoots.map((r) => path.resolve(r))])];
  for (const wsRoot of roots) {
    if (isGitWorktree(wsRoot)) continue;
    let ws: Workspace;
    try {
      ws = { root: wsRoot, config: loadWorkspaceConfig(wsRoot) };
    } catch {
      continue;
    }
    const found = findProjectByUid(ws, uid);
    if (found !== null && !isGitWorktree(found.root)) {
      writeUidCacheEntry(store, uid, found.root);
      return found.root;
    }
  }
  throw new ResolveError(
    `cannot resolve canonical location for project UID ${uid}: not in the UID cache and not ` +
      `found in any known workspace (${roots.length === 0 ? "none registered" : roots.join(", ")}). ` +
      `The activation is orphaned — \`projects automation prune\` removes it, or run a workspace ` +
      `command from the canonical checkout to re-register it.`,
  );
}

// ---------------------------------------------------------------------------
// Activation records (machine-local App Support store)
// ---------------------------------------------------------------------------

export interface ActivationRecord {
  project_uid: string;
  name: string;
  machine_id: string;
  label: string;
  plist_path: string;
  workspace_root: string | null;
  applied_at: string;
  direct_exec: boolean;
  schedule: string;
}

export function readActivationRecords(store: MachineStore): Array<{ path: string; record: ActivationRecord }> {
  const dir = activationsDir(store);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith(".toml")).sort();
  } catch {
    return [];
  }
  const out: Array<{ path: string; record: ActivationRecord }> = [];
  for (const name of entries) {
    const filePath = path.join(dir, name);
    let raw: TomlTable;
    try {
      raw = readTomlIfExists(filePath);
    } catch {
      continue; // unreadable activation record; prune's concern, not a crash
    }
    if (typeof raw["project_uid"] !== "string" || typeof raw["name"] !== "string") continue;
    out.push({
      path: filePath,
      record: {
        project_uid: raw["project_uid"],
        name: raw["name"],
        machine_id: typeof raw["machine_id"] === "string" ? raw["machine_id"] : "",
        label: typeof raw["label"] === "string" ? raw["label"] : plistLabel(raw["project_uid"], raw["name"]),
        plist_path: typeof raw["plist_path"] === "string" ? raw["plist_path"] : "",
        workspace_root: typeof raw["workspace_root"] === "string" ? raw["workspace_root"] : null,
        applied_at: typeof raw["applied_at"] === "string" ? raw["applied_at"] : "",
        direct_exec: raw["direct_exec"] === true,
        schedule: typeof raw["schedule"] === "string" ? raw["schedule"] : "",
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Verbs: apply / deactivate / list / status / prune / logs
// ---------------------------------------------------------------------------

export interface AutomationContext {
  /** Project dir (or inside one); apply RESOLVES TO CANONICAL (§6.3). */
  startDir: string;
  store: MachineStore;
  launchd: LaunchdAdapter;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  extraWorkspaceRoots?: string[];
  /** Runner entry point baked into plists; defaults to the packaged runner. */
  runnerPath?: string;
  nodePath?: string;
}

function ctxNow(ctx: AutomationContext): Date {
  return (ctx.now ?? (() => new Date()))();
}

function isoStamp(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function defaultRunnerPath(): string {
  // automations.ts compiles to dist/src/primitives/; the runner to dist/src/.
  return path.resolve(__dirname, "..", "runner.js");
}

/**
 * The node that plists invoke the runner with (decision-1, PRD §7.4):
 * explicit injection (tests) → the machine-store's configured runner-node
 * (`projects home runner-node`) → process.execPath as the FALLBACK. The
 * fallback is not a durable TCC grant identity (e.g. a Homebrew node's
 * ad-hoc signature changes on every update), so apply() warns and doctor's
 * runner-posture checks warn whenever it is in effect. apply, list, and
 * status all use this one chain — a plist generated under one node path must
 * compare equal under the same configuration, never spuriously "stale".
 */
export function effectiveNodePath(ctx: AutomationContext): string {
  return ctx.nodePath ?? readRunnerNode(ctx.store) ?? process.execPath;
}

interface CanonicalTarget {
  uid: string;
  canonicalRoot: string;
  workspaceRoot: string | null;
}

/** §6.3: apply from a worktree registers the CANONICAL definition. */
function canonicalTarget(ctx: AutomationContext): CanonicalTarget {
  const resolved = resolveCanonicalProject(ctx.startDir, ctx.store, {
    extraWorkspaceRoots: ctx.extraWorkspaceRoots,
  });
  return {
    uid: resolved.uid,
    canonicalRoot: resolved.canonicalRoot,
    workspaceRoot: findWorkspaceRoot(resolved.canonicalRoot),
  };
}

export type ApplyAction = "installed" | "regenerated" | "unchanged";

export interface ApplyResult {
  name: string;
  action: ApplyAction;
  label: string;
  plistPath: string;
  machine: string;
  forced: boolean;
}

export interface ApplySummary {
  machine: string;
  applied: ApplyResult[];
  /** --all only: declared elsewhere, skipped here (placement respected). */
  skippedUndeclared: string[];
  /** --all only: manifests too broken to apply (each blocks with doctor too). */
  invalid: Array<{ name: string; problems: ManifestProblem[] }>;
  /**
   * Non-fatal posture warnings (decision-1): currently the runner-node
   * fallback — a runner-path plist was generated without a configured
   * runner-node, so ProgramArguments[0] is the node that ran apply.
   */
  warnings: string[];
}

function applyOne(
  ctx: AutomationContext,
  target: CanonicalTarget,
  manifest: AutomationManifest,
  forced: boolean,
): ApplyResult {
  const mid = machineId(ctx.store);
  const label = plistLabel(target.uid, manifest.name);
  const plistPath = path.join(ctx.launchd.agentsDir, `${label}.plist`);
  const content = generatePlist({
    projectUid: target.uid,
    manifest,
    runnerPath: ctx.runnerPath ?? defaultRunnerPath(),
    nodePath: effectiveNodePath(ctx),
    ...(manifest.run.directExec ? { workingDirectory: target.canonicalRoot } : {}),
  });

  const existing = readTextIfExists(plistPath);
  const recordPath = activationRecordPath(ctx.store, target.uid, manifest.name);
  const recordExists = fs.existsSync(recordPath);
  const loaded = ctx.launchd.loadedLabels().includes(label);

  // Idempotent convergence (§7.1 terraform property): unchanged = no-op.
  if (existing === content && recordExists && loaded) {
    return { name: manifest.name, action: "unchanged", label, plistPath, machine: mid, forced };
  }

  if (loaded) ctx.launchd.unload(plistPath, label);
  writeFileAtomic(plistPath, content);
  ctx.launchd.load(plistPath, label);

  const record: ActivationRecord = {
    project_uid: target.uid,
    name: manifest.name,
    machine_id: mid,
    label,
    plist_path: plistPath,
    workspace_root: target.workspaceRoot,
    applied_at: isoStamp(ctxNow(ctx)),
    direct_exec: manifest.run.directExec,
    schedule: scheduleSummary(manifest),
  };
  const recordToml: TomlTable = { ...record };
  if (record.workspace_root === null) delete recordToml["workspace_root"];
  writeToml(recordPath, recordToml);

  if (target.workspaceRoot !== null) {
    recordRegistryActivation(target.workspaceRoot, mid, {
      project_uid: target.uid,
      name: manifest.name,
      label,
      applied_at: record.applied_at,
      schedule: record.schedule,
    }, ctxNow(ctx));
  }
  return {
    name: manifest.name,
    action: existing === null ? "installed" : "regenerated",
    label,
    plistPath,
    machine: mid,
    forced,
  };
}

/**
 * `apply <name>` / `apply --all` (§7.1 declared-machines reconciliation):
 * named apply ERRORS when this machine is undeclared (override --force);
 * `--all` converges this machine to its declared set — install the missing,
 * regenerate the changed, no-op the current. `--all` never force-installs an
 * undeclared automation and never deactivates (that is prune/deactivate's
 * job; the drift is surfaced by `status`).
 */
export function apply(
  ctx: AutomationContext,
  options: { name?: string; all?: boolean; force?: boolean },
): ApplySummary {
  const target = canonicalTarget(ctx);
  const mid = machineId(ctx.store);
  const summary: ApplySummary = { machine: mid, applied: [], skippedUndeclared: [], invalid: [], warnings: [] };

  // decision-1 (§7.4): a runner-path plist without a configured runner-node
  // bakes the node that ran apply — functional today, but not a durable TCC
  // grant identity. Surfaced as a WARNING (and a doctor warn), never an error.
  const nodeFallback = ctx.nodePath === undefined && readRunnerNode(ctx.store) === null;
  let usedRunnerPath = false;

  if (options.all === true) {
    for (const entry of scanManifests(target.canonicalRoot)) {
      if (entry.manifest === null) {
        summary.invalid.push({ name: entry.name, problems: entry.problems });
        continue;
      }
      if (!entry.manifest.machines.includes(mid)) {
        summary.skippedUndeclared.push(entry.name);
        continue;
      }
      if (!entry.manifest.run.directExec) usedRunnerPath = true;
      summary.applied.push(applyOne(ctx, target, entry.manifest, false));
    }
    if (nodeFallback && usedRunnerPath) summary.warnings.push(runnerNodeFallbackWarning());
    return summary;
  }

  if (options.name === undefined) {
    throw new ConfigError("usage: projects automation apply <name> | --all");
  }
  const manifest = loadManifest(target.canonicalRoot, options.name);
  const declared = manifest.machines.includes(mid);
  if (!declared && options.force !== true) {
    throw new ConfigError(
      `automation "${manifest.name}" does not declare this machine ("${mid}"; machines = ` +
        `[${manifest.machines.map((m) => `"${m}"`).join(", ")}]) — declare it in automation.toml, ` +
        `or override with --force`,
    );
  }
  summary.applied.push(applyOne(ctx, target, manifest, !declared));
  if (nodeFallback && !manifest.run.directExec) summary.warnings.push(runnerNodeFallbackWarning());
  return summary;
}

function runnerNodeFallbackWarning(): string {
  return (
    `no runner-node configured on this machine — the plist invokes the node that ran apply ` +
    `(${process.execPath}), which is NOT a durable TCC grant identity (decision-1: use a dedicated ` +
    `official-pkg node at a fixed path); set it with \`projects home runner-node <path>\` and re-apply`
  );
}

export interface DeactivateResult {
  name: string;
  label: string;
  removedPlist: boolean;
  removedRecord: boolean;
}

export function deactivate(ctx: AutomationContext, name: string): DeactivateResult {
  const target = canonicalTarget(ctx);
  const mid = machineId(ctx.store);
  const label = plistLabel(target.uid, name);
  const plistPath = path.join(ctx.launchd.agentsDir, `${label}.plist`);
  const recordPath = activationRecordPath(ctx.store, target.uid, name);

  if (ctx.launchd.loadedLabels().includes(label)) ctx.launchd.unload(plistPath, label);
  let removedPlist = false;
  if (fs.existsSync(plistPath)) {
    fs.unlinkSync(plistPath);
    removedPlist = true;
  }
  let removedRecord = false;
  if (fs.existsSync(recordPath)) {
    fs.unlinkSync(recordPath);
    removedRecord = true;
  }
  if (target.workspaceRoot !== null) {
    removeRegistryActivation(target.workspaceRoot, mid, target.uid, name, ctxNow(ctx));
  }
  return { name, label, removedPlist, removedRecord };
}

// --- list ---

export interface AutomationListEntry {
  name: string;
  machines: string[];
  schedule: string | null;
  valid: boolean;
  problems: string[];
  /** This machine's view: active | stale | not-applied | undeclared. */
  localState: "active" | "stale" | "not-applied" | "undeclared";
}

export function listAutomations(ctx: AutomationContext): AutomationListEntry[] {
  const target = canonicalTarget(ctx);
  const mid = machineId(ctx.store);
  const out: AutomationListEntry[] = [];
  for (const entry of scanManifests(target.canonicalRoot)) {
    if (entry.manifest === null) {
      out.push({
        name: entry.name,
        machines: [],
        schedule: null,
        valid: false,
        problems: entry.problems.map((p) => p.message),
        localState: "not-applied",
      });
      continue;
    }
    const m = entry.manifest;
    const declared = m.machines.includes(mid);
    const recordPath = activationRecordPath(ctx.store, target.uid, m.name);
    let localState: AutomationListEntry["localState"];
    if (!fs.existsSync(recordPath)) {
      localState = declared ? "not-applied" : "undeclared";
    } else {
      const label = plistLabel(target.uid, m.name);
      const plistPath = path.join(ctx.launchd.agentsDir, `${label}.plist`);
      const wanted = generatePlist({
        projectUid: target.uid,
        manifest: m,
        runnerPath: ctx.runnerPath ?? defaultRunnerPath(),
        nodePath: effectiveNodePath(ctx),
        ...(m.run.directExec ? { workingDirectory: target.canonicalRoot } : {}),
      });
      const current = readTextIfExists(plistPath);
      const loaded = ctx.launchd.loadedLabels().includes(label);
      localState = current === wanted && loaded ? "active" : "stale";
    }
    out.push({
      name: m.name,
      machines: m.machines,
      schedule: scheduleSummary(m),
      valid: true,
      problems: [],
      localState,
    });
  }
  return out;
}

export interface MachineRegistryView {
  machineId: string;
  heartbeat: string | null;
  /** Days since heartbeat, or null when unparseable. */
  staleDays: number | null;
  activations: Array<{ project_uid: string; name: string; schedule: string }>;
  lastRuns: Array<{ key: string; status: string; finished_at: string | null }>;
}

/** §7.3 `list --all`: every machine's synced registry, explicit staleness. */
export function listAllMachines(ctx: AutomationContext): MachineRegistryView[] {
  const target = canonicalTarget(ctx);
  const wsRoot = target.workspaceRoot;
  if (wsRoot === null) throw new NotFoundError(`project ${target.canonicalRoot} is not inside a workspace`);
  const machinesDir = path.join(wsRoot, MARKER_DIR, "machines");
  let files: string[];
  try {
    files = fs.readdirSync(machinesDir).filter((f) => f.endsWith(".toml")).sort();
  } catch {
    return [];
  }
  const nowMs = ctxNow(ctx).getTime();
  const out: MachineRegistryView[] = [];
  for (const file of files) {
    let raw: TomlTable;
    try {
      raw = readTomlIfExists(path.join(machinesDir, file));
    } catch {
      out.push({ machineId: file.slice(0, -5), heartbeat: null, staleDays: null, activations: [], lastRuns: [] });
      continue;
    }
    const hb = typeof raw["heartbeat"] === "string" ? raw["heartbeat"] : raw["heartbeat"] instanceof Date ? raw["heartbeat"].toISOString() : null;
    const hbMs = hb !== null ? Date.parse(hb) : Number.NaN;
    const activations: MachineRegistryView["activations"] = [];
    if (Array.isArray(raw["activations"])) {
      for (const a of raw["activations"]) {
        if (!isTable(a) || typeof a["project_uid"] !== "string" || typeof a["name"] !== "string") continue;
        activations.push({
          project_uid: a["project_uid"],
          name: a["name"],
          schedule: typeof a["schedule"] === "string" ? a["schedule"] : "",
        });
      }
    }
    const lastRuns: MachineRegistryView["lastRuns"] = [];
    if (isTable(raw["last_runs"])) {
      for (const [key, v] of Object.entries(raw["last_runs"] as TomlTable)) {
        if (!isTable(v)) continue;
        lastRuns.push({
          key,
          status: typeof v["status"] === "string" ? v["status"] : "unknown",
          finished_at: typeof v["finished_at"] === "string" ? v["finished_at"] : null,
        });
      }
    }
    out.push({
      machineId: typeof raw["machine_id"] === "string" ? raw["machine_id"] : file.slice(0, -5),
      heartbeat: hb,
      staleDays: Number.isNaN(hbMs) ? null : Math.floor((nowMs - hbMs) / 86_400_000),
      activations,
      lastRuns,
    });
  }
  return out;
}

// --- status: activation records ↔ launchd ↔ the tree ---

export type StatusKind =
  | "uninstalled-draft" // declared for this machine, no activation here
  | "stale-install" // installed plist no longer matches the manifest
  | "plist-missing" // activation record without its plist
  | "not-loaded" // plist present, label not registered with launchd
  | "orphan" // activation whose UID no longer resolves anywhere
  | "activated-undeclared" // active here but the manifest no longer declares this machine
  | "manifest-invalid-active" // ACTIVE somewhere but the manifest is present-but-invalid (every fire fails)
  | "remote-declared-inactive" // another declared machine's registry shows no activation
  | "remote-activated-undeclared"; // another machine's registry shows an undeclared activation

export interface StatusFinding {
  kind: StatusKind;
  machine: string;
  project: string | null;
  name: string;
  detail: string;
}

/**
 * Reconcile three sources for this machine — the App Support activation
 * records, the launchd view (through the adapter), and the live tree — plus
 * the synced per-machine registries for cross-machine placement drift
 * (§7.1/§7.3). A report, never a control plane.
 */
export function status(ctx: AutomationContext): StatusFinding[] {
  const target = canonicalTarget(ctx);
  const mid = machineId(ctx.store);
  const wsRoot = target.workspaceRoot;
  const findings: StatusFinding[] = [];
  const loaded = new Set(ctx.launchd.loadedLabels());
  const projectName = path.basename(target.canonicalRoot);

  const manifests = scanManifests(target.canonicalRoot);
  const byName = new Map(manifests.map((m) => [m.name, m]));

  // tree → records: present-but-INVALID manifests that are still active
  // (locally or per a synced registry) hard-fail at every fire — a drift
  // class neither "stale-install" nor "orphan" covers; surface it here so
  // `status` (the §7.3 supervision surface) is not blind to it.
  for (const entry of manifests) {
    if (entry.manifest !== null) continue;
    const firstProblem = entry.problems[0]?.message ?? "see `projects automation list` / doctor";
    const detailFor = (where: string): string =>
      `active on "${where}" but its manifest is INVALID (${firstProblem}) — every fire will fail ` +
      `until automation.toml is fixed; do NOT deactivate over a manifest typo`;
    if (fs.existsSync(activationRecordPath(ctx.store, target.uid, entry.name))) {
      findings.push({
        kind: "manifest-invalid-active",
        machine: mid,
        project: projectName,
        name: entry.name,
        detail: detailFor(mid),
      });
    }
    if (wsRoot !== null) {
      for (const view of listAllMachinesAt(wsRoot, ctxNow(ctx))) {
        if (view.machineId === mid) continue;
        if (view.activations.some((a) => a.project_uid === target.uid && a.name === entry.name)) {
          findings.push({
            kind: "manifest-invalid-active",
            machine: view.machineId,
            project: projectName,
            name: entry.name,
            detail: detailFor(view.machineId),
          });
        }
      }
    }
  }

  // tree → records: declared-but-not-activated + install fidelity
  for (const entry of manifests) {
    if (entry.manifest === null) continue;
    const m = entry.manifest;
    const recordPath = activationRecordPath(ctx.store, target.uid, m.name);
    const declaredHere = m.machines.includes(mid);
    if (declaredHere && !fs.existsSync(recordPath)) {
      findings.push({
        kind: "uninstalled-draft",
        machine: mid,
        project: projectName,
        name: m.name,
        detail: `declared for "${mid}" but not activated — run \`projects automation apply ${m.name}\``,
      });
    }
    if (fs.existsSync(recordPath)) {
      const label = plistLabel(target.uid, m.name);
      const plistPath = path.join(ctx.launchd.agentsDir, `${label}.plist`);
      const current = readTextIfExists(plistPath);
      if (current === null) {
        findings.push({
          kind: "plist-missing",
          machine: mid,
          project: projectName,
          name: m.name,
          detail: `activation record exists but ${plistPath} is gone — re-apply or deactivate`,
        });
      } else {
        const wanted = generatePlist({
          projectUid: target.uid,
          manifest: m,
          runnerPath: ctx.runnerPath ?? defaultRunnerPath(),
          nodePath: effectiveNodePath(ctx),
          ...(m.run.directExec ? { workingDirectory: target.canonicalRoot } : {}),
        });
        if (current !== wanted) {
          findings.push({
            kind: "stale-install",
            machine: mid,
            project: projectName,
            name: m.name,
            detail: `installed plist no longer matches the manifest (cadence/exec change) — re-apply`,
          });
        }
        if (!loaded.has(label)) {
          findings.push({
            kind: "not-loaded",
            machine: mid,
            project: projectName,
            name: m.name,
            detail: `plist present but label ${label} is not loaded — re-apply`,
          });
        }
      }
      if (!declaredHere) {
        findings.push({
          kind: "activated-undeclared",
          machine: mid,
          project: projectName,
          name: m.name,
          detail: `active on "${mid}" but machines = [${m.machines.map((x) => `"${x}"`).join(", ")}] — deactivate or declare`,
        });
      }
    }

    // cross-machine: each declared machine's synced registry should show it
    if (wsRoot !== null) {
      for (const remote of m.machines) {
        if (remote === mid) continue;
        const reg = readMachineRegistryRaw(wsRoot, remote);
        const active =
          reg !== null &&
          Array.isArray(reg["activations"]) &&
          reg["activations"].some(
            (a) => isTable(a) && a["project_uid"] === target.uid && a["name"] === m.name,
          );
        if (!active) {
          findings.push({
            kind: "remote-declared-inactive",
            machine: remote,
            project: projectName,
            name: m.name,
            detail:
              reg === null
                ? `declared for "${remote}" but that machine has no registry — apply there`
                : `declared for "${remote}" but its registry shows no activation — apply there`,
          });
        }
      }
    }
  }

  // records → tree: orphans + undeclared activations for OTHER projects too
  for (const { record } of readActivationRecords(ctx.store)) {
    let canonical: string;
    try {
      canonical = resolveUidToCanonical(record.project_uid, ctx.store, ctx.extraWorkspaceRoots ?? []);
    } catch (err) {
      if (err instanceof ResolveError) {
        findings.push({
          kind: "orphan",
          machine: mid,
          project: record.project_uid,
          name: record.name,
          detail: `activation's project UID is unresolvable — \`projects automation prune\` removes it`,
        });
        continue;
      }
      throw err;
    }
    if (canonical !== target.canonicalRoot) continue; // out of this project's scope
    const entry = byName.get(record.name);
    if (entry === undefined) {
      findings.push({
        kind: "activated-undeclared",
        machine: mid,
        project: projectName,
        name: record.name,
        detail: `active on "${mid}" but the definition is gone from the tree — deactivate or prune`,
      });
    }
  }

  // synced registries → tree: other machines running undeclared automations
  if (wsRoot !== null) {
    for (const view of listAllMachinesAt(wsRoot, ctxNow(ctx))) {
      if (view.machineId === mid) continue;
      for (const a of view.activations) {
        if (a.project_uid !== target.uid) continue;
        const entry = byName.get(a.name);
        if (entry !== undefined && entry.manifest === null) continue; // covered by manifest-invalid-active above
        const declared = entry?.manifest?.machines.includes(view.machineId) === true;
        if (!declared) {
          findings.push({
            kind: "remote-activated-undeclared",
            machine: view.machineId,
            project: projectName,
            name: a.name,
            detail:
              entry === undefined
                ? `"${view.machineId}" registry shows an activation whose definition is gone — deactivate there`
                : `"${view.machineId}" registry shows an activation but machines does not declare it — deactivate there or declare`,
          });
        }
      }
    }
  }

  return findings;
}

function readMachineRegistryRaw(workspaceRoot: string, machine: string): TomlTable | null {
  const filePath = path.join(workspaceRoot, MARKER_DIR, "machines", `${machine}.toml`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return readTomlIfExists(filePath);
  } catch {
    return null;
  }
}

function listAllMachinesAt(wsRoot: string, now: Date): MachineRegistryView[] {
  const machinesDir = path.join(wsRoot, MARKER_DIR, "machines");
  let files: string[];
  try {
    files = fs.readdirSync(machinesDir).filter((f) => f.endsWith(".toml")).sort();
  } catch {
    return [];
  }
  const out: MachineRegistryView[] = [];
  for (const file of files) {
    const raw = readMachineRegistryRaw(wsRoot, file.slice(0, -5));
    if (raw === null) continue;
    const hb = typeof raw["heartbeat"] === "string" ? raw["heartbeat"] : null;
    const hbMs = hb !== null ? Date.parse(hb) : Number.NaN;
    const activations: MachineRegistryView["activations"] = [];
    if (Array.isArray(raw["activations"])) {
      for (const a of raw["activations"]) {
        if (!isTable(a) || typeof a["project_uid"] !== "string" || typeof a["name"] !== "string") continue;
        activations.push({
          project_uid: a["project_uid"],
          name: a["name"],
          schedule: typeof a["schedule"] === "string" ? a["schedule"] : "",
        });
      }
    }
    out.push({
      machineId: typeof raw["machine_id"] === "string" ? raw["machine_id"] : file.slice(0, -5),
      heartbeat: hb,
      staleDays: Number.isNaN(hbMs) ? null : Math.floor((now.getTime() - hbMs) / 86_400_000),
      activations,
      lastRuns: [],
    });
  }
  return out;
}

// --- prune ---

export interface PruneResult {
  pruned: Array<{ name: string; project_uid: string; reason: string }>;
  kept: number;
}

/**
 * Remove this machine's dead activations: orphaned UIDs, deleted definitions,
 * and activations the manifest no longer declares for this machine. Each
 * prune unloads the agent, deletes the plist + activation record, and updates
 * this machine's synced registry. Own-machine only (P15).
 */
export function prune(ctx: AutomationContext): PruneResult {
  const mid = machineId(ctx.store);
  const result: PruneResult = { pruned: [], kept: 0 };
  for (const { path: recordPath, record } of readActivationRecords(ctx.store)) {
    let reason: string | null = null;
    let workspaceRoot: string | null = record.workspace_root;
    try {
      const canonical = resolveUidToCanonical(record.project_uid, ctx.store, ctx.extraWorkspaceRoots ?? []);
      workspaceRoot = findWorkspaceRoot(canonical) ?? workspaceRoot;
      const manifestPath = path.join(automationsDir(canonical), record.name, MANIFEST_FILE);
      if (!fs.existsSync(manifestPath)) {
        reason = "definition gone from the tree";
      } else {
        try {
          const m = loadManifest(canonical, record.name);
          if (!m.machines.includes(mid)) reason = `machine "${mid}" no longer declared`;
        } catch {
          reason = null; // invalid manifest: a doctor error, not a prune (intent unclear)
        }
      }
    } catch (err) {
      if (err instanceof ResolveError) reason = "project UID unresolvable (orphan)";
      else throw err;
    }
    if (reason === null) {
      result.kept += 1;
      continue;
    }
    const plistPath = record.plist_path !== "" ? record.plist_path : path.join(ctx.launchd.agentsDir, `${record.label}.plist`);
    if (ctx.launchd.loadedLabels().includes(record.label)) ctx.launchd.unload(plistPath, record.label);
    if (fs.existsSync(plistPath)) fs.unlinkSync(plistPath);
    fs.unlinkSync(recordPath);
    if (workspaceRoot !== null && fs.existsSync(workspaceRoot)) {
      removeRegistryActivation(workspaceRoot, mid, record.project_uid, record.name, ctxNow(ctx));
    }
    result.pruned.push({ name: record.name, project_uid: record.project_uid, reason });
  }
  return result;
}

// --- logs ---

export interface LogsResult {
  name: string;
  /** Machine-partitioned log files, newest last. */
  files: Array<{ machine: string; path: string }>;
  latest: { machine: string; path: string; content: string } | null;
}

export function logsFor(
  ctx: AutomationContext,
  name: string,
  options: { machine?: string } = {},
): LogsResult {
  const target = canonicalTarget(ctx);
  const autoDir = path.join(automationsDir(target.canonicalRoot), name);
  if (!fs.existsSync(autoDir)) throw new NotFoundError(`no automation "${name}" in ${target.canonicalRoot}`);
  const logsDir = path.join(autoDir, "logs");
  const files: Array<{ machine: string; path: string }> = [];
  let machines: string[];
  try {
    machines = fs.readdirSync(logsDir).filter((m) => fs.statSync(path.join(logsDir, m)).isDirectory());
  } catch {
    machines = [];
  }
  for (const machine of machines.sort()) {
    if (options.machine !== undefined && machine !== options.machine) continue;
    let names: string[];
    try {
      names = fs.readdirSync(path.join(logsDir, machine)).filter((f) => f.endsWith(".log"));
    } catch {
      continue;
    }
    for (const f of names.sort()) files.push({ machine, path: path.join(logsDir, machine, f) });
  }
  files.sort((a, b) => path.basename(a.path).localeCompare(path.basename(b.path)));
  const last = files[files.length - 1];
  return {
    name,
    files,
    latest:
      last !== undefined
        ? { machine: last.machine, path: last.path, content: fs.readFileSync(last.path, "utf8") }
        : null,
  };
}

