
import type { ProbeResult, ScanConfig } from './types.js';
import { buildUrl, withProbeTimeout } from './types.js';

const MCP_PATHS = ['/.well-known/mcp', '/mcp', '/.well-known/mcp.json'];
const NOT_DETECTED: ProbeResult = { protocol: 'mcp', status: 'not_detected', confidence: 'high', capabilities: {} };

export async function probeMCP(domain: string, config: ScanConfig): Promise<ProbeResult> {
  return withProbeTimeout(() => _probeMCP(domain, config), NOT_DETECTED, config.timeout_ms + 1000);
}

async function _probeMCP(domain: string, config: ScanConfig): Promise<ProbeResult> {
  const start = Date.now();

  for (const path of MCP_PATHS) {
    const url = buildUrl(domain, path);

    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'User-Agent': config.user_agent, Accept: 'application/json' },
        signal: AbortSignal.timeout(config.timeout_ms),
      });

      const responseTime = Date.now() - start;

      if (!res.ok) continue;

      const text = await res.text();
      let manifest: Record<string, unknown> = {};
      try {
        manifest = JSON.parse(text);
      } catch {
        continue;
      }

      const hasTools = Array.isArray(manifest.tools) && manifest.tools.length > 0;
      const hasResources = Array.isArray(manifest.resources) && manifest.resources.length > 0;

      return {
        protocol: 'mcp',
        status: 'confirmed',
        confidence: 'high',
        detection_method: `GET ${path}`,
        endpoint_url: url,
        capabilities: manifest,
        response_time_ms: responseTime,
        is_functional: hasTools || hasResources,
      };
    } catch {
      // Try next path
    }
  }

  return {
    protocol: 'mcp',
    status: 'not_detected',
    confidence: 'high',
    response_time_ms: Date.now() - start,
    capabilities: {},
  };
}
