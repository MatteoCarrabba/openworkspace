/**
 * Automations tests (PRD §7): manifest validation, the PINNED cron DOM/DOW
 * union semantics (the required conformance test), plist late-binding
 * invariants, declared-machines reconciliation (apply / --all / --force),
 * idempotent convergence, deactivate/status/prune/logs, the synced machine
 * registry, and the doctor's automation findings.
 *
 * Everything runs against temp dirs: makeTmpWorkspace + makeTmpStore + the
 * file-backed fake launchd. NOTHING here touches the real ~/Library or real
 * launchctl.
 */

import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import { automationPlacementIssues, doctorProject } from "../src/doctor.js";
import { activationRecordPath, readRunnerNode, writeRunnerNode } from "../src/lib/machine.js";
import { ConfigError } from "../src/lib/errors.js";
import { readTomlIfExists, parseToml, writeToml } from "../src/lib/toml.js";
import { discoverProjects } from "../src/lib/workspace.js";
import {
  AutomationContext,
  CalendarEntry,
  apply,
  compileCron,
  deactivate,
  fileFakeLaunchd,
  generatePlist,
  listAllMachines,
  listAutomations,
  loadManifest,
  logsFor,
  plistLabel,
  prune,
  resolveUidToCanonical,
  scanManifests,
  status,
  validateManifest,
} from "../src/primitives/automations.js";
import { makeTmpDir, makeTmpStore, makeTmpWorkspace, rmrf } from "./helpers.js";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const MACHINE = "testmac";

function makeFixture(configToml?: string) {
  const tmpWs = makeTmpWorkspace(configToml);
  const project = tmpWs.addProject("Auto: Proj A");
  const tmpStore = makeTmpStore();
  fs.writeFileSync(path.join(tmpStore.store.dir, "machine-id"), `${MACHINE}\n`);
  const launchdDir = makeTmpDir("ow-launchd-");
  const launchd = fileFakeLaunchd(launchdDir);
  const ctx: AutomationContext = {
    startDir: project.root,
    store: tmpStore.store,
    launchd,
    runnerPath: "/opt/openworkspace/dist/src/runner.js",
    nodePath: "/usr/local/bin/node",
    extraWorkspaceRoots: [tmpWs.root],
  };
  return {
    ws: tmpWs.ws,
    root: tmpWs.root,
    project,
    store: tmpStore.store,
    launchd,
    launchdDir,
    ctx,
    addProject: tmpWs.addProject,
    cleanup: () => {
      tmpWs.cleanup();
      tmpStore.cleanup();
      rmrf(launchdDir);
    },
  };
}

function writeManifest(projectRoot: string, name: string, toml: string): string {
  const dir = path.join(projectRoot, "_project", "automations", name);
  fs.mkdirSync(dir, { recursive: true });
  const manifestPath = path.join(dir, "automation.toml");
  fs.writeFileSync(manifestPath, toml);
  return manifestPath;
}

const GOOD_MANIFEST = `name = "nightly"
machines = ["${MACHINE}"]

[schedule]
cron = "0 22 * * *"
miss_policy = "skip"

[run]
command = ["/bin/echo", "hi"]
`;

function machineRegistry(wsRoot: string, machine: string): Record<string, unknown> {
  return readTomlIfExists(path.join(wsRoot, ".openworkspace", "machines", `${machine}.toml`));
}

// ---------------------------------------------------------------------------
// Cron compilation — the REQUIRED conformance test (PRD §7.1)
// ---------------------------------------------------------------------------

