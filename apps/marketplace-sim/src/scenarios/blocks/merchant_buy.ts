/**
 * merchant_buy — parametric agent-to-merchant purchase loop.
 *
 * Each cycle:
 *   1. Pick an active buyer agent from the pool.
 *   2. Pick a merchant (or x402 endpoint) matching the scenario's protocol.
 *   3. Build a protocol-specific payload and execute the flow:
 *        - 'acp': create + complete ACP checkout against a POS merchant.
 *        - 'ucp': create + instrument + complete UCP checkout.
 *        - 'x402': one-shot pay for a merchant-owned API endpoint.
 *   4. Narrate the outcome (milestone + feed line) with the right protocol icon.
 *
 * Kill-switch aware: uses `agentState.activeAgents()` + `handleSuspension()`
 * to drop killed agents from future cycles without noisy alerts.
 *
 * Config shape:
 *   {
 *     protocol: 'acp' | 'ucp' | 'x402',
 *     merchantTypeFilter?: 'hotel' | 'airline' | 'retail' | 'restaurant' | 'service',
 *     maxBasket?: number,  // default 3 products per checkout
 *     defaults: { cycleSleepMs?: number, styleFilter?: PersonaStyle[] }
 *   }
 */

import { SlyClient, isSuspensionError } from '../../sly-client.js';
import type { SimAgent, PersonaStyle } from '../../processors/types.js';
import type { ScenarioContext, ScenarioResult } from '../types.js';
import { filterByStyle } from '../../agents/registry.js';
import { AgentStateManager } from '../../agents/agent-state.js';
import { randomUUID } from 'node:crypto';

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

type Protocol = 'acp' | 'ucp' | 'x402';

export interface MerchantBuyConfig {
  protocol: Protocol;
  merchantTypeFilter?: string;
  maxBasket?: number;
  defaults?: {
    cycleSleepMs?: number;
    styleFilter?: PersonaStyle[];
  };
}

export interface RunMerchantBuyOptions {
  scenarioId: string;
  config: MerchantBuyConfig;
  dryRun?: boolean;
}

const PROTOCOL_ICON: Record<Protocol, string> = {
  acp: '\u{1F354}',   // 🍔
  ucp: '\u{1F3E8}',   // 🏨
  x402: '\u26a1',      // ⚡
};

