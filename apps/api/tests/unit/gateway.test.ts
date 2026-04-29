/**
 * Unit tests for the x402 Bazaar gateway (Worktree C).
 *
 * Covers:
 *   - Subdomain parsing: known slug, unknown slug, wrong host suffix, multi-level subdomain
 *   - Reserved-slug guard
 *   - 402 challenge shape: accepts[] payTo from tenant_payout_wallets, bazaar extension
 *   - Visibility: private endpoint → 404
 *   - HMAC signature on backend proxy when backend_auth.hmac_secret set
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseGatewayHost,
  isReservedSlug,
  computeSlyHmacSignature,
  verifySlyHmacSignature,
  buildProxyHeaders,
  __testing,
} from '../../src/routes/gateway.js';

// Force a known suffix list for parser tests; the gateway reads env at call time.
beforeEach(() => {
  process.env.GATEWAY_HOSTNAME_SUFFIX = 'x402.getsly.ai';
  delete process.env.GATEWAY_RESERVED_SLUGS;
});

describe('parseGatewayHost', () => {
  it('accepts a known-shape subdomain on the prod suffix', () => {
    expect(parseGatewayHost('acme.x402.getsly.ai')).toEqual({
      slug: 'acme',
      matchedSuffix: 'x402.getsly.ai',
    });
  });

  it('accepts a subdomain on the staging suffix', () => {
    expect(parseGatewayHost('acme.x402-staging.getsly.ai')).toEqual({
      slug: 'acme',
      matchedSuffix: 'x402-staging.getsly.ai',
    });
  });

  it('accepts the local-dev `.localhost` variant (with port)', () => {
    expect(parseGatewayHost('acme.x402.getsly.ai.localhost:4000')).toEqual({
      slug: 'acme',
      matchedSuffix: 'x402.getsly.ai.localhost',
    });
  });

  it('returns null for hosts that do not match any gateway suffix', () => {
    expect(parseGatewayHost('api.getsly.ai')).toBeNull();
    expect(parseGatewayHost('localhost:4000')).toBeNull();
    expect(parseGatewayHost('example.com')).toBeNull();
  });

  it('returns null for the apex (no subdomain)', () => {
    expect(parseGatewayHost('x402.getsly.ai')).toBeNull();
  });

  it('rejects multi-level subdomains', () => {
    const out = parseGatewayHost('api.acme.x402.getsly.ai');
    expect(out?.slug).toBe('__INVALID_MULTILEVEL__');
  });

  it('rejects malformed slugs (leading hyphen, underscores)', () => {
    expect(parseGatewayHost('-bad.x402.getsly.ai')?.slug).toBe('__INVALID_SHAPE__');
    expect(parseGatewayHost('foo_bar.x402.getsly.ai')?.slug).toBe('__INVALID_SHAPE__');
  });

  it('handles missing host header', () => {
    expect(parseGatewayHost(undefined)).toBeNull();
    expect(parseGatewayHost('')).toBeNull();
  });
});

describe('isReservedSlug', () => {
  it('rejects baked-in reserved slugs', () => {
    for (const reserved of ['api', 'app', 'dashboard', 'admin', 'www', 'auth']) {
      expect(isReservedSlug(reserved)).toBe(true);
    }
  });

  it('allows non-reserved tenant slugs', () => {
    expect(isReservedSlug('acme')).toBe(false);
    expect(isReservedSlug('contoso')).toBe(false);
  });

  it('honours GATEWAY_RESERVED_SLUGS env override', () => {
    process.env.GATEWAY_RESERVED_SLUGS = 'foo,bar';
    expect(isReservedSlug('foo')).toBe(true);
    expect(isReservedSlug('bar')).toBe(true);
    expect(isReservedSlug('api')).toBe(false); // overridden away
  });
});

describe('computeSlyHmacSignature', () => {
  it('produces a deterministic signature for fixed inputs', () => {
    const sig1 = computeSlyHmacSignature({
      hmacSecret: 'shhh',
      timestampMs: 1_700_000_000_000,
      method: 'POST',
      path: '/forecast',
      body: '{"city":"sf"}',
    });
    const sig2 = computeSlyHmacSignature({
      hmacSecret: 'shhh',
      timestampMs: 1_700_000_000_000,
      method: 'POST',
      path: '/forecast',
      body: '{"city":"sf"}',
    });
    expect(sig1).toBe(sig2);
    expect(sig1).toMatch(/^[a-f0-9]{64}$/);
  });

  it('produces different signatures when any input changes', () => {
    const base = {
      hmacSecret: 'shhh',
      timestampMs: 1_700_000_000_000,
      method: 'POST',
      path: '/forecast',
      body: '{}',
    };
    const baseSig = computeSlyHmacSignature(base);
    expect(computeSlyHmacSignature({ ...base, hmacSecret: 'other' })).not.toBe(baseSig);
    expect(computeSlyHmacSignature({ ...base, timestampMs: 1 })).not.toBe(baseSig);
    expect(computeSlyHmacSignature({ ...base, method: 'GET' })).not.toBe(baseSig);
    expect(computeSlyHmacSignature({ ...base, path: '/other' })).not.toBe(baseSig);
    expect(computeSlyHmacSignature({ ...base, body: '{"a":1}' })).not.toBe(baseSig);
  });

  it('round-trips through verifySlyHmacSignature', () => {
    const sig = computeSlyHmacSignature({
      hmacSecret: 'shhh',
      timestampMs: 42,
      method: 'GET',
      path: '/x',
      body: '',
    });
    expect(verifySlyHmacSignature(sig, sig)).toBe(true);
    expect(verifySlyHmacSignature(sig, sig.replace(/.$/, '0'))).toBe(false);
  });
});

describe('buildProxyHeaders', () => {
  it('drops Cookie, Authorization, X-Sly-* and Host', () => {
    const buyerHeaders = new Headers({
      cookie: 'session=abc',
      authorization: 'Bearer leak',
      host: 'acme.x402.getsly.ai',
      'x-sly-spoof': 'evil',
      'user-agent': 'curl/8',
      accept: 'application/json',
    });
    const headers = buildProxyHeaders({
      backendUrl: 'https://internal.acme.com',
      method: 'GET',
      servicePath: '/',
      buyerHeaders,
      body: undefined,
    });
    expect(headers['cookie']).toBeUndefined();
    expect(headers['authorization']).toBeUndefined();
    expect(headers['host']).toBeUndefined();
    expect(headers['x-sly-spoof']).toBeUndefined();
    expect(headers['user-agent']).toBe('curl/8');
    expect(headers['accept']).toBe('application/json');
  });

  it('attaches X-Sly-Signature + X-Sly-Timestamp when hmac_secret is set', () => {
    const buyerHeaders = new Headers({ accept: 'application/json' });
    const headers = buildProxyHeaders({
      backendUrl: 'https://internal.acme.com',
      method: 'POST',
      servicePath: '/forecast',
      buyerHeaders,
      body: Buffer.from('{"city":"sf"}', 'utf8'),
      hmacSecret: 'top-secret',
    });
    expect(headers['x-sly-signature']).toMatch(/^sha256=[a-f0-9]{64}$/);
    expect(headers['x-sly-timestamp']).toMatch(/^\d+$/);
  });

  it('does NOT attach signature headers when hmac_secret is absent', () => {
    const headers = buildProxyHeaders({
      backendUrl: 'https://internal.acme.com',
      method: 'GET',
      servicePath: '/',
      buyerHeaders: new Headers(),
      body: undefined,
    });
    expect(headers['x-sly-signature']).toBeUndefined();
    expect(headers['x-sly-timestamp']).toBeUndefined();
  });
});

describe('buildAcceptsArray', () => {
  it('builds an exact-EVM accept entry with the resolved payTo and minor-unit amount', () => {
    const accepts = __testing.buildAcceptsArray(
      {
        id: 'e1',
        tenant_id: 't1',
        account_id: 'a1',
        service_slug: 'weather',
        backend_url: 'https://internal.acme.com',
        backend_auth: null,
        base_price: '0.01',
        currency: 'USDC',
        network: 'base-mainnet',
        asset_address: '0xUSDC',
        payment_address: 'internal://payos/t1/a1',
        visibility: 'public',
        publish_status: 'published',
        facilitator_mode: 'cdp',
        discovery_metadata: { description: 'x' },
        description: 'Daily forecast',
        method: 'GET',
      },
      '0xPayoutWallet',
    );
    expect(accepts).toHaveLength(1);
    const a = accepts[0] as any;
    expect(a.scheme).toBe('exact');
    expect(a.network).toBe('eip155:8453'); // CAIP-2 (buyer derives chainId from this)
    expect(a.payTo).toBe('0xPayoutWallet');
    expect(a.amount).toBe('10000'); // 0.01 USDC at 6 decimals
    expect(a.asset).toBe('0xUSDC');
    // EIP-712 domain `name` matches the contract's on-chain name() —
    // 'USD Coin' for native USDC on Base mainnet. Misalignment causes
    // signature recovery to fail at the facilitator.
    expect(a.extra.name).toBe('USD Coin');
  });
});

describe('toMinorUnits', () => {
  it('converts decimal strings to minor units without floating-point drift', () => {
    expect(__testing.toMinorUnits('1', 6)).toBe('1000000');
    expect(__testing.toMinorUnits('0.01', 6)).toBe('10000');
    expect(__testing.toMinorUnits('0.000001', 6)).toBe('1');
    expect(__testing.toMinorUnits('1.234567', 6)).toBe('1234567');
    // Truncates beyond the configured precision (no rounding).
    expect(__testing.toMinorUnits('0.0000019', 6)).toBe('1');
  });
});

// ────────────────────────────────────────────────────────────────────────
// End-to-end gateway request handling — drives `handleGatewayRequest`
// with mocked Supabase + facilitator + backend fetch so we cover the full
// branch matrix without network or DB.
// ────────────────────────────────────────────────────────────────────────

const TENANT = {
  id: '11111111-1111-1111-1111-111111111111',
  slug: 'acme',
  status: 'active',
};

const PUBLIC_ENDPOINT = {
  id: 'e1111111-1111-1111-1111-111111111111',
  tenant_id: TENANT.id,
  account_id: 'aaaaaaaa-1111-1111-1111-111111111111',
  service_slug: 'weather',
  backend_url: 'https://backend.acme.test',
  backend_auth: null,
  base_price: '0.01',
  currency: 'USDC',
  network: 'base-mainnet',
  asset_address: '0xUSDC',
  payment_address: 'internal://payos/t1/a1',
  visibility: 'public',
  publish_status: 'published',
  facilitator_mode: 'cdp',
  discovery_metadata: { description: 'Daily forecast', category: 'weather' },
  description: 'Daily forecast',
  method: 'GET',
};

const PRIVATE_ENDPOINT = { ...PUBLIC_ENDPOINT, visibility: 'private', publish_status: 'draft' };

const PAYOUT_WALLET = { address: '0xCAFEBABE', network: 'base-mainnet' };

/**
 * Build a fluent Supabase mock that returns canned data for the three
 * tables the gateway hits: tenants, x402_endpoints, tenant_payout_wallets.
 * Updates and inserts are no-ops with structured stubs so audit writes
 * don't blow up the request path.
 */
