import type { SupabaseClient } from '@supabase/supabase-js';
import type { MerchantScan, ScanProtocolResult, ScanBatch, DetectionStatus, AgentShoppingTestResult, AgentObservation, AgentTrafficEvent, TrafficMonitorStats } from '@sly/types';
import { getClient } from './client.js';

function isDetected(status?: string): boolean {
  return status === 'confirmed' || status === 'platform_enabled' || status === 'eligible';
}

function db(): SupabaseClient {
  return getClient();
}

// ============================================
// MERCHANT SCANS
// ============================================

export async function upsertMerchantScan(
  tenantId: string,
  data: {
    domain: string;
    url: string;
    merchant_name?: string;
    merchant_category?: string;
    country_code?: string;
    region?: string;
    scan_status: string;
  },
): Promise<MerchantScan> {
  const { data: scan, error } = await db()
    .from('merchant_scans')
    .upsert(
      { tenant_id: tenantId, ...data, scan_version: '1.0' },
      { onConflict: 'tenant_id,domain' },
    )
    .select()
    .single();

  if (error) throw new Error(`Failed to upsert merchant scan: ${error.message}`);
  return scan;
}

export async function updateMerchantScan(
  id: string,
  data: Partial<{
    scan_status: string;
    readiness_score: number;
    protocol_score: number;
    data_score: number;
    accessibility_score: number;
    checkout_score: number;
    business_model: string;
    last_scanned_at: string;
    scan_duration_ms: number;
    error_message: string | null;
  }>,
): Promise<void> {
  const { error } = await db()
    .from('merchant_scans')
    .update(data)
    .eq('id', id);

  if (error) throw new Error(`Failed to update merchant scan: ${error.message}`);
}

