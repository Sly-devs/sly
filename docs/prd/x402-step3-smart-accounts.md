# x402 Step 3: ERC-4337 Smart Accounts for Sly Agents

**Status:** Design doc (implementation scoped separately)
**Prerequisite:** x402 Step 2 (Sly-custodial EOAs) — shipped 2026-04-05

## Context

Step 2 gave each Sly agent a raw secp256k1 EOA whose private key is encrypted in credential-vault. Agents can now sign EIP-3009 `transferWithAuthorization` payloads for spec-compliant x402 payments, verified against external facilitators like `facilitator.x402.rs`.

This works. But raw EOAs have four limitations we'll hit as the agent economy scales:

1. **Gas tokens.** To submit an on-chain transaction, an EOA needs ETH for gas. Agents will never hold ETH — they hold USDC. Today we work around this by relying on relayers (the facilitator or the USDC contract's `transferWithAuthorization` mechanic where any msg.sender can submit a signed payload). This only works for the EIP-3009 code path; any other on-chain action (permits, approvals, custom calls) requires the agent to hold ETH.

2. **Key rotation is painful.** If a private key is compromised, there's no way to "change the key" on an EOA — the address IS the key's hash. We'd have to deploy a new EOA, update all references, and ask users/other agents to update their records.

3. **No session keys.** If an agent wants to authorize a sub-process (a temporary worker, a scoped operation) to spend a small amount without handing over the master key, it can't — EOAs are all-or-nothing.

4. **ERC-7710 delegation path unavailable.** The x402 spec's third signing scheme (ERC-7710) is specifically designed for smart contract accounts. EIP-3009 and Permit2 work fine today, but ERC-7710 would let Sly offer richer authorization models (delegations, time-bounded permissions, spending caps enforced by the contract itself).

ERC-4337 smart accounts solve all four of these.

## What we'd build

Each agent gets a **smart contract wallet** (a deployed contract on Base) instead of (or in addition to) a raw EOA. Sly holds an **owner key** that authorizes actions on the smart wallet via `UserOperation` objects submitted to an ERC-4337 bundler.

Key properties of this model:

- **Gas abstraction.** The smart wallet's `validateUserOp` can accept a paymaster, so gas is paid in USDC (or sponsored entirely by Sly). Agents never touch ETH.
- **Owner rotation.** The smart wallet contract has a mutable `owner` field. If Sly's hot owner key is compromised, rotate to a new owner without losing the wallet or its funds.
- **Session keys / scoped permissions.** The smart wallet can grant a short-lived key permission to spend up to X USDC until timestamp Y. Useful for agent sub-processes (e.g. a long-running scraper that needs to pay per-request).
- **ERC-7710 delegation.** The spec for x402's third signing scheme. A delegation proof from the smart wallet's Delegation Manager is signed by the owner once, then any number of facilitators can redeem it without additional signatures.
- **Batch operations.** Multiple payments bundled into one `UserOp` → one on-chain transaction. Cheaper per-payment, less congestion.

## Options

There are three main smart account implementations we could use. Each has different trade-offs.

### Option A — CDP Smart Wallets (Coinbase)

Coinbase's CDP platform offers hosted smart wallets via their Wallet API. We'd call CDP instead of managing our own contracts.

**Pros:**
- Zero contract deployment work
- Coinbase handles the bundler, paymaster, and security
- Native integration with Coinbase's x402 facilitator
- Production-ready (used by Coinbase's own products)

**Cons:**
- Vendor lock-in to Coinbase
- Cost per wallet / per transaction (pricing TBD)
- Less control over the account logic
- Requires CDP API keys and policy setup

**Best for:** shipping fast, leaning on Coinbase's infrastructure. Matches the Sly ↔ Coinbase x402 ecosystem story.

### Option B — Biconomy Smart Accounts

Biconomy provides a modular SDK for ERC-4337 wallets with their own bundler and paymaster infrastructure. Widely used in production.

**Pros:**
- Mature, widely audited contracts
- Built-in session keys, social recovery, batching
- ERC-7579 modular architecture (we can add custom validators later)
- Self-hostable bundler if we want to avoid vendor dependency

**Cons:**
- Another SDK to integrate (biconomy-sdk)
- Paymaster costs money (either USDC fees or sponsored via Biconomy account)
- Contract deployment per agent (~$0.50-$1 gas equivalent on mainnet, free on testnet)

**Best for:** balance of control and ease. Good middle path if we don't want full Coinbase lock-in.

### Option C — Safe (Gnosis Safe) Smart Accounts

Safe is the battle-tested multisig and smart wallet implementation. ERC-4337 support via Safe{Core}.

**Pros:**
- Most audited smart contract wallet in existence (~$100B+ locked across all Safes)
- Excellent tooling, observability, and recovery
- Strong social recovery and module ecosystem
- Sly engineers are likely already familiar with it

**Cons:**
- Heavier for per-agent use (designed for treasuries, not single-owner agents)
- Higher deployment gas than Biconomy or CDP
- ERC-4337 integration via `Safe4337Module` is solid but adds a layer

**Best for:** if we expect agents to eventually become multi-owner entities (e.g. an agent managed jointly by a human and another agent), or if we want the strongest possible security guarantees.

## Recommendation

**Start with Option A (CDP)** for the prototype, then evaluate migration to Option B (Biconomy) once we have usage data.

Reasoning:
- CDP gives us the fastest path to a working prototype. We already have Circle custodial wallets integrated, and CDP is Coinbase-owned infrastructure — same ecosystem, same operational familiarity.
- The Coinbase x402 facilitator will natively support CDP smart wallets. That's the exact interop story we want for the demo.
- Biconomy is the long-term play if CDP's pricing or control trade-offs prove untenable.
- Safe is overkill for the single-owner-per-agent model we have today. Revisit if multi-party agents become a thing.

## Proposed sequence

### Phase 1 — Design + prototype (1 week)

1. Provision a CDP developer account and API key. Document the CDP wallet creation flow.
2. Build a new agent wallet type `cdp_smart_account` in the `wallets` table. Parallel to `circle_custodial` — agents can hold both.
3. Add `POST /v1/agents/:id/smart-wallet` endpoint that creates a CDP smart wallet and stores the reference.
4. Test EIP-3009 signing via the CDP wallet path (CDP exposes raw `signTypedData`).
5. Verify the resulting signature against `facilitator.x402.rs` — same validation we did for EOAs in Step 2.
6. Test ERC-7710 delegation signing (the "smart account native" x402 scheme).

### Phase 2 — Gas abstraction (3-5 days)

1. Wire up CDP's paymaster so USDC transfers pay gas in USDC, not ETH.
2. Update the async settlement worker to route through the CDP bundler instead of calling `Circle.transferTokens` for smart wallet-backed agents.
3. Measure gas cost per transfer vs. the current Circle custodial path. Go/no-go decision on making CDP smart wallets the default.

### Phase 3 — Migration path (spec only, 2 days)

1. Design the migration flow: existing agents with raw EOAs → upgrade to smart wallet by transferring USDC from old EOA to new smart wallet address.
2. Dual-path support in the signer (`agent_signing_keys` stores either `secp256k1` or `cdp_wallet_id`, sign endpoint routes based on which exists).
3. No forced migration — new agents get smart wallets, old agents keep raw EOAs unless user opts in.

### Phase 4 — Evaluate Option B (Biconomy) (1 week)

1. Deploy a parallel Biconomy integration behind a feature flag.
2. Compare: gas cost, latency, operational complexity, vendor cost.
3. Decide whether to migrate the default off CDP.

## Open questions for decision

1. **Who pays gas?** Options:
   - Sly absorbs gas cost as a platform fee (simple, predictable)
   - Agents pay gas in USDC via paymaster (pass-through, harder to budget)
   - Hybrid: free up to N transactions/month, then pass-through

2. **CDP wallet set management.** CDP has wallet sets (like Circle). Do we create one wallet set per tenant, or one global Sly wallet set? One per tenant = better isolation, more API calls.

3. **Session keys.** Do we want to expose session keys to end users at launch, or keep it internal for now? Session keys are the biggest DX win but also the biggest attack surface.

4. **ERC-7710 delegation.** Is any facilitator in production actually using ERC-7710 yet, or is it still spec-only? If no one accepts it, we can deprioritize implementing it.

5. **Backwards compatibility.** Once smart wallets exist, do we deprecate raw EOAs entirely (Step 2) or keep them as a lower-tier option?

## Success criteria

- A Sly agent can pay an external x402 endpoint using a smart wallet signature — verified by `facilitator.x402.rs` or Coinbase's facilitator.
- Gas is paid in USDC (not ETH) via paymaster.
- Agent never handles any key material — Sly holds the owner key.
- Owner key rotation works without losing access to smart wallet funds.
- Session key creation and redemption work for at least one test scenario.

## Related files (to be touched during implementation)

| File | Purpose |
|------|---------|
| `apps/api/supabase/migrations/YYYYMMDD_smart_wallets.sql` | NEW — wallet type enum + `cdp_wallet_id` column |
| `apps/api/src/services/x402/signer.ts` | EXTEND — route signing by key type (EOA vs smart account) |
| `apps/api/src/services/cdp/client.ts` | NEW — CDP API wrapper |
| `apps/api/src/routes/agents.ts` | EXTEND — `POST /v1/agents/:id/smart-wallet` |
| `apps/api/src/routes/onboarding-agent.ts` | EXTEND — smart wallet auto-provisioning option |
| `packages/sdk/src/protocols/x402/client.ts` | EXTEND — `signTransferAuthWithSmartWallet()` helper |

## Non-goals

- Not building our own smart wallet contracts. We use existing audited implementations only.
- Not replacing Circle custodial wallets. They stay as the settlement / treasury layer. Smart wallets are a new complementary layer for external x402 payments.
- Not deploying to mainnet in Phase 1. Base Sepolia testnet only until we're confident in the flow.
- Not building our own bundler or paymaster. Use CDP's or Biconomy's hosted infrastructure.
