---
id: TASK-1
title: Revoke exposed Anthropic API key from Salamander notes export
status: Done
created_date: '2026-05-04 04:05'
updated_date: '2026-05-05 04:17'
labels:
  - security
milestone: phase-e-notes-obsidian
dependencies: []
references:
  - 'Inbox:Outbox/_from-notes-export/SALAMANDER-SECRETS-REVIEW/'
priority: high
quadrant: Q1
ordinal: 1000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
An Anthropic API key (sk-ant-api03-...) was found in plaintext inside ~Documents/Inbox:Outbox/_from-notes-export/SALAMANDER-SECRETS-REVIEW/NETSUITE.md during the 2026-05-03 Apple Notes triage. The key has been on the open filesystem for unknown duration. Revoke it at console.anthropic.com regardless of the file's eventual destination. Once revoked, the file can be sanitized (replace the secret with an op://Personal/<item> pointer) and moved to Dormant Projects/Salamander/Notes from Apple Notes/.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Anthropic API key revoked at console.anthropic.com
- [ ] #2 NETSUITE.md updated to remove the plaintext key (replace with 1Password pointer)
- [ ] #3 Cleaned NETSUITE.md moved to Dormant Projects/Salamander/Notes from Apple Notes/
<!-- AC:END -->

## Final Summary

Anthropic API key revoked at console.anthropic.com on 2026-05-05 — the live security threat is closed (key is no longer valid). AC #1 done.

**Not done in this task:** the underlying file `~/Documents/Inbox:Outbox/_from-notes-export/SALAMANDER-SECRETS-REVIEW/NETSUITE.md` still contains the (now-revoked) key in plaintext, and has not been moved to its eventual home in `Dormant Projects/Salamander/Notes from Apple Notes/`. ACs #2 and #3 are left unchecked. Closing the task on the security-threat axis only; the file-cleanup is now hygiene rather than a security incident, but should still happen as part of the broader Inbox triage.
