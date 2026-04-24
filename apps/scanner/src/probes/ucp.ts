
import type { ProbeResult, ScanConfig } from './types.js';
import { buildUrl } from './types.js';

export async function probeUCP(domain: string, config: ScanConfig): Promise<ProbeResult> {
  const url = buildUrl(domain, '/.well-known/ucp');
  const start = Date.now();

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': config.user_agent, Accept: 'application/json' },
      signal: AbortSignal.timeout(config.timeout_ms),
    });

    const responseTime = Date.now() - start;

    if (!res.ok) {
      return { protocol: 'ucp', status: 'not_detected', confidence: 'high', response_time_ms: responseTime, capabilities: {} };
    }

    const text = await res.text();
    let profile: Record<string, unknown> = {};
    try {
      profile = JSON.parse(text);
    } catch {
      return { protocol: 'ucp', status: 'not_detected', confidence: 'high', response_time_ms: responseTime, capabilities: {} };
    }

    const hasCheckoutTypes = Array.isArray(profile.checkout_types) && profile.checkout_types.length > 0;
    const hasHandlers = Array.isArray(profile.handlers) && profile.handlers.length > 0;

    return {
      protocol: 'ucp',
      status: 'confirmed',
      confidence: 'high',
      detection_method: '/.well-known/ucp',
      endpoint_url: url,
      capabilities: profile,
      response_time_ms: responseTime,
      is_functional: hasCheckoutTypes || hasHandlers,
    };
  } catch (err) {
    return {
      protocol: 'ucp',
      status: 'not_detected',
      confidence: 'low',
      response_time_ms: Date.now() - start,
      capabilities: {},
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}
