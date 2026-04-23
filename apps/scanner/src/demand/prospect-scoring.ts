import type { ProspectScore, HeatMapCell, SalesPriority, DemandScoreBreakdown } from '@sly/types';
import * as queries from '../db/queries.js';

// Prospect scoring runs against the shared scan corpus — no tenant filter.

// ============================================
// SCORING WEIGHTS (from PRD 56.23)
// demand_score = 30% public_intelligence + 25% synthetic_test + 25% observatory + 20% telemetry
// ============================================

const WEIGHTS = {
  public_intelligence: 0.30,
  synthetic_test: 0.25,
  observatory: 0.25,
  telemetry: 0.20,
};

// ============================================
// PRIORITY THRESHOLDS
// ============================================

function getSalesPriority(opportunityScore: number): SalesPriority {
  if (opportunityScore > 80) return 'critical';
  if (opportunityScore > 60) return 'high';
  if (opportunityScore > 40) return 'medium';
  return 'low';
}

// ============================================
// SUB-SCORE COMPUTATIONS (each 0-100)
// ============================================

/**
 * Public intelligence score: based on demand_intelligence rows matching merchant category/region.
 * More data points + higher values = higher score.
 */
function computePublicIntelligenceScore(
  merchantCategory?: string,
  merchantRegion?: string,
  intelligenceData?: Array<{ value: number; confidence: string }>,
): number {
  if (!intelligenceData || intelligenceData.length === 0) return 0;

  // Filter relevant data
  const relevant = intelligenceData;
  if (relevant.length === 0) return 0;

  // Score based on count of data points (capped at 10) and avg confidence
  const countScore = Math.min(relevant.length / 10, 1) * 50;
  const avgValue = relevant.reduce((sum, d) => sum + d.value, 0) / relevant.length;
  const valueScore = Math.min(avgValue / 100, 1) * 30;
  const confidenceScore = relevant.filter(d => d.confidence === 'high').length / relevant.length * 20;

  return Math.round(countScore + valueScore + confidenceScore);
}

/**
 * Synthetic test score: based on agent shopping test results.
 * Lower success rate = higher demand signal (agents are trying but failing).
 */
function computeSyntheticTestScore(
  testResult?: { success_rate: number; total_steps: number; completed_steps: number; blockers: unknown[] },
): number {
  if (!testResult) return 0;

  // Agents attempted the flow = there's demand. Lower success = bigger gap = more opportunity.
  const attemptScore = 30; // Having a test at all means there's interest
  const failureSignal = (1 - testResult.success_rate / 100) * 50; // Higher failure = more need for Sly
  const blockerScore = Math.min((testResult.blockers as unknown[]).length / 5, 1) * 20;

  return Math.round(attemptScore + failureSignal + blockerScore);
}

/**
 * Observatory score: based on agent_observations (AI search references, MCP listings, etc).
 * More observations = more demand from AI agents.
 */
function computeObservatoryScore(
  observationCount: number,
  sourceCount: number,
): number {
  if (observationCount === 0) return 0;

  // More observations = higher score
  const volumeScore = Math.min(observationCount / 20, 1) * 60;
  // Multiple sources = stronger signal
  const diversityScore = Math.min(sourceCount / 5, 1) * 40;

  return Math.round(volumeScore + diversityScore);
}

/**
 * Telemetry score: based on checkout_telemetry (actual agent checkout attempts).
 * More attempts + more failures = higher demand signal.
 */
function computeTelemetryScore(
  totalAttempts: number,
  failedAttempts: number,
  uniqueAgents: number,
): number {
  if (totalAttempts === 0) return 0;

  const attemptScore = Math.min(totalAttempts / 50, 1) * 40;
  const failureRate = totalAttempts > 0 ? failedAttempts / totalAttempts : 0;
  const failureSignal = failureRate * 30; // Higher failure rate = more need
  const agentDiversity = Math.min(uniqueAgents / 10, 1) * 30;

  return Math.round(attemptScore + failureSignal + agentDiversity);
}

// ============================================
// MAIN SCORING FUNCTIONS
// ============================================

interface MerchantSignalData {
  domain: string;
  merchant_name?: string;
  merchant_category?: string;
  region?: string;
  readiness_score: number;
  // Sub-signal data
  intelligenceData?: Array<{ value: number; confidence: string }>;
  testResult?: { success_rate: number; total_steps: number; completed_steps: number; blockers: unknown[] };
  observationCount: number;
  observationSourceCount: number;
  telemetryAttempts: number;
  telemetryFailures: number;
  telemetryAgents: number;
}

