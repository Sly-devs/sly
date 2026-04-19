/**
 * one_to_one — generic 1:1 trade building block.
 *
 * Each cycle is a single buyer→seller trade. Used by adversarial scenarios
 * where the goal isn't competition but stress-testing rogue patterns:
 *   - Honest agents trade normally to establish baseline volume.
 *   - Every Nth cycle a rogue is injected as either buyer (disputer) or
 *     seller (spammer) to exercise platform defenses (KYA gates, dispute
 *     handling, settlement enforcement).
 *
 * Configuration shape:
 *
 *   {
 *     pricePerCycle: 1.0,                       // amount per trade
 *     honestRequests: ["...", ...],             // round-robin list of briefs
 *     defaults: {
 *       rogueCycleEvery?: 3,                    // inject rogue every N cycles
 *       cycleSleepMs?: 1500,
 *       honestStyles?: ['honest', 'quality-reviewer'],
 *       rogueStyles?: ['rogue-disputer', 'rogue-spam'],
 *     },
 *   }
 *
 * Runtime knobs (read from `ctx.params`, validated upstream):
 *   - rogueCycleEvery: number
 *   - cycleSleepMs:    number
 *
 * Outcomes the report can attribute (via task metadata.outcome):
 *   - rogueRejected             buyer caught the bad work
 *   - rogueSucceeded            buyer accepted bad work (containment failure)
 *   - rogueBlockedByPlatform    KYA gate / mandate creation refused (defensive win)
 *   - rogueDisputes             rogue successfully filed a dispute
 *   - rogueDefeated             rogue could not find an excuse — work was too good
 *   - normal                    honest baseline trade
 */

import { SlyClient } from '../../sly-client.js';
import type { TaskContext, SimAgent, PersonaLike } from '../../processors/types.js';
import type { ScenarioContext, ScenarioResult } from '../types.js';
import { filterByStyle, createAgentClient } from '../../agents/registry.js';
import { AgentStateManager } from '../../agents/agent-state.js';

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export interface OneToOneConfig {
  pricePerCycle: number;
  honestRequests: string[];
  defaults?: {
    rogueCycleEvery?: number;
    cycleSleepMs?: number;
    honestStyles?: SimAgent['style'][];
    rogueStyles?: SimAgent['style'][];
  };
  /**
   * Pricing mode: 'static' (default) = fixed prices from config.
   * 'dynamic' = agents adjust prices based on reputation + win rate each cycle.
   */
  pricingMode?: 'static' | 'dynamic';
  /** Dynamic pricing tuning. Only used when pricingMode = 'dynamic'. */
  dynamicPricing?: Partial<import('../../agents/agent-state.js').DynamicPricingConfig>;
  /** Open-ended hooks slot — reserved for future scenario-specific logic. */
  hooks?: Record<string, unknown>;
}

export interface RunOneToOneOptions {
  scenarioId: string;
  config: OneToOneConfig;
  /** Skip every network call, run one cycle, return — used by the compiler. */
  dryRun?: boolean;
}

type Outcome =
  | 'normal'
  | 'rogueRejected'
  | 'rogueSucceeded'
  | 'rogueBlockedByPlatform'
  | 'rogueDisputes'
  | 'rogueDefeated';

interface CycleStats {
  cycles: number;
  normal: number;
  rogueRejected: number;
  rogueSucceeded: number;
  rogueBlockedByPlatform: number;
  rogueDisputes: number;
  rogueDefeated: number;
}

