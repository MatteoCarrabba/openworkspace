---
id: task-4
title: "Automation visibility: show enabled/running/failing/stale-by-machine without false green"
status: doing
quadrant: q1
hidden_until: null
created: 2026-06-25
updated: 2026-06-28T00:00:00Z
---
## Description

Make automation status legible and trustworthy from both CLI and dashboard.
Matteo and agents need to see what exists, what is enabled, where it runs,
whether it is currently stuck, when it last ran, and what failed.

## Acceptance Criteria

- [ ] `projects automation list/status` distinguish declared, activated,
      running, stale, failed, and unreachable states.
- [ ] A stale machine heartbeat is surfaced as a high-signal warning.
- [ ] Long-running jobs past timeout are reported as stuck.
- [ ] Dashboard automation view exposes the same state without false green.
- [ ] Output includes machine name, last run time, exit status, and log pointer.

## Why this matters

Automations are only useful if Matteo and agents can trust what is running.
The current surfaces can say "no drift" while the Mini registry is stale and
runner processes are wedged.

## Implementation Plan

## Implementation Notes

2026-06-25 partial progress:
- Dashboard automation API work now runs in a scan child with a 20s timeout, so
  a stuck automation registry/workspace scan returns `504` instead of leaving a
  false-green or unreachable dashboard process.
- Mini still cannot produce the automation dataset: `/api/automations` returns
  `504 {"error":"automations scan timed out after 20000ms"}` while reading the
  synced Documents workspace.
- The CLI/dashboard still need a richer running/stale/failing model once the
  FileProvider scan blocker is resolved.

## Log

- 2026-06-25T21:47Z — 2026-06-25 audit: User needs automation view showing what exists, enabled status, machine, running/stale state, last run, failures. Current local laptop view: projects automation list shows C3 automations declared for mini but 'undeclared'; status says no drift; list --all shows mini heartbeat stale 2d and last runs from Jun 22. Dashboard service on Mini was loaded, but API was not reachable; launchd showed process running with no listener on 8790 after restart. (codex)
- 2026-06-25T22:24Z — Dashboard service reliability improved: Mini now has a listener on 8790 and root HTML responds, while automation scan failures surface as 504 timeouts. Remaining work: actual automation visibility still blocked by the Mini Documents/FileProvider scan stall. (codex)
- 2026-06-25T23:48Z — Drafted Automation Runtime v2 design for Matteo review at _project/wiki/automation-runtime-v2-design.md. Core shape: modular host/backend contract, machine-local run ledger, supervisor tick, richer status/dashboard/doctor model, and synced registry as reporting mirror rather than runtime truth. (codex)
- 2026-06-25T23:54Z — Refined Automation Runtime v2 design to make payload execution provider-neutral. OW core now treats deterministic scripts, Codex, Claude Code, and other agents as opaque managed commands under the same scheduler/ledger/status model; provider-specific behavior belongs outside the core scheduler. Added recommended answers to the approval questions. (codex)
- 2026-06-26T17:59Z — Implemented Automation Runtime v2 foundations in the code checkout: machine-local run ledger/state pointer, scheduler policy helper, provider-neutral manifest fields, runner ledger integration, overlap skip recording, dashboard local-run visibility, CLI/doctor wording, manual supervisor tick, and supervisor LaunchAgent apply/status/deactivate. Full npm test passes (396 tests). Local doctor is clean. Mini verification found the deployed Mini checkout is separate/dirty and lacks this supervisor implementation; two old runner processes are stuck for many hours with no child payloads attached, so rollout/remediation on Mini remains pending rather than silently killing/deploying. (codex)
- 2026-06-26T18:24Z — Mini rollout completed for the v2 code path: backed up the Mini checkout, disabled the three old C3 automation LaunchAgents/activation records to Desktop, overlaid the updated OW checkout, rebuilt and ran the full Mini test suite (396 tests), installed `com.openworkspace.supervisor`, and restarted the dashboard. Remaining blocker for real C3 automation reactivation: Mini `~/Documents`/iCloud FileProvider can still block or fail POSIX reads (first observed on `C3/_project/id`). To keep the dashboard usable, created a lightweight local workspace mirror at `~/.openworkspace-mirrors/Documents` (15 projects, 380 tasks) and pointed Mini dashboard + machine-local OW cache there; `/api/scan` and `/api/automations` now respond quickly, with the expected drift of the three C3 automations being declared for `mini` but not activated. Do not re-enable real C3 automations against the mirror unless write-back semantics are explicitly designed. (codex)
- 2026-06-26T18:30Z — Synced the missing local git working trees from `~/code` to the Mini's `~/code` (excluding generated dependency folders and leaving the deployed `openworkspace` checkout untouched). This reduced mirror `home doctor` from 32 missing-code ownership errors to 6 document sync-conflict artifact errors plus 9 warnings. Dashboard and supervisor still verify: dashboard sees 15 projects / 380 tasks, automation view sees 3 declared-but-not-activated C3 automations, and supervisor tick checks 0 active automations with no findings. (codex)
- 2026-06-28 — Design follow-up captured in `_project/wiki/local-control-plane-data-plane-design.md`: automation visibility should distinguish runtime health from document dependency health. The implementation target is local APFS activation bundles plus bounded iCloud dependency checks, so the dashboard can show "automation installed/runnable, but required iCloud input unavailable" instead of either hanging or turning a temporary dashboard mirror into the architecture. (codex)