export function computeDemandScore(data: MerchantSignalData): ProspectScore {
  const publicScore = computePublicIntelligenceScore(
    data.merchant_category,
    data.region,
    data.intelligenceData,
  );
  const syntheticScore = computeSyntheticTestScore(data.testResult);
  const observatoryScore = computeObservatoryScore(data.observationCount, data.observationSourceCount);
  const telemetryScore = computeTelemetryScore(data.telemetryAttempts, data.telemetryFailures, data.telemetryAgents);

  const demandScore = Math.round(
    publicScore * WEIGHTS.public_intelligence +
    syntheticScore * WEIGHTS.synthetic_test +
    observatoryScore * WEIGHTS.observatory +
    telemetryScore * WEIGHTS.telemetry,
  );

  const opportunityScore = Math.round(demandScore * (1 - data.readiness_score / 100));
  const salesPriority = getSalesPriority(opportunityScore);

  return {
    domain: data.domain,
    merchant_name: data.merchant_name,
    merchant_category: data.merchant_category,
    region: data.region,
    readiness_score: data.readiness_score,
    demand_score: demandScore,
    demand_breakdown: {
      public_intelligence: publicScore,
      synthetic_test: syntheticScore,
      observatory: observatoryScore,
      telemetry: telemetryScore,
    },
    opportunity_score: opportunityScore,
    sales_priority: salesPriority,
    signals: {
      has_demand_intelligence: publicScore > 0,
      has_shopping_test: syntheticScore > 0,
      has_observatory_data: observatoryScore > 0,
      has_telemetry: telemetryScore > 0,
    },
  };
}

/**
 * Get the full prospect list: all scanned merchants scored and sorted by opportunity.
 */
export async function getProspectList(options: {
  category?: string;
  region?: string;
  min_opportunity?: number;
  priority?: SalesPriority;
  limit?: number;
} = {}): Promise<ProspectScore[]> {
  const limit = options.limit || 50;

  // 1. Get all completed scans (shared corpus)
  const { data: scans } = await queries.listMerchantScans({
    category: options.category,
    region: options.region,
    status: 'completed',
    limit: 500, // Get a large pool to score
  });

  if (scans.length === 0) return [];

  // 2. Fetch all demand signals in parallel
  const [
    intelligenceData,
    observations,
    telemetryData,
  ] = await Promise.all([
    queries.getDemandIntelligence({
      category: options.category,
      region: options.region,
      limit: 200,
    }),
    queries.getAgentObservations({ limit: 500 }),
    queries.getCheckoutTelemetryTopMerchants({ limit: 200 }),
  ]);

  // 3. Index observations by domain
  const obsByDomain: Record<string, { count: number; sources: Set<string> }> = {};
  for (const obs of observations) {
    if (!obsByDomain[obs.domain]) {
      obsByDomain[obs.domain] = { count: 0, sources: new Set() };
    }
    obsByDomain[obs.domain].count++;
    obsByDomain[obs.domain].sources.add(obs.source);
  }

  // 4. Index telemetry by domain
  const telemetryByDomain: Record<string, { attempts: number; failures: number; agents: number }> = {};
  for (const t of telemetryData) {
    telemetryByDomain[t.merchant_domain] = {
      attempts: t.total_attempts,
      failures: t.failed_attempts,
      agents: t.unique_agents,
    };
  }

  // 5. Get latest shopping test for each scanned domain
  const testByDomain: Record<string, { success_rate: number; total_steps: number; completed_steps: number; blockers: unknown[] }> = {};
  for (const scan of scans) {
    try {
      const test = await queries.getLatestAgentShoppingTest(scan.domain);
      if (test) {
        testByDomain[scan.domain] = {
          success_rate: test.success_rate,
          total_steps: test.total_steps,
          completed_steps: test.completed_steps,
          blockers: test.blockers,
        };
      }
    } catch { /* no test data */ }
  }

  // 6. Score each merchant
  const prospects: ProspectScore[] = scans.map(scan => {
    const obsData = obsByDomain[scan.domain];
    const telemetry = telemetryByDomain[scan.domain];

    return computeDemandScore({
      domain: scan.domain,
      merchant_name: scan.merchant_name || undefined,
      merchant_category: scan.merchant_category || undefined,
      region: scan.region || undefined,
      readiness_score: scan.readiness_score || 0,
      intelligenceData: intelligenceData
        .filter(d =>
          (!d.category || !scan.merchant_category || d.category === scan.merchant_category) &&
          (!d.region || !scan.region || d.region === scan.region),
        )
        .map(d => ({ value: d.value, confidence: d.confidence })),
      testResult: testByDomain[scan.domain],
      observationCount: obsData?.count || 0,
      observationSourceCount: obsData?.sources.size || 0,
      telemetryAttempts: telemetry?.attempts || 0,
      telemetryFailures: telemetry?.failures || 0,
      telemetryAgents: telemetry?.agents || 0,
    });
  });

  // 7. Filter and sort
  let filtered = prospects;

  if (options.min_opportunity !== undefined) {
    filtered = filtered.filter(p => p.opportunity_score >= options.min_opportunity!);
  }
  if (options.priority) {
    filtered = filtered.filter(p => p.sales_priority === options.priority);
  }

  filtered.sort((a, b) => b.opportunity_score - a.opportunity_score);
  return filtered.slice(0, limit);
}

/**
 * Generate a heat map: category × region matrix with aggregated scores.
 */
