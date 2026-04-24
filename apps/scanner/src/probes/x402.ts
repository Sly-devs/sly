
import type { ProbeResult, ScanConfig } from './types.js';
import { buildUrl, withProbeTimeout } from './types.js';

// Paths that commonly return HTTP 402 Payment Required
const X402_PATHS = ['/api/paid', '/x402', '/v1', '/v2', '/api/v1', '/api/v2'];

// CDP Facilitator Bazaar registry
const BAZAAR_URL = 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources';

const NOT_DETECTED: ProbeResult = {
  protocol: 'x402', status: 'not_detected', confidence: 'high', capabilities: {},
};

export async function probeX402(domain: string, config: ScanConfig): Promise<ProbeResult> {
  return withProbeTimeout(() => _probeX402(domain, config), NOT_DETECTED, config.timeout_ms + 1000);
}

async function _probeX402(domain: string, config: ScanConfig): Promise<ProbeResult> {
  const start = Date.now();
  const stripped = domain.replace(/^www\./, '');

  // 0. Query Bazaar registry for registered resources matching this domain
  const bazaarResult = await checkBazaarRegistry(stripped, config, start);
  if (bazaarResult) return bazaarResult;

  // Build list of origins to probe: primary domain + api. subdomain + x402. subdomain
  const origins = [domain];
  if (!stripped.startsWith('api.')) {
    origins.push(`api.${stripped}`);
  }
  if (!stripped.startsWith('x402.')) {
    origins.push(`x402.${stripped}`);
  }

  // 1. Check .well-known/x402.json manifest on each origin (Bazaar discovery)
  for (const origin of origins) {
    const manifestResult = await checkBazaarManifest(origin, config, start);
    if (manifestResult) return manifestResult;
  }

  // 2. Probe known paths for HTTP 402 responses (or 401 with x402 body)
  for (const origin of origins) {
    for (const path of X402_PATHS) {
      const result = await check402Response(origin, path, config, start);
      if (result) return result;
    }
  }

  return {
    protocol: 'x402',
    status: 'not_detected',
    confidence: 'high',
    response_time_ms: Date.now() - start,
    capabilities: {},
  };
}

/**
 * Query the CDP Facilitator Bazaar registry for resources matching a domain.
 * The registry indexes all x402-enabled endpoints registered with Coinbase's facilitator.
 */
async function checkBazaarRegistry(
  domain: string,
  config: ScanConfig,
  start: number,
): Promise<ProbeResult | null> {
  try {
    // Bazaar doesn't support domain filtering, so we fetch a page and search
    // We search for the domain across multiple pages with a reasonable limit
    const res = await fetch(`${BAZAAR_URL}?limit=100&offset=0`, {
      method: 'GET',
      headers: { 'User-Agent': config.user_agent, Accept: 'application/json' },
      signal: AbortSignal.timeout(config.timeout_ms),
    });

    if (!res.ok) return null;

    const data = await res.json() as {
      items: Array<{ resource: string; x402Version?: number; accepts?: Array<Record<string, unknown>> }>;
      pagination: { total: number };
    };

    // Search for resources matching this domain (including subdomains)
    const matching = data.items.filter(item => {
      try {
        const url = new URL(item.resource);
        return url.hostname === domain ||
               url.hostname.endsWith(`.${domain}`);
      } catch { return false; }
    });

    if (matching.length === 0) return null;

    const capabilities: Record<string, unknown> = {
      bazaar_registered: true,
      resource_count: matching.length,
      registry_total: data.pagination.total,
    };

    // Extract sample resources with pricing
    capabilities.sample_resources = matching.slice(0, 5).map(item => {
      const accepts = item.accepts?.[0] as Record<string, unknown> | undefined;
      return {
        url: item.resource,
        price_usdc: accepts?.maxAmountRequired
          ? Number(accepts.maxAmountRequired) / 1e6
          : undefined,
        network: accepts?.network,
        description: accepts?.description
          ? String(accepts.description).slice(0, 80)
          : undefined,
      };
    });

    // Extract networks
    const networks = new Set<string>();
    for (const item of matching) {
      for (const acc of item.accepts || []) {
        const net = (acc as Record<string, unknown>).network;
        if (typeof net === 'string') networks.add(net);
      }
    }
    if (networks.size > 0) capabilities.networks = [...networks];

    return {
      protocol: 'x402',
      status: 'confirmed',
      confidence: 'high',
      detection_method: 'Bazaar registry (CDP facilitator)',
      endpoint_url: matching[0].resource,
      capabilities,
      response_time_ms: Date.now() - start,
      is_functional: true,
    };
  } catch {
    return null;
  }
}

/**
 * Check a single path for x402 signals:
 * - HTTP 402 status code (standard x402)
 * - HTTP 401 with x402Version in JSON body (Neynar-style)
 */
