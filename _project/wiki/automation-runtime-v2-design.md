# Automation Runtime v2 Design

status: draft-for-matteo-review
created: 2026-06-25

2026-06-28 amendment: see
`_project/wiki/local-control-plane-data-plane-design.md` for the follow-on
design that separates the local APFS automation control plane from the
iCloud-backed document data plane. That amendment is the intended resolution to
the Mini/FileProvider failure mode discovered during rollout: activation,
supervision, run ledgers, and dashboard runtime state must not depend on
`~/Documents`, while individual payloads may declare bounded document
dependencies.

## Goal

OpenWorkspace automations should make it easy to answer:

- what exists;
- what is declared to run where;
- what is enabled on each machine;
- what is running now;
- what last succeeded, failed, timed out, or was skipped;
- what is stale, stuck, unreachable, or misconfigured;
- what to do next.

The current v1 design gets intent and activation mostly right: automation
definitions live in the tree, activation is a deliberate per-machine act, and
launchd runs a late-bound runner by project UID and automation name. The broken
part is runtime truth. The system records last finished runs, but it does not
durably model active runs, stuck runs, missed runs, leases, per-run heartbeats,
or partial failure. On the Mini, that gap combines badly with iCloud/FileProvider
hangs: the machine can be reachable and launchd can be loaded while the synced
registry and dashboard are stale or unavailable.

## Design Summary

Keep the v1 split:

- synced tree = automation intent;
- machine-local activation = what this machine is allowed to run;
- launchd = wake-up mechanism;
- runner = executor.

Add three v2 pieces:

1. A machine-local run ledger in `~/Library/Application Support/OpenWorkspace`.
2. A short-lived machine supervisor launchd job for recovery and health checks.
3. A richer status model used by CLI, dashboard, and doctor.

The live runtime ledger must not depend on iCloud/FileProvider. Synced registry
files remain reporting mirrors for other machines, not the control plane.

The local Mini/launchd implementation is the first automation host backend, not
the architecture itself. v2 should define a stable host/backend contract so that
a future cloud worker, Linux box, or other always-on machine can be added without
changing manifest semantics, status vocabulary, dashboard shape, or run records.

## Modularity Principle

OpenWorkspace automations have four separable layers:

1. Intent: `automation.toml` in the project tree.
2. Placement: which hosts are declared and enabled.
3. Runtime: how a host wakes, claims, executes, heartbeats, logs, and publishes.
4. Visibility: status, dashboard, doctor, and alerting.

Only layer 3 should vary by host type. The other layers must stay stable.

This means `machines = ["mini"]` should be interpreted as placement onto a named
automation host, not as "macOS launchd only." A host has capabilities and a
backend:

```toml
[[automation_hosts]]
id = "mini"
backend = "local-launchd"
always_on = true

[[automation_hosts]]
id = "cloud-small"
backend = "ssh-linux-systemd"
always_on = true
```

The exact config file can be decided during implementation, but the conceptual
contract should be stable from v2 onward.

## Host Backend Contract

Each backend must implement the same operations:

- `apply(host, activation)`: install or update this host's wake mechanism.
- `deactivate(host, activation)`: remove this host's wake mechanism.
- `tick(host)`: run supervisor recovery and due-work checks.
- `run(host, uid, name, trigger)`: execute one automation through the runner.
- `status(host)`: report local install and runtime health.
- `logs(host, run_id)`: resolve local/published logs.
- `reap(host, run_id)`: recover a stuck local run.

The first backend is `local-launchd`:

- activation = LaunchAgent plist;
- wake mechanism = `StartCalendarInterval` plus supervisor `StartInterval`;
- local state = macOS App Support;
- process control = POSIX process groups.

Future backends should fit the same contract:

- `linux-systemd`: systemd timers/services, App Support equivalent under XDG
  state, process groups/cgroups.
- `ssh-remote`: OW controls a remote machine over SSH, installs the runner
  there, and pulls status/log summaries.
- `cloud-worker`: a small always-on VM/container runs the OW runner/supervisor
  and publishes registry summaries back through git, object storage, or another
  configured sync channel.

No backend should be allowed to invent a different manifest language or a
different status model.

## Storage Model

Machine-local state:

```text
~/Library/Application Support/OpenWorkspace/
  activations/<project_uid>--<name>.toml
  automation-runs/<project_uid>--<name>/
    state.toml
    lease.toml
    attempts/<run_id>.toml
    logs/<run_id>.log
    events.jsonl
```

For non-macOS hosts, this becomes the host's configured OW state directory. The
path changes; the schema does not. Examples:

