# Epic 63: Collusion Detection — Implementation Status

**Status**: ✅ Complete (v1 + v2 + live flagging + red-team audit)
**Date**: April 16–19, 2026
**Epic PRD**: [`docs/prd/epics/epic-63-external-reputation-bridge.md`](../../prd/epics/epic-63-external-reputation-bridge.md)
**Related Commits**: `f67e2bd` (v1), `372efb4` (v2 ring coefficient), `444b1f5` (red-team audit), `7c95371` (live flagging)

---

## What Was Built

Epic 63 centers on consuming external reputation sources (ERC-8004, Mnemom, escrow history). During marketplace simulation rounds we observed that the **internal** `a2a_task_feedback` source — the one Sly owns — was trivially gamed: an agent could rate itself (or its ring of accomplices) and inflate its trust score past policy thresholds (e.g., `min_counterparty_reputation_score: 600`).

This work adds collusion detection directly inside the trust-score calculator so the a2a-feedback source is no longer a free ride to high reputation.

### v1: Single-agent heuristics (`f67e2bd`)

Inside `apps/api/src/services/reputation/collusion-detector.ts` — three signals computed per agent across their last N ratings:

| Signal | Meaning |
|---|---|
| `uniqueRaters` | Count of distinct rater agent IDs. Low diversity = suspicious. |
| `topRaterShare` | Share of ratings coming from the single most frequent rater. > ~0.4 is a red flag. |
| `reciprocalRatio` | Share of ratings where the target also rated the rater. > ~0.5 suggests a trading pair. |

The detector returns a `collusionFlag` (`clean` / `suspicious` / `colluding`) and a short `reason` string. Trust score is penalized in proportion to the flag:

```
a2a_feedback_score_raw = base_score_from_ratings
if flag == 'suspicious':  score *= 0.7
if flag == 'colluding':   score *= 0.4
```

Surfaced on the agent detail page so a viewer can see *why* a score looks off.

### v2: Ring coefficient via one-hop graph community (`372efb4`)

v1 catches pairs well but misses triangles and larger rings where no single rater dominates. v2 adds a fourth signal:

| Signal | Meaning |
|---|---|
| `ringCoefficient` | For the agent's top-K raters, how densely connected are they to each other by rating edges? Ranges 0 (raters are strangers) to 1 (raters all rate each other). |

Implementation is a one-hop graph walk: pull the target's raters, pull *their* rating edges, compute the density. No Neo4j / igraph — raw SQL + a small in-memory matrix. Cheap at N ≤ 50 raters, which covers 99% of agents.

The flag-assignment logic was updated to fold the ring coefficient in: high ring coefficient + moderate top-rater share bumps the flag up, even when no single rater dominates.

### Red-team audit (`444b1f5`)

`apps/api/scripts/red-team-detector-audit.ts` — a synthetic adversary generator that runs N scripted collusion strategies (pair-trading, triangle rings, mixed-cover rings, etc.) against the detector and reports which strategies slipped through. Output lands in `docs/reports/red-team-detector-audit.md` as a baseline we can regress against.

Baseline at the time: v2 catches pair-trading and triangle rings reliably; misses strategies that blend real peer traffic with colluding traffic in ratios below ~60% colluding. Flagged this gap for a v3 follow-up (min-volume threshold + dispute-rate + rating velocity signals).

### Live flagging during scenario runs (`7c95371`)

Before this, the detector ran on-demand when the agent detail page was opened. During marketplace simulations the LIVE_ROUND_VIEWER would show all agents at `clean` until someone clicked in. Now:

- `apps/marketplace-sim/src/scenarios/blocks/ring_trade.ts`, `bake_off.ts`, `double_auction.ts` — each block calls `sly-client.ts`'s `checkCollusion()` at the end of its scenario tick.
- `apps/api/src/routes/round-viewer.ts` — new `POST /admin/round/check-collusion` endpoint that batch-recomputes collusion flags for all agents in the current round.
- `docs/demos/LIVE_ROUND_VIEWER.html` — pulls the flags live and renders ring/pair decorators next to each agent card as they turn suspicious.

So rings that form mid-round are now visible in real time, not on next page refresh.

---

## Files Modified

| File | Role |
|---|---|
| `apps/api/src/services/reputation/collusion-detector.ts` | Core detector. v1 heuristics + v2 ring coefficient. |
| `apps/api/src/services/reputation/trust-score-calculator.ts` | Applies the collusion penalty to the `a2a_feedback` source score. |
| `apps/api/src/services/reputation/types.ts` | Added `collusionFlag`, `ringCoefficient`, per-signal fields. |
| `apps/api/src/routes/reputation.ts` | Exposes the flag + signals on the agent reputation response. |
| `apps/api/src/routes/round-viewer.ts` | `POST /admin/round/check-collusion` batch endpoint. |
| `apps/api/scripts/red-team-detector-audit.ts` | Adversary generator + audit runner. |
| `apps/marketplace-sim/src/sly-client.ts` | `checkCollusion()` helper used by scenario blocks. |
| `apps/marketplace-sim/src/scenarios/blocks/{ring_trade,bake_off,double_auction}.ts` | Hook the collusion check into each scenario tick. |
| `apps/web/src/app/dashboard/agents/[id]/page.tsx` | Renders the flag + signals on the agent detail page. |
| `docs/demos/LIVE_ROUND_VIEWER.html` | Live ring/pair decorators. |
| `docs/reports/red-team-detector-audit.md` | Baseline audit report. |

---

## Verification

- v1 detector unit-tested against synthetic pair-trade fixtures — all three signals flag correctly.
- v2 ring coefficient tested against a 5-agent triangle ring — ringCoefficient = 1.0, flag = `colluding`.
- Red-team audit runs on every push to main; baseline report is in `docs/reports/red-team-detector-audit.md`.
- Live flagging verified in Round 10 (April 16, 2026) — ring trade scenario surfaced three agents as `colluding` within the first tick.

---

## Known Gaps → v3 Backlog

Captured in memory (`project_collusion_detection_gaps.md`):

1. **Min-volume threshold** — agents with fewer than ~10 ratings should not be flagged at all (too noisy). Currently we flag aggressively below that threshold.
2. **Dispute-rate detector** — colluding rings tend to have zero disputes. A dispute rate far below the peer median is itself a signal.
3. **Rating velocity** — healthy agents accumulate ratings over time; colluding rings often burst-rate at round boundaries. Time-series anomaly detection on rating arrival times.
4. **Adapted-colluder detection** — rings that mix in some real peer traffic to stay under the detector. Needs a longer-window baseline or a secondary classifier.

These are tracked but not yet scheduled.

---

## Design Rationale

**Why penalize instead of block?**

An agent flagged `suspicious` still has legitimate ratings mixed in. Cutting their score to zero would punish honest raters too. The 0.7× / 0.4× multipliers degrade the score enough that policy engines relying on `min_counterparty_reputation_score: 600` stop contracting with them, without treating them as definitively malicious (which would require human review).

**Why a one-hop graph walk instead of a full community-detection library?**

Agents have bounded rater sets (median 12, p99 ~60). At that scale a hand-rolled density computation is faster than spinning up a graph library and translates to a cheap SQL query. If rater counts grow past ~500 per agent we'll revisit.

**Why run the audit on every push?**

Collusion strategies evolve. An ad-hoc audit rots. Running it on every push means a regression (a new change that makes the detector less sensitive) is caught on the commit that introduced it, not months later.
