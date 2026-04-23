/**
 * Story 56.8: Snapshot Generator & Trend Tracking
 *
 * Captures periodic aggregate snapshots of scan data for week-over-week
 * protocol adoption tracking and readiness trend analysis.
 */
import { getClient } from '../db/client.js';

// Snapshots aggregate the shared corpus across all tenants — no tenant filter.

export interface SnapshotData {
  snapshot_date: string;
  snapshot_period: string;
  total_merchants_scanned: number;
  ucp_adoption_rate: number;
  acp_adoption_rate: number;
  ap2_adoption_rate: number;
  x402_adoption_rate: number;
  mcp_adoption_rate: number;
  any_protocol_adoption_rate: number;
  schema_org_adoption_rate: number;
  json_ld_adoption_rate: number;
  agent_blocking_rate: number;
  captcha_rate: number;
  guest_checkout_rate: number;
  avg_readiness_score: number;
  avg_protocol_score: number;
  avg_data_score: number;
  scores_by_category: Record<string, { avg: number; count: number }>;
  scores_by_region: Record<string, { avg: number; count: number }>;
  scores_by_platform: Record<string, { avg: number; count: number }>;
}

export async function generateSnapshot(
  period: 'daily' | 'weekly' | 'monthly' | 'quarterly' = 'weekly',
): Promise<SnapshotData> {
  const db = getClient();

  // Get all completed scans across the shared corpus
  const { data: scans, error: scanError } = await (db
    .from('merchant_scans') as any)
    .select('id, readiness_score, protocol_score, data_score, merchant_category, region')
    .eq('scan_status', 'completed');

  if (scanError) throw new Error(`Failed to get scans: ${scanError.message}`);
  const allScans = (scans || []) as Array<{
    id: string;
    readiness_score: number;
    protocol_score: number;
    data_score: number;
    merchant_category: string | null;
    region: string | null;
  }>;
  const total = allScans.length;

  if (total === 0) {
    throw new Error('No completed scans to snapshot');
  }

  const scanIds = allScans.map(s => s.id);

  // Fetch protocol results in chunks
  let protocolResults: Array<{ merchant_scan_id: string; protocol: string; detected: boolean; status: string }> = [];
  for (let i = 0; i < scanIds.length; i += 200) {
    const chunk = scanIds.slice(i, i + 200);
    const { data } = await db
      .from('scan_protocol_results')
      .select('merchant_scan_id, protocol, detected, status')
      .in('merchant_scan_id', chunk);
    if (data) protocolResults = protocolResults.concat(data);
  }

  // Fetch accessibility data in chunks
  let accessData: Array<{ merchant_scan_id: string; robots_blocks_gptbot: boolean; robots_blocks_claudebot: boolean; has_captcha: boolean; guest_checkout_available: boolean }> = [];
  for (let i = 0; i < scanIds.length; i += 200) {
    const chunk = scanIds.slice(i, i + 200);
    const { data } = await db
      .from('scan_accessibility')
      .select('merchant_scan_id, robots_blocks_gptbot, robots_blocks_claudebot, has_captcha, guest_checkout_available')
      .in('merchant_scan_id', chunk);
    if (data) accessData = accessData.concat(data);
  }

  // Fetch structured data in chunks
  let structuredData: Array<{ merchant_scan_id: string; has_schema_product: boolean; has_json_ld: boolean }> = [];
  for (let i = 0; i < scanIds.length; i += 200) {
    const chunk = scanIds.slice(i, i + 200);
    const { data } = await db
      .from('scan_structured_data')
      .select('merchant_scan_id, has_schema_product, has_json_ld')
      .in('merchant_scan_id', chunk);
    if (data) structuredData = structuredData.concat(data);
  }

  // Compute protocol adoption
  const protocolCounts: Record<string, number> = {};
  const merchantsWithAnyProtocol = new Set<string>();

  for (const pr of protocolResults) {
    if (pr.status === 'confirmed' || pr.status === 'platform_enabled' || pr.status === 'eligible') {
      protocolCounts[pr.protocol] = (protocolCounts[pr.protocol] || 0) + 1;
      merchantsWithAnyProtocol.add(pr.merchant_scan_id);
    }
  }

  const rate = (count: number) => total > 0 ? Math.round((count / total) * 10000) / 100 : 0;

  // Accessibility stats
  const blockers = accessData.filter(a => a.robots_blocks_gptbot || a.robots_blocks_claudebot).length;
  const captchas = accessData.filter(a => a.has_captcha).length;
  const guestCheckout = accessData.filter(a => a.guest_checkout_available).length;

  // Structured data stats
  const withSchemaOrg = structuredData.filter(s => s.has_schema_product).length;
  const withJsonLd = structuredData.filter(s => s.has_json_ld).length;

  // Score averages
  const avgReadiness = Math.round(allScans.reduce((s, r) => s + r.readiness_score, 0) / total * 100) / 100;
  const avgProtocol = Math.round(allScans.reduce((s, r) => s + r.protocol_score, 0) / total * 100) / 100;
  const avgData = Math.round(allScans.reduce((s, r) => s + r.data_score, 0) / total * 100) / 100;

  // Breakdowns
  const scoresByCategory: Record<string, { avg: number; count: number }> = {};
  const scoresByRegion: Record<string, { avg: number; count: number }> = {};

  for (const scan of allScans) {
    const cat = scan.merchant_category || 'other';
    if (!scoresByCategory[cat]) scoresByCategory[cat] = { avg: 0, count: 0 };
    scoresByCategory[cat].avg += scan.readiness_score;
    scoresByCategory[cat].count++;

    const reg = scan.region || 'unknown';
    if (!scoresByRegion[reg]) scoresByRegion[reg] = { avg: 0, count: 0 };
    scoresByRegion[reg].avg += scan.readiness_score;
    scoresByRegion[reg].count++;
  }

  for (const key of Object.keys(scoresByCategory)) {
    scoresByCategory[key].avg = Math.round(scoresByCategory[key].avg / scoresByCategory[key].count * 100) / 100;
  }
  for (const key of Object.keys(scoresByRegion)) {
    scoresByRegion[key].avg = Math.round(scoresByRegion[key].avg / scoresByRegion[key].count * 100) / 100;
  }

  const today = new Date().toISOString().slice(0, 10);

  const snapshot: SnapshotData = {
    snapshot_date: today,
    snapshot_period: period,
    total_merchants_scanned: total,
    ucp_adoption_rate: rate(protocolCounts['ucp'] || 0),
    acp_adoption_rate: rate(protocolCounts['acp'] || 0),
    ap2_adoption_rate: rate(protocolCounts['ap2'] || 0),
    x402_adoption_rate: rate(protocolCounts['x402'] || 0),
    mcp_adoption_rate: rate(protocolCounts['mcp'] || 0),
    any_protocol_adoption_rate: rate(merchantsWithAnyProtocol.size),
    schema_org_adoption_rate: rate(withSchemaOrg),
    json_ld_adoption_rate: rate(withJsonLd),
    agent_blocking_rate: rate(blockers),
    captcha_rate: rate(captchas),
    guest_checkout_rate: rate(guestCheckout),
    avg_readiness_score: avgReadiness,
    avg_protocol_score: avgProtocol,
    avg_data_score: avgData,
    scores_by_category: scoresByCategory,
    scores_by_region: scoresByRegion,
    scores_by_platform: {},
  };

  // Upsert to DB
  const { error } = await (db
    .from('scan_snapshots') as any)
    .upsert(snapshot, { onConflict: 'snapshot_date,snapshot_period' });

  if (error) throw new Error(`Failed to save snapshot: ${error.message}`);

  return snapshot;
}