```text
macOS local-launchd:
  ~/Library/Application Support/OpenWorkspace/

Linux systemd / cloud worker:
  $XDG_STATE_HOME/openworkspace/
  or /var/lib/openworkspace/<operator>/
```

Synced reporting state:

```text
<workspace>/.openworkspace/machines/<machine>.toml
```

Human-facing run logs remain where they are:

```text
_project/automations/<name>/logs/<machine>/<stamp>.log
_project/automations/<name>/logs/<machine>/<stamp>.json
```

`state.toml` stores schedule cursor and pending/coalesced work for one local
activation. `lease.toml` stores the current owner and expiry. Each attempt gets
one mutable TOML record until it reaches a terminal state. `events.jsonl` is an
optional local debug audit trail, not a primary index.

## Attempt Schema

One file per run attempt:

```toml
schema = 1
run_id = "20260625T160000Z--mini--p5891--8ca6"
project_uid = "defa84d9-2055-4f25-a1af-8398e46db626"
name = "briefing-cycle"
machine_id = "mini"
trigger = "calendar" # calendar | supervisor | run-now
status = "running"
phase = "executing"
reason = ""
schedule = "cron 0 * * * *"

scheduled_from = "2026-06-25T16:00:00Z"
scheduled_through = "2026-06-25T16:00:00Z"
scheduled_count = 1

created_at = "2026-06-25T16:00:00Z"
started_at = "2026-06-25T16:00:04Z"
updated_at = "2026-06-25T16:08:00Z"
heartbeat_at = "2026-06-25T16:08:00Z"
timeout_seconds = 1800
deadline_at = "2026-06-25T16:30:04Z"

[owner]
lease_token = "8ca6..."
runner_pid = 5891
child_pid = 5898
child_pgid = 5898
launch_label = "com.openworkspace.defa84d9-2055-4f25-a1af-8398e46db626.briefing-cycle"
node_path = "/Users/matteocarrabba/runner-node/bin/node"
runner_version = "..."

[command]
kind = "script" # script | codex | claude | agent | shell | other
argv0 = "/usr/bin/python3"
argv_hash = "sha256:..."
env_keys = ["AUTOMATION_SESSION", "AUTOMATION_LABEL"]
secret_keys = []

[logs]
local_path = "automation-runs/defa84...--briefing-cycle/logs/20260625T160000Z--mini--p5891--8ca6.log"
published_path = "C3/_project/automations/briefing-cycle/logs/mini/20260625T160000Z.log"
publish_status = "pending" # pending | published | failed | skipped

[outcome]
# present only once terminal
```

Resolved secret values must never appear in the ledger, registry, dashboard
payloads, published logs, or notifications. Store secret key names only. Logs
should best-effort redact resolved secret values before writing stdout/stderr.

## Program Runtime Contract

OpenWorkspace should schedule, supervise, and observe automations. It should not
be a Claude Code automation system. The payload is an arbitrary command.

First-class payloads include:

- deterministic scripts;
- shell commands;
- Codex non-interactive runs;
- Claude Code non-interactive runs;
- other local or remote agent CLIs;
- small purpose-built binaries.

The runner treats all payloads the same way:

1. construct environment from the host, `[run].env`, schedule metadata, and
   resolved `[secrets]`;
2. spawn the command;
3. stream stdout/stderr to logs;
4. heartbeat, enforce timeout, and record outcome;
5. publish status/log mirrors.

Provider-specific behavior belongs outside the core scheduler. If a Codex run
needs a model flag, a Claude run needs an OAuth token, or a script needs an API
key, those are just command arguments, static env keys, and secret pointers.
OpenWorkspace may label the payload for visibility, but it must not branch core
runtime behavior on the provider.

Optional manifest metadata:

```toml
[run]
command = ["/usr/bin/python3", "scripts/refresh.py"]
kind = "script" # script | codex | claude | agent | shell | other
timeout_seconds = 900
env = { AUTOMATION_SESSION = "1", AUTOMATION_LABEL = "finance-refresh" }

[secrets]
API_TOKEN = "op://Service/token/password"
```

`kind` is descriptive unless a backend explicitly declares support for a richer
adapter. The default is `other`.

Examples:

```toml
# deterministic script
[run]
kind = "script"
command = ["/usr/bin/python3", "scripts/audit_tasks.py"]

# Codex
[run]
kind = "codex"
command = ["/opt/homebrew/bin/codex", "exec", "--json", "--", "Run the inbox audit"]

# Claude Code
[run]
kind = "claude"
command = ["/Users/matteocarrabba/.local/bin/claude", "--print", "Run the briefing cycle"]
```

