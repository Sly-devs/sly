
import * as cheerio from 'cheerio';
import type { ProbeResult, ScanConfig } from './types.js';
import { buildUrl } from './types.js';

// Specific AgentPay SDK script path patterns (matched against src attribute only)
const MC_SCRIPT_PATTERNS = [
  'mastercard-agent-pay',
  'mastercard.com/agentpay',
  'mc-agentpay',
];

// Specific AgentPay meta tag names (exact match)
const MC_META_NAMES = [
  'mastercard-agent-pay',
  'mc-agentpay-merchant-id',
  'mc-agentpay-api-key',
];

export async function probeMastercardAP(domain: string, config: ScanConfig): Promise<ProbeResult> {
  const url = buildUrl(domain, '/');
  const start = Date.now();

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': config.user_agent, Accept: 'text/html' },
      signal: AbortSignal.timeout(config.timeout_ms),
    });

    const responseTime = Date.now() - start;

    if (!res.ok) {
      return {
        protocol: 'mastercard_agentpay', status: 'not_detected', confidence: 'high',
        response_time_ms: responseTime, capabilities: {},
      };
    }

    const html = await res.text();
    const $ = cheerio.load(html);

    // Check for AgentPay-specific meta tags (exact name match)
    const mcMeta = MC_META_NAMES.some(name =>
      $(`meta[name="${name}"]`).length > 0
    );

    // Check for AgentPay SDK scripts (src attribute only, not body text)
    let mcScript = false;
    $('script[src]').each((_, el) => {
      const src = $(el).attr('src') || '';
      if (MC_SCRIPT_PATTERNS.some(sig => src.toLowerCase().includes(sig.toLowerCase()))) {
        mcScript = true;
      }
    });

    // Check for AgentPay-specific data attributes via CSS selectors
    const mcDataAttrs = $('[data-mc-agent-id], [data-mc-agentpay], [data-mc-agent-enabled]').length > 0;

    // Check for AgentPay global variable in inline scripts
    let mcGlobal = false;
    $('script:not([src])').each((_, el) => {
      const content = $(el).html() || '';
      if (content.includes('mastercardAgentPay') || content.includes('MCAgentPay.init')) {
        mcGlobal = true;
      }
    });

    const found = mcMeta || mcScript || mcDataAttrs || mcGlobal;

    return {
      protocol: 'mastercard_agentpay',
      status: found ? 'confirmed' : 'not_detected',
      confidence: 'high',
      detection_method: found ? 'HTML meta/script/data-attr inspection' : undefined,
      endpoint_url: found ? url : undefined,
      capabilities: found ? { meta_tag: mcMeta, sdk_script: mcScript, data_attrs: mcDataAttrs, global_var: mcGlobal } : {},
      response_time_ms: responseTime,
      is_functional: found,
    };
  } catch (err) {
    return {
      protocol: 'mastercard_agentpay',
      status: 'not_detected',
      confidence: 'low',
      response_time_ms: Date.now() - start,
      capabilities: {},
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}