export async function runMerchantBuy(
  ctx: ScenarioContext,
  opts: RunMerchantBuyOptions,
): Promise<ScenarioResult> {
  const { agents, durationMs, params, shouldStop } = ctx;
  const { scenarioId, config, dryRun = false } = opts;
  const baseUrl = process.env.SLY_API_URL!;
  const adminKey = process.env.SLY_PLATFORM_ADMIN_KEY!;

  if (!['acp', 'ucp', 'x402'].includes(config.protocol)) {
    throw new Error(`merchant_buy: protocol must be 'acp'|'ucp'|'x402', got '${config.protocol}'`);
  }

  const adminClient = new SlyClient({ baseUrl, adminKey });
  const cycleSleepMs = (params.cycleSleepMs as number) || config.defaults?.cycleSleepMs || 2000;
  const styleFilter = (params.styleFilter as PersonaStyle[]) || config.defaults?.styleFilter || ['honest', 'whale', 'budget', 'opportunist'];
  const maxBasket = config.maxBasket ?? 3;

  // Build per-agent clients using their API key (tenant-scoped).
  // The sim tenant's sim-* agents all belong to the same tenant, so reusing
  // one client with apiKey works — but loadSimAgents gives us per-agent
  // tokens which are also agent tokens. We use apiKey auth here because ACP
  // and UCP and x402 endpoints expect tenant-key authentication.
  // When no API key is available we fall back to using the agent's token
  // and let the SlyClient default to it.
  const buyerClients: Record<string, SlyClient> = {};
  for (const a of agents) {
    // SimAgent carries a `token` which is the agent token. We pass it as
    // apiKey here because the underlying endpoints accept either — the ACP/UCP
    // handlers just need a tenant context. If this doesn't work at runtime
    // we'll fall back to the admin client.
    buyerClients[a.agentId] = new SlyClient({ baseUrl, adminKey, apiKey: (a as any).token || adminKey });
  }

  const agentState = new AgentStateManager({ slyClient: adminClient });

  const pool = filterByStyle(agents, styleFilter);
  if (pool.length === 0) {
    if (!dryRun) {
      await adminClient.comment(
        `merchant_buy: no buyers matching styles [${styleFilter.join(', ')}]`,
        'alert',
      );
    }
    return { completedTrades: 0, totalVolume: 0, findings: ['No buyer pool'] };
  }

  // Preload merchant catalog (for ACP/UCP) OR endpoint list (for x402).
  let merchants: any[] = [];
  let x402Endpoints: any[] = [];
  if (config.protocol === 'x402') {
    x402Endpoints = await adminClient.listX402Endpoints({ status: 'active', limit: 50 });
    // Filter down to MERCHANT endpoints (paths starting with /x402/merchants/)
    x402Endpoints = x402Endpoints.filter((e) => typeof e.path === 'string' && e.path.startsWith('/x402/merchants/'));
  } else {
    merchants = await adminClient.listMerchants({
      type: config.merchantTypeFilter,
      limit: 50,
    });
  }

  if (config.protocol === 'x402' && x402Endpoints.length === 0) {
    await adminClient.comment(
      `merchant_buy (x402): no merchant-owned endpoints found. Run scripts/seed-sim-commerce.ts first.`,
      'alert',
    );
    return { completedTrades: 0, totalVolume: 0, findings: ['No x402 endpoints'] };
  }
  if ((config.protocol === 'acp' || config.protocol === 'ucp') && merchants.length === 0) {
    await adminClient.comment(
      `merchant_buy (${config.protocol}): no merchants found. Run scripts/seed-sim-commerce.ts first.`,
      'alert',
    );
    return { completedTrades: 0, totalVolume: 0, findings: ['No merchants'] };
  }

  if (!dryRun) {
    const stockNote = config.protocol === 'x402'
      ? `${x402Endpoints.length} endpoints`
      : `${merchants.length} merchants`;
    await adminClient.comment(
      `merchant_buy [${config.protocol.toUpperCase()}]: ${pool.length} buyers · ${stockNote}`,
      'governance',
    );
  }

  const handleSuspension = (err: unknown, agent: SimAgent): boolean => {
    if (!isSuspensionError(err)) return false;
    agentState.markKilled(agent.agentId, 'kill_switch', { agentName: agent.name });
    return true;
  };

  let cycle = 0;
  let completedTrades = 0;
  let totalVolume = 0;
  const findings: string[] = [];
  const startedAt = Date.now();

  while (!shouldStop() && Date.now() - startedAt < durationMs) {
    cycle++;

    const activePool = agentState.activeAgents(pool);
    if (activePool.length === 0) {
      if (!dryRun) {
        await adminClient.comment(`merchant_buy: all buyers killed — ending round`, 'alert');
      }
      break;
    }

    const buyer = pick(activePool);
    const client = buyerClients[buyer.agentId];

    if (dryRun) {
      completedTrades++;
      break;
    }

    try {
      if (config.protocol === 'acp') {
        const merchant = pick(merchants);
        const catalog = merchant?.catalog?.products || merchant?.catalog || [];
        if (catalog.length === 0) {
          await adminClient.comment(`merchant_buy (acp): ${merchant.name} has empty catalog — skipping`, 'alert');
          continue;
        }
        const basketSize = 1 + Math.floor(Math.random() * Math.min(maxBasket, catalog.length));
        const shuffled = [...catalog].sort(() => Math.random() - 0.5);
        const basket = shuffled.slice(0, basketSize);
        const items = basket.map((p: any) => ({
          item_id: p.id,
          name: p.name,
          quantity: 1,
          unit_price: (p.unit_price_cents ?? 0) / 100,
          total_price: (p.unit_price_cents ?? 0) / 100,
          currency: p.currency || 'USDC',
        }));
        const total = items.reduce((s, i) => s + i.total_price, 0);
        const checkoutId = `sim_${scenarioId}_${cycle}_${randomUUID().slice(0, 8)}`;

        const created = await client.createAcpCheckout({
          checkout_id: checkoutId,
          agent_id: buyer.agentId,
          agent_name: buyer.name,
          merchant_id: merchant.merchant_id || merchant.id,
          merchant_name: merchant.name,
          account_id: buyer.parentAccountId,
          items,
          currency: 'USDC',
          metadata: { simRound: scenarioId, cycle, source: 'marketplace_sim' },
        });

        // Some ACP flows settle at create; if the checkout is already in a
        // paid/completed state, we're done. Otherwise call /complete.
        if (created.status !== 'completed') {
          try {
            await client.completeAcpCheckout(checkoutId, { shared_payment_token: 'sim-token-' + randomUUID().slice(0, 8) });
          } catch { /* best-effort — some variants auto-settle */ }
        }

        completedTrades++;
        totalVolume += total;
        await adminClient.milestone(
          `${PROTOCOL_ICON.acp} ${buyer.name} bought ${basket.length} items from ${merchant.name} ($${total.toFixed(2)})`,
          { agentId: buyer.agentId, agentName: buyer.name, icon: PROTOCOL_ICON.acp },
        );
      } else if (config.protocol === 'ucp') {
        const merchant = pick(merchants);
        const catalog = merchant?.catalog?.products || merchant?.catalog || [];
        if (catalog.length === 0) {
          await adminClient.comment(`merchant_buy (ucp): ${merchant.name} has empty catalog — skipping`, 'alert');
          continue;
        }
        const item = pick(catalog) as { name: string; unit_price_cents?: number };
        const lineItems = [{
          name: item.name,
          quantity: 1,
          unit_price: (item.unit_price_cents ?? 0) / 100,
        }];
        const total = lineItems[0].unit_price;

        const checkout: any = await client.createUcpCheckout({
          currency: 'USDC',
          line_items: lineItems,
          agent_id: buyer.agentId,
          checkout_type: merchant.type === 'hotel' || merchant.type === 'airline' || merchant.type === 'service' ? 'service' : 'physical',
          metadata: {
            simRound: scenarioId,
            cycle,
            source: 'marketplace_sim',
            merchant_id: merchant.merchant_id || merchant.id,
            merchant_name: merchant.name,
          },
        });
        const checkoutId = checkout?.id || checkout?.data?.id;
        if (!checkoutId) throw new Error('UCP checkout had no id in response');

        // Attach a sly-native USDC instrument and complete.
        try {
          await client.addUcpInstrument(checkoutId, {
            id: `pi_sim_${buyer.agentId.slice(0, 8)}`,
            handler: 'sly',
            type: 'usdc',
          });
        } catch { /* some flows don't require an instrument */ }

        try {
          await client.completeUcpCheckout(checkoutId);
        } catch { /* best-effort */ }

        completedTrades++;
        totalVolume += total;
        await adminClient.milestone(
          `${PROTOCOL_ICON.ucp} ${buyer.name} booked "${item.name}" at ${merchant.name} ($${total.toFixed(2)})`,
          { agentId: buyer.agentId, agentName: buyer.name, icon: PROTOCOL_ICON.ucp },
        );
      } else if (config.protocol === 'x402') {
        const endpoint = pick(x402Endpoints);
        const price = Number(endpoint.base_price ?? endpoint.price ?? 0);
        if (price <= 0) {
          await adminClient.comment(`merchant_buy (x402): endpoint "${endpoint.name}" has no price — skipping`, 'alert');
          continue;
        }

        // The x402 payment needs a walletId. Use the buyer's SimAgent walletId.
        const walletId = (buyer as any).walletId;
        if (!walletId) {
          await adminClient.comment(`merchant_buy (x402): ${buyer.name} has no wallet — skipping`, 'alert');
          continue;
        }

        await client.payX402({
          endpointId: endpoint.id,
          requestId: randomUUID(),
          amount: price,
          currency: 'USDC',
          walletId,
          method: endpoint.method || 'POST',
          path: endpoint.path,
          metadata: { simRound: scenarioId, cycle, source: 'marketplace_sim' },
        });

        completedTrades++;
        totalVolume += price;
        await adminClient.milestone(
          `${PROTOCOL_ICON.x402} ${buyer.name} paid $${price.toFixed(2)} for "${endpoint.name}"`,
          { agentId: buyer.agentId, agentName: buyer.name, icon: PROTOCOL_ICON.x402 },
        );
      }
    } catch (e: any) {
      if (!handleSuspension(e, buyer)) {
        await adminClient.comment(
          `${PROTOCOL_ICON[config.protocol]} ${buyer.name} merchant_buy (${config.protocol}) failed: ${e.message}`,
          'alert',
        );
      }
    }

    await new Promise((r) => setTimeout(r, cycleSleepMs * (0.8 + Math.random() * 0.4)));
  }

  if (!dryRun) {
    await adminClient.comment(
      `merchant_buy [${config.protocol.toUpperCase()}] complete: ${cycle} cycles, ${completedTrades} purchases, $${totalVolume.toFixed(2)} volume`,
      'governance',
    );
  }

  findings.push(`${completedTrades} ${config.protocol.toUpperCase()} purchases across ${pool.length} buyers`);
  if (agentState.killedCount() > 0) findings.push(`${agentState.killedCount()} buyers killed mid-run`);

  return { completedTrades, totalVolume, findings };
}
