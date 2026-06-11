---
id: REMINDER-7
surface_on: 2027-05-01
surface_to: brief
status: pending
created: 2026-06-01T14:15:00-07:00
created_by: agent
created_by_detail: automations-setup-session 2026-06-01
fired_at: null
promoted_to_task: null
recur: yearly
recur_until: null
---

# Rotate the Claude Code OAuth token for the Mini automations (expires ~2027-06-01)

The headless OAuth token from `claude setup-token`, baked into the Mini's `daily-briefing-draft` / `daily-briefing-triage` / `weekly-tasks-audit` automations, was minted 2026-06-01 and is valid ~1 year. If it expires un-rotated, every claude automation fails auth ("Not logged in"). Rotate it a few weeks ahead.

## then
Rotate the Claude OAuth token: on the Mini run `claude setup-token`, update the 1Password item `op://AI Secrets/claude-code-oauth-token/password` with the new value, then re-run `automation install` for the three claude automations **from a login shell** (so `OP_SERVICE_ACCOUNT_TOKEN` is set) to re-bake the token into each plist's `EnvironmentVariables`. Verify with a `claude -p` test over SSH.
