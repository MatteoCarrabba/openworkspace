---
id: task-5
title: Revisit dashboard UI concepts and implement the OW dashboard UI improvements
status: todo
quadrant: q2
labels:
  - ux
hidden_until: null
created: 2026-07-09
updated: 2026-07-09T18:35:00Z
---
## Description

The live dashboard is **flat** — dense with info but almost no visual
hierarchy, so the eye lands nowhere and every view reads as one undifferentiated
gray list. A 2026-07-09 review diagnosed the specifics (status invisible; empty
section headers in the detail pane; ids out-shout titles; the attention bar
de-emphasizes the actionable counts; panes don't scroll independently; no accent
identity / spacing rhythm) and produced three interactive concept mockups.

Revisit the concepts, pick a direction (or combine), and implement the
improvements in the real React client.

**Concepts + diagnosis live at** `docs/dashboard-concepts/` (README + three
self-contained HTML files built on real workspace data):
- **A — Signal** (`concept-a-signal.html`): fixes the *list* — status color
  system, badges, clickable attention chips, List↔Board toggle.
- **B — Focus** (`concept-b-focus.html`): fixes the *detail pane* — independent
  scroll, empty sections vanish, demoted metadata, Cmd-K palette, keyboard nav.
- **C — Pulse** (`concept-c-pulse.html`): reorganizes the *top level* — cross-
  project attention feed, project momentum, Eisenhower quadrants, pull-into-plan.

Working recommendation from the review: **C (overview) → A (drill-in list) →
B (task detail)**, sharing one status color system.

## Acceptance Criteria

- [ ] Re-open the three concepts and decide a direction (one, a blend, or a 4th).
- [ ] Status is visible at a glance in the list (color-coded status system).
- [ ] Detail pane no longer shows empty section headers.
- [ ] Attention counts are prominent and actionable; ids demoted under titles.
- [ ] Change is built in a worktree via the `developing-openworkspace` skill and
      shipped via `openworkspace-ship` without breaking the live dashboard.

## Why this matters

The dashboard is Matteo's survey/planning surface (see task-2), but its flat
presentation actively fights that job — you can't scan state or triage at a
glance, which is the whole point. The concepts already exist and are validated;
this is the highest-leverage remaining dashboard work and turns a
"technically-correct but frustrating" tool into one that's actually pleasant to
use daily.

## Implementation Plan

1. Review `docs/dashboard-concepts/` and pick/blend a direction.
2. Worktree via `developing-openworkspace`; port the chosen ideas into
   `src/dashboard/client/` (React + TS, single-file Vite build).
3. Keep it CSP-safe / dependency-free; preserve URL-persisted state.
4. Verify in-browser, then `openworkspace-ship`.

## Implementation Notes

2026-07-09: Concepts built and saved to `docs/dashboard-concepts/`. Not yet
implemented in the real client. Charset bug in concept C was fixed before saving.
