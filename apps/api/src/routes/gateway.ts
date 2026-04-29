/**
 * x402 Bazaar Gateway (Worktree C — One-Click Publish)
 *
 * Sly-hosted x402 gateway that fronts published tenant endpoints at
 * `https://{tenant.slug}.x402.getsly.ai/{service_slug}` and routes
 * verify+settle through Coinbase's CDP Facilitator so they get indexed
 * on Coinbase's Bazaar catalog (agentic.market).
 *
 * Request flow:
 *
 *   Buyer ──GET──▶ acme.x402.getsly.ai/weather (Sly gateway)
 *                  │ 402 + bazaar extension
 *                  ▼
 *   Buyer ──GET + X-PAYMENT──▶ Sly gateway ──verify+settle──▶ CDP Facilitator
 *                                                  │
 *                                                  │ EXTENSION-RESPONSES
 *                                                  ▼
 *                              Sly gateway ──HMAC-signed proxy──▶ tenant backend_url
 *                                                  ◀──response──────────
 *   Buyer ◀──response + receipt header── Sly gateway
 *
 * Mounted as host-routed middleware in apps/api/src/app.ts BEFORE the
 * /v1/* control-plane routes. Hosts that don't match `*.x402.getsly.ai`
 * (or staging/local equivalents) fall through.
 */

import type { Context, MiddlewareHandler, Next } from 'hono';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createClient } from '../db/client.js';
import { getCdpCredentials } from '../services/coinbase/cdp-client.js';

// ──────────────────────────────────────────────────────────────────────────
// Config
// ──────────────────────────────────────────────────────────────────────────

/** Hostname suffix the gateway claims (no leading dot). */
const DEFAULT_HOSTNAME_SUFFIX = 'x402.getsly.ai';

/** Reserved slugs that may collide with first-level subdomains we want later. */
const DEFAULT_RESERVED_SLUGS = [
  'api',
  'app',
  'dashboard',
  'admin',
  'www',
  'staging',
  'sandbox',
  'docs',
  'status',
  'auth',
];

/**
 * Suffixes the gateway will treat as gateway hosts. Any of these match wins.
 * - prod:    `x402.getsly.ai`
 * - staging: `x402-staging.getsly.ai`
 * - local:   `x402.getsly.ai.localhost` (browsers/curl resolve `*.localhost` → 127.0.0.1)
 *            and `x402-staging.getsly.ai.localhost` for staging-shaped local tests.
 */
function getGatewaySuffixes(): string[] {
  const primary = (process.env.GATEWAY_HOSTNAME_SUFFIX || DEFAULT_HOSTNAME_SUFFIX).toLowerCase();
  // Staging variant: replace leading "x402" with "x402-staging" if applicable.
  const stagingDerived = primary.startsWith('x402.')
    ? `x402-staging.${primary.slice('x402.'.length)}`
    : null;

  const suffixes = new Set<string>([primary]);
  if (stagingDerived) suffixes.add(stagingDerived);

  // Local-dev variants (`*.x402.getsly.ai.localhost`)
  for (const s of Array.from(suffixes)) {
    suffixes.add(`${s}.localhost`);
  }

  return Array.from(suffixes);
}

function getReservedSlugs(): Set<string> {
  const raw = process.env.GATEWAY_RESERVED_SLUGS;
  const list = raw
    ? raw
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    : DEFAULT_RESERVED_SLUGS;
  return new Set(list);
}

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

/**
 * Bazaar discovery extension shape (mirrors `X402DiscoveryMetadata` from
 * `@sly/api-client/types`). Worktree B's publish flow writes this into
 * `x402_endpoints.discovery_metadata`. The gateway only reads it.
 */
export interface X402DiscoveryMetadata {
  description: string;
  category?: string;
  input?: {
    schema?: Record<string, unknown>;
    example?: unknown;
  };
  output?: {
    schema?: Record<string, unknown>;
    example?: unknown;
  };
  bodyType?: 'json';
}

interface ParsedHost {
  /** Sly tenant slug (subdomain). */
  slug: string;
  /** Suffix the gateway recognised this host under. */
  matchedSuffix: string;
}

