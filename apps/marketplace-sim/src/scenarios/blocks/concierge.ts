/**
 * concierge — agents as middlemen between A2A buyers and protocol-native merchants.
 *
 * Flow per cycle:
 *   1. Buyer agent sends an A2A task to a concierge seller agent: "book me a flight",
 *      "get me a coffee-shipping quote", "summarize this article" (depending on merchantType).
 *   2. Concierge agent picks a merchant (UCP/ACP) or endpoint (x402) matching the request,
 *      executes the real merchant purchase on the buyer's behalf.
 *   3. Concierge completes the A2A task with the booking/purchase reference.
 *   4. Buyer rates the concierge.
 *
 * Demonstrates agents acting as agentic travel agents / shopping concierges — the buyer
 * never talks to the merchant directly, the concierge takes a fee.
 *
 * Kill-switch aware: skipped if either buyer or concierge gets killed mid-run.
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

export interface ConciergeConfig {
  /** Merchant protocol the concierge purchases from. */
  protocol: 'acp' | 'ucp' | 'x402';
  /** Service fee the concierge charges above the merchant cost (USDC). */
  conciergeFeeUsdc?: number;
  defaults?: {
    cycleSleepMs?: number;
    buyerStyles?: PersonaStyle[];
    conciergeStyles?: PersonaStyle[];
  };
}

export interface RunConciergeOptions {
  scenarioId: string;
  config: ConciergeConfig;
  dryRun?: boolean;
}

const PROTOCOL_ICON: Record<'acp' | 'ucp' | 'x402', string> = {
  acp: '\u{1F354}',
  ucp: '\u{1F3E8}',
  x402: '\u26a1',
};

const BRIEFS_BY_PROTOCOL: Record<'acp' | 'ucp' | 'x402', string[]> = {
  acp: [
    'Pick up a coffee sampler from the best roaster you can find. Budget $40.',
    'I need 2 premium coffee bags delivered. Use whichever roaster has the best catalog.',
  ],
  ucp: [
    'Book me a hotel room in Panama City for one night. Mid-tier.',
    'Need a one-way flight to Costa Rica. Find the cheapest available.',
    'Arrange airport transfer + hotel for next week.',
  ],
  x402: [
    'Run a deep web search on agentic commerce adoption metrics. Pay up to $0.05.',
    'Summarize this article: <link>. Use the best paid summarizer.',
    'Translate the attached spec to Spanish via whichever translation service is cheapest.',
  ],
};

