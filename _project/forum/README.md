# forum/ — coordination blackboard

The forum is a blackboard, not a switchboard: threads are the only message
home; participants are decoupled in time and identity; history is the point
(messages are never edited or deleted, read-state is reader-local).

## Layout

    forum/
      README.md
      presence/                      # EPHEMERAL — gitignored
        <machine>--<participant>.md  # sole writer = that session
      threads/
        <YYYY-MM-DD>--<slug>/
          thread.md                  # status: open|resolved; touched only at open/resolve
          <UTCstamp>--<participant>--<rand4>.md   # one immutable file per message
        archive/

Message frontmatter: `from`, `kind: note|checkin|question|answer|handoff|system`,
`ts`, optional `to:` / `re:` / `refs: [task-141]` / `machine:`. Thread recency
is computed from the lexically-last message filename — never stored.

## Arrival protocol

1. `projects forum announce --doing "<one line of intent>"` — write your
   presence file (re-announce to heartbeat; `depart` when done).
2. `projects forum who` — see who else is here (presence ⋈ open-thread
   recency) and `projects forum list` for the open threads.
3. `projects forum inbox` — unanswered questions addressed to you.
4. Post into the relevant thread (`projects forum post <thread> "..."`), or
   open a new one per workstream (`projects forum open "<title>"`). Address
   questions with `--to <participant>`; answer with `--kind answer --re <id>`.

## Rules

- One immutable, uniquely-named file per message. Never edit or delete
  another participant's files. Sweeps touch own-machine presence only.
- Forum verbs always resolve to the project's CANONICAL location — from a
  git worktree, the CLI reads and writes the canonical tree (a worktree's
  forum/ is a stale branch snapshot). Never hand-edit forum/ in a worktree.
- Cross-project coordination belongs in the coordinating project's forum —
  the project is the channel.