// Shared-corpus read: returns the freshest scan of the domain across all tenants.
// Writes remain tenant-scoped via upsertMerchantScan; reads merge the view.
export async function getMerchantScanByDomain(
  domain: string,
): Promise<MerchantScan | null> {
  const { data, error } = await db()
    .from('merchant_scans')
    .select('*')
    .eq('domain', domain)
    .order('last_scanned_at', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Failed to get merchant scan: ${error.message}`);
  return data;
}

export async function getMerchantScanById(id: string): Promise<MerchantScan | null> {
  const { data, error } = await db()
    .from('merchant_scans')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) throw new Error(`Failed to get merchant scan: ${error.message}`);
  return data;
}

export async function getMerchantScanWithDetails(id: string): Promise<MerchantScan | null> {
  const scan = await getMerchantScanById(id);
  if (!scan) return null;

  const [protocols, structured, accessibility] = await Promise.all([
    getProtocolResults(id),
    getStructuredData(id),
    getAccessibility(id),
  ]);

  return {
    ...scan,
    protocol_results: protocols,
    structured_data: structured || undefined,
    accessibility: accessibility || undefined,
  };
}

// Shared-corpus read: no tenant filter. Multiple tenants may have scanned the
// same domain — rows are not deduped here; callers wanting a single row per
// domain should use getMerchantScanByDomain.
export async function listMerchantScans(
  filters: {
    category?: string;
    region?: string;
    status?: string;
    min_score?: number;
    max_score?: number;
    page?: number;
    limit?: number;
  } = {},
): Promise<{ data: MerchantScan[]; total: number }> {
  const page = filters.page || 1;
  const limit = filters.limit || 20;
  const offset = (page - 1) * limit;

  let query = db()
    .from('merchant_scans')
    .select('*', { count: 'exact' });

  if (filters.category) query = query.eq('merchant_category', filters.category);
  if (filters.region) query = query.eq('region', filters.region);
  if (filters.status) query = query.eq('scan_status', filters.status);
  if (filters.min_score !== undefined) query = query.gte('readiness_score', filters.min_score);
  if (filters.max_score !== undefined) query = query.lte('readiness_score', filters.max_score);

  query = query.order('readiness_score', { ascending: false }).range(offset, offset + limit - 1);

  const { data, error, count } = await query;

  if (error) throw new Error(`Failed to list merchant scans: ${error.message}`);
  return { data: data || [], total: count || 0 };
}

// Shared-corpus read: no tenant filter.
export async function getScanStats(): Promise<{
  total: number;
  completed: number;
  avg_readiness_score: number;
  by_category: Record<string, number>;
  by_region: Record<string, number>;
}> {
  const { data, error } = await db()
    .from('merchant_scans')
    .select('scan_status, readiness_score, merchant_category, region');

  if (error) throw new Error(`Failed to get scan stats: ${error.message}`);

  const scans = data || [];
  const completed = scans.filter(s => s.scan_status === 'completed');
  const avgScore = completed.length > 0
    ? Math.round(completed.reduce((sum, s) => sum + s.readiness_score, 0) / completed.length)
    : 0;

  const byCategory: Record<string, number> = {};
  const byRegion: Record<string, number> = {};

  for (const scan of completed) {
    if (scan.merchant_category) {
      byCategory[scan.merchant_category] = (byCategory[scan.merchant_category] || 0) + 1;
    }
    if (scan.region) {
      byRegion[scan.region] = (byRegion[scan.region] || 0) + 1;
    }
  }

  return {
    total: scans.length,
    completed: completed.length,
    avg_readiness_score: avgScore,
    by_category: byCategory,
    by_region: byRegion,
  };
}

// ============================================
// PROTOCOL RESULTS
// ============================================

export async function insertProtocolResults(
  merchantScanId: string,
  results: Array<{
    protocol: string;
    status?: string;
    confidence?: string;
    eligibility_signals?: string[];
    detection_method?: string;
    endpoint_url?: string;
    capabilities: Record<string, unknown>;
    response_time_ms?: number;
    is_functional?: boolean;
  }>,
): Promise<void> {
  // Delete existing results for this scan
  await db()
    .from('scan_protocol_results')
    .delete()
    .eq('merchant_scan_id', merchantScanId);

  if (results.length === 0) return;

  const rows = results.map(r => ({
    merchant_scan_id: merchantScanId,
    protocol: r.protocol,
    detected: isDetected(r.status),
    status: r.status || 'not_detected',
    confidence: r.confidence || 'medium',
    eligibility_signals: r.eligibility_signals || [],
    detection_method: r.detection_method,
    endpoint_url: r.endpoint_url,
    capabilities: r.capabilities,
    response_time_ms: r.response_time_ms,
    is_functional: r.is_functional,
    last_verified_at: new Date().toISOString(),
  }));

  const { error } = await db().from('scan_protocol_results').insert(rows);
  if (error) throw new Error(`Failed to insert protocol results: ${error.message}`);
}

export async function getProtocolResults(merchantScanId: string): Promise<ScanProtocolResult[]> {
  const { data, error } = await db()
    .from('scan_protocol_results')
    .select('*')
    .eq('merchant_scan_id', merchantScanId);

  if (error) throw new Error(`Failed to get protocol results: ${error.message}`);
  return data || [];
}

// ============================================
// STRUCTURED DATA
// ============================================

export async function upsertStructuredData(
  merchantScanId: string,
  data: {
    has_schema_product: boolean;
    has_schema_offer: boolean;
    has_schema_organization: boolean;
    has_json_ld: boolean;
    has_open_graph: boolean;
    has_microdata: boolean;
    product_count: number;
    products_with_price: number;
    products_with_availability: number;
    products_with_sku: number;
    products_with_image: number;
    data_quality_score: number;
    sample_products: unknown[];
  },
): Promise<void> {
  // Delete existing
  await db()
    .from('scan_structured_data')
    .delete()
    .eq('merchant_scan_id', merchantScanId);

  const { error } = await db()
    .from('scan_structured_data')
    .insert({ merchant_scan_id: merchantScanId, ...data });

  if (error) throw new Error(`Failed to upsert structured data: ${error.message}`);
}

export async function getStructuredData(merchantScanId: string) {
  // Tolerate duplicate rows: concurrent upsertStructuredData calls (same
  // merchant_scan_id, racing DELETE-then-INSERT) can leave multiple rows.
  // Pick the most recent and let the next upsert clean up.
  const { data, error } = await db()
    .from('scan_structured_data')
    .select('*')
    .eq('merchant_scan_id', merchantScanId)
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Failed to get structured data: ${error.message}`);
  return data;
}

// ============================================
// ACCESSIBILITY
// ============================================

