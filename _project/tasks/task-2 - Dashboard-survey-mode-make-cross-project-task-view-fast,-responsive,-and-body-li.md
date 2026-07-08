---
id: task-2
title: "Dashboard survey mode: make cross-project task view fast, responsive, and body-light"
status: doing
quadrant: q1
hidden_until: null
created: 2026-06-25
updated: 2026-06-25T21:47:54Z
---
## Description

Make the dashboard a survey surface for planning: Matteo should be able to scan
open work across active projects and pull items into `Today.md`, `This Week.md`,
or `This Month.md`. The dashboard should not try to choose the next action.

## Acceptance Criteria

- [ ] Project/task list loads quickly on the live `~/Documents` workspace.
- [x] List payload omits full task bodies; task detail loads lazily.
- [x] Active/all/dormant filters are obvious and preserve counts.
- [x] Mobile and desktop layouts are usable for read-only surveying.
- [x] Editing/closing/adding tasks is consciously deferred or implemented.

## Why this matters

The current dashboard does not support Matteo's core planning loop. A useful
dashboard is the bridge between OpenWorkspace as task store and Matteo's
human-authored daily/weekly/monthly planning docs.

## Implementation Plan

## Implementation Notes

2026-06-25 partial implementation:
- `/api/scan` now returns body-light task records for the dashboard; task bodies
  load through `/api/task?project=<uid>&task=<id>`.
- Dashboard list gained search, status filtering, open-task default filtering,
  and responsive single-column/mobile layout.
- Normal dashboard launches run scan/detail work in `scan-child.js`, so a
  FileProvider stall does not freeze the HTTP server process.
- Local `~/Documents` scan payload dropped to about 190 KB for 458 tasks with
  zero non-empty task bodies in the list payload.
- Mini now binds `*:8790` and serves `/`, but `/api/scan` still times out after
  20s against the synced Documents tree. The remaining load blocker belongs to
  task-3.

## Log

- 2026-06-25T21:47Z — 2026-06-25 audit: Matteo wants dashboard primarily for surveying open tasks/plans across projects while drafting Today/This Week/This Month. Current scan JSON is ~840 KB for 457 tasks; ~538 KB/64% is task body text. The list view should be body-light and lazy-load task detail. Dashboard also needs responsive mobile/desktop usability; editing tasks is optional. (codex)
- 2026-06-25T22:24Z — Implemented body-light scan, lazy task detail endpoint, search/status filters, responsive layout, and scan-child isolation. Local tests pass; Mini dashboard process now stays responsive but live data scans still timeout on the underlying FileProvider path. (codex)
- 2026-07-08T15:06Z — Replaced the invalidate-and-cold-rebuild scan cache behind `/api/scan`/`/api/task` with a `WarmModel` (decision-7 Phase 1b): built once at server start, kept current by write-through on the mutation path and `fs.watch` reconciliation, served entirely from memory. This targets the first (still-unchecked) acceptance criterion directly, but has only been verified against `tests/dashboard.test.ts`'s temp-dir fixtures, not the live `~/Documents` tree — the FileProvider-stall root cause tracked in task-3 is unrelated (reads are cheap once warm; the open question is whether the initial `fs.watch` setup and first full build are themselves cheap enough over FileProvider). Do not check the box until that's confirmed live. The client was also rebuilt as React + Vite (single self-contained HTML, decision-8) in the same pass — a faithful port, no behavior change to the criteria above. (claude)
