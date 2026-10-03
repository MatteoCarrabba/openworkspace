# MBI projects: information-map migration plan

Status: **plan only — not applied** (2026-10-03). Matteo asked for no MBI
project to be migrated yet. This plan applies OpenWorkspace decision-2 (the
information map) to every MBI project that uses OpenWorkspace, using the
homes set by MBI decision-26:

- **Engineering backlog:** GitHub Issues on each repo
  (`github.com/ModernBusinessIntelligence/<repo>/issues`).
- **People's tasks:** Teamwork, `https://sunsteadgroup.teamwork.com`
  (MBI-Docs `resources/teamwork-projects`).
- **Company decisions and knowledge:** the MBI wiki,
  `https://docs.modernbusinessintelligence.co`. Its repo is
  `ModernBusinessIntelligence/MBI-Docs` and is about to be renamed
  `mbi-wiki-mbi`. Pointers use the site URL, so the rename doesn't break
  them.
- **Repo engineering decisions:** stay in each repo for now. Matteo hasn't
  settled this, so the maps below keep them native, or at their current
  in-repo path.

State of the stores was surveyed on 2026-10-03 with
`projects map show --project <path>`.

## How to apply (per project, when Matteo says go)

1. Move the content listed under "Move first" and check it landed.
2. Write the `[map]` block below into `_project/project.toml`. You can also
   build it with `projects map set` calls; `map set` keeps `lifecycle` and
   `[[owns]]`.
3. Retire stores. A retired store is either removed with `git rm` (the git
   history keeps it) or moved to `_project/archive/` (git-ignored; local and
   backed up only). Then run `projects map adopt --prune-empty --apply` to
   remove the empty skeleton directories.
4. Run `projects map render`, then `projects doctor`. Doctor should report no
   map findings.
5. Commit the repo (project.toml, README.md, AGENTS.md and the store
   removals) on a branch, and open a PR.

Doctor warns while a store homed elsewhere still holds records ("migrate
them, then remove the store"). That warning is the migration checklist.

---

## 1. MBI umbrella — `~/Documents/MBI/_project`

**Today:** 28 tasks, all `done`. They were filed in Teamwork on 2026-10-01.
21 decisions (19 accepted, 2 superseded), all copied to MBI-Docs
`governance/decisions/` (PR #10). 11 wiki items. The plan was copied to
`about/current-plan`. The forum is empty. `MIGRATION.md` and
`teamwork-import.csv` are also here. MBI-Docs `resources/mbi-openworkspace`
already says this folder "is no longer canonical for anything".

```toml
[map]
render_to = ["README.md"]          # ~/Documents/MBI has a README.md and no AGENTS.md

[map.tasks]
system = "Teamwork"
url = "https://sunsteadgroup.teamwork.com"
note = "MBI's shared tracker (decision-26); engineering backlog is GitHub Issues per repo"

[map.decisions]
system = "MBI wiki"
url = "https://docs.modernbusinessintelligence.co/governance/decisions"

[map.wiki]
system = "MBI wiki"
url = "https://docs.modernbusinessintelligence.co"
locator = "repo ModernBusinessIntelligence/MBI-Docs (renaming to mbi-wiki-mbi)"

[map.plans]
system = "MBI wiki"
url = "https://docs.modernbusinessintelligence.co/about/current-plan"

[map.forum]
system = "Slack"
locator = "MBI workspace (team T0C3CT2TQA2)"
note = "MBI-Docs resources/slack-mbi-workspace"

[map.documents]
system = "Google Drive"
locator = "MBI shared drive (MBI-Docs resources/drive-mbi-shared)"

[map.credentials]
system = "1Password"
url = "https://modernbusinessintelligence.1password.com"
```

**Keep:** nothing native. Keep `MIGRATION.md` at the project root as the
record of where everything went.

**Retire:** all five stores: `tasks/`, `decisions/`, `wiki/`, `plans/` and
the empty `forum/`, plus the empty `automations/`. This folder is in iCloud,
not git, so move the retired stores to `_project/archive/2026-10-retired/`;
don't delete them. MIGRATION.md says the local copies stay as Matteo's
personal record.

**Move first:**
- Merge MBI-Docs PR #14 (`parties/smb-law-group`,
  `parties/studio-office-solutions`) and PR #15 (decisions 21–23 and the
  code-signing runbook).
- Move the Drive items in MIGRATION.md §4 (the two Salamander proposal PDFs
  and `tariff-shipping-derivation-2026-09-13/`) into the shared drive's
  Salamander engagement folder.
