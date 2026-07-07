import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import { ConflictError } from "../src/lib/errors.js";
import {
  AutomationAttempt,
  acquireLease,
  automationAttemptPath,
  automationAttemptsDir,
  automationLeasePath,
  automationLocalLogsDir,
  automationRunDir,
  automationStatePath,
  computeRunHealth,
  computeRunState,
  createAttempt,
  finishAttempt,
  readAttempt,
  readLease,
  readRunState,
  releaseLease,
  updateAttempt,
  writeRunState,
} from "../src/primitives/automation-runs.js";
import { makeTmpStore } from "./helpers.js";

const UID = "defa84d9-2055-4f25-a1af-8398e46db626";
const NAME = "briefing-cycle";
const MACHINE = "mini";
const T0 = new Date("2026-06-25T16:00:00Z");

test("path layout stays under the injected MachineStore", (t) => {
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);

  const base = path.join(store.dir, "automation-runs", `${UID}--${NAME}`);
  assert.equal(automationRunDir(store, UID, NAME), base);
  assert.equal(automationAttemptsDir(store, UID, NAME), path.join(base, "attempts"));
  assert.equal(automationLocalLogsDir(store, UID, NAME), path.join(base, "logs"));
  assert.equal(automationStatePath(store, UID, NAME), path.join(base, "state.toml"));
  assert.equal(automationLeasePath(store, UID, NAME), path.join(base, "lease.toml"));
  assert.equal(automationAttemptPath(store, UID, NAME, "run-1"), path.join(base, "attempts", "run-1.toml"));
});

test("attempt lifecycle: create, read, update, finish; unknown TOML keys survive owned rewrites", (t) => {
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);

  const created = createAttempt({
    store,
    uid: UID,
    name: NAME,
    machine: MACHINE,
    trigger: "calendar",
    now: T0,
    schedule: "cron 0 * * * *",
    scheduledFrom: "2026-06-25T16:00:00Z",
    scheduledThrough: "2026-06-25T16:00:00Z",
    scheduledCount: 1,
    extra: { foreign_table: { keep: "yes" } },
  });

  assert.match(created.run_id, new RegExp(`^20260625T160000Z--${MACHINE}--p\\d+--[0-9a-f]{4}$`));
  assert.equal(created.status, "starting");
  assert.equal(created.phase, "created");
  assert.ok(fs.statSync(automationAttemptsDir(store, UID, NAME)).isDirectory());
  assert.ok(fs.statSync(automationLocalLogsDir(store, UID, NAME)).isDirectory());

  const loaded = readAttempt(store, UID, NAME, created.run_id);
  assert.equal(loaded?.project_uid, UID);
  assert.deepEqual(loaded?.["foreign_table"], { keep: "yes" });
  assert.equal(readRunState(store, UID, NAME)?.latest_run_id, created.run_id);
  assert.equal(readRunState(store, UID, NAME)?.current_run_id, created.run_id);

  writeRunState(store, {
    schema: 1,
    project_uid: UID,
    name: NAME,
    machine_id: MACHINE,
    latest_run_id: created.run_id,
    latest_status: "starting",
    latest_phase: "created",
    latest_updated_at: created.updated_at,
    current_run_id: created.run_id,
    schedule_cursor: "2026-06-25T16:00:00Z",
    foreign_state: { keep: "cursor metadata" },
  });

  // Comments/formatting are outside the preservation contract for these
  // tool-owned TOML files, but unknown data fields are preserved.
  fs.appendFileSync(automationAttemptPath(store, UID, NAME, created.run_id), "\n# not preserved by whole-document TOML writes\n");

  const running = updateAttempt(
    store,
    UID,
    NAME,
    created.run_id,
    {
      status: "running",
      phase: "executing",
      started_at: "2026-06-25T16:00:04Z",
      heartbeat_at: "2026-06-25T16:08:00Z",
      owner: { lease_token: "lease-a", runner_pid: 5891, foreign_owner: "keep me" },
    },
    new Date("2026-06-25T16:08:00Z"),
  );
  assert.equal(running.updated_at, "2026-06-25T16:08:00Z");
  assert.deepEqual(running["foreign_table"], { keep: "yes" });
  assert.equal(running.owner?.foreign_owner, "keep me");
  const runningState = readRunState(store, UID, NAME);
  assert.equal(runningState?.latest_status, "running");
  assert.equal(runningState?.current_run_id, created.run_id);
  assert.equal(runningState?.schedule_cursor, "2026-06-25T16:00:00Z");
  assert.deepEqual(runningState?.["foreign_state"], { keep: "cursor metadata" });

  const childAdded = updateAttempt(
    store,
    UID,
    NAME,
    created.run_id,
    { owner: { child_pid: 5898 } },
    new Date("2026-06-25T16:09:00Z"),
  );
  assert.deepEqual(childAdded.owner, {
    lease_token: "lease-a",
    runner_pid: 5891,
    foreign_owner: "keep me",
    child_pid: 5898,
  });

  const finished = finishAttempt({
    store,
    uid: UID,
    name: NAME,
    runId: created.run_id,
    status: "succeeded",
    now: new Date("2026-06-25T16:10:00Z"),
    outcome: { exit_code: 0, foreign_outcome: "kept" },
    logs: { publish_status: "published", published_path: "C3/_project/automations/briefing-cycle/logs/mini/run.log" },
  });
  assert.equal(finished.status, "succeeded");
  assert.equal(finished.phase, "finished");
  assert.equal(finished.finished_at, "2026-06-25T16:10:00Z");
  assert.equal(finished.outcome?.exit_code, 0);
  assert.equal(finished.outcome?.foreign_outcome, "kept");
  assert.deepEqual(finished["foreign_table"], { keep: "yes" });
  const finishedState = readRunState(store, UID, NAME);
  assert.equal(finishedState?.latest_status, "succeeded");
  assert.equal(finishedState?.current_run_id, undefined);
  assert.equal(finishedState?.last_terminal_run_id, created.run_id);
  assert.equal(finishedState?.schedule_cursor, "2026-06-25T16:00:00Z");
  assert.ok(!fs.readFileSync(automationAttemptPath(store, UID, NAME, created.run_id), "utf8").includes("not preserved"));
});

