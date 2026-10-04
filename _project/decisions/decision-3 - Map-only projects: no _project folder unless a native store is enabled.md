---
id: decision-3
title: "Map-only projects: no _project/ folder unless a native store is enabled"
status: accepted
date: 2026-10-04
superseded_by: null
amends: decision-2
---

## Context

Decision-2 made the information map OpenWorkspace's default purpose and the
native stores opt-in, but every project still got a `_project/` folder
(`id`, the orientation README, `.gitignore`, `project.toml`) even when every
primitive lives elsewhere. Matteo, 2026-10-03: "Why should OpenWorkspace
create `_project` as a folder if it's set to map only? The map just goes into
the README and AGENTS.md." For a project whose tasks live in Teamwork and
whose decisions live in a wiki, the folder is an empty control plane that
duplicates what the README already says.

## Decision

1. **Two project forms.** A *folder* project keeps `_project/` exactly as in
   decision-2. A *map-only* project has **no `_project/` folder**: its
   declared document (`[map]`, `lifecycle`, `[[owns]]`) and its identity
   (`uid`) live in a fenced TOML block (`format = "openworkspace-map/1"`)
   inside the "Where information lives" block of its `README.md` (or
   `AGENTS.md`), whose BEGIN marker carries the `map-only` flavor. That block
   is the project's source of truth; the other doc carries a rendered copy
   kept in step by every write. `CLAUDE.md → AGENTS.md` symlinks are written
   through.
2. **Discovery is strict.** Only `README.md`/`AGENTS.md` at the directory
   itself are read; marker lines must be at column 0 outside fenced code;
   the BEGIN line must say `map-only`; the TOML must carry the format tag and
   a UUID `uid`. A document that describes the format is never a project.
   `_project/id` wins when both exist. An unparseable TOML keeps the project
   discoverable (uid by line scan), is a doctor error, and blocks writes.
3. **`_project/` appears only when a native store is enabled.**
   `projects init|new` default to map-only unless `--native` (or `--folder`,
   or `--no-docs`, which leaves nowhere to put the map) is given.
   `projects map set <prim> native` and the first native write create the
   folder with the same uid and move the map into `project.toml` verbatim.
   Presence verbs and reads never create it.
4. **`projects map adopt` converts both ways.** `--map-only` moves the
   document and uid into the block and removes `_project/`, only when it
   holds nothing but the tool's stamps and empty stores and no primitive is
   declared native (it lists blockers otherwise); `--folder` is the reverse.
   Both are dry-run unless `--apply`.
5. **Every surface handles both forms**: doctor (map checks plus the form's
   invariants: no declared-native home, no stray `_project/` without an id),
   `home list` (tag `map-only`), `home doctor`, `home scan --json` and the
   dashboard (`form`), lifecycle reconcile (the committed block is tier-1
   evidence).

## Consequences

- Amends decision-2 §3 ("init stamps `_project/id`, README, `.gitignore`,
  `project.toml`") and the PRD's "projects are directories marked by
  `_project/id`": a project is marked by `_project/id` *or* a valid map-only
  block.
- Existing `_project/` projects are unchanged; nothing is converted
  automatically. `projects map adopt` on an eligible folder project says it
  could drop the folder.
- Scripts that `projects init` and then `task create` still work: the first
  native write promotes the project to the folder form (a stderr note says
  so).
- Discovery now reads `README.md`/`AGENTS.md` once per walked directory;
  measured on `~/Documents` the `home doctor` and `home list` times and
  outputs are unchanged.
- External tools may write a map-only block themselves (pmt engagement
  workspaces do); they must keep the format tag and a stable UUID.
- Tests: `tests/maponly.test.ts`.
