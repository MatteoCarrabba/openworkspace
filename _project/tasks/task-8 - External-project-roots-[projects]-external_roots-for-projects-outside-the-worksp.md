---
id: task-8
title: "External project roots: [projects] external_roots for projects outside the workspace tree"
status: done
quadrant: q2
labels:
  - discovery
hidden_until: null
created: 2026-09-29
updated: 2026-09-29T21:43:12Z
---
## Description

Repos that are OpenWorkspace projects (they commit `_project/`) move whole, tracker included, to `~/Code`, out of iCloud (Matteo's decision, 2026-09-29, `move-repo-out-of-icloud` skill). The workspace needs a config setting listing extra project roots outside the tree, so discovery, the dashboard, cross-project views (`home scan`), `skills sync` and `doctor` still include them. First user: this repo (`~/Code/openworkspace`); next: `~/Code/process-mining-toolkit`.

## Acceptance Criteria

- [x] `[projects] external_roots = [...]` in `.openworkspace/config.toml`: `~` expansion, relative paths against the workspace root, deduped
- [x] Discovery walks each root (a project or a folder of projects, nested projects included); every discovery consumer sees them (list/scan, dashboard + fs.watch, skills sync, doctor, owns, automations, canonical resolution)
- [x] Missing / non-dir / worktree / non-project-git / empty roots are doctor warnings, never crashes; redundant entries are info
- [x] Dedupe with in-tree projects and symlinked spellings (by real path; in-tree wins)
- [x] Split-brain guard: linked worktrees never discovered from an external root, never canonical
- [x] Lifecycle metadata-only outside the tree (no drift, `lifecycle`/`reconcile` never move an external project)
- [x] Workspace-routed commands work from inside an external root (fallback to the known workspace that lists it)
- [x] Documented (README, MODULES, service-architecture, using-openworkspace skill) and tested
- [x] `~/Code/openworkspace` registered in `~/Documents/.openworkspace/config.toml`

## Why this matters

Git repos can't live in iCloud (cruft copies and evicted files broke this repo's build), but repos that are also OpenWorkspace projects must stay visible to the dashboard, briefs and task views after they move. The setting has to be general-purpose, with no user-specific paths in `src/`.

## Implementation Notes

- `src/lib/workspace.ts`: `WorkspaceConfig.projects.externalRoots`; `expandHomePath`, `externalProjectRoots`, `isOutsideWorkspace`, `isWithinPath`, `isLinkedWorktreeCheckout` (spawn-free: `.git` file whose gitdir is `…/worktrees/<name>`); `discoverProjects` walks externals after the tree (`external: false` opts out); `ProjectInfo.externalRoot`; `lifecycleOf` mirrors declared metadata outside the tree.
- `src/lib/resolve.ts#findWorkspaceClaimingPath`: CLI fallback used by `openWorkspaceRegistered` and `show`.
- `src/doctor.ts#externalRootIssues`; `src/reconcile.ts` skips external projects on the lifecycle axis.
- `relPath` for an external project is `path.relative(ws.root, root)` (e.g. `../Code/openworkspace`); invariant `path.resolve(ws.root, relPath) === root` holds.

## Final Summary

Shipped 2026-09-29 in 5e59424 (merge ff1b0c0), pushed. 10 new tests (`tests/external-roots.test.ts`), suite 466/466. Registered `external_roots = ["~/Code/openworkspace"]` in `~/Documents/.openworkspace/config.toml`. Live-verified: `home list`/`home scan` include `../Code/openworkspace` with its tasks, dashboard `/api/scan` shows it with 7 tasks, workspace doctor has no new findings (2 fewer: the deleted iCloud cruft), `projects doctor`/`forum who`/`home list` work from inside the repo, and a linked worktree resolves canonical to `~/Code/openworkspace` without being discovered. To register another repo, add its path to the same array, e.g. `external_roots = ["~/Code/openworkspace", "~/Code/process-mining-toolkit"]`. Older builds (e.g. the Mini's separate checkout) ignore the key; a root missing on another machine is a doctor warning there.
