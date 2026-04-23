import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { scanDomain, normalizeDomain } from '../scanner.js';
import { BatchProcessor } from '../queue/batch-processor.js';
import { getDemandBrief, getDemandStats } from '../demand/intelligence.js';
import { runAgentShoppingTest, formatTestResultMarkdown } from '../demand/synthetic-tests.js';
import { getAgentActivityReport, formatActivityReportMarkdown } from '../demand/observatory.js';
import {
  getProspectList,
  getHeatMap,
  exportProspectsAsCSV,
  formatProspectsMarkdown,
  formatHeatMapMarkdown,
} from '../demand/prospect-scoring.js';
import {
  generateSnapshot,
  getSnapshots,
  formatSnapshotMarkdown,
  formatTrendMarkdown,
} from '../demand/snapshots.js';
import * as queries from '../db/queries.js';
import { getReadinessGrade } from '@sly/utils';

// MCP (stdio) is single-tenant per process. The tenant is configured via
// SCANNER_TENANT_ID at launch — required in production.
const MCP_TENANT_ID = (() => {
  const t = process.env.SCANNER_TENANT_ID;
  if (t) return t;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SCANNER_TENANT_ID is required when running the MCP server in production');
  }
  return 'dad4308f-f9b6-4529-a406-7c2bdf3c6071';
})();

const batchProcessor = new BatchProcessor();

export async function handleToolCall(request: CallToolRequest): Promise<{
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}> {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'scan_merchant':
        return await handleScanMerchant(args as any);
      case 'batch_scan':
        return await handleBatchScan(args as any);
      case 'get_batch_progress':
        return await handleGetBatchProgress(args as any);
      case 'get_scan_results':
        return await handleGetScanResults(args as any);
      case 'search_scans':
        return await handleSearchScans(args as any);
      case 'compare_merchants':
        return await handleCompareMerchants(args as any);
      case 'get_readiness_report':
        return await handleGetReadinessReport();
      case 'find_best_prospects':
        return await handleFindBestProspects(args as any);
      case 'get_protocol_adoption':
        return await handleGetProtocolAdoption();
      case 'get_demand_brief':
        return await handleGetDemandBrief(args as any);
      case 'get_demand_stats':
        return await handleGetDemandStats(args as any);
      case 'run_agent_shopping_test':
        return await handleRunAgentTest(args as any);
      case 'get_test_results':
        return await handleGetTestResults(args as any);
      case 'get_checkout_demand':
        return await handleGetCheckoutDemand(args as any);
      case 'get_agent_activity':
        return await handleGetAgentActivity(args as any);
      case 'get_heat_map':
        return await handleGetHeatMap();
      case 'get_traffic_monitor':
        return await handleGetTrafficMonitor(args as any);
      case 'generate_snapshot':
        return await handleGenerateSnapshot(args as any);
      case 'get_trend':
        return await handleGetTrend(args as any);
      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
  }
}

