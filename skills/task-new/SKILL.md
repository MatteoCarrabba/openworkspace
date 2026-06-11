---
name: task-new
description: Create a new task in the current project's `_tasks/` directory using the simplified Backlog.md CLI. Prompts for the Eisenhower quadrant if not specified and enforces the Q2 quality bar (a `## Why this matters` section). Use when the user wants to capture a task, add a TODO, or create a backlog item. Examples - "create a task to refactor the parser", "add a backlog item for...", "/task-new <title>".
---

# /task-new

Creates a new task in the current project's `_tasks/` directory.

## When to use

- User asks to "create a task" / "add a TODO" / "capture a backlog item."
- User starts a sentence with "I need to remember to…" or "let's track…"
- User invokes `/task-new <title>`.

## Tasks vs reminders — pick the right artifact first

If the request is **time-keyed and not work-shaped** — "remind me about X in 3 weeks," "nudge me mid-trip," "check whether Plaid trial expired around June," "every December re-evaluate active project slots" — it's a **reminder**, not a task. Reminders live in `<scope>/_tasks/reminders/` per `~/Documents/Personal OS/_wiki/REMINDERS_DESIGN.md` §3. Schema:

```yaml
---
id: REMINDER-N            # next id under the scope
surface_on: 2026-06-05    # required, ISO date
surface_to: brief         # brief | inbox-outbox (default brief)
status: pending           # pending | surfaced | dismissed | promoted
created: <ISO timestamp>
created_by: user          # user | agent
recur: null               # null | yearly | monthly | weekly | every-N-days
---

# <one-line title>
<2-5 sentence elaboration>

## then (optional — pre-fills task body if user promotes)
<suggested follow-on>
```

The CLI subcommand `backlog reminder create` is being implemented (Personal OS TASK-121). Until it ships, write the reminder file directly in the right `_tasks/reminders/` folder using the next `REMINDER-N` id, and the bootstrap surfacer (`python3 ~/Documents/C2/.scripts/list-due-reminders.py`) will pick it up. A future `reminder-new` companion skill will wrap this; for now, applying the schema directly is fine.

**Heuristic:** if there's a clear "done" condition (acceptance criteria fit), it's a task. If it's "show me this string on this date and I'll decide what to do," it's a reminder. When ambiguous, ask.

## Prerequisites

- A `_tasks/` directory must exist in the current working directory or an ancestor. If not, run `backlog init <project-name> --no-git --defaults` first (ask the user before initializing — that's a meaningful project setup choice, not a side-effect).

## Protocol

1. **Title**: from the user's input. Trim it.
2. **Quadrant**: ask the user to classify (Q1/Q2/Q3/Q4) using the Eisenhower / 7 Habits framework documented in `~/Documents/Personal OS/_wiki/TASKS.md` §4. Don't skip this — explicit classification is the value of the framework. If the user explicitly declines, leave the field unset.
3. **Q2 quality bar** (if quadrant is Q2): ask for a one-sentence "why this matters" — the importance argument. Insert this into the task body under a `## Why this matters` section. Vague Q2 work is a Covey failure mode; the scanner will flag tasks lacking this section.
4. **Other fields**: optionally prompt for `--priority`, `--labels`, `--ac` (acceptance criteria). Keep the prompt short — most tasks don't need all of these at creation time; they can be edited later.
5. **Create**: run the CLI:
   ```bash
   backlog task create "<title>" --plain \
     [--quadrant Q2] \
     [--priority high|medium|low] \
     [--labels foo,bar] \
     [--ac "criterion 1" --ac "criterion 2"] \
     [--desc "description"] \
     [--why "one-sentence importance argument"]
   ```
   When the quadrant is Q2, pass the importance argument via `--why <text>` — that writes the `## Why this matters` section directly. Do not route it through `--notes` (which writes `## Implementation Notes`, a different section).
6. **Confirm**: print the created task's ID and file path.

## Schema reference

Per `~/Documents/Personal OS/_wiki/TASKS.md`:
- Required: `id`, `title`, `status`, `created_date` (the CLI handles all of these).
- Optional: `quadrant`, `priority`, `assignee`, `labels`, `dependencies`, `references`, `documentation`, `parent_task_id`, `milestone`.
- Status values: `open`, `in-progress`, `blocked`, `review`, `done` (CLI uses `To Do`, `In Progress`, `Done` etc. depending on the project's configured statuses; verify with `backlog config get statuses`).

## Don'ts

- Don't bulk-create tasks. One per invocation. If the user asks for multiple, confirm and create one at a time.
- Don't classify quadrant on the user's behalf without asking. The act of classification is the point.
- Don't set `assignee` to the agent (`agent:claude`) on creation — that happens at claim time, not at create time.