async function check402Response(
  domain: string,
  path: string,
  config: ScanConfig,
  start: number,
): Promise<ProbeResult | null> {
  const url = buildUrl(domain, path);

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': config.user_agent },
      signal: AbortSignal.timeout(config.timeout_ms),
      redirect: 'manual',
    });

    const responseTime = Date.now() - start;

    // Standard: HTTP 402 Payment Required
    if (res.status === 402) {
      const capabilities = await extractX402Capabilities(res);
      return {
        protocol: 'x402',
        status: 'confirmed',
        confidence: 'high',
        detection_method: `402 response on ${path}`,
        endpoint_url: url,
        capabilities,
        response_time_ms: responseTime,
        is_functional: true,
      };
    }

    // Some services return 401 with x402 payment info in the body
    if (res.status === 401) {
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('json')) {
        try {
          const body = await res.json() as Record<string, unknown>;
          if (body.x402Version || body.accepts) {
            const capabilities = extractX402CapabilitiesFromBody(body);
            return {
              protocol: 'x402',
              status: 'confirmed',
              confidence: 'high',
              detection_method: `401 with x402 body on ${path}`,
              endpoint_url: url,
              capabilities,
              response_time_ms: responseTime,
              is_functional: true,
            };
          }
        } catch {
          // Not valid JSON or no x402 fields
        }
      }
    }
  } catch {
    // Connection failed, try next
  }

  return null;
}

/** Extract capabilities from HTTP headers on a 402 response */
async function extractX402Capabilities(res: { headers: { get(name: string): string | null }; json(): Promise<unknown> }): Promise<Record<string, unknown>> {
  const capabilities: Record<string, unknown> = {};
  const priceHeader = res.headers.get('x-payment-required');
  const x402Header = res.headers.get('x-402-version');

  if (priceHeader) capabilities.price = priceHeader;
  if (x402Header) capabilities.version = x402Header;

  // Try to parse body for richer x402 data
  try {
    const body = await res.json() as Record<string, unknown>;
    Object.assign(capabilities, extractX402CapabilitiesFromBody(body));
  } catch {
    // Body not JSON, headers are enough
  }

  return capabilities;
}

/** Extract capabilities from a JSON body containing x402 fields */
function extractX402CapabilitiesFromBody(body: Record<string, unknown>): Record<string, unknown> {
  const capabilities: Record<string, unknown> = {};

  if (body.x402Version) capabilities.version = body.x402Version;

  if (Array.isArray(body.accepts) && body.accepts.length > 0) {
    const first = body.accepts[0] as Record<string, unknown>;
    capabilities.network = first.network;
    capabilities.max_amount = first.maxAmountRequired;
    capabilities.asset = first.asset;
    capabilities.pay_to = first.payTo;
    if (first.extra && typeof first.extra === 'object') {
      capabilities.token_name = (first.extra as Record<string, unknown>).name;
    }
  }

  return capabilities;
}

/**
 * Check for .well-known/x402.json — the Bazaar discovery manifest.
 * Services advertise their paid endpoints, pricing, and accepted payment methods.
 * See: https://docs.cdp.coinbase.com/x402/bazaar
 */
async function checkBazaarManifest(
  domain: string,
  config: ScanConfig,
  start: number,
): Promise<ProbeResult | null> {
  const url = buildUrl(domain, '/.well-known/x402.json');

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': config.user_agent, Accept: 'application/json' },
      signal: AbortSignal.timeout(config.timeout_ms),
    });

    if (!res.ok) return null;

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('json')) return null;

    const text = await res.text();
    const manifest = JSON.parse(text);

    // Validate it looks like an x402 manifest
    // Real-world formats: flat arrays (resources/endpoints/services) or categorized objects (categories)
    const flatResources = manifest.resources || manifest.endpoints || manifest.services;
    const categories = manifest.categories;
    if (!flatResources && !categories && !manifest.x402Version && !manifest.accepts) return null;

    const capabilities: Record<string, unknown> = {};

    if (manifest.x402Version) capabilities.version = manifest.x402Version;
    if (manifest.name) capabilities.service_name = manifest.name;
    if (manifest.baseUrl) capabilities.base_url = manifest.baseUrl;

    // Handle flat resource arrays
    if (Array.isArray(flatResources)) {
      capabilities.resource_count = flatResources.length;
      capabilities.sample_resources = flatResources.slice(0, 5).map((r: any) => ({
        path: r.resource || r.path || r.url,
        method: r.method,
        price: r.price || r.accepts?.[0]?.maxAmountRequired,
        currency: r.currency || r.accepts?.[0]?.asset,
      }));
    }

    // Handle categorized resources (e.g. x402engine uses { categories: { compute: [...], web: [...] } })
    if (categories && typeof categories === 'object' && !Array.isArray(categories)) {
      const categoryNames = Object.keys(categories);
      const allResources = categoryNames.flatMap(cat => Array.isArray(categories[cat]) ? categories[cat] : []);
      capabilities.resource_count = allResources.length;
      capabilities.category_names = categoryNames;
      capabilities.sample_resources = allResources.slice(0, 5).map((r: any) => ({
        id: r.id,
        name: r.name,
        path: r.endpoint || r.resource || r.path || r.url,
        price: r.price,
      }));
    }

    // Network support
    if (manifest.networks) {
      capabilities.networks = Object.keys(manifest.networks);
    }

    if (manifest.accepts) capabilities.accepts = manifest.accepts;
    if (manifest.bazaar) capabilities.bazaar = true;
    if (manifest.mcp) capabilities.has_mcp = true;

    return {
      protocol: 'x402',
      status: 'confirmed',
      confidence: 'high',
      detection_method: '.well-known/x402.json manifest',
      endpoint_url: url,
      capabilities,
      response_time_ms: Date.now() - start,
      is_functional: true,
    };
  } catch {
    return null;
  }
}
