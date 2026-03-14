# Epic 18: Agent Wallets & Contract Policies

**Status:** Complete
**Phase:** 5.2 (Agent Governance)
**Priority:** P0 — Foundation for All Agent Contracting
**Estimated Points:** 35
**Stories:** 9 (9 complete)
**Completed:** 2026-03-14
**Dependencies:** Epic 3 (Agent System & KYA ✅), Epic 40 (Circle Sandbox ✅)
**Created:** March 1, 2026

[← Back to Epic List](./README.md)

---

## Executive Summary

Build the agent wallet system that enables AI agents to operate autonomously within policy-defined bounds. Originally specced in PRD v1.7 for x402 payment execution (23 pts, 6 stories), this epic is expanded to **35 points across 9 stories** to support agent-to-agent contracting governance.

Each agent receives a dedicated Circle Programmable Wallet with a configurable policy document governing what contracts the agent can enter, with whom, and at what value. The policy engine is consulted before every payment, escrow creation, or contract commitment.

**What's new for contracting (Stories 18.7–18.9):**
1. **Contract Policy Engine** — evaluates any proposed action against wallet policy (contract-type restrictions, counterparty requirements, value limits, reputation gating)
2. **Per-Counterparty Exposure Tracking** — rolling 24h/7d/30d exposure windows per counterparty, not just aggregate limits
3. **Negotiation Guardrails API** — real-time policy validation during A2A negotiation, before the agent commits to terms

**Key Design Decision — Policies are Data, Not Code:**
Policy documents are JSONB validated by Zod schemas, not hard-coded conditionals. This means enterprises configure policies via API/dashboard without code changes. Wallet policies can only narrow agent limits from Epic 3 (effective limits are always the ceiling).

---

## SDK Impact Assessment

| Feature/Endpoint | Needs SDK? | Module | Priority | Notes |
|------------------|------------|--------|----------|-------|
| `POST /v1/agents/:id/wallet` | ✅ Yes | `sly.agents.wallet` | P0 | Create wallet |
| `GET /v1/agents/:id/wallet` | ✅ Yes | `sly.agents.wallet` | P0 | Get wallet + balance |
| `POST /v1/agents/:id/wallet/pay` | ✅ Yes | `sly.agents.wallet` | P0 | Execute payment |
| `PUT /v1/agents/:id/wallet/policy` | ✅ Yes | `sly.agents.wallet` | P0 | Update policy |
| `POST /v1/agents/:id/wallet/policy/evaluate` | ✅ Yes | `sly.agents.wallet` | P0 | Dry-run policy check |
| `GET /v1/agents/:id/wallet/exposure` | ✅ Yes | `sly.agents.wallet` | P1 | Counterparty exposure |
| `POST /v1/agents/:id/wallet/freeze` | ✅ Yes | `sly.agents.wallet` | P0 | Emergency freeze |
| Dashboard wallet pages | ❌ No | - | - | Frontend only |

**SDK Stories Required:**
- Story 18.6: Add `agents.wallet` module to @sly/sdk

---

## Architecture

### Policy Evaluation Flow

```
Agent Action Request (pay, escrow, contract)
    │
    ▼
┌─────────────────────────┐
│  Contract Policy Engine  │ ◄── Cached policy doc (60s TTL)
│       (Story 18.7)       │
├─────────────────────────┤
│ 1. Contract type allowed?│
│ 2. Counterparty on       │
│    blocklist?            │
│ 3. Counterparty KYA tier │
│    meets minimum?        │
│ 4. Counterparty reputation│
│    meets minimum? (E63)  │
│ 5. Amount within limits? │
│ 6. Exposure within daily │
│    cap? (Story 18.8)     │
│ 7. Concurrent contracts  │
│    under max?            │
└────────┬────────────────┘
         │
    ┌────┴────┐
    ▼         ▼         ▼
 APPROVE   ESCALATE    DENY
 (< auto)  (between)  (> max or blocked)
    │         │         │
    ▼         ▼         ▼
 Execute   Workflow    Return
 payment   instance   403 +
           (E29)      reason
```