function buildSupabaseMock(opts: {
  tenant?: any;
  endpoint?: any;
  wallet?: any;
}) {
  const queryBuilder = (rows: any) => {
    const builder: any = {
      select: vi.fn(() => builder),
      eq: vi.fn(() => builder),
      in: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      maybeSingle: vi.fn(async () => ({ data: rows ?? null, error: null })),
      single: vi.fn(async () => ({ data: rows ?? null, error: null })),
      update: vi.fn(() => builder),
      insert: vi.fn(async () => ({ data: null, error: null })),
    };
    return builder;
  };

  return {
    from: vi.fn((table: string) => {
      if (table === 'tenants') return queryBuilder(opts.tenant);
      if (table === 'x402_endpoints') return queryBuilder(opts.endpoint);
      if (table === 'tenant_payout_wallets') return queryBuilder(opts.wallet);
      if (table === 'x402_publish_events') return queryBuilder(null);
      return queryBuilder(null);
    }),
  };
}

vi.mock('../../src/db/client.js', () => ({
  createClient: vi.fn(),
}));

import { createClient as mockedCreateClient } from '../../src/db/client.js';
import { handleGatewayRequest } from '../../src/routes/gateway.js';

function makeContext(opts: {
  host: string;
  pathname: string;
  search?: string;
  method?: string;
  paymentHeader?: string;
}): any {
  const { host, pathname, search = '', method = 'GET', paymentHeader } = opts;
  const url = `https://${host}${pathname}${search}`;
  const headers = new Headers({
    host,
    accept: 'application/json',
    'user-agent': 'gateway-test/1.0',
  });
  if (paymentHeader) headers.set('x-payment', paymentHeader);

  return {
    req: {
      url,
      method,
      header: (name: string) => headers.get(name) ?? undefined,
      arrayBuffer: async () => new ArrayBuffer(0),
      raw: { headers },
    },
  };
}

