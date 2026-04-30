# Epic 84: Cross-Marketplace Publishing for x402 Endpoints

## Summary

Generalize the x402 publish flow from "single-target Coinbase Bazaar" into a pluggable, multi-marketplace fanout. A tenant publishes an endpoint once and Sly fans it out to every catalog the tenant has opted into — Bazaar, A2A registry, MCP registries (Smithery, mcp.run), PaySponge, card-network agent catalogs (Visa VIC, Mastercard Agent Pay), and any future surface that emerges. Per-marketplace lifecycle (validate, publish, unpublish, status-poll) lives behind a uniform interface.

## Motivation

Epic 79's current implementation hardcodes Coinbase as the only catalog target. Every tenant gets one option: agentic.market. That's enough for a launch, but it leaves three real opportunities on the table:

1. **A2A native distribution** — Sly already runs an A2A registry (`apps/api/src/routes/a2a.ts`) where agents discover peer agents via `find_agent` / `list_agents`. Sly-published x402 endpoints aren't surfaced there. A buyer agent that discovered a Sly publisher via A2A can't currently see the publisher's paid catalog.
2. **MCP marketplaces are emerging** — Anthropic's MCP Connectors directory, Smithery, and mcp.run are becoming the de-facto agent tool registries for the Anthropic ecosystem. An x402 endpoint conceptually wraps as an MCP tool ("call this paid API"), but no automatic bridge exists today. Tenants who want their endpoint discoverable from Claude Desktop have to write the MCP server themselves.
3. **Card-network agent catalogs** — Visa VIC and Mastercard Agent Pay (Sly already has scanner support for both at `apps/scanner/src/probes/`) are running agent-commerce pilots with their own discovery surfaces. Sly tenants are paying USDC the card networks would happily route. No publish path exists.

Without this epic, Sly's monetization story is "Coinbase + manual everything else." With it, "publish once, discover everywhere" becomes the platform's pitch.

## Why "publish once" is non-trivial

Each catalog has different shape, vocabulary, and lifecycle:

| Marketplace | Discovery URL | Auth | Submit method | Unpublish? |
|---|---|---|---|---|
| Coinbase Bazaar | `api.cdp.coinbase.com/platform/v2/x402/discovery/resources` | CDP API key | Auto on first settle (no POST) | ❌ no API |
| Sly A2A registry | `apps/api/src/routes/a2a.ts` | Internal | DB row | ✅ flag flip |
| Smithery | `smithery.ai/api/v1/servers` | API key | POST manifest | ✅ DELETE |
| mcp.run | `mcp.run/api/registry` | OAuth | POST manifest | ✅ DELETE |
| Anthropic Connectors | (allowlist via support) | manual | submit form | manual |
| PaySponge | `paysponge.com/api/services` | API key | POST | ✅ DELETE |
| Visa VIC | (NDA, partner-only) | mTLS + JWT | POST | ✅ |
| Mastercard Agent Pay | (partner-only) | API key + signature | POST | ✅ |
| NLWeb | self-hosted (`/.well-known/nlweb.json`) | none | host file | n/a (delete file) |

So the abstraction isn't just "POST to a catalog" — it's a **per-marketplace adapter** that:
- Translates the Sly discovery metadata → that marketplace's shape
- Knows the auth + submission verb
- Knows the polling/confirmation strategy
- Knows whether unpublish is supported and what it means

## Direction confirmed with the user

Phase 3, scoped after the core publish + hardening already shipped. Pluggable adapters with at least 3 targets in v1: Coinbase Bazaar (existing, refactored to use the adapter shape), Sly A2A, and one MCP registry (Smithery — most active, has a documented public API).

## Scope

**In scope (v1):**
- Adapter interface in `apps/api/src/services/marketplaces/`
- Refactor existing CDP publish into a `BazaarAdapter` implementing the interface (no behaviour change)
- Two new adapters: `A2AAdapter`, `SmitheryAdapter`
- `marketplace_publications` table — per-(endpoint, marketplace) lifecycle row
- Per-endpoint marketplace selector in the dashboard publish dialog (checkboxes)
- Per-marketplace status badges on the endpoint detail page
- Extend the `x402_publish_events` audit to include `marketplace` field
- Existing `publish-status` endpoint returns per-marketplace breakdown

