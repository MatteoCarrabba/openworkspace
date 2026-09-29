---
id: task-6
title: Make automation supervisor enforce failure streak and silence thresholds
status: todo
quadrant: q2
labels:
  - automation
  - supervision
hidden_until: null
created: 2026-07-09
updated: 2026-07-09T18:54:38Z
---
## Description

The installed supervisor currently performs stuck/abandoned managed-run
recovery every five minutes, but it does not evaluate the manifest
`[supervise]` fields `failure_streak_to_alert`,
`silence_alert_after_hours`, or `expect_runs_per_day`. Implement the declared
runtime-health semantics and expose structured findings that a project-owned
attention surface can consume without making OpenWorkspace depend on C3.

## Acceptance Criteria

- [ ] A supervisor tick computes failure streaks and silence against each locally activated manifest.
- [ ] Expected-run cadence and catch-up/skip semantics do not produce false silence alerts.
- [ ] Findings are available as structured output and durable machine-local run evidence.
- [ ] Recovery and alert evaluation are independently testable; an alerting failure cannot block stuck-run recovery.
- [ ] Tests cover consecutive failures, overdue silence, healthy sparse schedules, and recovery to healthy state.

## Why this matters

OW manifests already declare health thresholds, so ignoring them creates a
dangerous false sense of supervision: placement can be correct while an
automation has been semantically silent for days. Reliable background work
requires runtime truth, not only activation-drift detection.

## Implementation Plan

## Implementation Notes

Created by the 2026-07-09 C3 truth audit after installing the existing
supervisor. Supersedes the unimplemented residual described in Personal OS
task-164/task-182; Personal OS task-178 remains the process-tree timeout and
kill-hardening concern rather than this health-evaluation scope.