export async function upsertAccessibility(
  merchantScanId: string,
  data: {
    robots_txt_exists: boolean;
    robots_blocks_gptbot: boolean;
    robots_blocks_claudebot: boolean;
    robots_blocks_googlebot: boolean;
    robots_blocks_all_bots: boolean;
    robots_allows_agents: boolean;
    robots_raw?: string;
    requires_javascript: boolean;
    has_captcha: boolean;
    requires_account: boolean;
    guest_checkout_available: boolean;
    checkout_steps_count?: number;
    payment_processors: string[];
    supports_digital_wallets: boolean;
    supports_crypto: boolean;
    supports_pix: boolean;
    supports_spei: boolean;
    ecommerce_platform?: string;
    platform_version?: string;
  },
): Promise<void> {
  // Delete existing
  await db()
    .from('scan_accessibility')
    .delete()
    .eq('merchant_scan_id', merchantScanId);

  const { error } = await db()
    .from('scan_accessibility')
    .insert({ merchant_scan_id: merchantScanId, ...data });

  if (error) throw new Error(`Failed to upsert accessibility: ${error.message}`);
}

export async function getAccessibility(merchantScanId: string) {
  // Tolerate duplicate rows (same reason as getStructuredData).
  const { data, error } = await db()
    .from('scan_accessibility')
    .select('*')
    .eq('merchant_scan_id', merchantScanId)
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Failed to get accessibility: ${error.message}`);
  return data;
}

// ============================================
// SCAN BATCHES
// ============================================

export async function createBatch(
  tenantId: string,
  data: {
    name: string;
    description?: string;
    batch_type?: string;
    target_domains: string[];
    scan_config?: Record<string, unknown>;
  },
): Promise<ScanBatch> {
  const { data: batch, error } = await db()
    .from('scan_batches')
    .insert({
      tenant_id: tenantId,
      name: data.name,
      description: data.description,
      batch_type: data.batch_type || 'manual',
      target_domains: data.target_domains,
      scan_config: data.scan_config || {},
      total_targets: data.target_domains.length,
      status: 'pending',
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to create batch: ${error.message}`);
  return batch;
}

export async function updateBatch(
  id: string,
  data: Partial<{
    status: string;
    completed_targets: number;
    failed_targets: number;
    started_at: string;
    completed_at: string;
  }>,
): Promise<void> {
  const { error } = await db()
    .from('scan_batches')
    .update(data)
    .eq('id', id);

  if (error) throw new Error(`Failed to update batch: ${error.message}`);
}

export async function getBatch(id: string): Promise<ScanBatch | null> {
  const { data, error } = await db()
    .from('scan_batches')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) throw new Error(`Failed to get batch: ${error.message}`);
  return data;
}

// ============================================
// DEMAND INTELLIGENCE
// ============================================

export async function getDemandIntelligence(filters: {
  source?: string;
  metric?: string;
  category?: string;
  region?: string;
  limit?: number;
} = {}): Promise<Array<{
  id: string;
  source: string;
  metric: string;
  value: number;
  unit?: string;
  category?: string;
  region?: string;
  description?: string;
  source_url?: string;
  confidence: string;
}>> {
  let query = db()
    .from('demand_intelligence')
    .select('*');

  if (filters.source) query = query.eq('source', filters.source);
  if (filters.metric) query = query.eq('metric', filters.metric);
  if (filters.category) query = query.eq('category', filters.category);
  if (filters.region) query = query.eq('region', filters.region);

  query = query.order('collected_at', { ascending: false }).limit(filters.limit || 50);

  const { data, error } = await query;
  if (error) throw new Error(`Failed to get demand intelligence: ${error.message}`);
  return data || [];
}

export async function insertDemandIntelligence(
  rows: Array<{
    source: string;
    metric: string;
    value: number;
    unit?: string;
    category?: string;
    region?: string;
    period?: string;
    description?: string;
    source_url?: string;
    confidence?: string;
    collected_at?: string;
  }>,
): Promise<void> {
  const { error } = await db()
    .from('demand_intelligence')
    .insert(rows.map(r => ({
      ...r,
      confidence: r.confidence || 'medium',
      collected_at: r.collected_at || new Date().toISOString(),
    })));

  if (error) throw new Error(`Failed to insert demand intelligence: ${error.message}`);
}

// ============================================
// PROTOCOL ADOPTION STATS
// ============================================