describe('handleGatewayRequest — end-to-end branches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 404 when host does not match the gateway suffix', async () => {
    (mockedCreateClient as any).mockReturnValue(buildSupabaseMock({}));
    const res = await handleGatewayRequest(
      makeContext({ host: 'example.com', pathname: '/weather' }),
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 for multi-level subdomains', async () => {
    (mockedCreateClient as any).mockReturnValue(buildSupabaseMock({}));
    const res = await handleGatewayRequest(
      makeContext({ host: 'api.acme.x402.getsly.ai', pathname: '/weather' }),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('invalid_gateway_host');
  });

  it('returns 404 for reserved slugs (e.g. api)', async () => {
    (mockedCreateClient as any).mockReturnValue(buildSupabaseMock({}));
    const res = await handleGatewayRequest(
      makeContext({ host: 'api.x402.getsly.ai', pathname: '/weather' }),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('reserved_slug');
  });

  it('returns 404 when tenant slug is unknown', async () => {
    (mockedCreateClient as any).mockReturnValue(buildSupabaseMock({ tenant: null }));
    const res = await handleGatewayRequest(
      makeContext({ host: 'unknown.x402.getsly.ai', pathname: '/weather' }),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('tenant_not_found');
  });

  it('returns 404 when endpoint visibility is private', async () => {
    (mockedCreateClient as any).mockReturnValue(
      buildSupabaseMock({
        tenant: TENANT,
        endpoint: PRIVATE_ENDPOINT,
        wallet: PAYOUT_WALLET,
      }),
    );
    const res = await handleGatewayRequest(
      makeContext({ host: 'acme.x402.getsly.ai', pathname: '/weather' }),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('endpoint_not_public');
  });

  it('returns 402 with bazaar extension + accepts when no X-PAYMENT header', async () => {
    (mockedCreateClient as any).mockReturnValue(
      buildSupabaseMock({
        tenant: TENANT,
        endpoint: PUBLIC_ENDPOINT,
        wallet: PAYOUT_WALLET,
      }),
    );
    const res = await handleGatewayRequest(
      makeContext({ host: 'acme.x402.getsly.ai', pathname: '/weather' }),
    );
    expect(res.status).toBe(402);
    expect(res.headers.get('x402-version')).toBe('2');
    const body = await res.json();
    expect(body.x402Version).toBe(2);
    expect(body.accepts).toHaveLength(1);
    expect(body.accepts[0].payTo).toBe(PAYOUT_WALLET.address);
    // resource lives at top level on PaymentRequired (not per-accept)
    expect(body.resource.url).toContain('acme.x402.getsly.ai');
    expect(body.extensions.bazaar).toEqual(PUBLIC_ENDPOINT.discovery_metadata);
  });

  it('PAYMENT-REQUIRED header survives non-ASCII descriptions (em dashes, smart quotes)', async () => {
    // Regression: @x402/core's safeBase64Encode uses btoa which throws
    // "Invalid character" on multi-byte UTF-8. The em dash in a human-
    // written description was enough to silently fail the encode in prod.
    // Sanitize layer should replace common non-ASCII glyphs before encoding.
    (mockedCreateClient as any).mockReturnValue(
      buildSupabaseMock({
        tenant: TENANT,
        endpoint: {
          ...PUBLIC_ENDPOINT,
          asset_address: null,
          description:
            'Endpoint with non-ASCII — em dashes, “smart quotes”, ellipsis…',
          discovery_metadata: {
            description: 'bazaar metadata — also has em dash',
            output: { schema: { type: 'object' }, example: {} },
          },
        },
        wallet: PAYOUT_WALLET,
      }),
    );
    const res = await handleGatewayRequest(
      makeContext({ host: 'acme.x402.getsly.ai', pathname: '/weather' }),
    );
    expect(res.status).toBe(402);
    const headerValue = res.headers.get('PAYMENT-REQUIRED');
    expect(headerValue).toBeTruthy();

    const { decodePaymentRequiredHeader } = await import('@x402/core/http');
    const decoded: any = decodePaymentRequiredHeader(headerValue!);
    // Round-trip works → description was sanitized to ASCII before encode.
    expect(decoded.resource.description).toContain('em dashes');
    expect(decoded.resource.description).not.toContain('—');
    expect(decoded.extensions.bazaar.description).not.toContain('—');
  });

  it('emits PAYMENT-REQUIRED header that @x402/core decodes back to our PaymentRequired (buyer-parser integration)', async () => {
    // The DEFINITIVE test: take our 402 response, run @x402/core's
    // actual decodePaymentRequiredHeader against the PAYMENT-REQUIRED
    // header, and assert it round-trips to our exact PaymentRequired.
    // If this passes, x402-fetch's parser will accept our response.
    (mockedCreateClient as any).mockReturnValue(
      buildSupabaseMock({
        tenant: TENANT,
        endpoint: { ...PUBLIC_ENDPOINT, asset_address: null },
        wallet: PAYOUT_WALLET,
      }),
    );
    const res = await handleGatewayRequest(
      makeContext({ host: 'acme.x402.getsly.ai', pathname: '/weather' }),
    );
    expect(res.status).toBe(402);

    const headerValue = res.headers.get('PAYMENT-REQUIRED');
    expect(headerValue).toBeTruthy();

    // Use the canonical decoder — same code path the buyer client
    // (x402-fetch) runs.
    const { decodePaymentRequiredHeader } = await import('@x402/core/http');
    const decoded: any = decodePaymentRequiredHeader(headerValue!);

    expect(decoded.x402Version).toBe(2);
    expect(decoded.resource).toBeDefined();
    expect(decoded.resource.url).toContain('acme.x402.getsly.ai');
    expect(decoded.accepts).toHaveLength(1);
    expect(decoded.accepts[0].scheme).toBe('exact');
    expect(decoded.accepts[0].amount).toBeDefined();
    expect(decoded.accepts[0].asset).toBeDefined();
    expect(decoded.extensions?.bazaar).toBeDefined();
  });

  it('emits a 402 body matching @x402/core PaymentRequired shape exactly', async () => {
    // Regression: x402-fetch parses the 402 body with Zod and rejects
    // anything off-shape. This locks the structure so future drift is
    // caught at unit-test time, not in production.
    (mockedCreateClient as any).mockReturnValue(
      buildSupabaseMock({
        tenant: TENANT,
        // asset_address null forces the canonical USDC fallback so the
        // production-grade 0x40-hex shape assertion below holds.
        endpoint: { ...PUBLIC_ENDPOINT, asset_address: null },
        wallet: PAYOUT_WALLET,
      }),
    );
    const res = await handleGatewayRequest(
      makeContext({ host: 'acme.x402.getsly.ai', pathname: '/weather' }),
    );
    expect(res.status).toBe(402);
    const body = await res.json();

    // Top-level PaymentRequired shape
    expect(typeof body.x402Version).toBe('number');
    expect(body.x402Version).toBe(2);
    expect(typeof body.error).toBe('string');
    expect(body.resource).toBeDefined();
    expect(typeof body.resource.url).toBe('string');
    expect(typeof body.resource.description).toBe('string');
    expect(typeof body.resource.mimeType).toBe('string');
    expect(Array.isArray(body.accepts)).toBe(true);

    // PaymentRequirements shape on each accepts entry
    const a = body.accepts[0];
    expect(typeof a.scheme).toBe('string');
    expect(typeof a.network).toBe('string');
    expect(typeof a.asset).toBe('string');
    expect(a.asset).toMatch(/^0x[0-9a-fA-F]{40}$/); // canonical USDC address
    expect(typeof a.amount).toBe('string'); // atomic units, NOT maxAmountRequired
    expect(typeof a.payTo).toBe('string');
    expect(typeof a.maxTimeoutSeconds).toBe('number');
    expect(a.extra).toBeDefined();

    // Forbidden fields (old shape that we drifted from)
    expect(a.maxAmountRequired).toBeUndefined();
    expect(a.resource).toBeUndefined();
    expect(a.description).toBeUndefined();
    expect(a.mimeType).toBeUndefined();
  });

  it('returns 404 when discovery_metadata is null (not ready to publish)', async () => {
    (mockedCreateClient as any).mockReturnValue(
      buildSupabaseMock({
        tenant: TENANT,
        endpoint: { ...PUBLIC_ENDPOINT, discovery_metadata: null },
        wallet: PAYOUT_WALLET,
      }),
    );
    const res = await handleGatewayRequest(
      makeContext({ host: 'acme.x402.getsly.ai', pathname: '/weather' }),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('endpoint_metadata_missing');
  });

  it('returns 404 when payout wallet is not bound', async () => {
    (mockedCreateClient as any).mockReturnValue(
      buildSupabaseMock({
        tenant: TENANT,
        endpoint: PUBLIC_ENDPOINT,
        wallet: null,
      }),
    );
    const res = await handleGatewayRequest(
      makeContext({ host: 'acme.x402.getsly.ai', pathname: '/weather' }),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('payout_wallet_not_bound');
  });

  it('proxies to backend with HMAC headers when backend_auth.hmac_secret is set', async () => {
    (mockedCreateClient as any).mockReturnValue(
      buildSupabaseMock({
        tenant: TENANT,
        endpoint: {
          ...PUBLIC_ENDPOINT,
          backend_auth: { hmac_secret: 'top-secret' },
        },
        wallet: PAYOUT_WALLET,
      }),
    );

    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const res = await handleGatewayRequest(
      makeContext({
        host: 'acme.x402.getsly.ai',
        pathname: '/weather',
        paymentHeader: 'eyFAKE',
      }),
      {
        callFacilitator: async () => ({
          ok: true,
          txHash: '0xabc',
          extensionResponses: 'processing',
        }),
        fetchBackend: fetchSpy as any,
      },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Payment-Receipt')).toBe('0xabc');
    expect(res.headers.get('EXTENSION-RESPONSES')).toBe('processing');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0]!;
    const sentHeaders = init?.headers as Record<string, string>;
    expect(sentHeaders['x-sly-signature']).toMatch(/^sha256=[a-f0-9]{64}$/);
    expect(sentHeaders['x-sly-timestamp']).toMatch(/^\d+$/);
    // Buyer cookies must never reach the backend.
    expect(sentHeaders['cookie']).toBeUndefined();
    expect(sentHeaders['authorization']).toBeUndefined();
  });

  it('returns 502 with extensionResponses when CDP rejects the extension', async () => {
    (mockedCreateClient as any).mockReturnValue(
      buildSupabaseMock({
        tenant: TENANT,
        endpoint: PUBLIC_ENDPOINT,
        wallet: PAYOUT_WALLET,
      }),
    );

    const res = await handleGatewayRequest(
      makeContext({
        host: 'acme.x402.getsly.ai',
        pathname: '/weather',
        paymentHeader: 'eyBAD',
      }),
      {
        callFacilitator: async () => ({
          ok: false,
          status: 400,
          error: 'verification_failed',
          extensionResponses: 'rejected: missing inputSchema',
        }),
      },
    );

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe('settlement_failed');
    expect(body.extensionResponses).toContain('rejected');
  });
});

// ────────────────────────────────────────────────────────────────────────
// Path-based gateway handler (temporary fallback while DNS for
// `*.x402.getsly.ai` is being provisioned). URL shape:
//   https://api.getsly.ai/x402/{tenant}/{service}/...
// ────────────────────────────────────────────────────────────────────────

import { handlePathBasedGatewayRequest } from '../../src/routes/gateway.js';

function makePathContext(opts: {
  tenant: string;
  service: string;
  /** Path remainder AFTER `/x402/{tenant}/{service}` — e.g. `/today` for /x402/acme/weather/today */
  remainder?: string;
  search?: string;
  method?: string;
  paymentHeader?: string;
}): any {
  const {
    tenant,
    service,
    remainder = '',
    search = '',
    method = 'GET',
    paymentHeader,
  } = opts;
  const pathname = `/x402/${tenant}/${service}${remainder}`;
  const url = `https://api.getsly.ai${pathname}${search}`;
  const headers = new Headers({
    host: 'api.getsly.ai',
    accept: 'application/json',
    'user-agent': 'gateway-path-test/1.0',
  });
  if (paymentHeader) headers.set('x-payment', paymentHeader);

  // Hono exposes route params via c.req.param(name); mock that.
  const params: Record<string, string> = { tenant, service };

  return {
    req: {
      url,
      method,
      header: (name: string) => headers.get(name) ?? undefined,
      param: (name?: string) => (name ? params[name] : params),
      arrayBuffer: async () => new ArrayBuffer(0),
      raw: { headers },
    },
  };
}

describe('handlePathBasedGatewayRequest — DNS-fallback shape', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 404 for reserved tenant slugs (e.g. api)', async () => {
    (mockedCreateClient as any).mockReturnValue(buildSupabaseMock({}));
    const res = await handlePathBasedGatewayRequest(
      makePathContext({ tenant: 'api', service: 'weather' }),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('reserved_slug');
  });

  it('returns 404 for invalid tenant slug shape', async () => {
    (mockedCreateClient as any).mockReturnValue(buildSupabaseMock({}));
    const res = await handlePathBasedGatewayRequest(
      makePathContext({ tenant: '!!bad!!', service: 'weather' }),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('invalid_tenant_slug');
  });

  it('returns 404 for invalid service slug shape', async () => {
    (mockedCreateClient as any).mockReturnValue(buildSupabaseMock({}));
    const res = await handlePathBasedGatewayRequest(
      makePathContext({ tenant: 'acme', service: '!!bad!!' }),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('invalid_service_slug');
  });

  it('returns 404 when tenant slug is unknown', async () => {
    (mockedCreateClient as any).mockReturnValue(buildSupabaseMock({ tenant: null }));
    const res = await handlePathBasedGatewayRequest(
      makePathContext({ tenant: 'unknown', service: 'weather' }),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('tenant_not_found');
  });

  it('returns 402 with bazaar extension when no X-PAYMENT header is present', async () => {
    (mockedCreateClient as any).mockReturnValue(
      buildSupabaseMock({
        tenant: TENANT,
        endpoint: PUBLIC_ENDPOINT,
        wallet: PAYOUT_WALLET,
      }),
    );
    const res = await handlePathBasedGatewayRequest(
      makePathContext({ tenant: 'acme', service: 'weather' }),
    );
    expect(res.status).toBe(402);
    expect(res.headers.get('x402-version')).toBe('2');
    const body = await res.json();
    expect(body.x402Version).toBe(2);
    expect(body.extensions?.bazaar?.description).toBe('Daily forecast');
    // The resource URL lives on the top-level PaymentRequired, not on
    // each accept entry — and it reflects the path-based shape.
    expect(body.resource.url).toBe('https://api.getsly.ai/x402/acme/weather');
  });

  it('proxies to backend with correct remainder after stripping `/x402/{tenant}/{service}`', async () => {
    (mockedCreateClient as any).mockReturnValue(
      buildSupabaseMock({
        tenant: TENANT,
        endpoint: PUBLIC_ENDPOINT,
        wallet: PAYOUT_WALLET,
      }),
    );
    let calledWith: string | null = null;
    const fakeFetch: any = async (target: string) => {
      calledWith = target;
      return new Response(JSON.stringify({ temperature: 72 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const res = await handlePathBasedGatewayRequest(
      makePathContext({
        tenant: 'acme',
        service: 'weather',
        remainder: '/today',
        search: '?units=metric',
        paymentHeader: 'eyOK',
      }),
      {
        callFacilitator: async () => ({
          ok: true,
          txHash: '0xdeadbeef',
          extensionResponses: 'processing',
        }),
        fetchBackend: fakeFetch,
      },
    );

    expect(res.status).toBe(200);
    expect(calledWith).toBe('https://backend.acme.test/today?units=metric');
  });
});
