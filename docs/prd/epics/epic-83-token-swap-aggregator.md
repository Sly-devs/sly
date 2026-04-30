# Epic 83: Wallet Token Swap via DEX Aggregator

## Summary

Add a token swap surface to Sly wallets so tenants and agents can exchange between USDC, ETH, and any ERC-20 on Base/Polygon directly from the dashboard, MCP, or API — without sending funds to Coinbase, Uniswap, or any third-party UI. Implementation routes quotes through a DEX aggregator (0x as primary, 1inch as fallback) and signs/broadcasts via Sly's existing CDP-managed wallet path.

## Motivation

Coinbase's `agentic-wallet-skills` package ships a `trade` skill (`npx awal@2.8.2 trade`) that wraps the CDP Swap API. Three real customer asks today:

1. **Agents holding non-USDC inventory** — paid x402 endpoints settle in USDC, but agents earn ETH from gas refunds and POL from Polygon flows. Today they have to bridge or off-ramp manually to redeploy that capital.
2. **Treasury operations** — tenants top up wallets in USDC but need ETH for gas on Base / POL on Polygon. Currently solved with manual transfers or auto-refill epics; both require holding gas-token reserves.
3. **Buyer-side cost optimization** — an agent paying $0.001 USDC per call wants to swap a small ETH balance to USDC just-in-time rather than maintain dual reserves.

Without native swap, Sly stays in the "you brought the right token, we route it" lane. With swap, we own the full lifecycle: fund → swap → spend → withdraw. This is the gap between "wallet" and "actual wallet."

## Why aggregator (vs. CDP Swap or direct DEX)

| Approach | Liquidity | Coupling | Implementation cost | Fee model |
|---|---|---|---|---|
| **0x Aggregator API** ✅ | Routes across Uniswap, Curve, Balancer, Aerodrome, Maverick, etc. | None — public API + our keys | ~1 day per chain | Affiliate fee param built-in |
| 1inch API (fallback) | Same coverage class as 0x | None | Same shape as 0x — easy to slot as backup | Affiliate fee param |
| CDP Swap API | Coinbase wraps 0x | Locks us to CDP keys | Lowest (we already have CDP creds) | Bills via CDP → opaque markup |
| Uniswap Universal Router | Uniswap v2/v3/v4 only | None | Highest — custom routing logic, slippage protection, multi-hop math | None |

**Decision: 0x Aggregator as primary, 1inch as runtime fallback, no CDP Swap.** Coinbase already gets the facilitator fees on x402 settles; routing swaps through them too compounds the lock-in. 0x gives us the same liquidity, our own affiliate-fee revenue, and a 1inch fallback if their endpoint degrades.

## Scope

**In scope (v1):**
- USDC ↔ ETH swaps on Base mainnet
- Quote-then-execute flow with 30s quote TTL
- Permit2-style approvals (gasless approval signature)
- Affiliate fee captured to a Sly treasury address
- Slippage protection (default 0.5%, override up to 5%)
- Dashboard "Swap" tab on wallet detail page
- MCP tools `wallet_swap_quote`, `wallet_swap_execute`, `wallet_list_swaps`
- 1inch fallback when 0x returns 5xx or no liquidity

**Out of scope (v2+):**
- Polygon, Arbitrum, Optimism, Solana — Base only in v1
- Cross-chain swaps (would require LiFi/Squid)
- Limit orders, TWAP, DCA — single-shot market swaps only
- Solana SPL token swaps (requires separate signer path)
- Native ETH wrap/unwrap UX (use WETH; users handle wrapping themselves in v1)

## Prerequisites

- None on the signing side. CDP Wallet API path used by `apps/api/src/services/x402/signer.ts` already supports arbitrary calldata signing.
- A Sly affiliate-fee treasury address per network (set via env, e.g. `SLY_SWAP_FEE_RECIPIENT_BASE=0x...`).
- 0x API key (free tier covers > 100k requests/month — enough through v1 launch).

## Code changes

### 1. Schema — swap orders + quote cache