function sortEntries(entries: CalendarEntry[]): CalendarEntry[] {
  return [...entries].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

test("cron conformance (PRD §7.1): both DOM and DOW restricted ⇒ UNION, never AND", () => {
  // The pinned paragraph: "when both day-of-month and day-of-week are
  // restricted, the job fires when EITHER matches (union/OR — the v0.2
  // compiler implemented AND, a confirmed bug)". `0 9 1 * 1` must mean
  // "9:00 on the 1st OR on any Monday" — two launchd entries, because
  // StartCalendarInterval ANDs keys within one entry.
  assert.deepEqual(sortEntries(compileCron("0 9 1 * 1")), sortEntries([
    { Minute: 0, Hour: 9, Day: 1 },
    { Minute: 0, Hour: 9, Weekday: 1 },
  ]));
  // and the union scales across comma-lists on both sides
  assert.deepEqual(sortEntries(compileCron("30 6 1,15 2 0,3")), sortEntries([
    { Minute: 30, Hour: 6, Month: 2, Day: 1 },
    { Minute: 30, Hour: 6, Month: 2, Day: 15 },
    { Minute: 30, Hour: 6, Month: 2, Weekday: 0 },
    { Minute: 30, Hour: 6, Month: 2, Weekday: 3 },
  ]));
  // single-sided restriction stays a plain product (no phantom union)
  assert.deepEqual(compileCron("0 9 1 * *"), [{ Minute: 0, Hour: 9, Day: 1 }]);
  assert.deepEqual(compileCron("0 9 * * 1"), [{ Minute: 0, Hour: 9, Weekday: 1 }]);
});

test("cron: wildcards, comma lists, DOW-7 normalization, loud rejections", () => {
  assert.deepEqual(compileCron("* * * * *"), [{}]);
  assert.deepEqual(compileCron("0 12,19 * * *"), [
    { Minute: 0, Hour: 12 },
    { Minute: 0, Hour: 19 },
  ]);
  // 0 and 7 are both Sunday; 7 normalizes (and the duplicate collapses)
  assert.deepEqual(compileCron("0 9 * * 7"), [{ Minute: 0, Hour: 9, Weekday: 0 }]);
  assert.deepEqual(compileCron("0 9 * * 0,7"), [{ Minute: 0, Hour: 9, Weekday: 0 }]);

  assert.throws(() => compileCron("0 9 * * 1-5"), /calendar_interval/);
  assert.throws(() => compileCron("*/15 * * * *"), /calendar_interval/);
  assert.throws(() => compileCron("0 24 * * *"), /out of range/);
  assert.throws(() => compileCron("60 9 * * *"), /out of range/);
  assert.throws(() => compileCron("0 9 * *"), /exactly 5 fields/);
});

// ---------------------------------------------------------------------------
// Manifest validation
// ---------------------------------------------------------------------------

test("manifest: a full valid manifest parses with defaults and typed fields", () => {
  const raw = parseToml(`name = "sync"
machines = ["mini", "${MACHINE}"]

[schedule]
cron = "0 6 * * *"
miss_policy = "catch-up"

[run]
command = ["/usr/bin/true"]
timeout_seconds = 600

[secrets]
PLAID_SECRET = "op://AI Secrets/Plaid/secret"

[supervise]
expect_runs_per_day = 1

[signature.inputs]
ledger = { type = "file", path = "Finance/ledger.beancount" }

[signature.outputs]
brief = { type = "api", endpoint = "https://example.com" }
`);
  const { manifest, problems } = validateManifest(raw, { dirName: "sync" });
  assert.deepEqual(problems, []);
  assert.ok(manifest !== null);
  assert.equal(manifest.name, "sync");
  assert.deepEqual(manifest.machines, ["mini", MACHINE]);
  assert.equal(manifest.schedule.cron, "0 6 * * *");
  assert.equal(manifest.schedule.missPolicy, "catch-up");
  assert.equal(manifest.schedule.timezone, null);
  assert.equal(manifest.run.directExec, false);
  assert.equal(manifest.run.timeoutSeconds, 600);
  assert.deepEqual(manifest.secrets, { PLAID_SECRET: "op://AI Secrets/Plaid/secret" });
  assert.equal(manifest.onDormantProject, "stop");
  assert.equal(manifest.signature.inputs[0]?.path, "Finance/ledger.beancount");
  assert.equal(manifest.signature.outputs[0]?.type, "api");
});

test("manifest: calendar_interval (table and array) normalizes to launchd entries", () => {
  const single = validateManifest(
    parseToml(`machines=["m"]\n[schedule]\ncalendar_interval = { hour = 22, minute = 0 }\n[run]\ncommand=["/bin/true"]\n`),
    { dirName: "x" },
  );
  assert.deepEqual(single.manifest?.schedule.calendar, [{ Hour: 22, Minute: 0 }]);
  const multi = validateManifest(
    parseToml(`machines=["m"]\n[schedule]\ncalendar_interval = [{ hour = 9, weekday = 1 }, { hour = 9, weekday = 4 }]\n[run]\ncommand=["/bin/true"]\n`),
    { dirName: "x" },
  );
  assert.deepEqual(multi.manifest?.schedule.calendar, [
    { Hour: 9, Weekday: 1 },
    { Hour: 9, Weekday: 4 },
  ]);
});

test("manifest: every malformed shape is a named problem (validation gates apply)", () => {
  const probe = (toml: string): string[] =>
    validateManifest(parseToml(toml), { dirName: "auto" }).problems.map((p) => p.code);

  // bare secret value = the §7.5 hard error
  assert.ok(probe(`machines=["m"]\n[schedule]\ncron="0 9 * * *"\n[run]\ncommand=["/bin/true"]\n[secrets]\nKEY = "sk-bare-value"\n`).includes("bare-secret"));
  // both cadence shapes / neither
  assert.ok(probe(`machines=["m"]\n[schedule]\ncron="0 9 * * *"\ncalendar_interval={hour=9}\n[run]\ncommand=["/bin/true"]\n`).includes("schedule-shape"));
  assert.ok(probe(`machines=["m"]\n[run]\ncommand=["/bin/true"]\n`).includes("no-schedule"));
  // run / command shape
  assert.ok(probe(`machines=["m"]\n[schedule]\ncron="0 9 * * *"\n`).includes("no-run"));
  assert.ok(probe(`machines=["m"]\n[schedule]\ncron="0 9 * * *"\n[run]\ncommand="not-an-array"\n`).includes("command"));
  // declared placement is required (§7.1)
  assert.ok(probe(`[schedule]\ncron="0 9 * * *"\n[run]\ncommand=["/bin/true"]\n`).includes("no-machines"));
  // name drift
  assert.ok(
    validateManifest(parseToml(`name="other"\nmachines=["m"]\n[schedule]\ncron="0 9 * * *"\n[run]\ncommand=["/bin/true"]\n`), {
      dirName: "auto",
    }).problems.some((p) => p.code === "name-mismatch"),
  );
  // direct_exec cannot carry secrets (no runner to resolve them)
  assert.ok(
    probe(
      `machines=["m"]\n[schedule]\ncron="0 9 * * *"\n[run]\ncommand=["/bin/true"]\ndirect_exec=true\n[secrets]\nK="op://v/i/f"\n`,
    ).includes("direct-exec-secrets"),
  );
  assert.ok(probe(`machines=["m"]\n[schedule]\ncron="0 9 * * *"\nmiss_policy="whenever"\n[run]\ncommand=["/bin/true"]\n`).includes("miss_policy"));
  assert.ok(probe(`machines=["m"]\non_dormant_project="pause"\n[schedule]\ncron="0 9 * * *"\n[run]\ncommand=["/bin/true"]\n`).includes("on_dormant_project"));
  // timezone has NO consumer (launchd fires machine-local) — rejected until
  // implemented, never silently accepted as a no-op key
  const tzProblems = validateManifest(
    parseToml(`machines=["m"]\n[schedule]\ncron="0 9 * * *"\ntimezone="America/New_York"\n[run]\ncommand=["/bin/true"]\n`),
    { dirName: "auto" },
  ).problems;
  assert.ok(tzProblems.some((p) => p.code === "timezone" && /not implemented/.test(p.message)));
});

// ---------------------------------------------------------------------------
// Plist generation — late binding invariants
// ---------------------------------------------------------------------------

test("plist: references runner + UID + name — NEVER a project path, never a secret value", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  writeManifest(
    fx.project.root,
    "nightly",
    `name = "nightly"\nmachines = ["${MACHINE}"]\n[schedule]\ncron = "0 9 1 * 1"\n[run]\ncommand = ["/bin/echo", "hi"]\n[secrets]\nTOKEN = "op://Vault/item/field"\n`,
  );
  const manifest = loadManifest(fx.project.root, "nightly");
  const content = generatePlist({
    projectUid: fx.project.uid,
    manifest,
    runnerPath: "/opt/ow/runner.js",
    nodePath: "/usr/local/bin/node",
  });
  assert.match(content, new RegExp(plistLabel(fx.project.uid, "nightly")));
  assert.match(content, /\/opt\/ow\/runner\.js/);
  assert.match(content, new RegExp(fx.project.uid));
  assert.match(content, /<string>--name<\/string>\n\t\t<string>nightly<\/string>/);
  // the load-bearing negatives: no project filesystem path, no command
  // baked (late binding reads the manifest at fire time), no secret material
  assert.ok(!content.includes(fx.project.root), "plist must not contain the project path");
  assert.ok(!content.includes("/bin/echo"), "normal mode never bakes the command");
  assert.ok(!content.includes("op://"), "plist must not contain secret pointers or values");
  // the §7.1-union cadence landed as an ARRAY of calendar dicts
  assert.match(content, /<key>StartCalendarInterval<\/key>\n\t<array>/);
  assert.match(content, /<key>Day<\/key><integer>1<\/integer>/);
  assert.match(content, /<key>Weekday<\/key><integer>1<\/integer>/);
});

