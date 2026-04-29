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
import {
  encodePaymentRequiredHeader,
  decodePaymentSignatureHeader,
  HTTPFacilitatorClient,
} from '@x402/core/http';
import { createFacilitatorConfig } from '@coinbase/x402';
// Note: @x402/extensions has the same builder, but its bundle imports
// `ajv/dist/2020` without a `.js` extension which Vitest's ESM resolver
// rejects. We hand-roll the canonical shape (see buildBazaarExtension)
// to avoid that test-only dep hazard. The shape mirrors the SDK type
// defs in @x402/extensions exactly.

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
  /** Buyer address recovered from the signed paymentPayload by CDP. */
  payer?: string;
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
/**
 * Canonical USDC contract config per network — address + on-chain
 * EIP-712 domain (name, version) verified by reading name() and
 * version() from each contract. Buyers sign EIP-3009
 * transferWithAuthorization against this exact domain; if the
 * `extra.name` we advertise doesn't match the contract's name(),
 * signature recovery returns the wrong address and CDP rejects with
 * `invalid_payload`.
 *
 * Keyed by every alias the codebase uses: x402 short slug, Sly slug,
 * CAIP-2.
 */
interface UsdcConfig {
  address: string;
  domainName: string;
  domainVersion: string;
}

const USDC_BASE_MAINNET: UsdcConfig = {
  address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  domainName: 'USD Coin', // verified on-chain via name() — NOT "USDC"
  domainVersion: '2',
};

const USDC_BASE_SEPOLIA: UsdcConfig = {
  address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  domainName: 'USDC', // testnet uses the short name
  domainVersion: '2',
};

const USDC_ETH_MAINNET: UsdcConfig = {
  address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  domainName: 'USD Coin',
  domainVersion: '2',
};

const USDC_OP_MAINNET: UsdcConfig = {
  address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  domainName: 'USD Coin',
  domainVersion: '2',
};

const USDC_BY_NETWORK: Record<string, UsdcConfig> = {
  // Base mainnet
  base: USDC_BASE_MAINNET,
  'base-mainnet': USDC_BASE_MAINNET,
  'eip155:8453': USDC_BASE_MAINNET,
  // Base sepolia
  'base-sepolia': USDC_BASE_SEPOLIA,
  'eip155:84532': USDC_BASE_SEPOLIA,
  // Ethereum mainnet
  'eip155:1': USDC_ETH_MAINNET,
  ethereum: USDC_ETH_MAINNET,
  // Optimism mainnet
  'eip155:10': USDC_OP_MAINNET,
  optimism: USDC_OP_MAINNET,
};

function resolveUsdcConfig(network: string, endpointAsset: string | null): UsdcConfig {
  // Prefer an explicit asset on the endpoint when it looks like a real
  // EVM address. Tests sometimes pass a placeholder ('0xUSDC') — in that
  // case still honor it so the test doesn't need a 40-hex value.
  // We still need a domain name/version though, so look those up from
  // the network even when the address is overridden.
  const networkCfg = USDC_BY_NETWORK[network];
  if (endpointAsset && endpointAsset.startsWith('0x') && endpointAsset.length >= 4) {
    return {
      address: endpointAsset,
      domainName: networkCfg?.domainName ?? 'USDC',
      domainVersion: networkCfg?.domainVersion ?? '2',
    };
  }
  return networkCfg ?? { address: '', domainName: 'USDC', domainVersion: '2' };
}

/**
 * Build the `accepts: PaymentRequirements[]` array for a 402 challenge.
 * Shape MUST match `@x402/core`'s `PaymentRequirements` exactly — buyer
 * clients (x402-fetch, etc.) parse this with Zod and reject anything
 * with an extra/missing/wrong-typed field.
 */
