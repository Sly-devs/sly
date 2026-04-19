/**
 * multi_hop — chain trading pattern (A → B → C → D) with per-hop margins.
 *
 * Each cycle: the initiator buys from agent[0], who sub-contracts to agent[1],
 * and so on down the chain. Each hop takes a margin cut. Settlement propagates
 * backwards: last agent delivers, previous agent wraps that + its margin, etc.
 *
 * Use for:
 *   - multi_hop_paid: normal chain with healthy margins
 *   - cascading_default: thin margins + configurable demand shock every N cycles
 *     that doubles the initiator's price expectation → downstream agents can't
 *     cover their margins → cascade triggers
 *
 * Configuration shape:
 *
 *   {
 *     chainLength: 3,              // how many hops (agents) in the chain
 *     basePrice: 1.0,              // initiator pays this much
 *     marginPerHop: 0.15,          // each intermediary takes this fraction
 *     briefs: ["...", ...],        // round-robin list of requests
 *     defaults: {
 *       cycleSleepMs?: 2000,
 *       demandShockEvery?: 0,      // 0 = off; N = every Nth cycle, double basePrice
 *       styleFilter?: [...],
 *     },
 *   }
 */

import { SlyClient } from '../../sly-client.js';
import type { TaskContext, SimAgent, PersonaLike } from '../../processors/types.js';
import type { ScenarioContext, ScenarioResult } from '../types.js';
import { filterByStyle, createAgentClient } from '../../agents/registry.js';
import { AgentStateManager } from '../../agents/agent-state.js';

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export interface MultiHopConfig {
  chainLength: number;
  basePrice: number;
  marginPerHop: number;
  briefs: string[];
  defaults?: {
    cycleSleepMs?: number;
    /** Inject a demand shock (2x price) every N cycles. 0 = off. */
    demandShockEvery?: number;
    styleFilter?: SimAgent['style'][];
  };
  /**
   * Pricing mode: 'static' (default) = fixed prices from config.
   * 'dynamic' = agents adjust prices based on reputation + win rate each cycle.
   */
  pricingMode?: 'static' | 'dynamic';
  /** Dynamic pricing tuning. Only used when pricingMode = 'dynamic'. */
  dynamicPricing?: Partial<import('../../agents/agent-state.js').DynamicPricingConfig>;
  hooks?: Record<string, unknown>;
}

export interface RunMultiHopOptions {
  scenarioId: string;
  config: MultiHopConfig;
  dryRun?: boolean;
}