test("plist: direct_exec mode bakes the command + WorkingDirectory (the documented §7.4 fallback)", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  writeManifest(
    fx.project.root,
    "tcc",
    `machines = ["${MACHINE}"]\n[schedule]\ncron = "0 9 * * *"\n[run]\ncommand = ["/usr/local/bin/tool", "--flag"]\ndirect_exec = true\n`,
  );
  const manifest = loadManifest(fx.project.root, "tcc");
  const content = generatePlist({
    projectUid: fx.project.uid,
    manifest,
    runnerPath: "/opt/ow/runner.js",
    nodePath: "/usr/local/bin/node",
    workingDirectory: fx.project.root,
  });
  assert.match(content, /<string>\/usr\/local\/bin\/tool<\/string>/);
  assert.match(content, /<string>--flag<\/string>/);
  assert.ok(content.includes(`<string>${fx.project.root}</string>`)); // baked, by design
  assert.ok(!content.includes("runner.js"), "direct_exec bypasses the runner");
  // single cadence entry renders as a dict, not an array
  assert.match(content, /<key>StartCalendarInterval<\/key>\n\t<dict>/);
});

// ---------------------------------------------------------------------------
// Runner-node (decision-1, PRD §7.4): the machine-store-configured node is
// ProgramArguments[0]; unset = process.execPath fallback + an apply WARNING
// ---------------------------------------------------------------------------

/** A fake "official pkg node": an existing executable file in a temp dir. */
function makeFakeNodeBin(t: { after: (fn: () => void) => void }): string {
  const dir = makeTmpDir("ow-runner-node-");
  t.after(() => rmrf(dir));
  const bin = path.join(dir, "node");
  fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(bin, 0o755);
  return bin;
}

test("runner-node: configured binary is ProgramArguments[0]; unset falls back to process.execPath WITH a warning", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  writeManifest(fx.project.root, "nightly", GOOD_MANIFEST);
  // exercise the store-backed chain, not the fixture's test injection
  const ctx: AutomationContext = { ...fx.ctx };
  delete ctx.nodePath;

  // unset → the plist bakes the node that ran apply, and the summary warns
  const fallback = apply(ctx, { name: "nightly" });
  assert.equal(fallback.warnings.length, 1);
  assert.match(fallback.warnings[0] ?? "", /no runner-node configured/);
  assert.match(fallback.warnings[0] ?? "", /projects home runner-node/);
  const plistPath = fallback.applied[0]?.plistPath as string;
  assert.ok(
    fs.readFileSync(plistPath, "utf8").includes(`<string>${process.execPath}</string>`),
    "unset runner-node must fall back to process.execPath",
  );

  // configure → status/list see the SAME resolution chain: install now stale
  const nodeBin = makeFakeNodeBin(t);
  writeRunnerNode(fx.store, nodeBin);
  assert.equal(readRunnerNode(fx.store), nodeBin);
  assert.deepEqual(status(ctx).map((f) => f.kind), ["stale-install"]);
  assert.equal(listAutomations(ctx).find((e) => e.name === "nightly")?.localState, "stale");

  // re-apply regenerates with the configured node — and stops warning
  const configured = apply(ctx, { name: "nightly" });
  assert.equal(configured.applied[0]?.action, "regenerated");
  assert.deepEqual(configured.warnings, []);
  const content = fs.readFileSync(plistPath, "utf8");
  assert.ok(content.includes(`<string>${nodeBin}</string>`), "plist must invoke the configured runner-node");
  assert.ok(!content.includes(`<string>${process.execPath}</string>`));
  assert.deepEqual(status(ctx), [], "re-applied install is clean again");

  // clear → the fallback (and its warning) is back on the next apply
  writeRunnerNode(fx.store, null);
  const cleared = apply(ctx, { name: "nightly" });
  assert.equal(cleared.applied[0]?.action, "regenerated");
  assert.equal(cleared.warnings.length, 1);
  assert.ok(fs.readFileSync(plistPath, "utf8").includes(`<string>${process.execPath}</string>`));
});