interface EndpointRow {
  id: string;
  tenant_id: string;
  account_id: string;
  service_slug: string | null;
  backend_url: string | null;
  backend_auth: { hmac_secret?: string; header?: string; bearer?: string } | null;
  base_price: string | number;
  currency: string | null;
  network: string | null;
  asset_address: string | null;
  payment_address: string | null;
  visibility: string | null;
  publish_status: string | null;
  facilitator_mode: string | null;
  discovery_metadata: X402DiscoveryMetadata | null;
  description: string | null;
  method: string | null;
}

interface TenantRow {
  id: string;
  slug: string | null;
  status: string | null;
}

interface PayoutWalletRow {
  address: string;
  network: string;
}

interface SettleResult {
  ok: boolean;
  txHash?: string;
  rawSettleHeader?: string;
  rawVerifyHeader?: string;
  extensionResponses?: string;
  error?: string;
  status?: number;
}

// ──────────────────────────────────────────────────────────────────────────
// Host parsing
// ──────────────────────────────────────────────────────────────────────────

/**
 * Parse the Host header and decide whether this request belongs to the gateway.
 *
 * Rules:
 * - Host must end with one of the configured gateway suffixes.
 * - Exactly ONE label of subdomain in front of the suffix (e.g. `acme.x402.getsly.ai`).
 *   Multi-level subdomains like `api.acme.x402.getsly.ai` are rejected to keep
 *   the namespace flat and avoid DNS/cert ambiguity.
 * - Returns null when the host does not match any suffix → caller should fall
 *   through to non-gateway routes.
 */
export function parseGatewayHost(hostHeader: string | undefined | null): ParsedHost | null {
  if (!hostHeader) return null;
  // Strip port if present (e.g. `acme.x402.getsly.ai.localhost:4000`).
  const hostNoPort = hostHeader.split(':')[0]?.trim().toLowerCase();
  if (!hostNoPort) return null;

  const suffixes = getGatewaySuffixes();
  // Prefer the longest-matching suffix so `x402-staging.getsly.ai.localhost`
  // wins over `x402-staging.getsly.ai` when both are configured.
  const matched = suffixes
    .filter((s) => hostNoPort === s || hostNoPort.endsWith(`.${s}`))
    .sort((a, b) => b.length - a.length)[0];
  if (!matched) return null;

  // Exact match (no subdomain) is not a gateway request — it's the apex.
  if (hostNoPort === matched) return null;

  // Strip the suffix; whatever remains must be a single label.
  const subdomainPart = hostNoPort.slice(0, hostNoPort.length - matched.length - 1);
  if (!subdomainPart) return null;
  if (subdomainPart.includes('.')) {
    // Multi-level subdomain like api.acme.x402.getsly.ai — explicit reject.
    return { slug: '__INVALID_MULTILEVEL__', matchedSuffix: matched };
  }

  // Validate slug shape (same regex as DB constraint on tenants.slug callers
  // expect: lowercase alnum + hyphen, 2-40 chars).
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(subdomainPart)) {
    return { slug: '__INVALID_SHAPE__', matchedSuffix: matched };
  }

  return { slug: subdomainPart, matchedSuffix: matched };
}

/**
 * Returns true if the slug is reserved at the application layer and must
 * never be used as a tenant subdomain.
 */
export function isReservedSlug(slug: string): boolean {
  return getReservedSlugs().has(slug.toLowerCase());
}

// ──────────────────────────────────────────────────────────────────────────
// 402 challenge construction
// ──────────────────────────────────────────────────────────────────────────

/**
 * Build the `accepts` array for the 402 challenge. Phase 1 emits a single
 * accept matching the endpoint's network/currency/payTo.
 */
function buildAcceptsArray(endpoint: EndpointRow, payTo: string): unknown[] {
  const network = normalizeNetwork(endpoint.network);
  const baseAmount = typeof endpoint.base_price === 'string'
    ? endpoint.base_price
    : String(endpoint.base_price);
  // x402 spec uses minor units for ERC-20 (USDC/EURC = 6 decimals).
  const decimals = 6;
  const amountMinor = toMinorUnits(baseAmount, decimals);

  return [
    {
      scheme: 'exact',
      network,
      maxAmountRequired: amountMinor,
      resource: '', // populated by caller (full request URL)
      description: endpoint.description ?? '',
      mimeType: 'application/json',
      payTo,
      maxTimeoutSeconds: 60,
      asset: endpoint.asset_address ?? null,
      extra: {
        name: endpoint.currency || 'USDC',
        version: '2',
      },
    },
  ];
}

