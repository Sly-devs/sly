/**
 * ring_trade — circular trading pattern for collusion detection scenarios.
 *
 * Each cycle: agent[i] buys from agent[(i+1) % N], rotating through the ring.
 * Every `camouflageEvery` cycles, a random pair of non-adjacent agents trades
 * to create noise that makes the ring harder to detect.
 *
 * Configuration shape:
 *
 *   {
 *     pricePerTrade: 1.0,
 *     briefs: ["...", ...],          // round-robin list of requests
 *     ratingInflation: 0,            // 0-30 bonus added to colluder ratings (0 = honest)
 *     defaults: {
 *       cycleSleepMs?: 1500,
 *       camouflageEvery?: 0,         // 0 = no camouflage trades
 *       styleFilter?: [...],
 *     },
 *   }
 *
 * Outcomes the report can attribute (via mandate metadata):
 *   - ring_trade         — circular trade between adjacent ring members
 *   - camouflage_trade   — non-adjacent noise trade
 *   - normal             — legitimate baseline trade (if mixed pool)
 */

import { SlyClient, isSuspensionError, isStaleAgentTokenError } from '../../sly-client.js';
import type { TaskContext, SimAgent, PersonaLike } from '../../processors/types.js';
import type { ScenarioContext, ScenarioResult } from '../types.js';
import { filterByStyle, createAgentClient } from '../../agents/registry.js';
import { AgentStateManager } from '../../agents/agent-state.js';

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export interface RingTradeConfig {
  pricePerTrade: number;
  briefs: string[];
  /** Bonus score added to colluder ratings (0-30). 0 = honest baseline. */
  ratingInflation?: number;
  defaults?: {
    cycleSleepMs?: number;
    /** Insert a camouflage trade (non-adjacent pair) every N cycles. 0 = off. */
    camouflageEvery?: number;
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

export interface RunRingTradeOptions {
  scenarioId: string;
  config: RingTradeConfig;
  dryRun?: boolean;
}

export async function runRingTrade(
  ctx: ScenarioContext,
  opts: RunRingTradeOptions,
): Promise<ScenarioResult> {
  const { processor, agents, durationMs, params, shouldStop } = ctx;
  const { scenarioId, config, dryRun = false } = opts;
  const baseUrl = process.env.SLY_API_URL!;
  const adminKey = process.env.SLY_PLATFORM_ADMIN_KEY!;

  if (!Array.isArray(config.briefs) || config.briefs.length === 0) {
    throw new Error('ring_trade: config.briefs is required and must be non-empty');
  }
  if (typeof config.pricePerTrade !== 'number' || config.pricePerTrade <= 0) {
    throw new Error('ring_trade: config.pricePerTrade must be a positive number');
  }

  const defaults = config.defaults || {};
  const cycleSleepMs = (params.cycleSleepMs as number) || defaults.cycleSleepMs || 1500;
  const camouflageEvery = (params.camouflageEvery as number) || defaults.camouflageEvery || 0;
  const styleFilter = (params.styleFilter as SimAgent['style'][]) || defaults.styleFilter || ['honest', 'colluder'];
  const ratingInflation = config.ratingInflation ?? 0;

  const adminClient = new SlyClient({ baseUrl, adminKey });
  const clients: Record<string, SlyClient> = {};
  for (const a of agents) {
    clients[a.agentId] = createAgentClient(a, baseUrl, adminKey);
  }

  // Live collusion flagging — re-run the detector after each new rating and
  // emit a milestone the first time an agent trips the heuristics.
  const flaggedThisRun = new Set<string>();
  const maybeFlagCollusion = async (agentId: string, agentName: string) => {
    if (flaggedThisRun.has(agentId)) return;
    try {
      const sig = await adminClient.checkCollusion(agentId);
      if (!sig.flagged) return;
      flaggedThisRun.add(agentId);
      await adminClient.milestone(
        `Rating ring detected on ${agentName} — ${sig.reason ?? 'closed rating graph'}`,
        { agentId, agentName, icon: '\u{1F6A8}' },
      );
    } catch { /* best-effort */ }
  };

  const isDynamicPricing = config.pricingMode === 'dynamic';
  const agentState = new AgentStateManager({
    slyClient: adminClient,
    dynamicPricing: isDynamicPricing,
    pricingConfig: config.dynamicPricing,
  });
  // Initialize base prices for all agents
  for (const a of agents) {
    agentState.setBasePrice(a.agentId, 'default', config.pricePerTrade);
  }

  const pool = filterByStyle(agents, styleFilter);
  if (pool.length < 3) {
    if (!dryRun) {
      await adminClient.comment(
        `Need at least 3 agents in the ring (have ${pool.length}).`,
        'alert',
      );
    }
    return { completedTrades: 0, totalVolume: 0, findings: ['Insufficient pool for ring'] };
  }

  // Build the ring order — shuffle once at start for variety across runs.
  const ring = [...pool].sort(() => Math.random() - 0.5);

  if (!dryRun) {
    await adminClient.comment(
      `ring_trade: ${ring.length} agents in ring · price=$${config.pricePerTrade} · inflation=${ratingInflation} · camouflage every ${camouflageEvery || 'never'}`,
      'governance',
    );
    await adminClient.comment(
      `Ring order: ${ring.map((a) => a.name).join(' → ')} → ${ring[0].name}`,
      'info',
    );
  }

  let cycle = 0;
  let completedTrades = 0;
  let totalVolume = 0;
  let briefIdx = 0;
  let firstTradeAnnounced = false;
  const findings: string[] = [];
  const startedAt = Date.now();

  /**
   * When a Sly API call throws isSuspensionError, the agent the call targeted
   * (seller for A2A endpoints, buyer for mandate/respond endpoints) has been
   * killed via the kill switch. Mark it so future cycles skip the agent.
   * Returns true if we classified it as a suspension.
   */
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

  const executeTrade = async (
    buyer: SimAgent,
    seller: SimAgent,
    tradeType: 'ring_trade' | 'camouflage_trade',
  ): Promise<boolean> => {
    // Skip trades where either participant has been killed mid-run.
    if (agentState.isKilled(buyer.agentId) || agentState.isKilled(seller.agentId)) {
      return false;
    }
    const brief = config.briefs[briefIdx % config.briefs.length];
    briefIdx++;

    if (dryRun) return true;

    const tradePrice = agentState.getCurrentPrice(seller.agentId, 'default', config.pricePerTrade);
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
            buyerStyle: buyer.style,
            sellerStyle: seller.style,
            externallyManaged: true,
            tradeType,
          },
        },
      });
      taskId = created.id;

      try {
        await clients[seller.agentId].claimTask(taskId);
      } catch (e: any) {
        if (!handleSuspension(e, seller)) {
          await adminClient.comment(`${seller.name} could not claim: ${e.message}`, 'alert');
        }
        return false;
      }

      try {
        const mandate = await clients[buyer.agentId].createMandate({
          accountId: buyer.parentAccountId,
          buyerAgentId: buyer.agentId,
          providerAgentId: seller.agentId,
          providerAccountId: seller.parentAccountId,
          amount: tradePrice,
          currency: 'USDC',
          a2aSessionId: taskId,
          metadata: { simRound: scenarioId, cycle, source: 'marketplace_sim', tradeType },
        });
        mandateId = mandate.mandate_id || (mandate as any).mandateId || null;
      } catch (e: any) {
        // A mandate refusal can mean the buyer was killed; check both.
        if (!handleSuspension(e, buyer) && !handleSuspension(e, seller)) {
          await adminClient.comment(`Mandate refused for ${buyer.name}→${seller.name}: ${e.message}`, 'alert');
        }
        return false;
      }

      const taskCtx: TaskContext = {
        taskId,
        requestText: brief,
        amount: tradePrice,
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
        if (mandateId) {
          try { await clients[buyer.agentId].cancelMandate(mandateId, { metadataMerge: { outcome: 'provider_failed' } }); } catch {}
        }
        return false;
      }

      try {
        await clients[seller.agentId].completeTask(taskId, provDecision.artifactText);
      } catch (e: any) {
        handleSuspension(e, seller);
        if (mandateId) {
          try { await clients[buyer.agentId].cancelMandate(mandateId, { metadataMerge: { outcome: 'complete_failed' } }); } catch {}
        }
        return false;
      }

      // Buyer reviews — colluders inflate their ratings
      const buyerWithContext: PersonaLike = {
        ...buyer,
        prompt: buyer.prompt + agentState.getSellerContext(seller.agentId),
      };
      const { decision: buyerDecision } = await processor.processAsBuyer(
        taskCtx, seller, buyerWithContext, provDecision.artifactText,
      );

      const isCollusionTrade = tradeType === 'ring_trade' &&
        buyer.style === 'colluder' && seller.style === 'colluder';
      const inflatedScore = isCollusionTrade
        ? Math.min(100, buyerDecision.score + ratingInflation)
        : buyerDecision.score;

      try {
        await clients[buyer.agentId].respond({
          taskId,
          action: 'accept',
          score: inflatedScore,
          comment: buyerDecision.comment,
          satisfaction: inflatedScore >= 80 ? 'excellent' : inflatedScore >= 60 ? 'acceptable' : 'partial',
        });
      } catch (e: any) {
        if (!handleSuspension(e, buyer) && !handleSuspension(e, seller)) {
          await adminClient.comment(`${buyer.name}'s respond() rejected: ${e.message}`, 'alert');
        }
      }

      try {
        await clients[buyer.agentId].rateTask(taskId, {
          score: inflatedScore,
          comment: buyerDecision.comment,
          satisfaction: inflatedScore >= 80 ? 'excellent' : inflatedScore >= 60 ? 'acceptable' : 'partial',
          direction: 'buyer_rates_provider',
        });
      } catch {}

      // Live collusion check after the seller just got a new rating.
      // Fire-and-forget — dedupe handled inside maybeFlagCollusion.
      void maybeFlagCollusion(seller.agentId, seller.name);

      // Record outcome for AgentState
      agentState.recordOutcome(seller.agentId, 'default', true, inflatedScore);

      completedTrades++;
      totalVolume += tradePrice;

      const tag = tradeType === 'ring_trade' ? '⟳' : '◇';
      const inflateNote = isCollusionTrade && ratingInflation > 0 ? ` [inflated +${ratingInflation}]` : '';
      await adminClient.comment(
        `${tag} ${buyer.name}→${seller.name} scored ${inflatedScore}${inflateNote} ($${tradePrice.toFixed(2)})`,
        tradeType === 'ring_trade' ? 'finding' : 'info',
      );

      if (!firstTradeAnnounced) {
        await adminClient.milestone(
          `First REAL settlement: ${buyer.name} → ${seller.name} ($${tradePrice.toFixed(2)} via public AP2)`,
          { agentId: seller.agentId, agentName: seller.name, icon: '✮' },
        );
        firstTradeAnnounced = true;
      }

      return true;
    } catch (e: any) {
      // If the top-level createTask rejects because the seller is suspended,
      // classify and suppress the noisy alert.
      const classified = handleSuspension(e, seller) || handleSuspension(e, buyer);
      if (!classified && !dryRun) {
        await adminClient.comment(`Trade ${buyer.name}→${seller.name} crashed: ${e.message}`, 'alert');
      }
      if (mandateId) {
        try { await clients[buyer.agentId].cancelMandate(mandateId, { metadataMerge: { outcome: 'crash' } }); } catch {}
      }
      return false;
    }
  };

  while (!shouldStop() && Date.now() - startedAt < durationMs) {
    cycle++;

    // Skip killed agents — if too few remain, end the round cleanly.
    const activeRing = agentState.activeAgents(ring);
    if (activeRing.length < 3) {
      if (!dryRun) {
        await adminClient.comment(
          `ring_trade: only ${activeRing.length} active agents left (need 3+), ending round`,
          'alert',
        );
      }
      break;
    }

    // Main ring trade: agent[i] buys from agent[(i+1) % N]
    const ringIdx = (cycle - 1) % activeRing.length;
    const buyer = activeRing[ringIdx];
    const seller = activeRing[(ringIdx + 1) % activeRing.length];

    // ─── Reputation + pricing adaptation (every cycle when dynamic) ───
    if (!dryRun && isDynamicPricing) {
      const repChecks = await Promise.all([
        agentState.checkReputation(buyer.agentId, cycle),
        agentState.checkReputation(seller.agentId, cycle),
      ]);
      const participants = [buyer, seller];
      for (let i = 0; i < repChecks.length; i++) {
        const rc = repChecks[i];
        if (rc.changed) {
          const name = participants[i].name;
          const dir = rc.changed.to.score > rc.changed.from.score ? '📈' : '📉';
          await adminClient.comment(
            `${dir} ${name} reputation: ${rc.changed.from.score} (${rc.changed.from.tier}) → ${rc.changed.to.score} (${rc.changed.to.tier})`,
            'finding',
          );
        }
      }
      // Adapt pricing for the seller
      const events = await agentState.adaptPricing(seller.agentId, cycle);
      for (const ev of events) {
        await adminClient.comment(`💰 ${seller.name} ${ev.action} (${ev.reason})`, 'finding');
      }
    }

    if (!dryRun) {
      await adminClient.comment(
        `Cycle ${cycle}: ring trade ${buyer.name}→${seller.name}`,
        'info',
      );
    }

    await executeTrade(buyer, seller, 'ring_trade');

    // Camouflage trade: non-adjacent pair to obscure the ring
    if (camouflageEvery > 0 && cycle % camouflageEvery === 0 && activeRing.length >= 4) {
      // Pick two active agents that are NOT adjacent in the ring
      const camoA = activeRing[Math.floor(Math.random() * activeRing.length)];
      let camoB: SimAgent;
      do {
        camoB = activeRing[Math.floor(Math.random() * activeRing.length)];
      } while (
        camoB.agentId === camoA.agentId ||
        activeRing[(activeRing.indexOf(camoA) + 1) % activeRing.length].agentId === camoB.agentId ||
        activeRing[(activeRing.indexOf(camoB) + 1) % activeRing.length].agentId === camoA.agentId
      );

      if (!dryRun) {
        await adminClient.comment(
          `Cycle ${cycle}: camouflage trade ${camoA.name}→${camoB.name}`,
          'info',
        );
      }
      await executeTrade(camoA, camoB, 'camouflage_trade');
    }

    if (cycle % 5 === 0 && !dryRun) {
      await adminClient.comment(
        `After ${cycle} cycles: ${completedTrades} trades, $${totalVolume.toFixed(2)} volume`,
        'finding',
      );
    }

    if (dryRun) break;
    await new Promise((r) => setTimeout(r, cycleSleepMs * (0.8 + Math.random() * 0.4)));
  }

  if (!dryRun) {
    await adminClient.comment(
      `ring_trade complete: ${cycle} cycles, ${completedTrades} trades, $${totalVolume.toFixed(2)} volume`,
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
    findings.push(`${cycle} cycles · ${completedTrades} trades`);
    findings.push(`$${totalVolume.toFixed(2)} volume`);
    findings.push(`Ring size: ${ring.length} agents`);
    if (ratingInflation > 0) findings.push(`Rating inflation: +${ratingInflation} for colluder↔colluder trades`);
    if (camouflageEvery > 0) findings.push(`Camouflage: every ${camouflageEvery} cycles`);
  }

  return { completedTrades, totalVolume, findings };
}
