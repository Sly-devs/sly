
import type { ProbeResult, ScanConfig } from './types.js';
import { buildUrl } from './types.js';

export async function probeAP2(domain: string, config: ScanConfig): Promise<ProbeResult> {
  const url = buildUrl(domain, '/.well-known/ap2');
  const start = Date.now();

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': config.user_agent, Accept: 'application/json' },
      signal: AbortSignal.timeout(config.timeout_ms),
    });

    const responseTime = Date.now() - start;

    if (!res.ok) {
      return { protocol: 'ap2', status: 'not_detected', confidence: 'high', response_time_ms: responseTime, capabilities: {} };
    }

    const text = await res.text();
    let profile: Record<string, unknown> = {};
    try {
      profile = JSON.parse(text);
    } catch {
      return { protocol: 'ap2', status: 'not_detected', confidence: 'high', response_time_ms: responseTime, capabilities: {} };
    }

    return {
      protocol: 'ap2',
      status: 'confirmed',
      confidence: 'high',
      detection_method: '/.well-known/ap2',
      endpoint_url: url,
      capabilities: profile,
      response_time_ms: responseTime,
      is_functional: !!profile.mandate_types || !!profile.version,
    };
  } catch (err) {
    return {
      protocol: 'ap2',
      status: 'not_detected',
      confidence: 'low',
      response_time_ms: Date.now() - start,
      capabilities: {},
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}