export async function runOneToOne(
  ctx: ScenarioContext,
  opts: RunOneToOneOptions,
): Promise<ScenarioResult> {
  const { processor, agents, durationMs, params, shouldStop } = ctx;
  const { scenarioId, config, dryRun = false } = opts;
  const baseUrl = process.env.SLY_API_URL!;
  const adminKey = process.env.SLY_PLATFORM_ADMIN_KEY!;

  if (typeof config.pricePerCycle !== 'number' || config.pricePerCycle <= 0) {
    throw new Error('one_to_one: config.pricePerCycle must be a positive number');
  }
  if (!Array.isArray(config.honestRequests) || config.honestRequests.length === 0) {
    throw new Error('one_to_one: config.honestRequests is required and must be non-empty');
  }

  const defaults = config.defaults || {};
  const rogueCycleEvery = (params.rogueCycleEvery as number) || defaults.rogueCycleEvery || 3;
  const cycleSleepMs = (params.cycleSleepMs as number) || defaults.cycleSleepMs || 1500;
  const honestStyles = defaults.honestStyles || ['honest', 'quality-reviewer'];
  const rogueStyles = defaults.rogueStyles || ['rogue-disputer', 'rogue-spam'];

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
    agentState.setBasePrice(a.agentId, 'default', config.pricePerCycle);
  }

  const honestPool = filterByStyle(agents, honestStyles);
  const roguePool = filterByStyle(agents, rogueStyles);

  if (!dryRun) {
    await adminClient.comment(
      `one_to_one: ${honestPool.length} honest, ${roguePool.length} rogue · price=$${config.pricePerCycle} · rogueEvery=${rogueCycleEvery} cycles`,
      'governance',
    );
  }

  if (honestPool.length < 2) {
    if (!dryRun) {
      await adminClient.comment(
        `Need at least 2 honest agents to run baseline trades (have ${honestPool.length}).`,
        'alert',
      );
    }
    return { completedTrades: 0, totalVolume: 0, findings: ['Insufficient honest pool'] };
  }

  const stats: CycleStats = {
    cycles: 0,
    normal: 0,
    rogueRejected: 0,
    rogueSucceeded: 0,
    rogueBlockedByPlatform: 0,
    rogueDisputes: 0,
    rogueDefeated: 0,
  };
  let completedTrades = 0;
  let totalVolume = 0;
  let firstTradeAnnounced = false;
  let briefIdx = 0;
  const findings: string[] = [];
  const startedAt = Date.now();

  /**
   * Run one buyer→seller trade. Returns the outcome label so the cycle loop
   * can update stats. The function is responsible for cleaning up its own
   * mandate via cancelMandate() on any non-accept path.
   */
  const runTrade = async (buyer: SimAgent, seller: SimAgent, isRogueCycle: boolean): Promise<Outcome> => {
    const brief = config.honestRequests[briefIdx % config.honestRequests.length];
    briefIdx++;
    const shortBrief = brief.length > 80 ? brief.slice(0, 77) + '\u2026' : brief;
    // Pre-compute the rogue role so the mandate metadata carries enough
    // context for the report assessor to bucket outcomes without needing to
    // know which agent was rogue at report time.
    const sellerIsRogueAtCycleStart = seller.style.startsWith('rogue');
    const buyerIsRogueAtCycleStart = buyer.style.startsWith('rogue');
    const rogueRole: 'buyer' | 'seller' | null = !isRogueCycle
      ? null
      : sellerIsRogueAtCycleStart
      ? 'seller'
      : buyerIsRogueAtCycleStart
      ? 'buyer'
      : null;

    if (!dryRun) {
      const tag = isRogueCycle ? 'ROGUE' : 'normal';
      await adminClient.comment(
        `Cycle ${stats.cycles}: ${tag} · ${buyer.name}\u2192${seller.name} · "${shortBrief}"`,
        isRogueCycle ? 'alert' : 'info',
      );
    }

    let taskId: string | null = null;
    let mandateId: string | null = null;

    try {
      if (dryRun) return 'normal';

      // 1. Buyer creates the task
      const created = await clients[buyer.agentId].createTask({
        agentId: seller.agentId,
        message: {
          role: 'user',
          parts: [{ type: 'text', text: brief }],
          metadata: {
            simRound: scenarioId,
            cycle: stats.cycles,
            buyerStyle: buyer.style,
            sellerStyle: seller.style,
            externallyManaged: true,
            isRogueCycle,
          },
        },
      });
      taskId = created.id;

      // 2. Seller claims it (race against the background worker)
      try {
        await clients[seller.agentId].claimTask(taskId);
      } catch (e: any) {
        await adminClient.comment(`${seller.name} could not claim task: ${e.message}`, 'alert');
        return isRogueCycle && seller.style.startsWith('rogue') ? 'rogueBlockedByPlatform' : 'normal';
      }

      // 3. Buyer escrows funds via public AP2. The KYA gate may refuse this
      //    when either side is unverified — that's the platform working as
      //    intended, and we count it as `rogueBlockedByPlatform`.
      const tradePrice = agentState.getCurrentPrice(seller.agentId, 'default', config.pricePerCycle);

      try {
        const mandate = await clients[buyer.agentId].createMandate({
          accountId: buyer.parentAccountId,
          buyerAgentId: buyer.agentId,
          providerAgentId: seller.agentId,
          providerAccountId: seller.parentAccountId,
          amount: tradePrice,
          currency: 'USDC',
          a2aSessionId: taskId,
          metadata: {
            simRound: scenarioId,
            cycle: stats.cycles,
            source: 'marketplace_sim',
            isRogueCycle,
            rogueRole,
          },
        });
        mandateId = mandate.mandate_id || (mandate as any).mandateId || null;
      } catch (e: any) {
        await adminClient.comment(
          `Mandate refused by platform for ${buyer.name}\u2192${seller.name}: ${e.message}`,
          isRogueCycle ? 'finding' : 'alert',
        );
        // Best-effort cleanup of the orphaned task
        try {
          await clients[buyer.agentId].respond({
            taskId,
            action: 'reject',
            comment: 'Mandate creation refused by platform',
          });
        } catch { /* best-effort */ }
        return isRogueCycle ? 'rogueBlockedByPlatform' : 'normal';
      }

      // 4. Seller produces the artifact (real LLM call)
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
        try {
          if (mandateId) {
            await clients[buyer.agentId].cancelMandate(mandateId, {
              metadataMerge: { outcome: 'provider_failed' },
            });
          }
        } catch { /* best-effort */ }
        await adminClient.comment(
          `${seller.name} FAILED to deliver (${provDecision.failureReason || 'no artifact'})`,
          'alert',
        );
        return 'normal';
      }

      // 5. Seller marks complete via public endpoint
      try {
        await clients[seller.agentId].completeTask(taskId, provDecision.artifactText);
      } catch (e: any) {
        await adminClient.comment(`${seller.name}'s complete() rejected: ${e.message}`, 'alert');
        try {
          if (mandateId) await clients[buyer.agentId].cancelMandate(mandateId, {
            metadataMerge: { outcome: 'complete_failed' },
          });
        } catch { /* best-effort */ }
        return 'normal';
      }

      // 6. Buyer reviews
      const buyerWithContext: PersonaLike = {
        ...buyer,
        prompt: buyer.prompt + agentState.getSellerContext(seller.agentId),
      };
      const { decision: buyerDecision } = await processor.processAsBuyer(
        taskCtx,
        seller,
        buyerWithContext,
        provDecision.artifactText,
      );

      // 7. Settle via public /respond
      try {
        await clients[buyer.agentId].respond({
          taskId,
          action: buyerDecision.action,
          score: buyerDecision.score,
          comment: buyerDecision.comment,
          satisfaction:
            buyerDecision.score >= 80 ? 'excellent' : buyerDecision.score >= 60 ? 'acceptable' : 'partial',
        });
      } catch (e: any) {
        await adminClient.comment(`${buyer.name}'s respond() rejected: ${e.message}`, 'alert');
      }

      // Best-effort rating + defensive mandate cancel on non-accept.
      // Tag the mandate with a rogue-aware outcome so the report assessor can
      // bucket containment metrics without re-deriving who was rogue.
      if (buyerDecision.action !== 'accept' && mandateId) {
        let outcome: string;
        if (isRogueCycle) {
          if (rogueRole === 'seller') {
            // Rogue seller delivered bad work, honest buyer caught it.
            outcome = 'rogueRejected';
          } else if (rogueRole === 'buyer') {
            // Rogue buyer rejected/disputed honest seller's work.
            outcome = buyerDecision.action === 'dispute' ? 'rogueDisputed' : 'rogueRejected';
          } else {
            outcome = buyerDecision.action === 'dispute' ? 'disputed' : 'rejected';
          }
        } else {
          outcome = buyerDecision.action === 'dispute' ? 'disputed' : 'rejected';
        }
        try {
          await clients[buyer.agentId].cancelMandate(mandateId, {
            metadataMerge: {
              outcome,
              resolvedAt: new Date().toISOString(),
            },
          });
        } catch { /* best-effort */ }
      }
      try {
        await clients[buyer.agentId].rateTask(taskId, {
          score: buyerDecision.score,
          comment: buyerDecision.comment,
          satisfaction:
            buyerDecision.score >= 80 ? 'excellent' : buyerDecision.score >= 60 ? 'acceptable' : 'partial',
          direction: 'buyer_rates_provider',
        });
      } catch { /* may fail if terminal */ }

      // ─── Record outcome for AgentState ───
      const won = buyerDecision.action === 'accept';
      agentState.recordOutcome(seller.agentId, 'default', won, buyerDecision.score);

      // ─── Outcome attribution ───
      if (!isRogueCycle) {
        if (won) {
          completedTrades++;
          totalVolume += tradePrice;
        }
        return 'normal';
      }

      // Rogue cycle — use the precomputed rogueRole
      if (rogueRole === 'seller') {
        // Rogue tried to deliver bad work
        if (buyerDecision.action === 'reject' || buyerDecision.action === 'dispute') {
          await adminClient.comment(
            `Containment WIN: ${buyer.name} caught ${seller.name}'s bad work (${buyerDecision.action})`,
            'finding',
          );
          return 'rogueRejected';
        }
        await adminClient.comment(
          `Containment FAILURE: ${buyer.name} accepted ${seller.name}'s low-effort work`,
          'alert',
        );
        completedTrades++;
        totalVolume += tradePrice;
        return 'rogueSucceeded';
      }

      if (rogueRole === 'buyer') {
        // Rogue tried to extract value via dispute
        if (buyerDecision.action === 'dispute') {
          await adminClient.comment(
            `${buyer.name} filed a dispute against ${seller.name}`,
            'alert',
          );
          return 'rogueDisputes';
        }
        // Rogue had to accept — work was too good to refuse
        await adminClient.comment(
          `Rogue DEFEATED: ${buyer.name} could find no excuse, accepted ${seller.name}'s work`,
          'finding',
        );
        completedTrades++;
        totalVolume += tradePrice;
        return 'rogueDefeated';
      }

      return 'normal';
    } catch (e: any) {
      if (!dryRun) {
        await adminClient.comment(`Trade ${buyer.name}\u2192${seller.name} crashed: ${e.message}`, 'alert');
      }
      // Defensive cleanup if a mandate was created before the crash
      if (mandateId) {
        try {
          await clients[buyer.agentId].cancelMandate(mandateId, {
            metadataMerge: { outcome: 'crash' },
          });
        } catch { /* best-effort */ }
      }
      return 'normal';
    }
  };

  while (!shouldStop() && Date.now() - startedAt < durationMs) {
    stats.cycles++;
    const isRogueCycle = roguePool.length > 0 && stats.cycles % rogueCycleEvery === 0;

    let buyer: SimAgent;
    let seller: SimAgent;

    if (isRogueCycle) {
      // Coin-flip: rogue is either the buyer (disputer) or seller (spammer).
      const rogueAsBuyer = Math.random() < 0.5;
      if (rogueAsBuyer) {
        buyer = pick(roguePool);
        seller = pick(honestPool.filter((a) => a.agentId !== buyer.agentId));
      } else {
        seller = pick(roguePool);
        buyer = pick(honestPool.filter((a) => a.agentId !== seller.agentId));
      }
      if (!seller || !buyer) {
        // Pool too small after exclusion — fall back to a normal cycle
        buyer = pick(honestPool);
        seller = pick(honestPool.filter((a) => a.agentId !== buyer.agentId));
      }
    } else {
      buyer = pick(honestPool);
      seller = pick(honestPool.filter((a) => a.agentId !== buyer.agentId));
    }

    // ─── Reputation check (always) + pricing adaptation (only when dynamic) ───
    if (!dryRun) {
      const repChecks = await Promise.all([
        agentState.checkReputation(buyer.agentId, stats.cycles),
        agentState.checkReputation(seller.agentId, stats.cycles),
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
      // Adapt pricing for the seller (only when dynamic pricing is on)
      if (isDynamicPricing) {
        const events = await agentState.adaptPricing(seller.agentId, stats.cycles);
        for (const ev of events) {
          await adminClient.comment(`💰 ${seller.name} ${ev.action} (${ev.reason})`, 'finding');
        }
      }
    }

    const outcome = await runTrade(buyer, seller, isRogueCycle);
    stats[outcome]++;

    if (!firstTradeAnnounced && (outcome === 'normal' || outcome === 'rogueDefeated') && completedTrades > 0 && !dryRun) {
      await adminClient.milestone(
        `First REAL settlement: ${buyer.name} \u2192 ${seller.name} ($${config.pricePerCycle.toFixed(2)} via public AP2)`,
        { agentId: seller.agentId, agentName: seller.name, icon: '\u272e' },
      );
      firstTradeAnnounced = true;
    }

    if (stats.cycles % 5 === 0 && !dryRun) {
      await adminClient.comment(
        `After ${stats.cycles} cycles: ${completedTrades} settled, $${totalVolume.toFixed(2)} volume · rogue: ${stats.rogueRejected}rej/${stats.rogueSucceeded}suc/${stats.rogueBlockedByPlatform}blk/${stats.rogueDisputes}dsp/${stats.rogueDefeated}dft`,
        'finding',
      );
    }

    if (dryRun) break;
    await new Promise((r) => setTimeout(r, cycleSleepMs * (0.8 + Math.random() * 0.4)));
  }

  if (!dryRun) {
    const containmentTotal =
      stats.rogueRejected + stats.rogueBlockedByPlatform + stats.rogueSucceeded + stats.rogueDisputes;
    const containmentWins = stats.rogueRejected + stats.rogueBlockedByPlatform;
    const containmentRate = containmentTotal > 0 ? (containmentWins / containmentTotal) * 100 : 0;

    await adminClient.comment(
      `one_to_one complete: ${stats.cycles} cycles, ${completedTrades} settled, $${totalVolume.toFixed(2)} volume`,
      'governance',
    );
    if (containmentTotal > 0) {
      await adminClient.comment(
        `Rogue containment: ${containmentRate.toFixed(0)}% (${containmentWins}/${containmentTotal})`,
        'finding',
      );
    }
    const usage = processor.getTotalUsage();
    if ((usage.costUsd ?? 0) > 0) {
      await adminClient.comment(
        `LLM cost: $${usage.costUsd?.toFixed(4)} (${usage.inputTokens}in/${usage.outputTokens}out)`,
        'governance',
      );
    }
    if ((usage.costUsd ?? 0) > 0) findings.push(`LLM cost: $${usage.costUsd?.toFixed(4)}`);

    findings.push(`${stats.cycles} cycles · ${completedTrades} settled trades`);
    findings.push(`$${totalVolume.toFixed(2)} settled volume`);
    if (containmentTotal > 0) {
      findings.push(`Rogue containment ${containmentRate.toFixed(0)}% (${containmentWins}/${containmentTotal})`);
      findings.push(
        `Rogue breakdown: ${stats.rogueRejected} rejected · ${stats.rogueBlockedByPlatform} blocked · ${stats.rogueSucceeded} succeeded · ${stats.rogueDisputes} disputed · ${stats.rogueDefeated} defeated`,
      );
    }
  }

  return { completedTrades, totalVolume, findings };
}
