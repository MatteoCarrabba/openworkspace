---
id: task-7
title: "Remove machine-specific skills path: defaultSourceRoots hardcodes <ws>/Personal OS/OpenWorkspace/skills"
status: done
quadrant: q2
hidden_until: null
created: 2026-09-29
updated: 2026-09-29T21:42:53Z
---
## Description

`src/skills.ts` `defaultSourceRoots()` adds `path.join(ws.root, "Personal OS", "OpenWorkspace", "skills")` (and `ws.root/OpenWorkspace/skills`) to find OpenWorkspace's own bundled skills. That's one user's folder layout. On any other machine the bundled skills aren't found (silently, since missing dirs are skipped).

Fix: resolve bundled skills relative to the installed package (e.g. from `import.meta.url`/`__dirname` → `<package>/skills`), with an optional workspace config override. Keep per-project `Skills/` discovery as is. Also grep the rest of `src/` and the dashboard for layout assumptions.

## Acceptance Criteria

- [x] No user-specific path segments in `src/`
- [x] Bundled skills found from the package location; a test with a workspace at an arbitrary root
- [x] Existing layout still works

## Final Summary

Shipped 2026-09-29: merged `fix/task-7-bundled-skills-path` (cb96b42) into main (11469f8), pushed (main at ff1b0c0 with the external-roots feature). Bundled skills resolve from the installed package (`<package>/skills` via `__dirname`), overridable with `[skills] bundled_dir`; source roots dedupe by (dev, ino). The node_modules blocker was fixed by moving the repo out of iCloud to `~/Code/openworkspace` and running plain `npm ci` (root + client); `~/.node_modules/openworkspace` deleted. Live check: `projects skills sync --apply` gives the same 25 skills with no self-collision warnings; OpenWorkspace's own skills link to `~/Code/openworkspace/Skills/<name>` (the package's `skills/` dir, same inode). Suite 466/466. The other layout assumptions listed in the log (doctor's `~/Documents` TCC and `~/.local/bin/claude` checks) are unchanged.

## Why this matters

OpenWorkspace is meant to be general-purpose; layout assumptions break it for anyone else and hide the failure.

## Log

- 2026-09-29T20:15Z — Fix implemented + committed on branch fix/task-7-bundled-skills-path (cb96b42), worktree at the session scratchpad ow-wt; NOT merged/shipped. Change: bundled skills now resolve from the installed package (<package>/skills via __dirname), overridable with [skills] bundled_dir in .openworkspace/config.toml (relative to ws root; "" disables); hardcoded 'Personal OS/OpenWorkspace/skills' + 'OpenWorkspace/skills' removed. Also dedupes source roots by (dev,ino): on case-insensitive APFS the repo's skills/ was scanned twice (project Skills/ + hardcoded path), giving 6 spurious self-collisions in skills sync. Worktree suite 456/456 (+5 tests: arbitrary temp root finds bundled skills; live-like layout scans once and the project path wins; identity dedup; config override/disable). Live dry-run with branch build: same 24 skills, same sources, 72 ok. BLOCKER (why not shipped): main can't build. Root node_modules -> ~/.node_modules/openworkspace/root (repointed 2026-09-12) is a flattened package dir, so tsc fails resolving undici-types. The client node_modules is a symlink to itself (a loop), and the real deps sit in iCloud-duplicate 'node_modules 2' dirs. Live dist is last good build (Jul 8). npm test on main would fail tsc (and tsc still emits into live dist). Needs a supervised node_modules repair on main (e.g. npm ci root + client, decide on out-of-iCloud location), then ship per openworkspace-ship. Other layout assumptions (listed, not changed): doctor claude-grant-staleness assumes workspace under ~/Documents (Documents-folder TCC) + claude at ~/.local/bin/claude (gated on activations, overridable in tests); comments mention 'Matteo'/laptop/Mini (workspace.ts:38, reconcile.ts etc.). Dashboard client: none found.
- 2026-09-29T21:42Z — Shipped: merged to main (11469f8) and pushed; repo moved to ~/Code/openworkspace with clean npm ci deps; live skills sync verified (25 skills, no self-collisions). See Final Summary.
