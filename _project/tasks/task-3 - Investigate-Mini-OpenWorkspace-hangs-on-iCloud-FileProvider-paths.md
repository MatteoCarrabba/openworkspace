---
id: task-3
title: Investigate Mini OpenWorkspace hangs on iCloud/FileProvider paths
status: doing
quadrant: q1
hidden_until: null
created: 2026-06-25
updated: 2026-06-28T22:01:08Z
---
## Description

Diagnose and fix the Mini-side hangs when OpenWorkspace reads iCloud-backed
`~/Documents` paths. The immediate symptom is stale automations and blocked
status/dashboard checks.

## Acceptance Criteria

- [ ] Reproduce or explain the `EINTR` / `Interrupted system call` behavior.
- [ ] Mini-side `projects automation list/status --project C3` completes.
- [ ] Automation runner timeouts actually terminate stuck runs.
- [x] Dashboard scan hangs are isolated from the HTTP server and return a timeout instead of wedging the process.
- [ ] Stuck-run cleanup/recovery path is documented.
- [ ] Mac Mini registry heartbeat is fresh after the fix.

## Why this matters

The Mac Mini is where background automations run. If filesystem reads hang
there, automation state goes stale and the system cannot prove that background
support is working.

## Implementation Plan

## Implementation Notes

2026-06-25 findings:
- Mini OpenWorkspace source was behind the laptop checkout (`c927ba9` vs local
  `7527774`), so the dashboard source/test tree was synced to the Mini and
  rebuilt there.
- Dashboard startup no longer calls `openWorkspaceRegistered`; it resolves only
  the workspace root before binding so startup does not block on config reads.
- Dashboard scan/detail/automation API work now runs in `dist/src/dashboard/scan-child.js`
  and is killed after 20s if the workspace walk stalls.
- Verified on Mini: dashboard process PID 5120 listens on `*:8790`, `/` returns
  immediately, `/api/scan` returns `504 {"error":"scan scan timed out after 20000ms"}`,
  and `/api/automations` returns `504 {"error":"automations scan timed out after 20000ms"}`.
- The 2026-06-25 15:xx `briefing-cycle` runner remained alive past its
  `timeout_seconds = 1800` threshold (`ps` showed 30:51 elapsed). Terminated
  PID 4475 with SIGTERM; no runner processes remained afterward.
- This contains the dashboard hang but does not fix the underlying synced
  Documents/FileProvider stall.

## Log

