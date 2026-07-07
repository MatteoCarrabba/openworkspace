import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import { activationRecordPath } from "../src/lib/machine.js";
import { readTomlIfExists, writeToml } from "../src/lib/toml.js";
import { fileFakeLaunchd } from "../src/primitives/automations.js";
import {
  acquireLease,
  createAttempt,
  readAttempt,
  readLease,
  readRunState,
} from "../src/primitives/automation-runs.js";
import {
  applySupervisor,
  deactivateSupervisor,
  superviseLocalAutomations,
  supervisorInstallStatus,
} from "../src/primitives/automation-supervisor.js";
import { makeTmpDir, makeTmpStore, makeTmpWorkspace, rmrf } from "./helpers.js";

const MACHINE = "mini";
const UID = "defa84d9-2055-4f25-a1af-8398e46db626";
const NAME = "briefing-cycle";

function makeFixture() {
  const tmpWs = makeTmpWorkspace('workspace_id = "ws-supervisor-test"\n');
  const project = tmpWs.addProject("C3", UID);
  const tmpStore = makeTmpStore();
  fs.writeFileSync(path.join(tmpStore.store.dir, "machine-id"), `${MACHINE}\n`);
  writeToml(activationRecordPath(tmpStore.store, UID, NAME), {
    project_uid: UID,
    name: NAME,
    machine_id: MACHINE,
    label: `com.openworkspace.${UID}.${NAME}`,
    plist_path: "/tmp/com.openworkspace.test.plist",
    workspace_root: tmpWs.root,
    applied_at: "2026-06-25T15:00:00Z",
    direct_exec: false,
    schedule: "cron 0 * * * *",
  });
  return {
    root: tmpWs.root,
    project,
    store: tmpStore.store,
    cleanup: () => {
      tmpWs.cleanup();
      tmpStore.cleanup();
    },
  };
}

test("supervisor: live owner PID is left alone", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  acquireLease({
    store: fx.store,
    uid: UID,
    name: NAME,
    machine: MACHINE,
    now: new Date("2026-06-25T16:00:00Z"),
    ttlSeconds: 3600,
    token: "lease-live",
    runnerPid: 42,
  });
  const created = createAttempt({
    store: fx.store,
    uid: UID,
    name: NAME,
    machine: MACHINE,
    trigger: "calendar" as const,
    now: new Date("2026-06-25T16:00:00Z"),
    status: "running" as const,
    phase: "executing" as const,
    startedAt: "2026-06-25T16:00:00Z",
    heartbeatAt: "2026-06-25T15:40:00Z",
    owner: { lease_token: "lease-live", runner_pid: 42 },
  });

  const summary = superviseLocalAutomations({
    store: fx.store,
    now: new Date("2026-06-25T16:20:00Z"),
    processAlive: () => true,
  });
  assert.equal(summary.abandoned, 0);
  assert.equal(summary.findings[0]?.kind, "active-run");
  assert.equal(readAttempt(fx.store, UID, NAME, created.run_id)?.status, "running");
  assert.equal(readLease(fx.store, UID, NAME)?.lease_token, "lease-live");
});

test("supervisor: dead active run is marked abandoned, lease released, registry mirrored", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  acquireLease({
    store: fx.store,
    uid: UID,
    name: NAME,
    machine: MACHINE,
    now: new Date("2026-06-25T16:00:00Z"),
    ttlSeconds: 3600,
    token: "lease-dead",
    runnerPid: 99,
  });
  const created = createAttempt({
    store: fx.store,
    uid: UID,
    name: NAME,
    machine: MACHINE,
    trigger: "calendar",
    now: new Date("2026-06-25T16:00:00Z"),
    status: "running",
    phase: "executing",
    startedAt: "2026-06-25T16:00:00Z",
    heartbeatAt: "2026-06-25T16:01:00Z",
    owner: { lease_token: "lease-dead", runner_pid: 99 },
  });

  const summary = superviseLocalAutomations({
    store: fx.store,
    now: new Date("2026-06-25T16:05:00Z"),
    processAlive: () => false,
  });
  assert.equal(summary.abandoned, 1);
  assert.equal(summary.findings[0]?.kind, "abandoned-run");
  assert.equal(readLease(fx.store, UID, NAME), null);
  const attempt = readAttempt(fx.store, UID, NAME, created.run_id);
  assert.equal(attempt?.status, "abandoned");
  assert.equal(attempt?.phase, "finished");
  assert.match(attempt?.reason ?? "", /supervisor marked/);
  const state = readRunState(fx.store, UID, NAME);
  assert.equal(state?.latest_status, "abandoned");
  assert.equal(state?.current_run_id, undefined);
  assert.equal(state?.last_terminal_run_id, created.run_id);

  const registry = readTomlIfExists(path.join(fx.root, ".openworkspace", "machines", `${MACHINE}.toml`));
  const lastRuns = registry["last_runs"] as Record<string, Record<string, unknown>>;
  const mirrored = lastRuns[`${UID}--${NAME}`];
  assert.equal(mirrored?.["run_id"], created.run_id);
  assert.equal(mirrored?.["status"], "abandoned");
  assert.equal(mirrored?.["finished_at"], "2026-06-25T16:05:00Z");
});

test("supervisor LaunchAgent: apply/status/deactivate through launchd adapter", (t) => {
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);
  const launchdDir = makeTmpDir("ow-supervisor-launchd-");
  t.after(() => rmrf(launchdDir));
  const launchd = fileFakeLaunchd(launchdDir);

  const first = applySupervisor({
    store,
    launchd,
    nodePath: "/usr/local/bin/node",
    cliPath: "/opt/openworkspace/dist/src/cli.js",
    intervalSeconds: 60,
  });
  assert.equal(first.action, "installed");
  assert.equal(first.intervalSeconds, 60);
  assert.deepEqual(first.warnings, []);
  assert.ok(fs.readFileSync(first.plistPath, "utf8").includes("<integer>60</integer>"));
  assert.deepEqual(launchd.loadedLabels(), ["com.openworkspace.supervisor"]);

  const unchanged = applySupervisor({
    store,
    launchd,
    nodePath: "/usr/local/bin/node",
    cliPath: "/opt/openworkspace/dist/src/cli.js",
    intervalSeconds: 60,
  });
  assert.equal(unchanged.action, "unchanged");
  assert.deepEqual(supervisorInstallStatus({ store, launchd }), {
    label: "com.openworkspace.supervisor",
    plistPath: first.plistPath,
    installed: true,
    loaded: true,
  });

  const off = deactivateSupervisor({ store, launchd });
  assert.deepEqual(off, {
    label: "com.openworkspace.supervisor",
    removedPlist: true,
    wasLoaded: true,
  });
  assert.deepEqual(launchd.loadedLabels(), []);
});