Provider-specific hooks such as `NOTIFY:` lines are C3 conventions, not
OpenWorkspace runtime semantics. OW should expose enough structured status that
C3 can decide how to notify Matteo.

## Portable Host Identity

Host identity is stable and explicit. A host record needs:

- `id`: the name used in `machines = [...]`;
- `backend`: `local-launchd`, `linux-systemd`, `ssh-remote`, `cloud-worker`, etc.;
- `always_on`: whether stale heartbeat is critical or merely expected;
- `runner_version`: published by the host;
- `capabilities`: secrets, network, local filesystem access, browser, GPU,
  supported program kinds, etc.;
- `sync_mode`: how it can read the workspace and publish registry summaries.

For local hosts, the workspace can be the normal filesystem tree. For cloud
hosts, the workspace may be a git checkout, a read-only mirror, or a mounted
sync volume. The runner only depends on the backend presenting a project tree
and a host state directory. If a backend cannot read Matteo's full `~/Documents`
tree, it can still run automations whose signatures and capabilities are
satisfied by that backend.

This implies future status output should distinguish:

- declared for host;
- enabled on host;
- host reachable/fresh;
- host capabilities satisfy manifest;
- workspace mirror fresh enough for this automation;
- latest run state.

That distinction prevents a future cloud runner from being treated as a weird
Mini. It is just another host with different capabilities and sync constraints.

## Status Vocabulary

Stored attempt statuses:

- `starting`
- `running`
- `succeeded`
- `failed`
- `timed_out`
- `skipped`
- `error`
- `abandoned`

Computed run states:

- `pending-first-run`
- `running`
- `overdue`
- `stuck`
- `missed`
- `unknown`
- `unobservable-direct-exec`

Computed health rollups:

- `ok`
- `attention`
- `critical`
- `unknown`

Do not store `stuck` as a primary status. Compute it from `running` plus stale
heartbeat, missing/dead PID, or an exceeded deadline. For remote machines, if
the machine registry is stale, report `unknown`, not `ok` or `stuck`.

## Scheduling Semantics

The existing manifest key remains:

```toml
[schedule]
cron = "0 * * * *"
miss_policy = "skip"
```

Extend it:

```toml
misfire_grace_seconds = 300
max_catch_up = 3
```

Allowed `miss_policy` values:

- `skip`: default. Run only if the latest due occurrence is within grace; record
  older missed occurrences as skipped and advance the cursor.
- `catch-up`: run missed occurrences oldest-first, bounded by `max_catch_up`;
  record overflow as skipped-over-cap.
- `fail-loud`: if an occurrence was missed beyond grace, record a synthetic
  failed outcome and do not run the command. Do not repeat the same miss on
  every tick.
- `coalesce`: run once for the missed window and pass
  `OW_SCHEDULED_FROM`, `OW_SCHEDULED_THROUGH`, and `OW_SCHEDULED_COUNT`.

Timezone stays rejected until explicitly implemented. Scheduling is machine
local. DST nonexistent times are skipped; repeated wall-clock times collapse to
one scheduled key.

Add overlap controls:

```toml
[run]
overlap_policy = "skip" # skip | queue | coalesce | fail-loud | allow
max_concurrency = 1
```

Default is no concurrency. `allow` requires explicit `max_concurrency > 1`.
This is per machine; two declared machines are independent activations.

## Runner Behavior

Each backend invokes the runner with project UID, automation name, and trigger.
For the initial `local-launchd` backend, the LaunchAgent uses:

```text
runner --uid <uid> --name <name> --trigger calendar
```

The runner should:

1. Create a local attempt record before any synced-tree read.
2. Acquire or respect the local lease.
3. Resolve UID to canonical project path.
4. Load and validate the live manifest.
5. Resolve secrets with per-resolver timeout.
6. Spawn the command asynchronously, not via `spawnSync`.
7. Heartbeat the attempt while the child runs.
8. Enforce timeout with process-group termination: SIGTERM, short grace, SIGKILL.
9. Write local log and attempt outcome.
10. Best-effort publish human logs and registry mirror to the synced tree.

The runner must be able to produce an error attempt even when manifest loading,
secret resolution, UID resolution, or synced-tree publishing fails.

## Supervisor

Install one machine supervisor LaunchAgent:

```text
com.openworkspace.supervisor
```

Shape:

- `RunAtLoad = true`
- `StartInterval = 300`
- short-lived tick, not a long-running daemon
- scans local activation records and local run ledger first
- only touches synced workspace paths when needed and with bounded timeouts

Supervisor responsibilities:

