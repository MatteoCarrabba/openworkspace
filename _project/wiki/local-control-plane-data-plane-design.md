# Local Control Plane / Document Data Plane Design

status: draft-for-review
created: 2026-06-28

## Goal

OpenWorkspace automations should keep running, reporting, and recovering even
when the user's document corpus is slow, offline, or backed by a flaky provider
such as iCloud FileProvider.

The Mini incident showed the failure mode clearly: the automation machinery was
too dependent on `~/Documents` being a healthy POSIX filesystem. If iCloud blocks
or returns `EINTR`, OW should be able to say "the iCloud dependency is down" and
keep its own control plane healthy.

## Design Summary

Separate the system into two planes:

1. **Local control plane**: the machinery that schedules, starts, supervises,
   logs, and reports automation runs. This lives on local APFS, outside iCloud.
2. **Document data plane**: the files an automation may read or write, including
   iCloud-backed `~/Documents` paths. These are declared dependencies of the
   payload, not the substrate of the automation runtime.

This is not a full mirror of `~/Documents`. The local APFS side contains only
runtime facts, activation snapshots, logs, scratch space, staged outputs, and
small derived indexes where needed for dashboard/read-only views.

## Core Rule

An automation run must be observable before it touches the document data plane.

The runner records the attempt in local APFS first. Only then may it try to read
`~/Documents`, call an agent, or materialize input files. If the document read
hangs or fails, the attempt ends as a visible dependency failure instead of
wedging the scheduler/dashboard.

## Local Control Plane

The local machine store remains the source of runtime truth:

```text
~/Library/Application Support/OpenWorkspace/
  activations/
    <project_uid>--<name>.toml
  activation-bundles/
    <project_uid>--<name>/
      manifest.toml
      source.toml
      command.toml
      inputs.toml
      outputs.toml
  automation-runs/
    <project_uid>--<name>/
      state.toml
      lease.toml
      attempts/<run_id>.toml
      logs/<run_id>.log
      scratch/<run_id>/
      staged/<run_id>/
```

The existing run ledger and supervisor design stays intact. The new piece is
the **activation bundle**.

### Activation Bundle

`projects automation apply` reads the canonical automation definition once and
writes a local activation bundle. The bundle is a snapshot of the runnable
definition:

- project UID and automation name;
- source path and source content hash;
- schedule and host placement;
- command/provider-neutral run configuration;
- timeout/overlap/miss policy;
- declared document inputs and output policy;
- secret pointer names, never resolved secret values.

Launchd and the runner should be able to start from the activation bundle
without reading `~/Documents/_project/automations/...` at fire time.

If the canonical manifest later becomes unreadable, already-applied automations
can still report their installed definition and either continue using the last
bundle or refuse to run based on policy. The important point is that OW can
explain the state locally.

## Document Data Plane

Automations declare the external document paths they need. A simple manifest
shape could be:

```toml
[[inputs]]
id = "this_week"
path = "~/Documents/C3/This Week.md"
kind = "file"              # file | directory | glob
required = true
materialize = "copy"       # none | copy | snapshot
timeout_seconds = 5
on_unavailable = "skip"    # skip | fail

[[inputs]]
id = "inbox"
path = "~/Documents/Inbox:Outbox"
kind = "directory"
required = false
materialize = "snapshot"
timeout_seconds = 10
on_unavailable = "continue"

[[outputs]]
id = "brief_proposal"
mode = "proposal"          # none | proposal | patch | direct
path = "~/Documents/C3/Briefs/_proposals"
```

The exact TOML names can change during implementation. The semantics should not:

- every document dependency is explicit;
- every dependency has a bounded access timeout;
- unavailable dependencies produce a structured run outcome;
- payloads receive local scratch paths when inputs are materialized;
- direct writes are opt-in and rare.

### Bounded I/O

The runner must not perform unbounded synchronous reads against iCloud-backed
paths. Document access should happen through a child helper process:

```text
runner
  -> records attempt locally
  -> starts dependency helper with timeout
  -> helper stat/read/copies declared inputs
  -> runner kills helper on timeout
  -> runner records dependency_unavailable if needed
```

This protects the runner and supervisor even if the kernel/FileProvider path
blocks in a way ordinary JavaScript `fs` calls cannot interrupt safely.

### Materialization

For agent payloads, prefer materialized local inputs:

```text
scratch/<run_id>/inputs/this_week/This Week.md
scratch/<run_id>/inputs/inbox/...
```

The payload also receives metadata:

```text
OW_INPUT_THIS_WEEK=/.../scratch/<run_id>/inputs/this_week/This Week.md
OW_INPUT_THIS_WEEK_SOURCE=~/Documents/C3/This Week.md
OW_INPUT_THIS_WEEK_HASH=sha256:...
```

