# Epic 85 — Sly Scanner on the x402 marketplace

**Status:** Ready for engineering · **Owner:** TBA · **Target:** sprint after Epic 84 lands · **Related PRs:** [#53 docs](https://github.com/Sly-devs/sly/pull/53), [#50 SDK](https://github.com/Sly-devs/sly/pull/50), [#46 audit trail](https://github.com/Sly-devs/sly/pull/46)

## Summary

Publish 4 Sly Scanner endpoints to Coinbase's x402 discovery catalog so they appear on **[agentic.market](https://agentic.market)**. Use the existing internal `publishEndpoint` state machine in `apps/api/src/services/publish-x402.ts` — no new infra; this is configuration + 4 rows in `x402_endpoints` + a publish call per endpoint.

## Why

A partner is starting integration tomorrow. Listing on agentic.market gives Sly a discovery channel for AI agents that don't yet know about the scanner, and creates a visible $0.05/scan price point that the partner channel undercuts (50–86% off). Pricing strategy and partner-facing docs already shipped in [PR #53](https://github.com/Sly-devs/sly/pull/53). What's missing is the actual marketplace listing.

## Scope

### What's in

Four endpoints, all routed through the existing gateway, all backed by `scanner.getsly.ai`:

| Path (gateway) | Backend | Method | Price (USDC) | Description |
|---|---|---|---|---|
| `/x402/scanner/scan` | `https://scanner.getsly.ai/v1/scanner/scan` | POST | **$0.05** | Score a merchant for agentic-commerce readiness across 8 protocols |
| `/x402/scanner/tests` | `https://scanner.getsly.ai/v1/scanner/tests` | POST | **$0.25** | Run a synthetic agent shopping test against a domain |
| `/x402/scanner/by-domain/:domain` | `https://scanner.getsly.ai/v1/scanner/scans/by-domain/:domain` | GET | **$0.005** | Fetch the freshest cached scan for a domain |
| `/x402/scanner/prospects` | `https://scanner.getsly.ai/v1/scanner/prospects` | GET | **$0.025** | Find agentic-ready prospects in a category |

All 4 settle in USDC on Base via the CDP facilitator (existing `facilitator_mode: 'cdp'` path).

### What's out

- Batch endpoint (`POST /v1/scanner/scan/batch`) — stateful + polling + refunds doesn't fit per-call x402 cleanly. Partner-channel only.
- Per-tenant pricing overrides — every x402 buyer pays the same rate.
- Self-serve x402-buyer dashboard — buyers' wallets settle on-chain; no Sly account needed.

## Approach — leverage what already exists

The `x402_publish` state machine handles everything end-to-end. Per-endpoint work is **one row + one `publishEndpoint` call**:

1. **Create the `x402_endpoints` row** (tenant_id = Sly internal tenant, account_id = Sly platform account, base_price = USDC amount, network = `base`, backend_url = scanner.getsly.ai equivalent, visibility = `public`, facilitator_mode = `cdp`).
2. **Authentication for the backend hop** — gateway needs a `psk_live_*` scanner key with full scopes to call the backend on behalf of x402 buyers. Issue one via `apps/scanner/scripts/issue-partner-key.ts` against the Sly internal tenant; store as `GATEWAY_SCANNER_KEY` env var. Gateway adds it as `Authorization: Bearer ${GATEWAY_SCANNER_KEY}` when proxying.
3. **Discovery metadata** — `name`, `description`, `category` (= "Search" or new "Commerce Intelligence" — see Open question below). Lift descriptions from `docs-site/public/scanner/x402.mdx`.
4. **Output schema** — must declare `schema.properties.output.type === "object"` (lesson from [PR #39](https://github.com/Sly-devs/sly/pull/39)). Scanner responses are objects, so this is straightforward — declare the relevant subset of `MerchantScan` per endpoint.
5. **Call `publishEndpoint(endpoint, { force: true })`** — runs probe → validate → publish → poll. Auto-republish-on-update is already wired.
6. **Wait for the existing poller** to flip status from `processing` → `published`. SLA is 4h; in practice ~10 min.
7. **Verify** appearance at `https://api.agentic.market/v1/services/search?q=scanner` with `provider: "scanner.getsly.ai"`.

### Critical files (existing — to reuse, NOT modify unless noted)

- `apps/api/src/services/publish-x402.ts` — state machine; `publishEndpoint()` entrypoint
- `apps/api/src/services/bazaar-extension.ts` — `buildBazaarExtension()` for the schema. Reuse as-is; scanner outputs are object-typed so the [PR #39](https://github.com/Sly-devs/sly/pull/39) coercion path doesn't trip.
- `apps/api/src/services/endpoint-probe.ts` — pre-publish probe that hits the backend before calling CDP
- `apps/api/src/routes/x402-endpoints.ts` — CRUD for `x402_endpoints` rows
- `apps/api/src/routes/gateway.ts` — proxy that handles incoming x402-paid requests; adds `GATEWAY_BACKEND_TIMEOUT_MS` (existing) and the per-endpoint rate limit from [PR #42](https://github.com/Sly-devs/sly/pull/42)
- `apps/api/src/workers/x402-publish-poller.ts` — flips `processing → published` once CDP indexes the listing
- `apps/scanner/scripts/issue-partner-key.ts` — to mint `GATEWAY_SCANNER_KEY`

### New scripts (small)

- `apps/api/scripts/seed-scanner-x402-endpoints.ts` — idempotent script that creates/updates the 4 `x402_endpoints` rows on the Sly internal tenant from a constant table. Idempotency keys on `(tenant_id, path, method)`. Run once per pricing change.
- `apps/api/scripts/publish-scanner-x402-endpoints.ts` — calls `publishEndpoint(id, { force: true })` for each of the 4 ids. Run once after seed; re-run if metadata changes.

## Stories

### 85.1 — Mint gateway scanner key (1 point)
- Issue a `psk_live_*` key via `apps/scanner/scripts/issue-partner-key.ts <sly-internal-tenant> "x402-gateway"` with scopes `[scan, batch, read, tests]` and a high rate limit (600 rpm).
- Add to gateway env as `GATEWAY_SCANNER_KEY` (Vercel + local `.env.example`).
- Acceptance: `curl -H "Authorization: Bearer $GATEWAY_SCANNER_KEY" $SCANNER/v1/scanner/credits/balance` returns 200.

### 85.2 — Backend-key proxying in gateway (3 points)
- In `apps/api/src/routes/gateway.ts`, when `endpoint.backend_url` matches `scanner.getsly.ai`, inject `Authorization: Bearer ${process.env.GATEWAY_SCANNER_KEY}` on the proxied request. Strip any `X-PAYMENT` / `Authorization` from the inbound (already stripped per the existing security middleware — verify).
- Acceptance: unit test confirms the proxied request to scanner backend has the gateway's bearer token.

### 85.3 — Seed `x402_endpoints` rows (2 points)
- Write `apps/api/scripts/seed-scanner-x402-endpoints.ts` with the 4-row table from the Scope section above.
- Each row: `tenant_id` = Sly internal tenant, `account_id` = platform, `path` = the gateway path, `backend_url` = scanner.getsly.ai equivalent, `base_price` = USDC amount, `network` = `base`, `currency` = `USDC`, `visibility` = `public`, `facilitator_mode` = `cdp`, `service_slug` = `sly-scanner`, `category` = TBD per Open question.
- Acceptance: running the script creates 4 rows with `publish_status = 'draft'`; re-running is a no-op.

### 85.4 — Output schemas per endpoint (3 points)
- For each of the 4 endpoints, declare a `discovery_metadata.output_schema` object that satisfies CDP's `properties.output.type === "object"` constraint.
- For `scan` and `tests`, the schema is a subset of the live `MerchantScan` response (id, domain, readiness_score, sub-scores, protocol_results, business_model, scan_status). For `by-domain` it's the same. For `prospects`, declare the prospect list shape.
- Reuse types from `packages/types/src/scanner.ts` to keep schemas in sync with code.
- Acceptance: `validateBazaarExtension()` (existing) returns no errors for each endpoint.

### 85.5 — Publish + poll (3 points)
- Write `apps/api/scripts/publish-scanner-x402-endpoints.ts` that calls `publishEndpoint(id, { force: true })` for each seeded row.
- Wait on the publish poller (existing) to flip `processing → published`. Timeout: 6h.
- Acceptance: all 4 endpoints reach `publish_status = 'published'`. Verify each appears at `GET https://api.agentic.market/v1/services/search?q=sly-scanner` with the listed price.

### 85.6 — End-to-end verification (3 points)
- Run a paid x402 call against each of the 4 published endpoints from a test wallet (existing `apps/api/scripts/_test-publish-e2e.ts` pattern):
  ```ts
  const fetch = wrapFetchWithPayment(globalThis.fetch, account);
  const res = await fetch('https://api.getsly.ai/x402/scanner/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ domain: 'shopify.com' }),
  });
  ```
- Verify USDC was deducted from test wallet, response matches scanner backend, `X-Request-ID` flows back, gateway logged the call against the right endpoint id.
- Acceptance: 4× successful paid calls; on-chain settle visible on Basescan.

### 85.7 — Auto-refund on backend 4xx/5xx (2 points)
- The scanner backend already auto-refunds 4xx/5xx ([PR #43](https://github.com/Sly-devs/sly/pull/43)) — but that refund flows to the scanner's credit ledger, NOT to the x402 buyer's wallet.
- Decision: when scanner backend returns 4xx/5xx to the gateway, gateway should call the CDP facilitator's refund path so the buyer's USDC is returned. (Or document the gap and accept it for v1.)
- Acceptance: a deliberately malformed `POST /x402/scanner/scan` returns 400 to the buyer AND no USDC is debited from the test wallet. If facilitator refund isn't yet supported in our codebase, file as 85.10 follow-up.

### 85.8 — Pricing change tooling (1 point)
- The pricing constants live in the seed script. Doc-site pricing is in `docs-site/public/scanner/credits-and-billing.mdx` + `x402.mdx`.
- Add a one-liner README in `apps/api/scripts/` explaining "to change x402 prices: edit seed script → re-run seed → re-run publish (with `force: true`) → poller will republish to CDP".
- Acceptance: README exists; pricing change verified end-to-end at least once.

### 85.9 — Listing announcement (1 point — comms, not eng)
- Tweet / LinkedIn / docs banner: "Sly Scanner is live on agentic.market. Per-call USDC. 50% under the closest comparable. Get a partner key for another 80% off."
- Add a top-of-page banner to `scanner/x402.mdx` linking to the agentic.market listing once verified.
- Owner: marketing.

### 85.10 (optional follow-up) — Buyer-side wallet refund on backend errors
Only if 85.7 surfaces a gap. Likely needs CDP facilitator changes; defer.

## Open questions

1. **Category** — `agentic.market` has a `Search` category that Firecrawl uses, and others. The scanner doesn't fit cleanly; closest existing categories are `Search` or `Data`. Options: (a) reuse `Data`, (b) request a `Commerce Intelligence` category from CDP, (c) dual-list. Recommend (a) for v1, request (b) to CDP after listing is live.
2. **Service ID** — the listing surfaces as `id: "<provider>-<service-slug>"` per the catalog format. Confirm `sly-scanner` (or `getsly-scanner`) doesn't collide with an existing entry. Run `curl https://api.agentic.market/v1/services/search?q=sly` before publishing.
3. **Discovery metadata copy** — descriptions are partner-facing marketing. The story uses placeholders from `x402.mdx`; product/marketing should sign off before publishing.

## Verification (full)

1. **Pre-publish** — `pnpm --filter @sly/api test`; new tests cover seed-script idempotency + gateway backend-key injection.
2. **Seed** — run `seed-scanner-x402-endpoints.ts` against staging tenant, confirm 4 rows in `x402_endpoints` with `publish_status = 'draft'`.
3. **Publish** — run `publish-scanner-x402-endpoints.ts`; tail `x402-publish-poller` logs; wait for `published`.
4. **Marketplace check** — `curl https://api.agentic.market/v1/services/search?q=sly-scanner | jq` shows all 4 endpoints with prices matching the seed file.
5. **Paid call** — run `_test-publish-e2e.ts` variant against each of the 4 endpoints from a test wallet; confirm USDC debit + correct response shape.
6. **Audit** — confirm gateway logs show the proxied scanner backend call carrying `X-Request-ID` and the correct backend authorization.

## Estimated total

**18 points** across 8 stories (1 + 3 + 2 + 3 + 3 + 3 + 2 + 1). Realistic 1–2 sprint scope for one engineer; could parallelize stories 85.3/85.4 with 85.1/85.2.

## Out of scope (file as separate epics if needed)

- **Custom domain `scanner.getsly.ai`** for the marketplace listing (currently `sly-scanner.vercel.app`).
- **MCP listing on agentic.market** — separate marketplace, separate work.
- **Other Sly products on x402** (UCP, ACP, AP2 endpoints) — Epic 84 (cross-marketplace publishing) covers some of this; coordinate.
- **Buyer-side dashboard** for x402 buyers — they have wallets, not accounts; the partner dashboard is for partner-channel users.
