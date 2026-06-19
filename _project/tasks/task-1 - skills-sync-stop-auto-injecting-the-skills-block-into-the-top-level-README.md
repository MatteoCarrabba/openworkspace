---
id: task-1
title: "skills sync: stop auto-injecting the skills block into the top-level README"
status: todo
quadrant: q2
labels:
  - openworkspace
  - tooling
hidden_until: null
created: 2026-06-19
updated: 2026-06-19T19:28:55Z
---
## Description

`projects skills sync --apply` currently writes and maintains an auto-generated
"Installed agent skills" block in the workspace top-level README
(`~/Documents/README.md`), delimited by:

```
<!-- BEGIN openworkspace:skills (managed by `projects skills sync`) -->
...
<!-- END openworkspace:skills -->
```

Change the command so it **no longer injects or maintains this block**. Skill
aggregation into `.agents/skills/` and the `~/.claude` + `~/.codex` symlink
installs should be unchanged — only the README mutation goes away.

Behavior today (verified 2026-06-19, code in `~/code/openworkspace`):
- `applyReadmeSection` (`src/skills.ts` ~403–423): if both markers present it
  replaces the body between them; **if markers are absent it appends a fresh
  block + markers at EOF**. So deleting the block by hand does not stick — the
  next `--apply` re-creates it (and at the bottom of the file, not its original
  position).
- README target resolved in `src/cli.ts` `buildSkillsEnv` (~1490–1517), path at
  ~1504–1508, overridable via `OPENWORKSPACE_SKILLS_README`.
- Section rendered by `renderReadmeSection` (`src/skills.ts` ~380–393); planned
  by `planReadme` (~425–435); written by the apply path (~526–529).
- Markers are string constants at `src/skills.ts` ~376–377.
- The on-PATH `projects` runs the compiled `dist/`, so a rebuild is required for
  the change to take effect.

## Acceptance Criteria

- [ ] `projects skills sync --apply` does not create, update, or re-append the
      `openworkspace:skills` block in any README.
- [ ] Running sync against a README that still contains the block does not error
      and does not re-add it; ideally it strips the now-orphaned block + markers
      (clean migration) — confirm desired behavior with Matteo (see open question).
- [ ] Skill discovery/aggregation into `.agents/skills/` and the `~/.claude` +
      `~/.codex` symlink install behavior are unchanged.
- [ ] README-injection code paths (`renderReadmeSection`, `applyReadmeSection`,
      `planReadme`, the markers, the `OPENWORKSPACE_SKILLS_README` plumbing) are
      removed, or gated behind an explicit opt-in flag that defaults OFF.
- [ ] Tests updated/removed accordingly; `dist/` rebuilt so the on-PATH `projects`
      reflects the change.
- [ ] `~/code/openworkspace/README.md` and any `_project/wiki/` doc that documents
      the README skills section are updated in the same pass (docs move with work).

## Why this matters

The skills block is a cached aggregate **index** of state that lives elsewhere
(the `SKILL.md` files are the source of truth) — exactly the kind of
"dashboard/index/status table" that load-bearing **principle 2 forbids** ("No
cached aggregate state files... indexes, dashboards, status tables"). It also
duplicates content the agent harness already injects into context, and it has
already drifted (e.g. a stale `Mersi`/glossary-era entry, `_tasks` vs
`_project/tasks` paths). Removing it stops the duplication, removes a drift
source, and makes the top-level README a hand-authored record of intent rather
than a tool-managed surface — which is how Matteo wants it to read.

## Open question

Should `--apply` actively **strip** an existing block when it finds the markers
(self-healing, one-time migration), or just **stop maintaining** it and leave any
existing block alone? The block has already been removed from `~/Documents/README.md`
by hand, so "stop maintaining" is sufficient for the current state; "strip on
sight" is a nicety for any other workspace/README that still carries it.

## Implementation Plan

## Implementation Notes

Migrated from Personal OS task-221 on 2026-06-19, when ~/code/openworkspace became a tracked OpenWorkspace node owned (kind=code) by Personal OS. Original lived in the Personal OS tracker before the project-graph cutover.
