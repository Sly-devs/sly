# Red-Team Detector Audit (2026-04-19)

Empirical validation of the collusion detector (v1 + v2) shipped in commits `f67e2bd` and `372efb4`.

## Methodology

- Queried every `sim-*` agent with at least one row in `a2a_task_feedback` as the rated party.
- Classified by persona name: `ColluderBot`, `DisputeBot`, `SpamBot` = **adversarial** (expected to be flagged).
- Everything else (`HonestBot`, `QualityReviewer`, `BudgetBot`, ...) = **honest** (expected NOT flagged).
- Ran `computeCollusionSignals` for each and compared the `flagged` verdict to the expected label.

## Confusion matrix

| | **Flagged** | **Not flagged** |
|---|---|---|
| **Adversarial** | 4 (TP) | 3 (FN — missed) |
| **Honest**       | 2 (FP — false flag) | 26 (TN) |

- **Recall**    = 57.1% (4/7 adversarial agents caught)
- **Precision** = 66.7% (4/6 flagged agents were truly adversarial)
- **FP rate**   = 7.1% (2/28 honest agents flagged in error)

## Per-agent results

| Agent | Expected | Ratings | Uniq / Top% / Recip% / Ring% | Flagged | Class | Reason |
|---|---|---|---|---|---|---|
| `sim-ColluderBot-1` | adversarial | 2 | 1 / 100% / 0% / 0% | 🚨 | TP | Only 1 unique rater across 2 ratings — tight clique |
| `sim-ColluderBot-2` | adversarial | 2 | 2 / 50% / 50% / 0% | 🚨 | TP | Only 2 unique raters across 2 ratings — tight clique |
| `sim-ColluderBot-3` | adversarial | 3 | 3 / 33% / 0% / 51% | 🚨 | TP | 51% of raters' own raters are inside this agent's rating circle — closed subgraph |
| `sim-ColluderBot-4` | adversarial | 3 | 2 / 67% / 0% / 0% | 🚨 | TP | Only 2 unique raters across 3 ratings — tight clique |
| `sim-DisputeBot-1` | adversarial | 98 | 23 / 17% / 87% / 0% | — | FN |  |
| `sim-DisputeBot-2` | adversarial | 72 | 23 / 13% / 87% / 0% | — | FN |  |
| `sim-SpamBot-1` | adversarial | 59 | 22 / 12% / 50% / 0% | — | FN |  |
| `sim-BudgetBot-1` | honest | 62 | 19 / 23% / 84% / 0% | — | TN |  |
| `sim-BudgetBot-2` | honest | 65 | 24 / 8% / 92% / 0% | — | TN |  |
| `sim-BudgetBot-3` | honest | 76 | 23 / 16% / 78% / 0% | — | TN |  |
| `sim-BudgetBot-4` | honest | 22 | 16 / 14% / 44% / 0% | — | TN |  |
| `sim-ConservativeBot-1` | honest | 69 | 18 / 16% / 89% / 0% | — | TN |  |
| `sim-HonestBot` | honest | 4 | 1 / 100% / 100% / 0% | 🚨 | FP | Only 1 unique rater across 4 ratings — tight clique |
| `sim-HonestBot-1` | honest | 262 | 30 / 16% / 90% / 0% | — | TN |  |
| `sim-HonestBot-2` | honest | 298 | 29 / 17% / 93% / 0% | — | TN |  |
| `sim-HonestBot-3` | honest | 218 | 27 / 13% / 81% / 0% | — | TN |  |
| `sim-HonestBot-4` | honest | 99 | 25 / 14% / 80% / 0% | — | TN |  |
| `sim-HonestBot-5` | honest | 71 | 18 / 15% / 83% / 0% | — | TN |  |
| `sim-MMBot-1` | honest | 43 | 18 / 12% / 61% / 0% | — | TN |  |
| `sim-MMBot-2` | honest | 59 | 21 / 14% / 76% / 0% | — | TN |  |
| `sim-NewcomerBot-1` | honest | 94 | 25 / 10% / 84% / 0% | — | TN |  |
| `sim-NewcomerBot-2` | honest | 79 | 27 / 10% / 81% / 0% | — | TN |  |
| `sim-NewcomerBot-3` | honest | 19 | 13 / 11% / 69% / 0% | — | TN |  |
| `sim-OpportunistBot-1` | honest | 65 | 23 / 14% / 91% / 0% | — | TN |  |
| `sim-OpportunistBot-2` | honest | 61 | 24 / 13% / 75% / 0% | — | TN |  |
| `sim-OpportunistBot-3` | honest | 36 | 20 / 8% / 40% / 0% | — | TN |  |
| `sim-QualityReviewer` | honest | 3 | 1 / 100% / 100% / 0% | 🚨 | FP | Only 1 unique rater across 3 ratings — tight clique |
| `sim-QualityReviewer-1` | honest | 253 | 24 / 17% / 96% / 0% | — | TN |  |
| `sim-QualityReviewer-2` | honest | 174 | 24 / 16% / 92% / 0% | — | TN |  |
| `sim-QualityReviewer-3` | honest | 93 | 20 / 14% / 95% / 0% | — | TN |  |
| `sim-ResearchBot-1` | honest | 83 | 24 / 14% / 92% / 0% | — | TN |  |
| `sim-ResearchBot-2` | honest | 68 | 25 / 9% / 80% / 0% | — | TN |  |
| `sim-SpecialistBot-1` | honest | 77 | 23 / 21% / 70% / 0% | — | TN |  |
| `sim-SpecialistBot-2` | honest | 62 | 20 / 15% / 80% / 0% | — | TN |  |
| `sim-WhaleBot-1` | honest | 78 | 22 / 19% / 100% / 0% | — | TN |  |

## Known limitations

- **Name-based ground truth**: we assume persona prefix predicts intent. Fine for sim personas we control.
- **One-hop graph only**: ring coefficient looks at raters-of-raters. Multi-hop rings (A→B→C→A) aren't fully detected until a v3 Louvain/SCC pass.
- **Time-blind**: sudden rating-bomb spikes aren't caught yet.
- **Needs volume**: agents with 0–1 ratings are excluded from the audit.

Re-run this after each scenario round to track drift.
