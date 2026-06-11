---
id: TASK-106
title: 'Research: hosted single-tenant vs multi-tenant tradeoffs (edification)'
status: To Do
created_date: '2026-05-06 17:40'
labels: []
dependencies: []
priority: low
quadrant: Q4
ordinal: 106000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Deep-dive on the design space and how existing systems navigate it. Personal-edification task with cross-project relevance — informs Briefing's isolation posture and likely several future systems (anything that holds users' data and has compliance/risk surface).

Hypothesis to test: hosted single-tenant (per-customer dedicated stacks) is becoming more popular as compliance burdens rise and per-customer infra costs fall; the traditional multi-tenant SaaS playbook may be ceding ground at the high end.

What to look at:
- How the major SaaS infrastructure providers position dedicated-instance / single-tenant offerings (Stripe Connect, AWS Dedicated, Postgres-per-customer at Neon/Supabase, GitHub Enterprise Server, MongoDB Atlas dedicated, etc.)
- Cohort-isolation patterns (how Linear, Notion, Discord, Slack handled the transition from single-DB to sharded multi-tenancy and what they exposed to customers)
- Compliance frameworks driving the shift (SOC 2 Type 2, EU data residency, healthcare/finance industry pressure)
- Cost crossover points where per-customer infra becomes economic vs pooled
- The 'BYOC / customer-managed deployment' pattern (Confluent BYOC, Snowflake, Materialize, Stripe-on-prem) — different from hosted-single-tenant but adjacent
- Tooling that makes per-customer ops tractable (Vercel projects, Render envs, k8s operators, Nomad)

Format the output as a memo with a section on each pattern + a synthesis ('what does the boundary actually look like in 2026'). Should be ~3-5 pages, citation-heavy.

Trigger: when Briefing has shipped to beta and there's appetite for a learning sprint, or when a future project hits the 'should this be multi-tenant?' decision point.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Memo committed to C2/decisions/ or a new docs/research/ folder
- [ ] #2 At least 6 named systems analyzed with their isolation posture
- [ ] #3 Synthesis section: when should new projects default to single-tenant?
- [ ] #4 Cross-references to Briefing/DESIGN.md if applicable
<!-- AC:END -->
