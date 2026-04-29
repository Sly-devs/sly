#!/usr/bin/env tsx
/**
 * agentic.market — static market analysis.
 *
 * Pulls the public catalog at https://api.agentic.market/v1/services, runs
 * paradigm aggregation (network, integration type, price tiers, method mix),
 * persona-driven shopping walkthroughs, resale-margin analysis, and a gap
 * report. Writes a dated JSON snapshot + Markdown report under
 * docs/reports/agentic-market/.
 *
 * No platform dependencies — pure Node + fetch. Run with:
 *
 *   pnpm --filter @sly/api tsx scripts/agentic-market-analysis.ts
 *
 * Optional flags:
 *   --markup=1.25       Resale markup factor (default 1.25, mirrors resale_chain.ts)
 *   --limit=1000        Max services to pull (API caps low; we ask for the lot)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Config ─────────────────────────────────────────────────────────────

const CATALOG_URL = 'https://api.agentic.market/v1/services';

// Reachability assumptions for the gap analysis. Our agent EOAs fund Base
// (mainnet + Sepolia) USDC today; Solana EOAs aren't provisioned.
//
// agentic.market labels Base in three formats — friendly names + CAIP-2
// chain IDs. `eip155:8453` = Base mainnet, `eip155:84532` = Base Sepolia.
// Cover all variants so the reachability count isn't artificially low.
const REACHABLE_NETWORKS = new Set([
  'Base',
  'Base-Sepolia',
  'Base Sepolia',
  'eip155:8453',     // Base mainnet (CAIP-2)
  'eip155:84532',    // Base Sepolia (CAIP-2)
]);
const REACHABLE_CURRENCIES = new Set(['USDC']);

// Services that contribute disproportionately many endpoints (e.g., a
// parametric API listing one URL per resource) are called out separately
// so they don't drown the topline aggregates.
const OUTLIER_ENDPOINT_THRESHOLD = 1000;

// Endpoints with absurdly high advertised prices (e.g., $500,000/call) are
// almost certainly test data or wei-vs-USDC parse errors at the source.
// Capping the resale + addressable-spend math at a realistic per-call ceiling
// keeps the top-20 lists actionable. Anything above this is reported in a
// separate "extreme-price outliers" section.
const REALISTIC_PRICE_CEILING_USDC = 10.0;

// Persona budgets (USDC / month) + strategy. Strategies match
// apps/marketplace-sim/src/scenarios/blocks/merchant_comparison.ts:51
// (strategyFor()) so the walkthrough is consistent with what the live sim
// would do at runtime.
type Strategy = 'lowest_price' | 'highest_rating' | 'weighted';
interface Persona {
  name: string;
  monthlyBudgetUsdc: number;
  strategy: Strategy;
  preferredCategories?: string[]; // soft hint, not a hard filter
  callsPerEndpoint: number;       // expected calls/month per chosen endpoint
}
const PERSONAS: Persona[] = [
  { name: 'WhaleBot',         monthlyBudgetUsdc: 20.00, strategy: 'highest_rating', callsPerEndpoint: 30, preferredCategories: ['Search', 'AI', 'Data', 'Research'] },
  { name: 'QualityReviewer',  monthlyBudgetUsdc: 10.00, strategy: 'highest_rating', callsPerEndpoint: 20, preferredCategories: ['Research', 'Data', 'Analysis'] },
  { name: 'MMBot',            monthlyBudgetUsdc:  5.00, strategy: 'lowest_price',   callsPerEndpoint: 50, preferredCategories: ['Infra', 'Data'] },
  { name: 'HonestBot',        monthlyBudgetUsdc:  3.00, strategy: 'weighted',       callsPerEndpoint: 30 },
  { name: 'OpportunistBot',   monthlyBudgetUsdc:  2.00, strategy: 'lowest_price',   callsPerEndpoint: 25 },
  { name: 'BudgetBot',        monthlyBudgetUsdc:  1.00, strategy: 'lowest_price',   callsPerEndpoint: 30 },
  { name: 'NewcomerBot',      monthlyBudgetUsdc:  0.50, strategy: 'lowest_price',   callsPerEndpoint: 15 },
];

// ─── Catalog types (mirror agentic.market response shape) ──────────────

interface CatalogPricing {
  amount?: string;           // empty string when free / dynamic
  currency?: string;         // typically 'USDC'
  network?: string;          // 'Base' | 'Solana' | ...
  asset?: string;
}
interface CatalogEndpoint {
  url: string;
  method?: string;
  description?: string;
  pricing?: CatalogPricing;
  providerName?: string;
}
interface CatalogService {
  id: string;
  name: string;
  description?: string;
  domain?: string;
  provider?: string;
  category?: string;
  networks?: string[];
  enriched?: boolean;
  integrationType?: string;  // '1P' | '3P' | undefined
  quality?: any;
  endpoints?: CatalogEndpoint[];
}

interface FlatEndpoint {
  serviceId: string;
  serviceName: string;
  category: string;
  provider: string;
  domain: string;
  integrationType: string;
  url: string;
  method: string;
  description: string;
  priceUsdc: number | null;   // null = empty / dynamic / unparseable
  currency: string;
  network: string;
  reachable: boolean;         // payable on a network we currently fund
}

// ─── Helpers ───────────────────────────────────────────────────────────

function parseFlag(name: string, fallback: string): string {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.slice(name.length + 3) : fallback;
}

function pad(n: number, width = 5): string {
  return String(n).padStart(width);
}

// Always use en-US for thousand separators — script runs on dev machines
// where the system locale (e.g. es-ES) would format 32477 as "32.477", which
// reads as decimal in a Markdown table.
function fmtInt(n: number): string {
  return n.toLocaleString('en-US');
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function percentile(nums: number[], p: number): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

function pct(part: number, whole: number): string {
  if (whole === 0) return '—';
  return `${((part / whole) * 100).toFixed(1)}%`;
}

function fmtUsd(n: number, digits = 4): string {
  return `$${n.toFixed(digits)}`;
}

function pickPriceTier(p: number | null): 'free_or_dynamic' | 'micro' | 'small' | 'medium' | 'large' {
  if (p == null) return 'free_or_dynamic';
  if (p < 0.01) return 'micro';
  if (p < 0.10) return 'small';
  if (p < 1.00) return 'medium';
  return 'large';
}

function flattenCatalog(services: CatalogService[]): FlatEndpoint[] {
  const flat: FlatEndpoint[] = [];
  for (const svc of services) {
    const endpoints = Array.isArray(svc.endpoints) ? svc.endpoints : [];
    for (const ep of endpoints) {
      const pricing = ep.pricing || {};
      const priceRaw = pricing.amount;
      let priceUsdc: number | null = null;
      if (typeof priceRaw === 'string' && priceRaw.trim() !== '') {
        const n = Number(priceRaw);
        if (Number.isFinite(n)) priceUsdc = n;
      }
      const network = pricing.network || (svc.networks?.[0] || '');
      const currency = pricing.currency || 'USDC';
      const reachable = REACHABLE_NETWORKS.has(network) && REACHABLE_CURRENCIES.has(currency);
      flat.push({
        serviceId: svc.id,
        serviceName: svc.name,
        category: svc.category || 'Uncategorized',
        provider: svc.provider || ep.providerName || svc.name,
        domain: svc.domain || '',
        integrationType: svc.integrationType || 'unknown',
        url: ep.url,
        method: (ep.method || 'GET').toUpperCase(),
        description: ep.description || '',
        priceUsdc,
        currency,
        network,
        reachable,
      });
    }
  }
  return flat;
}

// ─── Persona walkthrough — mirrors merchant_comparison.ts strategies ───

function rankEndpointsForPersona(persona: Persona, endpoints: FlatEndpoint[]): FlatEndpoint[] {
  // Only consider reachable, priced endpoints for the walkthrough — agents
  // can't actually transact on the rest yet.
  const candidates = endpoints.filter((e) => e.reachable && e.priceUsdc != null && e.priceUsdc > 0);
  if (candidates.length === 0) return [];

  // For ratings we don't have a real signal yet (agentic.market doesn't
  // expose merchant ratings on every service). Use enrichment + integration
  // type as proxy: 1P enriched > 1P > 3P > unknown. Score 0..1.
  const ratingProxy = (e: FlatEndpoint): number => {
    let score = 0.5;
    if (e.integrationType === '1P') score += 0.3;
    if (e.integrationType === '3P') score -= 0.1;
    return Math.min(1, Math.max(0, score));
  };

  const minP = Math.min(...candidates.map((e) => e.priceUsdc!));
  const maxP = Math.max(...candidates.map((e) => e.priceUsdc!));
  const range = maxP - minP || 1;

  const scored = candidates.map((e) => {
    const priceScore = 1 - (e.priceUsdc! - minP) / range;
    const ratingScore = ratingProxy(e);
    const categoryBoost = persona.preferredCategories?.includes(e.category) ? 0.15 : 0;
    let blend: number;
    if (persona.strategy === 'lowest_price') {
      blend = priceScore + categoryBoost;
    } else if (persona.strategy === 'highest_rating') {
      blend = ratingScore + categoryBoost;
    } else {
      blend = priceScore * 0.5 + ratingScore * 0.5 + categoryBoost;
    }
    return { e, blend };
  });

  scored.sort((a, b) => b.blend - a.blend);
  return scored.map((s) => s.e);
}

interface PersonaPick {
  endpoint: FlatEndpoint;
  monthlyCost: number;
}

function buildPersonaShoppingList(persona: Persona, endpoints: FlatEndpoint[]): {
  picks: PersonaPick[];
  monthlySpend: number;
  catalogCoveragePct: number;
} {
  const ranked = rankEndpointsForPersona(persona, endpoints);
  const picks: PersonaPick[] = [];
  let spend = 0;
  for (const e of ranked) {
    const cost = e.priceUsdc! * persona.callsPerEndpoint;
    if (spend + cost > persona.monthlyBudgetUsdc) continue;
    picks.push({ endpoint: e, monthlyCost: cost });
    spend += cost;
    if (picks.length >= 20) break;
  }
  const totalReachable = endpoints.filter((e) => e.reachable && e.priceUsdc != null && e.priceUsdc > 0).length;
  const coverage = totalReachable > 0 ? (picks.length / totalReachable) * 100 : 0;
  return { picks, monthlySpend: spend, catalogCoveragePct: coverage };
}

// ─── Main ──────────────────────────────────────────────────────────────

async function fetchCatalog(limit: number): Promise<CatalogService[]> {
  // The catalog API has no pagination metadata in the response — we have to
  // walk it via offset until we get an empty page or duplicates. Page size
  // is capped server-side around 200 regardless of the `limit` requested.
  const PAGE = 200;
  const seen = new Set<string>();
  const all: CatalogService[] = [];
  let offset = 0;
  let safetyHops = 0;
  while (offset < limit && safetyHops < 50) {
    safetyHops++;
    const url = `${CATALOG_URL}?limit=${PAGE}&offset=${offset}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Catalog ${url} returned HTTP ${res.status}`);
    const body = await res.json() as any;
    const page: CatalogService[] = Array.isArray(body?.services)
      ? body.services
      : Array.isArray(body)
        ? body
        : [];
    if (page.length === 0) break;
    let added = 0;
    for (const s of page) {
      if (s?.id && !seen.has(s.id)) {
        seen.add(s.id);
        all.push(s);
        added++;
      }
    }
    process.stdout.write(`[agentic-market]   page offset=${offset} → +${added} (cum ${all.length})\n`);
    if (added === 0) break; // server returned only duplicates → done
    if (page.length < PAGE) break; // last page
    offset += PAGE;
  }
  return all;
}

async function main() {
  const markup = Number(parseFlag('markup', '1.25'));
  const limit = Number(parseFlag('limit', '1000'));
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  console.log(`[agentic-market] fetching catalog from ${CATALOG_URL}?limit=${limit}…`);
  const services = await fetchCatalog(limit);
  console.log(`[agentic-market]   ${services.length} services returned`);
  if (services.length === 0) {
    console.error('No services returned. Aborting.');
    process.exit(1);
  }

  const allEndpoints = flattenCatalog(services);
  console.log(`[agentic-market]   ${allEndpoints.length} endpoints flattened (incl. parametric outliers)`);

  // Identify and split out outlier services (parametric APIs like orbisapi
  // that list one URL per resource). The aggregates report two flavors:
  // "all" (incl. outliers) and "core" (excluding) so the topline isn't
  // distorted by a single 16k-endpoint provider.
  const epCountByService: Record<string, number> = {};
  for (const e of allEndpoints) epCountByService[e.serviceId] = (epCountByService[e.serviceId] || 0) + 1;
  const outlierServiceIds = new Set(
    Object.entries(epCountByService)
      .filter(([, c]) => c >= OUTLIER_ENDPOINT_THRESHOLD)
      .map(([id]) => id),
  );
  const outliers = services
    .filter((s) => outlierServiceIds.has(s.id))
    .map((s) => ({ id: s.id, name: s.name, category: s.category || 'Uncategorized', endpointCount: epCountByService[s.id] || 0 }))
    .sort((a, b) => b.endpointCount - a.endpointCount);
  const endpoints = allEndpoints.filter((e) => !outlierServiceIds.has(e.serviceId));
  if (outliers.length > 0) {
    console.log(`[agentic-market]   excluding ${outliers.length} outlier service(s) from core aggregates: ${outliers.map((o) => `${o.name} (${o.endpointCount})`).join(', ')}`);
    console.log(`[agentic-market]   core endpoint count: ${endpoints.length}`);
  }

  // Reports dir at repo root
  const reportsDir = resolve(__dirname, '..', '..', '..', 'docs', 'reports', 'agentic-market');
  mkdirSync(reportsDir, { recursive: true });

  // ── Snapshot ──
  const snapshotPath = resolve(reportsDir, `catalog-${today}.json`);
  writeFileSync(snapshotPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: CATALOG_URL,
    serviceCount: services.length,
    endpointCount: endpoints.length,
    services,
  }, null, 2));
  console.log(`[agentic-market]   snapshot → ${snapshotPath}`);

  // ── Aggregations ──
  const byCategory: Record<string, { services: Set<string>; endpoints: number; reachableEndpoints: number; addressableSpendPerCall: number }> = {};
  const byNetwork: Record<string, number> = {};
  const byIntegration: Record<string, number> = {};
  const byMethod: Record<string, number> = {};
  const byPriceTier: Record<string, { count: number; spendPerCall: number }> = {
    free_or_dynamic: { count: 0, spendPerCall: 0 },
    micro: { count: 0, spendPerCall: 0 },
    small: { count: 0, spendPerCall: 0 },
    medium: { count: 0, spendPerCall: 0 },
    large: { count: 0, spendPerCall: 0 },
  };

  for (const e of endpoints) {
    const cat = byCategory[e.category] ||= { services: new Set(), endpoints: 0, reachableEndpoints: 0, addressableSpendPerCall: 0 };
    cat.services.add(e.serviceId);
    cat.endpoints += 1;
    if (e.reachable) cat.reachableEndpoints += 1;
    if (e.priceUsdc != null) cat.addressableSpendPerCall += e.priceUsdc;

    byNetwork[e.network || 'unspecified'] = (byNetwork[e.network || 'unspecified'] || 0) + 1;
    byIntegration[e.integrationType] = (byIntegration[e.integrationType] || 0) + 1;
    byMethod[e.method] = (byMethod[e.method] || 0) + 1;

    const tier = pickPriceTier(e.priceUsdc);
    byPriceTier[tier].count += 1;
    if (e.priceUsdc != null) byPriceTier[tier].spendPerCall += e.priceUsdc;
  }

  // ── Persona walkthroughs ──
  const personaResults = PERSONAS.map((p) => ({ persona: p, ...buildPersonaShoppingList(p, endpoints) }));

  // ── Resale-margin analysis ──
  const priced = endpoints.filter((e) => e.priceUsdc != null && e.priceUsdc > 0 && e.reachable);
  const extremePriceEndpoints = priced.filter((e) => e.priceUsdc! > REALISTIC_PRICE_CEILING_USDC);
  const realisticPriced = priced.filter((e) => e.priceUsdc! <= REALISTIC_PRICE_CEILING_USDC);
  const resaleEntries = realisticPriced.map((e) => ({
    endpoint: e,
    pricePerCall: e.priceUsdc!,
    resalePrice: Math.round(e.priceUsdc! * markup * 1e6) / 1e6,
    grossMarginPerCall: Math.round(e.priceUsdc! * (markup - 1) * 1e6) / 1e6,
  })).sort((a, b) => b.grossMarginPerCall - a.grossMarginPerCall);
  const top20Resale = resaleEntries.slice(0, 20);

  const resaleByCategory: Record<string, { endpoints: number; avgGrossMarginPerCall: number; totalGrossMarginPerCall: number }> = {};
  for (const r of resaleEntries) {
    const cat = r.endpoint.category;
    const c = resaleByCategory[cat] ||= { endpoints: 0, avgGrossMarginPerCall: 0, totalGrossMarginPerCall: 0 };
    c.endpoints += 1;
    c.totalGrossMarginPerCall += r.grossMarginPerCall;
  }
  for (const c of Object.values(resaleByCategory)) {
    c.avgGrossMarginPerCall = c.endpoints > 0 ? c.totalGrossMarginPerCall / c.endpoints : 0;
  }

  // ── Gap analysis ──
  const gaps = {
    freeOrDynamic: endpoints.filter((e) => e.priceUsdc == null).length,
    solanaOnly: endpoints.filter((e) => e.network === 'Solana' && !REACHABLE_NETWORKS.has('Solana')).length,
    nonUsdc: endpoints.filter((e) => e.currency && e.currency !== 'USDC').length,
    unknownNetwork: endpoints.filter((e) => !e.network).length,
    reachable: endpoints.filter((e) => e.reachable).length,
  };

  // ── Render report ──
  const md = renderMarkdown({
    today,
    services,
    endpoints,
    allEndpointCount: allEndpoints.length,
    outliers,
    byCategory,
    byNetwork,
    byIntegration,
    byMethod,
    byPriceTier,
    personaResults,
    resaleEntries,
    top20Resale,
    resaleByCategory,
    extremePriceCount: extremePriceEndpoints.length,
    priceCeiling: REALISTIC_PRICE_CEILING_USDC,
    gaps,
    markup,
    snapshotPath,
  });
  const reportPath = resolve(reportsDir, `analysis-${today}.md`);
  writeFileSync(reportPath, md);
  console.log(`[agentic-market]   report  → ${reportPath}`);
  console.log('');
  console.log(`Done. Open ${reportPath} for the writeup.`);
}

// ─── Markdown rendering ────────────────────────────────────────────────

function renderMarkdown(d: {
  today: string;
  services: CatalogService[];
  endpoints: FlatEndpoint[];
  allEndpointCount: number;
  outliers: Array<{ id: string; name: string; category: string; endpointCount: number }>;
  byCategory: Record<string, { services: Set<string>; endpoints: number; reachableEndpoints: number; addressableSpendPerCall: number }>;
  byNetwork: Record<string, number>;
  byIntegration: Record<string, number>;
  byMethod: Record<string, number>;
  byPriceTier: Record<string, { count: number; spendPerCall: number }>;
  personaResults: Array<{ persona: Persona; picks: PersonaPick[]; monthlySpend: number; catalogCoveragePct: number }>;
  resaleEntries: Array<{ endpoint: FlatEndpoint; pricePerCall: number; resalePrice: number; grossMarginPerCall: number }>;
  top20Resale: Array<{ endpoint: FlatEndpoint; pricePerCall: number; resalePrice: number; grossMarginPerCall: number }>;
  resaleByCategory: Record<string, { endpoints: number; avgGrossMarginPerCall: number; totalGrossMarginPerCall: number }>;
  extremePriceCount: number;
  priceCeiling: number;
  gaps: { freeOrDynamic: number; solanaOnly: number; nonUsdc: number; unknownNetwork: number; reachable: number };
  markup: number;
  snapshotPath: string;
}): string {
  const lines: string[] = [];
  const totalEndpoints = d.endpoints.length;

  lines.push(`# agentic.market — Market Analysis (${d.today})`);
  lines.push('');
  lines.push(`Snapshot of the public catalog at \`https://api.agentic.market/v1/services\` plus a forward-looking simulation walkthrough showing how Sly sim agents would shop, and where reseller economics sit. All numbers reproducible from the JSON snapshot at \`${d.snapshotPath.split('/').slice(-3).join('/')}\`.`);
  lines.push('');

  // Executive summary
  const reachablePct = (d.gaps.reachable / totalEndpoints * 100).toFixed(1);
  const pricedPct = ((totalEndpoints - d.gaps.freeOrDynamic) / totalEndpoints * 100).toFixed(1);
  const top5Categories = Object.entries(d.byCategory)
    .sort((a, b) => b[1].endpoints - a[1].endpoints)
    .slice(0, 5)
    .map(([k, v]) => `${k} (${v.services.size} svc / ${v.endpoints} ep)`).join(', ');
  lines.push(`## Executive Summary`);
  lines.push('');
  lines.push(`- **${fmtInt(d.services.length)} services / ${fmtInt(d.allEndpointCount)} endpoints** total in the catalog. Aggregates below use a **core** set of ${fmtInt(totalEndpoints)} endpoints — ${d.outliers.length} parametric outlier service(s) (≥${OUTLIER_ENDPOINT_THRESHOLD} endpoints each) are reported separately so they don't drown the topline.`);
  lines.push(`- **${pricedPct}%** of core endpoints expose a concrete price; the rest are free or dynamic and need a live probe to budget against.`);
  lines.push(`- **${reachablePct}%** of core endpoints are reachable from our agents today (Base + USDC, including CAIP-2 \`eip155:8453\`). Solana endpoints (${d.gaps.solanaOnly}) are a structural gap pending Solana EOA provisioning.`);
  lines.push(`- Top 5 categories by endpoint count: ${top5Categories}.`);
  lines.push(`- At a default ${d.markup.toFixed(2)}× markup, the priced + reachable subset (${d.resaleEntries.length} endpoints) yields a per-call gross margin total of \`${fmtUsd(d.resaleEntries.reduce((s, r) => s + r.grossMarginPerCall, 0))}\` if every endpoint is hit once.`);
  lines.push('');
  if (d.outliers.length > 0) {
    lines.push(`### Parametric outliers (excluded from core aggregates)`);
    lines.push('');
    lines.push(`| Service | Category | Endpoints | Note |`);
    lines.push(`|---|---|---:|---|`);
    for (const o of d.outliers) {
      lines.push(`| ${o.name} | ${o.category} | ${fmtInt(o.endpointCount)} | Likely one URL per resource — meaningful as a single integration target, not as N endpoints |`);
    }
    lines.push('');
  }

  // Network distribution
  lines.push(`## Paradigms`);
  lines.push('');
  lines.push(`### Network distribution`);
  lines.push('');
  lines.push(`| Network | Endpoints | Share |`);
  lines.push(`|---|---:|---:|`);
  const sortedNets = Object.entries(d.byNetwork).sort((a, b) => b[1] - a[1]);
  const HEAD_NET = 12;
  const head = sortedNets.slice(0, HEAD_NET);
  const tail = sortedNets.slice(HEAD_NET);
  for (const [n, c] of head) {
    lines.push(`| ${n} | ${fmtInt(c)} | ${pct(c, totalEndpoints)} |`);
  }
  if (tail.length > 0) {
    const tailEndpoints = tail.reduce((s, [, c]) => s + c, 0);
    lines.push(`| _other (${tail.length} chains, mostly QuickNode-style 1 endpoint per chain)_ | ${fmtInt(tailEndpoints)} | ${pct(tailEndpoints, totalEndpoints)} |`);
  }
  lines.push('');

  // Integration type
  lines.push(`### Integration type (1P first-party vs 3P relay/proxy)`);
  lines.push('');
  lines.push(`| Type | Endpoints | Share |`);
  lines.push(`|---|---:|---:|`);
  for (const [t, c] of Object.entries(d.byIntegration).sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${t} | ${c} | ${pct(c, totalEndpoints)} |`);
  }
  lines.push('');

  // Price tiers
  lines.push(`### Price tiers (per-call, USDC)`);
  lines.push('');
  lines.push(`| Tier | Range | Endpoints | Share | Per-call total |`);
  lines.push(`|---|---|---:|---:|---:|`);
  const tierLabels: Record<string, string> = {
    free_or_dynamic: 'free / dynamic',
    micro: '< $0.01',
    small: '$0.01 – $0.10',
    medium: '$0.10 – $1.00',
    large: '> $1.00',
  };
  for (const tier of ['free_or_dynamic', 'micro', 'small', 'medium', 'large'] as const) {
    const t = d.byPriceTier[tier];
    lines.push(`| ${tier} | ${tierLabels[tier]} | ${fmtInt(t.count)} | ${pct(t.count, totalEndpoints)} | ${fmtUsd(t.spendPerCall, 2)} |`);
  }
  lines.push('');
  // Percentile stats so the gross-margin total ($X.XM) doesn't read as a
  // single-API number — it's a sum across thousands of endpoints, mostly
  // dominated by a few high-priced ones in the large tier.
  const pricedNums = d.endpoints.filter((e) => e.priceUsdc != null && e.priceUsdc > 0).map((e) => e.priceUsdc!);
  if (pricedNums.length > 0) {
    lines.push(`Per-call price percentiles across the priced subset (n=${fmtInt(pricedNums.length)}): p50 ${fmtUsd(median(pricedNums))} · p90 ${fmtUsd(percentile(pricedNums, 90))} · p99 ${fmtUsd(percentile(pricedNums, 99))} · max ${fmtUsd(Math.max(...pricedNums))}. The bulk of the catalog is sub-cent; the gross-margin total above is dominated by a long tail of \$10/call data + node services.`);
    lines.push('');
  }

  // Method mix
  lines.push(`### Method mix`);
  lines.push('');
  lines.push(`| Method | Endpoints | Share |`);
  lines.push(`|---|---:|---:|`);
  for (const [m, c] of Object.entries(d.byMethod).sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${m} | ${c} | ${pct(c, totalEndpoints)} |`);
  }
  lines.push('');

  // Top categories
  lines.push(`### Top 10 categories (by endpoint count)`);
  lines.push('');
  lines.push(`| Category | Services | Endpoints | Reachable today | Per-call addressable |`);
  lines.push(`|---|---:|---:|---:|---:|`);
  const catRows = Object.entries(d.byCategory)
    .sort((a, b) => b[1].endpoints - a[1].endpoints)
    .slice(0, 10);
  for (const [cat, c] of catRows) {
    lines.push(`| ${cat} | ${c.services.size} | ${c.endpoints} | ${c.reachableEndpoints} | ${fmtUsd(c.addressableSpendPerCall)} |`);
  }
  lines.push('');

  // Persona walkthroughs
  lines.push(`## Persona shopping walkthroughs`);
  lines.push('');
  lines.push(`Each persona evaluates the reachable catalog under their monthly budget using the same selection rubric that lives in \`apps/marketplace-sim/src/scenarios/blocks/merchant_comparison.ts\`. \`callsPerEndpoint\` is an assumed monthly call volume per chosen endpoint — tweak per scenario.`);
  lines.push('');
  for (const r of d.personaResults) {
    lines.push(`### ${r.persona.name} — ${r.persona.strategy}, $${r.persona.monthlyBudgetUsdc.toFixed(2)}/mo, ${r.persona.callsPerEndpoint} calls/endpoint`);
    lines.push('');
    lines.push(`Picked **${r.picks.length}** endpoints. Total monthly spend **${fmtUsd(r.monthlySpend, 4)}** (${(r.monthlySpend / r.persona.monthlyBudgetUsdc * 100).toFixed(1)}% of budget). Catalog coverage: ${r.catalogCoveragePct.toFixed(1)}% of priced+reachable endpoints.`);
    lines.push('');
    if (r.picks.length === 0) {
      lines.push('_No reachable endpoints fit this budget — the catalog\'s smallest priced+reachable endpoint costs more than this persona can afford for a meaningful call volume._');
      lines.push('');
      continue;
    }
    lines.push(`| # | Service | Category | Per call | Monthly cost | URL |`);
    lines.push(`|---:|---|---|---:|---:|---|`);
    for (let i = 0; i < r.picks.length; i++) {
      const p = r.picks[i];
      lines.push(`| ${i + 1} | ${p.endpoint.serviceName} | ${p.endpoint.category} | ${fmtUsd(p.endpoint.priceUsdc!)} | ${fmtUsd(p.monthlyCost)} | \`${p.endpoint.url}\` |`);
    }
    lines.push('');
  }

  // Resale margins
  lines.push(`## Resale-margin analysis (${d.markup.toFixed(2)}× markup)`);
  lines.push('');
  lines.push(`Reseller pattern from \`resale_chain_acp\`: agent buys upstream, repackages at +${((d.markup - 1) * 100).toFixed(0)}%, peer pays via AP2 mandate. Per-call gross margin = (markup − 1) × upstream price.`);
  if (d.extremePriceCount > 0) {
    lines.push('');
    lines.push(`> Excluded **${fmtInt(d.extremePriceCount)}** endpoint(s) with advertised prices above \`${fmtUsd(d.priceCeiling, 2)}/call\` from the resale ranking and per-category totals — these are almost certainly test data or wei↔USDC parse errors at the source. Treat any catalog entry above this ceiling as suspicious until probed.`);
  }
  lines.push('');
  lines.push(`### Top 20 endpoints by per-call gross margin (≤ ${fmtUsd(d.priceCeiling, 2)} cap)`);
  lines.push('');
  lines.push(`| # | Service | Category | Cost | Resale | Margin |`);
  lines.push(`|---:|---|---|---:|---:|---:|`);
  for (let i = 0; i < d.top20Resale.length; i++) {
    const r = d.top20Resale[i];
    lines.push(`| ${i + 1} | ${r.endpoint.serviceName} | ${r.endpoint.category} | ${fmtUsd(r.pricePerCall)} | ${fmtUsd(r.resalePrice)} | ${fmtUsd(r.grossMarginPerCall)} |`);
  }
  lines.push('');
  lines.push(`### By category (priced + reachable only)`);
  lines.push('');
  lines.push(`| Category | Endpoints | Avg margin/call | Total margin/call (sum) |`);
  lines.push(`|---|---:|---:|---:|`);
  for (const [cat, c] of Object.entries(d.resaleByCategory).sort((a, b) => b[1].totalGrossMarginPerCall - a[1].totalGrossMarginPerCall)) {
    lines.push(`| ${cat} | ${c.endpoints} | ${fmtUsd(c.avgGrossMarginPerCall)} | ${fmtUsd(c.totalGrossMarginPerCall)} |`);
  }
  lines.push('');

  // Gap analysis
  lines.push(`## Gap analysis — what blocks our agents today?`);
  lines.push('');
  lines.push(`| Gap | Endpoints | % of catalog |`);
  lines.push(`|---|---:|---:|`);
  lines.push(`| Free or dynamic pricing (no concrete price advertised) | ${d.gaps.freeOrDynamic} | ${pct(d.gaps.freeOrDynamic, totalEndpoints)} |`);
  lines.push(`| Solana-only (we don't fund Solana EOAs yet) | ${d.gaps.solanaOnly} | ${pct(d.gaps.solanaOnly, totalEndpoints)} |`);
  lines.push(`| Non-USDC currency | ${d.gaps.nonUsdc} | ${pct(d.gaps.nonUsdc, totalEndpoints)} |`);
  lines.push(`| Unknown / unspecified network | ${d.gaps.unknownNetwork} | ${pct(d.gaps.unknownNetwork, totalEndpoints)} |`);
  lines.push(`| **Reachable end-to-end today** | **${d.gaps.reachable}** | **${pct(d.gaps.reachable, totalEndpoints)}** |`);
  lines.push('');
  lines.push(`### What it would take to close the gaps`);
  lines.push('');
  lines.push(`- **Solana support**: provision Solana EOAs and route x402 payments through a Solana-aware facilitator. Largest single unlock by endpoint count.`);
  lines.push(`- **Dynamic-pricing endpoints**: probe each one with our scanner's x402 probe (\`apps/scanner/src/probes/x402.ts\`) to extract the per-call price into the snapshot, instead of treating "" as un-budgetable.`);
  lines.push(`- **Auth-walled endpoints (not yet enumerated here)**: a synthetic shopping test (\`apps/scanner/src/demand/synthetic-tests.ts\`) per service would tell us which ones need a key on top of x402 — track and surface that as a separate column in a future revision.`);
  lines.push('');

  // Footer
  lines.push(`## Reproducing this report`);
  lines.push('');
  lines.push('```bash');
  lines.push(`pnpm --filter @sly/api tsx scripts/agentic-market-analysis.ts`);
  lines.push('```');
  lines.push('');
  lines.push(`Re-runs against the live catalog and writes a new dated snapshot + report side-by-side with this one. Pass \`--markup=1.5\` to model a different reseller take, or \`--limit=200\` to restrict the catalog pull.`);
  lines.push('');

  return lines.join('\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