This lets an agent reason over the requested files without keeping the iCloud
path open during the entire run.

## Write Policy

Default: background automations do not directly mutate iCloud-backed documents.

Supported output modes:

- `none`: no document writes expected.
- `proposal`: write a proposed note, patch, Markdown draft, or JSON summary into
  local staged output; optionally publish to a human-review folder when the
  document path is healthy.
- `patch`: produce a patch against a known input hash; a later apply step checks
  the source hash before mutating the document.
- `direct`: write to the source path during the run. This is allowed only for
  explicitly approved automations with narrow path allowlists, bounded writes,
  and backup-before-write behavior.

The first useful Mini loop should use `none` or `proposal`. Direct iCloud writes
should wait until the dependency checker, staging, and rollback path are tested.

## Dashboard And Indexing

Dashboard visibility should not require a full `~/Documents` mirror.

Use a small local index instead:

```text
~/Library/Application Support/OpenWorkspace/indexes/
  workspace-summary.json
  projects.json
  tasks.json
  automations.json
  last-refresh.toml
```

The index can be refreshed by one of two modes:

1. **Pull mode**: the Mini tries to scan `~/Documents` through the bounded
   helper. If iCloud is unavailable, it keeps serving the last good index and
   marks it stale.
2. **Push mode**: a healthy machine, usually Matteo's laptop, pushes a generated
   index to the Mini. This is safer while the Mini's FileProvider state is bad.

The index is a derived view for read-only dashboard use. It is not the source of
truth for project records.

## Status Model

Runtime health and data-plane health must be separate.

Example automation states:

- `idle`: installed and due logic healthy.
- `running`: payload currently executing.
- `succeeded`: last attempt succeeded.
- `failed`: payload failed after dependencies were available.
- `skipped_dependency_unavailable`: a required input was unavailable.
- `stale_definition`: local bundle exists, but canonical manifest could not be
  checked recently.
- `index_stale`: dashboard index is older than the target freshness window.
- `host_unhealthy`: supervisor/heartbeat is stale.

This keeps the dashboard from reporting false green while also avoiding the
current false red where an iCloud stall makes OW itself look broken.

## Closed-Loop MVP

Implement the smallest loop that proves the shape:

1. Add activation bundles under the local machine store.
2. Make the runner start from the activation bundle.
3. Add bounded dependency checks for declared input paths.
4. Add a `runtime-healthcheck` automation that touches no iCloud path and proves
   scheduler -> runner -> ledger -> dashboard -> supervisor.
5. Add an `icloud-read-probe` dependency check that tries to read
   `~/Documents/C3/_project/id` within a short timeout and reports
   `dependency_unavailable` when it fails.
6. Replace the ad-hoc Mini dashboard mirror with a small generated index.
7. Re-enable one read-only/proposal-only C3 automation.

At that point OW is valuable even if iCloud is still broken: it can show the
open task view, run local health checks, and tell Matteo exactly when document
dependencies are unavailable.

## Migration From Current Mini State

Current state:

- v2 runner/supervisor code is deployed on the Mini.
- old C3 automations are disabled.
- dashboard is pointed at a temporary local workspace mirror.
- live Mini `~/Documents` has FileProvider/FPFS read failures.

Recommended migration:

1. Leave old C3 automations disabled.
2. Keep the dashboard workaround until the small-index path exists.
3. Implement activation bundles and bounded dependency checks in OW.
4. Create and apply a local-only `runtime-healthcheck` automation.
5. Add the iCloud read probe as a monitored dependency, not a prerequisite for
   OW runtime health.
6. Switch dashboard from the temporary mirror to the generated index.
7. Re-enable C3 automations one by one in read-only/proposal mode.
8. Only after iCloud is healthy and direct-write safeguards exist, consider
   automations that mutate `~/Documents` directly.

## Open Questions

1. Should canonical automation manifests remain in the project tree, with local
   activation bundles as runtime snapshots? Recommendation: yes.
2. Should the laptop push dashboard indexes to the Mini initially?
   Recommendation: yes, while Mini FileProvider is unreliable.
3. Which C3 automations need direct writes versus proposal outputs?
   Recommendation: none direct at first.
4. What freshness target does Matteo want for dashboard task visibility?
   Recommendation: 5-15 minutes is enough for the Mini dashboard; manual refresh
   can request a new index.
5. Should phone quick capture write directly into OW records?
   Recommendation: no; append to an inbox queue first, then let a controlled
   apply step convert captures into tasks/notes.

## Non-Goals

- Do not make a full local mirror of `~/Documents` the architecture.
- Do not use bidirectional live sync as the primary write substrate.
- Do not hide iCloud failures behind stale green dashboard status.
- Do not let FileProvider determine whether OW can record, supervise, or report
  automation runtime state.