test("runner-node: direct_exec applies never warn (no runner in that path); explicit nodePath injection outranks the store", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  writeManifest(
    fx.project.root,
    "tcc",
    `machines = ["${MACHINE}"]\n[schedule]\ncron = "0 9 * * *"\n[run]\ncommand = ["/usr/local/bin/tool"]\ndirect_exec = true\n`,
  );
  const ctx: AutomationContext = { ...fx.ctx };
  delete ctx.nodePath;
  // direct_exec with no runner-node configured: the plist has no node at all
  const direct = apply(ctx, { name: "tcc" });
  assert.deepEqual(direct.warnings, []);

  // an explicitly injected nodePath (tests/tools) outranks the store
  writeManifest(fx.project.root, "nightly", GOOD_MANIFEST);
  const nodeBin = makeFakeNodeBin(t);
  writeRunnerNode(fx.store, nodeBin);
  const injected = apply(fx.ctx, { name: "nightly" }); // fixture ctx injects nodePath
  assert.deepEqual(injected.warnings, []);
  const content = fs.readFileSync(injected.applied[0]?.plistPath as string, "utf8");
  assert.ok(content.includes("<string>/usr/local/bin/node</string>"));
  assert.ok(!content.includes(nodeBin));
});

// ---------------------------------------------------------------------------
// apply — declared-machines reconciliation + idempotent convergence
// ---------------------------------------------------------------------------

test("apply: errors when this machine is undeclared; --force overrides and marks it", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  writeManifest(fx.project.root, "minionly", `machines = ["mini"]\n[schedule]\ncron = "0 9 * * *"\n[run]\ncommand = ["/bin/true"]\n`);
  assert.throws(() => apply(fx.ctx, { name: "minionly" }), (err: unknown) => {
    assert.ok(err instanceof ConfigError);
    assert.match(err.message, /does not declare this machine \("testmac"/);
    assert.match(err.message, /--force/);
    return true;
  });
  const forced = apply(fx.ctx, { name: "minionly", force: true });
  assert.equal(forced.applied[0]?.action, "installed");
  assert.equal(forced.applied[0]?.forced, true);
  assert.ok(fs.existsSync(forced.applied[0]?.plistPath as string));
});

test("apply: idempotent convergence — install, no-op, regenerate-on-cadence-change", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  writeManifest(fx.project.root, "nightly", GOOD_MANIFEST);

  const first = apply(fx.ctx, { name: "nightly" });
  assert.equal(first.applied[0]?.action, "installed");
  const label = first.applied[0]?.label as string;
  const plistPath = first.applied[0]?.plistPath as string;
  assert.ok(fs.existsSync(plistPath));
  assert.deepEqual(fx.launchd.loadedLabels(), [label]);
  // activation record landed in the machine-local store
  const recordPath = activationRecordPath(fx.store, fx.project.uid, "nightly");
  const record = readTomlIfExists(recordPath);
  assert.equal(record["machine_id"], MACHINE);
  assert.equal(record["schedule"], "cron 0 22 * * *");
  // ... and the activation is reported in THIS machine's synced registry
  const reg = machineRegistry(fx.root, MACHINE);
  assert.equal(reg["machine_id"], MACHINE);
  const acts = reg["activations"] as Array<Record<string, unknown>>;
  assert.equal(acts.length, 1);
  assert.equal(acts[0]?.["name"], "nightly");
  assert.equal(acts[0]?.["project_uid"], fx.project.uid);

  // unchanged manifest → pure no-op (same plist bytes, no reload)
  const before = fs.readFileSync(plistPath, "utf8");
  const second = apply(fx.ctx, { name: "nightly" });
  assert.equal(second.applied[0]?.action, "unchanged");
  assert.equal(fs.readFileSync(plistPath, "utf8"), before);
  const ops1 = fs.readFileSync(path.join(fx.launchdDir, ".ops.jsonl"), "utf8").trim().split("\n");
  assert.equal(ops1.length, 1, "no-op apply must not touch launchd");

  // cadence change → regenerate + reload through the adapter
  writeManifest(fx.project.root, "nightly", GOOD_MANIFEST.replace("0 22 * * *", "30 5 * * *"));
  const third = apply(fx.ctx, { name: "nightly" });
  assert.equal(third.applied[0]?.action, "regenerated");
  assert.match(fs.readFileSync(plistPath, "utf8"), /<integer>5<\/integer>/);
  const ops2 = fs.readFileSync(path.join(fx.launchdDir, ".ops.jsonl"), "utf8").trim().split("\n");
  assert.deepEqual(
    ops2.map((l) => (JSON.parse(l) as { op: string }).op),
    ["load", "unload", "load"],
  );
});

test("apply --all: converges THIS machine to its declared set", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  writeManifest(fx.project.root, "a-here", GOOD_MANIFEST.replace('name = "nightly"', 'name = "a-here"'));
  writeManifest(fx.project.root, "b-elsewhere", `machines = ["mini"]\n[schedule]\ncron = "0 9 * * *"\n[run]\ncommand = ["/bin/true"]\n`);
  writeManifest(fx.project.root, "c-broken", `machines = ["${MACHINE}"]\n[schedule]\ncron = "every day"\n[run]\ncommand = ["/bin/true"]\n`);

  const result = apply(fx.ctx, { all: true });
  assert.deepEqual(result.applied.map((r) => [r.name, r.action]), [["a-here", "installed"]]);
  assert.deepEqual(result.skippedUndeclared, ["b-elsewhere"]);
  assert.deepEqual(result.invalid.map((i) => i.name), ["c-broken"]);
  // converging again is a no-op
  const again = apply(fx.ctx, { all: true });
  assert.deepEqual(again.applied.map((r) => r.action), ["unchanged"]);
});