async function handleScanMerchant(args: {
  domain: string;
  merchant_name?: string;
  merchant_category?: string;
  country_code?: string;
  region?: string;
}) {
  const result = await scanDomain({
    tenantId: MCP_TENANT_ID,
    domain: args.domain,
    merchant_name: args.merchant_name,
    merchant_category: args.merchant_category,
    country_code: args.country_code,
    region: args.region,
  });

  const grade = getReadinessGrade(result.readiness_score);

  const summary = [
    `## Scan Results: ${result.domain}`,
    `**Readiness Score:** ${result.readiness_score}/100 (Grade ${grade})`,
    `**Status:** ${result.scan_status}`,
    `**Duration:** ${result.scan_duration_ms}ms`,
    '',
    '### Scores',
    `- Protocol: ${result.protocol_score}/100`,
    `- Data: ${result.data_score}/100`,
    `- Accessibility: ${result.accessibility_score}/100`,
    `- Checkout: ${result.checkout_score}/100`,
  ];

  if (result.business_model) {
    summary.push(`**Business Model:** ${result.business_model}`);
  }

  if (result.protocol_results) {
    summary.push('', '### Protocol Detection');
    for (const p of result.protocol_results) {
      const statusLabel = formatDetectionStatus(p);
      summary.push(`- **${p.protocol}**: ${statusLabel}${p.endpoint_url ? ` (${p.endpoint_url})` : ''}`);
    }
  }

  if (result.accessibility) {
    summary.push('', '### Accessibility');
    if (result.accessibility.ecommerce_platform) {
      summary.push(`- Platform: ${result.accessibility.ecommerce_platform}`);
    }
    summary.push(`- CAPTCHA: ${result.accessibility.has_captcha ? 'Yes' : 'No'}`);
    summary.push(`- Guest Checkout: ${result.accessibility.guest_checkout_available ? 'Yes' : 'No'}`);
    if (result.accessibility.payment_processors.length > 0) {
      summary.push(`- Payment Processors: ${result.accessibility.payment_processors.join(', ')}`);
    }
    summary.push(`- Blocks GPTBot: ${result.accessibility.robots_blocks_gptbot ? 'Yes' : 'No'}`);
    summary.push(`- Blocks ClaudeBot: ${result.accessibility.robots_blocks_claudebot ? 'Yes' : 'No'}`);
  }

  return { content: [{ type: 'text' as const, text: summary.join('\n') }] };
}

async function handleBatchScan(args: {
  domains: Array<{ domain: string; merchant_name?: string; merchant_category?: string; country_code?: string; region?: string }>;
  name?: string;
}) {
  const batch = await queries.createBatch(MCP_TENANT_ID, {
    name: args.name || `MCP Batch ${new Date().toISOString()}`,
    target_domains: args.domains.map(d => d.domain),
  });

  // Start in background
  batchProcessor.processBatch(batch.id, MCP_TENANT_ID, args.domains);

  return {
    content: [{
      type: 'text' as const,
      text: `Batch scan started.\n**Batch ID:** ${batch.id}\n**Domains:** ${args.domains.length}\n\nUse \`get_batch_progress\` with batch_id "${batch.id}" to check progress.`,
    }],
  };
}

async function handleGetBatchProgress(args: { batch_id: string }) {
  const batch = await queries.getBatch(args.batch_id);
  if (!batch) {
    return { content: [{ type: 'text' as const, text: 'Batch not found.' }], isError: true };
  }

  const progress = batch.total_targets > 0
    ? Math.round(((batch.completed_targets + batch.failed_targets) / batch.total_targets) * 100)
    : 0;

  return {
    content: [{
      type: 'text' as const,
      text: [
        `## Batch: ${batch.name}`,
        `**Status:** ${batch.status}`,
        `**Progress:** ${progress}% (${batch.completed_targets} completed, ${batch.failed_targets} failed, ${batch.total_targets} total)`,
        batch.started_at ? `**Started:** ${batch.started_at}` : '',
        batch.completed_at ? `**Completed:** ${batch.completed_at}` : '',
      ].filter(Boolean).join('\n'),
    }],
  };
}

async function handleGetScanResults(args: { domain: string }) {
  const domain = normalizeDomain(args.domain);
  const scan = await queries.getMerchantScanByDomain(domain);

  if (!scan) {
    return { content: [{ type: 'text' as const, text: `No scan found for domain: ${domain}. Use \`scan_merchant\` to scan it first.` }] };
  }

  const full = await queries.getMerchantScanWithDetails(scan.id);
  return { content: [{ type: 'text' as const, text: JSON.stringify(full, null, 2) }] };
}