- 2026-06-25T21:47Z — 2026-06-25 audit: On Mini, C3 automation registry heartbeat is stale at 2026-06-22T23:17:04Z. SSH worked, but reading ~/Documents/C3/_project/automations sometimes returned EINTR / Interrupted system call, and Mini-side projects automation list/status/doctor hung against --project ~/Documents/C3. Two runner processes had been alive for ~2 days despite configured timeouts; stopped them with launchctl kill SIGTERM so next scheduled fires can start cleanly. (codex)
- 2026-06-25T22:24Z — Narrowed: Mini dashboard can now bind and serve HTML, but scan children still time out walking ~/Documents. Main server stays responsive, and scan children are gone after timeout. Need next pass on why FileProvider-backed paths block and whether OpenWorkspace should scan a local materialized mirror/cache for dashboard reads. (codex)
- 2026-06-25T22:31Z — Confirmed runner timeout failure: briefing-cycle runner was still alive at 30:51 elapsed despite timeout_seconds = 1800. Sent SIGTERM to PID 4475; process exited. This keeps the runner-timeout acceptance criterion open. (codex)
- 2026-06-26T18:31Z — Reproduced the Mini FileProvider problem below OW: `ls -ldO@ ~/Documents` and `ls -lO@ ~/Documents/C3/_project/id` both hung until killed. Restarted user-level `fileproviderd`, `bird`, `cloudd`, and CloudDocs provider processes; directory metadata became readable, but reading `C3/_project/id` still failed with `Interrupted system call` while `fileproviderctl evaluate` claimed the file was downloaded/current. `fileproviderctl check -a ~/Documents/C3` timed out after 30s. Dashboard is now pointed at a local lightweight workspace mirror `~/.openworkspace-mirrors/Documents` so read-only visibility works, but real C3 automation reactivation remains blocked on fixing or bypassing the live iCloud-backed `~/Documents` path safely. (codex)
- 2026-06-26T18:36Z — User added an environment clue: Mini is on Ethernet to a Wi-Fi router known to drop connectivity for ~2-3 minutes several times/day. Spawned background agent Singer (`019f0538-dd6b-7692-a51e-1494a1f7206b`) to run bounded Mini/iCloud/FileProvider diagnostics and assess whether intermittent network loss is causing or amplifying FileProvider stalls before proposing a fix. (codex)
- 2026-06-26T18:47Z — Singer findings: the broken layer is FileProvider/FPFS for the iCloud-backed `~/Documents` domain, not OW. `stat` can see `~/Documents/C3/_project/id` as a 37-byte file, but `cat` returns `Interrupted system call`, `xattr` fails with EINTR, `mdls` hangs, and `fileproviderctl check -a` on the file/_project times out; the mirror copy reads normally. `fileproviderctl evaluate` still claims the file is downloaded/current, so the local provider state is internally inconsistent. `fileproviderctl dump -l` showed a very large active Desktop/Documents domain (~248k reconciliation entries, ~1.5M pending indexable items, active Finder/Spotlight enumerators, throttled reconciliation), and logs showed repeated FPCKService launches/XPC invalidations. The flaky router is plausible as a trigger/amplifier for iCloud retries/reconciliation pressure, but not the whole cause because local reads fail while the file is reported downloaded and network is currently healthy. Safe sequence proposed: keep dashboard on mirror; preserve mirror and verify a known-good source backup; stabilize network before repair/reindex; collect `fileproviderctl diagnose`/bounded check logs; then try low-risk restart/reboot. Blocked until explicit approval: `fileproviderctl repair`, deleting caches, signing out/toggling iCloud Drive/Desktop/Documents, moving the canonical workspace, or re-enabling automations. (codex)
- 2026-06-26T18:57Z — Spawned background agent Sagan (`019f0558-5626-7c83-8451-adc76b6a9316`) to research cloud or non-Mini runtime options that would avoid iCloud/FileProvider as the automation substrate. Scope: compare local non-iCloud Mini workspace+sync, cheap Linux VPS, major-cloud VM, hosted Mac, NAS/Tailscale-style home server, and Git/object-store sync variants with current costs, reliability, privacy, migration path, and open questions. (codex)
- 2026-06-26T22:04Z — Sagan recommendation: short term, keep the Mini but move runtime/dashboard/automation workspace out of iCloud/FileProvider into a plain local APFS path, with iCloud Documents treated as a user-facing copy only. Add Git snapshots, scheduled encrypted backups, and heartbeat monitoring. Long term, use a hybrid control plane: Git for OW text state, object storage for encrypted artifacts/backups, a cheap Linux VPS ($6-$24/mo typical) for always-on scheduler/dashboard/API, and Mini or hosted Mac only for macOS-specific jobs. Avoid bidirectional live sync as the primary write substrate. Open decisions: whether OW canonical text state becomes Git now vs audit snapshots first; which automations truly require macOS/local Apple data; acceptable cloud exposure for C3; whether phone writes directly or only appends to a capture queue; target RPO. (codex)
- 2026-06-28 — Drafted `_project/wiki/local-control-plane-data-plane-design.md`. Direction: do not make a full `~/Documents` mirror the architecture. Instead, keep activation bundles, schedules, leases, run ledgers, logs, scratch, staged outputs, and dashboard runtime state on local APFS; treat iCloud `~/Documents` paths as explicit bounded dependencies of individual payloads. This lets OW report `dependency_unavailable` when iCloud is unhealthy while the scheduler/supervisor/dashboard remain healthy. (codex)
- 2026-06-28T22:01Z — Pauli Mini check recommends restart now after saving/closing active Mini work. Evidence: `stat ~/Documents/C3/_project/id` returns immediately, but a 5s read hangs/no-output, `xattr -l` fails with EINTR, `mdls` cannot find the file after waiting, and `fileproviderctl check -a ~/Documents/C3 -P` times out. FileProvider processes are present, Mini uptime is ~9 days, old OW automation labels are inactive, dashboard is running, and supervisor/bootstrap are loaded. Additional risk: stale older commands touching `~/Documents/C3` remain, including high-CPU `ugrep` processes and stuck `ls -ldeO@ ~/Documents` processes from prior diagnostics. After reboot, verify the sentinel file read before removing the workaround or re-enabling automations. (codex)
