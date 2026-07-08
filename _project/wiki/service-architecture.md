# Service Architecture (summary)

status: summary-of-accepted-decision
created: 2026-07-08
canonical: `Personal OS/_project/decisions/decision-7 - OpenWorkspace as a service...md`

This is a short pointer/summary for readers of this repo. **Decision-7 in
Personal OS is the source of truth** for rationale, the non-negotiable
constraints, and the open question below — read it before changing anything
described here. Do not fork this summary into a second design doc; extend
decision-7 instead.

## The model in one paragraph

OW was radically stateless: "the tree is everything," every query
re-derives from files, no aggregate state files, lifecycle signalled by
folder location. That bought no-lock-in but paid for it twice — full-tree
scans don't scale, and a large apparatus of peer-coordination machinery
(machine registries, heartbeats, `reconcile`, staleness warnings,
`mint-suffix`) exists only to simulate having a center. Decision-7 reframes
the tenet: **"no lock-in" means "you can walk away," not "the tool holds
nothing."** Files stay authoritative for content; a service is allowed to
hold derived, reconstructable state (an index/read-model) plus ephemeral
operational state, as a warm-but-disposable cache and write-through
convenience layer — never a write-authority. Tar the tree, point a fresh
service at it, and it reconstructs everything the service knows.

## Four planes

1. **Storage** — where bytes live, pluggable via drivers (localfs today;
   ssh/hub, s3, git later).
2. **Compute** — executors (macbook, always-on-vm, mini, ephemeral-pool)
   selected per-automation via a `runs_on` / machine-affinity field.
3. **Control** — the service itself: index/read-model, desired-state
   (placement), a run ledger, dispatch.
4. **Interface** — thin clients (dashboard, CLI, agents) over an HTTP+SSE
   API.

Storage ⊥ compute ⊥ ownership: where a project's bytes live, where its
automations run, and which project owns an automation are three independent
facts.

## Non-negotiables (from adversarial review)

1. The index is reconciled by content hash, never mtime, and lives *outside*
   the synced/portable tree. Drop-index → reindex must be a CI-verified
   no-op.
2. The write path closes the data-loss race: atomic writes, self-echo
   suppression, and an optimistic-concurrency hash-check that refuses to
   overwrite a file changed underneath it.
3. Earn the heavy parts — keep the OS scheduler for static jobs; defer a
   persistent in-daemon scheduler/leases/presence until the hub exists and a
   real second concurrent writer does too.

## What this repo has actually built so far (see README "Status")

This worktree/branch carries **Phase 2** of decision-7: `locations.toml`
externalizes the storage plane's root away from cwd-walk-up — a `[[stores]]`
array naming `localfs` stores, `openWorkspace()` preferring a configured
store's path over walk-up, and the read-only `projects locations list`
verb plus a documented-no-op `projects reindex` hook for a persistent index
that does not exist yet. This is a **storage-plane / location** change only;
it does not touch identity or discovery, and does not itself build the
index/read-model described in non-negotiable #1 above.

**Phase 1 (the warm read-model + write-race guard, plus decision-8's React
client) and Phase 3 (compute-plane cleanup — `runs_on`, dropping the
peer-coordination machinery) were built in sibling worktrees/branches this
same session and are not present on this branch.** Do not assume the
dashboard's warm model, `touchAndWrite` optimistic concurrency, or `runs_on`
exist here until those branches land. Phase 4 (the hub) is explicitly
deferred, gated on token rotation (Personal OS task-201/203).

## Open question (deferred, not resolved by any phase so far)

Once a hub holds the authoritative files, `fs.watch` is local-only and does
not work over SSH — so where does Obsidian edit? A synced Mac replica
reintroduces cross-machine two-writer risk; a network mount leaves the
watcher blind on that side; out-of-band edits on a remote store would only
be caught by periodic reconcile, not by watch. This is a hub-phase design
problem, not something Phase 1/2/3 attempts to answer.
