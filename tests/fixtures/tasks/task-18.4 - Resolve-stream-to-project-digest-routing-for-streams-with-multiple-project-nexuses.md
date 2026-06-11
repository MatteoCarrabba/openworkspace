---
id: TASK-18.4
title: >-
  Resolve stream-to-project digest routing for streams with multiple project
  nexuses
status: To Do
created_date: '2026-05-04 23:41'
labels:
  - gates-phase-d
milestone: phase-a-finish-design
dependencies: []
parent_task_id: TASK-18
priority: medium
quadrant: Q2
ordinal: 22000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase D mail design: how do streams (e.g., Money Stuff) that touch multiple projects get routed to digest agents? Many-to-many nexus design.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Routing model specified in MAIL_DESIGN.md
<!-- AC:END -->

## Why this matters

Without a defined routing model, the daily mail-triage agent and per-stream digest agents will overlap, duplicate, or drop content. This question shapes Phase D's mail-design doc and gates the implementation of any stream digest agent. Important architecturally; not urgent because Phase D hasn't started.