test("lease acquire/release: token ownership, conflict, and expiry", (t) => {
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);

  const first = acquireLease({
    store,
    uid: UID,
    name: NAME,
    machine: MACHINE,
    runId: "run-a",
    now: T0,
    ttlSeconds: 60,
    token: "token-a",
    runnerPid: 1234,
  });
  assert.equal(first.lease_token, "token-a");
  assert.equal(first.expires_at, "2026-06-25T16:01:00Z");
  assert.equal(readLease(store, UID, NAME)?.run_id, "run-a");

  assert.throws(
    () =>
      acquireLease({
        store,
        uid: UID,
        name: NAME,
        machine: MACHINE,
        now: new Date("2026-06-25T16:00:30Z"),
        ttlSeconds: 60,
        token: "token-b",
      }),
    ConflictError,
  );

  assert.equal(releaseLease({ store, uid: UID, name: NAME, token: "wrong-token" }), false);
  assert.equal(readLease(store, UID, NAME)?.lease_token, "token-a");
  assert.equal(releaseLease({ store, uid: UID, name: NAME, token: "token-a" }), true);
  assert.equal(readLease(store, UID, NAME), null);

  acquireLease({
    store,
    uid: UID,
    name: NAME,
    machine: MACHINE,
    now: T0,
    ttlSeconds: 60,
    token: "expired-token",
  });
  const replacement = acquireLease({
    store,
    uid: UID,
    name: NAME,
    machine: MACHINE,
    now: new Date("2026-06-25T16:01:01Z"),
    ttlSeconds: 60,
    token: "fresh-token",
  });
  assert.equal(replacement.lease_token, "fresh-token");
  assert.equal(readLease(store, UID, NAME)?.lease_token, "fresh-token");
});

test("computeRunState derives running, overdue, stuck, and terminal states", () => {
  const base = (overrides: Partial<AutomationAttempt>): AutomationAttempt => ({
    schema: 1,
    run_id: "run-a",
    project_uid: UID,
    name: NAME,
    machine_id: MACHINE,
    trigger: "calendar",
    status: "running",
    phase: "executing",
    created_at: "2026-06-25T16:00:00Z",
    updated_at: "2026-06-25T16:04:00Z",
    heartbeat_at: "2026-06-25T16:04:00Z",
    deadline_at: "2026-06-25T16:30:00Z",
    owner: { runner_pid: 42 },
    ...overrides,
  });
  const now = new Date("2026-06-25T16:05:00Z");

  assert.equal(computeRunState(base({}), now, () => true), "running");
  assert.equal(
    computeRunState(base({ deadline_at: "2026-06-25T16:04:59Z" }), now, () => true),
    "overdue",
  );
  assert.equal(
    computeRunState(base({ heartbeat_at: "2026-06-25T15:40:00Z" }), now, () => true),
    "running",
  );
  assert.equal(computeRunState(base({ heartbeat_at: "2026-06-25T15:40:00Z", owner: {} }), now), "stuck");
  assert.equal(computeRunState(base({ owner: { runner_pid: 42 } }), now, () => false), "stuck");
  assert.equal(computeRunState(base({ status: "failed", phase: "finished" }), now), "failed");
  assert.equal(computeRunState(null, now), "pending-first-run");

  assert.equal(computeRunHealth("running"), "ok");
  assert.equal(computeRunHealth("overdue"), "attention");
  assert.equal(computeRunHealth("stuck"), "critical");
  assert.equal(computeRunHealth("unknown"), "unknown");
});