test("apply from a worktree-shaped start dir registers the CANONICAL definition", (t) => {
  // resolveCanonicalProject is regression-tested against real worktrees in
  // resolve.test.ts; here we assert apply ROUTES through it: starting from a
  // subdirectory still lands the activation on the canonical project root.
  const fx = makeFixture();
  t.after(fx.cleanup);
  writeManifest(fx.project.root, "nightly", GOOD_MANIFEST);
  const sub = path.join(fx.project.root, "deep", "inside");
  fs.mkdirSync(sub, { recursive: true });
  const result = apply({ ...fx.ctx, startDir: sub }, { name: "nightly" });
  assert.equal(result.applied[0]?.action, "installed");
  const record = readTomlIfExists(activationRecordPath(fx.store, fx.project.uid, "nightly"));
  assert.equal(record["project_uid"], fx.project.uid);
  assert.equal(record["workspace_root"], fx.root);
});

// ---------------------------------------------------------------------------
// deactivate / status / prune / logs / list
// ---------------------------------------------------------------------------

test("deactivate: unloads, removes plist + activation record + registry entry", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  writeManifest(fx.project.root, "nightly", GOOD_MANIFEST);
  const applied = apply(fx.ctx, { name: "nightly" });
  const plistPath = applied.applied[0]?.plistPath as string;

  const result = deactivate(fx.ctx, "nightly");
  assert.equal(result.removedPlist, true);
  assert.equal(result.removedRecord, true);
  assert.ok(!fs.existsSync(plistPath));
  assert.deepEqual(fx.launchd.loadedLabels(), []);
  assert.ok(!fs.existsSync(activationRecordPath(fx.store, fx.project.uid, "nightly")));
  const reg = machineRegistry(fx.root, MACHINE);
  assert.equal(reg["activations"], undefined);
  // idempotent: a second deactivate is a clean no-op
  const again = deactivate(fx.ctx, "nightly");
  assert.equal(again.removedPlist, false);
});

test("status: stale-install, uninstalled-draft, orphan, placement drift in both directions", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  writeManifest(fx.project.root, "nightly", GOOD_MANIFEST);

  // declared-but-not-activated (uninstalled-draft)
  let findings = status(fx.ctx);
  assert.deepEqual(findings.map((f) => f.kind), ["uninstalled-draft"]);

  // applied → clean
  apply(fx.ctx, { name: "nightly" });
  assert.deepEqual(status(fx.ctx), []);

  // cadence edit without re-apply → stale-install
  writeManifest(fx.project.root, "nightly", GOOD_MANIFEST.replace("0 22 * * *", "0 4 * * *"));
  findings = status(fx.ctx);
  assert.deepEqual(findings.map((f) => f.kind), ["stale-install"]);
  apply(fx.ctx, { name: "nightly" }); // back to clean
  assert.deepEqual(status(fx.ctx), []);

  // placement drift, activated side: manifest stops declaring this machine
  writeManifest(fx.project.root, "nightly", GOOD_MANIFEST.replace(`machines = ["${MACHINE}"]`, `machines = ["mini"]`));
  findings = status(fx.ctx);
  const kinds = findings.map((f) => f.kind).sort();
  assert.ok(kinds.includes("activated-undeclared"), `got ${kinds.join(",")}`);
  // ... and declared side: mini has no registry → remote-declared-inactive
  assert.ok(kinds.includes("remote-declared-inactive"), `got ${kinds.join(",")}`);

  // orphan: an activation record whose UID resolves nowhere
  writeToml(activationRecordPath(fx.store, "00000000-dead-dead-dead-000000000000", "ghost"), {
    project_uid: "00000000-dead-dead-dead-000000000000",
    name: "ghost",
    machine_id: MACHINE,
    label: "com.openworkspace.dead.ghost",
    plist_path: path.join(fx.launchdDir, "com.openworkspace.dead.ghost.plist"),
    applied_at: "2026-01-01T00:00:00Z",
    direct_exec: false,
    schedule: "cron 0 9 * * *",
  });
  findings = status(fx.ctx);
  assert.ok(findings.some((f) => f.kind === "orphan" && f.name === "ghost"));

  // a remote machine's registry claiming an activation the manifest does not
  // declare for it → remote-activated-undeclared
  writeToml(path.join(fx.root, ".openworkspace", "machines", "rogue.toml"), {
    machine_id: "rogue",
    heartbeat: "2026-06-10T00:00:00Z",
    activations: [{ project_uid: fx.project.uid, name: "nightly", label: "x", applied_at: "x", schedule: "x" }],
  });
  findings = status(fx.ctx);
  assert.ok(findings.some((f) => f.kind === "remote-activated-undeclared" && f.machine === "rogue"));
});