export async function runConcierge(
  ctx: ScenarioContext,
  opts: RunConciergeOptions,
): Promise<ScenarioResult> {
  const { agents, durationMs, params, shouldStop } = ctx;
  const { scenarioId, config, dryRun = false } = opts;
  const baseUrl = process.env.SLY_API_URL!;
  const adminKey = process.env.SLY_PLATFORM_ADMIN_KEY!;

  if (!['acp', 'ucp', 'x402'].includes(config.protocol)) {
    throw new Error(`concierge: protocol must be 'acp'|'ucp'|'x402', got '${config.protocol}'`);
  }

  const adminClient = new SlyClient({ baseUrl, adminKey });
  const cycleSleepMs = (params.cycleSleepMs as number) || config.defaults?.cycleSleepMs || 3000;
  const buyerStyles = config.defaults?.buyerStyles || (['whale', 'honest'] as PersonaStyle[]);
  const conciergeStyles = config.defaults?.conciergeStyles || (['quality-reviewer', 'mm'] as PersonaStyle[]);
  const fee = config.conciergeFeeUsdc ?? 0.50;

  const clients: Record<string, SlyClient> = {};
  for (const a of agents) {
    clients[a.agentId] = createAgentClient(a, baseUrl, adminKey);
  }

  const agentState = new AgentStateManager({ slyClient: adminClient });

  const buyerPool = filterByStyle(agents, buyerStyles);
  const conciergePool = filterByStyle(agents, conciergeStyles);
  if (buyerPool.length === 0 || conciergePool.length === 0) {
    await adminClient.comment(
      `concierge: need at least 1 buyer (styles ${buyerStyles.join('|')}) and 1 concierge (styles ${conciergeStyles.join('|')}). Found ${buyerPool.length}/${conciergePool.length}.`,
      'alert',
    );
    return { completedTrades: 0, totalVolume: 0, findings: ['Insufficient pool'] };
  }

  // Preload the merchant / endpoint set the concierge can fulfill against.
  let merchants: any[] = [];
  let x402Endpoints: any[] = [];
  if (config.protocol === 'x402') {
    // Proxy pre-filters to /x402/merchants/* — no client-side filter needed.
    x402Endpoints = await adminClient.listX402Endpoints({ status: 'active', limit: 50 });
  } else {
    merchants = await adminClient.listMerchants({ limit: 50 });
  }
  if (config.protocol === 'x402' ? x402Endpoints.length === 0 : merchants.length === 0) {
    await adminClient.comment(
      `concierge: no merchants/endpoints for protocol=${config.protocol}. Run scripts/seed-sim-commerce.ts.`,
      'alert',
    );
    return { completedTrades: 0, totalVolume: 0, findings: ['No merchants'] };
  }

  if (!dryRun) {
    await adminClient.comment(
      `concierge [${config.protocol.toUpperCase()}]: ${buyerPool.length} buyer(s), ${conciergePool.length} concierge(s), fee $${fee.toFixed(2)}`,
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
    const activeConcierges = agentState.activeAgents(conciergePool);
    if (activeBuyers.length === 0 || activeConcierges.length === 0) {
      if (!dryRun) {
        await adminClient.comment(
          `concierge: insufficient active agents (buyers=${activeBuyers.length}, concierges=${activeConcierges.length}), ending round`,
          'alert',
        );
      }
      break;
    }

    const buyer = pick(activeBuyers);
    const concierge = pick(activeConcierges);
    const brief = pick(BRIEFS_BY_PROTOCOL[config.protocol]);

    if (dryRun) { completedTrades++; break; }

    try {
      // ─── 1. Buyer opens an A2A task to the concierge ─────────────────
      const created = await clients[buyer.agentId].createTask({
        agentId: concierge.agentId,
        message: {
          role: 'user',
          parts: [{ type: 'text', text: brief }],
          metadata: {
            simRound: scenarioId,
            cycle,
            concierge: true,
            protocol: config.protocol,
            externallyManaged: true,
          },
        },
      });
      const taskId = created.id;

      // ─── 2. Concierge claims ─────────────────────────────────────────
      try {
        await clients[concierge.agentId].claimTask(taskId);
      } catch (e) {
        handleSuspension(e, concierge);
        continue;
      }

      // ─── 3. Concierge executes the merchant purchase ─────────────────
      let merchantOutcome = '';
      let merchantCost = 0;
      let merchantTarget: { id: string; name: string } | null = null;
      if (config.protocol === 'x402') {
        const ep = pick(x402Endpoints);
        const price = Number(ep.base_price ?? 0);
        const walletId = (concierge as any).walletId;
        if (!walletId || price <= 0) {
          await adminClient.comment(`concierge: ${concierge.name} skipping — no wallet or endpoint priced ${price}`, 'alert');
          continue;
        }
        await clients[concierge.agentId].payX402({
          endpointId: ep.id,
          requestId: randomUUID(),
          amount: price,
          currency: 'USDC',
          walletId,
          method: ep.method || 'POST',
          path: ep.path,
          metadata: { simRound: scenarioId, cycle, onBehalfOf: buyer.agentId, concierge: true },
        });
        merchantCost = price;
        merchantOutcome = `paid $${price.toFixed(2)} for "${ep.name}"`;
        merchantTarget = { id: 'merch:x402:' + String(ep.id), name: ep.name || 'x402 endpoint' };
      } else if (config.protocol === 'acp') {
        // Find a merchant with a non-empty catalog — some seeded merchants
        // (e.g. x402-only operators) don't expose one. Try a few picks, then
        // skip the cycle so the outer crash handler doesn't fire on a
        // `pick([])` → undefined.id.
        let merchant: any = null;
        let catalog: any[] = [];
        for (let attempt = 0; attempt < 5 && catalog.length === 0; attempt++) {
          merchant = pick(merchants);
          catalog = merchant?.catalog?.products || merchant?.catalog || [];
        }
        if (!merchant || catalog.length === 0) {
          await adminClient.comment(`concierge: ${concierge.name} couldn't find a merchant with a catalog (acp) — skipping cycle`, 'alert');
          continue;
        }
        const item = pick(catalog) as { id: string; name: string; unit_price_cents?: number; currency?: string };
        if (!item) continue;
        merchantCost = (item?.unit_price_cents ?? 0) / 100;
        const checkoutId = `sim_concierge_${cycle}_${randomUUID().slice(0, 8)}`;
        const created: any = await clients[concierge.agentId].createAcpCheckout({
          checkout_id: checkoutId,
          agent_id: concierge.agentId,
          agent_name: concierge.name,
          merchant_id: merchant.merchant_id || merchant.id,
          merchant_name: merchant.name,
          account_id: concierge.parentAccountId,
          items: [{ item_id: item.id, name: item.name, quantity: 1, unit_price: merchantCost, total_price: merchantCost, currency: item.currency || 'USDC' }],
          currency: 'USDC',
          metadata: { simRound: scenarioId, cycle, onBehalfOf: buyer.agentId, concierge: true },
        });
        const createdAcpId = created?.id;
        if (createdAcpId) {
          try { await clients[concierge.agentId].completeAcpCheckout(createdAcpId, { shared_payment_token: 'sim-' + randomUUID().slice(0, 8) }); } catch {}
        }
        merchantOutcome = `bought "${item.name}" at ${merchant.name} ($${merchantCost.toFixed(2)})`;
        merchantTarget = { id: 'merch:' + String(merchant.id), name: merchant.name };
      } else {
        // Same catalog-presence guard as the ACP branch — UCP merchants may
        // expose a pos_provider without a structured catalog and pick([])
        // returns undefined, which then blows up on item.id.
        let merchant: any = null;
        let catalog: any[] = [];
        for (let attempt = 0; attempt < 5 && catalog.length === 0; attempt++) {
          merchant = pick(merchants);
          catalog = merchant?.catalog?.products || merchant?.catalog || [];
        }
        if (!merchant || catalog.length === 0) {
          await adminClient.comment(`concierge: ${concierge.name} couldn't find a merchant with a catalog (ucp) — skipping cycle`, 'alert');
          continue;
        }
        const item = pick(catalog) as { id?: string; name: string; unit_price_cents?: number };
        if (!item) continue;
        const priceCents = item?.unit_price_cents ?? 0;
        merchantCost = priceCents / 100;
        const checkout: any = await clients[concierge.agentId].createUcpCheckout({
          currency: 'USD',
          line_items: [{
            id: item.id || `sim-item-${randomUUID().slice(0, 8)}`,
            name: item.name,
            quantity: 1,
            unit_price: priceCents,
            total_price: priceCents,
          }],
          buyer: {
            email: `${buyer.agentId.slice(0, 8)}@sim.agents.local`,
            name: buyer.name,
          },
          agent_id: concierge.agentId,
          checkout_type: 'service',
          metadata: { simRound: scenarioId, cycle, onBehalfOf: buyer.agentId, concierge: true, merchant_name: merchant.name },
        });
        const checkoutId = checkout?.id || checkout?.data?.id;
        if (checkoutId) {
          try { await clients[concierge.agentId].addUcpInstrument(checkoutId, { id: `pi_conc_${concierge.agentId.slice(0, 8)}`, handler: 'sly', type: 'usdc' }); } catch {}
          try { await clients[concierge.agentId].completeUcpCheckout(checkoutId); } catch {}
        }
        merchantOutcome = `booked "${item.name}" at ${merchant.name} ($${merchantCost.toFixed(2)})`;
        merchantTarget = { id: 'merch:' + String(merchant.id), name: merchant.name };
      }

      // ─── 4. Concierge completes the A2A task with the result ─────────
      try {
        await clients[concierge.agentId].completeTask(
          taskId,
          `${merchantOutcome}. Concierge fee: $${fee.toFixed(2)}. Total charged: $${(merchantCost + fee).toFixed(2)}.`,
        );
      } catch (e) {
        handleSuspension(e, concierge);
        continue;
      }

      // ─── 5. Buyer rates the concierge ────────────────────────────────
      try {
        await clients[buyer.agentId].respond({
          taskId,
          action: 'accept',
          score: 85 + Math.floor(Math.random() * 10),
          comment: `Good concierge work — ${merchantOutcome}`,
          satisfaction: 'excellent',
        });
      } catch (e) {
        handleSuspension(e, buyer) || handleSuspension(e, concierge);
      }

      completedTrades++;
      totalVolume += merchantCost + fee;

      await adminClient.milestone(
        `\u{1F9F3} ${buyer.name} used ${concierge.name} as concierge: ${merchantOutcome}`,
        {
          agentId: concierge.agentId,
          agentName: concierge.name,
          icon: '\u{1F9F3}',
          amount: merchantCost + fee,
          currency: 'USDC',
          ...(merchantTarget
            ? { toId: merchantTarget.id, toName: merchantTarget.name, toKind: 'merchant' as const }
            : {}),
        },
      );
    } catch (e: any) {
      const classified = handleSuspension(e, buyer) || handleSuspension(e, concierge);
      if (!classified) {
        await adminClient.comment(`concierge: trade crashed ${buyer.name}→${concierge.name}: ${e.message}`, 'alert');
      }
    }

    await new Promise((r) => setTimeout(r, cycleSleepMs * (0.8 + Math.random() * 0.4)));
  }

  if (!dryRun) {
    await adminClient.comment(
      `concierge complete: ${completedTrades} orders fulfilled, $${totalVolume.toFixed(2)} volume (merchant + fees), ${agentState.killedCount()} agents killed`,
      'governance',
    );
  }

  findings.push(`${completedTrades} concierge-mediated orders via ${config.protocol.toUpperCase()}`);
  if (agentState.killedCount() > 0) findings.push(`${agentState.killedCount()} agents killed mid-run`);

  return { completedTrades, totalVolume, findings };
}
