---
name: using-openworkspace
description: >-
  Work correctly inside an OpenWorkspace workspace using the `projects` CLI —
  first finding and maintaining each project's information map (where its
  tasks, decisions, wiki, plans and coordination canonically live, native or
  external), then, where a primitive is homed natively, creating and triaging
  tasks (including reminders-as-tasks and recurring tasks), recording
  decisions, coordinating with other agents on the forum, navigating projects,
  and validating with doctor. Use this skill whenever you are operating in a
  directory tree that contains a `.openworkspace/` marker, a `_project/`
  directory, or a README/AGENTS.md "Where information lives" block marked
  `openworkspace:information-map`, or when the user mentions the `projects` CLI, OpenWorkspace,
  project tasks/decisions/forum, or asks you to organize work in such a
  workspace.
---

# Using OpenWorkspace

OpenWorkspace's default purpose is to make every project say **where each
kind of its information canonically lives** — its task tracker, decision log,
knowledge base, plans, coordination channel, and extras like a credentials
vault or data stores. That **information map** lives in
`_project/project.toml` under `[map]` and is rendered into a generated
"Where information lives" section of the project's `README.md` and
`AGENTS.md` — or, for a **map-only** project (every primitive external or
`none`), there is no `_project/` folder at all and that section *is* the
map (see below). OpenWorkspace also ships plain-file **native stores** for tasks,
decisions, wiki, plans and forum — one option per primitive, chosen à la
carte, never the default expectation. The CLI is `projects`. Validate
anything you're unsure about with `projects doctor`.

## First: find where things live

Before you create a task, record a decision or write a wiki page, check the
project's map — and put the information in its declared home, not wherever
is convenient:

```sh
projects map show             # each primitive's home: native, an external system, or "none"
grep -A20 "Where information lives" README.md   # the same, rendered
```

- **Native** → use the `projects` verbs below (the store is created by its
  first write; nothing is scaffolded empty).
- **External** (GitHub Issues, Teamwork, a wiki URL, a Slack channel, a repo
  path, …) → go there. The native verbs say so instead of writing here:
  reads (`task list`, `decision list`, `forum list`) print the pointer, and
  creates (`task create`, `decision new`, `forum open|post`, `plan open`)
  **exit 3** with the pointer and write nothing. Never work around exit 3
  by hand-writing a native file.
- **"none"** → the project deliberately has no such home; ask before
  inventing one.
- **Undeclared** → native writes still work (with a stderr note), but
  declare the home — or ask the user where it should be.

Keep the map current when a home changes — it is the one thing everyone
(people and agents) relies on to find information:

```sh
projects map set tasks https://github.com/acme/widget/issues --locator acme/widget
projects map set tasks --system Teamwork --url https://acme.teamwork.com/app/projects/42
projects map set decisions docs/decisions          # a path in this repo
projects map set wiki native                       # OpenWorkspace's file store
projects map set forum none                        # not used here
projects map set credentials --system 1Password --locator "vault Acme"   # any extra key
projects map unset credentials
projects map render                                # re-render the README/AGENTS sections (idempotent)
```

`map set`/`unset` re-render the sections automatically; the block between
the `openworkspace:information-map` markers is generated — edit the map, not
the block. Text around the block is never touched. A project with no `[map]`
at all is a **legacy** project: everything is treated as native, exactly as
before; `projects map adopt` (dry-run; `--apply` to execute, `--prune-empty`
to remove stores holding only the old empty skeleton) declares a map from
what is actually in use.

### Map-only projects (no `_project/` folder)

When no primitive is native, the project has **no `_project/` folder**. Its
map and identity (`uid`) live in a fenced TOML block inside the
"Where information lives" section of `README.md` (or `AGENTS.md`); the BEGIN
marker carries the `map-only` flavor. That block is the source of truth:

