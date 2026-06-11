---
id: TASK-10
title: 'Walk through Backlog.md tooling, then migrate folder-specific TODOs into it'
status: To Do
created_date: '2026-05-04 04:10'
updated_date: '2026-05-04 23:40'
labels: []
milestone: phase-g-conventions-rollout
dependencies: []
priority: medium
quadrant: Q2
ordinal: 10000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The Backlog.md fork is the official task system per Personal OS/_wiki/TASKS.md, but currently only the 9 session-2 followups are in it. Multiple parallel TODO surfaces still exist: Personal OS/TODO.md (the migration plan, plus Phase A/E/H operational items mixed in), Life Admin/TODO.md (per-domain fill-ins + cross-cutting rethinks), and the README narratives in Inbox:Outbox/_from-notes-export/ subfolders. These are state files in disguise (principle 2) — they should either be Backlog tasks or stay as design/plan docs, but not both.\n\nTwo phases:\n1. **Walkthrough**: tour the Backlog CLI + skills together (task-new, task-next, task-review, tasks-audit). Decide naming conventions, project boundaries (single Personal OS backlog vs per-project backlogs vs C2 for cross-cutting), milestone usage, and how the planning surface in C2/ references task IDs.\n2. **Migration**: pull operational items out of the various TODO.md files and parking-lot READMEs into Backlog tasks. Leave architectural plans / phase narratives in TODO.md (those are documentation, not tasks). Update each migrated TODO.md to point at the Backlog instead of duplicating items.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Tooling walkthrough completed; conventions documented in Personal OS/_wiki/TASKS.md (or a delta to it)
- [ ] #2 Decision recorded on per-project backlogs vs single Personal OS backlog vs C2 cross-cutting
- [ ] #3 Operational items in Personal OS/TODO.md migrated to Backlog tasks (Phases C/D/E/F/G/H individual line items)
- [ ] #4 Operational items in Life Admin/TODO.md migrated to Backlog tasks (per-domain fill-ins + cross-cutting rethinks)
- [ ] #5 Inbox:Outbox/_from-notes-export/README.md narrative replaced with task-ID references
- [ ] #6 Architectural / phase-narrative content stays in TODO.md, with a note pointing readers to Backlog for actionable items
<!-- AC:END -->
