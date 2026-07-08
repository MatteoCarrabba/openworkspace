/**
 * Runner tests (PRD §7.1 late binding + §7.5 secrets): UID → canonical
 * resolution at fire time, on_dormant_project, per-run secret resolution
 * through configured scheme resolvers (env-only — the tests grep every
 * written artifact to prove nothing lands on disk), machine-partitioned logs
 * with retention, and last-run outcomes appended to THIS machine's synced
 * registry file only (P15).
 *
 * Temp dirs only; no real ~/Library, no launchd (the runner never talks to
 * launchd at all — launchd talks to IT).
 */

import * as assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import { ConfigError, ResolveError } from "../src/lib/errors.js";
import { readTomlIfExists } from "../src/lib/toml.js";
import { writeDeclaredLifecycle } from "../src/lib/workspace.js";
import { acquireLease, readAttempt, readLease, readRunState } from "../src/primitives/automation-runs.js";
import { LOG_RETENTION, applyLogRetention, runAutomation } from "../src/runner.js";
import { makeTmpDir, makeTmpStore, makeTmpWorkspace, rmrf } from "./helpers.js";

const MACHINE = "runmach";
const SECRET_VALUE = "SEKRET-VALUE-9b1c44";

function makeFixture(options: { configToml?: string; projectRel?: string } = {}) {
  const tmpWs = makeTmpWorkspace(options.configToml);
  const project = tmpWs.addProject(options.projectRel ?? "Run: Proj A");
  const tmpStore = makeTmpStore();
  fs.writeFileSync(path.join(tmpStore.store.dir, "machine-id"), `${MACHINE}\n`);
  return {
    root: tmpWs.root,
    project,
    store: tmpStore.store,
    addProject: tmpWs.addProject,
    cleanup: () => {
      tmpWs.cleanup();
      tmpStore.cleanup();
    },
  };
}

function writeManifest(projectRoot: string, name: string, toml: string): void {
  const dir = path.join(projectRoot, "_project", "automations", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "automation.toml"), toml);
}

function nodeCommandToml(script: string, extra = ""): string {
  return (
    `machines = ["${MACHINE}"]\n[schedule]\ncron = "0 9 * * *"\n[run]\n` +
    `command = ${JSON.stringify([process.execPath, "-e", script])}\n${extra}`
  );
}

function logFiles(projectRoot: string, name: string, machine = MACHINE): string[] {
  const dir = path.join(projectRoot, "_project", "automations", name, "logs", machine);
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".log"))
      .sort()
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

function registry(wsRoot: string): Record<string, unknown> {
  return readTomlIfExists(path.join(wsRoot, ".openworkspace", "machines", `${MACHINE}.toml`));
}

function lastRun(wsRoot: string, uid: string, name: string): Record<string, unknown> {
  const lastRuns = registry(wsRoot)["last_runs"] as Record<string, unknown> | undefined;
  return (lastRuns?.[`${uid}--${name}`] ?? {}) as Record<string, unknown>;
}

/** Every file under `root`, read as UTF-8 (the no-secret-on-disk sweep). */
function grepTree(root: string, needle: string): string[] {
  const hits: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile() && fs.readFileSync(full, "utf8").includes(needle)) hits.push(full);
    }
  };
  walk(root);
  return hits;
}

// ---------------------------------------------------------------------------