export async function runMultiHop(
  ctx: ScenarioContext,
  opts: RunMultiHopOptions,
): Promise<ScenarioResult> {
  const { processor, agents, durationMs, params, shouldStop } = ctx;
  const { scenarioId, config, dryRun = false } = opts;
  const baseUrl = process.env.SLY_API_URL!;
  const adminKey = process.env.SLY_PLATFORM_ADMIN_KEY!;

  if (!Array.isArray(config.briefs) || config.briefs.length === 0) {
    throw new Error('multi_hop: config.briefs is required and must be non-empty');
  }
  if (typeof config.chainLength !== 'number' || config.chainLength < 2) {
    throw new Error('multi_hop: config.chainLength must be >= 2');
  }
  if (typeof config.basePrice !== 'number' || config.basePrice <= 0) {
    throw new Error('multi_hop: config.basePrice must be > 0');
  }

  const defaults = config.defaults || {};
  const cycleSleepMs = (params.cycleSleepMs as number) || defaults.cycleSleepMs || 2000;
  const demandShockEvery = (params.demandShockEvery as number) || defaults.demandShockEvery || 0;
  const styleFilter = (params.styleFilter as SimAgent['style'][]) || defaults.styleFilter || ['honest', 'quality-reviewer'];

  const adminClient = new SlyClient({ baseUrl, adminKey });
  const clients: Record<string, SlyClient> = {};
  for (const a of agents) {
    clients[a.agentId] = createAgentClient(a, baseUrl, adminKey);
  }

  const isDynamicPricing = config.pricingMode === 'dynamic';
  const agentState = new AgentStateManager({
    slyClient: adminClient,
    dynamicPricing: isDynamicPricing,
    pricingConfig: config.dynamicPricing,
  });
  // Initialize base prices for all agents
  for (const a of agents) {
    agentState.setBasePrice(a.agentId, 'default', config.basePrice);
  }

  const pool = filterByStyle(agents, styleFilter);
  if (pool.length < config.chainLength + 1) {
    if (!dryRun) {
      await adminClient.comment(
        `Need at least ${config.chainLength + 1} agents for a ${config.chainLength}-hop chain + 1 initiator (have ${pool.length}).`,
        'alert',
      );
    }
    return { completedTrades: 0, totalVolume: 0, findings: ['Insufficient pool for chain'] };
  }

  if (!dryRun) {
    await adminClient.comment(
      `multi_hop: ${config.chainLength} hops · basePrice=$${config.basePrice} · margin=${(config.marginPerHop * 100).toFixed(0)}%/hop · demandShock every ${demandShockEvery || 'never'}`,
      'governance',
    );
  }

  let cycle = 0;
  let completedTrades = 0;
  let totalVolume = 0;
  let cascadeFailures = 0;
  let briefIdx = 0;
  let firstTradeAnnounced = false;
  const findings: string[] = [];
  const startedAt = Date.now();

  while (!shouldStop() && Date.now() - startedAt < durationMs) {
    cycle++;

    // Demand shock: double the base price every N cycles
    const isDemandShock = demandShockEvery > 0 && cycle % demandShockEvery === 0;
    const cycleBasePrice = isDemandShock ? config.basePrice * 2 : config.basePrice;

    // Build the chain: random initiator + N chain members
    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    const initiator = shuffled[0];
    const chain = shuffled.slice(1, 1 + config.chainLength);
    const brief = config.briefs[briefIdx % config.briefs.length];
    briefIdx++;

    // ─── Reputation + pricing adaptation (every cycle when dynamic) ───
    if (!dryRun && isDynamicPricing) {
      const allParticipants = [initiator, ...chain];
      const repChecks = await Promise.all(
        allParticipants.map((a) => agentState.checkReputation(a.agentId, cycle)),
      );
      for (let i = 0; i < repChecks.length; i++) {
        const rc = repChecks[i];
        if (rc.changed) {
          const name = allParticipants[i].name;
          const dir = rc.changed.to.score > rc.changed.from.score ? '📈' : '📉';
          await adminClient.comment(
            `${dir} ${name} reputation: ${rc.changed.from.score} (${rc.changed.from.tier}) → ${rc.changed.to.score} (${rc.changed.to.tier})`,
            'finding',
          );
        }
      }
      // Adapt pricing for all chain members (sellers)
      for (const s of chain) {
        const events = await agentState.adaptPricing(s.agentId, cycle);
        for (const ev of events) {
          await adminClient.comment(`💰 ${s.name} ${ev.action} (${ev.reason})`, 'finding');
        }
      }
    }

    if (!dryRun) {
      const shockNote = isDemandShock ? ' [DEMAND SHOCK 2x]' : '';
      await adminClient.comment(
        `Cycle ${cycle}: ${initiator.name} → ${chain.map((a) => a.name).join(' → ')} ($${cycleBasePrice.toFixed(2)})${shockNote}`,
        isDemandShock ? 'alert' : 'info',
      );
    }

    if (dryRun) {
      // Just validate the shape
      completedTrades++;
      break;
    }

    // Execute the chain: initiator buys from chain[0] at basePrice,
    // chain[0] buys from chain[1] at basePrice * (1 - margin), etc.
    // Each hop creates its own task + mandate.
    let chainBroke = false;
    let hopVolume = 0;
    const mandateIds: string[] = [];

    for (let hop = 0; hop < chain.length; hop++) {
      const buyer = hop === 0 ? initiator : chain[hop - 1];
      const seller = chain[hop];
      const dynamicBase = agentState.getCurrentPrice(seller.agentId, 'default', cycleBasePrice);
      const hopPrice = dynamicBase * Math.pow(1 - config.marginPerHop, hop);

      // If the hop price is too small to transact, the chain breaks
      if (hopPrice < 0.01) {
        if (!dryRun) {
          await adminClient.comment(
            `Chain broke at hop ${hop + 1}: price $${hopPrice.toFixed(4)} below minimum`,
            'alert',
          );
        }
        chainBroke = true;
        cascadeFailures++;
        break;
      }

      let taskId: string | null = null;
      let mandateId: string | null = null;
      try {
        const created = await clients[buyer.agentId].createTask({
          agentId: seller.agentId,
          message: {
            role: 'user',
            parts: [{ type: 'text', text: brief }],
            metadata: {
              simRound: scenarioId,
              cycle,
              hop: hop + 1,
              totalHops: chain.length,
              buyerStyle: buyer.style,
              sellerStyle: seller.style,
              externallyManaged: true,
              isDemandShock,
            },
          },
        });
        taskId = created.id;

        await clients[seller.agentId].claimTask(taskId);

        const mandate = await clients[buyer.agentId].createMandate({
          accountId: buyer.parentAccountId,
          buyerAgentId: buyer.agentId,
          providerAgentId: seller.agentId,
          providerAccountId: seller.parentAccountId,
          amount: hopPrice,
          currency: 'USDC',
          a2aSessionId: taskId,
          metadata: { simRound: scenarioId, cycle, hop: hop + 1, source: 'marketplace_sim', isDemandShock },
        });
        mandateId = mandate.mandate_id || (mandate as any).mandateId || null;
        if (mandateId) mandateIds.push(mandateId);

        const taskCtx: TaskContext = {
          taskId,
          requestText: brief,
          amount: hopPrice,
          currency: 'USDC',
          buyerName: buyer.name,
          sellerName: seller.name,
        };

        const sellerWithContext: PersonaLike = {
          ...seller,
          prompt: seller.prompt + agentState.getReputationContext(seller.agentId),
        };
        const { decision: provDecision } = await processor.processAsProvider(taskCtx, sellerWithContext);
        if (provDecision.action === 'fail' || !provDecision.artifactText) {
          await adminClient.comment(`Chain broke at hop ${hop + 1}: ${seller.name} failed to deliver`, 'alert');
          chainBroke = true;
          cascadeFailures++;
          // Cancel this hop's mandate
          if (mandateId) {
            try { await clients[buyer.agentId].cancelMandate(mandateId, { metadataMerge: { outcome: 'chain_broke' } }); } catch {}
          }
          break;
        }

        await clients[seller.agentId].completeTask(taskId, provDecision.artifactText);

        const buyerWithContext: PersonaLike = {
          ...buyer,
          prompt: buyer.prompt + agentState.getSellerContext(seller.agentId),
        };
        const { decision: buyerDecision } = await processor.processAsBuyer(
          taskCtx, seller, buyerWithContext, provDecision.artifactText,
        );

        await clients[buyer.agentId].respond({
          taskId,
          action: 'accept',
          score: buyerDecision.score,
          comment: buyerDecision.comment,
          satisfaction: buyerDecision.score >= 80 ? 'excellent' : buyerDecision.score >= 60 ? 'acceptable' : 'partial',
        });

        try {
          await clients[buyer.agentId].rateTask(taskId, {
            score: buyerDecision.score,
            comment: buyerDecision.comment,
            satisfaction: buyerDecision.score >= 80 ? 'excellent' : buyerDecision.score >= 60 ? 'acceptable' : 'partial',
            direction: 'buyer_rates_provider',
          });
        } catch {}

        // Record outcome for AgentState
        agentState.recordOutcome(seller.agentId, 'default', true, buyerDecision.score);

        hopVolume += hopPrice;
        // Log each hop with margin math for transparency
        if (!dryRun) {
          const marginPct = hop === 0 ? 'base' : `-${(config.marginPerHop * 100).toFixed(0)}%`;
          await adminClient.comment(
            `  hop ${hop + 1}/${chain.length}: ${buyer.name} → ${seller.name} $${hopPrice.toFixed(2)} (${marginPct}) score=${buyerDecision.score}`,
            'info',
          );
        }
      } catch (e: any) {
        await adminClient.comment(`Chain hop ${hop + 1} crashed: ${e.message}`, 'alert');
        chainBroke = true;
        cascadeFailures++;
        if (mandateId) {
          try { await clients[buyer.agentId].cancelMandate(mandateId, { metadataMerge: { outcome: 'crash' } }); } catch {}
        }
        break;
      }
    }

    // If chain broke mid-way, cancel all mandates created in earlier hops
    if (chainBroke) {
      for (const mid of mandateIds) {
        try {
          await clients[initiator.agentId].cancelMandate(mid, {
            metadataMerge: { outcome: 'cascade_cancel' },
          });
        } catch {}
      }
      if (!dryRun) {
        await adminClient.comment(
          `Cascade: chain broke, ${mandateIds.length} mandate(s) cancelled`,
          'finding',
        );
      }
    } else {
      completedTrades++;
      totalVolume += hopVolume;
      // Log the complete chain with margin breakdown
      if (!dryRun) {
        const chainPrices = chain.map((_, i) =>
          `$${(cycleBasePrice * Math.pow(1 - config.marginPerHop, i)).toFixed(2)}`
        ).join(' → ');
        await adminClient.comment(
          `✓ Chain ${cycle} complete: ${initiator.name} → ${chain.map((a) => a.name).join(' → ')} | prices: ${chainPrices} | total: $${hopVolume.toFixed(2)}`,
          'finding',
        );
      }
      if (!firstTradeAnnounced && !dryRun) {
        await adminClient.milestone(
          `First complete chain: ${initiator.name} → ${chain.map((a) => a.name).join(' → ')} ($${hopVolume.toFixed(2)})`,
          { agentId: chain[chain.length - 1].agentId, agentName: chain[chain.length - 1].name, icon: '✮' },
        );
        firstTradeAnnounced = true;
      }
    }

    if (cycle % 5 === 0 && !dryRun) {
      await adminClient.comment(
        `After ${cycle} cycles: ${completedTrades} complete chains, $${totalVolume.toFixed(2)} volume, ${cascadeFailures} cascade failures`,
        'finding',
      );
    }

    await new Promise((r) => setTimeout(r, cycleSleepMs * (0.8 + Math.random() * 0.4)));
  }

  if (!dryRun) {
    await adminClient.comment(
      `multi_hop complete: ${cycle} cycles, ${completedTrades} chains, $${totalVolume.toFixed(2)} volume, ${cascadeFailures} cascade failures`,
      'governance',
    );
    const usage = processor.getTotalUsage();
    if ((usage.costUsd ?? 0) > 0) {
      await adminClient.comment(
        `LLM cost: $${usage.costUsd?.toFixed(4)} (${usage.inputTokens}in/${usage.outputTokens}out)`,
        'governance',
      );
    }
    if ((usage.costUsd ?? 0) > 0) findings.push(`LLM cost: $${usage.costUsd?.toFixed(4)}`);
    findings.push(`${cycle} cycles · ${completedTrades} complete chains`);
    findings.push(`$${totalVolume.toFixed(2)} total volume across all hops`);
    findings.push(`${cascadeFailures} cascade failures`);
    if (demandShockEvery > 0) findings.push(`Demand shocks every ${demandShockEvery} cycles`);
  }

  return { completedTrades, totalVolume, findings };
}
