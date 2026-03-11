# Epic 38: High-Frequency Microtransaction Optimization

**Status:** P1 — Active Development
**Phase:** Performance & Scale
**Priority:** P1
**Total Points:** 63
**Stories:** 18 (across 5 phases)
**Dependencies:** Epic 26 (x402 Performance - Phase 3 folded in), Epic 50 (Settlement Decoupling - complete), Epic 57 (A2A Protocol - complete)
**Enables:** Sub-100ms authorization latency, multi-chain support, gasless transactions, deferred batch settlement

[<- Back to Epic List](./README.md)

---

## Executive Summary

A2A and x402 are our primary agent-to-agent payment rails, but current settlement is synchronous and slow. The Circle polling loop blocks responses for up to 30 seconds, and we only support Base chain. For a busy agentic marketplace with high-frequency microtransactions ($0.01-$1.00), we need sub-100ms authorization latency, multi-chain support (Solana + Base), gasless transactions, and deferred batch settlement.

---

## Current Bottlenecks

- `executeOnChainTransfer()` polls Circle every 2s for up to 30s, blocking the response
- Single chain (Base only) despite Circle supporting Solana, Polygon, etc.
- No Gas Station -- external wallets need native tokens for gas
- Per-transaction on-chain settlement -- no batching for micro-payments
- No deferred settlement -- all payments block on on-chain confirmation

## Reusable Infrastructure

- Circle client already defines `SOL/SOL-DEVNET` in types (`services/circle/types.ts`)
- Wallet schema already supports `blockchain: 'sol'` (`routes/wallets.ts:65`)
- Settlement router already has multi-rail routing + batch ops (`settlement-router.ts`)
- Settlement triggers engine (Epic 50) supports immediate/threshold/schedule/manual
- `settle_x402_payment` RPC is atomic and fast (<50ms) for ledger-only settlement

## Multi-Chain Policy

Agents choose their chain at wallet creation time. No forced default -- the wallet creation API already accepts `blockchain` param.

---

## Phase 1: Async Settlement Worker (8 pts, ~1 sprint)

*Biggest quick win -- decouples response from on-chain settlement. Subsumes Epic 26 Phase 3.*

### Story 38.1: x402 Async Settlement (5 pts)

Return payment response after fast ledger authorization; settle on-chain asynchronously.

**Files to modify:**
- `apps/api/src/services/wallet-settlement.ts` -- Add `authorizeWalletTransfer()` that does ledger debit/credit only (the `.gte()` guard path), returns in <50ms
- `apps/api/src/routes/x402-payments.ts` -- After ledger settlement, return response immediately. Enqueue on-chain settlement task instead of blocking on `executeOnChainTransfer()`
- **New:** `apps/api/src/workers/x402-settlement-worker.ts` -- Polls `transfers` with `status='authorized'`, executes on-chain via `executeOnChainTransfer()`, updates to `completed`

**New transfer status:** `authorized` (ledger settled, on-chain pending)
**Latency impact:** ~2-30s down to ~50-200ms per payment

### Story 38.2: A2A Async Settlement (3 pts)

Same async pattern for A2A payments.

**Files to modify:**
- `apps/api/src/services/a2a/payment-handler.ts` -- Use `authorizeWalletTransfer()` instead of `settleWalletTransfer()`

---

## Phase 2: Solana Chain Activation (13 pts, ~1.5 sprints)

*Second chain for faster finality (100-150ms vs 200ms on Base)*

### Story 38.3: Solana Chain Configuration (3 pts)

- `apps/api/src/config/blockchain.ts` -- Add Solana to `CHAIN_CONFIGS` (devnet + mainnet)
- **New:** `apps/api/src/config/solana.ts` -- `@solana/web3.js` client, SPL Token balance/transfer functions
- `apps/api/src/services/wallet-settlement.ts` -- Add Solana branch to `executeOnChainTransfer()`

**New deps:** `@solana/web3.js`, `@solana/spl-token`

### Story 38.4: Circle Wallet Creation on Solana (3 pts)

- `apps/api/src/services/circle/index.ts` -- Ensure `createWallet()` correctly handles SOL/SOL-DEVNET based on environment
- `apps/api/src/routes/wallets.ts` -- Verify `blockchain: 'sol'` flows through correctly (types already support it)

### Story 38.5: Settlement Router Chain Awareness (5 pts)

- `apps/api/src/services/settlement-router.ts` -- Add `solana_chain` rail, chain-aware routing (Solana wallets prefer Solana rail)
- `apps/api/src/services/wallet-settlement.ts` -- Update `isOnChainCapable()` to check wallet `blockchain` field
- **Migration:** `20260310_solana_rail.sql`

### Story 38.6: Solana Balance Sync (2 pts)

- `apps/api/src/routes/wallets.ts` -- Add Solana path to `/sync` endpoint using `getSolanaUsdcBalance()`

---