test("runner: resolves UID → canonical, cds there, logs machine-partitioned, records the outcome", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  writeManifest(
    fx.project.root,
    "hello",
    nodeCommandToml(`console.log('hello-from ' + process.cwd()); console.error('warn-line')`),
  );
  const outcome = runAutomation({
    uid: fx.project.uid,
    name: "hello",
    store: fx.store,
    extraWorkspaceRoots: [fx.root],
  });
  assert.equal(outcome.status, "ok");
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.machine, MACHINE);

  const logs = logFiles(fx.project.root, "hello");
  assert.equal(logs.length, 1);
  assert.equal(outcome.logPath, logs[0]);
  const content = fs.readFileSync(logs[0] as string, "utf8");
  // cwd was the CANONICAL project root (late binding: the plist had no path);
  // process.cwd() reports the realpath under macOS's symlinked tmpdir
  assert.ok(content.includes(`hello-from ${fs.realpathSync(fx.project.root)}`), content);
  assert.match(content, /warn-line/); // stderr captured too
  assert.match(content, /# machine: runmach/);
  assert.match(content, /# status: ok/);

  // outcome appended to THIS machine's synced registry file only
  const run = lastRun(fx.root, fx.project.uid, "hello");
  assert.equal(run["status"], "ok");
  assert.equal(run["exit_code"], 0);
  assert.equal(typeof run["run_id"], "string");
  assert.match(String(run["log"]), /logs\/runmach\//);
  const machinesDir = path.join(fx.root, ".openworkspace", "machines");
  assert.deepEqual(fs.readdirSync(machinesDir), [`${MACHINE}.toml`]); // P15: one writer, one file

  const state = readRunState(fx.store, fx.project.uid, "hello");
  assert.equal(state?.latest_run_id, run["run_id"]);
  assert.equal(state?.latest_status, "succeeded");
  assert.equal(state?.last_terminal_run_id, state?.latest_run_id);
  assert.equal(state?.current_run_id, undefined);
  assert.equal(readLease(fx.store, fx.project.uid, "hello"), null);
  const attempt = readAttempt(fx.store, fx.project.uid, "hello", state?.latest_run_id as string);
  assert.equal(attempt?.command?.kind, "other");
  assert.equal(attempt?.logs?.publish_status, "published");
  assert.equal(attempt?.logs?.published_path, run["log"]);
});

test("runner §7.5: secrets resolve per-run into the child ENV — and NEVER land on disk", (t) => {
  // the resolver lives OUTSIDE the workspace so the disk sweep can be total
  const resolverDir = makeTmpDir("ow-resolver-");
  const resolverPath = path.join(resolverDir, "resolver.sh");
  fs.writeFileSync(resolverPath, `#!/bin/sh\necho "${SECRET_VALUE}"\n`, { mode: 0o755 });
  const fx = makeFixture({
    configToml: `[secrets.resolvers]\nfake = "${resolverPath} {ref}"\n`,
  });
  t.after(() => {
    fx.cleanup();
    rmrf(resolverDir);
  });
  // the child PROVES it saw the value without ever printing it (the log — and
  // the manifest — must stay free of the literal for the disk sweep below)
  writeManifest(
    fx.project.root,
    "secretive",
    nodeCommandToml(
      `const t = process.env.TOKEN ?? ''; ` +
        `console.log('TOKEN:len=' + t.length + ':sha=' + require('crypto').createHash('sha256').update(t).digest('hex').slice(0, 12))`,
      `[secrets]\nTOKEN = "fake://AI Secrets/item/field"\n`,
    ),
  );
  const outcome = runAutomation({
    uid: fx.project.uid,
    name: "secretive",
    store: fx.store,
    extraWorkspaceRoots: [fx.root],
  });
  assert.equal(outcome.status, "ok");
  const content = fs.readFileSync(outcome.logPath as string, "utf8");
  // the child really got the value (length + sha prefix match), env-only
  const sha = crypto.createHash("sha256").update(SECRET_VALUE).digest("hex").slice(0, 12);
  assert.ok(content.includes(`TOKEN:len=${SECRET_VALUE.length}:sha=${sha}`), content);
  assert.match(content, /# secrets: TOKEN \(env-only, values never logged\)/);

  // THE assertion: grep every artifact the run could have written — the
  // workspace tree (manifest, logs, registry) and the machine store — for
  // the resolved value. Zero hits anywhere.
  assert.deepEqual(grepTree(fx.root, SECRET_VALUE), []);
  assert.deepEqual(grepTree(fx.store.dir, SECRET_VALUE), []);
});

test("runner: a secret scheme with no resolver fails loudly, with an error outcome on record", (t) => {
  const fx = makeFixture(); // ships with an EMPTY resolver map (§4.1)
  t.after(fx.cleanup);
  writeManifest(
    fx.project.root,
    "unmapped",
    nodeCommandToml(`console.log('should never run')`, `[secrets]\nTOKEN = "op://Vault/item/field"\n`),
  );
  assert.throws(
    () =>
      runAutomation({ uid: fx.project.uid, name: "unmapped", store: fx.store, extraWorkspaceRoots: [fx.root] }),
    (err: unknown) => err instanceof ConfigError && /no resolver for scheme "op"/.test(err.message),
  );
  // the failure is still logged + recorded before the throw
  const logs = logFiles(fx.project.root, "unmapped");
  assert.equal(logs.length, 1);
  const content = fs.readFileSync(logs[0] as string, "utf8");
  assert.match(content, /# status: error/);
  assert.ok(!content.includes("--- exit:"), "the command must never have executed");
  assert.equal(lastRun(fx.root, fx.project.uid, "unmapped")["status"], "error");
});

test("runner: a manifest-load failure still writes the log and records the error outcome (§7.1 contract)", (t) => {
  // Regression: loadManifest used to throw before the log/registry plumbing
  // existed — a corrupted manifest silently killed a scheduled automation
  // behind a fresh heartbeat and a registry forever showing the last
  // successful run. The fire-time failure must be supervisable.
  const fx = makeFixture();
  t.after(fx.cleanup);
  // an applied-then-corrupted manifest: bare [secrets] value = invalid
  writeManifest(
    fx.project.root,
    "corrupt",
    nodeCommandToml(`console.log('should never run')`, `[secrets]\nKEY = "sk-bare-value"\n`),
  );
  assert.throws(
    () =>
      runAutomation({ uid: fx.project.uid, name: "corrupt", store: fx.store, extraWorkspaceRoots: [fx.root] }),
    (err: unknown) => err instanceof ConfigError && /invalid automation manifest/.test(err.message),
  );
  const logs = logFiles(fx.project.root, "corrupt");
  assert.equal(logs.length, 1, "machine-partitioned log written despite the manifest failure");
  const content = fs.readFileSync(logs[0] as string, "utf8");
  assert.match(content, /# status: error/);
  assert.match(content, /manifest load failed/);
  assert.match(content, /# command: \(manifest unavailable\)/);
  assert.ok(!content.includes("--- exit:"), "the command must never have executed");
  assert.equal(lastRun(fx.root, fx.project.uid, "corrupt")["status"], "error");
  let state = readRunState(fx.store, fx.project.uid, "corrupt");
  assert.equal(state?.latest_status, "error");
  let attempt = readAttempt(fx.store, fx.project.uid, "corrupt", state?.latest_run_id as string);
  assert.match(attempt?.reason ?? "", /manifest load failed/);
  assert.equal(attempt?.logs?.publish_status, "published");

  // a MISSING manifest behaves the same (NotFoundError, still logged + recorded)
  writeManifest(fx.project.root, "ghostly", nodeCommandToml(`console.log('x')`));
  fs.rmSync(path.join(fx.project.root, "_project", "automations", "ghostly", "automation.toml"));
  assert.throws(() =>
    runAutomation({ uid: fx.project.uid, name: "ghostly", store: fx.store, extraWorkspaceRoots: [fx.root] }),
  );
  assert.equal(logFiles(fx.project.root, "ghostly").length, 1);
  assert.equal(lastRun(fx.root, fx.project.uid, "ghostly")["status"], "error");
  state = readRunState(fx.store, fx.project.uid, "ghostly");
  assert.equal(state?.latest_status, "error");
  attempt = readAttempt(fx.store, fx.project.uid, "ghostly", state?.latest_run_id as string);
  assert.match(attempt?.reason ?? "", /manifest load failed/);
});

test("runner: nonzero exit → failed outcome with the child's exit code", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  writeManifest(fx.project.root, "crashy", nodeCommandToml(`console.error('boom'); process.exit(3)`));
  const outcome = runAutomation({
    uid: fx.project.uid,
    name: "crashy",
    store: fx.store,
    extraWorkspaceRoots: [fx.root],
  });
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.exitCode, 3);
  const content = fs.readFileSync(outcome.logPath as string, "utf8");
  assert.match(content, /boom/);
  assert.match(content, /--- exit: 3 ---/);
  const run = lastRun(fx.root, fx.project.uid, "crashy");
  assert.equal(run["status"], "failed");
  assert.equal(run["exit_code"], 3);
});

test("runner: timeout_seconds terminates the child and reports failed/timed out", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  // nodeCommandToml ends inside [run]; the appended key stays in that table
  writeManifest(fx.project.root, "sleepy", nodeCommandToml(`setTimeout(() => {}, 30000)`) + `timeout_seconds = 1\n`);
  const outcome = runAutomation({
    uid: fx.project.uid,
    name: "sleepy",
    store: fx.store,
    extraWorkspaceRoots: [fx.root],
  });
  assert.equal(outcome.status, "failed");
  assert.match(fs.readFileSync(outcome.logPath as string, "utf8"), /timed out/);
});

test("runner: timeout kills a child that IGNORES SIGTERM (regression: claude-hang)", { timeout: 15000 }, (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  // A child that traps SIGTERM and keeps running — like `claude --print`, which
  // ignored SIGTERM and hung a briefing-cycle run ~13h past its timeout. The
  // timeout MUST escalate to SIGKILL; otherwise this test hangs (caught by the
  // 15s test timeout) instead of completing.
  writeManifest(
    fx.project.root,
    "stubborn",
    nodeCommandToml(`process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`) + `timeout_seconds = 1\n`,
  );
  const outcome = runAutomation({
    uid: fx.project.uid,
    name: "stubborn",
    store: fx.store,
    extraWorkspaceRoots: [fx.root],
  });
  assert.equal(outcome.status, "failed");
  assert.match(fs.readFileSync(outcome.logPath as string, "utf8"), /timed out/);
});

test("runner: on_dormant_project — stop skips (movement signals lifecycle); continue runs", (t) => {
  const fx = makeFixture({ projectRel: path.join("Dormant Projects", "Sleeper") });
  t.after(fx.cleanup);
  const marker = path.join(fx.project.root, "should-not-exist.txt");
  writeManifest(
    fx.project.root,
    "dormwatch",
    nodeCommandToml(`require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`),
  );
  const skipped = runAutomation({
    uid: fx.project.uid,
    name: "dormwatch",
    store: fx.store,
    extraWorkspaceRoots: [fx.root],
  });
  assert.equal(skipped.status, "skipped-dormant");
  assert.equal(skipped.exitCode, null);
  assert.ok(!fs.existsSync(marker), "stop must not execute the command");
  assert.match(fs.readFileSync(skipped.logPath as string, "utf8"), /project is dormant/);
  assert.equal(lastRun(fx.root, fx.project.uid, "dormwatch")["status"], "skipped-dormant");

  // continue: the same dormant project runs when the manifest says so
  // (top-level key, so it goes BEFORE the [schedule]/[run] tables)
  writeManifest(
    fx.project.root,
    "dormwatch",
    `on_dormant_project = "continue"\n` +
      nodeCommandToml(`require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`),
  );
  const ran = runAutomation({
    uid: fx.project.uid,
    name: "dormwatch",
    store: fx.store,
    extraWorkspaceRoots: [fx.root],
  });
  assert.equal(ran.status, "ok");
  assert.ok(fs.existsSync(marker));
});

test("runner: on_dormant_project honors DECLARED lifecycle (metadata), not just folder location (decision-2/phase-3)", (t) => {
  // The project sits at an ACTIVE location (top-level, not under Dormant
  // Projects/) but its project.toml DECLARES dormant — the runner must skip,
  // proving on_dormant_project reads the EFFECTIVE (metadata-primary)
  // lifecycle rather than lifecycleOf's location-only view.
  const fx = makeFixture();
  t.after(fx.cleanup);
  writeDeclaredLifecycle(fx.project.root, "dormant", "2026-01-01T00:00:00Z");
  const marker = path.join(fx.project.root, "should-not-exist.txt");
  writeManifest(
    fx.project.root,
    "metawatch",
    nodeCommandToml(`require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`),
  );
  const skipped = runAutomation({
    uid: fx.project.uid,
    name: "metawatch",
    store: fx.store,
    extraWorkspaceRoots: [fx.root],
  });
  assert.equal(skipped.status, "skipped-dormant");
  assert.ok(!fs.existsSync(marker), "declared dormant must stop the run even at an active location");
  assert.match(fs.readFileSync(skipped.logPath as string, "utf8"), /project is dormant/);
});

test("runner: log retention keeps the newest LOG_RETENTION files, own machine dir only", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  writeManifest(fx.project.root, "chatty", nodeCommandToml(`console.log('run')`));
  const machineDir = path.join(fx.project.root, "_project", "automations", "chatty", "logs", MACHINE);
  const otherDir = path.join(fx.project.root, "_project", "automations", "chatty", "logs", "othermac");
  fs.mkdirSync(machineDir, { recursive: true });
  fs.mkdirSync(otherDir, { recursive: true });
  for (let i = 0; i < LOG_RETENTION + 5; i++) {
    const stamp = `2026010${i % 10}T0${String(i).padStart(2, "0").slice(-1)}000${i % 10}Z`;
    fs.writeFileSync(path.join(machineDir, `2026-old-${String(i).padStart(3, "0")}${stamp}.log`), "old\n");
  }
  fs.writeFileSync(path.join(otherDir, "20260101T000000Z.log"), "another machine's history\n");

  const outcome = runAutomation({
    uid: fx.project.uid,
    name: "chatty",
    store: fx.store,
    extraWorkspaceRoots: [fx.root],
  });
  assert.equal(outcome.status, "ok");
  assert.equal(logFiles(fx.project.root, "chatty").length, LOG_RETENTION);
  // the newest (this run's) survived; P15 — the other machine's dir untouched
  assert.ok(logFiles(fx.project.root, "chatty").some((f) => f === outcome.logPath));
  assert.equal(fs.readdirSync(otherDir).length, 1);

  // unit edge: retention never deletes below the keep threshold
  assert.deepEqual(applyLogRetention(machineDir, 100), []);
});

test("runner: unresolvable UID is a LOUD ResolveError (exit-2 class) — never a guess", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  const missingUid = "33333333-3333-3333-3333-333333333333";
  assert.throws(
    () =>
      runAutomation({
        uid: missingUid,
        name: "anything",
        store: fx.store,
        extraWorkspaceRoots: [fx.root],
      }),
    (err: unknown) => {
      assert.ok(err instanceof ResolveError);
      assert.equal(err.exitCode, 2);
      assert.match(err.message, /orphaned/);
      return true;
    },
  );
  const state = readRunState(fx.store, missingUid, "anything");
  assert.equal(state?.latest_status, "error");
  assert.equal(state?.current_run_id, undefined);
  assert.equal(readLease(fx.store, missingUid, "anything"), null);
  const attempt = readAttempt(fx.store, missingUid, "anything", state?.latest_run_id as string);
  assert.equal(attempt?.phase, "finished");
  assert.match(attempt?.reason ?? "", /orphaned/);
  assert.equal(attempt?.logs?.publish_status, "skipped");
});

