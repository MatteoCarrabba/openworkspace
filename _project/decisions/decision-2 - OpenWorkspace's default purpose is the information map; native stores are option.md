---
id: decision-2
title: "OpenWorkspace's default purpose is the information map; native stores are optional, per primitive"
status: accepted
date: 2026-10-03
superseded_by: null
---

## Context

OpenWorkspace scaffolded every project with file-based tasks, decisions,
wiki, plans, forum and automations, and its README, PRD, skills and doctor
pushed people and agents toward those native stores. That is wrong for team
projects whose records live in team tools, and it produces orphaned,
laptop-only context. MBI decided (MBI decision-26, 2026-10-01) that tasks
live in Teamwork, the engineering backlog in GitHub Issues, and decisions
and knowledge in the MBI wiki; MBI-Docs `guide/information-architecture.md`
§7 records that "OpenWorkspace is being reframed as a data model: each
project keeps a map of where its information lives, and the native
file-based stores are optional (OpenWorkspace task-9)".

Task-9 (Matteo, 2026-10-01) is the recommendation this decision implements:
"Make the core of OpenWorkspace the **project map**: a lightweight, declared
index per project of where its wiki, forum(s), decisions, plans, tasks,
files, repos and so on live. Each entry can point at a native `_project/`
store or an external system ... Keep the native file-based stores as a
light reference implementation, but stop treating them as required or
default." Matteo, 2026-10-03: the tools "shouldn't be all or nothing: you
should be able to use the provided wiki and the provided task tracker, but
your own choice for the decision log, and it shouldn't scaffold anything
empty."

## Decision

1. **The information map is OpenWorkspace's default purpose.** Each project
   declares, in `_project/project.toml` under `[map]`, the canonical home of
   each core primitive — `tasks` (tasks & backlog), `decisions`, `wiki`
   (knowledge), `plans`, `forum` (coordination) — plus any free-form extras
   (`credentials`, `data`, …). A home is `native` (an OpenWorkspace store),
   `none` (deliberately unused), or an external pointer: `system` plus at
   least one of `url`, `locator`, `path` (and optional `note`/`label`).
   Shorthand strings (`native`, `none`, a URL, a path) are accepted.
2. **The map is rendered into the project's docs.** `projects map render`
   (and every `map set|unset`, and `init`) writes a generated,
   marker-delimited "Where information lives" block into `README.md` and
   `AGENTS.md` (overridable with `render_to`). Idempotent; text outside the
   markers is never touched.
3. **Native stores are opt-in per primitive and never scaffolded empty.**
   `projects init|new` stamps only `_project/id`, the orientation README,
   `.gitignore` and `project.toml`; `--native <prims>` / `--home key=...`
   declare homes up front. A native store is created by its first write.
4. **Commands for a primitive homed elsewhere say where it lives.** Reads
   print the pointer; record-creating verbs exit 3 with the pointer and
   write nothing. Mutating existing native records is never blocked (a
   half-migrated store stays drainable). Undeclared primitives still write
   natively with a nudge, so scripts that init and then create (pmt's
   engagement tracker) keep working. No integrations are built.
5. **Doctor enforces the map in map mode**: declared home per core primitive,
   no empty native store, no records left in a store homed elsewhere,
   pointers resolvable without network, rendered sections present and
   current. Malformed entries are errors; the rest are warnings.
6. **Backward compatibility.** A project with no `[map]` is legacy: every
   primitive is native, exactly as before, and doctor adds one info-level
   note (one aggregated line in `home doctor`) — no new errors or warnings.
   Inside a map, an undeclared primitive whose native store exists counts
   as native (inferred). `projects map adopt` declares a map from the stores
   actually in use (`--prune-empty` removes stores holding only the old
   skeleton).

## Consequences

- Amends the PRD (§4.3 skeleton, Appendix A stamped README; new §15) and
  supersedes the "pre-create every primitive" rule. The stamped
  `_project/README.md` now opens with the map.
- Existing workspaces are unaffected until a project declares a map. New
  projects ask for homes (doctor warns per undeclared primitive) — that is
  the intended urge.
- Visible behavior changes: `projects init|new` no longer creates
  `tasks/ wiki/ decisions/ automations/ forum/ plans/`; it writes
  `project.toml` and renders the map into the project's README.md and
  AGENTS.md (creating them if absent; `--no-docs` skips). Exit code 3 is new.
- The dashboard shows a declared map on each project card (links for URL
  homes) and "Tasks live in …" where tasks are external.
- MBI is the first adopter; its per-project migration plan is in
  `_project/wiki/mbi-information-map-migration.md` (not yet applied).
