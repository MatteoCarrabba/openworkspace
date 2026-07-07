---
name: using-openworkspace
description: >-
  Work correctly inside an OpenWorkspace workspace using the `projects` CLI —
  creating and triaging tasks (including reminders-as-tasks and recurring
  tasks), recording decisions, coordinating with other agents on the forum,
  navigating projects, and validating with doctor. Use this skill whenever you
  are operating in a directory tree that contains a `.openworkspace/` marker or
  a `_project/` directory, or when the user mentions the `projects` CLI,
  OpenWorkspace, project tasks/decisions/forum, or asks you to organize work in
  such a workspace.
---

# Using OpenWorkspace

OpenWorkspace manages a personal workspace as plain files: **projects are
directories** (marked by `_project/id`), primitives are Markdown + YAML
frontmatter (TOML for config), and every view is computed from the live tree.
The CLI is `projects`. Validate anything you're unsure about with
`projects doctor`.

## The two rules that explain everything

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
projects home scan --json     # task/planning view; plain scan is only a summary
projects show                 # which project am I in (walk-up from cwd)
projects doctor               # are this project's invariants intact
cat _project/README.md        # every project carries its own orientation file
```

Any directory becomes a project with `projects init [<path>]` (path defaults
to the cwd, which must be inside a workspace and be neither the workspace
root nor a shelf root) — or `projects new "Name"` to create a fresh
directory. Init pre-creates every primitive: `tasks/`, `wiki/`,
`decisions/`, `automations/`, `forum/`, `plans/current.md`, plus the README
and a stamped `.gitignore`. Never restamp by hand; never edit `_project/id`.

## Tasks — including reminders and recurrence

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

## Decisions

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

## Forum — coordination etiquette and the worktree rule

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

Doctor *proposes*; it never mutates. Exit 1 means errors (schema invariants
violated — fix before proceeding); warnings are hygiene proposals (e.g. a
recurring task lagging behind, a missing git-posture stamp). Typical findings
and the right response: duplicate IDs after a sync/merge → reconcile by hand,
keep the older citation; `done` without Final Summary → write the summary
(one line is fine); state-named subdir → move records back flat and put state
in frontmatter; `hidden_until`/`recur` malformed → fix the field to
`YYYY-MM-DD` / a valid interval.