function toMinorUnits(amount: string, decimals: number): string {
  // Avoid floating-point drift: split on '.' and pad.
  const [whole, frac = ''] = amount.split('.');
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  const combined = `${whole}${fracPadded}`.replace(/^0+(?=\d)/, '');
  return combined || '0';
}

function normalizeNetwork(network: string | null | undefined): string {
  if (!network) return 'base';
  // CAIP-2 → x402 short name mapping (Bazaar prefers short names).
  switch (network) {
    case 'eip155:8453':
    case 'base-mainnet':
      return 'base';
    case 'eip155:84532':
    case 'base-sepolia':
      return 'base-sepolia';
    default:
      return network;
  }
}

/**
 * The full bazaar extension blob is read straight from
 * `endpoint.discovery_metadata`. The plan declares this column as the
 * frozen extension payload populated by Worktree B's publish flow.
 */
function buildBazaarExtension(metadata: X402DiscoveryMetadata): X402DiscoveryMetadata {
  return metadata;
}

// ──────────────────────────────────────────────────────────────────────────
// Backend proxy + HMAC signing
// ──────────────────────────────────────────────────────────────────────────

const ALLOWED_PROXY_HEADERS = new Set([
  'accept',
  'accept-language',
  'content-type',
  'user-agent',
  'x-request-id',
]);

const STRIPPED_PROXY_HEADERS = new Set([
  'host',
  'cookie',
  'authorization',
  'x-payment',
]);

/**
 * Compute the X-Sly-Signature value: sha256({hmac_secret}({timestamp}.{method}.{path}.{body_hash}))
 * Returns hex digest.
 */
export function computeSlyHmacSignature(input: {
  hmacSecret: string;
  timestampMs: number;
  method: string;
  path: string;
  body: Buffer | string;
}): string {
  const { hmacSecret, timestampMs, method, path, body } = input;
  const bodyBuf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  const bodyHash = createHash('sha256').update(bodyBuf).digest('hex');
  const message = `${timestampMs}.${method.toUpperCase()}.${path}.${bodyHash}`;
  return createHmac('sha256', hmacSecret).update(message).digest('hex');
}

/**
 * Constant-time signature comparison helper (exported for completeness, used
 * by tenant backends to verify our signatures).
 */
export function verifySlyHmacSignature(expectedHex: string, actualHex: string): boolean {
  if (expectedHex.length !== actualHex.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expectedHex, 'hex'), Buffer.from(actualHex, 'hex'));
  } catch {
    return false;
  }
}

interface ProxyRequestOptions {
  backendUrl: string;
  method: string;
  servicePath: string;
  buyerHeaders: Headers;
  body: Buffer | undefined;
  hmacSecret?: string;
}

/**
 * Build the outbound headers for the backend proxy. Strips buyer auth/cookie
 * material, forwards a small allowlist, and attaches HMAC headers if the
 * endpoint has `backend_auth.hmac_secret` set.
 */
export function buildProxyHeaders(opts: ProxyRequestOptions): Record<string, string> {
  const headers: Record<string, string> = {};
  opts.buyerHeaders.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (STRIPPED_PROXY_HEADERS.has(lower)) return;
    if (lower.startsWith('x-sly-')) return; // never forward our own namespace
    if (ALLOWED_PROXY_HEADERS.has(lower)) {
      headers[lower] = value;
    }
  });

  if (opts.hmacSecret) {
    const ts = Date.now();
    const sig = computeSlyHmacSignature({
      hmacSecret: opts.hmacSecret,
      timestampMs: ts,
      method: opts.method,
      path: opts.servicePath,
      body: opts.body ?? Buffer.alloc(0),
    });
    headers['x-sly-timestamp'] = String(ts);
    headers['x-sly-signature'] = `sha256=${sig}`;
  }

  return headers;
}

// ──────────────────────────────────────────────────────────────────────────
// CDP Facilitator client
// ──────────────────────────────────────────────────────────────────────────

/**
 * Minimal CDP facilitator client. Worktree B will likely swap this for the
 * `@coinbase/x402` SDK once that dep lands; until then, a direct HTTP call
 * keeps the gateway buildable without the dependency.
 *
 * Returns a structured result with the EXTENSION-RESPONSES header so the
 * caller can persist publish state.
 */