Migration: `apps/api/supabase/migrations/YYYYMMDD_wallet_swap.sql`

```sql
CREATE TABLE wallet_swap_quotes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  network TEXT NOT NULL,                  -- CAIP-2: 'eip155:8453'
  sell_token TEXT NOT NULL,               -- 0x address (lowercase)
  buy_token TEXT NOT NULL,
  sell_amount NUMERIC(78, 0) NOT NULL,    -- atomic units (uint256)
  buy_amount NUMERIC(78, 0) NOT NULL,
  price NUMERIC(36, 18) NOT NULL,         -- buy/sell, decimal
  estimated_gas BIGINT,
  source TEXT NOT NULL CHECK (source IN ('0x', '1inch')),
  raw_quote JSONB NOT NULL,               -- full aggregator response (signed payload, allowanceTarget, to, data, value)
  expires_at TIMESTAMPTZ NOT NULL,        -- now() + 30s
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE wallet_swaps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  quote_id UUID REFERENCES wallet_swap_quotes(id),
  network TEXT NOT NULL,
  sell_token TEXT NOT NULL,
  buy_token TEXT NOT NULL,
  sell_amount NUMERIC(78, 0) NOT NULL,
  buy_amount_min NUMERIC(78, 0) NOT NULL, -- after slippage
  buy_amount_actual NUMERIC(78, 0),       -- filled in after settle
  slippage_bps INTEGER NOT NULL,          -- basis points
  affiliate_fee_bps INTEGER NOT NULL,     -- our take, basis points
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','submitted','confirmed','failed','reverted')),
  tx_hash TEXT,
  block_number BIGINT,
  gas_used BIGINT,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  confirmed_at TIMESTAMPTZ
);

CREATE INDEX idx_wallet_swaps_wallet_status ON wallet_swaps(wallet_id, status);
CREATE INDEX idx_wallet_swap_quotes_expires ON wallet_swap_quotes(expires_at);
```

RLS: tenant-scoped; verified via `pnpm --filter @sly/api check:rls`.

### 2. Aggregator client — `apps/api/src/services/swap/aggregator.ts` (new)

Pure HTTP client, no DB:

```ts
export interface QuoteRequest {
  network: 'eip155:8453';      // base mainnet only in v1
  sellToken: `0x${string}`;
  buyToken: `0x${string}`;
  sellAmount: bigint;          // atomic units
  taker: `0x${string}`;        // wallet address
  slippageBps: number;         // basis points (50 = 0.5%)
  affiliateAddress?: `0x${string}`;
  affiliateBps?: number;
}

export interface AggregatorQuote {
  source: '0x' | '1inch';
  buyAmount: bigint;
  sellAmount: bigint;
  price: number;
  estimatedGas: bigint;
  allowanceTarget: `0x${string}`;
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
  permit2?: { eip712: TypedDataDomain };
  raw: unknown;
}

export async function getQuote(req: QuoteRequest): Promise<AggregatorQuote>;
```

Implementation:
- Hit `https://api.0x.org/swap/permit2/quote` first (with `0x-api-key` header from env).
- On 5xx or no-liquidity error: fall back to 1inch's `https://api.1inch.dev/swap/v6.0/8453/quote`.
- Both sources mapped to the same `AggregatorQuote` shape so the executor doesn't care which routed.

### 3. Swap service — `apps/api/src/services/swap/swap-service.ts` (new)

```ts
export async function quoteSwap(ctx: RequestContext, walletId: string, req: SwapRequest): Promise<SwapQuoteRecord>;
export async function executeSwap(ctx: RequestContext, walletId: string, quoteId: string): Promise<SwapRecord>;
```

