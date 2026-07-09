---
name: openworkspace-ship
description: >-
  Promote finished OpenWorkspace development from an isolated worktree branch to
  `main` and the live tooling — the merge → install-client-deps → rebuild dist →
  full-suite → push → restart-dashboard → verify → cleanup checklist. Use this
  whenever work on the OpenWorkspace repo (`Personal OS/openworkspace`) is
  complete and needs to reach the live `projects` CLI and the always-on
  dashboard, or when the user says "ship it", "merge to main", "promote", or
  "make it live" for OpenWorkspace. Assumes the change was built in a worktree
  per the `developing-openworkspace` skill.
---

# Shipping OpenWorkspace to main + the live tooling

The live `projects` CLI and the `com.openworkspace.dashboard` LaunchAgent both
run from main's built `dist/`. Promotion = rebuild that `dist` from a verified
merge, then refresh the running dashboard. Do the steps in order; each gate
protects the live tooling.

## Checklist

1. **Worktree green first.** In the worktree, confirm the full suite is green.
   Under heavy load the known flakes (`ids` lock-steal, `fs.watch` reconcile)
   may fail — an **isolated** re-run is the truth (`node --test dist/tests/dashboard.test.js`).
   Only proceed from a genuinely-green state.

2. **Merge to main** (in the real repo, not the worktree):
   ```sh
   cd "$HOME/Documents/Personal OS/openworkspace"
   git merge --no-ff <worktree-branch> -m "…"
   ```
   If multiple branches must land (e.g. a scattered workflow), merge each and
   resolve conflicts. `README.md` / `_project/wiki/*.md` are the usual conflict
   surface — resolve by **rewriting them comprehensively**, not by hand-merging
   markers.

3. **Install client deps in main.** The client `node_modules` is git-ignored, so
   after a merge that touched the client the build needs them:
   ```sh
   (cd src/dashboard/client && npm install)
   ```

4. **Rebuild `dist` + run the full suite on main:**
   ```sh
   npm test        # rebuilds dist (tsc + client vite build) then runs tests
   ```
   Confirm green. If only a known flake fails, re-run / isolate to confirm it's
   not a regression.

5. **Push:** `git push origin main`.

6. **Restart the live dashboard** so it serves the new `dist`, and verify:
   ```sh
   launchctl kickstart -k gui/$(id -u)/com.openworkspace.dashboard
   sleep 3
   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8790/   # expect 200
   ```
   For a UI change, spot-check the served HTML (`curl -s http://127.0.0.1:8790/`
   → single-file: `0` external `http` asset refs) or drive it in the browser.

7. **Clean up the worktree + branch:**
   ```sh
   rm -f "$WT/node_modules" "$WT/src/dashboard/client/node_modules"
   git worktree remove "$WT" --force && git worktree prune
   git branch -D <worktree-branch>
   ```

8. **Update docs** for anything user-facing: `README.md` (features/endpoints +
   the test count), `_project/wiki/service-architecture.md`, a decision record
   for significant design choices, and the `Personal OS` plan for the session
   narrative. (Docs are the thing most easily forgotten — this project's own
   audit flagged doc-staleness as a recurring failure.)

## If `projects` breaks

If the CLI is broken after a rebuild (module-load error, bad build), restore by
checking out the last-good `main` and rebuilding (`git log` shows it); if
`node_modules` was clobbered, `npm install` (root) + `npm install` in the client
(package-lock is authoritative — nothing is lost). If restore fails, **STOP**
and park a sign-off item rather than improvising on the live toolchain.
