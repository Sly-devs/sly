# Epic 63: External Reputation Bridge

**Status:** Pending
**Phase:** 5.3 (Agent Contracting)
**Priority:** P0 — Trust Layer for Agent Contracts
**Estimated Points:** 25
**Stories:** 7 (5 complete, 2 blocked on external SDKs)
**Note:** Story 63.5 (On-Chain Escrow History Aggregator) moved to Epic 62 as Story 62.11. Stories 63.3 (Mnemom) and 63.4 (Vouched) are stubs blocked on external SDKs.
**Dependencies:** None (can start immediately)
**Created:** March 1, 2026
**Implementation Notes:** [Collusion Detection (v1 + v2 + live flagging + red-team audit)](../../completed/epics/EPIC_63_COLLUSION_DETECTION.md)

[← Back to Epic List](./README.md)

---

## Executive Summary

Read-only aggregation service that consumes reputation data from multiple external sources and presents a unified trust score to Sly's policy engine. Sly does not become a reputation provider — we become the enterprise layer that checks reputation before authorizing contracts.

**Three Reputation Sources (this epic):**
1. **ERC-8004** (Ethereum/Base, launched Jan 29, 2026) — on-chain Identity, Reputation, and Validation registries
2. **Mnemom Trust Ratings** — individual agent scores (0–1000, AAA-CCC grades) and Team Trust Ratings
3. **Vouched Agent Checkpoint / MCP-I** — KYA suite with public "Know That AI" registry

**Fourth source (moved to Epic 62):**
4. **On-Chain Escrow History** — now Epic 62 Story 62.11 (Escrow History Reputation Source)

**Unified Trust Score:**
All sources aggregate into a normalized 0–1000 score across four dimensions with weighted scoring. Wallet policies in Epic 18 reference tiers directly: `"min_counterparty_reputation_score": 600` means only contract with agents scoring 600+.

