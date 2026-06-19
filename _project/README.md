# _project/ — OpenWorkspace control plane

This directory holds this project's work-organization records, owned by
OpenWorkspace (`projects` CLI). The project's actual content lives at the
project root; agent configuration (CLAUDE.md, .claude/) also stays at the
root, outside this directory.

## The two rules that explain everything here

1. **Location encodes visibility and retention.** Live records sit directly
   in their primitive's directory; archived records sit in its `archive/`
   subdirectory; a project's lifecycle (active/dormant/archived) is encoded
   by where the *project folder* sits in the workspace — never by a field.
2. **Frontmatter encodes workflow state.** A task's `status:` (and a
   decision's, a thread's) lives in YAML frontmatter, edited in place.
   Never encode state by moving a record between subdirectories; never
   duplicate a fact in both places.

Everything is plain Markdown + YAML frontmatter (TOML for config). Edit
records with the CLI when one exists, or directly in a text editor —
`projects doctor` checks the invariants either way. **Preserve frontmatter
keys you don't recognize.**

## What lives here

- `id` — stable project UUID. Never edit; survives renames and moves.
- `.gitignore` — this project's git posture (stamped at init; doctor checks
  it). Ignored material here may still be canonical (synced, backed up) —
  **never run `git clean -fdx` in this workspace.**
- `project.toml` — optional; declared facts (e.g. `lifecycle = "dormant"`) only.
- `plans/current.md` — the forward-looking plan, in prose. Complements
  tasks; never a duplicate checkbox list of them.
- `tasks/` — one file per task: `task-<n> - <slug>.md`.
  - **Status** lives in frontmatter: `todo | doing | waiting | review |
    done`. `done` requires a `## Final Summary` (one line suffices for a
    judgment call: "Decided: skip").
  - **Subtasks** use dotted IDs (`task-36.7`; parentage lives in the ID
    alone), flat in the same directory. Keep nesting ≤3 levels — if a
    child doesn't need its own status/notes, make it an Acceptance
    Criteria checkbox instead.
  - **Reminders are tasks.** Set `hidden_until: <date>` and the task stays
    out of default listings until then, then reappears for you to act on,
    re-hide (`projects task hide <id> --until <date>`), or close.
  - **Recurring tasks** set `recur: <weekly|monthly|yearly|every-N-days>`.
    `projects task done` on one completes the *occurrence*: it appends a
    completion line to `## Log` and advances `hidden_until` to the next
    occurrence — the record stays open. A recurring task is never
    `status: done`; to retire it, `projects task recur <id> off`, then
    close it normally.
- `wiki/` — the project's repository of substantive accumulated knowledge:
  research notes, reference pages, distilled findings, design docs. If the
  project learned something worth keeping, it goes here.
- `decisions/` — one short record per significant decision:
  `decision-<n> - <slug>.md`, Context / Decision / Consequences. Immutable
  once accepted; changing course means a new record plus `superseded_by:`
  on the old one. **Record decisions when they happen** —
  `projects decision new "<title>"` takes two minutes.
- `automations/` — scheduled-job definitions: a TOML manifest (cadence,
  declared target machines, secret *pointers* — never secret values),
  README, and program. Definitions are intent; nothing runs until
  `projects automation apply` is executed on a declared machine.
- `forum/` — coordination: announce presence (`projects forum announce
  --doing "..."`), check in on workstream threads, ask addressed questions
  (`--to <participant>`). One immutable file per message; never edit or
  delete another participant's files. Forum verbs always read and write
  the project's CANONICAL location (so agents in different git worktrees
  see each other) — never hand-edit `forum/` from inside a worktree.

Tool-created when needed: `archive/` (bulk preserved material, e.g.
migration imports; not tracked in git — durability rides the backup tier)
and `dashboard/` (dashboard config). There are deliberately no other
directories here; anything else (helper scripts, retrospectives, …) is
ordinary project content and belongs at the project root.

## Quick reference

    projects task create "title" [--parent 36] [--quadrant q2]
                                 [--hidden-until 2026-09-01] [--recur weekly]
    projects task list [--subtasks] [--hidden] [--all]
    projects task status <id> <todo|doing|waiting|review|done>
    projects decision new "title"
    projects forum announce --doing "..." · who · post <thread> "..." · inbox
    projects automation apply [--all] · status
    projects doctor

## What never lives here

No manifests, no status dashboards, no cached aggregate state: every view
is computed from these files at read time. No secrets — use secret
pointers (`<scheme>://…`) resolved at run time. No state-named
subdirectories (`todo/`, `accepted/`, …).

Validate with `projects doctor`.