test("prune: removes orphans + undeclared + definition-gone; keeps healthy activations", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  writeManifest(fx.project.root, "keepme", GOOD_MANIFEST.replace('name = "nightly"', 'name = "keepme"'));
  writeManifest(fx.project.root, "dropme", GOOD_MANIFEST.replace('name = "nightly"', 'name = "dropme"'));
  apply(fx.ctx, { all: true });
  // dropme's definition disappears from the tree
  rmrf(path.join(fx.project.root, "_project", "automations", "dropme"));
  // plus a hand-planted orphan
  writeToml(activationRecordPath(fx.store, "00000000-dead-dead-dead-000000000000", "ghost"), {
    project_uid: "00000000-dead-dead-dead-000000000000",
    name: "ghost",
    machine_id: MACHINE,
    label: "com.openworkspace.dead.ghost",
    plist_path: path.join(fx.launchdDir, "com.openworkspace.dead.ghost.plist"),
    applied_at: "2026-01-01T00:00:00Z",
    direct_exec: false,
    schedule: "cron 0 9 * * *",
  });

  const result = prune(fx.ctx);
  assert.equal(result.kept, 1);
  assert.deepEqual(result.pruned.map((p) => p.name).sort(), ["dropme", "ghost"]);
  assert.ok(fs.existsSync(activationRecordPath(fx.store, fx.project.uid, "keepme")));
  assert.ok(!fs.existsSync(activationRecordPath(fx.store, fx.project.uid, "dropme")));
  assert.deepEqual(fx.launchd.loadedLabels(), [plistLabel(fx.project.uid, "keepme")]);
  // the synced registry now reports only the survivor
  const acts = machineRegistry(fx.root, MACHINE)["activations"] as Array<Record<string, unknown>>;
  assert.deepEqual(acts.map((a) => a["name"]), ["keepme"]);
});

test("list: local definition view; list --all renders every machine's registry with staleness", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  writeManifest(fx.project.root, "nightly", GOOD_MANIFEST);
  writeManifest(fx.project.root, "elsewhere", `machines = ["mini"]\n[schedule]\ncron = "0 9 * * *"\n[run]\ncommand = ["/bin/true"]\n`);

  let entries = listAutomations(fx.ctx);
  assert.deepEqual(entries.map((e) => [e.name, e.localState]), [
    ["elsewhere", "undeclared"],
    ["nightly", "not-applied"],
  ]);
  apply(fx.ctx, { name: "nightly" });
  entries = listAutomations(fx.ctx);
  assert.equal(entries.find((e) => e.name === "nightly")?.localState, "active");

  const now = new Date();
  const stale = new Date(now.getTime() - 10 * 86_400_000);
  writeToml(path.join(fx.root, ".openworkspace", "machines", "mini.toml"), {
    machine_id: "mini",
    heartbeat: stale.toISOString(),
    activations: [],
  });
  const machines = listAllMachines({ ...fx.ctx, now: () => now });
  const mini = machines.find((m) => m.machineId === "mini");
  assert.equal(mini?.staleDays, 10);
  const self = machines.find((m) => m.machineId === MACHINE);
  assert.equal(self?.activations.length, 1);
  assert.equal(self?.staleDays, 0);
});

test("logs: machine-partitioned files, lexical ordering, machine filter", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  writeManifest(fx.project.root, "nightly", GOOD_MANIFEST);
  const logsDir = path.join(fx.project.root, "_project", "automations", "nightly", "logs");
  fs.mkdirSync(path.join(logsDir, MACHINE), { recursive: true });
  fs.mkdirSync(path.join(logsDir, "mini"), { recursive: true });
  fs.writeFileSync(path.join(logsDir, MACHINE, "20260601T000000Z.log"), "old local\n");
  fs.writeFileSync(path.join(logsDir, "mini", "20260609T000000Z.log"), "newer mini\n");

  const all = logsFor(fx.ctx, "nightly");
  assert.equal(all.files.length, 2);
  assert.equal(all.latest?.machine, "mini");
  assert.match(all.latest?.content ?? "", /newer mini/);

  const filtered = logsFor(fx.ctx, "nightly", { machine: MACHINE });
  assert.equal(filtered.files.length, 1);
  assert.match(filtered.latest?.content ?? "", /old local/);
});

test("resolveUidToCanonical: cache hit, rescan, and the loud orphan error", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  // no cache yet → bounded rescan of the extra root finds it (and caches)
  const found = resolveUidToCanonical(fx.project.uid, fx.store, [fx.root]);
  assert.equal(found, fx.project.root);
  // cache path now serves it with no extra roots
  assert.equal(resolveUidToCanonical(fx.project.uid, fx.store, []), fx.project.root);
  assert.throws(
    () => resolveUidToCanonical("11111111-1111-1111-1111-111111111111", fx.store, [fx.root]),
    /cannot resolve canonical location/,
  );
});

// ---------------------------------------------------------------------------
// Doctor: manifest validation findings, [signature] paths, placement drift
// ---------------------------------------------------------------------------

test("doctor: manifest validation errors + [signature] path checks surface from doctorProject", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  writeManifest(fx.project.root, "broken", `machines = ["${MACHINE}"]\n[schedule]\ncron = "*/5 * * * *"\n`);
  writeManifest(
    fx.project.root,
    "sigcheck",
    `machines = ["${MACHINE}"]\n[schedule]\ncron = "0 9 * * *"\n[run]\ncommand = ["/bin/true"]\n` +
      `[signature.inputs]\nledger = { type = "file", path = "Data/ledger.beancount" }\n` +
      `present = { type = "file", path = "Auto: Proj A/_project/id" }\n`,
  );
  const issues = doctorProject(fx.project.root);
  // the broken manifest's problems are ERRORS (validation as enforcement)
  assert.ok(issues.some((i) => i.severity === "error" && /calendar_interval/.test(i.message)));
  assert.ok(issues.some((i) => i.severity === "error" && /\[run\]|missing \[run\]/.test(i.message)));
  // missing signature path warns; the existing one stays quiet
  const sigWarns = issues.filter((i) => /\[signature\] path missing/.test(i.message));
  assert.equal(sigWarns.length, 1);
  assert.match(sigWarns[0]?.message ?? "", /Data\/ledger\.beancount/);
});