`executeSwap` flow:
1. Load quote, assert not expired and tenant matches.
2. Check wallet sell-token balance ≥ `sellAmount`. Reject early on insufficient.
3. If `allowanceTarget !== sellToken` and the wallet hasn't approved before: build approve tx, sign via existing CDP signer, broadcast, wait for receipt. (Permit2 path skips this when the aggregator returns a Permit2 typed-data signature instead — sign typed data, append to calldata, no on-chain approval needed.)
4. Sign + broadcast the swap tx (`to`, `data`, `value`) via `apps/api/src/services/x402/signer.ts` — same code path as x402 settles, just different calldata.
5. Insert `wallet_swaps` row in `submitted` state with the tx hash. Return immediately.
6. Background: a `wallet-swap-confirmer.ts` worker watches submitted swaps, polls `eth_getTransactionReceipt`, updates `confirmed`/`reverted` + actual `buy_amount_actual` from logs.

### 4. Routes — `apps/api/src/routes/wallet-swap.ts` (new)

| Method | Path | Body | Response |
|---|---|---|---|
| `POST` | `/v1/wallets/:id/swap/quote` | `{ sellToken, buyToken, sellAmount, slippageBps? }` | `{ quoteId, buyAmount, price, expiresAt, source }` |
| `POST` | `/v1/wallets/:id/swap/execute` | `{ quoteId }` | `{ swapId, status, txHash }` |
| `GET`  | `/v1/wallets/:id/swaps` | — | `{ data: SwapRecord[], pagination }` |
| `GET`  | `/v1/wallets/:id/swaps/:swapId` | — | `SwapRecord` |

Mount in `apps/api/src/app.ts` next to existing wallet routes.

### 5. MCP tools — `packages/mcp-server/src/tools.ts`

Three new tools next to `wallet_withdraw`:

- `wallet_swap_quote` — get a quote, returns `quoteId` + price preview
- `wallet_swap_execute` — accept a quote, broadcasts the swap
- `wallet_list_swaps` — paginate swap history for a wallet

Handlers in `server-factory.ts` proxy through to `api.wallets.swap.*`.

### 6. API client — `packages/api-client/src/client.ts`

Extend `wallets` namespace with `.swap.quote()`, `.swap.execute()`, `.swap.list()`, `.swap.get()`.

### 7. UI — `apps/web/src/app/dashboard/wallets/[id]/swap/page.tsx` (new)

- Token-in / token-out selector (USDC, ETH, WETH presets + "paste address" advanced)
- Live quote — debounced 500ms after sellAmount changes; shows `you receive ≈ X` + `1 USDC = Y ETH` rate + `network fee est. $Z`
- Slippage selector (0.1% / 0.5% / 1% / custom up to 5%)
- "Confirm Swap" → POST /execute → tx-hash toast + redirect to swap detail page
- Swap detail page with status timeline (`submitted → confirmed`), BaseScan link, actual fill info

Reuse `apps/web/src/components/x402/publication-timeline.tsx` pattern for the status timeline.

### 8. Worker — `apps/api/src/workers/wallet-swap-confirmer.ts` (new)

Pattern matches `apps/api/src/workers/scheduled-transfers.ts`:
- Polls `wallet_swaps WHERE status='submitted'` every 15s
- For each: `eth_getTransactionReceipt(txHash)`
- On confirmed: parse logs (Transfer events) to compute `buy_amount_actual`, set status to `confirmed` + record `gas_used` + `block_number`
- On revert: set status `reverted`, persist revert reason from receipt
- Mock mode (`MOCK_WALLET_SWAP_CONFIRMER=true`) for local dev

## Configuration

Add to `apps/api/.env.example`:

```
# DEX aggregator
ZEROEX_API_KEY=
ONEINCH_API_KEY=

# Sly affiliate-fee recipients (per network)
SLY_SWAP_FEE_RECIPIENT_BASE=0x...
SLY_SWAP_FEE_BPS=20                    # 0.2% default; per-tenant override TBD

# Worker config
WALLET_SWAP_CONFIRMER_INTERVAL_MS=15000
MOCK_WALLET_SWAP_CONFIRMER=false
```

## Critical files

