/**
 * resale_chain — agent buys from a merchant, resells to a peer for a markup.
 *
 * Flow per cycle:
 *   1. Reseller agent R buys a product from a merchant (ACP or UCP).
 *   2. R opens an A2A task to an end-buyer peer B, offering the same product at a markup.
 *   3. B creates an AP2 mandate for the marked-up price, funding the purchase.
 *   4. R completes the A2A task with the merchant's receipt as proof-of-fulfillment.
 *   5. B accepts + rates.
 *
 * Demonstrates agents arbitraging between merchant catalogs and peer agents —
 * micro-supply-chains. The resale markup is the reseller's profit.
 *
 * Kill-switch aware: drops killed resellers or buyers from the active pool each cycle.
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

export interface ResaleChainConfig {
  /** Merchant protocol the reseller sources from. Only ACP/UCP — x402 resale is deferred. */
  sourceProtocol: 'acp' | 'ucp';
  /** Markup factor applied over merchant cost (e.g. 1.25 = 25% markup). */
  markup?: number;
  defaults?: {
    cycleSleepMs?: number;
    resellerStyles?: PersonaStyle[];
    buyerStyles?: PersonaStyle[];
  };
}

export interface RunResaleChainOptions {
  scenarioId: string;
  config: ResaleChainConfig;
  dryRun?: boolean;
}

