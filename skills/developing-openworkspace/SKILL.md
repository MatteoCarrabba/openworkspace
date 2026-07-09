---
name: developing-openworkspace
description: >-
  Safely modify, build, and test the OpenWorkspace codebase itself (the
  `projects` CLI + the dashboard) which lives at `Personal OS/openworkspace/`.
  Use this skill BEFORE editing any TypeScript under that repo's `src/` or
  `tests/`, changing the dashboard React client, running `npm test` there, or
  touching its build — because the live `projects` CLI and the always-on
  dashboard both run from that repo's built `dist/`, so a careless build breaks
  the very tooling you depend on mid-session. Trigger whenever the task is
  "change/fix/add to OpenWorkspace", "the projects CLI", "the dashboard code",
  or any work inside `Personal OS/openworkspace`. To promote finished work, use
  the companion `openworkspace-ship` skill.
---

# Developing OpenWorkspace safely

The OpenWorkspace package is **npm-linked**: `projects` on PATH →
`/opt/homebrew/bin/projects` → `<repo>/dist/src/cli.js`. The always-on
dashboard LaunchAgent (`com.openworkspace.dashboard`) runs from the same
`dist`. **A broken `dist` on main breaks the CLI every skill and this session
depend on.** So the one rule is: never develop against main's `dist` — work in
an isolated worktree and only rebuild main's `dist` after the full suite passes
on the merged result.

## Repo layout

- `src/` — TypeScript (lib, primitives, dashboard/server.ts, runner.ts, cli.ts).
- `src/dashboard/client/` — the **React + Vite** dashboard client, its **own**
  npm package with its **own** `node_modules` and build (`vite-plugin-singlefile`
  → one self-contained `index.html`). Root `npm install` does NOT reach it.
- `tests/` — `node --test` suites. `dist/` — the built output (git-ignored;
  what actually runs).
- Root runtime deps are only `yaml` + `smol-toml`.

## Set up an isolated worktree (do this first)

Work off-tree (off iCloud, so git internals + build artifacts stay out of
FileProvider). Replace `<SCRATCH>` with your session scratchpad dir.

```sh
cd "$HOME/Documents/Personal OS/openworkspace"
WT="<SCRATCH>/ow-wt"                     # off-tree path
git worktree add "$WT" -b my/feature main
# a git worktree has NO node_modules — symlink BOTH from main (no new deps? symlink; new deps? npm install in the worktree instead):
ln -s "$PWD/node_modules" "$WT/node_modules"
ln -s "$PWD/src/dashboard/client/node_modules" "$WT/src/dashboard/client/node_modules"
cd "$WT" && npm test        # baseline — expect ~451 pass / 0 fail
```

- **If a phase will add npm deps**, do NOT symlink that `node_modules` — run a
  real `npm install` inside the worktree (root and/or client) so you don't
  pollute main's install through the symlink.
- **`node_modules` symlink trap:** `.gitignore` now ignores `node_modules`
  (no trailing slash) so a symlink of that name is ignored — but historically a
  worktree `git add -A` committed the symlinks and a later checkout clobbered
  main's real `node_modules` (breaking the live CLI). Prefer committing explicit
  paths; if you do `git add -A`, verify `git status` shows no `node_modules`.

## Test discipline

- `npm test` = `tsc` + the client `vite build` + `node --test`. Green is
  **451/451** (grows as you add tests). Only commit a phase when green.
- **Known load-flaky tests** (NOT regressions): the `ids.ts`
  "stale-lock steal under contention" race, and the dashboard `fs.watch`
  reconcile / SSE-reconcile tests (FSEvents latency under full-parallel load).
  The truth is an **isolated** run — e.g. `node --test dist/tests/dashboard.test.js`
  or `node --test dist/tests/ids.test.js` — which passes cleanly. Never "fix" a
  flake by weakening an assertion; if you must, raise a `waitFor` ceiling.

## Architecture you must respect (read before changing behavior)

Canonical decisions live in `Personal OS/_project/decisions/`:
- **decision-1** — the dashboard write path: mutations route **through the
  library** (never `fs.writeFile` from the server); only status/done/note
  originally, plus decision-9's narrow body edit. Loopback-gated writes.
- **decision-7** — OW as a service: files authoritative for content; the server
  is a **warm-but-disposable** derived read-model (write-through + `fs.watch`),
  never a write-authority; four planes (storage/compute/control/interface);
  content-hash reconcile; earn the heavy parts.
- **decision-9** — task-body edits + checkboxes are **library-mediated and
  hash-guarded** (`setTaskBody`/`toggleChecklistItem`, `expectedHash` → 409 on a
  concurrent edit), deliberately **not** a general WYSIWYG/file editor.
- Any new write must go through a library primitive that preserves frontmatter
  and rides the optimistic-concurrency guard; any new "open app / spawn" must be
  a loopback-gated endpoint resolving paths server-side (never client-supplied).

## When the change is done

Use the **`openworkspace-ship`** skill to merge to main, rebuild `dist`, run the
suite, push, and restart the live dashboard — safely.