test("runner: overlapping managed run records a skipped attempt and does not execute", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  const marker = path.join(fx.project.root, "should-not-run.txt");
  writeManifest(
    fx.project.root,
    "busy",
    nodeCommandToml(`require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`),
  );
  acquireLease({
    store: fx.store,
    uid: fx.project.uid,
    name: "busy",
    machine: MACHINE,
    now: new Date("2026-06-25T16:00:00Z"),
    ttlSeconds: 60,
    token: "held-by-other-run",
  });
  const outcome = runAutomation({
    uid: fx.project.uid,
    name: "busy",
    store: fx.store,
    extraWorkspaceRoots: [fx.root],
    now: () => new Date("2026-06-25T16:00:30Z"),
  });
  assert.equal(outcome.status, "skipped");
  assert.equal(outcome.logPath, null);
  assert.ok(!fs.existsSync(marker), "overlap skip must not execute the command");
  const state = readRunState(fx.store, fx.project.uid, "busy");
  assert.equal(state?.latest_status, "skipped");
  const attempt = readAttempt(fx.store, fx.project.uid, "busy", state?.latest_run_id as string);
  assert.match(attempt?.reason ?? "", /lease is already held/);
  assert.equal(readLease(fx.store, fx.project.uid, "busy")?.lease_token, "held-by-other-run");
});