- refresh local machine health;
- identify stale active attempts;
- mark dead pre-reboot attempts as `abandoned` or `interrupted`;
- enforce missed-run policy from local schedule cursors;
- publish best-effort registry summaries;
- surface local stuck/failed/unpublished-log findings.

Per-automation plists remain for calendar precision. The supervisor is the
recovery path, not the only scheduler.

## Synced Registry Mirror

Keep existing registry fields and extend them:

```toml
[current_runs."<project_uid>--<name>"]
run_id = "..."
status = "running"
started_at = "..."
heartbeat_at = "..."
deadline_at = "..."
timeout_seconds = 1800
log_publish_status = "pending"

[last_runs."<project_uid>--<name>"]
run_id = "..."
started_at = "..."
finished_at = "..."
status = "timed_out"
exit_code = 137
reason = "timeout"
log = "C3/_project/automations/briefing-cycle/logs/mini/..."
```

Registry writes are best-effort and throttled. The registry heartbeat is sync
visibility, not authoritative machine-local liveness.

## CLI Surface

Keep existing verbs:

- `projects automation apply`
- `projects automation deactivate`
- `projects automation list`
- `projects automation list --all`
- `projects automation status`
- `projects automation logs`
- `projects automation run-now`
- `projects automation prune`

Add or extend:

- `projects automation apply --dry-run`
- `projects automation status --all`
- `projects automation status --failed`
- `projects automation status --stale`
- `projects automation status --running`
- `projects automation status --machine mini`
- `projects automation why <name> --machine mini`
- `projects automation reap <name> --machine mini`
- `projects automation supervisor install|status|tick`

Example status:

```text
HEALTH    PROJECT  AUTOMATION       MACHINE  ENABLED  RUN       LAST        NEXT/DUE    WHY
ok        C3       weekly-tasks-audit mini    yes      ok        Jun 22      Jun 28      fresh
critical  C3       briefing-cycle    mini     yes      stuck     running 93m now         timeout 30m; pid alive
unknown   C3       inbox-triage      mini     yes      unknown   Jun 22      unknown     machine registry stale
```

`status` must not print `no drift` as an all-clear if machine heartbeat,
scan health, active run, last run, or visibility state is unhealthy.

## Dashboard

The automation view should be a dense table, one row per automation-machine
pair, with expandable detail.

Columns:

- Health
- Project
- Automation
- Machine
- Declared
- Enabled
- Install
- Run
- Last
- Next due
- Heartbeat
- Why
- Log

Top strip:

- machine heartbeat freshness;
- enabled count;
- running count;
- failed count;
- stuck count;
- unknown count.

Filters:

- Needs attention
- Running
- Failed
- Stale
- Invalid
- Machine

Never render green if machine freshness is stale. A stale remote registry means
`unknown`, not `ok`.

## Doctor

Schema/config errors remain errors. Operational problems are warnings with
urgency:

- `automation-run-stuck`
- `automation-run-overdue`
- `automation-machine-stale`
- `automation-missed-fire`
- `automation-declared-not-enabled`
- `automation-enabled-undeclared`
- `automation-direct-exec-unmanaged`
- `automation-log-publish-failed`
- `automation-secret-looking-env`
- `automation-secret-looking-argv`
- `automation-no-timeout`

Doctor should propose commands, not mutate. Example:

```text
warn critical automation-run-stuck C3 briefing-cycle@mini
  run 20260625T160000Z has heartbeat stale 42m and timeout_seconds=1800
  inspect: projects automation why briefing-cycle --machine mini --project C3
  recover: ssh mini 'projects automation reap briefing-cycle --machine mini'
```

## Alerting

OpenWorkspace core should expose machine-readable status. C3 should decide how
to write Brief entries or send texts.

Suggested C3 adapter policy:

- Brief Watch: stale machine, first failure, declared-not-enabled.
- Brief Sign-off: stuck run, repeated failure, active invalid manifest, missed
  critical schedule.
- notify-text: stuck past 2x timeout, machine unreachable more than 24h,
  security leak suspected, or repeated `fail-loud` failure.

Debounce by fingerprint:

```text
code + project_uid + automation + machine
```

Resolve alert when the next healthy run is recorded.

## Direct Exec

`direct_exec = true` bypasses the runner and cannot provide full v2 semantics.
Treat it as unmanaged:

- reject secrets;
- reject or warn on non-`skip` miss policies;
- warn on timeout/env expectations that require runner enforcement;
- status = `unobservable-direct-exec`.

Managed-runner mode is the default for C3 automations, regardless of payload
kind. A managed automation can run a deterministic script, Codex, Claude Code,
or another agent. `direct_exec` remains an escape hatch for cases where the host
platform can run something but OW cannot yet supervise it correctly.