**Modify**
- `apps/api/src/app.ts` — mount swap routes, start confirmer worker
- `apps/api/src/services/x402/signer.ts` — already signs arbitrary calldata; verify export shape supports raw `{to, data, value}`
- `packages/mcp-server/src/tools.ts` + `server-factory.ts` — register three new tools
- `packages/api-client/src/client.ts` — extend wallets namespace
- `packages/types/src/index.ts` — `SwapQuote`, `SwapRecord`, `SwapStatus`

**Create**
- `apps/api/supabase/migrations/YYYYMMDD_wallet_swap.sql`
- `apps/api/src/services/swap/aggregator.ts`
- `apps/api/src/services/swap/swap-service.ts`
- `apps/api/src/routes/wallet-swap.ts`
- `apps/api/src/workers/wallet-swap-confirmer.ts`
- `apps/web/src/app/dashboard/wallets/[id]/swap/page.tsx`
- `apps/web/src/app/dashboard/wallets/[id]/swap/[swapId]/page.tsx`
- `apps/web/src/components/wallet/swap-form.tsx`
- `apps/web/src/components/wallet/swap-status-timeline.tsx`

## Verification

1. **Unit tests** (`apps/api/tests/unit/`):
   - `aggregator.test.ts` — mock 0x + 1inch responses, assert mapping + fallback on 5xx
   - `swap-service.test.ts` — quote expiry, balance check, Permit2 vs. approval branches
   - `wallet-swap-routes.test.ts` — auth, RLS, validation

2. **Integration tests** (`INTEGRATION=true`):
   - End-to-end USDC→WETH swap on Base Sepolia using real 0x staging endpoint + a tenant Sly-custodied wallet pre-funded from faucet
   - Insufficient-balance rejection
   - Quote expiration rejection
   - 1inch fallback path (force 0x to fail via env flag)

3. **Manual end-to-end**:
   - Tenant logs in → wallet detail → Swap tab → quote $5 USDC → ETH → confirm → tx confirms within ~30s on Base mainnet → balances update
   - Repeat with 0.5% slippage and confirm `buy_amount_actual ≥ buy_amount_min`
   - MCP smoke: `mcp__sly__wallet_swap_quote` → `wallet_swap_execute`

4. **Affiliate fee accrual**:
   - After 10 test swaps, check `SLY_SWAP_FEE_RECIPIENT_BASE` balance — should reflect ~`SLY_SWAP_FEE_BPS` of total volume
   - Add a `swap_fee_revenue` view aggregating `wallet_swaps` by day for ops dashboard (deferred to follow-up)

## Risks & open questions

- **Permit2 signing UX in CDP-managed wallets**: 0x's permit2 endpoint returns EIP-712 typed data the wallet must sign. CDP Wallet API supports `signTypedData` (already used for x402). Verify the typed-data domain Coinbase produces matches what 0x expects — historically there have been domain-name mismatches (cf. the USDC `name: "USD Coin"` discovery during Epic 88).
- **MEV protection**: 0x's `enableSlippageProtection: true` flag routes through their RFQ system and avoids public mempool exposure. v1 enables this by default; revisit if it costs too much liquidity.
- **Affiliate fee on Permit2 path**: 0x supports `affiliateAddress` only on the `/quote` endpoint, not `/permit2/quote`. v1 may need to fall through to non-Permit2 path when `affiliateBps > 0`. Confirm during impl.
- **Per-tenant fee override vs. flat platform fee**: v1 uses flat `SLY_SWAP_FEE_BPS`. Customer asks for "I'll take a smaller cut on volume" come Phase 2 — would need a `tenants.swap_fee_bps_override` column.
- **Slippage cap**: 5% upper bound is conservative. Power-user agents trading thin pairs may complain. Make it configurable via tenant settings.

## Phasing

| Phase | Scope | Effort |
|---|---|---|
| **P1** | 0x quote+execute, USDC↔ETH on Base, dashboard UI, MCP tools | ~1 week |
| P2 | 1inch fallback, slippage protection, affiliate fee accrual reporting | ~3 days |
| P3 | Polygon support, native-ETH wrap/unwrap, arbitrary ERC-20 input | ~1 week |
| P4 | Cross-chain (LiFi), Solana SPL swaps | separate epic |
