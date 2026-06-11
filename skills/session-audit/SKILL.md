---
name: session-audit
description: End-of-session readiness check. Verifies the work you just did would survive a fresh agent picking it up cold — completed tasks have Final Summary, in-progress tasks reflect reality, user-action blockers are tracked (not buried in prose), principles surfaced in conversation are written into durable docs, project README has a resume pointer. Reports findings with auto-fix suggestions but does not silently change state. Use at the end of any non-trivial session, before summarizing. Also use when the user asks "would a future agent be able to pick this up?", "am I leaving this in a good state?", "is the tracker up to date?", or invokes `/session-audit`.
---

# /session-audit

Pre-summary readiness check. Runs against whatever project the current working directory sits inside, or all projects touched in the session if multiple were involved.

## When to use

- **Default**: at the end of any non-trivial session, before writing the final summary to the user. Especially for sessions that involved task creation, design decisions, partial builds, or principle-setting conversations.
- User asks: "would a future agent pick this up?", "is this in a good state to come back to?", "is the tracker up to date?", "did you log everything?".
- User invokes `/session-audit`.

## When NOT to use

- Trivial sessions (one-shot questions, single edits without ongoing work).
- Inside a session where the user has signaled they're not stopping ("keep going", "next one"). Wait for a natural pause.

## Protocol

For each project touched in the session, run these checks. Report findings grouped by check; *do not auto-fix without confirming* unless the fix is obviously safe (e.g., updating a one-line README pointer).

### 1. Backlog hygiene

- **Completed work has `## Final Summary`.** For every task moved to `Done` in this session, the task file must have a populated `## Final Summary` section. Tasks marked Done without one fail the audit.
- **In-progress tasks are real.** Tasks in `In Progress` should correspond to work that's actually unfinished and intended to resume. If a task is `In Progress` but the work was abandoned or rolled into another task, mark it correctly.
- **Done means done.** Acceptance criteria checked, work is actually complete, no scope expansion that should have been a separate task. (If unsure, this overlaps with `/task-review` — call that out instead of duplicating.)
- **New tasks have correct quadrant + Why.** Q2 tasks created in this session must have `## Why this matters`. Untriaged tasks (no quadrant) are flagged.
- **Dependency IDs resolve.** Any `dependencies:` entry must point to a real task ID. (Caught in this very codebase: an ID-collision bug where a session's create+edit assumed sequential IDs but the counter had advanced.)

### 2. Decisions and principles capture

- **Decisions made in conversation are written down.** If the session involved deciding "we're using X over Y because Z," that should appear in a `decisions.md`, `decisions/<topic>.md`, or equivalent — not just in the chat log. Same for surfacing rules / thresholds the user named.
- **Principles outlive the session.** When the user's answer to a question contains a *general rule* (e.g., "default is read-only," "if it's more than 2% of net worth," "always do X first"), check that the rule is written into the project's `context.md`, convention doc, or relevant CLAUDE.md. If it isn't, that's a finding.
- **Memory updates.** If the session surfaced a *user preference* or a *correction of past behavior*, check whether memory was updated (`MEMORY.md` index + a typed memory file). Don't write memory in this skill — flag it for the agent to handle separately.

### 3. User-action blockers are tracked

- **Buried blockers.** Scan the session's outputs (decisions, summaries) for prose like "user needs to," "blocked on," "requires browser flow," "needs human approval," "to be set up by hand." Each of those should be a tracked task (with `needs-user` label or equivalent), not a paragraph in `decisions.md` or a summary message.
- **Cross-task dependencies pointing at user actions.** If a high-priority task is blocked on a user action, its `dependencies:` should include the user-action task. (Avoids "everything's queued, but nothing can start.")

### 4. Project README has resume guidance

- **`<project>/README.md` (or equivalent landing doc) has a "Resuming this work" or "How to pick this up" section.** Even one paragraph is enough: "read this file, then context.md, then run `backlog task list -m <milestone> --plain`; look for tasks labeled `needs-user`."
- **Phase pointer in `TODO.md`.** Any phase / arc / initiative that has tasks in the backlog should have a one-paragraph pointer in the project's `TODO.md`, naming the milestone, headline arc, and operational principles for the slice. Forward-looking prose, never a checkbox list (that drifts).

### 5. Cross-references and freshness

- **`last_reviewed: YYYY-MM-DD`** updated on any entity README modified in the session.
- **Stale references.** If a folder or file moved, grep for the old path in modified files and surface any leftover references.
- **CHANGELOG / decision log** ordering: newest-first if that's the project's convention.

## Output format

Group findings by check. Each finding: one line per item, `<check> — <task-id-or-file> — <issue>`. Then a short "what I'd auto-fix vs what needs your judgment" split.

End with: `Audit: {N} checks, {X} findings, {Y} auto-fixable, {Z} need your decision.`

If everything's clean, say so in one line. The audit's value is partly in passing.

## Don'ts

- **Don't auto-fix anything that requires judgment.** Adding `## Final Summary` to a task — judgment (you have to write the summary). Updating a README pointer to reflect a moved file — safe. Assigning a quadrant — judgment. Updating `last_reviewed` — safe.
- **Don't run on trivial sessions.** Audit-as-default doesn't mean audit-everything. Use judgment.
- **Don't rerun the work.** This is a check, not a redo. If the audit finds a buried blocker, *flag it as a missing task*; don't create the task silently and continue.
- **Don't overlap with `/task-review`.** That skill verifies a single task is actually done. This skill checks the *whole session's* state. If a finding is "this Done task isn't really done," recommend the user run `/task-review` on it.

## Implementation notes

- The "what was touched in this session" set is the agent's responsibility — read it from your own conversation context. There's no machine-readable session log.
- Backlog queries: `backlog task list --json --status "In Progress"`, `backlog task list --json --status "Done"`, `backlog task list -m <milestone> --plain` for milestone-scoped checks.
- For cross-project sessions: `backlog cross-project --exclude-dormant --exclude-archived --json`.
- Files to scan for principle-capture checks: `<project>/context.md`, `<project>/decisions.md`, `<project>/CLAUDE.md`, `~/Documents/CLAUDE.md`.