async function handleSearchScans(args: {
  category?: string;
  region?: string;
  status?: string;
  min_score?: number;
  max_score?: number;
  page?: number;
  limit?: number;
}) {
  const result = await queries.listMerchantScans({
    category: args.category,
    region: args.region,
    status: args.status,
    min_score: args.min_score,
    max_score: args.max_score,
    page: args.page || 1,
    limit: Math.min(args.limit || 20, 100),
  });

  const lines = [
    `Found ${result.total} scans (showing page ${args.page || 1})`,
    '',
    '| Domain | Score | Grade | Category | Status |',
    '|--------|-------|-------|----------|--------|',
  ];

  for (const scan of result.data) {
    const grade = getReadinessGrade(scan.readiness_score);
    lines.push(`| ${scan.domain} | ${scan.readiness_score} | ${grade} | ${scan.merchant_category || '-'} | ${scan.scan_status} |`);
  }

  return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
}

async function handleCompareMerchants(args: { domains: string[] }) {
  const results = [];
  for (const domain of args.domains.slice(0, 10)) {
    const normalized = normalizeDomain(domain);
    const scan = await queries.getMerchantScanByDomain(normalized);
    if (scan) {
      results.push(scan);
    } else {
      results.push({ domain: normalized, readiness_score: -1, scan_status: 'not_scanned' });
    }
  }

  const lines = [
    '## Merchant Comparison',
    '',
    '| Domain | Readiness | Protocol | Data | Access | Checkout | Grade |',
    '|--------|-----------|----------|------|--------|----------|-------|',
  ];

  for (const r of results) {
    if ('protocol_score' in r && r.readiness_score >= 0) {
      const grade = getReadinessGrade(r.readiness_score);
      lines.push(`| ${r.domain} | ${r.readiness_score} | ${r.protocol_score} | ${r.data_score} | ${r.accessibility_score} | ${r.checkout_score} | ${grade} |`);
    } else {
      lines.push(`| ${(r as any).domain} | - | - | - | - | - | Not scanned |`);
    }
  }

  return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
}

async function handleGetReadinessReport() {
  const stats = await queries.getScanStats();

  const lines = [
    '## Readiness Report',
    '',
    `**Total Scanned:** ${stats.total}`,
    `**Completed:** ${stats.completed}`,
    `**Average Readiness Score:** ${stats.avg_readiness_score}/100`,
    '',
    '### By Category',
    ...Object.entries(stats.by_category).map(([cat, count]) => `- ${cat}: ${count} merchants`),
    '',
    '### By Region',
    ...Object.entries(stats.by_region).map(([reg, count]) => `- ${reg}: ${count} merchants`),
  ];

  return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
}

async function handleFindBestProspects(args: {
  category?: string;
  region?: string;
  min_opportunity?: number;
  priority?: string;
  limit?: number;
  export_csv?: boolean;
}) {
  const prospects = await getProspectList({
    category: args.category,
    region: args.region,
    min_opportunity: args.min_opportunity,
    priority: args.priority as 'critical' | 'high' | 'medium' | 'low' | undefined,
    limit: args.limit || 10,
  });

  if (args.export_csv) {
    const csv = exportProspectsAsCSV(prospects);
    return { content: [{ type: 'text' as const, text: csv }] };
  }

  const markdown = formatProspectsMarkdown(prospects);
  return { content: [{ type: 'text' as const, text: markdown }] };
}

async function handleGetHeatMap() {
  const heatMap = await getHeatMap();
  const markdown = formatHeatMapMarkdown(heatMap);
  return { content: [{ type: 'text' as const, text: markdown }] };
}

async function handleGetProtocolAdoption() {
  const adoption = await queries.getProtocolAdoption();

  const lines = [
    '## Protocol Adoption Rates',
    '',
    '| Protocol | Detected | Functional | Total | Rate |',
    '|----------|----------|------------|-------|------|',
  ];

  for (const [protocol, data] of Object.entries(adoption)) {
    lines.push(`| ${protocol} | ${data.detected} | ${data.functional} | ${data.total} | ${data.adoption_rate}% |`);
  }

  return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
}

async function handleGetDemandBrief(args: { category?: string; region?: string }) {
  const brief = await getDemandBrief(args.category, args.region);
  return { content: [{ type: 'text' as const, text: brief.narrative }] };
}