### Existing Infrastructure Reused

| Component | Location | Reuse |
|-----------|----------|-------|
| Agent CRUD | `apps/api/src/routes/agents.ts` | Agent lookup, effective limits |
| Agent effective limits | `computeEffectiveLimits()` in Epic 3 | Ceiling for wallet policy |
| Circle wallet provisioning | `apps/api/src/services/circle/` (Epic 40) | Wallet creation |
| Wallet balance sync | `apps/api/src/routes/wallets.ts` | Balance queries |
| Webhook infrastructure | `apps/api/src/services/webhooks/` (Epic 17) | Notification on policy events |
| Workflow trigger | Epic 29 `POST /v1/workflows/instances` | Escalation path |
| Reputation query | Epic 63 `query_reputation()` | Counterparty reputation check |

---

## Stories

### Phase 1: Core Wallet Infrastructure

---

### Story 18.1: Agent Wallet Database Schema

**Points:** 3
**Priority:** P0

**Description:**
Create database tables for agent wallets, contract policies, counterparty exposures, and policy evaluation audit log.

**Tables:**
- `agent_wallets` — one per agent, links to Circle Programmable Wallet (circle_wallet_id, wallet_address, balance_usdc, network, status)
- `agent_wallet_policies` — JSONB policy per wallet (allowed_contract_types, counterparty requirements, value limits, approval thresholds, protocol restrictions)
- `counterparty_exposures` — rolling exposure per counterparty (24h/7d/30d windows, active/completed/disputed contract counts)
- `policy_evaluations` — audit log of every policy check (action_type, counterparty, amount, decision, reason, rules triggered)

**Files:**
- New: `apps/api/supabase/migrations/XXX_agent_wallets.sql`

**Acceptance Criteria:**
- [ ] Migration runs without errors
- [ ] RLS policies enforce tenant isolation on all four tables
- [ ] `agent_wallets` has UNIQUE constraint on `agent_id` (one wallet per agent)
- [ ] `counterparty_exposures` has unique indexes on (wallet_id, counterparty_agent_id) and (wallet_id, counterparty_address)
- [ ] Indexes on wallet_id, agent_id, tenant_id across all tables
- [ ] `updated_at` triggers on mutable tables

---

### Story 18.2: Agent Wallet CRUD API

**Points:** 5
**Priority:** P0

**Description:**
Implement wallet creation, retrieval, and management. Wallet creation provisions a Circle Programmable Wallet and records the on-chain address.

**Endpoints:**
- `POST /v1/agents/:id/wallet` — create wallet (provisions Circle wallet)
- `GET /v1/agents/:id/wallet` — get wallet with current USDC balance
- `PATCH /v1/agents/:id/wallet` — update config (funding_source, status)
- `POST /v1/agents/:id/wallet/freeze` — emergency freeze

**Files:**
- New: `apps/api/src/routes/agent-wallets.ts`
- New: `apps/api/src/services/agent-wallet.service.ts`
- Modify: `apps/api/src/app.ts` (mount routes)

**Acceptance Criteria:**
- [ ] POST creates Circle wallet via existing Circle integration (Epic 40)
- [ ] Stores `circle_wallet_id` and `wallet_address`
- [ ] GET returns wallet with current USDC balance (synced from chain, 30s cache)
- [ ] PATCH updates `funding_source` and `status`
- [ ] POST /freeze sets status to `frozen` and blocks all operations
- [ ] Cannot create multiple wallets per agent (409 Conflict)
- [ ] All operations filter by tenant_id

---

### Story 18.3: Agent Payment Execution API

**Points:** 5
**Priority:** P0

**Description:**
Execute payments from agent wallet with mandatory policy check before execution. Every payment runs through the Contract Policy Engine (Story 18.7).

**Files:**
- Modify: `apps/api/src/routes/agent-wallets.ts`
- New: `apps/api/src/services/agent-payment.service.ts`