test("doctor: placement drift + orphaned activations read from the synced registries", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  writeManifest(fx.project.root, "nightly", GOOD_MANIFEST.replace(`machines = ["${MACHINE}"]`, `machines = ["${MACHINE}", "mini"]`));
  // this machine activates; mini never does
  apply(fx.ctx, { name: "nightly" });
  // a third machine's registry claims an activation nobody declared for it,
  // plus one for a UID that resolves nowhere in the workspace
  writeToml(path.join(fx.root, ".openworkspace", "machines", "rogue.toml"), {
    machine_id: "rogue",
    heartbeat: new Date().toISOString(),
    activations: [
      { project_uid: fx.project.uid, name: "nightly", label: "x", applied_at: "x", schedule: "x" },
      { project_uid: "22222222-2222-2222-2222-222222222222", name: "ghost", label: "y", applied_at: "y", schedule: "y" },
    ],
  });

  const projects = discoverProjects(fx.ws, { all: true });
  const issues = automationPlacementIssues(fx.ws, projects);
  assert.ok(issues.every((i) => i.severity === "warn"), "doctor proposes; placement drift is warn");
  // declared-but-not-activated: mini
  assert.ok(issues.some((i) => /declares machine "mini"|declared for "mini"/.test(i.message)));
  // activated-but-undeclared: rogue
  assert.ok(issues.some((i) => /active on "rogue"/.test(i.message)));
  // orphan: the dead UID
  assert.ok(issues.some((i) => /orphaned activation: "ghost"/.test(i.message)));
  // and the locally-applied machine is NOT flagged in either drift direction
  assert.ok(
    !issues.some((i) =>
      new RegExp(`(declares machine|declared for|active on) "${MACHINE}"`).test(i.message),
    ),
  );
});

test("doctor: an active automation whose manifest is present-but-INVALID is never misdiagnosed as 'definition gone'", (t) => {
  // Regression: editing a live automation's manifest into an invalid state
  // (e.g. a bare [secrets] value) used to make doctor report 'its definition
  // is gone from the tree — deactivate' — a false diagnosis whose proposed
  // remediation would tear down a live activation over a one-line TOML typo.
  const fx = makeFixture();
  t.after(fx.cleanup);
  writeManifest(fx.project.root, "cal-shape", GOOD_MANIFEST.replace('name = "nightly"', 'name = "cal-shape"'));
  apply(fx.ctx, { name: "cal-shape" });
  // now corrupt the manifest: a bare secret value (the §7.5 hard error)
  writeManifest(
    fx.project.root,
    "cal-shape",
    GOOD_MANIFEST.replace('name = "nightly"', 'name = "cal-shape"') + `\n[secrets]\nKEY = "sk-bare"\n`,
  );

  const projects = discoverProjects(fx.ws, { all: true });
  const issues = automationPlacementIssues(fx.ws, projects);
  assert.ok(
    !issues.some((i) => /definition is gone from the tree/.test(i.message)),
    `false 'gone from the tree' diagnosis: ${JSON.stringify(issues)}`,
  );
  const invalid = issues.filter((i) => /present-but-INVALID/.test(i.message));
  assert.equal(invalid.length, 1);
  assert.equal(invalid[0]?.severity, "warn");
  assert.match(invalid[0]?.message ?? "", /do NOT deactivate/);
  assert.match(invalid[0]?.file ?? "", /automations[/\\]cal-shape[/\\]automation\.toml$/);
  // a TRULY deleted definition still gets the orphan message
  rmrf(path.join(fx.project.root, "_project", "automations", "cal-shape"));
  const issues2 = automationPlacementIssues(fx.ws, discoverProjects(fx.ws, { all: true }));
  assert.ok(issues2.some((i) => /definition is gone from the tree/.test(i.message)));
});

test("status: active-but-INVALID manifest is VISIBLE — locally and via a remote registry", (t) => {
  // Regression: status's tree→records loop skipped manifest === null entries
  // entirely, so 'active here but will hard-fail at every fire' was a drift
  // class no status kind covered.
  const fx = makeFixture();
  t.after(fx.cleanup);
  writeManifest(fx.project.root, "cal-shape", GOOD_MANIFEST.replace('name = "nightly"', 'name = "cal-shape"'));
  apply(fx.ctx, { name: "cal-shape" });
  assert.ok(!status(fx.ctx).some((f) => f.kind === "manifest-invalid-active"), "healthy install is quiet");

  writeManifest(
    fx.project.root,
    "cal-shape",
    GOOD_MANIFEST.replace('name = "nightly"', 'name = "cal-shape"') + `\n[secrets]\nKEY = "sk-bare"\n`,
  );
  const local = status(fx.ctx).filter((f) => f.kind === "manifest-invalid-active");
  assert.equal(local.length, 1);
  assert.equal(local[0]?.machine, MACHINE);
  assert.match(local[0]?.detail ?? "", /INVALID/);
  assert.match(local[0]?.detail ?? "", /every fire will fail/);

  // a remote machine's synced registry showing the same activation is flagged too
  writeToml(path.join(fx.root, ".openworkspace", "machines", "mini.toml"), {
    machine_id: "mini",
    heartbeat: new Date().toISOString(),
    activations: [{ project_uid: fx.project.uid, name: "cal-shape", label: "x", applied_at: "x", schedule: "x" }],
  });
  const remote = status(fx.ctx).filter((f) => f.kind === "manifest-invalid-active" && f.machine === "mini");
  assert.equal(remote.length, 1);
  // and it is NOT double-reported as remote-activated-undeclared
  assert.ok(!status(fx.ctx).some((f) => f.kind === "remote-activated-undeclared" && f.name === "cal-shape"));
});

