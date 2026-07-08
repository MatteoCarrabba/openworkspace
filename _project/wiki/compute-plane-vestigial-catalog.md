# Compute-Plane Phase 3: Vestigial Peer-Coordination Catalog

status: catalog-only (nothing here has been removed)
created: 2026-07-08

## Why this exists

Phase 3 reframed compute placement declaratively (`runs_on`, the forward name
for the `machines = [...]` field — see `AutomationManifest.machines` in
`src/primitives/automations.ts`) but deliberately did NOT rip out the
peer-coordination machinery that was built for a multi-machine,
independently-applying, iCloud-synced model (mini + laptop, each running its
own `projects automation apply` and writing its own
`.openworkspace/machines/<id>.toml`). That machinery still works today and the
live laptop automations (briefing-cycle, weekly-tasks-audit) depend on parts of
it. This note catalogs exactly what becomes vestigial IF/WHEN a "hub" phase
lands — a single always-on service that is the sole executor and the sole
source of truth for placement and run state — so that phase can cut this
code with confidence instead of re-deriving the analysis. **Nothing listed
here should be removed opportunistically; removal is a hub-phase decision.**

The core reasoning: peer coordination exists to answer "is that OTHER
independently-acting machine alive, and does its independent view of the world
agree with mine?" A hub is not a peer — it is the one executor. Once there is
only one place that applies/runs automations, questions phrased as
cross-machine reconciliation stop being meaningful; they collapse to "is the
hub itself healthy," a much simpler, already-well-covered question (the
automation-runs.ts run ledger + automation-supervisor.ts already answer that
for a single machine).

## 1. Heartbeats

- **Where**: `src/init.ts` — `patchMachineRegistry` stamps `heartbeat =
  <now>` on every write to a machine's `.openworkspace/machines/<id>.toml`
  (`updateMachineRegistry`, `recordRegistryActivation`,
  `removeRegistryActivation`, `recordRegistryRunOutcome` all funnel through
  it). "A write IS a liveness proof" per the doc comment there.
- **Why vestigial under a hub**: the heartbeat exists so that OTHER machines
  (reading the synced file, not talking to the writer directly) can tell
  whether that machine is still alive/syncing. A hub has no peers reading its
  liveness out of a synced TOML file — it can just... be up, or report its own
  process health directly. The heartbeat becomes a self-referential fact
  nobody outside the hub needs to poll for.
- **Caution**: `projects home init` also uses this path for identity refresh
  (unrelated to peer liveness) — don't delete the whole registry file
  mechanism, just the staleness-consumption side (§2) once there's truly one
  writer.

## 2. Staleness warnings

- **Where**: `src/primitives/automations.ts` — `MachineRegistryView.staleDays`
  / `listAllMachines` / `listAllMachinesAt`; `src/doctor.ts` — the
  "machine-registry heartbeat staleness" check (searches for
  `HEARTBEAT_STALE_AFTER_MS`, ~doctor.ts around the `sync-conflict artifact`
  block).
- **Why vestigial under a hub**: staleness answers "has that OTHER machine
  gone dark." With one executor, "has the hub gone dark" is answered by
  whether the service/launchd job is running at all (a process-supervision
  question), not by reading a peer's last-write timestamp out of a synced
  file three days later.

## 3. Reconcile drift-healing (cross-machine placement, NOT project lifecycle)

- **Where**: `src/primitives/automations.ts` — `status()`'s cross-machine
  finding kinds: `remote-declared-inactive`, `remote-activated-undeclared`,
  plus the `readMachineRegistryRaw` / `listAllMachinesAt` helpers that back
  them. `src/doctor.ts` — `automationPlacementIssues()`, which compares each
  manifest's declared `machines` against every OTHER machine's registry file
  to find declared-but-not-activated and activated-but-undeclared drift.
- **Why vestigial under a hub**: this whole class of check exists because N
  machines independently apply and each keeps its own local truth, so nothing
  guarantees convergence — "declared for mini, but mini says it never applied"
  is a real, silent failure mode today. Under a hub, applying IS the placement
  decision, made once, by the one thing that can run it; there is no second
  independent actor whose registry can drift out of sync with the manifest.
- **Explicitly NOT included here**: `src/reconcile.ts`'s project **lifecycle**
  drift-healing (declared `project.toml` lifecycle vs. folder location,
  decision-2's `planLifecycleDrift`/`revertLocation`/`adoptLocation`). That is
  single-workspace state healing about where a project folder sits, unrelated
  to which machine executes automations, and stays relevant regardless of the
  compute-plane model.

## 4. Mint-suffix IDs (`task-7-mini`)

- **Where**: `src/lib/ids.ts` — `machineSuffix` on `formatId`/`parseId`/
  `MintOptions`, and the doc comment's "Mini-minted records take a machine
  suffix." The duplicate-ID doctor check is the documented "cross-machine
  merge backstop" for when this still collides anyway.
- **Why vestigial under a hub**: the suffix exists to keep two machines that
  might mint the same next sequential ID into the same iCloud-synced tree from
  colliding when their filesystem views haven't converged yet. A hub is a
  single writer for anything it mints, so the race this defends against can't
  happen by construction for hub-originated records.
- **Caution — this one is the least clear-cut**: humans will keep hand-editing
  the tree directly from laptop AND mini regardless of whether automations run
  on a hub (task creation is not automation-only), so the underlying
  concurrent-mint problem may outlive the hub for human-originated IDs. Do not
  remove the suffix mechanism in the hub phase without separately confirming
  whether human-driven task/decision creation is also collapsing onto the hub
  as the sole writer — if it isn't, this one stays.

## What is NOT vestigial (do not lump these in)

- `src/primitives/automation-runs.ts` (the run ledger: attempts, leases,
  `computeRunState`) — per-run, own-machine-only truth; a hub still needs
  exactly this.
- `src/primitives/automation-supervisor.ts` — explicitly documented as
  "local-first... recover only facts this machine owns"; already
  hub-compatible.
- `src/primitives/automation-scheduler.ts` — pure cron/cursor/overlap math,
  no cross-machine anything.
- Provenance fields on the run ledger (`machine_id` + `created_at`, pinned
  immutable across `updateAttempt` patches — see the `AutomationAttempt`
  provenance note in `automation-runs.ts`) — still exactly what a hub needs to
  record which executor ran a given attempt and when.