## Migration

No manifest migration is required for current C3 `automation.toml` files, but
cleanup is needed.

Compatibility:

- existing `last_runs` remain valid legacy records;
- existing machine logs remain valid;
- readers tolerate missing `run_id`, `current_runs`, and v2 fields;
- first v2 run creates local ledger and starts publishing richer registry state.

Cleanup:

- treat `schedule.toml` and `runs/.installed-at` as stale legacy audit artifacts;
- archive/remove them after burn-in;
- do not import them as control-plane truth.

Rollout:

1. Snapshot Mini LaunchAgents, App Support OpenWorkspace store, synced registry,
   and C3 automation folders.
2. Normalize docs/manifests and reject ignored legacy fields loudly.
3. Implement/test v2 with fake launchd and temp stores.
4. Deploy only from a clean, pinned OpenWorkspace commit on laptop and Mini.
5. Verify Mini facts: machine id, runner node, TCC grants for the selected
   payload runtimes, op resolver, bootstrap environment.
6. Apply v2 and supervisor on Mini.
7. Verify one launchd-fired run, not only `run-now`.
8. Burn in for one weekly cycle.
9. Rotate exposed tokens and delete legacy plists/metadata.

Rollback before burn-in:

- deactivate v2 jobs;
- restore snapshot launchd plists;
- note registry drift as intentional rollback state.

Rollback after token rotation:

- do not reuse old parked plists;
- reinstall with fresh secrets or revert to a pinned prior OpenWorkspace SHA and
  re-apply.

## Implementation Plan

Suggested worker split after approval:

1. Ledger and state library:
   - run IDs, attempt TOML, lease TOML, status computation, process liveness.
2. Schedule engine:
   - due occurrence calculation, cursor, miss policies, overlap policies.
3. Runner rewrite:
   - async spawn, heartbeat, process-group timeout, local ledger, publish mirror.
4. Supervisor:
   - launchd plist, tick command, stale-run recovery, missed-run recovery.
5. CLI:
   - dry-run apply, status table/json, why, reap, supervisor commands.
6. Dashboard:
   - automation-machine table, filters, health rollups, no false green.
7. Doctor:
   - operational warnings and urgency.
8. Migration/docs/tests:
   - README/skill updates, legacy metadata cleanup plan, Mini deploy runbook.

Test priority:

- pure schedule policy tests;
- ledger transition tests;
- runner timeout/stubborn-child tests;
- supervisor recovery tests;
- fake-launchd apply/status tests;
- dashboard API shape tests;
- doctor warning tests;
- Mini smoke test through launchd.

## Open Approval Questions

1. Which miss policies should v2 ship?

   Recommendation: implement `skip` and `catch-up` now; reserve and validate
   `fail-loud` and `coalesce`, but reject them at apply time until the simpler
   policies are proven. This gives immediate value for C3 while avoiding subtle
   schedule/window bugs in the first cut.

2. Should `reap` be automatic?

   Recommendation: make detection automatic and destructive recovery explicit in
   the first version. Status/doctor/dashboard should loudly report `stuck` and
   propose `projects automation reap ...`; the supervisor may auto-mark a run
   `abandoned` when the owner PID is gone and the lease is stale, but killing a
   live process should require an operator command until the ledger has burned
   in. After confidence, add an opt-in `auto_reap = true`.

3. Where should alerting live?

   Recommendation: OW core emits structured status only; C3 owns Matteo-facing
   Brief/text behavior as an adapter consuming `projects automation status
   --json`. Do not put C3-specific notification policy in OpenWorkspace. Later,
   OW can expose a generic hook point, but it should not block v2.

4. Should `direct_exec` remain supported?

   Recommendation: keep `direct_exec` as an explicit unmanaged escape hatch, but
   require C3 automations to use managed-runner mode unless there is a written
   exception. Managed-runner mode is provider-neutral: deterministic scripts,
   Codex, Claude Code, and other agents all run through the same scheduler,
   ledger, timeout, and status machinery.

5. Should `apply --all` install the supervisor automatically?

   Recommendation: yes, for any host backend where OW owns activation. A machine
   with enabled automations but no supervisor is a broken partial install. Also
   provide `projects automation supervisor install|status|tick` for explicit
   bootstrap/debugging.

6. Should OW ship provider-specific adapters for Codex/Claude/other agents?

   Recommendation: not in the scheduler core. Add only optional examples or thin
   helper templates later. The core should treat every payload as an opaque
   command plus declared `kind`, env, secrets, capabilities, timeout, and logs.
