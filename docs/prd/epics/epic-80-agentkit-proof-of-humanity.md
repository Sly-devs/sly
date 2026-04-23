# Epic 80: AgentKit Proof-of-Humanity for x402

## Summary

A new class of x402 services (Exa is first, more coming) require **two** signatures per call: the standard EIP-3009 payment authorization *plus* a proof-of-humanity signature from **AgentKit** (Coinbase CDP's agent identity protocol, anchored on Worldcoin Chain via World ID). Without the second signature, the vendor returns a generic `X402_INVALID_SIGNATURE` error — even though our payment sig is perfectly valid. This epic documents the gap and scopes the work to close it when customer demand justifies the lift. Not P0; file and defer.

## SDK Impact Assessment

| Feature/Endpoint | Needs SDK? | Module | Priority | Notes |
|------------------|------------|--------|----------|-------|
| `POST /v1/agents/:id/agentkit-sign` | ✅ Yes | `sly.agents` | P2 | New sign endpoint (parallel to `/x402-sign`) |
| Vault custody mode `human_attested` | ✅ Yes | `sly.vault` | P2 | Extend Epic 78 once it ships |
| x402_fetch auto-detection of agentkit challenges | ✅ Yes | `sly.vault` (MCP) | P1 | Already detects + classifies in this epic |

**SDK Stories Required:**
- [ ] Story 80.X: Add `agentkit_sign` capability to `sly.agents` SDK surface
- [ ] Story 80.Y: Update MCP `agent_call_service` dispatcher to auto-retry with AgentKit when challenge declares it

## Motivation

AI agents are trivial to create. An attacker with $1000 in USDC can spin up 100,000 agents and rate-limit-abuse any x402 service. Traditional per-API-key rate limits don't help when the caller is an autonomous program.

Proof-of-humanity binds each agent to a unique human operator via World ID (Worldcoin's orb-verified personhood credential). The human scans their iris once; their World ID credential lives on Worldcoin Chain (`eip155:480`). When their agent makes a call, it includes a signature from a key that's provably associated with that World ID — typically via:

- **EIP-191** — classic "personal sign" over a SIWE statement, signed by a key the World ID holder controls.
- **EIP-1271** — contract-wallet verification where the signer is a smart wallet whose owner chain roots in World ID.

For Sly, the gap is concrete: **Exa** (probably the best general-purpose search API in the agent ecosystem today) gates every call behind AgentKit proof after a free trial window. Their `X402_INVALID_SIGNATURE` error is misleading — the payment sig is fine; the missing piece is the AgentKit sig. More services will follow (expect Perplexity, Browserbase, and any service with strong anti-abuse requirements to add this within 6-12 months).

Three customer segments affected:
1. **Autonomous agents** calling Exa / any future AgentKit-gated service — currently blocked.
2. **Agent platforms** (like Sly) trying to offer universal pay-to-call — must degrade gracefully when the gate is AgentKit.
3. **Compliance-sensitive enterprises** who want to prove every agent action is ultimately human-authorized — AgentKit offers that primitive for free if we integrate.

## What exists today (after this epic's prework)

- `classifyX402Failure` in `packages/mcp-server/src/server-factory.ts` already detects `AGENTKIT_REQUIRED` via:
  - `challenge.extensions.agentkit` present
  - Error body `tag === 'X402_INVALID_SIGNATURE'`
- Transfer rows for failed AgentKit calls land with `protocol_metadata.classification.code = 'AGENTKIT_REQUIRED'` and a human-readable explanation.
- Dashboard transfer detail page shows an indigo "AGENTKIT_REQUIRED" badge with the recommendation to skip the vendor.

So the **failure mode is already visible and actionable** — what's missing is the ability to *succeed* on these endpoints.

## Custody modes to support

Piggyback on Epic 78 (Agentic Credential Vault). Extends the `lease_mode` column and adds a new concept `custody_type: 'human_attested'` to `vault_credentials`.

| Storage | What the tenant deposits | How Sly uses it | Priority |
|---------|-------------------------|-----------------|----------|
| **Attested private key** | A secp256k1 key the tenant (a human) personally generated, attested via World ID on Worldcoin Chain | Sly signs agentkit SIWE challenges with it on behalf of specific agents | **P1** |
| **Smart wallet session key** | Session key delegated from a Coinbase Smart Wallet / Safe that roots in the tenant's World ID | Sly signs as the session key; wallet's EIP-1271 `isValidSignature` validates via World ID nullifier | **P2** |
| **Worldcoin orb partnership** | — | Sly runs / partners with orb operator to issue identities directly | Out of scope |

## Prerequisites

- **Epic 78 (Agentic Credential Vault) must be MVP-shipped.** This epic extends the vault with a new `custody_type` and a new provider adapter. Without Epic 78, there's no place to store the attested identity.

## Code changes

### 1. Schema — extend `vault_credentials` (additive migration)

```sql
ALTER TABLE vault_credentials
  ADD COLUMN custody_type TEXT NOT NULL DEFAULT 'api_key'
    CHECK (custody_type IN ('api_key', 'human_attested', 'session_key')),
  ADD COLUMN identity_chain TEXT,                  -- 'eip155:480' for Worldcoin
  ADD COLUMN identity_address TEXT,                -- the signing address (World ID-linked)
  ADD COLUMN identity_verification JSONB;          -- { provider: 'worldcoin', nullifier_hash, verified_at, orb_id? }
```

### 2. New service — `apps/api/src/services/vault/providers/agentkit.ts`

Handles:
- `buildSiweMessage(info)` — constructs the SIWE statement from `agentkit.info` in the challenge.
- `signSiwe(credential, message)` — decrypts the attested key via credential-vault, signs with viem's `signMessage` (EIP-191).
- `buildSignedAgentKitHeader(signature, info)` — base64 wrap for the `AgentKit-Signature` HTTP header (or whatever the canonical header name is by shipping date — the draft AgentKit spec is still evolving).

### 3. Integrate into `x402_fetch` dispatcher

`packages/mcp-server/src/server-factory.ts`:
- When `failureClassification.code === 'AGENTKIT_REQUIRED'` AND the agent has an active vault grant with `custody_type='human_attested'`, retry the call with both `X-PAYMENT` and `AgentKit-Signature` headers.
- If no grant exists, return the current behavior (classified failure + skip recommendation).

### 4. Dashboard — new "Attested Identity" credential type

`apps/web/src/app/dashboard/vault/new/page.tsx` — add a card in the credential wizard:

> **Attested Identity (World ID)**
> For services like Exa that require proof of human operation. You'll need:
> 1. A World ID (orb-verified human credential from Worldcoin)
> 2. A key authorized to sign on behalf of your World ID
>
> Sly will sign AgentKit challenges on your behalf when agents call services that require it.

The form collects:
- Label
- Private key (stored encrypted via vault)
- World ID nullifier hash (for audit trail; verified against Worldcoin's on-chain registry)
- Identity signing address (derived from the key)

Plus a live verification flow: Sly posts a SIWE challenge signed by the deposited key to Worldcoin Chain, confirms it resolves to a valid World ID, stores the verification in `identity_verification`.

### 5. MCP tool — `agent_agentkit_sign`

Primitive for callers who want to sign manually instead of going through the dispatcher:
```
agent_agentkit_sign({ agentId, grantId, challengeInfo })
  → { signature, message, chainId, signerAddress }
```

Useful for future protocol variants we don't yet auto-dispatch.

## Story breakdown (~18 pts MVP, all Phase 2 of Epic 78)

| # | Story | Points |
|---|---|---|
| 80.1 | Migration: `custody_type`, `identity_chain`, `identity_address`, `identity_verification` columns on `vault_credentials` | 1 |
| 80.2 | `services/vault/providers/agentkit.ts` — SIWE builder + EIP-191 signer using credential-vault | 3 |
| 80.3 | `POST /v1/agents/:id/agentkit-sign` route — parallel to `/x402-sign`, accepts `{ challenge, grantId }`, returns `{ signature, message }` | 3 |
| 80.4 | `x402_fetch` dispatcher integration — auto-retry with AgentKit sig when classification is `AGENTKIT_REQUIRED` and a `human_attested` grant exists | 3 |
| 80.5 | Dashboard credential wizard: "Attested Identity (World ID)" card with live verification flow | 3 |
| 80.6 | MCP tool `agent_agentkit_sign` + `vault_issue_grant` extension for `custody_type='human_attested'` | 2 |
| 80.7 | World ID nullifier verification — call Worldcoin's on-chain registry contract to confirm the identity address maps to a valid, non-revoked World ID | 3 |

### Phase 2 backlog (not in MVP)

- **Smart wallet session keys** — accept Coinbase Smart Wallet / Safe session-key delegations rooted in World ID. Uses EIP-1271 path instead of EIP-191.
- **Continuous verification** — periodically re-verify the identity is still valid (World ID nullifiers can be revoked by re-scanning with opposite orb).
- **Revocation cascade** — if the underlying World ID is revoked, flip all grants using it to `status='revoked'`.
- **Multi-service AgentKit support** — as more services adopt AgentKit, add per-service adapter config (header name, SIWE field mapping).

## Risks

- **AgentKit spec is still draft.** Exa's implementation today may differ from Coinbase's published spec in 3 months. Plan for the provider adapter to be revisable.
- **World ID orb coverage is limited.** Not every customer will be orb-verified. Don't position this as required-for-everyone; it's a custody mode for customers whose use cases demand it.
- **Worldcoin regulatory exposure.** The project has faced privacy scrutiny in Kenya, Germany, Hong Kong, and elsewhere. If a major jurisdiction bans World ID, customers' identity keys become less useful. Mitigation: design for pluggable identity providers — if Fractal / Privado / Civic emerge as alternatives, the custody type can accept them.
- **Dual-chain complexity.** Payment on Base, identity on Worldcoin Chain. Confusing for users. The dashboard UX must make the two chains' purposes legible ("this address pays — this address proves you're human").
- **Replay across agents.** Nonces in the SIWE message must be unique per call and tracked server-side to prevent one agent replaying another's identity signature.

## Related

- **Epic 78 — Agentic Credential Vault** — prerequisite. AgentKit custody is a new mode in the vault's schema.
- **Epic 77 — BYO Wallet Custody** — shares the session-key delegation pattern with Phase 2 of this epic.
- **Exa** is the first confirmed AgentKit-gated vendor — file this as the canary target for MVP verification.

## What ships in this session (pre-epic-MVP)

Already landed via commit `TBD-after-this-push`:
1. `classifyX402Failure` in `packages/mcp-server/src/server-factory.ts` — detects `AGENTKIT_REQUIRED` from challenge extensions + error tag
2. `record-settlement` route accepts a `classification` field stored in `protocol_metadata.classification`
3. Dashboard transfer detail page renders a color-coded classification badge with human-readable explanation + recommendation
4. x402_fetch returns `failureClassification` in the tool output so agents can programmatically skip vendors gated by AgentKit

This prework means: even without AgentKit signing support, Sly agents can now cleanly identify "this vendor needs AgentKit, skip it" instead of retrying an endlessly-failing call.

## Critical files to reference during implementation

- `packages/mcp-server/src/server-factory.ts` — `classifyX402Failure` (detection already here, extends with retry logic)
- `apps/api/src/routes/transfers.ts` — `record-settlement` route + classification schema
- `apps/api/src/services/credential-vault/index.ts` — encryption primitive for attested keys
- `docs/prd/epics/epic-78-agentic-credential-vault.md` — prerequisite epic this extends
- Worldcoin SDK docs: https://docs.worldcoin.org/world-id
- Coinbase CDP AgentKit docs: https://docs.cdp.coinbase.com/agentkit
