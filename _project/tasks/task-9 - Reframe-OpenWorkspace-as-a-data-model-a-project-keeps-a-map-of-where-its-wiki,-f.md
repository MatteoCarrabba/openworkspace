---
id: task-9
title: "Reframe OpenWorkspace as a data model: a project keeps a map of where its wiki, forums, decisions, plans and tasks live; native file-based stores are one option, not the default expectation"
status: todo
quadrant: q2
labels:
  - positioning
  - docs
hidden_until: null
created: 2026-10-01
updated: 2026-10-01T18:48:43Z
---
## Description

## Acceptance Criteria

- [ ]

## Why this matters

## Implementation Plan

## Implementation Notes
## Why this matters

Matteo, 2026-10-01, while planning MBI's information architecture: at MBI, tasks will live in Teamwork (engineering backlog in GitHub Issues), decisions and plans in the MBI-Docs wiki, and discussion in Slack. Most of that is not in OpenWorkspace's native `_project/` stores. OpenWorkspace's value is the idea underneath: every project should declare where each kind of project information lives, so anyone (person or agent) can find it. Today the README, PRD, skills and doctor checks push people toward the native file-based tasks, decisions, wiki and forum. That's wrong for team projects whose records live in team tools, and it creates orphaned, laptop-only context. This is the failure MBI's data model is designed against.

## Description

Make the core of OpenWorkspace the **project map**: a lightweight, declared index per project of where its wiki, forum(s), decisions, plans, tasks, files, repos and so on live. Each entry can point at a native `_project/` store or an external system (Teamwork, GitHub Issues, a wiki URL, Slack channel, Drive folder). Keep the native file-based stores as a light reference implementation, but stop treating them as required or default.

## Acceptance Criteria

- [ ] Design note: the project map's shape (e.g. a `[map]` table in `_project/project.toml` or a `_project/MAP.md`), the kinds of information it covers, and how external pointers are written
- [ ] README, PRD and `using-openworkspace` skill reframed: data model first, native stores optional
- [ ] `projects doctor` checks the map is present and its entries resolve where checkable; it no longer flags a project for not using native tasks, decisions or wiki when the map points elsewhere
- [ ] Dashboard and `home scan` show external homes as links instead of omitting the project
- [ ] MBI used as the first example: its map points tasks at Teamwork, decisions and wiki at MBI-Docs

