# Epic 62: Escrow Orchestration

**Status:** Pending
**Phase:** 5.3 (Agent Contracting)
**Priority:** P0 — Trustless Payment for Agent Contracts
**Estimated Points:** 41
**Stories:** 10 (0 complete)
**Dependencies:** Epic 18 (Agent Wallets), Epic 29 (Workflow Engine), Epic 40 (Circle Sandbox ✅)
**Created:** March 1, 2026

[← Back to Epic List](./README.md)

---

## Executive Summary

Wrap existing on-chain escrow protocols with Sly's enterprise governance layer: authorization, policy enforcement, lifecycle monitoring, audit trails, and settlement to local rails. The escrow smart contract handles trustless fund management. Sly handles everything else.

**Target Protocol — AgentEscrowProtocol:**
- Production smart contract on Base mainnet, purpose-built for AI agent payments
- `agent-escrow-sdk` npm package provides three-call interface: `approveUSDC` → `createEscrow` → `completeEscrow`
- USDC on Base (same L2 and stablecoin as our existing x402 infrastructure)
- Built-in reputation tracking and dispute resolution
- 2.5% protocol fee

**What Sly Adds (Why Not Just Use the SDK Directly):**
1. **Pre-escrow authorization** — policy check + reputation check + balance verify before locking funds
2. **Lifecycle monitoring** — on-chain event listener + polling, full audit trail
3. **Release governance** — human-in-the-loop approval for large releases
4. **Kill switch** — enterprise can freeze any escrow via dashboard
5. **Settlement to local rails** — after escrow release, convert USDC → BRL via Pix or MXN via SPEI through Circle

The settlement integration is the unique differentiator. No other Moltbook governance solution offers last-mile fiat conversion.

---

## SDK Impact Assessment

| Feature/Endpoint | Needs SDK? | Module | Priority | Notes |
|------------------|------------|--------|----------|-------|
| `POST /v1/escrows` | ✅ Yes | `sly.escrows` | P0 | Create governed escrow |
| `GET /v1/escrows` | ✅ Yes | `sly.escrows` | P0 | List escrows |
| `GET /v1/escrows/:id` | ✅ Yes | `sly.escrows` | P0 | Get escrow + events |
| `POST /v1/escrows/:id/release` | ✅ Yes | `sly.escrows` | P0 | Request release |
| `POST /v1/escrows/:id/freeze` | ✅ Yes | `sly.escrows` | P0 | Emergency freeze |
| `POST /v1/escrows/:id/settle` | ✅ Yes | `sly.escrows` | P1 | Settle to local rail |
| Dashboard escrow pages | ❌ No | - | - | Frontend only |

**SDK Stories Required:**
- Story 62.9: Add `escrows` module to @sly/sdk

---

## Architecture

### Governance Layer

```
Agent wants to create escrow for contract on Moltbook
    │
    ▼
┌──────────────────────────────────┐
│  Pre-Escrow Authorization (62.3) │
│  1. Wallet policy allows escrow  │ ◄── Epic 18 policy engine
│     with this counterparty?      │
│  2. Counterparty reputation      │ ◄── Epic 63 reputation bridge
│     meets minimum?               │
│  3. Wallet has sufficient USDC?  │
│  4. Amount above approval        │
│     threshold?                   │
│     YES → trigger workflow (E29) │
│     NO → proceed                 │
└──────────┬───────────────────────┘
           │ authorized
           ▼
┌──────────────────────────────────┐
│  AgentEscrowProtocol on Base     │
│  approveUSDC() → createEscrow() │ ◄── On-chain USDC lock
└──────────┬───────────────────────┘
           │ escrow created
           ▼
┌──────────────────────────────────┐
│  Lifecycle Monitor (62.4)        │
│  - Chain event listener          │
│  - 30s polling fallback          │
│  - All transitions → escrow_events│
└──────────┬───────────────────────┘
           │ work complete, release requested
           ▼
┌──────────────────────────────────┐
│  Release Governance (62.5)       │
│  - Policy check: auto-release?   │
│  - If above threshold → E29      │
│    workflow approval              │
│  - completeEscrow() on-chain     │
└──────────┬───────────────────────┘
           │ USDC released
           ▼
┌──────────────────────────────────┐
│  Settlement (62.7, optional)     │
│  USDC → BRL via Pix             │ ◄── Circle direct integration
│  USDC → MXN via SPEI            │
└──────────────────────────────────┘
```

