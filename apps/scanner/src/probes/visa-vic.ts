
import * as cheerio from 'cheerio';
import type { ProbeResult, ScanConfig } from './types.js';
import { buildUrl } from './types.js';

// Specific VIC SDK script path patterns (matched against src attribute only)
const VIC_SCRIPT_PATTERNS = [
  'visa-intelligent-commerce',
  'visa.com/vic',
  'vic-sdk',
];

// Specific VIC meta tag names (exact match, not substring)
const VIC_META_NAMES = [
  'visa-intelligent-commerce',
  'vic-merchant-id',
  'vic-api-key',
];

export async function probeVisaVIC(domain: string, config: ScanConfig): Promise<ProbeResult> {
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
        protocol: 'visa_vic', status: 'not_detected', confidence: 'high',
        response_time_ms: responseTime, capabilities: {},
      };
    }

    const html = await res.text();
    const $ = cheerio.load(html);

    // Check for VIC-specific meta tags (exact name match)
    const vicMeta = VIC_META_NAMES.some(name =>
      $(`meta[name="${name}"]`).length > 0
    );

    // Check for VIC SDK scripts (src attribute only, not body text)
    let vicScript = false;
    $('script[src]').each((_, el) => {
      const src = $(el).attr('src') || '';
      if (VIC_SCRIPT_PATTERNS.some(sig => src.toLowerCase().includes(sig.toLowerCase()))) {
        vicScript = true;
      }
    });

    // Check for VIC-specific data attributes via CSS selectors
    const vicDataAttrs = $('[data-vic-merchant-id], [data-vic-api-key], [data-vic-enabled]').length > 0;

    // Check for VIC global variable in inline scripts
    let vicGlobal = false;
    $('script:not([src])').each((_, el) => {
      const content = $(el).html() || '';
      if (content.includes('visaIntelligentCommerce') || content.includes('VIC.init')) {
        vicGlobal = true;
      }
    });

    const found = vicMeta || vicScript || vicDataAttrs || vicGlobal;

    return {
      protocol: 'visa_vic',
      status: found ? 'confirmed' : 'not_detected',
      confidence: 'high',
      detection_method: found ? 'HTML meta/script/data-attr inspection' : undefined,
      endpoint_url: found ? url : undefined,
      capabilities: found ? { meta_tag: vicMeta, sdk_script: vicScript, data_attrs: vicDataAttrs, global_var: vicGlobal } : {},
      response_time_ms: responseTime,
      is_functional: found,
    };
  } catch (err) {
    return {
      protocol: 'visa_vic',
      status: 'not_detected',
      confidence: 'low',
      response_time_ms: Date.now() - start,
      capabilities: {},
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}
