
import type { ProbeResult, ScanConfig } from './types.js';
import { buildUrl, withProbeTimeout } from './types.js';

// ACP spec paths (OpenAI + Stripe Agentic Commerce Protocol)
// The official spec uses /checkout_sessions but there's no standard discovery yet.
// We check multiple common conventions.
const ACP_PATHS = [
  '/checkout_sessions',       // Official ACP spec path
  '/acp/checkout_sessions',   // Namespaced variant
  '/acp/checkout',            // Legacy / alternative
  '/.well-known/acp',         // Future discovery (spec says "working on it")
];

const NOT_DETECTED: ProbeResult = {
  protocol: 'acp', status: 'not_detected', confidence: 'high', capabilities: {},
};

export async function probeACP(domain: string, config: ScanConfig): Promise<ProbeResult> {
  return withProbeTimeout(() => _probeACP(domain, config), NOT_DETECTED, config.timeout_ms + 1000);
}

async function _probeACP(domain: string, config: ScanConfig): Promise<ProbeResult> {
  const start = Date.now();

  for (const path of ACP_PATHS) {
    const url = buildUrl(domain, path);

    try {
      // Try OPTIONS first (standard CORS preflight / capability check)
      const res = await fetch(url, {
        method: 'OPTIONS',
        headers: { 'User-Agent': config.user_agent },
        signal: AbortSignal.timeout(config.timeout_ms),
      });

      const responseTime = Date.now() - start;

      // Check for ACP-specific headers
      const acpVersion = res.headers.get('x-acp-version');
      const apiVersion = res.headers.get('api-version'); // ACP spec uses API-Version header

      if (acpVersion || (apiVersion && apiVersion.match(/^\d{4}-\d{2}-\d{2}$/) && isAcpResponse(res))) {
        const capabilities: Record<string, unknown> = {};
        if (acpVersion) capabilities.version = acpVersion;
        if (apiVersion) capabilities.api_version = apiVersion;

        const allowHeader = res.headers.get('allow');
        if (allowHeader) capabilities.methods = allowHeader.split(',').map(m => m.trim());

        return {
          protocol: 'acp',
          status: 'confirmed',
          confidence: 'high',
          detection_method: `OPTIONS ${path}`,
          endpoint_url: url,
          capabilities,
          response_time_ms: responseTime,
          is_functional: true,
        };
      }
    } catch {
      // Try next path
    }
  }

  // Also try GET on checkout_sessions (some implementations respond with 401/405
  // but include ACP-identifying headers or JSON error shapes)
  try {
    const url = buildUrl(domain, '/checkout_sessions');
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': config.user_agent },
      signal: AbortSignal.timeout(config.timeout_ms),
    });

    // A 401 or 405 with ACP-style headers suggests the endpoint exists
    if ((res.status === 401 || res.status === 405) && isAcpResponse(res)) {
      return {
        protocol: 'acp',
        status: 'confirmed',
        confidence: 'medium',
        detection_method: `GET /checkout_sessions → ${res.status}`,
        endpoint_url: url,
        capabilities: {},
        response_time_ms: Date.now() - start,
        is_functional: false,
      };
    }
  } catch {
    // ignore
  }

  return {
    protocol: 'acp',
    status: 'not_detected',
    confidence: 'high',
    response_time_ms: Date.now() - start,
    capabilities: {},
  };
}

/** Check response headers for ACP-specific signals */
function isAcpResponse(res: { headers: { get(name: string): string | null } }): boolean {
  // ACP spec requires Idempotency-Key and Request-Id headers
  const hasIdempotency = !!res.headers.get('idempotency-key');
  const hasRequestId = !!res.headers.get('request-id');
  const hasAcpVersion = !!res.headers.get('x-acp-version');
  const hasApiVersion = !!res.headers.get('api-version');

  return hasAcpVersion || (hasIdempotency && hasRequestId) || (hasApiVersion && hasRequestId);
}
