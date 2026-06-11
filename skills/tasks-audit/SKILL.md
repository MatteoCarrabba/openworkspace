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
   - Default: all `~/Documents/*/_tasks/` (cross-project; excludes `Dormant Projects/*` and `Archives/*` by default).
   - If user passes a project name, scope to that project only.

2. **Gather data**: run `backlog cross-project --exclude-dormant --exclude-archived --include-completed --json` for the default scope, or `backlog task list --json` for a single project. Parse.

3. **Run checks**:
   - **Vague Q2**: tasks with `quadrant: Q2` whose body lacks a `## Why this matters` section, OR have no acceptance criteria, OR have neither a description nor an implementation plan. These are Covey's classic Q2 failure mode — important work that hasn't been concretely planned.
   - **Untriaged**: open tasks with no `quadrant` field. List them so the user can classify.
   - **Stale in-progress**: tasks in `In Progress` whose file `lastModified` is more than 7 days ago. The agent or human claimed them and never finished or released.
   - **In-progress without Implementation Plan**: tasks whose `status` matches `In Progress` (case-insensitive; accept both the spec vocabulary `in-progress` and the live config vocabulary `In Progress` — drift tracked in TASK-150) whose body lacks a `## Implementation Plan` section header. Mirrors the Vague-Q2 header-grep pattern. TASKS.md §7 commits to "Plan before coding"; this check enforces it. Empirically the dominant failure mode (bulk-imported in-progress tasks that never had a plan written).
   - **Broken dependencies**: tasks whose `dependencies` reference IDs that don't exist in the project.
   - **Done-without-evidence**: tasks marked `Done` but whose body has no `## Final Summary` section.
   - **Long-standing open**: open tasks whose `created_date` is more than 90 days old. Possibly should be archived or rewritten.
   - **Missing AC for in-progress**: in-progress tasks with zero acceptance criteria. Hard to know "done" without them.

4. **Reminders sweep** (additive — `_tasks/reminders/*.md` across the same scope, schema in `~/Documents/Personal OS/_wiki/REMINDERS_DESIGN.md` §3):
   - **Stuck-surfaced**: reminders with `status: surfaced` whose `fired_at` is more than 7 days ago and which have not been dismissed or promoted. The user saw it but never acted; either dismiss or promote.
   - **Pending past surface_on**: reminders with `status: pending` and `surface_on <` today. These are surfacing-misses — should have fired but no caller queried, or the surfacer skipped them. Flag so the next briefing/cross-project run picks them up.
   - **Malformed frontmatter**: reminder files missing `id`, `surface_on`, `status`, or `created_by`; or with a `surface_on` that doesn't parse as ISO date; or with a `status` value outside `{pending, surfaced, dismissed, promoted}`.
   - **Recurring without recur_until and far-future surface_on > 5y**: gentle flag — possibly an unintended recurrence.
   - Use `python3 ~/Documents/C2/.scripts/list-due-reminders.py` to enumerate; or once `backlog reminder list` ships, prefer that.

5. **Report**:
   - Group findings by check, with a count and the affected task / reminder IDs.
   - Format: terse, scannable. Don't dump full task content; the user can drill in via `backlog task view <id> --json` or by reading the reminder file directly.
   - End with a one-line summary: "X total open tasks, Y reminders, Z issues found across N categories."

## Don'ts

- **Don't auto-fix anything.** This skill is read-only. The point is to surface issues so the user decides.
- Don't recommend a fix for "untriaged" — quadrant is a judgment call only the user can make.
- Don't include archived (`completed/`) or draft tasks unless the user explicitly asks.
