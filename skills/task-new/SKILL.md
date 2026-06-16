---
name: task-new
description: Create a new task in the current project's `_project/tasks/` directory using the `projects` CLI. Prompts for the Eisenhower quadrant if not specified and enforces the Q2 quality bar (a `## Why this matters` section). Use when the user wants to capture a task, add a TODO, or create a backlog item. Examples - "create a task to refactor the parser", "add a backlog item for...", "/task-new <title>".
---

# /task-new

Creates a new task in the current project's `_project/tasks/` directory.

## When to use

- User asks to "create a task" / "add a TODO" / "capture a backlog item."
- User starts a sentence with "I need to remember to…" or "let's track…"
- User invokes `/task-new <title>`.

## Tasks vs reminders — pick the right artifact first

If the request is **time-keyed and not work-shaped** — "remind me about X in 3 weeks," "nudge me mid-trip," "check whether Plaid trial expired around June," "every December re-evaluate active project slots" — it's a **reminder**. Under OpenWorkspace v1 there is no separate reminders primitive: a reminder is just a **task with `hidden_until: <date>`** (hidden from default lists until then), plus `recur: <weekly|monthly|...>` if it repeats. Create it via the same CLI:

```bash
projects task create "<one-line title>" \
    --hidden-until YYYY-MM-DD \
    --desc "<2-5 sentence elaboration>"
# add --recur weekly|monthly|... if it should repeat
```

A reminder-shaped task can be lighter than a work-shaped one (no full ACs / Definition of Done needed); the distinction is the `hidden_until:` frontmatter, not a separate folder. Reminder-tasks surface when due via `projects home scan`.

**Heuristic:** if there's a clear "done" condition (acceptance criteria fit), it's a normal task. If it's "show me this on this date and I'll decide what to do," it's a task with `hidden_until:`. When ambiguous, ask.

## Prerequisites

- A `_project/` control plane must exist in the current working directory or an ancestor (the `_project/tasks/` directory is where the task lands). If not, scaffold the project first with the `projects` CLI (ask the user before initializing — that's a meaningful project setup choice, not a side-effect).

## Protocol

1. **Title**: from the user's input. Trim it.
2. **Quadrant**: ask the user to classify (Q1/Q2/Q3/Q4) using the Eisenhower / 7 Habits framework. Don't skip this — explicit classification is the value of the framework. If the user explicitly declines, leave the field unset.
3. **Q2 quality bar** (if quadrant is Q2): ask for a one-sentence "why this matters" — the importance argument. Insert this into the task body under a `## Why this matters` section. Vague Q2 work is a Covey failure mode; the scanner will flag tasks lacking this section.
4. **Other fields**: optionally prompt for `--priority`, `--labels`, `--ac` (acceptance criteria). Keep the prompt short — most tasks don't need all of these at creation time; they can be edited later.
5. **Create**: run the CLI:
   ```bash
   projects task create "<title>" \
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

Per the OpenWorkspace task schema (`OPENWORKSPACE_PRD.md`):
- Required: `id`, `title`, `status`, `created_date` (the CLI handles all of these).
- Optional: `quadrant`, `priority`, `assignee`, `labels`, `dependencies`, `references`, `documentation`, `parent_task_id`, `milestone`, `hidden_until`, `recur`.
- Status values: `todo`, `doing`, `waiting`, `review`, `done`. Change status with `projects task status <id> <todo|doing|waiting|review|done>`.
- Subtasks use dotted IDs (`task-36.7`); parentage is encoded in the ID alone, not in folder nesting.

## Don'ts

- Don't bulk-create tasks. One per invocation. If the user asks for multiple, confirm and create one at a time.
- Don't classify quadrant on the user's behalf without asking. The act of classification is the point.
- Don't set `assignee` to the agent (`agent:claude`) on creation — that happens at claim time, not at create time.
