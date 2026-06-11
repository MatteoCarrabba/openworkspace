---
id: REMINDER-12
surface_on: 2026-06-05
surface_to: brief
status: pending
created: 2026-06-02T18:04:32.130Z
created_by: agent
created_by_detail: session-handover 2026-06-02 — partial L2 rollout, needs verification + Step 4
fired_at: null
promoted_to_task: null
recur: null
recur_until: null
---
# Resume TASK-156 mail forwarding rollout — verify Steps 1-3b completed and run Step 4 verification

User believes they completed through Step 3b of the L2 forwarding rollout walkthrough but wants to confirm on resume.

Open the Personal OS task and read Implementation Notes:
  backlog task view 156

Then verify each settings page is in the claimed state and run Step 4 verification (test inbound + reply round-trip per alias). See ~/Documents/Personal OS/MAIL_DESIGN.md §6 for L2 design context.

## then

1. Open https://www.icloud.com Mail → Preferences → General → confirm forwarding to matteo.angelo.carrabba@gmail.com is on AND 'Delete after forwarding' is unchecked.
2. Open https://mail.google.com as matteo.carrabba@aya.yale.edu → Settings → Forwarding → confirm forwarding to Gmail is enabled and source copy is kept in inbox.
3. Open Gmail Settings → Accounts and Import → Send mail as → confirm aliases for matteo.carrabba@icloud.com and matteo.carrabba@aya.yale.edu are both 'verified' (not 'pending').
4. Run Step 4 verification: have someone send a test to each forwarded address; confirm landing in Gmail AND staying in source. Then compose in Gmail using each alias and send to a separate account; confirm From-header is the alias.
5. Update TASK-156 ACs based on what's verified; start the 7-day spam-filter clean window or mark AC #6 if already past.