### Escrow State Machine

```
created ──► in_progress ──► pending_verification ──► released
   │             │                    │
   │             │                    ├──► disputed
   │             │                    │
   ▼             ▼                    ▼
expired       frozen              frozen
```

- `created` — USDC locked in smart contract
- `in_progress` — provider working on deliverable
- `pending_verification` — work reported complete, awaiting verification
- `released` — USDC transferred to provider (minus 2.5% protocol fee)
- `disputed` — issue raised, protocol dispute mechanism active
- `expired` — deadline passed without completion
- `frozen` — Sly governance freeze (kill switch)

### Existing Infrastructure Reused

| Component | Location | Reuse |
|-----------|----------|-------|
| Circle wallet operations | `apps/api/src/services/circle/` (Epic 40) | USDC balance, approvals |
| Policy engine | Epic 18 `contract-policy-engine.ts` | Pre-escrow authorization |
| Workflow trigger | Epic 29 `POST /v1/workflows/instances` | Release approval |
| Reputation bridge | Epic 63 | Counterparty reputation check |
| Base chain config | `apps/api/src/config/chains.ts` | RPC endpoints, contract addresses |
| Settlement service | `apps/api/src/services/settlement/` | Pix/SPEI conversion via Circle |
| Agent wallet | Epic 18 `agent-wallets.ts` | Wallet lookup, balance check |

---

## Stories

### Phase 1: Foundation

---

### Story 62.1: Escrow Data Model & Base API

**Points:** 5
**Priority:** P0

**Description:**
Create database tables for escrow contracts, escrow events (lifecycle audit), and escrow policies. Implement base CRUD endpoints.

**Tables:**
- `escrow_contracts` — each escrow agreement (tenant_id, agent_wallet_id, counterparty_address, amount_usdc, deadline, on_chain_escrow_id, on_chain_tx_hash, status, protocol, contract_terms JSONB)
- `escrow_events` — full lifecycle audit (escrow_id, event_type, actor, on_chain_tx_hash, metadata JSONB, timestamp)
- `escrow_policies` — tenant-level governance rules (max_escrow_amount, max_concurrent_escrows, auto_release_threshold, default_deadline_hours, protocol_preference)

**Files:**
- New: `apps/api/supabase/migrations/XXX_escrow_orchestration.sql`
- New: `apps/api/src/routes/escrows.ts`
- New: `apps/api/src/types/escrows.ts`
- New: `apps/api/src/schemas/escrow.schema.ts`
- Modify: `apps/api/src/app.ts` (mount routes)

**Acceptance Criteria:**
- [ ] Migration runs without errors
- [ ] RLS policies enforce tenant isolation
- [ ] CRUD endpoints: POST /v1/escrows, GET /v1/escrows, GET /v1/escrows/:id
- [ ] GET /:id includes escrow_events timeline
- [ ] Zod validation on all inputs
- [ ] Indexes on tenant_id, agent_wallet_id, status, counterparty_address

---

### Story 62.2: AgentEscrowProtocol SDK Integration

**Points:** 5
**Priority:** P0

**Description:**
Wrap `agent-escrow-sdk` npm package with Sly's service layer. The wrapper handles wallet key management, transaction signing, and maps on-chain events to Sly's data model.

**Implementation:**
```typescript
class EscrowProtocolService {
  async approveUSDC(walletId: string, amount: number): Promise<TxHash>;
  async createEscrow(walletId: string, params: CreateEscrowParams): Promise<OnChainEscrow>;
  async completeEscrow(walletId: string, escrowId: string): Promise<TxHash>;
  async getEscrowStatus(escrowId: string): Promise<OnChainEscrowStatus>;
}
```

**Files:**
- New: `apps/api/src/services/escrow/protocol-service.ts`
- New: `apps/api/src/services/escrow/types.ts`

**Acceptance Criteria:**
- [ ] Wraps all three `agent-escrow-sdk` calls: approveUSDC, createEscrow, completeEscrow
- [ ] Uses agent's Circle Programmable Wallet for signing
- [ ] Maps on-chain escrow ID to Sly escrow_contracts record
- [ ] Stores transaction hashes for every on-chain operation
- [ ] Supports Base mainnet and Base Sepolia (configurable)
- [ ] Graceful error handling for insufficient balance, failed transactions, timeout

---

### Story 62.3: Pre-Escrow Authorization Service

**Points:** 5
**Priority:** P0