- Read it with `projects map show` (or just read the README). Change it with
  `projects map set|unset` — or edit the TOML and run `projects map render`.
  Keep `format` and `uid` as they are; never copy a block into another
  project (the uid is that project's identity).
- `projects init`/`new` make a map-only project unless you pass `--native`,
  `--folder` or `--no-docs`.
- Enabling a native store (`projects map set <prim> native`, or the first
  `task create`/`decision new`/`forum open` on an undeclared primitive)
  creates `_project/` with the same uid and moves the map into
  `project.toml`. Prefer declaring the real external home instead.
- `projects map adopt --map-only --apply` turns a folder project whose
  stores are retired back into map-only (it refuses, listing blockers, while
  anything but stamps and empty stores is left); `--folder --apply` is the
  reverse.
- `home list` tags these projects `map-only`; doctor checks the block.

## Rules for native records

1. **Location encodes visibility and retention for records; project lifecycle
   is metadata-primary.** Live records sit directly in their primitive's
   directory; archived records sit in its `archive/` subdir. A *project's*
   lifecycle (active/dormant/archived) lives in `_project/project.toml`; folder
   location is the reconciled Finder-readable view. Change lifecycle with
   `projects lifecycle <ref> --to dormant`; if metadata and location disagree,
   use `projects reconcile`.
2. **Frontmatter encodes workflow state.** A task's `status:`, a decision's
   `status:`, a thread's `status:` live in YAML frontmatter, edited in place.
   Never encode state by moving a record between subdirectories; never
   duplicate a fact in both places. **Preserve frontmatter keys you don't
   recognize** — unknown keys are load-bearing for someone.

## Orientation

```sh
projects home list --all      # what projects exist (live scan; --all includes shelves)
projects home scan --json     # task/planning view (+ each project's declared map); plain scan is a summary
projects show                 # which project am I in (walk-up from cwd) + its information map
projects doctor               # are this project's invariants intact (incl. the map and its rendered sections)
cat _project/README.md        # a folder project's orientation file (map-only projects: read README.md)
```

Any directory becomes a project with `projects init [<path>]` (path defaults
to the cwd, which must be inside a workspace and be neither the workspace
root nor a shelf root) — or `projects new "Name"` to create a fresh
directory. Without a native store, init makes a **map-only** project: no
`_project/`, just the map block (with the uid) in `README.md`/`AGENTS.md`.
With one (or `--folder`/`--no-docs`), init stamps only `_project/id`, the
orientation README, a `.gitignore` and `project.toml` with the `[map]`, and
renders the map into the project's `README.md`/`AGENTS.md`. Declare homes
up front with `--native tasks,wiki` (or `--native all`) and
`--home tasks=<url>` / `--home forum=none`; otherwise doctor asks for each.
**No native store is pre-created.** Never restamp by hand; never edit
`_project/id` (or a map-only block's `uid`).

A project can also live **outside** the workspace tree — typically a git repo
that is itself a project, kept under `~/Code` (out of iCloud). The workspace
lists it in `.openworkspace/config.toml` under `[projects] external_roots =
["~/Code/<repo>"]`; it then shows up in `home list`/`home scan`, the dashboard,
`skills sync` and `home doctor` like any other project (its `relPath` starts
with `..`), and `projects` commands work from inside it. Its lifecycle is
metadata-only (nothing ever moves it). Run agents' worktrees of such a repo
anywhere; worktrees are never discovered or treated as canonical.

## Tasks — including reminders and recurrence (when tasks are native)

One file per task, flat in `_project/tasks/`, named `task-<n> - <slug>.md`.
Subtasks use dotted IDs (`task-36.7`) — parentage lives in the ID alone, no
parent field, same flat directory. Keep nesting ≤3 levels; if a child doesn't
need its own status/notes, make it an Acceptance Criteria checkbox instead.

```sh
projects task create "Fix the codec" --quadrant q2
projects task create "Write fixtures" --parent 36          # mints task-36.<n>
projects task list                       # top-level, with rollups (8 subtasks: 5 done)
projects task list --subtasks --hidden   # expanded; hidden tasks tagged
projects task show 36
projects task status 36 doing
projects task note 36 "found the root cause" --as claude-a3f
projects task edit 36 quadrant q1
projects task archive 36                 # moves record + subtree to tasks/archive/
```

Statuses: `todo | doing | waiting | review | done`. **`done` requires a
non-empty `## Final Summary`** in the body (one line suffices for a judgment
call: "Decided: skip"). Closing a parent with open children refuses without
`--force`. IDs are citations — they never churn, and archived IDs are never
re-minted.

**Reminders are tasks.** There is no separate reminder primitive: a reminder
is a task with `hidden_until: <date>`. Hidden tasks stay out of default
listings until the date passes, then simply reappear — no event, no state
transition. When one reappears: act on it, re-hide it, or close it.

```sh
projects task create "Renew the certificate" --hidden-until 2099-09-01
projects task hide 41 --until 2099-10-01      # re-hide / snooze
```

**Recurring tasks are standing records — never spawned copies.** Set
`recur: weekly|monthly|yearly|every-N-days`. `projects task done` on a
recurring task completes the *occurrence*: it appends a completion line to the
`## Log` section and advances `hidden_until` to the next occurrence strictly
in the future (schedule-anchored — a long-overdue task fast-forwards, no
catch-up pile). The record stays open; `status` never becomes `done` while
`recur:` is set. To retire: `projects task recur <id> off`, then close
normally with a Final Summary.

## Decisions (when decisions are native)

One short ADR-style record per significant decision in `_project/decisions/`:
Context / Decision / Consequences, optional `Expected:` line.

```sh
projects decision new "Vendor the YAML parser" --expected "round-trips stay byte-exact"
projects decision accept 7
projects decision supersede 7 --by 9     # changing course = a NEW record
projects decision list --status accepted
```

**Immutable once accepted.** Drafts can be edited; an accepted record's only
sanctioned mutation is the supersede stamp. Record decisions *when they
happen* — `decision new` takes two minutes, and an unrecorded decision is the
primary failure mode this primitive exists to prevent. A rejection worth
recording is an accepted decision *not* to do the thing.

## Forum — coordination etiquette and the worktree rule (when the forum is native)

The forum (`_project/forum/`) is a blackboard, not a switchboard: threads are
the only message home, one immutable uniquely-named file per message, history
never edited. Presence is your `.plan` file.

Arrival protocol when starting work in a shared project:

```sh
projects forum announce --doing "refactoring the codec" --as claude-a3f
projects forum who                        # presence ⋈ open-thread recency
projects forum list                       # open threads
projects forum inbox --as claude-a3f      # unanswered questions addressed to me
```

Working the threads:

```sh
projects forum open "Codec refactor"                     # one thread per workstream
projects forum post codec-refactor "starting on the range-splice" --as claude-a3f
projects forum post codec-refactor "does EOL handling matter?" \
    --kind question --to claude-b71 --as claude-a3f
projects forum post codec-refactor "yes — CRLF fixtures exist" \
    --kind answer --re <question-message-id> --as claude-b71
projects forum show codec-refactor
projects forum resolve codec-refactor                    # when the workstream closes
projects forum depart --as claude-a3f                    # when you leave
projects forum sweep                                     # retention: drop own stale presence, propose archives
```

Etiquette: never edit or delete another participant's files; answer questions
with `--kind answer --re <id>` so inboxes clear; resolve threads you opened;
re-announce to heartbeat; identity comes from `--as`, then `OW_ACTOR`, then
`$USER` — keep one identity per session.

**The worktree rule.** Records ride the branch; coordination rides the
machine. If you work in a git worktree: task/decision/plan/wiki writes are
worktree-local (they merge with your code — that's correct). Forum and
presence verbs always resolve to the project's **canonical** checkout by UID —
the CLI does this automatically; messages are visible to every agent on the
machine instantly. Therefore: **never hand-edit `forum/` from inside a
worktree** (its copy is a stale branch snapshot the CLI doesn't even read),
and if a forum verb fails with exit code 2 (canonical resolution failure),
**stop and report it — never work around it by writing locally**; a local
fallback split-brains the forum. Running any command once from inside the
canonical workspace registers it and fixes resolution.

## What never lives in `_project/`

- **No manifests, no status dashboards, no cached aggregate state** — every
  view is computed at read time. If you feel the urge to write a "current
  status" file or an index of records, don't; run the scan instead.
- **No secrets, ever.** Secret *pointers* only (`<scheme>://<ref>`), resolved
  at run time through the workspace's resolver map. A bare secret value under
  an automation manifest's `[secrets]` block is a doctor **error**; never
  write a secret value into any file.
- **No state-named subdirectories** (`todo/`, `accepted/`, `resolved/`, …) —
  doctor flags them. The only subdirectory a primitive dir owns is `archive/`.
- **No ad-hoc directories**: helper scripts, retrospectives, app config
  (including `.obsidian/`) are ordinary project content and belong at the
  project root, outside `_project/`.
- Also: never run `git clean -fdx` in an OpenWorkspace workspace — ignored
  paths there (archives, presence, logs) are still canonical, synced data.

## Doctor habits

`projects doctor` (project) and `projects home doctor` (workspace + every
project) are cheap — run them:

- after any bulk or hand edit of records,
- before declaring a migration or multi-file change done,
- when anything looks off (missing task, odd duplicate, stale thread).

Doctor *proposes*; it never mutates. In a project with a `[map]` it also
checks that every core primitive has a declared home, that no native store
sits empty, that a primitive homed elsewhere has no records left in its
native store, that pointers look resolvable (local paths exist, URLs are
well-formed — no network calls), and that the README/AGENTS sections exist
and match the map (`projects map render` fixes those). A legacy project gets
one info-level "no information map declared" note. Exit 1 means errors (schema invariants
violated — fix before proceeding); warnings are hygiene proposals (e.g. a
recurring task lagging behind, a missing git-posture stamp). Typical findings
and the right response: duplicate IDs after a sync/merge → reconcile by hand,
keep the older citation; `done` without Final Summary → write the summary
(one line is fine); state-named subdir → move records back flat and put state
in frontmatter; `hidden_until`/`recur` malformed → fix the field to
`YYYY-MM-DD` / a valid interval.