async function callCdpVerifyAndSettle(input: {
  paymentHeader: string;
  accepts: unknown;
  resourceUrl: string;
}): Promise<SettleResult> {
  const facilitatorUrl = process.env.CDP_FACILITATOR_URL || 'https://api.cdp.coinbase.com/platform/v2/x402';
  const creds = getCdpCredentials();

  // In test/dev without CDP creds, short-circuit so the gateway can be smoke-tested.
  if (!creds) {
    return {
      ok: false,
      error: 'CDP facilitator not configured',
      status: 500,
    };
  }
  const { apiKeyId, apiKeySecret } = creds;

  // CDP Facilitator authenticates with a Bearer JWT signed with the API
  // key (ES256). @coinbase/x402's createAuthHeader generates it for us
  // — same scheme the official SDK uses internally. Soft-fail on JWT
  // errors so unit tests with mock creds still exercise the response
  // parsing; in prod a missing auth header will produce a real 401
  // which the non-2xx branch below handles.
  let authHeader: string | undefined;
  try {
    const { createAuthHeader } = await import('@coinbase/x402');
    const url = new URL(facilitatorUrl);
    authHeader = await createAuthHeader(
      apiKeyId,
      apiKeySecret,
      'POST',
      url.host,
      `${url.pathname}/settle`.replace(/\/+/g, '/')
    );
  } catch (err: any) {
    console.warn('[gateway] JWT generation failed, proceeding unsigned:', err?.message);
  }

  // CDP exposes /verify and /settle; we call settle which performs verify
  // implicitly, returning the EXTENSION-RESPONSES header on the response.
  const settleHeaders: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (authHeader) settleHeaders.Authorization = authHeader;

  const settleRes = await fetch(`${facilitatorUrl}/settle`, {
    method: 'POST',
    headers: settleHeaders,
    body: JSON.stringify({
      paymentHeader: input.paymentHeader,
      paymentRequirements: input.accepts,
      resource: input.resourceUrl,
    }),
  }).catch((err) => {
    return new Response(
      JSON.stringify({ error: err?.message || 'fetch failed' }),
      { status: 502 },
    );
  });

  const extensionResponses = settleRes.headers.get('extension-responses') ?? undefined;
  let body: any = null;
  try {
    body = await settleRes.json();
  } catch {
    // Non-JSON body is acceptable for some failure paths.
  }

  if (!settleRes.ok) {
    return {
      ok: false,
      status: settleRes.status,
      error: body?.error || body?.message || `CDP settle failed (${settleRes.status})`,
      extensionResponses,
    };
  }

  return {
    ok: true,
    txHash: body?.transactionHash || body?.txHash,
    extensionResponses,
    rawSettleHeader: settleRes.headers.get('x-payment-response') ?? undefined,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// DB lookups (always tenant-filtered)
// ──────────────────────────────────────────────────────────────────────────

async function lookupTenantBySlug(slug: string): Promise<TenantRow | null> {
  const supabase: any = createClient();
  const { data } = await supabase
    .from('tenants')
    .select('id, slug, status')
    .eq('slug', slug)
    .limit(1)
    .maybeSingle();
  return (data as TenantRow) || null;
}

async function lookupEndpoint(
  tenantId: string,
  serviceSlug: string,
): Promise<EndpointRow | null> {
  const supabase: any = createClient();
  const { data } = await supabase
    .from('x402_endpoints')
    .select(
      'id, tenant_id, account_id, service_slug, backend_url, backend_auth, base_price, currency, network, asset_address, payment_address, visibility, publish_status, facilitator_mode, discovery_metadata, description, method',
    )
    .eq('tenant_id', tenantId)
    .eq('service_slug', serviceSlug)
    .limit(1)
    .maybeSingle();
  return (data as EndpointRow) || null;
}

async function lookupPayoutWallet(
  tenantId: string,
  accountId: string,
  network: string,
): Promise<PayoutWalletRow | null> {
  const supabase: any = createClient();
  // Try both CAIP-2 form and Sly slug — schema permits either.
  const candidates = [network, normalizeNetwork(network)];
  const { data } = await supabase
    .from('tenant_payout_wallets')
    .select('address, network')
    .eq('tenant_id', tenantId)
    .eq('account_id', accountId)
    .in('network', Array.from(new Set(candidates)))
    .limit(1)
    .maybeSingle();
  return (data as PayoutWalletRow) || null;
}

async function recordSettleEvent(input: {
  tenantId: string;
  endpointId: string;
  ok: boolean;
  txHash?: string;
  extensionResponses?: string;
  error?: string;
}): Promise<void> {
  const supabase: any = createClient();

  // Update endpoint state
  const update: Record<string, unknown> = {
    last_settle_at: new Date().toISOString(),
  };
  if (input.ok) {
    // Promote to publishing/processing if extension is processing/indexed.
    if (input.extensionResponses?.toLowerCase().includes('rejected')) {
      update.publish_status = 'failed';
      update.publish_error = `extension_rejected: ${input.extensionResponses}`;
    } else if (input.extensionResponses) {
      // 'processing' or future statuses
      update.publish_status = 'processing';
      update.publish_error = null;
    }
  } else {
    update.publish_error = input.error || 'settle_failed';
  }

  await supabase
    .from('x402_endpoints')
    .update(update)
    .eq('id', input.endpointId)
    .eq('tenant_id', input.tenantId);

  // Insert audit row
  await supabase.from('x402_publish_events').insert({
    tenant_id: input.tenantId,
    endpoint_id: input.endpointId,
    actor_type: 'system',
    actor_id: null,
    event: input.ok && !input.extensionResponses?.toLowerCase().includes('rejected')
      ? 'first_settle'
      : 'extension_rejected',
    details: {
      via: 'gateway',
      tx_hash: input.txHash || null,
      extension_responses: input.extensionResponses || null,
      error: input.error || null,
    },
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Gateway handler
// ──────────────────────────────────────────────────────────────────────────

interface HandleGatewayDeps {
  /** Override CDP call for tests. */
  callFacilitator?: typeof callCdpVerifyAndSettle;
  /** Override backend fetch for tests. */
  fetchBackend?: typeof fetch;
}

/**
 * Core gateway handler. Returns a Response to send back to the buyer.
 * Pulled out of the middleware shell so unit tests can drive it directly.
 */
export async function handleGatewayRequest(
  c: Context,
  deps: HandleGatewayDeps = {},
): Promise<Response> {
  const hostHeader = c.req.header('host');
  const parsed = parseGatewayHost(hostHeader);
  if (!parsed) {
    return jsonResponse(404, { error: 'gateway_not_found' });
  }

  if (parsed.slug === '__INVALID_MULTILEVEL__') {
    return jsonResponse(404, {
      error: 'invalid_gateway_host',
      detail: 'multi-level subdomains are not supported',
    });
  }
  if (parsed.slug === '__INVALID_SHAPE__') {
    return jsonResponse(404, { error: 'invalid_tenant_slug' });
  }

  const url = new URL(c.req.url);
  const pathParts = url.pathname.split('/').filter(Boolean);
  const serviceSlug = pathParts[0];
  if (!serviceSlug) {
    return jsonResponse(404, { error: 'service_not_specified' });
  }

  return dispatchGatewayRequest(c, deps, {
    tenantSlug: parsed.slug,
    serviceSlug,
    pathPrefix: `/${serviceSlug}`,
  });
}

/**
 * Path-based gateway handler used while wildcard DNS (`*.x402.getsly.ai`) is
 * being provisioned. URL shape: `https://api.getsly.ai/x402/{tenant}/{service}/...`.
 * Mount under `/x402/:tenant/:service` and `/x402/:tenant/:service/*`.
 *
 * Once DNS is live, host-routed `gatewayMiddleware()` is the canonical entry
 * point and this handler can be retired. Both share `dispatchGatewayRequest()`.
 */
export async function handlePathBasedGatewayRequest(
  c: Context,
  deps: HandleGatewayDeps = {},
): Promise<Response> {
  const tenantSlug = (c.req.param('tenant') || '').toLowerCase();
  const serviceSlug = (c.req.param('service') || '').toLowerCase();

  if (!tenantSlug || !serviceSlug) {
    return jsonResponse(404, { error: 'gateway_not_found' });
  }
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(tenantSlug)) {
    return jsonResponse(404, { error: 'invalid_tenant_slug' });
  }
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(serviceSlug)) {
    return jsonResponse(404, { error: 'invalid_service_slug' });
  }

  return dispatchGatewayRequest(c, deps, {
    tenantSlug,
    serviceSlug,
    pathPrefix: `/x402/${tenantSlug}/${serviceSlug}`,
  });
}

interface DispatchContext {
  tenantSlug: string;
  serviceSlug: string;
  /**
   * URL prefix to strip when forming the backend URL.
   * Host-based: `/{serviceSlug}` (path is just service + remainder).
   * Path-based: `/x402/{tenantSlug}/{serviceSlug}`.
   */
  pathPrefix: string;
}

async function dispatchGatewayRequest(
  c: Context,
  deps: HandleGatewayDeps,
  ctx: DispatchContext,
): Promise<Response> {
  const callFacilitator = deps.callFacilitator || callCdpVerifyAndSettle;
  const fetchImpl: typeof fetch = deps.fetchBackend || ((globalThis as any).fetch as typeof fetch);

  // Application-layer reserved-slug guard — block BEFORE any DB lookup so
  // a tenant can never claim `api`, `app`, etc. even if one slipped past
  // slug provisioning.
  if (isReservedSlug(ctx.tenantSlug)) {
    return jsonResponse(404, { error: 'reserved_slug' });
  }

  const tenant = await lookupTenantBySlug(ctx.tenantSlug);
  if (!tenant) {
    return jsonResponse(404, { error: 'tenant_not_found' });
  }

  const endpoint = await lookupEndpoint(tenant.id, ctx.serviceSlug);
  if (!endpoint) {
    return jsonResponse(404, { error: 'endpoint_not_found' });
  }

  const hostHeader = c.req.header('host') || '';
  const url = new URL(c.req.url);

  // Visibility check — gateway only serves public endpoints.
  if (endpoint.visibility !== 'public') {
    return jsonResponse(404, { error: 'endpoint_not_public' });
  }

  // discovery_metadata must be present — Worktree B's publish flow populates
  // this. If it's null, the endpoint isn't ready to publish.
  if (!endpoint.discovery_metadata) {
    return jsonResponse(404, { error: 'endpoint_metadata_missing' });
  }

  // backend_url is required for proxying.
  if (!endpoint.backend_url) {
    return jsonResponse(404, { error: 'endpoint_backend_url_missing' });
  }

  // Resolve payTo from tenant_payout_wallets for the endpoint's network.
  const wallet = await lookupPayoutWallet(
    tenant.id,
    endpoint.account_id,
    endpoint.network || 'base-mainnet',
  );
  if (!wallet) {
    return jsonResponse(404, { error: 'payout_wallet_not_bound' });
  }

  // ── 402 challenge ────────────────────────────────────────────────────
  const paymentHeader = c.req.header('x-payment');
  const resourceUrl = `https://${hostHeader}${url.pathname}${url.search}`;
  const accepts = buildAcceptsArray(endpoint, wallet.address).map((a: any) => ({
    ...a,
    resource: resourceUrl,
  }));

  if (!paymentHeader) {
    const body = {
      x402Version: 1,
      accepts,
      error: 'X-PAYMENT header required',
      extensions: {
        bazaar: buildBazaarExtension(endpoint.discovery_metadata),
      },
    };
    return new Response(JSON.stringify(body), {
      status: 402,
      headers: {
        'content-type': 'application/json',
        // CDP-required headers per @coinbase/x402 SDK conventions.
        'x402-version': '1',
        'access-control-expose-headers': 'EXTENSION-RESPONSES, X-Payment-Receipt',
      },
    });
  }

  // ── Verify + settle through CDP Facilitator ──────────────────────────
  const settle = await callFacilitator({
    paymentHeader,
    accepts,
    resourceUrl,
  });

  // Persist the settle outcome regardless of success — drives publish_status
  // transitions and audit timeline.
  try {
    await recordSettleEvent({
      tenantId: tenant.id,
      endpointId: endpoint.id,
      ok: settle.ok,
      txHash: settle.txHash,
      extensionResponses: settle.extensionResponses,
      error: settle.error,
    });
  } catch (e) {
    // Audit failures must not break the proxy path.
    console.error('[gateway] failed to record settle event', e);
  }

  if (!settle.ok) {
    return jsonResponse(settle.status === 402 ? 402 : 502, {
      error: 'settlement_failed',
      detail: settle.error,
      ...(settle.extensionResponses ? { extensionResponses: settle.extensionResponses } : {}),
    });
  }

  // ── Proxy to backend ─────────────────────────────────────────────────
  const buyerMethod = c.req.method;
  // The path the tenant's backend sees — drops the gateway prefix so
  // `acme.x402.getsly.ai/weather/today?units=metric` proxies to
  // `{backend_url}/today?units=metric`. For path-based routing, the prefix
  // is `/x402/{tenant}/{service}` instead of just `/{service}`.
  const remainder = url.pathname.slice(ctx.pathPrefix.length) || '/';
  const backendBase = endpoint.backend_url.replace(/\/+$/, '');
  const backendTarget = `${backendBase}${remainder}${url.search}`;

  let bodyBuf: Buffer | undefined;
  if (buyerMethod !== 'GET' && buyerMethod !== 'HEAD') {
    const ab = await c.req.arrayBuffer().catch(() => null);
    if (ab) bodyBuf = Buffer.from(ab);
  }

  const proxyHeaders = buildProxyHeaders({
    backendUrl: backendTarget,
    method: buyerMethod,
    servicePath: `${remainder}${url.search}`,
    buyerHeaders: new Headers(rawHeaders(c)),
    body: bodyBuf,
    hmacSecret: endpoint.backend_auth?.hmac_secret,
  });

  let backendRes: Response;
  try {
    backendRes = await fetchImpl(backendTarget, {
      method: buyerMethod,
      headers: proxyHeaders,
      body: bodyBuf as any, // undici accepts Buffer
    });
  } catch (err: any) {
    return jsonResponse(502, {
      error: 'backend_unreachable',
      detail: err?.message || String(err),
    });
  }

  // Stream response back, preserving status + content-type, attaching the
  // x402 receipt headers.
  const respHeaders = new Headers();
  backendRes.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    // Drop hop-by-hop headers and anything tenant-leaky.
    if (
      lower === 'transfer-encoding' ||
      lower === 'connection' ||
      lower === 'content-length' || // node will recompute
      lower === 'set-cookie' // never proxy tenant cookies to buyers
    ) {
      return;
    }
    respHeaders.set(key, value);
  });
  if (settle.txHash) {
    respHeaders.set('X-Payment-Receipt', settle.txHash);
  }
  if (settle.extensionResponses) {
    respHeaders.set('EXTENSION-RESPONSES', settle.extensionResponses);
  }
  respHeaders.set('x402-version', '1');
  respHeaders.set(
    'access-control-expose-headers',
    'EXTENSION-RESPONSES, X-Payment-Receipt, x402-version',
  );

  return new Response(backendRes.body, {
    status: backendRes.status,
    headers: respHeaders,
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function rawHeaders(c: Context): Record<string, string> {
  const out: Record<string, string> = {};
  // Hono exposes raw headers via c.req.raw.headers in node runtime.
  const raw = (c.req as any)?.raw?.headers as Headers | undefined;
  if (raw && typeof raw.forEach === 'function') {
    raw.forEach((v: string, k: string) => {
      out[k] = v;
    });
    return out;
  }
  // Fallback for environments without raw headers — copy known keys.
  for (const key of [
    'host',
    'accept',
    'accept-language',
    'content-type',
    'user-agent',
    'x-request-id',
    'x-payment',
    'authorization',
    'cookie',
  ]) {
    const v = c.req.header(key);
    if (v != null) out[key] = v;
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// Hono middleware shell
// ──────────────────────────────────────────────────────────────────────────

/**
 * Mount this BEFORE the /v1/* routes. It returns the gateway response when
 * the Host header matches; otherwise it calls `next()` and lets the rest of
 * the app handle the request normally.
 */
export function gatewayMiddleware(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const hostHeader = c.req.header('host');
    const parsed = parseGatewayHost(hostHeader);
    if (!parsed) {
      // Not a gateway host — fall through to the rest of the app.
      return next();
    }
    return handleGatewayRequest(c);
  };
}

// Internal helpers exported for tests
export const __testing = {
  parseGatewayHost,
  isReservedSlug,
  buildAcceptsArray,
  computeSlyHmacSignature,
  buildProxyHeaders,
  normalizeNetwork,
  toMinorUnits,
};