**Description:**
Authorization layer that runs before any escrow creation. Validates policy, reputation, and balance.

**Files:**
- New: `apps/api/src/services/escrow/authorization.ts`

**Acceptance Criteria:**
- [ ] Calls Epic 18 policy engine with `action_type='escrow_create'`
- [ ] Validates counterparty reputation via Epic 63 (minimum score from escrow policy)
- [ ] Verifies wallet has sufficient USDC balance (amount + estimated gas)
- [ ] Checks max_concurrent_escrows limit
- [ ] If amount > approval threshold → triggers Epic 29 workflow, returns 202
- [ ] If policy denies → returns 403 with reason
- [ ] If authorized → proceeds to Story 62.2 on-chain creation
- [ ] Logs authorization decision to `policy_evaluations` table

---

### Story 62.4: Escrow Lifecycle Monitor

**Points:** 5
**Priority:** P0

**Description:**
Monitor on-chain escrow state changes and record them in the Sly audit trail.

**Implementation:**
- Primary: WebSocket/event listener on Base chain for AgentEscrowProtocol contract events
- Fallback: Poll contract state every 30 seconds for active escrows
- All state transitions recorded as `escrow_events`

**Files:**
- New: `apps/api/src/services/escrow/lifecycle-monitor.ts`
- New: `apps/api/src/workers/escrow-monitor.ts`

**Acceptance Criteria:**
- [ ] Detects on-chain events: EscrowCreated, EscrowCompleted, EscrowDisputed, EscrowExpired
- [ ] Creates `escrow_events` record for every state change
- [ ] Updates `escrow_contracts.status` to match on-chain state
- [ ] Polling fallback runs every 30 seconds for active escrows
- [ ] Handles chain reorgs gracefully (confirm after N blocks)
- [ ] Worker restarts cleanly without missing events

---

### Story 62.5: Escrow Release Governance

**Points:** 3
**Priority:** P0

**Description:**
When release is requested, validate authorization before calling `completeEscrow` on-chain.

**Files:**
- Modify: `apps/api/src/routes/escrows.ts`
- Modify: `apps/api/src/services/escrow/authorization.ts`

**Acceptance Criteria:**
- [ ] `POST /v1/escrows/:id/release` validates agent is authorized to release
- [ ] Agent must not be suspended, wallet must not be frozen
- [ ] If amount > `auto_release_threshold` → triggers Epic 29 workflow approval
- [ ] On approval, executes `completeEscrow()` on-chain via Story 62.2
- [ ] Logs release event to `escrow_events`
- [ ] Returns release transaction hash on success

---

### Story 62.6: Kill Switch & Emergency Freeze

**Points:** 3
**Priority:** P0

**Description:**
Enterprise can freeze any escrow via dashboard or API, preventing release even if agent attempts it.

**Files:**
- Modify: `apps/api/src/routes/escrows.ts`

**Acceptance Criteria:**
- [ ] `POST /v1/escrows/:id/freeze` sets status to `frozen`
- [ ] Frozen escrow blocks all release attempts (403)
- [ ] If protocol supports on-chain dispute/freeze, Sly triggers it
- [ ] Freeze event recorded in `escrow_events` with actor
- [ ] Unfreeze endpoint: `POST /v1/escrows/:id/unfreeze` (owner/admin only)
- [ ] Dashboard freeze button with confirmation modal

---

### Phase 2: Settlement & UI

---

### Story 62.7: Escrow-to-Local-Rail Settlement

**Points:** 5
**Priority:** P1

**Description:**
After escrow release, optionally settle USDC to local banking rails via Circle. This is Sly's unique differentiator — no other Moltbook governance solution offers last-mile fiat conversion.

**Flows:**
- USDC on Base → BRL via Pix (Circle direct integration)
- USDC on Base → MXN via SPEI (Circle direct integration)
- USDC on Base → USD via wire (Circle standard)

**Files:**
- New: `apps/api/src/services/escrow/settlement.ts`
- Modify: `apps/api/src/routes/escrows.ts`

**Acceptance Criteria:**
- [ ] `POST /v1/escrows/:id/settle` triggers conversion after release
- [ ] Supports Pix (BRL), SPEI (MXN), wire (USD) settlement
- [ ] Uses existing Circle settlement infrastructure
- [ ] Settlement status tracked in `escrow_events`
- [ ] Automatic settlement configurable per tenant policy (opt-in)
- [ ] Settlement fees transparent in response