// Shared-corpus read: no tenant filter.
export async function getProtocolAdoption(): Promise<Record<string, {
  detected: number;
  functional: number;
  total: number;
  adoption_rate: number;
}>> {
  const { data: scans, error: scanError } = await db()
    .from('merchant_scans')
    .select('id')
    .eq('scan_status', 'completed');

  if (scanError) throw new Error(`Failed to get scans: ${scanError.message}`);
  if (!scans || scans.length === 0) return {};

  const scanIds = scans.map(s => s.id);
  const total = scanIds.length;

  const { data: protocols, error: protoError } = await db()
    .from('scan_protocol_results')
    .select('protocol, detected, is_functional')
    .in('merchant_scan_id', scanIds);

  if (protoError) throw new Error(`Failed to get protocol results: ${protoError.message}`);

  const adoption: Record<string, { detected: number; functional: number; total: number; adoption_rate: number }> = {};

  for (const p of (protocols || [])) {
    if (!adoption[p.protocol]) {
      adoption[p.protocol] = { detected: 0, functional: 0, total, adoption_rate: 0 };
    }
    if (p.detected) {
      adoption[p.protocol].detected++;
      if (p.is_functional) adoption[p.protocol].functional++;
    }
  }

  for (const key of Object.keys(adoption)) {
    adoption[key].adoption_rate = Math.round((adoption[key].detected / total) * 100);
  }

  return adoption;
}

// ============================================
// AGENT SHOPPING TESTS
// ============================================