## Phase 3: Circle Gas Station (8 pts, ~1 sprint)

*Gasless transactions -- agents don't need native tokens. Can run in parallel with Phase 2.*

### Story 38.7: Gas Station API Integration (3 pts)

- `apps/api/src/services/circle/client.ts` -- Add `getGasStationConfig()`, `updateGasStationConfig()`, `getGasStationStatus()`
- `apps/api/src/services/circle/types.ts` -- Add `GasStationConfig` interface

### Story 38.8: Gas Station Activation & Monitoring (3 pts)

- `apps/api/src/config/environment.ts` -- Add `circleGasStation` feature flag
- `apps/api/src/routes/wallets.ts` -- Add Gas Station status/configure endpoints

### Story 38.9: Gas Station Health Alerts (2 pts)

- `apps/api/src/services/circle/index.ts` -- Add `checkGasStationHealth()` to service interface
- `apps/api/src/app.ts` -- Include Gas Station balance in `/health` response

---

## Phase 4: Deferred Net Settlement (21 pts, ~2-3 sprints)

*Sub-100ms authorization for micro-payments via signed intents + batch settlement. Depends on Phase 1.*

### Story 38.10: Payment Intent Schema (3 pts)

- **New:** `apps/api/src/services/payment-intent.ts` -- `PaymentIntent` type, `createPaymentIntent()`, `authorizePaymentIntent()` (<10ms ledger operation)
- **Migration:** `20260315_payment_intents.sql` -- `payment_intents` table with nonce uniqueness, batch tracking

### Story 38.11: Net Position Tracker (5 pts)

- **New:** `apps/api/src/services/net-position.ts` -- In-memory tracker with DB persistence: `recordIntent()`, `getNetPosition()`, `clearPositions()`
- **New:** `apps/api/src/services/settlement-batcher.ts` -- `createBatch()` computes net positions, `executeBatch()` settles net amounts on-chain

Example: 1000 micro-payments between agents A and B net to a single $3 on-chain transfer.

### Story 38.12: x402 Intent-Based Micro-payments (5 pts)

- `apps/api/src/routes/x402-payments.ts` -- For payments below `deferred_threshold_amount` (e.g. $1.00), create `PaymentIntent` instead of `Transfer`. Returns `settlementMode: 'deferred'`
- `apps/api/src/services/settlement.ts` -- Add `deferredThresholdAmount` to `SettlementConfig`

### Story 38.13: A2A Intent-Based Micro-payments (3 pts)

- `apps/api/src/services/a2a/payment-handler.ts` -- Add `settleViaIntent()` for micro-payment A2A tasks

### Story 38.14: Batch Settlement Worker (5 pts)

- **New:** `apps/api/src/workers/batch-settlement-worker.ts` -- Runs on configurable schedule (default 60s), computes net positions per tenant, executes on-chain transfers for net amounts, marks intents as settled

---

## Phase 5: CCTP Cross-Chain & Metrics (13 pts, ~2 sprints)

*Cross-chain USDC movement + performance observability. Depends on Phase 2.*

### Story 38.15: CCTP Bridge Service (5 pts)

- **New:** `apps/api/src/services/cctp/bridge.ts` -- `burnUsdc()`, `mintUsdc()`, `getTransferStatus()` for Base <-> Solana USDC movement
- `apps/api/src/services/settlement-router.ts` -- Add `cctp_bridge` rail

### Story 38.16: Cross-Chain Wallet Routing (3 pts)

- `apps/api/src/services/wallet-settlement.ts` -- Auto-detect cross-chain scenarios, route through CCTP
- `apps/api/src/services/a2a/payment-handler.ts` -- Cross-chain A2A routing

### Story 38.17: Chain Performance Metrics (3 pts)

- **Migration:** `20260320_chain_metrics.sql` -- `chain_performance_metrics` table
- `apps/api/src/services/wallet-settlement.ts` -- Record timing/gas metrics after each settlement
- `apps/api/src/routes/settlement.ts` -- `GET /v1/settlement/chain-metrics` endpoint

### Story 38.18: Solana Priority Fees (2 pts)

- `apps/api/src/config/solana.ts` -- Compute budget instructions, dynamic priority fee estimation

---

## SDK Impact Assessment

| Feature/Endpoint | Needs SDK? | Module | Priority | Notes |
|------------------|------------|--------|----------|-------|
| Async settlement (38.1-38.2) | No | - | - | Internal optimization, no API change |
| Solana wallet creation (38.4) | Types | `sly.wallets` | P1 | `blockchain: 'sol'` already in types |
| Gas Station config (38.8) | No | - | - | Admin-only endpoint |
| `GET /v1/settlement/chain-metrics` (38.17) | Yes | `sly.settlements` | P2 | New read-only endpoint |
| Deferred settlement mode (38.12) | Types | Types only | P1 | Add `settlementMode` to response types |