export async function getSnapshots(options: {
  period?: string;
  limit?: number;
  since?: string;
} = {}): Promise<SnapshotData[]> {
  const db = getClient();

  let query = db
    .from('scan_snapshots')
    .select('*')
    .order('snapshot_date', { ascending: false })
    .limit(options.limit || 52);

  if (options.period) query = query.eq('snapshot_period', options.period);
  if (options.since) query = query.gte('snapshot_date', options.since);

  const { data, error } = await query;
  if (error) throw new Error(`Failed to get snapshots: ${error.message}`);
  return (data || []) as SnapshotData[];
}

export function formatSnapshotMarkdown(snapshot: SnapshotData): string {
  const lines = [
    `## Snapshot: ${snapshot.snapshot_date} (${snapshot.snapshot_period})`,
    '',
    `**Merchants Scanned:** ${snapshot.total_merchants_scanned}`,
    `**Average Readiness:** ${snapshot.avg_readiness_score}/100`,
    '',
    '### Protocol Adoption',
    '| Protocol | Adoption Rate |',
    '|----------|--------------|',
    `| UCP | ${snapshot.ucp_adoption_rate}% |`,
    `| ACP | ${snapshot.acp_adoption_rate}% |`,
    `| AP2 | ${snapshot.ap2_adoption_rate}% |`,
    `| x402 | ${snapshot.x402_adoption_rate}% |`,
    `| MCP | ${snapshot.mcp_adoption_rate}% |`,
    `| Any Protocol | ${snapshot.any_protocol_adoption_rate}% |`,
    '',
    '### Data & Accessibility',
    `- Schema.org: ${snapshot.schema_org_adoption_rate}%`,
    `- JSON-LD: ${snapshot.json_ld_adoption_rate}%`,
    `- Agent Blocking: ${snapshot.agent_blocking_rate}%`,
    `- CAPTCHA: ${snapshot.captcha_rate}%`,
    `- Guest Checkout: ${snapshot.guest_checkout_rate}%`,
  ];

  if (Object.keys(snapshot.scores_by_region).length > 0) {
    lines.push('', '### Readiness by Region', '| Region | Avg Score | Merchants |', '|--------|-----------|-----------|');
    for (const [region, info] of Object.entries(snapshot.scores_by_region).sort((a, b) => b[1].avg - a[1].avg)) {
      lines.push(`| ${region} | ${info.avg} | ${info.count} |`);
    }
  }

  if (Object.keys(snapshot.scores_by_category).length > 0) {
    lines.push('', '### Readiness by Category', '| Category | Avg Score | Merchants |', '|----------|-----------|-----------|');
    for (const [cat, info] of Object.entries(snapshot.scores_by_category).sort((a, b) => b[1].avg - a[1].avg)) {
      lines.push(`| ${cat} | ${info.avg} | ${info.count} |`);
    }
  }

  return lines.join('\n');
}

