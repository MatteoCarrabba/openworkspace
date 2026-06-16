---
name: tasks-audit
description: Sanity-check the task corpus for known failure modes - vague Q2 items missing `## Why this matters`, stale in-progress claims, broken dependency references, missing acceptance criteria for in-progress work, untriaged tasks lacking a quadrant. Reports findings without auto-fixing. Use weekly or when the user asks for a task review, "what tasks are stale", or invokes `/tasks-audit`.
---

# /tasks-audit

Walks the task corpus and reports quality issues. Read-only — does not modify tasks.

## When to use

- User asks: "audit my tasks", "what tasks are stale", "show me vague Q2 items".
- User invokes `/tasks-audit`.
- Once a week as part of weekly review (the user can invoke this manually, or schedule it).

## Protocol

1. **Determine scope**:
   - Default: all `~/Documents/*/_project/tasks/` (cross-project; excludes `Dormant Projects/*` and `Archives/*` by default).
   - If user passes a project name, scope to that project only.

2. **Gather data**: run `projects home scan` for the default cross-project scope, or `projects task list` for a single project. Parse.

3. **Run checks**:
   - **Vague Q2**: tasks with `quadrant: Q2` whose body lacks a `## Why this matters` section, OR have no acceptance criteria, OR have neither a description nor an implementation plan. These are Covey's classic Q2 failure mode — important work that hasn't been concretely planned.
   - **Untriaged**: open tasks with no `quadrant` field. List them so the user can classify.
   - **Stale in-progress**: tasks with `status: doing` whose file `lastModified` is more than 7 days ago. The agent or human claimed them and never finished or released.
   - **In-progress without Implementation Plan**: tasks with `status: doing` whose body lacks a `## Implementation Plan` section header. Mirrors the Vague-Q2 header-grep pattern. "Plan before coding" is the convention this check enforces. Empirically the dominant failure mode (bulk-imported in-progress tasks that never had a plan written).
   - **Broken dependencies**: tasks whose `dependencies` reference IDs that don't exist in the project.
   - **Done-without-evidence**: tasks with `status: done` but whose body has no `## Final Summary` section.
   - **Long-standing open**: open tasks whose `created_date` is more than 90 days old. Possibly should be archived or rewritten.
   - **Missing AC for in-progress**: in-progress tasks with zero acceptance criteria. Hard to know "done" without them.

4. **Reminders sweep** (additive — reminders are tasks with `hidden_until:` across the same scope; recurring ones also carry `recur:`):
   - **Stale-surfaced**: reminder-tasks whose `hidden_until` arrived more than 7 days ago that are still open (not `done`) and show no activity. The user saw it (or should have) but never acted; either close it or reschedule (bump `hidden_until:`).
   - **Long-overdue**: reminder-tasks with `hidden_until <` today that are still open. These should have surfaced already; flag so the next briefing / `projects home scan` picks them up.
   - **Malformed frontmatter**: reminder-tasks with a `hidden_until` that doesn't parse as an ISO date, or a `recur:` value outside the recognized set (`weekly|monthly|...`).
   - **Recurring with a far-future `hidden_until` > 5y**: gentle flag — possibly an unintended recurrence.
   - Use `projects task list` (which respects `hidden_until:`) to enumerate; reminder-tasks are surfaced when due via `projects home scan`.

5. **Report**:
   - Group findings by check, with a count and the affected task / reminder IDs.
   - Format: terse, scannable. Don't dump full task content; the user can drill in via `projects task view <id>` or by reading the task file directly.
   - End with a one-line summary: "X total open tasks, Y reminders, Z issues found across N categories."

## Don'ts

- **Don't auto-fix anything.** This skill is read-only. The point is to surface issues so the user decides.
- Don't recommend a fix for "untriaged" — quadrant is a judgment call only the user can make.
- Don't include tasks in dormant/archived projects unless the user explicitly asks (the default scope already excludes `Dormant Projects/*` and `Archives/*`).
