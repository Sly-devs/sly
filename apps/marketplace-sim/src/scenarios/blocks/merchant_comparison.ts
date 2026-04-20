/**
 * merchant_comparison — agents compare multiple merchants selling the same SKU.
 *
 * Flow per cycle:
 *   1. Pick a SKU that's offered by 2+ merchants (competing listings).
 *   2. Pick an active buyer.
 *   3. Persona-specific selection strategy:
 *        - lowest price  (budget, mm, opportunist, newcomer)
 *        - highest rating (whale, quality-reviewer, conservative)
 *        - weighted 60% price / 40% rating (honest, researcher, default)
 *   4. Create ACP checkout at the chosen merchant.
 *   5. Emit a milestone with the winner AND the full `considered` list so
 *      the viewer can compute per-merchant appearance + win rate.
 *
 * Seed requirement: `apps/api/scripts/seed-sim-commerce.ts` adds 3 roasters
 * (Atlas / Budget Beans / Midtown) with overlapping sku fields in each
 * catalog product. That's the "competing merchants offering the same SKU"
 * setup — add more as needed.
 */

import { SlyClient, isSuspensionError, isStaleAgentTokenError } from '../../sly-client.js';
import type { SimAgent, PersonaStyle } from '../../processors/types.js';
import type { ScenarioContext, ScenarioResult } from '../types.js';
import { filterByStyle, createAgentClient } from '../../agents/registry.js';
import { AgentStateManager } from '../../agents/agent-state.js';
import { randomUUID } from 'node:crypto';

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

type Strategy = 'lowest_price' | 'highest_rating' | 'weighted';

/**
 * Persona-driven shopping strategy. The earlier default ('weighted' for
 * everyone except whale/quality/mm) produced a monoculture — the weighted
 * 60/40 blend always favored the cheapest merchant when prices varied more
 * than ratings. The current mapping spreads personas across all three
 * strategies so market share actually diversifies across merchants.
 *
 *   Quality-first (highest_rating):
 *     whale, quality-reviewer, researcher, conservative
 *   Price-first (lowest_price):
 *     mm, budget, budget-trader, opportunist, newcomer, rogue-spam
 *   Balanced 50/50 (weighted):
 *     honest, colluder, rogue-disputer, (default)
 *
 * Also rebalanced weighted from 60% price / 40% rating to 50/50 so rating
 * isn't swamped when price ranges widen.
 */
function strategyFor(style: SimAgent['style'] | string | undefined): Strategy {
  if (!style) return 'weighted';
  const s = style as string;
  if (['whale', 'quality-reviewer', 'researcher', 'conservative'].includes(s)) return 'highest_rating';
  if (['mm', 'budget', 'budget-trader', 'opportunist', 'newcomer', 'rogue-spam'].includes(s)) return 'lowest_price';
  return 'weighted';
}

interface CompetingListing {
  merchantId: string;       // account uuid
  merchantName: string;
  rating: number;           // 0-5
  price: number;            // USDC
  item: { id: string; name: string; unit_price_cents: number; currency?: string; sku: string };
}

export interface MerchantComparisonConfig {
  /** Only compete on SKUs with at least this many listings. Default 2. */
  minCompetitors?: number;
  defaults?: {
    cycleSleepMs?: number;
    buyerStyles?: PersonaStyle[];
  };
}

export interface RunMerchantComparisonOptions {
  scenarioId: string;
  config: MerchantComparisonConfig;
  dryRun?: boolean;
}