export async function insertAgentShoppingTest(data: {
  merchant_scan_id: string;
  domain: string;
  test_type: string;
  status: string;
  steps: unknown[];
  blockers: unknown[];
  total_steps: number;
  completed_steps: number;
  success_rate: number;
  failure_point?: unknown;
  estimated_monthly_agent_visits?: number;
  estimated_lost_conversions?: number;
  estimated_lost_revenue_usd?: number;
  recommendations?: unknown[];
  duration_ms?: number;
  agent_model?: string;
}): Promise<{ id: string }> {
  // Delete previous tests for this domain to keep latest only
  await db()
    .from('agent_shopping_tests')
    .delete()
    .eq('domain', data.domain);

  const { data: row, error } = await db()
    .from('agent_shopping_tests')
    .insert({
      merchant_scan_id: data.merchant_scan_id,
      domain: data.domain,
      test_type: data.test_type,
      status: data.status,
      steps: data.steps,
      blockers: data.blockers,
      total_steps: data.total_steps,
      completed_steps: data.completed_steps,
      success_rate: data.success_rate,
      failure_point: data.failure_point || null,
      estimated_monthly_agent_visits: data.estimated_monthly_agent_visits,
      estimated_lost_conversions: data.estimated_lost_conversions,
      estimated_lost_revenue_usd: data.estimated_lost_revenue_usd,
      recommendations: data.recommendations || [],
      duration_ms: data.duration_ms,
      agent_model: data.agent_model,
      tested_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (error) throw new Error(`Failed to insert agent shopping test: ${error.message}`);
  return { id: row.id };
}

export async function getAgentShoppingTests(
  domain: string,
  limit = 10,
): Promise<AgentShoppingTestResult[]> {
  const { data, error } = await db()
    .from('agent_shopping_tests')
    .select('*')
    .eq('domain', domain)
    .order('tested_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Failed to get agent shopping tests: ${error.message}`);
  return (data || []) as AgentShoppingTestResult[];
}

export async function getLatestAgentShoppingTest(
  domain: string,
): Promise<AgentShoppingTestResult | null> {
  const { data, error } = await db()
    .from('agent_shopping_tests')
    .select('*')
    .eq('domain', domain)
    .order('tested_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Failed to get latest agent shopping test: ${error.message}`);
  return data as AgentShoppingTestResult | null;
}

// ============================================
// AGENT OBSERVATIONS (Observatory)
// ============================================

export async function insertAgentObservation(data: {
  domain: string;
  merchant_scan_id?: string;
  observation_type: string;
  source: string;
  query?: string;
  evidence: string;
  evidence_url?: string;
  metadata?: Record<string, unknown>;
  confidence?: string;
  observed_at?: string;
}): Promise<{ id: string }> {
  const { data: row, error } = await db()
    .from('agent_observations')
    .insert({
      domain: data.domain,
      merchant_scan_id: data.merchant_scan_id || null,
      observation_type: data.observation_type,
      source: data.source,
      query: data.query,
      evidence: data.evidence,
      evidence_url: data.evidence_url,
      metadata: data.metadata || {},
      confidence: data.confidence || 'medium',
      observed_at: data.observed_at || new Date().toISOString(),
    })
    .select('id')
    .single();

  if (error) throw new Error(`Failed to insert agent observation: ${error.message}`);
  return { id: row.id };
}

export async function insertAgentObservationsBatch(
  rows: Array<{
    domain: string;
    merchant_scan_id?: string;
    observation_type: string;
    source: string;
    query?: string;
    evidence: string;
    evidence_url?: string;
    metadata?: Record<string, unknown>;
    confidence?: string;
    observed_at?: string;
  }>,
): Promise<void> {
  if (rows.length === 0) return;

  const { error } = await db()
    .from('agent_observations')
    .insert(rows.map(r => ({
      domain: r.domain,
      merchant_scan_id: r.merchant_scan_id || null,
      observation_type: r.observation_type,
      source: r.source,
      query: r.query,
      evidence: r.evidence,
      evidence_url: r.evidence_url,
      metadata: r.metadata || {},
      confidence: r.confidence || 'medium',
      observed_at: r.observed_at || new Date().toISOString(),
    })));

  if (error) throw new Error(`Failed to insert agent observations batch: ${error.message}`);
}

export async function getAgentObservations(filters: {
  domain?: string;
  observation_type?: string;
  source?: string;
  since?: string;
  limit?: number;
} = {}): Promise<AgentObservation[]> {
  let query = db()
    .from('agent_observations')
    .select('*');

  if (filters.domain) query = query.eq('domain', filters.domain);
  if (filters.observation_type) query = query.eq('observation_type', filters.observation_type);
  if (filters.source) query = query.eq('source', filters.source);
  if (filters.since) query = query.gte('observed_at', filters.since);

  query = query.order('observed_at', { ascending: false }).limit(filters.limit || 50);

  const { data, error } = await query;
  if (error) throw new Error(`Failed to get agent observations: ${error.message}`);
  return (data || []) as AgentObservation[];
}

export async function getMostReferencedMerchants(
  limit = 20,
  since?: string,
): Promise<Array<{
  domain: string;
  observation_count: number;
  sources: string[];
  types: string[];
  latest_observed_at: string;
}>> {
  let query = db()
    .from('agent_observations')
    .select('domain, source, observation_type, observed_at');

  if (since) query = query.gte('observed_at', since);

  const { data, error } = await query;
  if (error) throw new Error(`Failed to get most referenced merchants: ${error.message}`);

  // Aggregate in application code since Supabase doesn't support GROUP BY well via JS client
  const byDomain: Record<string, {
    count: number;
    sources: Set<string>;
    types: Set<string>;
    latest: string;
  }> = {};

  for (const row of (data || [])) {
    if (!byDomain[row.domain]) {
      byDomain[row.domain] = { count: 0, sources: new Set(), types: new Set(), latest: row.observed_at };
    }
    byDomain[row.domain].count++;
    byDomain[row.domain].sources.add(row.source);
    byDomain[row.domain].types.add(row.observation_type);
    if (row.observed_at > byDomain[row.domain].latest) {
      byDomain[row.domain].latest = row.observed_at;
    }
  }

  return Object.entries(byDomain)
    .map(([domain, info]) => ({
      domain,
      observation_count: info.count,
      sources: Array.from(info.sources),
      types: Array.from(info.types),
      latest_observed_at: info.latest,
    }))
    .sort((a, b) => b.observation_count - a.observation_count)
    .slice(0, limit);
}

// ============================================
// CHECKOUT TELEMETRY (Story 56.22)
// ============================================

export async function getCheckoutTelemetryTopMerchants(options: {
  limit?: number;
  since?: string;
  failures_only?: boolean;
} = {}): Promise<Array<{
  merchant_domain: string;
  merchant_name?: string;
  total_attempts: number;
  failed_attempts: number;
  success_rate: number;
  failure_reasons: Record<string, number>;
  protocols_attempted: string[];
  unique_agents: number;
  first_seen: string;
  last_seen: string;
}>> {
  const limit = options.limit || 20;

  let query = db()
    .from('checkout_telemetry')
    .select('merchant_domain, merchant_name, success, failure_reason, protocol, agent_id, created_at')
    .not('merchant_domain', 'is', null);

  if (options.since) {
    query = query.gte('created_at', options.since);
  }

  const { data, error } = await query;
  if (error) throw new Error(`Failed to get checkout telemetry: ${error.message}`);

  // Aggregate by merchant_domain (same pattern as getMostReferencedMerchants)
  const byDomain: Record<string, {
    merchant_name?: string;
    total: number;
    failed: number;
    failure_reasons: Record<string, number>;
    protocols: Set<string>;
    agents: Set<string>;
    first_seen: string;
    last_seen: string;
  }> = {};

  for (const row of (data || [])) {
    const domain = row.merchant_domain;
    if (!domain) continue;

    if (!byDomain[domain]) {
      byDomain[domain] = {
        merchant_name: row.merchant_name || undefined,
        total: 0,
        failed: 0,
        failure_reasons: {},
        protocols: new Set(),
        agents: new Set(),
        first_seen: row.created_at,
        last_seen: row.created_at,
      };
    }

    const entry = byDomain[domain];
    entry.total++;
    if (!row.success) {
      entry.failed++;
      if (row.failure_reason) {
        entry.failure_reasons[row.failure_reason] = (entry.failure_reasons[row.failure_reason] || 0) + 1;
      }
    }
    entry.protocols.add(row.protocol);
    if (row.agent_id) entry.agents.add(row.agent_id);
    if (row.merchant_name && !entry.merchant_name) entry.merchant_name = row.merchant_name;
    if (row.created_at < entry.first_seen) entry.first_seen = row.created_at;
    if (row.created_at > entry.last_seen) entry.last_seen = row.created_at;
  }

  let signals = Object.entries(byDomain).map(([domain, info]) => ({
    merchant_domain: domain,
    merchant_name: info.merchant_name,
    total_attempts: info.total,
    failed_attempts: info.failed,
    success_rate: info.total > 0 ? Math.round(((info.total - info.failed) / info.total) * 100) : 0,
    failure_reasons: info.failure_reasons,
    protocols_attempted: Array.from(info.protocols),
    unique_agents: info.agents.size,
    first_seen: info.first_seen,
    last_seen: info.last_seen,
  }));

  if (options.failures_only) {
    signals = signals.filter(s => s.failed_attempts > 0);
  }

  signals.sort((a, b) => b.total_attempts - a.total_attempts);
  return signals.slice(0, limit);
}

export async function getObservationStats(): Promise<{
  total: number;
  by_source: Record<string, number>;
  by_type: Record<string, number>;
  unique_domains: number;
}> {
  const { data, error } = await db()
    .from('agent_observations')
    .select('domain, source, observation_type');

  if (error) throw new Error(`Failed to get observation stats: ${error.message}`);

  const rows = data || [];
  const domains = new Set<string>();
  const bySource: Record<string, number> = {};
  const byType: Record<string, number> = {};

  for (const row of rows) {
    domains.add(row.domain);
    bySource[row.source] = (bySource[row.source] || 0) + 1;
    byType[row.observation_type] = (byType[row.observation_type] || 0) + 1;
  }

  return {
    total: rows.length,
    by_source: bySource,
    by_type: byType,
    unique_domains: domains.size,
  };
}

// ============================================
// AGENT TRAFFIC MONITOR (Story 56.24)
// ============================================

export async function insertAgentTrafficEvent(event: {
  site_id: string;
  domain: string;
  page_path: string;
  agent_type: string;
  detection_method: string;
  referrer?: string;
  user_agent_raw?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const { error } = await db()
    .from('agent_traffic_events')
    .insert({
      site_id: event.site_id,
      domain: event.domain,
      page_path: event.page_path || '/',
      agent_type: event.agent_type,
      detection_method: event.detection_method,
      referrer: event.referrer || null,
      user_agent_raw: event.user_agent_raw || null,
      metadata: event.metadata || {},
    });

  if (error) throw new Error(`Failed to insert agent traffic event: ${error.message}`);
}

export async function getTrafficStats(siteId: string): Promise<TrafficMonitorStats | null> {
  const { data, error } = await db()
    .from('agent_traffic_events')
    .select('site_id, domain, page_path, agent_type, detection_method, created_at')
    .eq('site_id', siteId)
    .order('created_at', { ascending: false });

  if (error) throw new Error(`Failed to get traffic stats: ${error.message}`);
  if (!data || data.length === 0) return null;

  const agentBreakdown: Record<string, number> = {};
  const pageBreakdown: Record<string, number> = {};
  const dailyBreakdown: Record<string, number> = {};
  const methodBreakdown: Record<string, number> = {};
  const agentTypes = new Set<string>();
  let firstSeen = data[data.length - 1].created_at;
  let lastSeen = data[0].created_at;

  for (const row of data) {
    agentTypes.add(row.agent_type);
    agentBreakdown[row.agent_type] = (agentBreakdown[row.agent_type] || 0) + 1;
    pageBreakdown[row.page_path] = (pageBreakdown[row.page_path] || 0) + 1;
    methodBreakdown[row.detection_method] = (methodBreakdown[row.detection_method] || 0) + 1;

    const day = row.created_at.slice(0, 10);
    dailyBreakdown[day] = (dailyBreakdown[day] || 0) + 1;

    if (row.created_at < firstSeen) firstSeen = row.created_at;
    if (row.created_at > lastSeen) lastSeen = row.created_at;
  }

  const topPages = Object.entries(pageBreakdown)
    .map(([path, visits]) => ({ path, visits }))
    .sort((a, b) => b.visits - a.visits)
    .slice(0, 20);

  const dailyTrend = Object.entries(dailyBreakdown)
    .map(([date, visits]) => ({ date, visits }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    site_id: siteId,
    domain: data[0].domain,
    total_visits: data.length,
    unique_agents: agentTypes.size,
    agent_breakdown: agentBreakdown,
    top_pages: topPages,
    daily_trend: dailyTrend,
    detection_methods: methodBreakdown,
    first_seen: firstSeen,
    last_seen: lastSeen,
  };
}

export async function getTopMerchantsByAgentTraffic(limit = 20): Promise<Array<{
  domain: string;
  site_id: string;
  total_visits: number;
  top_agent: string;
  top_page: string;
  first_seen: string;
  last_seen: string;
}>> {
  const { data, error } = await db()
    .from('agent_traffic_events')
    .select('site_id, domain, agent_type, page_path, created_at');

  if (error) throw new Error(`Failed to get top merchants by traffic: ${error.message}`);
  if (!data || data.length === 0) return [];

  const byDomain: Record<string, {
    site_id: string;
    count: number;
    agents: Record<string, number>;
    pages: Record<string, number>;
    first_seen: string;
    last_seen: string;
  }> = {};

  for (const row of data) {
    if (!byDomain[row.domain]) {
      byDomain[row.domain] = {
        site_id: row.site_id,
        count: 0,
        agents: {},
        pages: {},
        first_seen: row.created_at,
        last_seen: row.created_at,
      };
    }
    const entry = byDomain[row.domain];
    entry.count++;
    entry.agents[row.agent_type] = (entry.agents[row.agent_type] || 0) + 1;
    entry.pages[row.page_path] = (entry.pages[row.page_path] || 0) + 1;
    if (row.created_at < entry.first_seen) entry.first_seen = row.created_at;
    if (row.created_at > entry.last_seen) entry.last_seen = row.created_at;
  }

  return Object.entries(byDomain)
    .map(([domain, info]) => {
      const topAgent = Object.entries(info.agents).sort(([, a], [, b]) => b - a)[0];
      const topPage = Object.entries(info.pages).sort(([, a], [, b]) => b - a)[0];
      return {
        domain,
        site_id: info.site_id,
        total_visits: info.count,
        top_agent: topAgent?.[0] || 'unknown',
        top_page: topPage?.[0] || '/',
        first_seen: info.first_seen,
        last_seen: info.last_seen,
      };
    })
    .sort((a, b) => b.total_visits - a.total_visits)
    .slice(0, limit);
}

export async function getTrafficEventCount(siteId: string, since: string): Promise<number> {
  const { count, error } = await db()
    .from('agent_traffic_events')
    .select('id', { count: 'exact', head: true })
    .eq('site_id', siteId)
    .gte('created_at', since);

  if (error) throw new Error(`Failed to count traffic events: ${error.message}`);
  return count || 0;
}
