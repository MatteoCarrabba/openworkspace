---
id: TASK-158
title: Categorize the human-judgment merchant tail in Uncategorized
status: In Progress
created_date: '2026-05-17 23:47'
updated_date: '2026-05-23'
labels: []
milestone: phase-i-personal-finance
dependencies: []
priority: medium
quadrant: Q2
ordinal: 176000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Why this matters

The 2026-05-17 apply-proposals run dropped Expenses:Uncategorized from $61,820 → $33,985 by closing the high-confidence machine-detectable patterns. The remaining ~$34K is the tail that needed a human's judgment to route correctly — it can't be closed by mining-and-applying because the right account isn't visible from the merchant name alone.

Closing this tail is what turns the monthly report and runway calc from 'mostly meaningful' into 'actually trustworthy'. Today's April monthly still says 49% of expense postings are Uncategorized ($9,506 of $11,203 spend). That number drowns the signal in every report that touches the spend side.

## Tail (largest items first)

- **Bilt Rewards $7,759** — actual rent (autopay to landlord through Bilt) plus genuine Bilt-card purchases that ride the same payee string. Routing: split into Expenses:Housing:Rent (the recurring rent autopay portion) and a separate per-charge categorization for the card purchases. Probably needs a date/amount-based split rule rather than a single payee match.
- **Custom Sofa Company $2,605** — furniture; Expenses:Home:Furniture (one-off, but still real spend).
- **Uplift Desk** — furniture; Expenses:Home:Furniture.
- **Christy Sports $1,500** — ski rental/gear; Expenses:Recreation:Skiing or similar.
- **JetBlue $1,489** — travel; Expenses:Travel:Air.
- **Amazon $1,156** — bucket payee; needs item-level review or a default Expenses:Shopping bucket.
- Plus a long tail of smaller merchants that appear under multiple aliased names (Margo Williams via Venmo splits, Big Sky Resort vs F&B at Big Sky, etc.) — should land in .ingest/aliases.toml as merchant-alias entries so the underlying rule applies cleanly.

## Approach

Walk the propose-rules.py output once with human-in-the-loop confirmation. For each ambiguous merchant, either (a) decide on an account and apply, (b) add a merchant alias if the issue is name fragmentation, or (c) explicitly leave Uncategorized with a note explaining why (e.g. mixed-use payee like Bilt or Amazon).

Pair with: run propose-transfers.py once more to make sure nothing transfer-shaped has slipped back in.
<!-- SECTION:DESCRIPTION:END -->

## Implementation Notes

### 2026-05-23 — Cumulative session progress

**Headline:** `Expenses:Uncategorized` went from $61,820 → $5,210 over the multi-round cleanup (91.6% reduction). The tail is now small enough that the monthly report and runway calc are no longer drowned in noise.

**Major routing decisions applied:**

- **Bilt Rewards $7,759 → `Expenses:Housing:Rent`** — landlord autopay through Bilt; routed in bulk after confirming the recurring portion is rent. Mixed-payee card purchases on Bilt still need per-charge handling but are now a small minority.
- **Move-in cluster ~$5,400 → `Expenses:Housing:BuenaVista-Setup`** — Custom Sofa Co, Uplift Desk, and other one-off furnishing/setup spend for the 65 Buena Vista E lease. Bundled rather than split because the timeframe + lease-start context makes the grouping meaningful.
- **Travel cluster (Big Sky Resort, Christy Sports, JetBlue) → `Expenses:Travel:*` / `Expenses:Transport:*`** per user judgment on Christy = ski-trip-coded rather than recreation-coded.
- **LightCone $675 → `Expenses:Travel`** — user-confirmed event-travel-coded.
- **STATE OF CT $885 → `Expenses:Taxes`** — state tax payment.
- **RINSE → `Expenses:Household:Laundry`** — recurring laundry pickup service; rule added to `.ingest/rules.toml`.
- **Apple Card + Amazon Store Card → unlinked liabilities** — these aren't in Plaid; postings that look like card payments to them are real outflows from cash, with the card balance untracked. Documented as a known data gap rather than a routing issue.
- Plus a long tail of smaller merchants routed via specific rules now in `.ingest/rules.toml`.

**What's left (~$5,210 in `Expenses:Uncategorized`):**

- ~$2,500 of small one-off tail items (genuine miscellany — single-charge merchants where the right account isn't obvious from name + amount alone).
- The bundled **Liberty unknown-counterparts** work — now scoped into TASK-159 (which has been expanded to cover both ***1173 inflows AND ***0257 outflows).
- The $1,162 IRS refund was identified + moved to `Income:Taxes:Refund` separately from this tail.

**Protocol established:**

The `/finance-receipt-lookup` skill (see `Personal OS/Tools/Finance/skills/finance-receipt-lookup/`) was created during this session as the canonical way to resolve "merchant name doesn't tell me what this is" ambiguity going forward — cross-references the posting against Gmail receipts to determine sub-vs-one-off, line items, and proposed categorization. Use it for the remaining tail rather than guessing.

**Not closed yet:** task stays In Progress until the remaining ~$2,500 tail is walked through (likely a single session with `/finance-receipt-lookup` for any non-obvious items).