**Acceptance Criteria:**
- [ ] `POST /v1/agents/:id/wallet/pay` runs policy evaluation before execution
- [ ] If policy returns `deny` → 403 with reason and triggered rules
- [ ] If policy returns `escalate` → creates workflow instance (Epic 29) and returns 202 with `workflow_instance_id`
- [ ] If policy returns `approve` → executes payment via appropriate protocol
- [ ] Updates `counterparty_exposures` after successful payment
- [ ] Logs `policy_evaluations` for every attempt (approve, deny, or escalate)
- [ ] Supports payment types: `x402`, `direct_transfer`, `escrow_fund`

---

### Story 18.7: Contract Policy Engine

**Points:** 5
**Priority:** P0

**Description:**
Core policy evaluation engine — the central governance decision point. Called by payment execution (18.3), escrow creation (Epic 62), and negotiation guardrails (18.9).

**Implementation:**
```typescript
evaluatePolicy(request: PolicyEvaluationRequest): PolicyEvaluationResult

interface PolicyEvaluationRequest {
  wallet_id: string;
  action_type: 'payment' | 'escrow_create' | 'escrow_release' | 'contract_accept' | 'negotiation_check';
  counterparty_id: string;
  amount: number;
  contract_type?: string;
  protocol?: string;
}

interface PolicyEvaluationResult {
  decision: 'approve' | 'deny' | 'escalate';
  reason: string;
  rules_triggered: string[];
  counterparty_reputation_score?: number;
  current_exposure?: number;
  suggested_counter_offer?: { max_amount: number };
  workflow_instance_id?: string;
}
```

**Files:**
- New: `apps/api/src/services/contract-policy-engine.ts`
- New: `apps/api/src/schemas/contract-policy.schema.ts`
- New: `apps/api/src/cache/policy-cache.ts`

**Acceptance Criteria:**
- [ ] Checks contract_type against allowed/blocked lists
- [ ] Checks counterparty against allowlist/blocklist
- [ ] Checks counterparty KYA tier (local agents via Epic 3)
- [ ] Checks counterparty reputation score (external agents via Epic 63, graceful fallback if unavailable)
- [ ] Checks amount against per-contract, per-counterparty-daily, and aggregate-daily limits
- [ ] Checks concurrent contract/escrow counts
- [ ] Determines decision: approve (below `auto_approve_below`), escalate (between thresholds), deny (above limits or blocked)
- [ ] Returns all triggered rules in response for transparency
- [ ] Policy documents cached in memory with 60s TTL
- [ ] Evaluation completes in <50ms (cached policy path)
- [ ] Zod schema validates policy documents on write

---

### Story 18.8: Per-Counterparty Exposure Tracking

**Points:** 4
**Priority:** P0

**Description:**
Track rolling exposure windows per counterparty. Updated on every payment, escrow creation, and contract completion. Queried by the policy engine on every evaluation.

**Files:**
- New: `apps/api/src/services/counterparty-exposure.service.ts`

**Acceptance Criteria:**
- [ ] Upsert exposure on payment/escrow (increment rolling windows)
- [ ] Decrement on contract completion/escrow release
- [ ] Rolling windows: 24h, 7d, 30d calculated from transaction timestamps
- [ ] Track active_contracts, completed_contracts, disputed_contracts counts
- [ ] Support dual identification: `counterparty_agent_id` (Sly agents) OR `counterparty_address` (external)
- [ ] GET `/v1/agents/:id/wallet/exposure` returns all counterparty exposures
- [ ] GET `/v1/agents/:id/wallet/exposure/:counterpartyId` returns specific exposure
- [ ] Materialized view for aggregate exposure per wallet (refreshed every 60s)

---

### Phase 2: Governance Integration

---

### Story 18.4: Payment Approval Workflow Integration

**Points:** 3
**Priority:** P1

**Description:**
When policy evaluation returns `escalate`, create a workflow instance in Epic 29 and hold the payment until approved or rejected.

**Files:**
- New: `apps/api/src/services/workflow-integration.ts`
- Modify: `apps/api/src/services/agent-payment.service.ts`

