import type { MerchantScan } from '@sly/types';
import { runProbes, DEFAULT_SCAN_CONFIG, isDetected } from './probes/index.js';
import type { ScanConfig } from './probes/types.js';
import { analyzeStructuredData } from './analyzers/structured-data.js';
import { analyzeAccessibility } from './analyzers/accessibility.js';
import { computeScoreFromScanResults } from './analyzers/readiness-score.js';
import { enrichProbeResults } from './analyzers/eligibility-enricher.js';
import { classifyBusinessModel, applyBusinessModelFilter } from './analyzers/business-model.js';
import * as queries from './db/queries.js';

export interface ScanOptions {
  tenantId: string;
  domain: string;
  merchant_name?: string;
  merchant_category?: string;
  country_code?: string;
  region?: string;
  config?: Partial<ScanConfig>;
  skipIfFresh?: boolean;
  freshnessWindowMs?: number;
}

const DEFAULT_FRESHNESS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function normalizeDomain(input: string): string {
  let domain = input.trim().toLowerCase();
  domain = domain.replace(/^https?:\/\//, '');
  domain = domain.replace(/^www\./, '');
  domain = domain.replace(/\/+$/, '');
  return domain;
}

export async function scanDomain(options: ScanOptions): Promise<MerchantScan> {
  const domain = normalizeDomain(options.domain);
  const url = `https://${domain}`;
  const config: ScanConfig = { ...DEFAULT_SCAN_CONFIG, ...options.config };

  // Check freshness — skip if recently scanned
  if (options.skipIfFresh) {
    const existing = await queries.getMerchantScanByDomain(domain);
    if (existing && existing.scan_status === 'completed' && existing.last_scanned_at) {
      const scannedAt = new Date(existing.last_scanned_at).getTime();
      const window = options.freshnessWindowMs || DEFAULT_FRESHNESS_WINDOW_MS;
      if (Date.now() - scannedAt < window) {
        return existing;
      }
    }
  }

  const startTime = Date.now();

  // Create/update scan record
  const scan = await queries.upsertMerchantScan(options.tenantId, {
    domain,
    url,
    merchant_name: options.merchant_name,
    merchant_category: options.merchant_category,
    country_code: options.country_code,
    region: options.region,
    scan_status: 'scanning',
  });

  try {
    // Overall scan timeout (15s) to prevent any scan from running forever
    const OVERALL_TIMEOUT_MS = parseInt(process.env.SCANNER_OVERALL_TIMEOUT_MS || '15000');
    const scanPromise = Promise.all([
      runProbes(domain, config),
      analyzeStructuredData(domain, config),
      analyzeAccessibility(domain, config),
    ]);
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Scan timed out after ${OVERALL_TIMEOUT_MS}ms`)), OVERALL_TIMEOUT_MS)
    );

    // Run probes, structured data, and accessibility analysis in parallel
    const [probeResults, structuredData, accessibilityData] = await Promise.race([
      scanPromise,
      timeoutPromise,
    ]);

    // Classify business model
    const confirmedProtocols = probeResults
      .filter(p => p.status === 'confirmed')
      .map(p => p.protocol);

    const businessModel = classifyBusinessModel({
      merchant_category: options.merchant_category,
      ecommerce_platform: accessibilityData.ecommerce_platform,
      has_schema_product: structuredData.has_schema_product,
      has_schema_offer: structuredData.has_schema_offer,
      product_count: structuredData.product_count,
      has_homepage: accessibilityData.homepage_accessible,
      detected_protocols: confirmedProtocols,
    });

    // Enrich probe results with eligibility signals and business model filtering
    let enrichedResults = enrichProbeResults(probeResults, accessibilityData);
    enrichedResults = applyBusinessModelFilter(enrichedResults, businessModel);

    // Store results in parallel
    await Promise.all([
      queries.insertProtocolResults(scan.id, enrichedResults),
      queries.upsertStructuredData(scan.id, structuredData),
      queries.upsertAccessibility(scan.id, accessibilityData),
    ]);

    // Compute readiness scores
    const scores = computeScoreFromScanResults(enrichedResults, structuredData, accessibilityData);
    const durationMs = Date.now() - startTime;

    // Update scan with scores and business model
    await queries.updateMerchantScan(scan.id, {
      scan_status: 'completed',
      readiness_score: scores.readiness_score,
      protocol_score: scores.protocol_score,
      data_score: scores.data_score,
      accessibility_score: scores.accessibility_score,
      checkout_score: scores.checkout_score,
      business_model: businessModel,
      last_scanned_at: new Date().toISOString(),
      scan_duration_ms: durationMs,
      error_message: null,
    });

    // Return full scan with details
    return {
      ...scan,
      scan_status: 'completed' as const,
      business_model: businessModel,
      readiness_score: scores.readiness_score,
      protocol_score: scores.protocol_score,
      data_score: scores.data_score,
      accessibility_score: scores.accessibility_score,
      checkout_score: scores.checkout_score,
      last_scanned_at: new Date().toISOString(),
      scan_duration_ms: durationMs,
      protocol_results: enrichedResults.map(p => ({
        id: '',
        merchant_scan_id: scan.id,
        protocol: p.protocol,
        detected: isDetected(p.status),
        status: p.status,
        confidence: p.confidence,
        eligibility_signals: p.eligibility_signals,
        detection_method: p.detection_method,
        endpoint_url: p.endpoint_url,
        capabilities: p.capabilities,
        response_time_ms: p.response_time_ms,
        is_functional: p.is_functional,
        created_at: new Date().toISOString(),
      })),
      structured_data: {
        id: '',
        merchant_scan_id: scan.id,
        ...structuredData,
        created_at: new Date().toISOString(),
      },
      accessibility: {
        id: '',
        merchant_scan_id: scan.id,
        ...accessibilityData,
        created_at: new Date().toISOString(),
      },
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errorMessage = err instanceof Error ? err.message : 'Unknown scan error';

    await queries.updateMerchantScan(scan.id, {
      scan_status: 'failed',
      scan_duration_ms: durationMs,
      error_message: errorMessage,
    });

    return {
      ...scan,
      scan_status: 'failed' as const,
      scan_duration_ms: durationMs,
      error_message: errorMessage,
    };
  }
}