**Key Design Decision — Read-Only, Cached, Graceful:**
Sly never writes reputation data (we're not a reputation provider). All queries are cached (5-min TTL). If a source is unavailable, the score degrades gracefully — available sources are weighted higher, and the policy engine can be configured to allow/deny when reputation is incomplete.

---

## SDK Impact Assessment

| Feature/Endpoint | Needs SDK? | Module | Priority | Notes |
|------------------|------------|--------|----------|-------|
| `GET /v1/reputation/:identifier` | ✅ Yes | `sly.reputation` | P0 | Query unified trust score |
| `GET /v1/reputation/:identifier/sources` | ✅ Yes | `sly.reputation` | P1 | Breakdown by source |
| Dashboard reputation widget | ❌ No | - | - | Frontend only |
| Internal policy engine calls | ❌ No | - | - | Server-to-server |

---

## Architecture

### Unified Trust Score

```
┌──────────────────────────────────────────────────────────┐
│                  External Reputation Sources               │
│                                                            │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────┐              │
│  │  ERC-8004   │ │   Mnemom    │ │ Vouched │              │
│  │  On-Chain   │ │  Trust API  │ │ MCP-I   │              │
│  │  (Base/ETH) │ │             │ │         │              │
│  └──────┬──────┘ └──────┬──────┘ └────┬────┘              │
│         │               │              │                   │
└─────────┼───────────────┼──────────────┼───────────────────┘
          │               │              │
          ▼               ▼              ▼
                                    ┌─────────┐
                                    │ Escrow  │ ◄── Epic 62
                                    │ History │    Story 62.11
                                    │ (Base)  │
                                    └────┬────┘
                                         │
                                         ▼
┌──────────────────────────────────────────────────────────┐
│           Unified Trust Score Calculator (63.6)           │
│                                                           │
│  Identity (25%)        │ ERC-8004 Identity + Vouched      │
│  Payment Reliability   │ Escrow completion rate, dispute   │
│    (30%)               │   frequency, avg escrow value     │
│  Capability Trust      │ Mnemom individual + ERC-8004      │
│    (25%)               │   Validation Registry             │
│  Community Signal      │ ERC-8004 Reputation Registry      │
│    (20%)               │   (peer feedback, weighted)       │
│                                                           │
│  Output: unified_score (0-1000), unified_tier (A-F)       │
└──────────────────────────┬────────────────────────────────┘
                           │
                           ▼
                ┌──────────────────────┐
                │  Policy Engine (E18) │
                │  "min score: 600"    │
                │  "min tier: B"       │
                └──────────────────────┘
```

### Tier Mapping

| Score Range | Tier | Label | Policy Meaning |
|-------------|------|-------|----------------|
| 900–1000 | A | Excellent | Auto-approve, highest limits |
| 750–899 | B | Good | Auto-approve, standard limits |
| 600–749 | C | Fair | May require approval |
| 400–599 | D | Limited | Requires approval, reduced limits |
| 200–399 | E | Poor | Manual review required |
| 0–199 | F | Unrated/New | Block or strict manual review |

### Existing Infrastructure Reused

| Component | Location | Reuse |
|-----------|----------|-------|
| Base chain RPC | `apps/api/src/config/chains.ts` | ERC-8004 + escrow history reads |
| Agent lookup | `apps/api/src/routes/agents.ts` | Resolve Sly agents to addresses |
| Cache layer | `apps/api/src/cache/` | TTL cache for reputation data |
| Policy engine | Epic 18 `contract-policy-engine.ts` | Consumes unified score |
| Workflow actions | Epic 29 `query_reputation` action | Workflow step integration |

---

## Stories

### Phase 1: Core Infrastructure

---

### Story 63.1: Reputation Data Model & Cache

**Points:** 3
**Priority:** P0

**Description:**
Create database tables for cached reputation profiles, source configuration, and query audit log. Implement TTL-based caching layer.

**Tables:**
- `external_agent_profiles` — cached reputation per external agent (external_identifier, identity_source, scores per dimension, unified_score, unified_tier, last_refreshed, raw_data JSONB)
- `reputation_source_configs` — per-tenant source configuration (source_type, enabled, api_endpoint, weight_override, minimum_data_points, refresh_interval_seconds)
- `reputation_queries` — audit log (external_identifier, source_type, query_timestamp, response_data, latency_ms, cache_hit)

**Files:**
- New: `apps/api/supabase/migrations/XXX_reputation_bridge.sql`
- New: `apps/api/src/services/reputation/types.ts`
- New: `apps/api/src/services/reputation/cache.ts`
- Modify: `apps/api/src/app.ts` (mount routes)

**Acceptance Criteria:**
- [ ] Migration runs without errors
- [ ] RLS policies on source configs (tenant-scoped) and profiles (shared read)
- [ ] Cache layer with configurable TTL (default 5 minutes)
- [ ] Cache hit/miss tracked in `reputation_queries`
- [ ] Stale cache returns data with `stale: true` flag while refresh runs in background

---

### Story 63.2: ERC-8004 Integration

**Points:** 5
**Priority:** P0

**Description:**
Read from ERC-8004 on-chain registries on Base (primary) and Ethereum mainnet (fallback). Three registries: Identity (ERC-721 NFT per agent), Reputation (structured peer feedback), Validation (task verification).

**Implementation:**
- Read Identity Registry: `getIdentity(agentAddress)` → linked `/.well-known/agent-card.json`
- Read Reputation Registry: `getFeedback(agentAddress)` → all feedback entries
- Read Validation Registry: `getValidations(agentAddress)` → task verification records
- Aggregate off-chain using weighted scoring (recency, volume, source credibility)

**Files:**
- New: `apps/api/src/services/reputation/sources/erc8004.ts`
- New: `apps/api/src/services/reputation/sources/erc8004-abi.json`

**Acceptance Criteria:**
- [ ] Reads from all three ERC-8004 registries via ethers.js or viem
- [ ] Prioritizes Base chain (lower latency) with Ethereum mainnet fallback
- [ ] Aggregates feedback with recency weighting (recent feedback weighted higher)
- [ ] Handles agents with no ERC-8004 identity gracefully (returns null, not error)
- [ ] Results cached with 5-minute TTL
- [ ] Query latency logged for monitoring

---

### Story 63.3: Mnemom API Integration

**Points:** 3
**Priority:** P1

**Description:**
Integrate with Mnemom Trust Ratings API for individual agent scores and Team Trust Ratings for multi-agent groups.

**Implementation:**
- Query individual agent trust rating by agent ID (0–1000 scale, AAA-CCC grade)
- Query team ratings for multi-agent contract proposals
- Map 0–1000 scale to Sly internal scoring (direct mapping)
- Mnemom's scoring prioritizes Team Coherence History at 35% weight

**Files:**
- New: `apps/api/src/services/reputation/sources/mnemom.ts`

**Acceptance Criteria:**
- [ ] Individual agent trust rating query works
- [ ] Team trust rating query works (for multi-agent proposals)
- [ ] Handles API unavailability gracefully (timeout 3s, return null)
- [ ] Results cached with 5-minute TTL
- [ ] SVG badge URL included in response for dashboard display

---

### Story 63.4: Vouched / MCP-I Integration

**Points:** 3
**Priority:** P1

**Description:**
Integrate with Vouched Agent Checkpoint and MCP-I (identity standards built on Anthropic's MCP) for agent verification status.

**Implementation:**
- Query "Know That AI" public registry for agent registration status
- Retrieve delegation scope and permission boundaries (Identiclaw product)
- Valuable for agents with OAuth/MCP-I identity rather than on-chain identity

**Files:**
- New: `apps/api/src/services/reputation/sources/vouched.ts`

**Acceptance Criteria:**
- [ ] Query agent verification status from Know That AI registry
- [ ] Retrieve delegation scope and permission boundaries
- [ ] Map verification status to identity score component
- [ ] Handles API unavailability gracefully
- [ ] Results cached with 5-minute TTL

---

### ~~Story 63.5~~ — Moved to Epic 62 as Story 62.11

> **On-Chain Escrow History Aggregator** has been moved to **Epic 62: Escrow Orchestration** as **Story 62.11: Escrow History Reputation Source**. Escrow history belongs with escrow infrastructure. See [Epic 62](./epic-62-escrow-orchestration.md) for the updated spec.

---

### Phase 2: Aggregation & UI

---

### Story 63.6: Unified Trust Score Calculator

**Points:** 5
**Priority:** P0

**Description:**
Weighted aggregation engine that combines all source scores into a single unified trust profile. Exposes API endpoints for policy engine and dashboard.

**Scoring Weights (defaults, configurable per tenant):**
- Identity: 25% (ERC-8004 Identity + Vouched)
- Payment Reliability: 30% (Escrow History)
- Capability Trust: 25% (Mnemom + ERC-8004 Validation)
- Community Signal: 20% (ERC-8004 Reputation)

**Endpoints:**
- `GET /v1/reputation/:identifier` — unified score + tier
- `GET /v1/reputation/:identifier/sources` — breakdown by source with raw data

**Files:**
- New: `apps/api/src/services/reputation/trust-score-calculator.ts`
- New: `apps/api/src/routes/reputation.ts`

**Acceptance Criteria:**
- [ ] Aggregates available sources with weighted scoring
- [ ] Graceful degradation: if a source is unavailable, redistributes weight across available sources
- [ ] `minimum_data_points` threshold: if fewer than N data points, returns `confidence: 'low'`
- [ ] Maps unified score (0–1000) to tier (A–F)
- [ ] GET endpoint returns unified score, tier, confidence, per-dimension breakdown
- [ ] GET /sources returns raw data from each source with individual scores
- [ ] Per-tenant weight overrides from `reputation_source_configs`
- [ ] Result cached as `external_agent_profiles` row
- [ ] Accepts both Sly agent_id and external wallet address as identifier

---

### Story 63.7: Reputation Dashboard Widget

**Points:** 3
**Priority:** P2

**Description:**
Counterparty profile card for the dashboard showing trust breakdown when reviewing contracts or escrows.

**Files:**
- New: `apps/web/src/components/reputation/ReputationCard.tsx`
- New: `apps/web/src/components/reputation/TrustBreakdown.tsx`

**Acceptance Criteria:**
- [ ] Card shows: unified score, tier badge, confidence level
- [ ] Breakdown chart: 4 dimensions with individual scores
- [ ] Source indicators: which sources contributed data
- [ ] "Last updated" timestamp with refresh button
- [ ] Embedded in escrow detail page and contract review workflow
- [ ] Handles "no data" state with clear messaging

---

### Phase 3: Cross-Epic Integration

---

### Story 63.8: A2A Feedback Ingestion for Trust Score

**Points:** 3
**Priority:** Medium
**Blocked by:** Epic 69 Story 69.4 (creates `a2a_task_feedback` table)

**Description:**
Add `a2a_task_feedback` as a reputation signal source alongside ERC-8004, Mnemom, Vouched, and escrow history. Aggregate feedback scores per agent into a new "Service Quality" dimension in the unified trust score calculator.

**Integration:**
- Read from `a2a_task_feedback` table (created in Epic 69.4)
- Calculate per-agent metrics: average satisfaction score, feedback count, rejection rate
- Add "Service Quality" as a 5th dimension with 15% weight
- Redistribute existing weights proportionally: Identity 22%, Payment Reliability 25%, Capability Trust 22%, Community Signal 16%, Service Quality 15%

**Files:**
- New: `apps/api/src/services/reputation/sources/a2a-feedback.ts`
- Modify: `apps/api/src/services/reputation/trust-score-calculator.ts`

**Acceptance Criteria:**
- [ ] New source adapter reads from `a2a_task_feedback` table
- [ ] Calculates: avg score (0-100 mapped to 0-1000), feedback count, rejection rate
- [ ] "Service Quality" dimension added with 15% weight
- [ ] Existing dimension weights redistributed proportionally (total still 100%)
- [ ] Agents with no A2A feedback: dimension excluded, weight redistributed (graceful degradation)
- [ ] Minimum 3 feedback entries required for `confidence: 'medium'` on this dimension
- [ ] Per-tenant weight override still works (can adjust Service Quality weight)

---

## Points Summary

| Phase | Stories | Points |
|-------|---------|--------|
| Phase 1: Core Infrastructure | 63.1–63.4 | 14 |
| Phase 2: Aggregation & UI | 63.6–63.7 | 8 |
| Phase 3: Cross-Epic Integration | 63.8 | 3 |
| **Total** | **7** | **25** |

> **Note:** Story 63.5 (3 pts) moved to Epic 62 as Story 62.11.

---

## Implementation Sequence

```
Phase 1: Core Infrastructure
    63.1 (data model + cache) → can run in parallel:
        ├── 63.2 (ERC-8004)
        ├── 63.3 (Mnemom) ← blocked on Mnemom SDK
        └── 63.4 (Vouched) ← blocked on Vouched SDK
    ↓
Phase 2: Aggregation & UI
    63.6 (calculator, depends on 63.2 + Epic 62 Story 62.11) → 63.7 (dashboard widget)
    ↓
Phase 3: Cross-Epic Integration
    63.8 (A2A feedback ingestion, depends on 63.6 + Epic 69.4)
```

Source integrations 63.2–63.4 can be developed in parallel after the data model lands. 63.3 and 63.4 are blocked on external SDKs.
Escrow history (formerly 63.5) is now Epic 62 Story 62.11 — the calculator (63.6) consumes its output cross-epic.
Story 63.8 requires Epic 69 Story 69.4 to be complete (creates the `a2a_task_feedback` table).

---

## Definition of Done

- [ ] All stories have passing tests (unit + integration)
- [ ] Unified score calculation correct with all four sources
- [ ] Graceful degradation when 1–3 sources unavailable
- [ ] Cache prevents excessive external API calls (<1 req/5min per agent per source)
- [ ] Query latency <200ms (cached path)
- [ ] Policy engine (Epic 18) can reference `min_counterparty_reputation_score` and it works end-to-end
- [ ] No reputation data is written to external sources (read-only)