async function handleGetDemandStats(args: {
  source?: string;
  metric?: string;
  category?: string;
  region?: string;
  limit?: number;
}) {
  const stats = await getDemandStats(args);
  return { content: [{ type: 'text' as const, text: JSON.stringify(stats, null, 2) }] };
}

async function handleRunAgentTest(args: { domain: string; test_type?: string }) {
  const result = await runAgentShoppingTest(
    MCP_TENANT_ID,
    args.domain,
    (args.test_type as 'browse' | 'search' | 'add_to_cart' | 'checkout' | 'full_flow') || undefined,
  );
  const markdown = formatTestResultMarkdown(result);
  return { content: [{ type: 'text' as const, text: markdown }] };
}

async function handleGetTestResults(args: { domain: string }) {
  const results = await queries.getAgentShoppingTests(normalizeDomain(args.domain));
  if (results.length === 0) {
    return { content: [{ type: 'text' as const, text: `No test results for ${args.domain}. Run \`run_agent_shopping_test\` first.` }] };
  }
  const markdown = formatTestResultMarkdown(results[0]);
  return { content: [{ type: 'text' as const, text: markdown }] };
}

async function handleGetCheckoutDemand(args: { limit?: number; since?: string; failures_only?: boolean }) {
  const signals = await queries.getCheckoutTelemetryTopMerchants({
    limit: args.limit,
    since: args.since,
    failures_only: args.failures_only,
  });

  if (signals.length === 0) {
    return {
      content: [{
        type: 'text' as const,
        text: 'No checkout telemetry data found. Telemetry is recorded when agents attempt checkouts via UCP, ACP, AP2, or x402 protocols.',
      }],
    };
  }

  const lines = [
    '## Checkout Demand — Top Merchants by Agent Attempts',
    '',
    '| Rank | Merchant | Attempts | Failed | Success Rate | Protocols | Agents | Top Failure |',
    '|------|----------|----------|--------|-------------|-----------|--------|-------------|',
  ];

  signals.forEach((s, i) => {
    const topFailure = Object.entries(s.failure_reasons)
      .sort(([, a], [, b]) => b - a)[0];
    const topFailureStr = topFailure ? `${topFailure[0]} (${topFailure[1]})` : '-';

    lines.push(
      `| ${i + 1} | ${s.merchant_name || s.merchant_domain} | ${s.total_attempts} | ${s.failed_attempts} | ${s.success_rate}% | ${s.protocols_attempted.join(', ')} | ${s.unique_agents} | ${topFailureStr} |`
    );
  });

  lines.push('', `_${signals.length} merchants shown. Data from checkout_telemetry table._`);

  return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
}

async function handleGetAgentActivity(args: { since?: string }) {
  const report = await getAgentActivityReport(args.since);
  const markdown = formatActivityReportMarkdown(report);
  return { content: [{ type: 'text' as const, text: markdown }] };
}

async function handleGenerateSnapshot(args: { period?: string }) {
  const period = (args.period || 'weekly') as 'daily' | 'weekly' | 'monthly' | 'quarterly';
  const snapshot = await generateSnapshot(period);
  const markdown = formatSnapshotMarkdown(snapshot);
  return { content: [{ type: 'text' as const, text: markdown }] };
}

async function handleGetTrend(args: { limit?: number; since?: string }) {
  const snapshots = await getSnapshots({
    limit: args.limit || 12,
    since: args.since,
  });

  if (snapshots.length === 0) {
    return {
      content: [{
        type: 'text' as const,
        text: 'No snapshots found. Use `generate_snapshot` to create the first one, then generate more over time to track trends.',
      }],
    };
  }

  if (snapshots.length === 1) {
    const markdown = formatSnapshotMarkdown(snapshots[0]);
    return { content: [{ type: 'text' as const, text: `Only 1 snapshot found (need 2+ for trend comparison).\n\n${markdown}` }] };
  }

  const markdown = formatTrendMarkdown(snapshots);
  return { content: [{ type: 'text' as const, text: markdown }] };
}

