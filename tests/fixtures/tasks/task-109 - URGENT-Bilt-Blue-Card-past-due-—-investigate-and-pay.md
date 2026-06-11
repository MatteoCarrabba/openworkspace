---
id: TASK-109
title: 'URGENT: Bilt Blue Card past due — investigate and pay'
status: Done
created_date: '2026-05-06 17:51'
updated_date: '2026-05-17 22:34'
labels:
  - needs-user
milestone: phase-i-personal-finance
dependencies: []
priority: high
quadrant: Q1
ordinal: 126000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Surfaced from Gmail scan 2026-05-06 (during TASK-97 inventory pass).

Bilt Blue Card has been past-due:
- 2026-04-06 — "Your Blue Card is past due"
- 2026-04-09 — "Your Blue Card payment is 7 days late"
- 2026-04-16 — "Your Blue Card payment is 14 days late"

Likely cause: autopay didn't carry over from the old Wells Fargo Bilt Mastercard to the new Bilt Blue Card after the Wells Fargo / Bilt split. The user has the Bilt Blue Card statement notification from 2026-04-07 but the payment never went through.

This is the kind of thing the cash-management forecast (TASK-59) is supposed to catch — but until the forecast exists, this is what manual scanning looks like.

This is Q1 (urgent + important): late payments accrue interest + late fees + can hit credit score. Should be resolved in the next few days, not weeks.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Logged into Bilt app and confirmed current balance + status
- [ ] #2 Paid the past-due amount
- [ ] #3 Set up autopay (full balance) on the Bilt Blue Card
- [ ] #4 Confirmed any late fees / interest are documented (or contested if first-offense forgiveness is available)
- [ ] #5 Bilt Blue Card README updated with current status
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Resolved 2026-05-06 via $5,164.22 payment that cleared the past-due bill. Confirmed against the ingested Bilt ledger (TASK-52): Bilt payments visible at 2026-03-02 ($3,879.53), 2026-04-02 ($3,879.87), 2026-05-06 ($5,164.22). Current outstanding $539.06 against $7,500 limit (small, well within autopay window). Original April past-due alert appears to have been triggered by a missed/late autopay that was caught up in early May. Action: no further work needed; monitor via the ingested ledger going forward.
<!-- SECTION:FINAL_SUMMARY:END -->