test("runner: project rename mid-flight is transparent (late binding re-resolves)", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  writeManifest(fx.project.root, "mover", nodeCommandToml(`console.log('ran at ' + process.cwd())`));
  // first run caches the canonical path
  const first = runAutomation({ uid: fx.project.uid, name: "mover", store: fx.store, extraWorkspaceRoots: [fx.root] });
  assert.equal(first.status, "ok");
  // the project moves (rename) — the plist would be byte-identical; only the
  // runner's resolution has to notice, via cache-verify → rescan
  const newRoot = path.join(fx.root, "Run: Proj B");
  fs.renameSync(fx.project.root, newRoot);
  const second = runAutomation({ uid: fx.project.uid, name: "mover", store: fx.store, extraWorkspaceRoots: [fx.root] });
  assert.equal(second.status, "ok");
  assert.ok(
    fs.readFileSync(second.logPath as string, "utf8").includes(`ran at ${fs.realpathSync(newRoot)}`),
  );
});

test("runner: child env precedence — base env < [run] env (static) < resolved [secrets]; names-only log line", (t) => {
  // the resolver lives OUTSIDE the workspace so the disk sweep can be total
  const resolverDir = makeTmpDir("ow-resolver-");
  const resolverPath = path.join(resolverDir, "resolver.sh");
  fs.writeFileSync(resolverPath, `#!/bin/sh\necho "${SECRET_VALUE}"\n`, { mode: 0o755 });
  const fx = makeFixture({
    configToml: `[secrets.resolvers]\nfake = "${resolverPath} {ref}"\n`,
  });
  t.after(() => {
    fx.cleanup();
    rmrf(resolverDir);
  });

  writeManifest(
    fx.project.root,
    "env-merge",
    nodeCommandToml(
      `const e = process.env; ` +
        `console.log('STATIC_ONLY=' + e.STATIC_ONLY); ` +
        `console.log('FROM_BASE=' + e.FROM_BASE); ` +
        `console.log('OVERRIDDEN=' + e.OVERRIDDEN); ` +
        `console.log('TOKEN:len=' + (e.TOKEN ?? '').length)`,
      `env = { STATIC_ONLY = "static-value", OVERRIDDEN = "static-wins-over-base" }\n` +
        `[secrets]\nTOKEN = "fake://AI Secrets/item/field"\n`,
    ),
  );
  const outcome = runAutomation({
    uid: fx.project.uid,
    name: "env-merge",
    store: fx.store,
    extraWorkspaceRoots: [fx.root],
    env: { ...process.env, FROM_BASE: "base-value", OVERRIDDEN: "base-loses" },
  });
  assert.equal(outcome.status, "ok");
  const content = fs.readFileSync(outcome.logPath as string, "utf8");
  assert.ok(content.includes("STATIC_ONLY=static-value"), content); // run.env reaches the child
  assert.ok(content.includes("FROM_BASE=base-value"), content); // base env still flows through
  assert.ok(content.includes("OVERRIDDEN=static-wins-over-base"), content); // run.env beats base
  assert.ok(content.includes(`TOKEN:len=${SECRET_VALUE.length}`), content); // secrets layer on top

  // trailing header lines: names only, never values — same shape as # secrets:
  assert.match(content, /# secrets: TOKEN \(env-only, values never logged\)/);
  assert.match(content, /# env: STATIC_ONLY, OVERRIDDEN \(static\)/);

  // no-secrets-on-disk sweep stays green with the env feature in play
  assert.deepEqual(grepTree(fx.root, SECRET_VALUE), []);
  assert.deepEqual(grepTree(fx.store.dir, SECRET_VALUE), []);
});

test("runner: a manifest without [run] env logs '# env: (none) (static)'", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  writeManifest(fx.project.root, "plain", nodeCommandToml(`console.log('plain')`));
  const outcome = runAutomation({
    uid: fx.project.uid,
    name: "plain",
    store: fx.store,
    extraWorkspaceRoots: [fx.root],
  });
  assert.equal(outcome.status, "ok");
  assert.match(fs.readFileSync(outcome.logPath as string, "utf8"), /# env: \(none\) \(static\)/);
});