**Out of scope (v2+):**
- mcp.run, Anthropic Connectors, PaySponge, Visa VIC, Mastercard Agent Pay, NLWeb — each is a separate adapter PR once we have v1 shape pinned
- Cross-marketplace deduplication / canonical service identity (when the same endpoint shows up in 4 catalogs, do we collapse the listing?)
- Search-aggregation across marketplaces (Sly as a meta-catalog) — separate epic
- Per-marketplace pricing (different price on Coinbase vs Smithery) — would need price-override per publication
- Tenant-supplied marketplace credentials (Phase 1 uses one Sly-managed account per marketplace; per-tenant creds is a Phase 2 follow-up like Bazaar's `tenant_cdp_credentials`)

## Adapter interface

**New file:** `apps/api/src/services/marketplaces/adapter.ts`

```ts
export interface MarketplaceAdapter {
  /** Stable identifier — used as the foreign key in marketplace_publications.marketplace */
  readonly id: 'bazaar' | 'a2a' | 'smithery' | 'mcprun' | 'paysponge' | 'visavic' | 'mcagentpay' | 'nlweb';

  /** Human-readable label for the dashboard. */
  readonly label: string;

  /** Per-marketplace defaults (e.g. Bazaar requires CDP creds, A2A is internal). */
  readonly requiresCredentials: boolean;

  /**
   * Adapter-specific preflight: schema completeness, required fields,
   * any marketplace constraints (e.g. Smithery requires a description ≥ 60
   * chars; Bazaar requires ≥ 20).
   */
  validate(endpoint: X402Endpoint, metadata: X402DiscoveryMetadata): Promise<{
    ok: boolean;
    errors: ValidationError[];
  }>;

  /**
   * Submit the endpoint to this marketplace. Returns the marketplace-side
   * identifier and lifecycle state. May be async (Bazaar's "first-settle
   * triggers indexing" model) or sync (Smithery's POST-and-done model).
   */
  publish(endpoint: X402Endpoint, metadata: X402DiscoveryMetadata): Promise<{
    publicationId?: string;       // marketplace-side ID
    state: 'processing' | 'published' | 'failed';
    error?: string;
    publicListingUrl?: string;    // if available immediately
  }>;

  /**
   * Withdraw from this marketplace. Some marketplaces (Bazaar) have no
   * unpublish API — adapter returns `unsupported` and the UI surfaces
   * the same disclaimer we already show.
   */
  unpublish(publicationId: string): Promise<{
    state: 'unpublished' | 'pending_prune' | 'unsupported';
    error?: string;
  }>;

  /**
   * Confirm catalog visibility. Used by the publish poller.
   * Returns `state: published` once visible.
   */
  pollStatus(publicationId: string, endpoint: X402Endpoint): Promise<{
    state: 'processing' | 'published' | 'failed';
    publicListingUrl?: string;
    error?: string;
  }>;
}
```

## Adapter registry + dispatch

**New file:** `apps/api/src/services/marketplaces/registry.ts`

```ts
const REGISTRY = new Map<string, MarketplaceAdapter>();

export function registerMarketplace(a: MarketplaceAdapter): void;
export function getMarketplace(id: string): MarketplaceAdapter | null;
export function listMarketplaces(): MarketplaceAdapter[];
```

`apps/api/src/index.ts` registers each adapter at boot. Adding a new marketplace = a single `registerMarketplace(new SmitheryAdapter())` line — no other plumbing.

## Refactor: existing `publish-x402.ts` → `BazaarAdapter`

**Edit:** Move the CDP-specific logic out of `services/publish-x402.ts` into `services/marketplaces/bazaar-adapter.ts`. The publish service becomes the orchestrator:

1. Resolve the list of marketplaces this endpoint is opted into (`marketplace_publications` rows).
2. For each: `await adapter.validate()`, `await adapter.publish()`.
3. Aggregate results into the existing `PublishResult` shape (now with a `byMarketplace` breakdown).
4. Each adapter call writes its own `x402_publish_events` row with `marketplace: '<id>'`.

Auto-republish on PATCH: when discovery-relevant fields change, re-publish to **every** opted-in marketplace.

Backward compatibility: an endpoint with no `marketplace_publications` rows but `facilitator_mode='cdp'` (the current state in prod) gets a one-time backfill on first read — automatically opted into Bazaar.

## Schema

**Migration:** `YYYYMMDD_marketplace_publications.sql`

```sql
CREATE TABLE marketplace_publications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  endpoint_id UUID NOT NULL REFERENCES x402_endpoints(id) ON DELETE CASCADE,
  marketplace TEXT NOT NULL,                -- 'bazaar' | 'a2a' | 'smithery' | ...
  publication_id TEXT,                      -- marketplace-side ID once known
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','published','failed','unpublished')),
  public_listing_url TEXT,
  last_error TEXT,
  last_published_at TIMESTAMPTZ,
  last_polled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (endpoint_id, marketplace)
);

ALTER TABLE x402_publish_events
  ADD COLUMN marketplace TEXT;              -- nullable for backward compat
```

RLS: same tenant-scoped pattern as `x402_publish_events`.

## v1 adapter implementations

### `BazaarAdapter` (refactor — no behaviour change)

Wraps the current CDP Facilitator path. `validate` runs the existing bazaar-extension validators. `publish` triggers the self-paid first-settle. `unpublish` returns `state: 'unsupported'` with the existing disclaimer copy. `pollStatus` calls into the existing poller logic.

### `A2AAdapter` (net-new)

Sly's A2A registry is internal — no external API to call. The adapter:
- `validate` confirms the endpoint has a description and at least one accepts entry (A2A doesn't need a JSON Schema like Bazaar does)
- `publish` inserts a row in `agent_skills` (or whatever table A2A's `find_agent` searches) with `kind: 'x402_endpoint'`, `gateway_url`, `pricing`. Returns `state: 'published'` synchronously.
- `unpublish` flips the row's `active=false`. Synchronous, complete.
- `pollStatus` is a no-op — A2A is internal so visibility is immediate.

### `SmitheryAdapter` (net-new)

Smithery treats services as "MCP servers." We translate an x402 endpoint into a single-tool MCP server descriptor:
- `validate` checks the endpoint has a description ≥ 60 chars (Smithery's threshold), input/output examples, and a unique `qualifiedName` (`sly/{tenant_slug}-{service_slug}`).
- `publish` POSTs to `https://smithery.ai/api/v1/servers` with the manifest. Smithery returns a `serverId` synchronously.
- `unpublish` `DELETE /api/v1/servers/{serverId}`.
- `pollStatus` GETs the server detail, returns `state: 'published'` once `status === 'active'`.

Smithery doesn't natively understand x402 paid endpoints — they assume MCP-over-stdio or HTTP transport. The MCP server we describe is a thin shim hosted at `https://api.getsly.ai/mcp/x402/{tenant}/{service}` that exposes a single `pay` tool calling our gateway. That shim infrastructure is part of this epic's scope.

## Dashboard UI

**Edit:** `apps/web/src/components/x402/publish-to-market-dialog.tsx`

After the readiness checklist, add a **Marketplaces** step:

```
☑ Coinbase Bazaar (agentic.market)
☑ Sly Agent Registry (A2A)
☐ Smithery
☐ mcp.run                        [coming soon]
☐ Anthropic Connectors           [coming soon]
```

Each marketplace shows a per-target preflight result. After publish, the Publication Timeline expands to show events grouped by marketplace.

The `Manage publication` mode lets the tenant toggle marketplaces individually — checking a new box runs the validate+publish flow for just that adapter; unchecking runs unpublish.

## API surface additions

Existing routes return a `byMarketplace` breakdown:

- `GET /v1/x402/endpoints/:id/publish-status` →
  ```json
  {
    "publishStatus": "published",     // overall (worst state across opted-in)
    "byMarketplace": {
      "bazaar":   { "status": "published", "publicListingUrl": "..." },
      "a2a":      { "status": "published", "publicListingUrl": "..." },
      "smithery": { "status": "processing" }
    }
  }
  ```

- `POST /v1/x402/endpoints/:id/publish` accepts `{ marketplaces: ['bazaar','a2a','smithery'] }`. Default = all opted-in.
- `POST /v1/x402/endpoints/:id/unpublish` accepts `{ marketplaces?: string[] }`. Default = all currently-published.

## Critical files

**Modify**
- `apps/api/src/services/publish-x402.ts` — orchestrator over adapter registry
- `apps/api/src/workers/x402-publish-poller.ts` — per-marketplace poll loop
- `apps/api/src/routes/x402-endpoints.ts` — accept `marketplaces` parameter on publish/unpublish
- `apps/web/src/components/x402/publish-to-market-dialog.tsx` — marketplace selector + per-target status
- `apps/web/src/components/x402/publication-timeline.tsx` — group events by marketplace
- `packages/types/src/index.ts` — `MarketplaceId`, `MarketplacePublicationState`

**Create**
- Migration `YYYYMMDD_marketplace_publications.sql`
- `apps/api/src/services/marketplaces/adapter.ts` — interface
- `apps/api/src/services/marketplaces/registry.ts` — registration + lookup
- `apps/api/src/services/marketplaces/bazaar-adapter.ts` — refactored from existing
- `apps/api/src/services/marketplaces/a2a-adapter.ts`
- `apps/api/src/services/marketplaces/smithery-adapter.ts`
- `apps/api/src/routes/mcp-shim.ts` — the per-tenant MCP-server shim that Smithery indexes
- Test suites for each adapter

## Verification

1. **Unit tests** per adapter: `validate` happy path + every constraint, `publish` mocked with the marketplace's expected request/response shape, `unpublish` for adapters that support it (and the `unsupported` branch for Bazaar).
2. **Orchestrator test** in `publish-x402.test.ts`: opt into 3 marketplaces, mock 2 to succeed and 1 to fail, assert overall state is `failed` (worst-of) but `byMarketplace` reflects all three.
3. **Backfill migration test**: an endpoint with `facilitator_mode='cdp'` and no `marketplace_publications` rows gets one Bazaar row written on first read.
4. **Manual e2e**:
   - Publish the existing `/x402/demo/poem` to Smithery → confirm it appears at `https://smithery.ai/server/sly-demo-poem` within a few minutes.
   - Search for the demo endpoint via A2A from a buyer agent → confirm it's returned.
   - Edit description on a multi-marketplace endpoint → confirm all three adapters re-publish.
5. **Idempotency**: re-publishing a clean endpoint to the same marketplaces is a no-op.

## Risks & open questions

- **MCP-shim hosting scale**: every Smithery-published Sly endpoint creates one shim MCP server URL we must serve. At low volume this is fine (one Hono route doing the same auth+route lookup we already do for the gateway). At 10k+ shims we may want a separate worker, or generate one shared MCP server with multiple tools.
- **Smithery's content guidelines**: paid services are allowed but they manually review descriptions and reject promotional language. Some Sly tenants will write descriptions Smithery rejects — adapter needs to surface this as a `failed` state, not silently drop.
- **Bazaar staleness**: Coinbase still has no unpublish API. When a tenant unchecks Bazaar in the dashboard, our DB flips to unpublished but agentic.market still shows the listing. Same disclaimer copy from Epic 79's unpublish dialog applies.
- **Search dedup across marketplaces**: when a user discovers the same endpoint on Bazaar AND Smithery AND A2A, are they three distinct buy paths or one canonical service? v1 says three separate listings; v2 explores a Sly-issued canonical id that all marketplaces reference.
- **Cost of fanout failure**: if Bazaar requires a self-paid first-settle (~$0.001), publishing to 5 marketplaces compounds — the probe wallet drains 5x faster. v1 limits the probe-spend per publish to 1 settle (Bazaar only); other adapters use sync APIs.

## Out of scope (Phase 4 follow-ups)

- mcp.run, Anthropic Connectors, PaySponge, Visa VIC, Mastercard Agent Pay, NLWeb adapters
- Per-tenant marketplace credentials (today everything uses Sly-managed accounts)
- Cross-marketplace canonical service id
- Marketplace-aware analytics ("70% of revenue came from buyers discovered on Smithery")
- Per-marketplace pricing overrides
- Tenant-controlled marketplace ranking/featured placement (most marketplaces don't expose ranking APIs anyway)

## Phasing

| Phase | Scope | Effort |
|---|---|---|
| **P1** | Adapter interface + registry, Bazaar refactor, A2A adapter, schema, dashboard checkbox UI | ~1 week |
| P2 | Smithery adapter + MCP shim hosting | ~1 week |
| P3 | mcp.run + PaySponge adapters | ~1 week |
| P4 | Card-network adapters (Visa VIC + Mastercard Agent Pay) — partner-gated | dependent on partner timelines |
| P5 | NLWeb + per-tenant credentials + canonical id (cross-marketplace dedup) | separate epic |