- Check that every row in MIGRATION.md §1–§3 and §5 says done or resolved.
- Update MBI-Docs `resources/mbi-openworkspace` so it describes the map and
  stops calling `_project/` stores canonical. That is a wiki PR, made after
  the repo rename.

---

## 2. ledger — `~/MBI/Code/ledger`

**Today:** 19 tasks, all `done`; the backlog moved to GitHub Issues #14–#31
(29 issues open). `decisions/` and `wiki/` are empty, `plans/current.md` is
the untouched stub, and `forum/` is empty. The repo has `docs/`, including
`ROADMAP.md`, `V0_SPEC.md` and `SYSTEM_OVERVIEW.html`.

```toml
[map]

[map.tasks]
system = "GitHub Issues"
url = "https://github.com/ModernBusinessIntelligence/ledger/issues"
locator = "ModernBusinessIntelligence/ledger"

[map.decisions]
home = "native"
note = "repo engineering decisions stay in the repo for now (MBI decision-26 open point)"

[map.wiki]
system = "repo"
path = "docs"

[map.plans]
system = "repo"
path = "docs/ROADMAP.md"

[map.forum]
home = "native"
note = "agent coordination across worktrees; created on first use"

[map.team_tasks]
label = "People's tasks"
system = "Teamwork"
url = "https://sunsteadgroup.teamwork.com"
note = "only for issues a partner must see; they link to the GitHub issue (decision-26)"

[map.system_page]
label = "Company knowledge"
system = "MBI wiki"
url = "https://docs.modernbusinessintelligence.co/components/ledger"
```

**Keep:** `decisions/` as a native store. It is empty, so it is created by
the first `projects decision new`.

**Retire:** `tasks/` (git rm; the history keeps the 19 closed tasks), plus
the empty `wiki/`, `plans/` stub, `forum/` skeleton and `automations/`
(`--prune-empty`).

**Move first:** nothing. Before removing `tasks/`, check that no closed
task's Final Summary is the only record of a design choice; if one is,
copy it to `docs/`.

**Renders into:** README.md, and creates AGENTS.md (ledger has no AGENTS.md
or CLAUDE.md today).

---

## 3. process-mining-toolkit — `~/MBI/Code/process-mining-toolkit`

**Today:** 34 tasks, all `done`; the README says `_project/tasks/` is closed
history and open work is in GitHub Issues (19 open). 16 decisions (12
accepted, 2 draft, 2 superseded). 10 wiki pages (ARCHITECTURE,
ANALYSIS_CATALOG, DEPLOYMENT, SOPs and research), linked from README.md and
AGENTS.md. A 1.8k plan. The forum is empty. `CLAUDE.md` is a symlink to
`AGENTS.md`, so rendering into AGENTS.md covers Claude too.

```toml
[map]

[map.tasks]
system = "GitHub Issues"
url = "https://github.com/ModernBusinessIntelligence/process-mining-toolkit/issues"
locator = "ModernBusinessIntelligence/process-mining-toolkit"

[map.decisions]
home = "native"
note = "repo engineering decisions stay in the repo for now"

[map.wiki]
home = "native"
note = "engineering design docs and SOPs; company-level knowledge is on the MBI wiki"

[map.plans]
home = "native"

[map.forum]
home = "native"

[map.team_tasks]
label = "People's tasks"
system = "Teamwork"
url = "https://sunsteadgroup.teamwork.com"

[map.system_page]
label = "Company knowledge"
system = "MBI wiki"
url = "https://docs.modernbusinessintelligence.co/components/process-mining-toolkit"
```

**Keep:** `decisions/`, `wiki/` and `plans/` as native stores, since they
have content and the repo's docs link into `_project/wiki/`. Keep `forum/` as
a native store; it is created on first use.