function buildAcceptsArray(endpoint: EndpointRow, payTo: string): unknown[] {
  const network = normalizeNetwork(endpoint.network);
  const baseAmount = typeof endpoint.base_price === 'string'
    ? endpoint.base_price
    : String(endpoint.base_price);
  // ERC-20 (USDC/EURC = 6 decimals) — atomic units.
  const decimals = 6;
  const amountMinor = toMinorUnits(baseAmount, decimals);
  const usdc = resolveUsdcConfig(network, endpoint.asset_address);

  return [
    {
      scheme: 'exact',
      network,
      asset: usdc.address,
      amount: amountMinor,
      payTo,
      maxTimeoutSeconds: 60,
      extra: {
        // The EIP-712 domain `name` and `version` MUST match the
        // ERC-20's on-chain values exactly. The buyer signs against
        // these, and the facilitator recovers the signer address by
        // re-deriving the domain from these fields. Mismatch →
        // signature recovers to a different address → CDP rejects
        // as `invalid_payload`. (Verified on-chain via name()/version()
        // for each network's USDC contract.)
        name: usdc.domainName,
        version: usdc.domainVersion,
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

/**
 * Normalize the endpoint's network to CAIP-2 form (`eip155:NNNN`).
 *
 * The x402 EVM scheme derives the EIP-712 chainId via
 * `requirements.network.split(':')[1]` — short slugs like `'base'`
 * split to undefined → NaN → CDP rejects the signed payload with
 * "Value is not nullable". CAIP-2 is the only form that works
 * end-to-end through the buyer's signing flow.
 */
function normalizeNetwork(network: string | null | undefined): string {
  if (!network) return 'eip155:8453';
  if (network.startsWith('eip155:')) return network;
  switch (network) {
    case 'base':
    case 'base-mainnet':
      return 'eip155:8453';
    case 'base-sepolia':
      return 'eip155:84532';
    case 'ethereum':
    case 'ethereum-mainnet':
      return 'eip155:1';
    case 'optimism':
    case 'optimism-mainnet':
      return 'eip155:10';
    default:
      return network;
  }
}

/**
 * Build the canonical Bazaar discovery extension from our internal
 * X402DiscoveryMetadata shape.
 *
 * Coinbase's bazaar indexer requires this exact structure (verified
 * against `@x402/extensions`'s type defs):
 *
 *   { info: {
 *       input: { type:"http", method, queryParams?, headers?,
 *                body?, bodyType? },  // body fields for POST/PUT/PATCH
 *       output?: { type?, format?, example? }
 *     },
 *     schema: { $schema, type:"object",
 *               properties: { input: {...}, output?: {...} },
 *               required: ["input"] }
 *   }
 *
 * Hand-rolling instead of importing @x402/extensions because its bundle
 * has an ajv import that breaks Vitest's ESM resolution.
 */
function buildBazaarExtension(
  metadata: X402DiscoveryMetadata,
  method: string
): unknown {
  const m = method.toUpperCase();
  const isQuery = m === 'GET' || m === 'HEAD' || m === 'DELETE';

  // ── info.input ────────────────────────────────────────────────────
  const inputInfo: any = { type: 'http', method: m };
  if (isQuery) {
    if (metadata.input?.example && typeof metadata.input.example === 'object') {
      inputInfo.queryParams = metadata.input.example as Record<string, unknown>;
    }
  } else {
    inputInfo.bodyType = metadata.bodyType || 'json';
    inputInfo.body =
      (metadata.input?.example && typeof metadata.input.example === 'object'
        ? (metadata.input.example as Record<string, unknown>)
        : {});
  }

  // ── info.output ───────────────────────────────────────────────────
  const outputInfo: any = {};
  if (metadata.output?.example !== undefined) outputInfo.example = metadata.output.example;
  // Sensible defaults that buyers/observers find useful:
  outputInfo.type = 'json';

  // ── schema (the JSON Schema that describes input/output) ─────────
  const inputSchemaInner: any = {
    type: 'object',
    properties: {
      type: { type: 'string', const: 'http' },
      method: {
        type: 'string',
        enum: isQuery ? ['GET', 'HEAD', 'DELETE'] : ['POST', 'PUT', 'PATCH'],
      },
    },
    required: isQuery ? ['type', 'method'] : ['type', 'method', 'bodyType', 'body'],
    additionalProperties: true,
  };
  if (!isQuery) {
    inputSchemaInner.properties.bodyType = {
      type: 'string',
      enum: ['json', 'form-data', 'text'],
    };
    inputSchemaInner.properties.body = (metadata.input?.schema as any) ?? { type: 'object' };
  } else if (metadata.input?.schema) {
    inputSchemaInner.properties.queryParams = metadata.input.schema as any;
  }

  const schema: any = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: { input: inputSchemaInner },
    required: ['input'],
  };
  if (metadata.output?.schema) {
    schema.properties.output = metadata.output.schema as any;
  }

  return {
    info: { input: inputInfo, output: outputInfo },
    schema,
  };
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
 * Settle a buyer's x402 payment via Coinbase's CDP Facilitator.
 *
 * Uses @coinbase/x402's facilitator config + @x402/core's
 * HTTPFacilitatorClient so request/response schemas match exactly what
 * CDP expects: the X-PAYMENT header is decoded into a PaymentPayload
 * and POSTed alongside the matched paymentRequirements entry.
 *
 * Returns a structured result with the EXTENSION-RESPONSES header so
 * the caller can persist publish state.
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

  // Decode the buyer's X-PAYMENT/PAYMENT-SIGNATURE header → PaymentPayload.
  let paymentPayload: any;
  try {
    paymentPayload = decodePaymentSignatureHeader(input.paymentHeader);
  } catch (err: any) {
    return {
      ok: false,
      status: 400,
      error: `Invalid X-PAYMENT header: ${err?.message || 'decode failed'}`,
    };
  }

  // Pick the paymentRequirements entry matching the buyer's network +
  // scheme. accepts[] usually has one entry today; future-proofed for
  // multi-network publishes.
  const acceptsArray = Array.isArray(input.accepts) ? (input.accepts as any[]) : [];
  const matched = acceptsArray.find(
    (a) =>
      (a?.network === paymentPayload?.network ||
        a?.network === paymentPayload?.paymentRequirements?.network) &&
      (a?.scheme === paymentPayload?.scheme ||
        a?.scheme === paymentPayload?.paymentRequirements?.scheme)
  ) ?? acceptsArray[0];

  if (!matched) {
    return {
      ok: false,
      status: 400,
      error: 'No accepts entry matched the buyer payment',
    };
  }

  // @coinbase/x402 builds the JWT auth headers; HTTPFacilitatorClient
  // uses them to call /verify and /settle on CDP's hosted facilitator.
  const facilitatorConfig = createFacilitatorConfig(creds.apiKeyId, creds.apiKeySecret);
  const client = new HTTPFacilitatorClient({
    url: facilitatorUrl,
    createAuthHeaders: facilitatorConfig.createAuthHeaders,
  });

  let settleResp: any;
  try {
    settleResp = await client.settle(paymentPayload, matched);
  } catch (err: any) {
    return {
      ok: false,
      status: 502,
      error: `CDP settle threw: ${err?.message || 'unknown'}`,
    };
  }

  // SettleResponse shape: { success, errorReason?, payer?, transaction, network }
  // EXTENSION-RESPONSES is conveyed by Coinbase as part of the body /
  // headers chain — the SDK does not expose them as a separate field on
  // the response object, so we treat success+transaction as "processed".
  if (!settleResp?.success) {
    return {
      ok: false,
      status: 402,
      error: settleResp?.errorReason || 'CDP settle returned success=false',
      extensionResponses: settleResp?.errorReason ? `rejected:${settleResp.errorReason}` : 'rejected',
    };
  }

  // Treat a successful settle as the indexing trigger — the bazaar
  // extension on the original 402 challenge is what CDP reads.
  return {
    ok: true,
    txHash: settleResp.transaction,
    payer: settleResp.payer,
    extensionResponses: 'processing',
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
  /** Buyer's address (probe wallet, organic agent, etc.) — NULL if unknown. */
  payerAddress?: string | null;
  /**
   * Settle amount in atomic minor units (USDC = 6 decimals). Used to
   * increment endpoint analytics + insert the transfers row. Set only on
   * a successful, non-rejected settle.
   */
  amountMinor?: string | null;
  /** Endpoint base_price in major units (decimal string). Used for transfers.amount. */
  amountMajor?: string | null;
  currency?: string | null;
  network?: string | null;
  payToAddress?: string | null;
  accountId?: string | null;
  environment?: string | null;
  /**
   * Where the buyer came from: 'agentic.market', 'a2a', 'x402-fetch',
   * 'direct', or a custom value supplied via X-Sly-Source. Stored in
   * transfers.initiated_by_name for the dashboard's From/Source column
   * and mirrored into protocol_metadata for full audit.
   */
  discoverySource?: string | null;
}): Promise<void> {
  const supabase: any = createClient();
  const now = new Date().toISOString();

  // Determine whether this is a successful, indexed-eligible settle.
  const wasRejected = input.extensionResponses?.toLowerCase().includes('rejected');
  const settleSucceeded = input.ok && !wasRejected;

  // ── Update endpoint state ─────────────────────────────────────────────
  const update: Record<string, unknown> = {
    last_settle_at: now,
  };
  if (input.ok) {
    if (wasRejected) {
      update.publish_status = 'failed';
      update.publish_error = `extension_rejected: ${input.extensionResponses}`;
    } else if (input.extensionResponses) {
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

  // ── Analytics: increment total_calls + total_revenue on success ──────
  // Done as a fresh SELECT/UPDATE rather than an RPC because we don't
  // need atomicity here (one settle per request, not contended).
  if (settleSucceeded && input.amountMajor) {
    const { data: ep } = await supabase
      .from('x402_endpoints')
      .select('total_calls, total_revenue')
      .eq('id', input.endpointId)
      .eq('tenant_id', input.tenantId)
      .single();
    if (ep) {
      const calls = Number((ep as any).total_calls ?? 0) + 1;
      const revenue =
        Number((ep as any).total_revenue ?? 0) + Number(input.amountMajor);
      await supabase
        .from('x402_endpoints')
        .update({ total_calls: calls, total_revenue: revenue })
        .eq('id', input.endpointId)
        .eq('tenant_id', input.tenantId);
    }
  }

  // ── Transfers row: drives the dashboard's Transactions tab ──────────
  if (settleSucceeded && input.amountMajor) {
    await supabase.from('transfers').insert({
      tenant_id: input.tenantId,
      type: 'x402',
      status: 'completed',
      to_account_id: input.accountId ?? null,
      to_account_name: null,
      initiated_by_type: 'agent',
      initiated_by_id: input.payerAddress ?? 'external-buyer',
      // initiated_by_name carries the discovery source for the dashboard
      // From/Source column. Falls back to the wallet address when no
      // source could be derived.
      initiated_by_name: input.discoverySource ?? input.payerAddress ?? null,
      amount: input.amountMajor,
      currency: input.currency ?? 'USDC',
      tx_hash: input.txHash ?? null,
      external_tx_hash: input.txHash ?? null,
      settlement_network: input.network ?? null,
      settled_at: now,
      completed_at: now,
      processing_at: now,
      environment: input.environment ?? 'live',
      description: input.discoverySource
        ? `x402 settle via ${input.discoverySource}`
        : 'x402 gateway settle',
      protocol_metadata: {
        protocol: 'x402',
        endpoint_id: input.endpointId,
        pay_to: input.payToAddress ?? null,
        extension_responses: input.extensionResponses ?? null,
        via: 'gateway',
        discovery_source: input.discoverySource ?? null,
        payer_wallet: input.payerAddress ?? null,
      },
    });
  }

  // ── Audit row for the publish-events timeline ────────────────────────
  await supabase.from('x402_publish_events').insert({
    tenant_id: input.tenantId,
    endpoint_id: input.endpointId,
    actor_type: 'system',
    actor_id: null,
    event: settleSucceeded ? 'first_settle' : 'extension_rejected',
    details: {
      via: 'gateway',
      tx_hash: input.txHash || null,
      extension_responses: input.extensionResponses || null,
      error: input.error || null,
      amount: input.amountMajor || null,
      payer: input.payerAddress || null,
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
  // x402 v2 transport: buyers send their signed payload in PAYMENT-SIGNATURE.
  // X-PAYMENT is the v1 name; we read both for compat.
  const paymentHeader =
    c.req.header('payment-signature') ?? c.req.header('x-payment');
  const resourceUrl = `https://${hostHeader}${url.pathname}${url.search}`;
  const accepts = buildAcceptsArray(endpoint, wallet.address);

  if (!paymentHeader) {
    // Shape MUST match @x402/core's `PaymentRequired` type — buyer
    // clients parse this with Zod and reject anything off-shape.
    //   { x402Version, error, resource: {url, description, mimeType},
    //     accepts: PaymentRequirements[], extensions? }
    //
    // Coinbase's Bazaar indexes the description verbatim and tokenizes
    // it for search. Append a Sly attribution so every Sly-published
    // endpoint is searchable as "Sly" / "getsly.ai" in the catalog.
    const baseDesc = (endpoint.description ?? '').trim();
    const slyTag = '· Powered by Sly (https://getsly.ai)';
    const description = baseDesc.includes('getsly.ai')
      ? baseDesc
      : (baseDesc ? `${baseDesc} ${slyTag}` : slyTag);

    const body = {
      x402Version: 2,
      error: 'PAYMENT-SIGNATURE header required',
      resource: {
        url: resourceUrl,
        description,
        mimeType: 'application/json',
      },
      accepts,
      extensions: {
        bazaar: buildBazaarExtension(
          endpoint.discovery_metadata,
          endpoint.method || 'GET'
        ),
      },
    };

    // x402 v2 buyer parser reads `PAYMENT-REQUIRED` header (base64-encoded
    // PaymentRequired). Without this header, x402-fetch throws "Invalid
    // payment required response" because the body-fallback path only
    // accepts v1.
    //
    // @x402/core's safeBase64Encode uses `btoa`, which only accepts Latin-1
    // characters and throws on multi-byte UTF-8 (em dash, smart quotes,
    // etc. — common in human-written descriptions). The buyer's decoder
    // uses `atob` symmetrically, so even if we forced UTF-8 encoding here
    // the decoder would produce mojibake. Sanitize to ASCII-safe before
    // encoding so the round-trip survives.
    const ascii = (s: string): string =>
      s
        .replace(/[—–]/g, '-') // em/en dashes → hyphen
        .replace(/[‘’]/g, "'") // smart single quotes
        .replace(/[“”]/g, '"') // smart double quotes
        .replace(/[…]/g, '...')      // horizontal ellipsis
        .replace(/[^\x00-\x7F]/g, '');    // strip remaining non-ASCII
    const sanitizedBody = {
      ...body,
      error: ascii(body.error || ''),
      resource: {
        ...body.resource,
        description: ascii(body.resource.description),
        mimeType: ascii(body.resource.mimeType),
      },
      extensions: body.extensions
        ? {
            bazaar: body.extensions.bazaar
              ? {
                  ...(body.extensions.bazaar as any),
                  description: ascii(((body.extensions.bazaar as any).description) || ''),
                }
              : body.extensions.bazaar,
          }
        : undefined,
    };

    let paymentRequiredHeader = '';
    try {
      paymentRequiredHeader = encodePaymentRequiredHeader(sanitizedBody as any);
    } catch (err: any) {
      console.error('[gateway] encodePaymentRequiredHeader failed:', err?.message || err);
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x402-version': '2',
      'access-control-expose-headers':
        'PAYMENT-REQUIRED, PAYMENT-RESPONSE, EXTENSION-RESPONSES, X-Payment-Receipt',
    };
    if (paymentRequiredHeader) {
      headers['PAYMENT-REQUIRED'] = paymentRequiredHeader;
    }

    return new Response(JSON.stringify(body), { status: 402, headers });
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
    // Pull amount + currency + network from the matched accept entry so
    // analytics tracking matches what was actually paid (not a separately
    // computed value that could drift).
    const matched = (accepts as any[])[0] || {};

    // Derive the discovery source — where did this buyer come from?
    // Buyer can supply X-Sly-Source explicitly; otherwise infer from
    // Referer (catalog/marketplace pages) and User-Agent (known clients).
    // Defaults to 'direct' so the column is never empty.
    const slySource = c.req.header('x-sly-source');
    const referer = c.req.header('referer') || c.req.header('referrer');
    const userAgent = c.req.header('user-agent') || '';
    const discoverySource = (() => {
      if (slySource) return slySource.slice(0, 64);
      if (referer) {
        try {
          const host = new URL(referer).host.toLowerCase();
          if (host.includes('agentic.market')) return 'agentic.market';
          if (host.includes('paysponge')) return 'paysponge';
          return host;
        } catch {
          /* fall through */
        }
      }
      // x402-fetch + similar buyer libraries often identify themselves.
      const ua = userAgent.toLowerCase();
      if (ua.includes('x402-fetch')) return 'x402-fetch';
      if (ua.includes('a2a-agent') || ua.includes('sly-a2a')) return 'a2a';
      if (ua.startsWith('node/')) return 'direct (node)';
      return 'direct';
    })();

    await recordSettleEvent({
      tenantId: tenant.id,
      endpointId: endpoint.id,
      ok: settle.ok,
      txHash: settle.txHash,
      extensionResponses: settle.extensionResponses,
      error: settle.error,
      payerAddress: settle.payer ?? null,
      amountMinor: String(matched.amount ?? ''),
      amountMajor:
        endpoint.base_price != null ? String(endpoint.base_price) : null,
      currency: endpoint.currency ?? 'USDC',
      network: matched.network ?? endpoint.network ?? null,
      payToAddress: wallet.address,
      accountId: endpoint.account_id,
      environment: (endpoint as any).environment ?? null,
      discoverySource,
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
  // Don't synthesize a trailing slash when the buyer hit the bare service
  // URL — many backends (httpbin's /json, REST handlers using exact-match
  // routing) return 404 for `/path/` when only `/path` is registered.
  const remainder = url.pathname.slice(ctx.pathPrefix.length);
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

  // Buffer the backend body so we can return a fixed content-length.
  // Streaming via `new Response(backendRes.body, ...)` was leaving buyers
  // hanging waiting for body-end (transfer-encoding handling through
  // Hono/Railway's edge wasn't terminating cleanly). Buffering trades a
  // little memory (capped at 8 MB to avoid abuse) for a clean,
  // deterministic response.
  const MAX_PROXY_BODY_BYTES = 8 * 1024 * 1024;
  let responseBytes: Uint8Array;
  try {
    const ab = await backendRes.arrayBuffer();
    responseBytes = new Uint8Array(ab);
  } catch (err: any) {
    return jsonResponse(502, {
      error: 'backend_body_read_failed',
      detail: err?.message || 'unknown',
    });
  }
  if (responseBytes.byteLength > MAX_PROXY_BODY_BYTES) {
    return jsonResponse(502, {
      error: 'backend_body_too_large',
      detail: `body exceeded ${MAX_PROXY_BODY_BYTES} bytes`,
    });
  }

  // Build response headers — preserve content-type etc., drop hop-by-hop
  // and tenant-leaky headers, and set our own content-length from the
  // buffered body.
  const respHeaders = new Headers();
  backendRes.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (
      lower === 'transfer-encoding' ||
      lower === 'connection' ||
      lower === 'content-length' || // we set our own below
      lower === 'set-cookie' // never proxy tenant cookies to buyers
    ) {
      return;
    }
    respHeaders.set(key, value);
  });
  respHeaders.set('content-length', String(responseBytes.byteLength));
  if (settle.txHash) {
    respHeaders.set('X-Payment-Receipt', settle.txHash);
  }
  if (settle.extensionResponses) {
    respHeaders.set('EXTENSION-RESPONSES', settle.extensionResponses);
  }
  respHeaders.set('x402-version', '2');
  respHeaders.set(
    'access-control-expose-headers',
    'EXTENSION-RESPONSES, X-Payment-Receipt, x402-version',
  );

  return new Response(responseBytes as unknown as BodyInit, {
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