export async function runResaleChain(
  ctx: ScenarioContext,
  opts: RunResaleChainOptions,
): Promise<ScenarioResult> {
  const { agents, durationMs, params, shouldStop } = ctx;
  const { scenarioId, config, dryRun = false } = opts;
  const baseUrl = process.env.SLY_API_URL!;
  const adminKey = process.env.SLY_PLATFORM_ADMIN_KEY!;

  if (config.sourceProtocol !== 'acp' && config.sourceProtocol !== 'ucp') {
    throw new Error(`resale_chain: sourceProtocol must be 'acp' or 'ucp'`);
  }
  const markup = config.markup ?? 1.25;
  const cycleSleepMs = (params.cycleSleepMs as number) || config.defaults?.cycleSleepMs || 3000;
  const resellerStyles = config.defaults?.resellerStyles || (['whale', 'mm'] as PersonaStyle[]);
  const buyerStyles = config.defaults?.buyerStyles || (['honest'] as PersonaStyle[]);

  const adminClient = new SlyClient({ baseUrl, adminKey });
  const clients: Record<string, SlyClient> = {};
  for (const a of agents) clients[a.agentId] = createAgentClient(a, baseUrl, adminKey);
  const agentState = new AgentStateManager({ slyClient: adminClient });

  const resellerPool = filterByStyle(agents, resellerStyles);
  const buyerPool = filterByStyle(agents, buyerStyles);
  if (resellerPool.length === 0 || buyerPool.length === 0) {
    await adminClient.comment(
      `resale_chain: need at least 1 reseller (${resellerStyles.join('|')}) and 1 buyer (${buyerStyles.join('|')}). Found ${resellerPool.length}/${buyerPool.length}.`,
      'alert',
    );
    return { completedTrades: 0, totalVolume: 0, findings: ['Insufficient pool'] };
  }

  const merchants = await adminClient.listMerchants({ limit: 50 });
  if (merchants.length === 0) {
    await adminClient.comment(
      `resale_chain: no merchants found. Run scripts/seed-sim-commerce.ts.`,
      'alert',
    );
    return { completedTrades: 0, totalVolume: 0, findings: ['No merchants'] };
  }

  if (!dryRun) {
    await adminClient.comment(
      `resale_chain [${config.sourceProtocol.toUpperCase()}]: ${resellerPool.length} reseller(s), ${buyerPool.length} buyer(s), markup ×${markup.toFixed(2)}`,
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

    const activeResellers = agentState.activeAgents(resellerPool);
    const activeBuyers = agentState.activeAgents(buyerPool);
    if (activeResellers.length === 0 || activeBuyers.length === 0) {
      if (!dryRun) await adminClient.comment(`resale_chain: insufficient active agents, ending round`, 'alert');
      break;
    }

    const reseller = pick(activeResellers);
    // Avoid selling to self.
    const buyerCandidates = activeBuyers.filter((a) => a.agentId !== reseller.agentId);
    if (buyerCandidates.length === 0) {
      await new Promise((r) => setTimeout(r, cycleSleepMs));
      continue;
    }
    const buyer = pick(buyerCandidates);

    if (dryRun) { completedTrades++; break; }

    try {
      // ─── 1. Reseller picks a merchant + product and buys it ──────────
      const merchant = pick(merchants);
      const catalogRaw = merchant?.catalog?.products || merchant?.catalog || [];
      const catalog: any[] = Array.isArray(catalogRaw) ? catalogRaw : [];
      if (catalog.length === 0) continue;
      const item = pick(catalog) as { id?: string; name: string; unit_price_cents?: number; currency?: string };
      const merchantCost = (item?.unit_price_cents ?? 0) / 100;
      if (merchantCost <= 0) continue;

      if (config.sourceProtocol === 'acp') {
        const checkoutId = `sim_resale_${cycle}_${randomUUID().slice(0, 8)}`;
        const createdAcp: any = await clients[reseller.agentId].createAcpCheckout({
          checkout_id: checkoutId,
          agent_id: reseller.agentId,
          agent_name: reseller.name,
          merchant_id: merchant.merchant_id || merchant.id,
          merchant_name: merchant.name,
          account_id: reseller.parentAccountId,
          items: [{ item_id: item.id, name: item.name, quantity: 1, unit_price: merchantCost, total_price: merchantCost, currency: item.currency || 'USDC' }],
          currency: 'USDC',
          metadata: { simRound: scenarioId, cycle, resale: true, resellerId: reseller.agentId },
        });
        if (createdAcp?.id) {
          try { await clients[reseller.agentId].completeAcpCheckout(createdAcp.id, { shared_payment_token: 'sim-' + randomUUID().slice(0, 8) }); } catch {}
        }
      } else {
        const priceCents = item.unit_price_cents ?? 0;
        const checkout: any = await clients[reseller.agentId].createUcpCheckout({
          currency: 'USD',
          line_items: [{
            id: item.id || `sim-item-${randomUUID().slice(0, 8)}`,
            name: item.name,
            quantity: 1,
            unit_price: priceCents,
            total_price: priceCents,
          }],
          buyer: {
            email: `${reseller.agentId.slice(0, 8)}@sim.agents.local`,
            name: reseller.name,
          },
          agent_id: reseller.agentId,
          checkout_type: 'physical',
          metadata: { simRound: scenarioId, cycle, resale: true, merchant_name: merchant.name },
        });
        const checkoutId = checkout?.id || checkout?.data?.id;
        if (checkoutId) {
          try { await clients[reseller.agentId].addUcpInstrument(checkoutId, { id: `pi_resale_${reseller.agentId.slice(0, 8)}`, handler: 'sly', type: 'usdc' }); } catch {}
          try { await clients[reseller.agentId].completeUcpCheckout(checkoutId); } catch {}
        }
      }

      // ─── 2. Reseller opens A2A offer to the end-buyer ────────────────
      const resalePrice = Math.round(merchantCost * markup * 100) / 100;
      const pitch = `Resale offer: "${item.name}" (sourced from ${merchant.name}). Price $${resalePrice.toFixed(2)} (merchant cost $${merchantCost.toFixed(2)}, markup ×${markup.toFixed(2)}). Fulfillment on acceptance.`;
      const created = await clients[reseller.agentId].createTask({
        agentId: buyer.agentId,
        message: {
          role: 'user',
          parts: [{ type: 'text', text: pitch }],
          metadata: {
            simRound: scenarioId,
            cycle,
            resale: true,
            merchantId: merchant.merchant_id || merchant.id,
            merchantCost,
            resalePrice,
            item: item.name,
            externallyManaged: true,
          },
        },
      });
      const taskId = created.id;

      // ─── 3. Buyer creates AP2 mandate for the marked-up price ────────
      let mandateId: string | null = null;
      try {
        const mandate = await clients[buyer.agentId].createMandate({
          accountId: buyer.parentAccountId,
          buyerAgentId: buyer.agentId,
          providerAgentId: reseller.agentId,
          providerAccountId: reseller.parentAccountId,
          amount: resalePrice,
          currency: 'USDC',
          a2aSessionId: taskId,
          metadata: { simRound: scenarioId, cycle, resale: true, source: 'marketplace_sim' },
        });
        mandateId = (mandate as any).mandate_id || (mandate as any).mandateId || null;
      } catch (e) {
        handleSuspension(e, buyer) || handleSuspension(e, reseller);
        continue;
      }

      // ─── 4. Reseller claims the task and completes with fulfillment ──
      try {
        await clients[reseller.agentId].claimTask(taskId);
      } catch (e) {
        handleSuspension(e, reseller);
        continue;
      }
      try {
        await clients[reseller.agentId].completeTask(
          taskId,
          `Delivered "${item.name}" from ${merchant.name}. Your cost: $${resalePrice.toFixed(2)}. My margin: $${(resalePrice - merchantCost).toFixed(2)}.`,
        );
      } catch (e) {
        handleSuspension(e, reseller);
        if (mandateId) { try { await clients[buyer.agentId].cancelMandate(mandateId, { metadataMerge: { outcome: 'reseller_failed' } }); } catch {} }
        continue;
      }

      // ─── 5. Buyer accepts + rates ────────────────────────────────────
      try {
        await clients[buyer.agentId].respond({
          taskId,
          action: 'accept',
          score: 80 + Math.floor(Math.random() * 15),
          comment: `Good resale fulfillment — item matches description`,
          satisfaction: 'excellent',
        });
      } catch (e) {
        handleSuspension(e, buyer) || handleSuspension(e, reseller);
      }

      completedTrades++;
      totalVolume += resalePrice;

      await adminClient.milestone(
        `\u{1F501} ${reseller.name} resold "${item.name}" (${merchant.name} → ${buyer.name}, margin $${(resalePrice - merchantCost).toFixed(2)})`,
        {
          agentId: reseller.agentId,
          agentName: reseller.name,
          icon: '\u{1F501}',
          toId: 'merch:' + String(merchant.id),
          toName: merchant.name,
          toKind: 'merchant',
          amount: resalePrice,
          currency: 'USDC',
        },
      );
    } catch (e: any) {
      const classified = handleSuspension(e, reseller) || handleSuspension(e, buyer);
      if (!classified) {
        await adminClient.comment(`resale_chain: cycle crashed ${reseller.name}→${buyer.name}: ${e.message}`, 'alert');
      }
    }

    await new Promise((r) => setTimeout(r, cycleSleepMs * (0.8 + Math.random() * 0.4)));
  }

  if (!dryRun) {
    await adminClient.comment(
      `resale_chain complete: ${completedTrades} resales, $${totalVolume.toFixed(2)} volume, ${agentState.killedCount()} agents killed`,
      'governance',
    );
  }

  findings.push(`${completedTrades} resale transactions across ${resellerPool.length} reseller(s)`);
  if (agentState.killedCount() > 0) findings.push(`${agentState.killedCount()} agents killed mid-run`);

  return { completedTrades, totalVolume, findings };
}