**Retire:** `tasks/` (git rm, which matches the README's "closed history"),
the empty `forum/` skeleton and `automations/`.

**Move first:** nothing for the map. Separately: the two draft decisions
should be accepted or dropped. Whether `wiki/` pages that describe *MBI* and
not the code (for example `ENGAGEMENT_INFRASTRUCTURE_OPTIONS.md`) belong on
the MBI wiki is a later call.

**pmt behavior to change (with pmt #7):** `pmt workspace adopt-tracker`
calls `projects init <engagement>`. Under the new OpenWorkspace, that also
writes a "Where information lives" block into the engagement's
README.md/AGENTS.md, and `pmt workspace guide` later rewrites AGENTS.md
without the block. Doctor would call that "missing". It also leaves the map
undeclared, so `task create` still works but prints a note. Until #7
retires the tracker, either pass `--no-docs` together with the engagement's
homes (`--home tasks=<teamwork project url> --home decisions=<wiki parties
page> --home wiki=<wiki parties page> --home forum=none`), or have
`pmt workspace guide` render the block from `projects map show --json`.

---

## 4. computer-monitoring-recorder — `~/MBI/Code/computer-monitoring-recorder`

**Today:** 45 tasks, all `done` (20 GitHub issues open). 12 decisions (9
accepted, 3 draft). `wiki/` is empty. A 4.2k plan. The forum is empty. The
repo has `docs/` (BUILDING, DEV_STACK, MODELS, OAUTH, MSP handoff, spec/),
`DESIGN.md` and `VISION.md`. CLAUDE.md and AGENTS.md are separate files.

```toml
[map]
render_to = ["README.md", "AGENTS.md", "CLAUDE.md"]   # CLAUDE.md is not a symlink here

[map.tasks]
system = "GitHub Issues"
url = "https://github.com/ModernBusinessIntelligence/computer-monitoring-recorder/issues"
locator = "ModernBusinessIntelligence/computer-monitoring-recorder"

[map.decisions]
home = "native"
note = "repo engineering decisions stay in the repo for now"

[map.wiki]
system = "repo"
path = "docs"
note = "plus DESIGN.md and VISION.md at the root"

[map.plans]
home = "native"

[map.forum]
home = "native"

[map.team_tasks]
label = "People's tasks"
system = "Teamwork"
url = "https://sunsteadgroup.teamwork.com"

[map.system_page]
label = "Company knowledge"
system = "MBI wiki"
url = "https://docs.modernbusinessintelligence.co/components/computer-monitoring-recorder"
```

**Keep:** `decisions/` and `plans/`. `forum/` stays native and is created
on first use.

**Retire:** `tasks/` (git rm), plus the empty `wiki/`, the empty forum
skeleton and `automations/`.

**Move first:** decide the 3 draft decisions (accept or drop). Check that
nothing still points at `computer-monitoring/recorder/_project` (MBI-Docs
`resources/mbi-openworkspace` still names the old iCloud path).

---

## 5. qm — `~/MBI/Code/qm` (git-ignored tracker)

**Today:** `_project/` is excluded through `.git/info/exclude`, under qm
decision-2, "Keep _project out of the qm git fork": qm is a fork of
`yc-software/qm`. 16 tasks, all `done` (11 GitHub issues open). 2 accepted
decisions. `wiki/` is empty. A 1.4k plan (the deployment resume guide). The
forum is empty. README.md, AGENTS.md and CLAUDE.md are upstream's files,
and `adrs/` is upstream's too.

```toml
[map]
render_to = ["CLAUDE.local.md"]    # untracked; Claude Code reads it. Never touch upstream's README/AGENTS.

[map.tasks]
system = "GitHub Issues"
url = "https://github.com/ModernBusinessIntelligence/qm/issues"
locator = "ModernBusinessIntelligence/qm"

[map.decisions]
home = "native"
note = "local-only (git-ignored, qm decision-2); repo decisions stay in the repo for now"

[map.wiki]
system = "repo"
path = "deploy/layers/mbi"
note = "ARCHITECTURE.md and the MBI deployment layer"

[map.plans]
home = "native"

[map.forum]
home = "none"

[map.team_tasks]
label = "People's tasks"
system = "Teamwork"
url = "https://sunsteadgroup.teamwork.com"

[map.system_page]
label = "Company knowledge"
system = "MBI wiki"
url = "https://docs.modernbusinessintelligence.co/components/qm"

[map.credentials]
system = "1Password"
locator = "QM deployment .env (mbi, Fly)"
```

**Keep:** `decisions/` and `plans/`, local only. Because they live on
Matteo's laptop and nowhere else, this is the "laptop-only context" risk:
consider copying the 2 decisions to the MBI wiki (`components/qm`) as the
canonical record.

**Retire:** `tasks/`. It is not in git, so move it to
`_project/archive/2026-10-closed-tasks/`, not delete. Also retire the empty
`wiki/`, the forum skeleton and `automations/`.

**Move first:** confirm `CLAUDE.local.md` is ignored (add it to
`.git/info/exclude` if it isn't), so the render never shows up as a change
to the fork. Check that `deploy/layers/mbi/` is on the tracked branch.

---

## 6. llm-process-observer — `~/MBI/Code/llm-process-observer`

**Today:** every store is empty except a 1.2k plan. No GitHub issues are
open. The repo has `docs/`, README.md and
`rolling-llm-logits-implementation-brief.md`.

```toml
[map]

[map.tasks]
system = "GitHub Issues"
url = "https://github.com/ModernBusinessIntelligence/llm-process-observer/issues"
locator = "ModernBusinessIntelligence/llm-process-observer"

[map.decisions]
home = "native"
note = "repo engineering decisions stay in the repo for now"

[map.wiki]
system = "repo"
path = "docs"

[map.plans]
home = "native"

[map.forum]
home = "native"

[map.system_page]
label = "Company knowledge"
system = "MBI wiki"
url = "https://docs.modernbusinessintelligence.co/components/llm-process-observer"
```

**Keep:** `plans/` (it has content). `decisions/` and `forum/` are declared
native but are absent until first used.

**Retire:** the empty `tasks/`, `decisions/` and `wiki/`, the forum skeleton
and `automations/` (`--prune-empty`).

**Move first:** nothing.

---

## 7. pmt engagement trackers — e.g. `~/MBI/Engagements/salamander/_project`

**Today:** these trackers are generated by pmt (`pmt workspace
adopt-tracker` → `projects init`) and synced, encrypted, with the
engagement. They are not git repos, and the `~/Documents` workspace doesn't
discover them. Salamander has 10 open tasks (client asks), 1 done task, 5
accepted decisions (Dropbox scopes, INT vault naming, the Claude content
agreement, Teamwork MCP, network-exploration levels), 6 wiki items
(engagement notes, tracker log, on-prem discovery, M365 access, and
`field-notes/` for dropbox and sd-cad-nas), and a 2.2k plan centered on the
information-map deliverable. pmt issue #7, "Retire the in-workspace
_project/ tracker", is open. Its PR #4 already makes the engagement
AGENTS.md point to the MBI homes.

Information map (Salamander; other engagements follow the same shape):

```toml
[map]
render_to = []    # pmt rewrites AGENTS.md; pmt's "Where things go in MBI" section shows the same homes

[map.tasks]
system = "Teamwork"
url = "https://sunsteadgroup.teamwork.com"
locator = "the Salamander Designs engagement project"

[map.decisions]
system = "MBI wiki"
url = "https://docs.modernbusinessintelligence.co/parties/salamander-designs"

[map.wiki]
system = "MBI wiki"
url = "https://docs.modernbusinessintelligence.co/parties/salamander-designs"
note = "knowledge and findings, citing run and snapshot ids"

[map.plans]
system = "MBI wiki"
url = "https://docs.modernbusinessintelligence.co/parties/salamander-designs"

[map.forum]
home = "none"

[map.documents]
system = "Google Drive"
locator = "MBI shared drive: Engagements/Salamander Designs (decision-7 layout)"

[map.credentials]
system = "1Password"
url = "https://modernbusinessintelligence.1password.com"
note = "op:// pointers only; INT vault for client-app credentials"

[map.client_data]
label = "Client system data"
system = "pmt engagement workspace"
locator = "s3 bucket mbi-eng-salamander, prefix salamander (replicas: pmt workspace replicas)"
```

**Keep:** nothing native once pmt #7 lands. The end state is either no
`_project/` at all, or `_project/id` plus this `[map]` (no stores), if the
map should stay machine-readable. Pick one in the decision that supersedes
pmt decision-13 (#7's open item).

**Retire:** all five stores and the empty `automations/`.

**Move first** (by hand, with Matteo, per #7):
- The 10 open tasks (asks) → Teamwork, in the Salamander engagement project.
- The 5 decisions → the MBI wiki under `parties/salamander-designs`. The
  guide must first say which client details may go on the wiki; that is
  #7's last open item.
- The wiki notes and `field-notes/` → `parties/salamander-designs`, or the
  Drive engagement folder for work in progress.
- The plan → the party page, or the Drive folder.

Then run `pmt workspace guide`, so AGENTS.md drops the legacy-tracker row.

---

## Open questions for Matteo

1. **Repo decisions:** stay native in `_project/decisions/` (as above), or
   move to a tracked `docs/decisions/` per repo? The maps make either a
   one-line change (`projects map set decisions docs/decisions`).
2. **qm's local-only decisions and plan:** acceptable as is, or should the
   MBI wiki's `components/qm` hold the canonical copy?
3. **Teamwork locators:** which Teamwork project each repo's partner-visible
   items use. The maps above point at the site root.
4. **Engagement end state** (pmt #7): no `_project/` at all, or a
   store-less `[map]`?
