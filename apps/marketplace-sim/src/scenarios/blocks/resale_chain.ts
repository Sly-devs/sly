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

/** External agentic.market endpoint flattened to a resale-source shape. */
interface ExternalEndpoint {
  serviceId: string;
  serviceName: string;
  category: string;
  url: string;
  method: string;
  priceUsdc: number;
  network: string;
  host: string;
}

const AGENTIC_MARKET_CATALOG = 'https://api.agentic.market/v1/services';
const REALISTIC_PRICE_CEILING_USDC = 10.0; // skip wei↔USDC parse-error outliers
const REACHABLE_NETWORKS_FOR_RESALE = new Set(['Base', 'eip155:8453']); // mainnet only

/**
 * Pull the agentic.market catalog and flatten to priced + Base-reachable
 * x402 endpoints under maxPricePerCallUsdc. Mirrors the loader in
 * external_marketplace_x402.ts; kept inline here so resale_chain can
 * compile without a runtime import from another scenario block.
 */
async function loadAgenticMarketEndpointsForResale(maxPricePerCallUsdc: number): Promise<ExternalEndpoint[]> {
  const PAGE = 200;
  const seen = new Set<string>();
  const services: any[] = [];
  let offset = 0;
  while (offset < 1000) {
    const res = await fetch(`${AGENTIC_MARKET_CATALOG}?limit=${PAGE}&offset=${offset}`);
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

  const flat: ExternalEndpoint[] = [];
  for (const svc of services) {
    const endpoints = Array.isArray(svc.endpoints) ? svc.endpoints : [];
    for (const ep of endpoints) {
      const priceRaw = ep?.pricing?.amount;
      if (typeof priceRaw !== 'string' || priceRaw.trim() === '') continue;
      const priceUsdc = Number(priceRaw);
      if (!Number.isFinite(priceUsdc) || priceUsdc <= 0) continue;
      if (priceUsdc > REALISTIC_PRICE_CEILING_USDC) continue;
      if (priceUsdc > maxPricePerCallUsdc) continue;
      const network = ep?.pricing?.network || svc?.networks?.[0] || '';
      if (!REACHABLE_NETWORKS_FOR_RESALE.has(network)) continue;
      let host = '';
      try { host = new URL(ep.url).hostname; } catch { continue; }
      flat.push({
        serviceId: svc.id,
        serviceName: svc.name || svc.id,
        category: svc.category || 'Uncategorized',
        url: ep.url,
        method: (ep.method || 'GET').toUpperCase(),
        priceUsdc,
        network,
        host,
      });
    }
  }
  return flat;
}

export interface ResaleChainConfig {
  /** Merchant protocol the reseller sources from.
   *  - 'acp' / 'ucp': internal Sly merchants seeded by scripts/seed-sim-commerce.ts
   *  - 'x402_external': REAL agentic.market endpoints — requires reseller agents
   *    to have a provisioned + funded agent_eoa wallet. Settles on Base via USDC.
   */
  sourceProtocol: 'acp' | 'ucp' | 'x402_external';
  /** Markup factor applied over merchant cost (e.g. 1.25 = 25% markup). */
  markup?: number;
  /** When sourceProtocol='x402_external': max per-call price the reseller will
   *  pay upstream (USDC). Default $0.10 to keep blast radius bounded. */
  maxPricePerCallUsdc?: number;
  /** When sourceProtocol='x402_external': max total upstream spend per round
   *  (USDC). Default $1.00. The round terminates once this is reached. */
  maxRoundSpendUsdc?: number;
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

  if (!['acp', 'ucp', 'x402_external'].includes(config.sourceProtocol)) {
    throw new Error(`resale_chain: sourceProtocol must be 'acp' | 'ucp' | 'x402_external'`);
  }
  const markup = config.markup ?? 1.25;
  const maxPricePerCallUsdc = config.maxPricePerCallUsdc ?? 0.10;
  const maxRoundSpendUsdc = config.maxRoundSpendUsdc ?? 1.00;
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

  // Source-of-supply: either internal Sly merchants (acp/ucp) or external
  // agentic.market x402 endpoints. Loaded once at round start; per-cycle
  // pick happens below. external_x402 endpoints are flattened into the same
  // shape as internal catalog items so the downstream resale flow doesn't
  // care which path produced them.
  let merchants: any[] = [];
  let externalEndpoints: ExternalEndpoint[] = [];
  if (config.sourceProtocol === 'x402_external') {
    try {
      externalEndpoints = await loadAgenticMarketEndpointsForResale(maxPricePerCallUsdc);
    } catch (e: any) {
      await adminClient.comment(`resale_chain (x402_external): catalog fetch failed: ${e.message}`, 'alert');
      return { completedTrades: 0, totalVolume: 0, findings: ['Catalog unreachable'] };
    }
    if (externalEndpoints.length === 0) {
      await adminClient.comment(
        `resale_chain (x402_external): no agentic.market endpoints under $${maxPricePerCallUsdc.toFixed(2)}/call on Base — try raising maxPricePerCallUsdc`,
        'alert',
      );
      return { completedTrades: 0, totalVolume: 0, findings: ['No affordable endpoints'] };
    }
  } else {
    merchants = await adminClient.listMerchants({ limit: 50 });
    if (merchants.length === 0) {
      await adminClient.comment(
        `resale_chain: no merchants found. Run scripts/seed-sim-commerce.ts.`,
        'alert',
      );
      return { completedTrades: 0, totalVolume: 0, findings: ['No merchants'] };
    }
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
  // Tracks upstream spend on agentic.market when sourceProtocol='x402_external'.
  // Round terminates when this hits maxRoundSpendUsdc. Stays 0 in acp/ucp mode.
  let totalSpendUsdc = 0;
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
      // ─── 1. Reseller picks an upstream source + buys it ─────────────
      // For acp/ucp: pick from internal merchant catalog.
      // For x402_external: pick from cached agentic.market endpoints; pay
      // via the agent's on-chain EOA. Round terminates when the per-round
      // spend cap is reached.
      let merchantName: string;
      let merchantNodeId: string;
      let item: { id?: string; name: string; unit_price_cents?: number; currency?: string };
      let merchantCost: number;

      if (config.sourceProtocol === 'x402_external') {
        if (totalSpendUsdc >= maxRoundSpendUsdc) {
          await adminClient.comment(
            `resale_chain (x402_external): round spend cap $${maxRoundSpendUsdc.toFixed(2)} reached at $${totalSpendUsdc.toFixed(4)} — ending`,
            'governance',
          );
          break;
        }
        const remaining = maxRoundSpendUsdc - totalSpendUsdc;
        const fits = externalEndpoints.filter((e) => e.priceUsdc <= remaining);
        if (fits.length === 0) {
          await adminClient.comment(
            `resale_chain (x402_external): $${remaining.toFixed(4)} remaining can't cover any catalog endpoint — ending`,
            'governance',
          );
          break;
        }
        const ep = pick(fits);
        merchantName = `${ep.serviceName} (${ep.host})`;
        merchantNodeId = `ext:agentic-market:${ep.host}`;
        item = { id: ep.serviceId, name: ep.serviceName, unit_price_cents: Math.round(ep.priceUsdc * 100), currency: 'USDC' };
        merchantCost = ep.priceUsdc;

        // Pay the upstream BEFORE marking the source done. If x402-sign
        // returns 4xx (no EOA, KYA cap, frozen wallet) we want to surface
        // it as an alert and skip the cycle, NOT proceed to A2A resale.
        const USDC_DECIMALS = 1_000_000;
        const maxPriceBaseUnits = String(BigInt(Math.floor(merchantCost * USDC_DECIMALS)));
        let upstreamPaid = false;
        try {
          const result = await clients[reseller.agentId].x402FetchExternal({
            agentId: reseller.agentId,
            url: ep.url,
            method: ep.method,
            maxPriceBaseUnits,
            agentReason: `resale source: ${ep.serviceName} (${ep.category}) — for resale to peer at ${markup.toFixed(2)}×`,
          });
          if (result.paid) {
            upstreamPaid = true;
            totalSpendUsdc += merchantCost;
          } else {
            await adminClient.comment(
              `resale_chain (x402_external): upstream ${ep.host} returned ${result.status ?? 'no-response'}${result.error ? ` — ${result.error}` : ''}; skipping cycle`,
              'alert',
            );
          }
        } catch (e: any) {
          if (!handleSuspension(e, reseller)) {
            await adminClient.comment(
              `resale_chain (x402_external): upstream call to ${ep.host} threw: ${e.message}`,
              'alert',
            );
          }
        }
        if (!upstreamPaid) continue;
      } else {
        const merchant = pick(merchants);
        const catalogRaw = merchant?.catalog?.products || merchant?.catalog || [];
        const catalog: any[] = Array.isArray(catalogRaw) ? catalogRaw : [];
        if (catalog.length === 0) continue;
        item = pick(catalog) as { id?: string; name: string; unit_price_cents?: number; currency?: string };
        merchantCost = (item?.unit_price_cents ?? 0) / 100;
        if (merchantCost <= 0) continue;
        merchantName = merchant.name;
        merchantNodeId = 'merch:' + String(merchant.id);

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
      } // end internal-source else-branch

      // Source purchase happened — emit a milestone NOW so the upstream
      // shows on the graph even if the downstream A2A resale fails. The
      // `merchantNodeId` is either `merch:<uuid>` (internal) or
      // `ext:agentic-market:<host>` (x402_external) — viewer renders both
      // as merchant squares.
      await adminClient.milestone(
        `\u{1F6D2} ${reseller.name} sourced "${item.name}" from ${merchantName} ($${merchantCost.toFixed(4)}) — preparing resale`,
        {
          agentId: reseller.agentId,
          agentName: reseller.name,
          icon: '\u{1F6D2}',
          toId: merchantNodeId,
          toName: merchantName,
          toKind: 'merchant',
          amount: merchantCost,
          currency: 'USDC',
        },
      );

      // ─── 2. Buyer opens an A2A order with the reseller ──────────────
      // A2A semantics: client_agent_id = requestor, agent_id = worker. The
      // reseller is the one doing the fulfillment work, so the task must be
      // created BY the buyer and assigned TO the reseller — otherwise
      // claimTask later 403s with "Agent can only claim tasks assigned to
      // them" (same pattern as concierge.ts: buyer→concierge).
      const resalePrice = Math.round(merchantCost * markup * 100) / 100;
      const orderPrompt = `Order for "${item.name}" from your resale inventory (sourced from ${merchantName}). Agreed price $${resalePrice.toFixed(2)} (your cost $${merchantCost.toFixed(4)}, markup ×${markup.toFixed(2)}). Deliver and I'll release payment on acceptance.`;
      let taskId: string;
      try {
        const created = await clients[buyer.agentId].createTask({
          agentId: reseller.agentId,
          message: {
            role: 'user',
            parts: [{ type: 'text', text: orderPrompt }],
            metadata: {
              simRound: scenarioId,
              cycle,
              resale: true,
              merchantId: merchantNodeId,
              merchantCost,
              resalePrice,
              item: item.name,
              externallyManaged: true,
            },
          },
        });
        taskId = created.id;
      } catch (e: any) {
        if (!(handleSuspension(e, buyer) || handleSuspension(e, reseller))) {
          await adminClient.comment(
            `resale_chain: createTask failed ${buyer.name}→${reseller.name}: ${e.message}`,
            'alert',
          );
        }
        continue;
      }

      // Per-step observability: offer visible as an agent→agent edge.
      await adminClient.milestone(
        `\u{1F4E8} ${reseller.name} offered "${item.name}" to ${buyer.name} at $${resalePrice.toFixed(2)}`,
        {
          agentId: reseller.agentId,
          agentName: reseller.name,
          icon: '\u{1F4E8}',
          toId: buyer.agentId,
          toName: buyer.name,
          toKind: 'agent',
        },
      );

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
        // Robust id extraction — the server-typed response is
        // { mandate_id, id, status }, but be defensive against wrapper shapes.
        mandateId = (mandate as any).mandate_id
          || (mandate as any).mandateId
          || (mandate as any).id
          || (mandate as any).data?.mandate_id
          || (mandate as any).data?.id
          || null;
        if (!mandateId) {
          await adminClient.comment(
            `resale_chain: createMandate returned 2xx but no mandate id for ${buyer.name}→${reseller.name}`,
            'alert',
          );
        } else {
          await adminClient.comment(
            `\u{1F4B3} ${buyer.name} escrowed $${resalePrice.toFixed(2)} for ${reseller.name}'s resale (mandate ${mandateId.slice(0, 8)})`,
            'finding',
          );
        }
      } catch (e: any) {
        const suspended = handleSuspension(e, buyer) || handleSuspension(e, reseller);
        if (!suspended) {
          // A tier-limit rejection (or other governance gate) IS the platform
          // working — surface it on the graph with a distinct rejected edge +
          // 🛡 icon so operators see the block rather than a quiet drop.
          // Any non-suspension failure is governance-adjacent; we treat them
          // uniformly here.
          const reason = /tier|limit|velocity|kya|exceed/i.test(String(e.message))
            ? 'governance block'
            : 'rejected';
          await adminClient.milestone(
            `\u{1F6E1} ${reason}: ${buyer.name} → ${reseller.name} mandate for $${resalePrice.toFixed(2)} rejected (${e.message})`,
            {
              agentId: buyer.agentId,
              agentName: buyer.name,
              icon: '\u{1F6E1}',
              toId: reseller.agentId,
              toName: reseller.name,
              toKind: 'agent',
              edgeState: 'rejected',
            },
          );
        }
        continue;
      }

      // Helper so the always-cancel path doesn't throw if the mandate is
      // already terminal (settled/cancelled elsewhere).
      const safeCancelMandate = async (outcome: string) => {
        if (!mandateId) return;
        try {
          await clients[buyer.agentId].cancelMandate(mandateId, { metadataMerge: { outcome } });
        } catch { /* mandate may already be resolved — fine */ }
      };

      // ─── 4. Reseller claims the task and completes with fulfillment ──
      try {
        await clients[reseller.agentId].claimTask(taskId);
        await adminClient.comment(
          `\u{1F6E0} ${reseller.name} claimed resale task ${taskId.slice(0, 8)}`,
          'finding',
        );
      } catch (e: any) {
        if (!handleSuspension(e, reseller)) {
          await adminClient.comment(
            `resale_chain: claimTask failed ${reseller.name}→${buyer.name}: ${e.message}`,
            'alert',
          );
        }
        await safeCancelMandate('claim_failed');
        continue;
      }
      try {
        await clients[reseller.agentId].completeTask(
          taskId,
          `Delivered "${item.name}" from ${merchantName}. Your cost: $${resalePrice.toFixed(2)}. My margin: $${(resalePrice - merchantCost).toFixed(4)}.`,
        );
        await adminClient.comment(
          `\u2705 ${reseller.name} delivered "${item.name}" — awaiting ${buyer.name} acceptance`,
          'finding',
        );
      } catch (e: any) {
        if (!handleSuspension(e, reseller)) {
          await adminClient.comment(
            `resale_chain: completeTask failed ${reseller.name}→${buyer.name}: ${e.message}`,
            'alert',
          );
        }
        await safeCancelMandate('complete_failed');
        continue;
      }

      // ─── 5. Buyer accepts + rates ────────────────────────────────────
      let buyerResponded = false;
      try {
        await clients[buyer.agentId].respond({
          taskId,
          action: 'accept',
          score: 80 + Math.floor(Math.random() * 15),
          comment: `Good resale fulfillment — item matches description`,
          satisfaction: 'excellent',
        });
        buyerResponded = true;
      } catch (e: any) {
        if (!(handleSuspension(e, buyer) || handleSuspension(e, reseller))) {
          await adminClient.comment(
            `resale_chain: respond failed ${buyer.name}→${reseller.name}: ${e.message}`,
            'alert',
          );
        }
        await safeCancelMandate('buyer_respond_failed');
      }

      // Post-respond sanity check — the server's /respond handler with
      // action:'accept' should have transitioned the mandate to 'completed'
      // via resolveSettlementMandate. If it didn't, the ap2↔a2a linkage
      // regressed; surface it as an alert rather than letting the mandate
      // quietly sit in escrow.
      if (buyerResponded && mandateId) {
        try {
          const m = await clients[buyer.agentId].getMandate(mandateId);
          const status = (m as any)?.status ?? (m as any)?.data?.status;
          if (status && status !== 'completed') {
            await adminClient.comment(
              `resale_chain: mandate ${mandateId.slice(0, 8)} still '${status}' after buyer accepted — ap2↔a2a linkage regression?`,
              'alert',
            );
          }
        } catch { /* non-fatal sanity check */ }
      }

      completedTrades++;
      totalVolume += resalePrice;

      // Resale-complete milestone. No `amount` — we already counted the
      // merchant leg in the sourced milestone; counting again would
      // double the volume number. The A2A task + AP2 mandate created above
      // will surface as regular agent→agent activity and their volume flows
      // through the normal mandate-completion aggregator.
      await adminClient.milestone(
        `\u{1F501} ${reseller.name} resold "${item.name}" (${merchantName} → ${buyer.name}, margin $${(resalePrice - merchantCost).toFixed(4)})`,
        {
          agentId: reseller.agentId,
          agentName: reseller.name,
          icon: '\u{1F501}',
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
