/**
 * external_marketplace_x402 — sim agents transact against EXTERNAL x402
 * endpoints listed on agentic.market.
 *
 * Differs from `merchant_buy.ts` (x402 path):
 *   - Sources endpoints from `https://api.agentic.market/v1/services` at
 *     round start, not from the local x402_endpoints table.
 *   - Calls SlyClient.x402FetchExternal which runs the full 402 → /v1/agents/
 *     :id/x402-sign → X-PAYMENT retry loop against the external URL.
 *   - Filters to networks our agent EOAs can pay (Base + USDC by default).
 *   - Caps total round spend at maxRoundSpendUsdc.
 *
 * Each successful payment emits a milestone the viewer renders as a
 * buyer→external-merchant edge (synthetic id `ext:agentic-market:<host>`).
 * Failures (over-budget, vendor 5xx, sign rejected) still cancel the
 * ledger row and emit an alert comment so the cycle never goes dark.
 */

import { SlyClient, isSuspensionError, isStaleAgentTokenError } from '../../sly-client.js';
import type { SimAgent, PersonaStyle } from '../../processors/types.js';
import type { ScenarioContext, ScenarioResult } from '../types.js';
import { filterByStyle, createAgentClient } from '../../agents/registry.js';
import { AgentStateManager } from '../../agents/agent-state.js';

const CATALOG_URL = 'https://api.agentic.market/v1/services';
const REACHABLE_NETWORKS = new Set(['Base', 'eip155:8453']); // mainnet only by default
// USDC has 6 decimals — convert to base units for the x402 amount cap.
const USDC_DECIMALS = 1_000_000;
// Anything above this is almost certainly a wei↔USDC parse error in the
// catalog (max observed: $500k/call). Skip them so a stray entry doesn't
// blow the round budget.
const REALISTIC_PRICE_CEILING_USDC = 10.0;

interface CatalogEndpointFlat {
  serviceId: string;
  serviceName: string;
  category: string;
  url: string;
  method: string;
  description: string;
  priceUsdc: number;
  network: string;
  host: string;
}

export interface ExternalMarketplaceX402Config {
  /** Hard cap on total spend per round (USDC). Default $1. */
  maxRoundSpendUsdc?: number;
  /** Max per-call price the agent will accept (USDC). Default $0.10. */
  maxPricePerCallUsdc?: number;
  defaults?: {
    cycleSleepMs?: number;
    buyerStyles?: PersonaStyle[];
  };
}