export function formatTrendMarkdown(snapshots: SnapshotData[]): string {
  if (snapshots.length === 0) return 'No snapshot data available.';
  if (snapshots.length === 1) return formatSnapshotMarkdown(snapshots[0]);

  const sorted = [...snapshots].sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));
  const latest = sorted[sorted.length - 1];
  const previous = sorted[sorted.length - 2];

  const delta = (a: number, b: number) => {
    const diff = a - b;
    return diff > 0 ? `+${diff.toFixed(2)}` : diff.toFixed(2);
  };

  const lines = [
    '## Trend Analysis',
    '',
    `**Latest:** ${latest.snapshot_date} | **Previous:** ${previous.snapshot_date}`,
    '',
    '| Metric | Current | Previous | Change |',
    '|--------|---------|----------|--------|',
    `| Total Scanned | ${latest.total_merchants_scanned} | ${previous.total_merchants_scanned} | ${delta(latest.total_merchants_scanned, previous.total_merchants_scanned)} |`,
    `| Avg Readiness | ${latest.avg_readiness_score} | ${previous.avg_readiness_score} | ${delta(latest.avg_readiness_score, previous.avg_readiness_score)} |`,
    `| UCP Adoption | ${latest.ucp_adoption_rate}% | ${previous.ucp_adoption_rate}% | ${delta(latest.ucp_adoption_rate, previous.ucp_adoption_rate)}pp |`,
    `| ACP Adoption | ${latest.acp_adoption_rate}% | ${previous.acp_adoption_rate}% | ${delta(latest.acp_adoption_rate, previous.acp_adoption_rate)}pp |`,
    `| Any Protocol | ${latest.any_protocol_adoption_rate}% | ${previous.any_protocol_adoption_rate}% | ${delta(latest.any_protocol_adoption_rate, previous.any_protocol_adoption_rate)}pp |`,
    `| Agent Blocking | ${latest.agent_blocking_rate}% | ${previous.agent_blocking_rate}% | ${delta(latest.agent_blocking_rate, previous.agent_blocking_rate)}pp |`,
    `| Guest Checkout | ${latest.guest_checkout_rate}% | ${previous.guest_checkout_rate}% | ${delta(latest.guest_checkout_rate, previous.guest_checkout_rate)}pp |`,
  ];

  return lines.join('\n');
}