**Acceptance Criteria:**
- [ ] Escalation creates `workflow_instance` with contract details as `trigger_data`
- [ ] Workflow template configurable per tenant (default: single manager approval)
- [ ] On approval, resumes payment execution automatically
- [ ] On rejection, marks payment as rejected with reason
- [ ] Timeout follows workflow template settings (default 24h)
- [ ] Agent receives structured response with workflow status and pending URL

---

### Story 18.9: Negotiation Guardrails API

**Points:** 3
**Priority:** P1

**Description:**
Real-time policy validation endpoint called during A2A negotiation. When an agent is negotiating terms on Moltbook or via A2A task exchange, this endpoint validates proposed terms before the agent commits.

**Files:**
- Modify: `apps/api/src/routes/agent-wallets.ts`
- New: `apps/api/src/services/negotiation-guardrails.service.ts`

**Acceptance Criteria:**
- [ ] `POST /v1/agents/:id/wallet/policy/evaluate` with `action_type='negotiation_check'`
- [ ] Accepts proposed terms: counterparty, amount, contract_type, duration
- [ ] Returns approve/deny/escalate with specific constraint violations
- [ ] If deny, returns maximum acceptable values (e.g. `"max_amount": 500` for this counterparty)
- [ ] Response includes `suggested_counter_offer` with policy-compliant alternatives
- [ ] Latency <100ms including network round-trip (policy cached)
- [ ] Integrates with Epic 57 A2A task processor for automated negotiation flows

---

### Phase 3: UI & SDK

---

### Story 18.5: Agent Wallet Dashboard

**Points:** 4
**Priority:** P1

**Description:**
Dashboard UI for managing agent wallets, viewing balances, and configuring policies.

**Files:**
- New: `apps/web/src/app/dashboard/agents/[id]/wallet/page.tsx`
- New: `apps/web/src/components/agents/WalletOverview.tsx`
- New: `apps/web/src/components/agents/PolicyConfigForm.tsx`
- New: `apps/web/src/components/agents/ExposureTable.tsx`

**Acceptance Criteria:**
- [ ] Wallet overview card on Agent detail page showing balance, status, network
- [ ] Policy configuration form with all policy fields
- [ ] Counterparty exposure table with sortable columns
- [ ] Policy evaluation log with filters (decision, action_type, date range)
- [ ] Freeze/unfreeze button with confirmation modal
- [ ] Visual indicator when wallet is frozen

---

### Story 18.6: Agent Wallet SDK Methods

**Points:** 3
**Priority:** P1

**Description:**
SDK methods for wallet operations, policy checks, and payment execution.

**Methods:**
```typescript
sly.agents.wallet = {
  get: (agentId: string) => AgentWallet,
  pay: (agentId: string, input: PayInput) => PaymentResult,
  evaluatePolicy: (agentId: string, request: PolicyEvaluationRequest) => PolicyEvaluationResult,
  getExposure: (agentId: string, counterpartyId?: string) => ExposureResult,
  freeze: (agentId: string) => void,
  updatePolicy: (agentId: string, policy: ContractPolicy) => ContractPolicy,
};
```

**Files:**
- Modify: `packages/api-client/src/types.ts`
- Modify: `packages/api-client/src/client.ts`

**Acceptance Criteria:**
- [ ] All methods match API endpoints
- [ ] Types match API response shapes
- [ ] `pnpm build` passes
- [ ] All methods return structured responses (Epic 30 format)

---

## Points Summary

| Phase | Stories | Points |
|-------|---------|--------|
| Phase 1: Core Wallet Infrastructure | 18.1–18.3, 18.7, 18.8 | 22 |
| Phase 2: Governance Integration | 18.4, 18.9 | 6 |
| Phase 3: UI & SDK | 18.5, 18.6 | 7 |
| **Total** | **9** | **35** |

---

## Definition of Done

- [ ] All stories have passing tests (unit + integration)
- [ ] No cross-tenant data leaks (RLS verified)
- [ ] Policy evaluation audit log captures every decision
- [ ] Policy engine evaluates in <50ms (cached path)
- [ ] Emergency freeze blocks all wallet operations immediately
- [ ] Wallet policies cannot exceed agent effective limits from Epic 3
- [ ] SDK methods documented with usage examples