export interface RunExternalMarketplaceX402Options {
  scenarioId: string;
  config: ExternalMarketplaceX402Config;
  dryRun?: boolean;
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function loadAgenticMarketEndpoints(): Promise<CatalogEndpointFlat[]> {
  // The catalog API has no pagination metadata; walk via offset until we
  // hit a duplicate page. Page size is server-capped near 200.
  const PAGE = 200;
  const seen = new Set<string>();
  const services: any[] = [];
  let offset = 0;
  while (offset < 1000) {
    const res = await fetch(`${CATALOG_URL}?limit=${PAGE}&offset=${offset}`);
    if (!res.ok) break;
    const body = await res.json() as any;
    const page: any[] = Array.isArray(body?.services) ? body.services : [];
    if (page.length === 0) break;
    let added = 0;
    for (const s of page) {
      if (s?.id && !seen.has(s.id)) { seen.add(s.id); services.push(s); added++; }
    }
    if (added === 0 || page.length < PAGE) break;
    offset += PAGE;
  }

  const flat: CatalogEndpointFlat[] = [];
  for (const svc of services) {
    const endpoints = Array.isArray(svc.endpoints) ? svc.endpoints : [];
    for (const ep of endpoints) {
      const priceRaw = ep?.pricing?.amount;
      if (typeof priceRaw !== 'string' || priceRaw.trim() === '') continue;
      const priceUsdc = Number(priceRaw);
      if (!Number.isFinite(priceUsdc) || priceUsdc <= 0) continue;
      if (priceUsdc > REALISTIC_PRICE_CEILING_USDC) continue;
      const network = ep?.pricing?.network || svc?.networks?.[0] || '';
      if (!REACHABLE_NETWORKS.has(network)) continue;
      let host = '';
      try { host = new URL(ep.url).hostname; } catch { continue; }
      flat.push({
        serviceId: svc.id,
        serviceName: svc.name || svc.id,
        category: svc.category || 'Uncategorized',
        url: ep.url,
        method: (ep.method || 'GET').toUpperCase(),
        description: ep.description || '',
        priceUsdc,
        network,
        host,
      });
    }
  }
  return flat;
}

export async function runExternalMarketplaceX402(
  ctx: ScenarioContext,
  opts: RunExternalMarketplaceX402Options,
): Promise<ScenarioResult> {
  const { agents, durationMs, params, shouldStop } = ctx;
  const { scenarioId, config, dryRun = false } = opts;
  const baseUrl = process.env.SLY_API_URL!;
  const adminKey = process.env.SLY_PLATFORM_ADMIN_KEY!;

  const adminClient = new SlyClient({ baseUrl, adminKey });
  const cycleSleepMs = (params.cycleSleepMs as number) || config.defaults?.cycleSleepMs || 4000;
  const buyerStyles = config.defaults?.buyerStyles || (['whale', 'mm', 'honest', 'opportunist'] as PersonaStyle[]);
  const maxRoundSpendUsdc = config.maxRoundSpendUsdc ?? 1.00;
  const maxPricePerCallUsdc = config.maxPricePerCallUsdc ?? 0.10;

  const clients: Record<string, SlyClient> = {};
  for (const a of agents) clients[a.agentId] = createAgentClient(a, baseUrl, adminKey);
  const agentState = new AgentStateManager({ slyClient: adminClient });

  const buyerPool = filterByStyle(agents, buyerStyles);
  if (buyerPool.length === 0) {
    await adminClient.comment(`external_marketplace_x402: no buyers in pool (need styles ${buyerStyles.join('|')})`, 'alert');
    return { completedTrades: 0, totalVolume: 0, findings: ['Insufficient pool'] };
  }

  // Load catalog upfront — one fetch per round, not per cycle.
  let catalog: CatalogEndpointFlat[] = [];
  try {
    catalog = await loadAgenticMarketEndpoints();
  } catch (e: any) {
    await adminClient.comment(`external_marketplace_x402: catalog fetch failed: ${e.message}`, 'alert');
    return { completedTrades: 0, totalVolume: 0, findings: ['Catalog unreachable'] };
  }
  // Apply per-call cap.
  const affordable = catalog.filter((c) => c.priceUsdc <= maxPricePerCallUsdc);
  if (affordable.length === 0) {
    await adminClient.comment(
      `external_marketplace_x402: no agentic.market endpoints under $${maxPricePerCallUsdc.toFixed(2)}/call after price ceiling — try raising maxPricePerCallUsdc`,
      'alert',
    );
    return { completedTrades: 0, totalVolume: 0, findings: ['No affordable endpoints'] };
  }

  if (!dryRun) {
    await adminClient.comment(
      `external_marketplace_x402: ${buyerPool.length} buyer(s), ${affordable.length} reachable endpoints (≤$${maxPricePerCallUsdc}/call), round cap $${maxRoundSpendUsdc.toFixed(2)}`,
      'governance',
    );
  }

  const handleSuspension = (err: unknown, agent: SimAgent): boolean => {
    if (isSuspensionError(err)) { agentState.markKilled(agent.agentId, 'kill_switch', { agentName: agent.name }); return true; }
    if (isStaleAgentTokenError(err)) { agentState.markKilled(agent.agentId, 'stale_token', { agentName: agent.name }); return true; }
    return false;
  };

  let cycle = 0;
  let completedTrades = 0;
  let totalVolume = 0;
  let totalSpend = 0;
  const findings: string[] = [];
  const startedAt = Date.now();

  while (!shouldStop() && Date.now() - startedAt < durationMs) {
    cycle++;

    if (totalSpend >= maxRoundSpendUsdc) {
      await adminClient.comment(`external_marketplace_x402: round spend cap $${maxRoundSpendUsdc.toFixed(2)} reached at $${totalSpend.toFixed(4)} — ending`, 'governance');
      break;
    }

    const activeBuyers = agentState.activeAgents(buyerPool);
    if (activeBuyers.length === 0) {
      if (!dryRun) await adminClient.comment(`external_marketplace_x402: no active buyers, ending round`, 'alert');
      break;
    }

    const buyer = pick(activeBuyers);
    // Skip buyers that have no per-call budget remaining.
    const remaining = maxRoundSpendUsdc - totalSpend;
    const fits = affordable.filter((e) => e.priceUsdc <= remaining);
    if (fits.length === 0) {
      await adminClient.comment(`external_marketplace_x402: $${remaining.toFixed(4)} remaining can't cover any catalog endpoint — ending`, 'governance');
      break;
    }
    const endpoint = pick(fits);

    if (dryRun) { completedTrades++; break; }

    // Each x402-sign call needs the agent's wallet. The agent EOA wallet
    // is created at agent-seed time and lives on the platform side; the
    // signing endpoint resolves it from agentId. No walletId required here.
    const maxPriceBaseUnits = String(BigInt(Math.floor(endpoint.priceUsdc * USDC_DECIMALS)));
    const reasonText = `external x402 buy on agentic.market — ${endpoint.serviceName} (${endpoint.category})`;

    try {
      const result = await clients[buyer.agentId].x402FetchExternal({
        agentId: buyer.agentId,
        url: endpoint.url,
        method: endpoint.method,
        maxPriceBaseUnits,
        agentReason: reasonText,
      });

      if (result.paid) {
        completedTrades++;
        totalVolume += endpoint.priceUsdc;
        totalSpend += endpoint.priceUsdc;
        const merchantId = `ext:agentic-market:${endpoint.host}`;
        await adminClient.milestone(
          `⚡ ${buyer.name} paid $${endpoint.priceUsdc.toFixed(4)} on agentic.market for "${endpoint.serviceName}" — ${endpoint.category}`,
          {
            agentId: buyer.agentId,
            agentName: buyer.name,
            icon: '⚡',
            toId: merchantId,
            toName: `${endpoint.serviceName} (${endpoint.host})`,
            toKind: 'merchant',
            amount: endpoint.priceUsdc,
            currency: 'USDC',
          },
        );
      } else {
        // Vendor / facilitator failure — visible but not platform-fatal.
        await adminClient.comment(
          `external_marketplace_x402: ${buyer.name} → ${endpoint.serviceName} (${endpoint.host}) failed: HTTP ${result.status ?? 'no-response'}${result.error ? ` — ${result.error}` : ''}`,
          'alert',
        );
      }
    } catch (e: any) {
      if (!handleSuspension(e, buyer)) {
        await adminClient.comment(
          `external_marketplace_x402: ${buyer.name} crashed on ${endpoint.serviceName}: ${e.message}`,
          'alert',
        );
      }
    }

    await new Promise((r) => setTimeout(r, cycleSleepMs * (0.7 + Math.random() * 0.6)));
  }

  if (!dryRun) {
    await adminClient.comment(
      `external_marketplace_x402 complete: ${completedTrades} purchases, $${totalVolume.toFixed(4)} spent on agentic.market, ${agentState.killedCount()} agents killed`,
      'governance',
    );
  }

  findings.push(`${completedTrades} external x402 purchases against agentic.market endpoints`);
  if (agentState.killedCount() > 0) findings.push(`${agentState.killedCount()} agents killed mid-run`);

  return { completedTrades, totalVolume, findings };
}
