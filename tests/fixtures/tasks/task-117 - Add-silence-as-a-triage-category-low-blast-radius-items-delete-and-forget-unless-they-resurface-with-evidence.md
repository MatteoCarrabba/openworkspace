---
id: TASK-117
title: >-
  Add 'silence' as a triage category (low-blast-radius items: delete and forget
  unless they resurface with evidence)
status: Done
created_date: '2026-05-06 18:18'
updated_date: '2026-06-02 01:21'
labels: []
dependencies: []
priority: medium
quadrant: Q2
ordinal: 134000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Source: 2026-05-06 morning briefing Q8 (Aristotle key context, then explicit principle).

Matteo's framing, near-verbatim:

> there is another category we need to add when things are being triaged. Which is essentially silence. Things, because if they are actually important, they will surface again with evidence that they're important. We can delete it and forget it, and if it causes an issue, we'll address it then. We should only do this if we know that the blast radius is contained.

The Aristotle API key (Personal OS TASK-92) is the canonical example: closed without revocation, on the bet that if the key were live and abused, evidence (billing alert, auth failure, etc.) would show up.

**Open: where does this convention live?**
The natural homes are `~/Documents/CLAUDE.md` (so every session knows the category) or a new section in a Personal OS conventions doc. Per the briefing-triage skill rules, CLAUDE.md changes need explicit approval — so this task captures the principle but the *write* should be confirmed with Matteo before landing. Auto-memory is the immediate fallback.

**Why this matters (Q2):** without this, Q4 (delegate-or-drop) becomes the catch-all for things that should actually be deleted, and the to-do list rots.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Triage convention (Q1-Q4 quadrants + 'silence') documented in /Users/matteocarrabba/Documents/CLAUDE.md or a relevant convention file (with user approval — see open question below)
- [ ] #2 task-new / tasks-audit / briefing-triage skills updated to recognize the category
- [ ] #3 Closure phrasing standard: 'silenced — low blast radius; will resurface with evidence if it matters' or similar
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Done — the 'silence' triage outcome is captured durably in ~/Documents/CLAUDE.md (Hard rules: silence as a triage decision) and in agent memory [[silence_triage_category]]. The principle is live and applied.
<!-- SECTION:FINAL_SUMMARY:END -->
