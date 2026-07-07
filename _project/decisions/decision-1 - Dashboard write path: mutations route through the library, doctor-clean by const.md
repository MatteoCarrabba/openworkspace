---
id: decision-1
title: "Dashboard write path: mutations route through the library, doctor-clean by construction, localhost-gated"
status: draft
date: 2026-07-07
superseded_by: null
---

## Context

The dashboard (`src/dashboard/`) is deliberately **read-only**: the HTTP
handler rejects any non-GET/HEAD method with 405 ("dashboard v1 is read-only",
server.ts:1229), and every response is a live scan over the tree. Matteo wants
to **act on To-Dos from the dashboard** — check a task off, move it
todo→doing→waiting→review→done, drop a note — without dropping to a terminal.

Two hard constraints, from the mission and the repo's invariants:

1. **Every write routes through the `projects` CLI/library — never direct file
   writes from the server.** The library is the single writer that already
   enforces the record invariants: `setStatus`/`done` refuses to mark a task
   `done` without a non-empty `## Final Summary` (tasks.ts:671), refuses
   done-with-open-children, refuses done on a recurring task (use the recur
   path), and validates the closed status vocabulary. Bypassing it to
   `fs.writeFile` from the server would re-implement — and eventually drift
   from — those guards. **Doctor-clean by construction** means: the only writes
   the server can perform are the ones the library already permits.

2. **The read surface may be tailnet-served (bind host + allowed-hosts opt-in,
   server.ts:1-14), but writes must not inherit that reach.** A GET scan
   leaking over the tailnet is low-stakes; a mutation endpoint reachable from
   any tailnet peer is not. The DNS-rebinding Host-header defense already in
   place is necessary but not sufficient for writes.

## Decision

Add a **narrow, allowlisted mutation layer** to the dashboard server, designed
so the library remains the sole writer and the blast radius is minimal.

**Routing — library in-process, not shelling out.** The mutation handlers
`import` the same primitive functions the CLI calls (`tasks.ts`:
`setStatus`, `done`, `addNote`) and invoke them in-process against
`openWorkspace(workspaceRoot)`. This inherits every invariant check for free
(the `TaskStateError` for a missing Final Summary becomes an HTTP 422 with the
library's own message), avoids a subprocess per click, and keeps one code path
between CLI and dashboard. (Shelling to `projects` was considered and rejected:
slower, argv-escaping surface, and it would fork the error-reporting path.)

**Endpoints (POST, JSON body), each mapping 1:1 to a library verb:**
- `POST /api/task/status` `{project, task, status, force?}` → `setStatus`.
  `status: "done"` with no Final Summary returns **422** carrying the library
  message; the UI then prompts for a summary and re-submits.
- `POST /api/task/done` `{project, task, summary}` → append the summary to the
  `## Final Summary` section (creating it if absent) **then** `done`, as one
  atomic library call, so "check off" from the UI always satisfies the
  invariant rather than tripping the 422.
- `POST /api/task/note` `{project, task, text}` → `addNote`.

No create/delete/edit-body endpoints in this slice (higher blast radius, rarely
the from-the-dashboard need). Status transitions + note + done-with-summary
cover the daily loop.

**Write gating — localhost-only, independent of the read bind:**
- A mutation is served **only if the connection is loopback** (`req.socket`
  remoteAddress ∈ {127.0.0.1, ::1}) AND the Host header is a loopback host —
  regardless of `--host`/`--allow-host`. Tailnet peers get reads, never writes.
- Writes require a `content-type: application/json` body and are additionally
  guarded by a same-origin check (Origin/Sec-Fetch-Site) to blunt CSRF from a
  browser pointed at a malicious page while the dashboard is open.
- A `--read-only` flag (and config `read_only = true`) hard-disables the
  mutation layer, restoring exact v1 behavior for any deployment that wants it
  (e.g. a future hub-hosted public-ish surface).

**Post-write freshness:** a successful mutation invalidates the in-memory scan
cache so the next `/api/scan` reflects it immediately (no waiting out the TTL);
the response returns the updated single-task record so the UI can repaint the
row without a full refetch.

**Doctor posture:** because writes go through the library, the tree stays
within the invariants the library enforces at write time. The dashboard does
**not** run a full `doctor` per write (the library's per-verb guards are the
relevant subset; a full workspace doctor per click is wasteful and would couple
one task's edit to unrelated pre-existing conflict-artifact noise). "Doctor-
clean by construction" is delivered by the single-writer discipline, not by a
post-hoc scan.

## Consequences

- The dashboard becomes the daily driver for task state without weakening the
  read-only security model for the tailnet: the exact same binary serves
  reads widely and writes only to the person at the machine.
- One writer (the library) means new invariants (e.g. a future "waiting needs a
  blocker note") land in one place and both CLI and dashboard inherit them.
- The "check off" gesture is honest: you cannot complete a task from the UI
  without a Final Summary, matching the CLI and keeping doctor quiet.
- Cost: the server gains a small, well-fenced mutation surface (previously
  zero). Mitigated by loopback-only gating, same-origin check, the `--read-only`
  escape hatch, and no create/delete verbs in this slice.
- Not resolved here: multi-user/hub write auth (out of scope until the hub
  exists per decision-5 — the hub would front writes with real auth, not
  loopback); optimistic-concurrency if two writers touch one task (the library's
  atomic write + `--force` semantics are the current answer).

Expected: task state is mutable from the dashboard for the local operator, every mutation passes the same library guards as the CLI, and the tailnet read surface gains no write reach.

### Sources / pointers
- Read-only seam: `src/dashboard/server.ts:1222-1233` (host + method gate).
- Library invariants: `src/primitives/tasks.ts` (`done`/`setStatus`,
  Final-Summary guard :671, done-with-open-children, recur guard).
- Relates to Personal OS task-220 (dashboard build) and task-231 (usage
  contract — session write-through; a dashboard write path is one surface for
  the "claim/close work" contract).