async function handleGetTrafficMonitor(args: { site_id?: string; domain?: string; limit?: number }) {
  if (args.site_id) {
    const stats = await queries.getTrafficStats(args.site_id);
    if (!stats) {
      return {
        content: [{
          type: 'text' as const,
          text: `No traffic data found for site_id "${args.site_id}". The merchant needs to install the traffic monitor snippet first.`,
        }],
      };
    }

    const lines = [
      `## Agent Traffic Monitor — ${stats.domain}`,
      `**Site ID:** ${stats.site_id}`,
      `**Total AI Visits:** ${stats.total_visits}`,
      `**Unique Agent Types:** ${stats.unique_agents}`,
      `**First Seen:** ${stats.first_seen}`,
      `**Last Seen:** ${stats.last_seen}`,
      '',
      '### Agent Breakdown',
      '| Agent | Visits | Share |',
      '|-------|--------|-------|',
    ];

    for (const [agent, count] of Object.entries(stats.agent_breakdown).sort(([, a], [, b]) => b - a)) {
      const share = stats.total_visits > 0 ? Math.round((count / stats.total_visits) * 100) : 0;
      lines.push(`| ${agent} | ${count} | ${share}% |`);
    }

    if (stats.top_pages.length > 0) {
      lines.push('', '### Top Pages', '| Page | Visits |', '|------|--------|');
      for (const p of stats.top_pages.slice(0, 10)) {
        lines.push(`| ${p.path} | ${p.visits} |`);
      }
    }

    if (stats.daily_trend.length > 0) {
      lines.push('', '### Daily Trend', '| Date | Visits |', '|------|--------|');
      for (const d of stats.daily_trend.slice(-14)) {
        lines.push(`| ${d.date} | ${d.visits} |`);
      }
    }

    const estLostRevenue = Math.round(stats.total_visits * 0.03 * 50);
    lines.push(
      '',
      '### Revenue Impact',
      `- **AI Agent Visits:** ${stats.total_visits}`,
      `- **Conversions from AI:** 0`,
      `- **Estimated Lost Revenue:** $${estLostRevenue.toLocaleString()}`,
      '',
      `_${stats.total_visits} agent visits with 0 conversions. Sly can fix this._`,
    );

    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  }

  // No site_id — return top merchants
  const limit = args.limit || 20;
  const merchants = await queries.getTopMerchantsByAgentTraffic(limit);

  if (merchants.length === 0) {
    return {
      content: [{
        type: 'text' as const,
        text: 'No agent traffic data yet. Merchants need to install the traffic monitor snippet to start tracking AI agent visits.',
      }],
    };
  }

  const lines = [
    '## Agent Traffic Monitor — Top Merchants',
    '',
    '| Rank | Domain | AI Visits | Top Agent | Top Page | First Seen | Last Seen |',
    '|------|--------|-----------|-----------|----------|------------|-----------|',
  ];

  merchants.forEach((m, i) => {
    lines.push(
      `| ${i + 1} | ${m.domain} | ${m.total_visits} | ${m.top_agent} | ${m.top_page} | ${m.first_seen.slice(0, 10)} | ${m.last_seen.slice(0, 10)} |`,
    );
  });

  lines.push('', `_${merchants.length} merchants with traffic monitor installed._`);

  return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
}

function formatDetectionStatus(p: {
  is_functional?: boolean;
  status?: string;
  confidence?: string;
  eligibility_signals?: string[];
}): string {
  const status = p.status || 'not_detected';

  switch (status) {
    case 'confirmed':
      return p.is_functional ? 'Confirmed (Functional)' : 'Confirmed';
    case 'eligible':
      return `Eligible${p.eligibility_signals?.length ? ` (${p.eligibility_signals[0]})` : ''}`;
    case 'platform_enabled':
      return `Platform-Enabled${p.eligibility_signals?.length ? ` (${p.eligibility_signals[0]})` : ''}`;
    case 'not_applicable':
      return 'N/A (not applicable to business model)';
    case 'not_detected':
    default:
      return 'Not detected';
  }
}