test("doctor: miss_policy beyond 'skip' warns that fire-time enforcement is not implemented", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  writeManifest(fx.project.root, "nightly", GOOD_MANIFEST.replace('miss_policy = "skip"', 'miss_policy = "fail-loud"'));
  const issues = doctorProject(fx.project.root);
  const warns = issues.filter((i) => /miss_policy = "fail-loud" is recorded/.test(i.message));
  assert.equal(warns.length, 1);
  assert.equal(warns[0]?.severity, "warn");
  // the default stays quiet
  writeManifest(fx.project.root, "nightly", GOOD_MANIFEST);
  assert.ok(!doctorProject(fx.project.root).some((i) => /miss_policy/.test(i.message)));
});

// ---------------------------------------------------------------------------
// CLI end-to-end (subprocess; fake launchd via OPENWORKSPACE_LAUNCHD_DIR)
// ---------------------------------------------------------------------------

const CLI = path.resolve(__dirname, "..", "src", "cli.js");

function runCli(args: string[], cwd: string, env: Record<string, string>) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

test("cli: automation apply/list/status/run-now/deactivate against the fake launchd", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  const env = {
    OPENWORKSPACE_STORE_DIR: fx.store.dir,
    OPENWORKSPACE_LAUNCHD_DIR: fx.launchdDir,
  };
  const marker = path.join(fx.project.root, "ran.txt");
  writeManifest(
    fx.project.root,
    "nightly",
    `name = "nightly"\nmachines = ["${MACHINE}"]\n[schedule]\ncron = "0 22 * * *"\n[run]\ncommand = ${JSON.stringify([
      process.execPath,
      "-e",
      `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran via ' + process.cwd())`,
    ])}\n`,
  );

  const applied = runCli(["automation", "apply", "nightly", "--json"], fx.project.root, env);
  assert.equal(applied.status, 0, applied.stderr);
  const summary = JSON.parse(applied.stdout) as {
    applied: Array<{ action: string; label: string }>;
    warnings: string[];
  };
  assert.equal(summary.applied[0]?.action, "installed");
  assert.ok(fs.existsSync(path.join(fx.launchdDir, `${summary.applied[0]?.label}.plist`)));
  // no runner-node configured in this store → the decision-1 fallback warning
  assert.equal(summary.warnings.length, 1);
  assert.match(summary.warnings[0] ?? "", /no runner-node configured/);
  const reapplied = runCli(["automation", "apply", "nightly"], fx.project.root, env);
  assert.equal(reapplied.status, 0, reapplied.stderr);
  assert.match(reapplied.stdout, /WARNING: no runner-node configured/);

  const list = runCli(["automation", "list", "--json"], fx.project.root, env);
  assert.equal(list.status, 0, list.stderr);
  assert.equal((JSON.parse(list.stdout) as Array<{ localState: string }>)[0]?.localState, "active");

  const st = runCli(["automation", "status", "--json"], fx.project.root, env);
  assert.equal(st.status, 0, st.stderr);
  assert.deepEqual(JSON.parse(st.stdout), []);

  const run = runCli(["automation", "run-now", "nightly", "--json"], fx.project.root, env);
  assert.equal(run.status, 0, run.stderr);
  const outcome = JSON.parse(run.stdout) as { status: string; logPath: string };
  assert.equal(outcome.status, "ok");
  assert.ok(fs.existsSync(marker), "run-now must execute the command");
  assert.match(fs.readFileSync(marker, "utf8"), /ran via /);
  assert.ok(outcome.logPath.includes(path.join("logs", MACHINE)));

  const off = runCli(["automation", "deactivate", "nightly"], fx.project.root, env);
  assert.equal(off.status, 0, off.stderr);
  assert.match(off.stdout, /deactivated nightly/);

  const unknown = runCli(["automation", "frobnicate"], fx.project.root, env);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown automation subcommand/);
});

test("cli: automation apply without name or --all is a usage error; undeclared exits 1", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  const env = { OPENWORKSPACE_STORE_DIR: fx.store.dir, OPENWORKSPACE_LAUNCHD_DIR: fx.launchdDir };
  writeManifest(fx.project.root, "minionly", `machines = ["mini"]\n[schedule]\ncron = "0 9 * * *"\n[run]\ncommand = ["/bin/true"]\n`);

  const bare = runCli(["automation", "apply"], fx.project.root, env);
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /usage: projects automation apply/);

  const undeclared = runCli(["automation", "apply", "minionly"], fx.project.root, env);
  assert.equal(undeclared.status, 1);
  assert.match(undeclared.stderr, /does not declare this machine/);

  const forced = runCli(["automation", "apply", "minionly", "--force", "--json"], fx.project.root, env);
  assert.equal(forced.status, 0, forced.stderr);
});

// sanity: scanManifests is what `apply --all` + doctor share — a dir without
// a manifest is not an automation, an unparseable one carries its problem
test("scanManifests: skips non-automation dirs; reports TOML/validation problems", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  fs.mkdirSync(path.join(fx.project.root, "_project", "automations", "logs-only", "logs"), { recursive: true });
  writeManifest(fx.project.root, "bad-toml", "machines = [unclosed\n");
  writeManifest(fx.project.root, "good", GOOD_MANIFEST.replace('name = "nightly"', 'name = "good"'));
  const entries = scanManifests(fx.project.root);
  assert.deepEqual(entries.map((e) => e.name), ["bad-toml", "good"]);
  assert.equal(entries[0]?.manifest, null);
  assert.ok((entries[0]?.problems.length ?? 0) > 0);
  assert.ok(entries[1]?.manifest !== null);
});