export async function getHeatMap(): Promise<HeatMapCell[]> {
  const prospects = await getProspectList({ limit: 500 });

  // Group by category × region
  const cells: Record<string, {
    category: string;
    region: string;
    merchants: ProspectScore[];
  }> = {};

  for (const p of prospects) {
    const cat = p.merchant_category || 'uncategorized';
    const reg = p.region || 'unknown';
    const key = `${cat}|${reg}`;

    if (!cells[key]) {
      cells[key] = { category: cat, region: reg, merchants: [] };
    }
    cells[key].merchants.push(p);
  }

  // Compute aggregates per cell
  const heatMap: HeatMapCell[] = Object.values(cells).map(cell => {
    const count = cell.merchants.length;
    const avgReadiness = Math.round(cell.merchants.reduce((s, m) => s + m.readiness_score, 0) / count);
    const avgDemand = Math.round(cell.merchants.reduce((s, m) => s + m.demand_score, 0) / count);
    const avgOpportunity = Math.round(cell.merchants.reduce((s, m) => s + m.opportunity_score, 0) / count);

    // Top priority is the highest priority among merchants in this cell
    const priorityOrder: SalesPriority[] = ['critical', 'high', 'medium', 'low'];
    const topPriority = priorityOrder.find(p => cell.merchants.some(m => m.sales_priority === p)) || 'low';

    return {
      category: cell.category,
      region: cell.region,
      merchant_count: count,
      avg_readiness: avgReadiness,
      avg_demand: avgDemand,
      avg_opportunity: avgOpportunity,
      top_priority: topPriority,
    };
  });

  // Sort by opportunity descending
  heatMap.sort((a, b) => b.avg_opportunity - a.avg_opportunity);
  return heatMap;
}

/**
 * Export prospect list as CSV for CRM import.
 */
export function exportProspectsAsCSV(prospects: ProspectScore[]): string {
  const headers = [
    'Domain',
    'Merchant Name',
    'Category',
    'Region',
    'Readiness Score',
    'Demand Score',
    'Opportunity Score',
    'Sales Priority',
    'Public Intelligence',
    'Synthetic Test',
    'Observatory',
    'Telemetry',
  ];

  const rows = prospects.map(p => [
    p.domain,
    p.merchant_name || '',
    p.merchant_category || '',
    p.region || '',
    p.readiness_score,
    p.demand_score,
    p.opportunity_score,
    p.sales_priority,
    p.demand_breakdown.public_intelligence,
    p.demand_breakdown.synthetic_test,
    p.demand_breakdown.observatory,
    p.demand_breakdown.telemetry,
  ]);

  const csvLines = [
    headers.join(','),
    ...rows.map(row =>
      row.map(val => {
        const str = String(val);
        return str.includes(',') || str.includes('"') ? `"${str.replace(/"/g, '""')}"` : str;
      }).join(','),
    ),
  ];

  return csvLines.join('\n');
}

/**
 * Format prospect list as markdown table for MCP.
 */
export function formatProspectsMarkdown(prospects: ProspectScore[]): string {
  if (prospects.length === 0) {
    return 'No prospects found. Run `scan_merchant` or `batch_scan` to build the dataset, then use demand intelligence tools to add demand signals.';
  }

  const lines = [
    '## Top Prospects by Opportunity Score',
    '',
    '| Rank | Domain | Opportunity | Demand | Readiness | Priority | Category | Region |',
    '|------|--------|------------|--------|-----------|----------|----------|--------|',
  ];

  prospects.forEach((p, i) => {
    lines.push(
      `| ${i + 1} | ${p.domain} | ${p.opportunity_score} | ${p.demand_score} | ${p.readiness_score} | ${p.sales_priority} | ${p.merchant_category || '-'} | ${p.region || '-'} |`,
    );
  });

  lines.push('');
  lines.push(`_${prospects.length} prospects shown. Scoring: demand × (1 − readiness/100)._`);

  // Add breakdown legend
  lines.push('');
  lines.push('**Demand Score Weights:** Public Intelligence (30%) + Synthetic Test (25%) + Observatory (25%) + Telemetry (20%)');

  return lines.join('\n');
}

/**
 * Format heat map as markdown table for MCP.
 */
export function formatHeatMapMarkdown(heatMap: HeatMapCell[]): string {
  if (heatMap.length === 0) {
    return 'No heat map data. Run scans and add demand signals first.';
  }

  const lines = [
    '## Demand Heat Map (Category × Region)',
    '',
    '| Category | Region | Merchants | Avg Readiness | Avg Demand | Avg Opportunity | Priority |',
    '|----------|--------|-----------|---------------|------------|-----------------|----------|',
  ];

  for (const cell of heatMap) {
    lines.push(
      `| ${cell.category} | ${cell.region} | ${cell.merchant_count} | ${cell.avg_readiness} | ${cell.avg_demand} | ${cell.avg_opportunity} | ${cell.top_priority} |`,
    );
  }

  lines.push('');
  lines.push(`_${heatMap.length} cells in heat map._`);

  return lines.join('\n');
}
