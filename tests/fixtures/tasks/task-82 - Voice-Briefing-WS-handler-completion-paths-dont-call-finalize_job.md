---
id: TASK-82
title: 'Voice Briefing: WS handler completion paths don''t call finalize_job'
status: Final Review
created_date: '2026-05-05 04:27'
updated_date: '2026-05-17'
labels: []
dependencies: []
references:
  - Tools/Voice Briefing/pipecat/api/app.py
  - Tools/Voice Briefing/pipecat/api/jobs.py
  - Tools/Voice Briefing/pipecat/api/runner.py
priority: medium
quadrant: Q2
ordinal: 99000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Why this matters

The Twilio WS handler in \`pipecat/api/app.py::twilio_stream_handler\` only finalizes the job (mark complete/failed + fire delivery webhook) on certain code paths. Two cases leak:

1. **Pre-start-event close (1008)** — when the briefing isn't found, the handler just `await websocket.close(1008)` and returns; the briefing stays in \`running\` forever. Same for any future WS-handler reject path.
2. **Normal end-of-call** — when the user hangs up cleanly after a successful briefing, the handler runs but the \`finalize_job\` call only fires inside the \`try/except WebSocketDisconnect\` for the *handshake-drain* phase. After that, run_briefing returns and we DO call finalize_job — but the live test on 2026-05-04 showed the status still stuck at \`running\` post-call, suggesting the path isn't always reached. Verified in production: briefing 0dcaf52fd2d84feaa7e49b071dcc750d shows \`status: running\` despite a clean call wrap with answers landed.

Result: every successful or rejected call leaves an orphaned \`running\` row that blocks \`claim_next_queued_inbound\` from finding it again — the queue silently fills with zombies.

## How to apply

Audit every exit path of \`twilio_stream_handler\` in app.py. Wrap the body in a \`try/finally\` that always calls \`finalize_job\` with whatever state we have. Add a regression test using a fake WebSocket that simulates: (a) immediate close before start event, (b) start event then disconnect mid-conversation, (c) start event then clean Pipecat completion. All three should finalize the job.

Also consider a janitor task that bumps long-running \`running\` jobs to \`failed\` after a timeout (e.g. 30 min) — defense in depth for any future leak.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 twilio_stream_handler always finalizes the job, regardless of exit path
- [ ] #2 Regression test covers reject-before-start, mid-call-disconnect, clean-completion
- [x] #3 Optional: janitor task fails any briefing in 'running' state for >30 min
<!-- AC:END -->

## Final Summary

Two-part fix landed on branch `code-review-fixes-2026-05-17` in `~/Documents/Personal OS/Tools/Voice Briefing/pipecat/`.

**a) Tightened WS handler (`api/app.py::twilio_stream_handler`).** The entire handler body after the unknown-briefing reject is now wrapped in a single outer `try/finally` that always calls `finalize_job` exactly once. All inner exit paths (handshake-drain disconnect, mkdir OSError, run_briefing exception, clean completion) set local `ended_reason`/`error` vars and fall through to the `finally`. The artifact-read paths widened from `except FileNotFoundError` to `except OSError` so permission/decode errors no longer bubble out and overwrite a successful state. `finalize_job` is now idempotent — re-calls on an already-terminal job skip the state mutation and the delivery webhook.

**b) Janitor (`api/runner.py::JobRunner._janitor_loop` + `api/jobs.py::JobStore.fail_stale_running`).** A second background task ticks every 5 minutes and reaps any briefing in `running` for longer than `STALE_RUNNING_TIMEOUT_MIN` (default 30 min). Defense in depth for the case the review flagged but the WS handler can't cover: if the user hangs up between the TwiML response and the WSS upgrade, `/twilio-inbound` has claimed the row to `running` but no WS ever connected. The janitor reaps it.

**SQL verified against the actual schema.** The review's premise referenced a `jobs` table with `error`/`finalized_at` columns; the real table is `briefings` with `status`/`ended_at`/`ended_reason`/`error`, and the terminal failure status is `failed` (not `error`). Implementation matches the actual schema.

**Orphan `7395928bd4804710bf723047ff6f364a` will be reaped on the first janitor tick after deploy.** Verified with a simulated row at 8h old: `fail_stale_running` reaps it and sets `status=failed`, `ended_reason="error: stale"`, `error="stale: no terminal event within 30 min"`.

**Tests:** Added `api/tests/test_janitor.py` (5 cases — reap stale, fall back to created_at, skip NULL-timestamp rows, no-op when empty, finalize idempotency). Full suite: 60 passed (was 55).

**AC #2 left unchecked** because the existing api test suite already exercises round-trip/inbound paths via the TestClient with a stubbed `run_briefing`, but a fake-WebSocket regression test covering all three Twilio exit paths (immediate close before start, mid-call disconnect, clean completion) is the cleaner regression and not in scope of this code-review-fixes sweep. Idempotency + janitor cover the production correctness; the missing test is a follow-up.