**SDK Stories Required:**
- [ ] Update `@sly/types` with `authorized` transfer status and `settlementMode` field
- [ ] Add `getChainMetrics()` to `sly.settlements` module

---

## Latency Impact Summary

| Scenario | Current | After Phase 1 | After Phase 4 |
|----------|---------|---------------|---------------|
| x402 payment response | 2-30s | 50-200ms | <100ms |
| A2A payment response | 2-30s | 50-200ms | <100ms |
| On-chain confirmation | Blocking | Async (background) | Batched (every 60s) |
| Micro-payment authorization | N/A | N/A | <10ms (ledger) |

---

## Story Summary

| Story | Points | Phase | Priority | Description |
|-------|--------|-------|----------|-------------|
| 38.1 | 5 | Phase 1 | P1 | x402 Async Settlement |
| 38.2 | 3 | Phase 1 | P1 | A2A Async Settlement |
| 38.3 | 3 | Phase 2 | P1 | Solana Chain Configuration |
| 38.4 | 3 | Phase 2 | P1 | Circle Wallet Creation on Solana |
| 38.5 | 5 | Phase 2 | P1 | Settlement Router Chain Awareness |
| 38.6 | 2 | Phase 2 | P1 | Solana Balance Sync |
| 38.7 | 3 | Phase 3 | P1 | Gas Station API Integration |
| 38.8 | 3 | Phase 3 | P1 | Gas Station Activation & Monitoring |
| 38.9 | 2 | Phase 3 | P2 | Gas Station Health Alerts |
| 38.10 | 3 | Phase 4 | P1 | Payment Intent Schema |
| 38.11 | 5 | Phase 4 | P1 | Net Position Tracker |
| 38.12 | 5 | Phase 4 | P1 | x402 Intent-Based Micro-payments |
| 38.13 | 3 | Phase 4 | P1 | A2A Intent-Based Micro-payments |
| 38.14 | 5 | Phase 4 | P1 | Batch Settlement Worker |
| 38.15 | 5 | Phase 5 | P2 | CCTP Bridge Service |
| 38.16 | 3 | Phase 5 | P2 | Cross-Chain Wallet Routing |
| 38.17 | 3 | Phase 5 | P2 | Chain Performance Metrics |
| 38.18 | 2 | Phase 5 | P2 | Solana Priority Fees |
| **Total** | **63** | | | |

---

## Dependency Graph

```
Phase 1 (Async Settlement)          Phase 3 (Gas Station)
  |-- 38.1 (x402 async)               |-- 38.7 (API integration)
  |-- 38.2 (A2A async)                |-- 38.8 (activation)
  |                                    |-- 38.9 (health alerts)
  v
Phase 4 (Deferred Net Settlement)   Phase 2 (Solana) [parallel w/ Phase 3]
  |-- 38.10 (intent schema)           |-- 38.3 (chain config)
  |-- 38.11 (net position tracker)    |-- 38.4 (Circle wallets)
  |-- 38.12 (x402 intents)            |-- 38.5 (router awareness)
  |-- 38.13 (A2A intents)             |-- 38.6 (balance sync)
  |-- 38.14 (batch worker)            |
                                       v
                                     Phase 5 (CCTP + Metrics)
                                       |-- 38.15 (CCTP bridge)
                                       |-- 38.16 (cross-chain routing)
                                       |-- 38.17 (chain metrics)
                                       |-- 38.18 (Solana priority fees)
```

---

## Verification

- **Phase 1:** Unit test `authorizeWalletTransfer()` returns without Circle API call. Integration test: x402 pay returns in <500ms, async worker settles on-chain within 60s.
- **Phase 2:** Create Solana wallet via API, fund via Circle faucet, execute Solana-to-Solana transfer.
- **Phase 3:** Transfer between agent wallets with Gas Station enabled, verify no native token consumed.
- **Phase 4:** Send 100 micro-payments between two agents, verify only 1 net on-chain transfer in batch.
- **Phase 5:** Transfer USDC from Base wallet to Solana wallet via CCTP, verify balances on both chains.

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Solana RPC reliability | Medium | Medium | Use fallback RPC providers, retry with backoff |
| Circle Gas Station limits | Low | Medium | Monitor gas budget, alert on low balance |
| Batch settlement failure | Low | High | Individual fallback settlement, reconciliation checks |
| CCTP bridge delays | Medium | Medium | Expose estimated time, async status polling |
| Net position accounting errors | Low | High | Double-entry bookkeeping, periodic reconciliation |

---

## Related Documents

- [Epic 26: x402 Performance](./epic-26-x402-performance.md) -- Phase 3 superseded by Story 38.1
- [Epic 50: Settlement Decoupling](./epic-50-settlement-decoupling.md) -- Settlement triggers engine (complete)
- [Epic 57: Google A2A Protocol](./epic-57-google-a2a-protocol.md) -- A2A payment rails (complete)