export async function runMerchantComparison(
  ctx: ScenarioContext,
  opts: RunMerchantComparisonOptions,
): Promise<ScenarioResult> {
  const { agents, durationMs, params, shouldStop } = ctx;
  const { scenarioId, config, dryRun = false } = opts;
  const baseUrl = process.env.SLY_API_URL!;
  const adminKey = process.env.SLY_PLATFORM_ADMIN_KEY!;

  const adminClient = new SlyClient({ baseUrl, adminKey });
  const cycleSleepMs = (params.cycleSleepMs as number) || config.defaults?.cycleSleepMs || 2500;
  const buyerStyles = config.defaults?.buyerStyles || (['honest', 'whale', 'mm'] as PersonaStyle[]);
  const minCompetitors = config.minCompetitors ?? 2;

  const clients: Record<string, SlyClient> = {};
  for (const a of agents) clients[a.agentId] = createAgentClient(a, baseUrl, adminKey);
  const agentState = new AgentStateManager({ slyClient: adminClient });

  const buyerPool = filterByStyle(agents, buyerStyles);
  if (buyerPool.length === 0) {
    await adminClient.comment(
      `merchant_comparison: no buyers matching styles [${buyerStyles.join(', ')}]`,
      'alert',
    );
    return { completedTrades: 0, totalVolume: 0, findings: ['No buyers'] };
  }

  // Pull all merchants + index products by SKU. Only SKUs with ≥minCompetitors
  // listings make it into the comparison pool.
  const merchants = await adminClient.listMerchants({ limit: 100 });
  const listingsBySku: Record<string, CompetingListing[]> = {};
  for (const m of merchants) {
    const catalog = (m.catalog as any)?.products || m.catalog || [];
    if (!Array.isArray(catalog)) continue;
    const rating = typeof (m as any).rating === 'number' ? (m as any).rating : 4.0;
    for (const p of catalog as any[]) {
      if (!p?.sku) continue;
      if (!listingsBySku[p.sku]) listingsBySku[p.sku] = [];
      listingsBySku[p.sku].push({
        merchantId: m.id,
        merchantName: m.name,
        rating,
        price: (p.unit_price_cents ?? 0) / 100,
        item: { id: p.id, name: p.name, unit_price_cents: p.unit_price_cents, currency: p.currency, sku: p.sku },
      });
    }
  }
  const competingSkus = Object.keys(listingsBySku).filter(
    (s) => listingsBySku[s].length >= minCompetitors,
  );
  if (competingSkus.length === 0) {
    await adminClient.comment(
      `merchant_comparison: no SKUs with ≥${minCompetitors} competing merchants. Re-run scripts/seed-sim-commerce.ts.`,
      'alert',
    );
    return { completedTrades: 0, totalVolume: 0, findings: ['No competing SKUs'] };
  }

  if (!dryRun) {
    await adminClient.comment(
      `merchant_comparison: ${buyerPool.length} buyers shopping across ${competingSkus.length} competing SKU(s): ${competingSkus.slice(0, 3).join(', ')}`,
      'governance',
    );
  }

  const handleSuspension = (err: unknown, agent: SimAgent): boolean => {
    if (isSuspensionError(err)) {
      agentState.markKilled(agent.agentId, 'kill_switch', { agentName: agent.name });
      return true;
    }
    if (isStaleAgentTokenError(err)) {
      agentState.markKilled(agent.agentId, 'stale_token', { agentName: agent.name });
      return true;
    }
    return false;
  };

  let cycle = 0;
  let completedTrades = 0;
  let totalVolume = 0;
  const findings: string[] = [];
  const startedAt = Date.now();

  while (!shouldStop() && Date.now() - startedAt < durationMs) {
    cycle++;
    const activeBuyers = agentState.activeAgents(buyerPool);
    if (activeBuyers.length === 0) {
      if (!dryRun) await adminClient.comment('merchant_comparison: all buyers killed, ending round', 'alert');
      break;
    }

    const buyer = pick(activeBuyers);
    const sku = pick(competingSkus);
    const listings = listingsBySku[sku];
    const strategy = strategyFor(buyer.style);

    // Persona-driven pick.
    let winner: CompetingListing;
    if (strategy === 'lowest_price') {
      winner = [...listings].sort((a, b) => a.price - b.price)[0];
    } else if (strategy === 'highest_rating') {
      winner = [...listings].sort((a, b) => b.rating - a.rating)[0];
    } else {
      // Weighted 50/50 with PROBABILISTIC selection — real shoppers don't
      // always pick the argmax. Each merchant's blend score is normalized
      // into a sampling weight, then we draw one at random. Middle-tier
      // merchants win proportionally even when an extreme always scores
      // highest, producing realistic market-share distribution.
      const minP = Math.min(...listings.map((l) => l.price));
      const maxP = Math.max(...listings.map((l) => l.price));
      const priceRange = maxP - minP || 1;
      const scored = listings.map((l) => {
        const priceScore = 1 - (l.price - minP) / priceRange;
        const ratingScore = l.rating / 5;
        return { l, score: priceScore * 0.5 + ratingScore * 0.5 };
      });
      // Temperature sharpens (higher → winner-take-all) vs flattens (lower →
      // closer to random). 3 gives "the best wins ~60%, middle ~30%, worst ~10%".
      const T = 3;
      const weights = scored.map((s) => Math.pow(s.score, T));
      const total = weights.reduce((a, b) => a + b, 0) || 1;
      let r = Math.random() * total;
      let chosen = scored[0];
      for (let i = 0; i < scored.length; i++) {
        r -= weights[i];
        if (r <= 0) { chosen = scored[i]; break; }
      }
      winner = chosen.l;
    }

    if (dryRun) { completedTrades++; break; }

    try {
      const checkoutId = `sim_cmp_${cycle}_${randomUUID().slice(0, 8)}`;
      await clients[buyer.agentId].createAcpCheckout({
        checkout_id: checkoutId,
        agent_id: buyer.agentId,
        agent_name: buyer.name,
        merchant_id: winner.merchantId,
        merchant_name: winner.merchantName,
        account_id: buyer.parentAccountId,
        items: [{
          item_id: winner.item.id,
          name: winner.item.name,
          quantity: 1,
          unit_price: winner.price,
          total_price: winner.price,
          currency: winner.item.currency || 'USDC',
        }],
        currency: 'USDC',
        metadata: { simRound: scenarioId, cycle, comparison: true, sku, strategy, considered: listings.length },
      });

      completedTrades++;
      totalVolume += winner.price;

      // Rationale line for the feed.
      const rationale = strategy === 'lowest_price'
        ? 'lowest price'
        : strategy === 'highest_rating'
          ? 'highest rating'
          : 'best price/rating blend';
      const considered = listings.map((l) => ({
        toId: 'merch:' + l.merchantId,
        toName: l.merchantName,
        price: l.price,
        rating: l.rating,
      }));

      await adminClient.milestone(
        `\u{1F6D2} ${buyer.name} chose ${winner.merchantName} for "${winner.item.name}" ($${winner.price.toFixed(2)}, ★${winner.rating.toFixed(1)}) — ${rationale} of ${listings.length} options`,
        {
          agentId: buyer.agentId,
          agentName: buyer.name,
          icon: '\u{1F6D2}',
          toId: 'merch:' + winner.merchantId,
          toName: winner.merchantName,
          toKind: 'merchant',
          amount: winner.price,
          currency: 'USDC',
          considered,
        },
      );
    } catch (e: any) {
      if (!handleSuspension(e, buyer)) {
        await adminClient.comment(
          `merchant_comparison: ${buyer.name} failed on SKU ${sku}: ${e.message}`,
          'alert',
        );
      }
    }

    await new Promise((r) => setTimeout(r, cycleSleepMs * (0.8 + Math.random() * 0.4)));
  }

  if (!dryRun) {
    await adminClient.comment(
      `merchant_comparison complete: ${completedTrades} purchases across ${competingSkus.length} SKUs, $${totalVolume.toFixed(2)} volume`,
      'governance',
    );
  }

  findings.push(`${completedTrades} competitive comparisons across ${competingSkus.length} SKU(s)`);
  return { completedTrades, totalVolume, findings };
}