---

### Story 62.8: Escrow Dashboard UI

**Points:** 4
**Priority:** P1

**Description:**
Dashboard page for viewing and managing escrows.

**Files:**
- New: `apps/web/src/app/dashboard/escrows/page.tsx`
- New: `apps/web/src/app/dashboard/escrows/[id]/page.tsx`
- New: `apps/web/src/components/escrows/EscrowTimeline.tsx`

**Acceptance Criteria:**
- [ ] List page: active escrows with status badges, amount, counterparty, deadline
- [ ] Filters: status, agent, date range
- [ ] Detail page: escrow info, event timeline (visual), counterparty info
- [ ] Freeze/unfreeze button with confirmation
- [ ] Release button (triggers governance flow)
- [ ] Settlement status visible when applicable

---

### Story 62.9: Escrow SDK Methods

**Points:** 3
**Priority:** P1

**Description:**
SDK methods for escrow operations.

**Methods:**
```typescript
sly.escrows = {
  create: (input: CreateEscrowInput) => Escrow,
  get: (escrowId: string) => Escrow,
  list: (params?: EscrowListParams) => PaginatedEscrows,
  release: (escrowId: string) => ReleaseResult,
  freeze: (escrowId: string) => void,
  settle: (escrowId: string, rail: SettlementRail) => SettlementResult,
};
```

**Files:**
- Modify: `packages/api-client/src/types.ts`
- Modify: `packages/api-client/src/client.ts`

**Acceptance Criteria:**
- [ ] All methods match API endpoints
- [ ] Types match API response shapes
- [ ] `pnpm build` passes

---

### Phase 3: Cross-Epic Integration

---

### Story 62.10: Escrow Outcome Reputation Signals

**Points:** 3
**Priority:** Medium

**Description:**
When an escrow reaches a terminal state (released, disputed, expired), emit a structured reputation event to the `escrow_events` table with `reputation_relevant: true`. This is the "write side" that Epic 63 Story 63.5 reads from — making the implicit link between escrow outcomes and reputation scoring explicit.

**Event payload:**
```json
{
  "event_type": "escrow_terminal",
  "reputation_relevant": true,
  "outcome": "released | disputed | expired",
  "counterparty_ids": { "depositor": "agent_id", "beneficiary": "agent_id" },
  "amount_usdc": 500.00,
  "duration_seconds": 86400,
  "dispute_reason": null
}
```

**Files:**
- Modify: `apps/api/src/services/escrow/lifecycle-monitor.ts`
- Modify: `apps/api/src/services/escrow/protocol-service.ts`

**Acceptance Criteria:**
- [ ] Terminal state events (released, disputed, expired) include `reputation_relevant: true`
- [ ] Event metadata includes outcome, counterparty IDs, amount, duration
- [ ] Disputed escrows include `dispute_reason` if available
- [ ] Epic 63 Story 63.5 can query `escrow_events WHERE reputation_relevant = true`
- [ ] No new tables — extends existing `escrow_events` with metadata fields
- [ ] Frozen → released transitions also emit reputation event

---

## Points Summary

| Phase | Stories | Points |
|-------|---------|--------|
| Phase 1: Foundation | 62.1–62.6 | 26 |
| Phase 2: Settlement & UI | 62.7–62.9 | 12 |
| Phase 3: Cross-Epic Integration | 62.10 | 3 |
| **Total** | **10** | **41** |

---

## Implementation Sequence

```
Phase 1: Foundation (62.1-62.6)
    62.1 (data model) → 62.2 (SDK wrap) → 62.3 (authorization) → can run in parallel:
                                              ├── 62.4 (lifecycle monitor)
                                              ├── 62.5 (release governance)
                                              └── 62.6 (kill switch)
    ↓
Phase 2: Settlement & UI (62.7-62.9)    ← Depends on Phase 1
    ↓
Phase 3: Cross-Epic Integration (62.10)  ← Depends on 62.4 (lifecycle monitor)
```

---

## Definition of Done

- [ ] All stories have passing tests (unit + integration)
- [ ] No cross-tenant data leaks (RLS verified)
- [ ] Every escrow lifecycle event captured in audit trail
- [ ] Kill switch blocks releases within 1 second
- [ ] On-chain state and Sly state never diverge (monitor catches up within 30s)
- [ ] Settlement to Pix/SPEI demonstrated end-to-end
- [ ] Escrow creation impossible without policy authorization
