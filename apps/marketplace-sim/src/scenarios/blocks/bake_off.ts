/**
 * bake_off — generic competitive review building block.
 *
 * Each cycle:
 *   1. Pick a buyer from buyerPool.
 *   2. Pick N sellers from providerPool (where N = config.sellersPerCycle).
 *   3. All sellers in parallel: createTask, claimTask, createMandate, LLM
 *      provider, completeTask. (Each seller has its own bearer token, so
 *      Promise.all is safe and a 5-bidder cycle drops from ~80s to ~16s.)
 *   4. Buyer LLM reviews each artifact in parallel and emits a score+action.
 *   5. Winner = highest-scored 'accept'. All other accepts are tagged outbid
 *      and rejected with metadata.outcome='outbid' so the report can subtract
 *      them from the failure count.
 *   6. Defensive cancelMandate for every non-winner — catches the production
 *      /respond mandate-strand bug.
 *
 * Configuration shape (everything except `skills` is optional with defaults):
 *
 *   {
 *     skills: [{ id, price, briefs: [string, ...] }, ...],   // required
 *     defaults: {
 *       sellersPerCycle: 3,
 *       cycleSleepMs: 1500,
 *       styleFilter: ['honest', 'quality-reviewer'],
 *     },
 *     hooks: {
 *       // not used yet — Phase D will add: priceUpdateOnWin, perAgentState,
 *       // afterCycleHooks, etc. The shape is open so we can grow without a
 *       // breaking change.
 *     }
 *   }
 *
 * The block reads `ctx.params.sellersPerCycle`, `ctx.params.cycleSleepMs`,
 * `ctx.params.styleFilter` at runtime — these come from the markdown's
 * `## Knobs` section via the param schema.
 */

import { createHash } from 'node:crypto';
import { SlyClient } from '../../sly-client.js';
import type { TaskContext, SimAgent, PersonaLike } from '../../processors/types.js';
import type { ScenarioContext, ScenarioResult } from '../types.js';
import { filterByStyle, createAgentClient } from '../../agents/registry.js';
import { isSuspensionError, isStaleAgentTokenError } from '../../sly-client.js';
import { AgentStateManager, type DynamicPricingConfig } from '../../agents/agent-state.js';

function sha256(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function shuffle<T>(arr: T[]): T[] {
  return [...arr].sort(() => Math.random() - 0.5);
}

export interface BakeOffSkill {
  id: string;
  price: number;
  briefs: string[];
  /**
   * Optional ± variance applied to `price` per bid (sellers in the same cycle
   * end up with slightly different prices). Drives the reverse-auction
   * "lowest qualified bid wins" mode. Default 0 = every seller bids `price`.
   */
  priceVariance?: number;
}

export interface BakeOffConfig {
  skills: BakeOffSkill[];
  defaults?: {
    sellersPerCycle?: number;
    cycleSleepMs?: number;
    /**
     * Single style filter applied to BOTH buyer and seller pools when no
     * separate buyer/seller filters are provided. Kept for backwards compat
     * with older templates (competitive_review_real).
     */
    styleFilter?: SimAgent['style'][];
    /** When set, takes precedence over styleFilter for the buyer pool. */
    buyerStyleFilter?: SimAgent['style'][];
    /** When set, takes precedence over styleFilter for the seller pool. */
    sellerStyleFilter?: SimAgent['style'][];
  };
  /**
   * How the buyer picks the winner from the pool of accepted bids.
   *   - 'highest_score' (default): the LLM judge's structured rubric wins.
   *     Used by competitive_review_real.
   *   - 'lowest_price': the cheapest accepted bid wins. Used by reverse-auction
   *     scenarios. Sellers should declare a `priceVariance` so prices differ.
   */
  auctionMode?: 'highest_score' | 'lowest_price';
  /**
   * Pricing mode: 'static' (default) = fixed prices from skill config.
   * 'dynamic' = agents adjust prices based on reputation + win rate each cycle.
   */
  pricingMode?: 'static' | 'dynamic';
  /** Dynamic pricing tuning. Only used when pricingMode = 'dynamic'. */
  dynamicPricing?: Partial<DynamicPricingConfig>;
  /** Open-ended hooks slot. */
  hooks?: Record<string, unknown>;
}

export interface RunBakeOffOptions {
  /** Identifier propagated to task metadata + the narrator */
  scenarioId: string;
  config: BakeOffConfig;
  /**
   * Dry-run mode for compile-time validation: skip every network call,
   * skip the LLM, and bail after one cycle. Used by Phase B's compiler.
   */
  dryRun?: boolean;
}

/**
 * Run the bake-off engine inside a scenario's run() function.
 * Returns the same shape as `ScenarioResult` so the caller just `return`s it.
 */
export async function runBakeOff(
  ctx: ScenarioContext,
  opts: RunBakeOffOptions,
): Promise<ScenarioResult> {
  const { narrator, processor, agents, durationMs, params, shouldStop, baseline = false } = ctx;
  const { scenarioId, config, dryRun = false } = opts;
  const baseUrl = process.env.SLY_API_URL!;
  const adminKey = process.env.SLY_PLATFORM_ADMIN_KEY!;

  if (!Array.isArray(config.skills) || config.skills.length === 0) {
    throw new Error('bake_off: config.skills is required and must be non-empty');
  }

  // Resolve per-run knobs (already validated/clamped by the runner against ParamSpec).
  const defaults = config.defaults || {};
  const sellersPerCycle = (params.sellersPerCycle as number) || defaults.sellersPerCycle || 3;
  const cycleSleepMs = (params.cycleSleepMs as number) || defaults.cycleSleepMs || 1500;
  const styleFilter =
    (params.styleFilter as SimAgent['style'][]) || defaults.styleFilter || ['honest', 'quality-reviewer'];
  // Separate buyer/seller filters take precedence when present, otherwise
  // both pools fall back to the unified styleFilter (legacy behavior).
  const buyerStyleFilter =
    (params.buyerStyleFilter as SimAgent['style'][]) || defaults.buyerStyleFilter || styleFilter;
  const sellerStyleFilter =
    (params.sellerStyleFilter as SimAgent['style'][]) || defaults.sellerStyleFilter || styleFilter;
  const auctionMode: 'highest_score' | 'lowest_price' = config.auctionMode || 'highest_score';
  // In baseline mode, ALL infrastructure features are disabled regardless of config
  const isDynamicPricing = baseline ? false : config.pricingMode === 'dynamic';
  const useReputation = !baseline; // reputation checks + context injection

  // Per-agent client (prefers Ed25519 key-pair auth when available, falls back to bearer token).
  const adminClient = new SlyClient({ baseUrl, adminKey });
  const clients: Record<string, SlyClient> = {};
  for (const a of agents) {
    clients[a.agentId] = createAgentClient(a, baseUrl, adminKey);
  }

  // Live collusion flagging — re-run the detector after each new rating
  // and emit a milestone the first time an agent trips the heuristics.
  // Per-run state so repeat runs get fresh flags; the Set is scoped to
  // this invocation of runBakeOff.
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
    } catch { /* best-effort — never block a cycle on this */ }
  };

  // Agent state manager — tracks reputation, win rates, prices per agent
  const agentState = new AgentStateManager({
    slyClient: adminClient,
    dynamicPricing: isDynamicPricing,
    pricingConfig: config.dynamicPricing,
  });
  // Initialize base prices for all agents across all skills
  for (const a of agents) {
    for (const skill of config.skills) {
      agentState.setBasePrice(a.agentId, skill.id, skill.price);
    }
  }

  if (!dryRun) {
    const stylesNote = buyerStyleFilter === sellerStyleFilter
      ? `styles=${styleFilter.join(',')}`
      : `buyers=[${buyerStyleFilter.join(',')}] sellers=[${sellerStyleFilter.join(',')}]`;
    const pricingNote = isDynamicPricing ? ' · pricing=DYNAMIC' : '';
    await adminClient.comment(
      `bake_off: pool of ${agents.length} agents · sellersPerCycle=${sellersPerCycle} · cycleSleep=${cycleSleepMs}ms · ${stylesNote} · auction=${auctionMode}${pricingNote}`,
      'governance',
    );
    await adminClient.comment(
      `Pool: ${agents.map((a) => `${a.name}(${a.style.slice(0, 4)})`).join(', ')}`,
      'info',
    );
  }

  // Buyer and seller pools resolved from their respective filters. With the
  // legacy single-filter config they end up identical.
  const providerPool = filterByStyle(agents, sellerStyleFilter);
  const buyerPool = filterByStyle(agents, buyerStyleFilter);

  if (providerPool.length < 2 || buyerPool.length < 1) {
    if (!dryRun) {
      await adminClient.comment(
        `Need at least 2 providers and 1 buyer in the pool (have ${providerPool.length}/${buyerPool.length}).`,
        'alert',
      );
    }
    return { completedTrades: 0, totalVolume: 0, findings: ['Insufficient pool'] };
  }

  const startedAt = Date.now();
  let cycle = 0;
  let completedTrades = 0;
  let totalVolume = 0;
  let firstTradeAnnounced = false;
  const findings: string[] = [];
  // Margin tracking: winner.score - runnerUp.score per cycle
  const margins: number[] = [];
  let tieCount = 0;

  // Classify suspended-agent errors and skip killed agents on future picks.
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

  while (!shouldStop() && Date.now() - startedAt < durationMs) {
    cycle++;
    // Filter killed agents out of the pools each cycle so nothing re-selects a dead agent.
    const activeBuyers = agentState.activeAgents(buyerPool);
    const activeProviders = agentState.activeAgents(providerPool);
    if (activeBuyers.length === 0 || activeProviders.length < 1) {
      if (!dryRun) {
        await adminClient.comment(
          `bake_off: insufficient active agents (buyers=${activeBuyers.length}, providers=${activeProviders.length}), ending round`,
          'alert',
        );
      }
      break;
    }
    const buyer = pick(activeBuyers);
    let sellerCandidates = activeProviders.filter((p) => p.agentId !== buyer.agentId);
    // When reputation is active, prefer higher-reputation sellers by sorting
    // by reputation score (descending). Baseline mode: pure random selection.
    if (useReputation && isDynamicPricing) {
      sellerCandidates = [...sellerCandidates].sort((a, b) => {
        const repA = agentState.getReputationScore(a.agentId);
        const repB = agentState.getReputationScore(b.agentId);
        return repB - repA; // higher reputation first
      });
    } else {
      sellerCandidates = shuffle(sellerCandidates);
    }
    const sellers = sellerCandidates.slice(0, Math.min(sellersPerCycle, sellerCandidates.length));
    const skill = pick(config.skills);
    const brief = pick(skill.briefs);

    // ─── Reputation check + pricing adaptation ───
    // Baseline mode: skip entirely (no infrastructure = blind market).
    // Full mode: always check reputation, adapt pricing only when dynamic.
    if (!dryRun && useReputation) {
      // Check reputation for all participants (rate-limited internally)
      const repChecks = await Promise.all([
        agentState.checkReputation(buyer.agentId, cycle),
        ...sellers.map((s) => agentState.checkReputation(s.agentId, cycle)),
      ]);
      // Emit reputation change events
      const allParticipants = [buyer, ...sellers];
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
      // Adapt pricing for sellers (only when dynamic pricing is on)
      if (isDynamicPricing) {
        for (const s of sellers) {
          const events = await agentState.adaptPricing(s.agentId, cycle);
          for (const ev of events) {
            await adminClient.comment(`💰 ${s.name} ${ev.action} (${ev.reason})`, 'finding');
          }
        }
      }
    }

    const shortBrief = brief.length > 80 ? brief.slice(0, 77) + '\u2026' : brief;
    if (!dryRun) {
      await adminClient.comment(
        `Cycle ${cycle}: ${buyer.name} requests "${skill.id}" from ${sellers.length} seller(s) — "${shortBrief}"`,
        'info',
      );
    }

    type Bid = {
      seller: SimAgent;
      taskId: string | null;
      mandateId: string | null;
      artifact: string;
      bidPrice: number;
      failed: boolean;
      failReason?: string;
    };
    const bids: Bid[] = [];

    // ─── 1. createTask + claim + mandate per seller (parallel via Promise.all)
    const placeBid = async (seller: SimAgent): Promise<Bid> => {
      let taskId: string | null = null;
      let mandateId: string | null = null;
      // Per-bid price: start from the agent's current price (which may have been
      // adjusted by dynamic pricing), then apply priceVariance jitter if present.
      const agentBasePrice = agentState.getCurrentPrice(seller.agentId, skill.id, skill.price);
      const variance = skill.priceVariance ?? 0;
      const bidPrice = variance > 0
        ? Math.max(0.01, agentBasePrice + (Math.random() * 2 - 1) * variance)
        : agentBasePrice;
      try {
        if (dryRun) {
          // Skip every network call but still go through the shape so the
          // compiler validator catches missing fields / null derefs.
          taskId = 'dryrun-task';
          mandateId = 'dryrun-mandate';
          return { seller, taskId, mandateId, artifact: 'dryrun artifact', bidPrice, failed: false };
        }

        const created = await clients[buyer.agentId].createTask({
          agentId: seller.agentId,
          message: {
            role: 'user',
            parts: [{ type: 'text', text: brief }],
            metadata: {
              skillId: skill.id,
              simRound: scenarioId,
              cycle,
              buyerStyle: buyer.style,
              sellerStyle: seller.style,
              externallyManaged: true,
            },
          },
        });
        taskId = created.id;

        try {
          await clients[seller.agentId].claimTask(taskId);
        } catch (e: any) {
          if (!handleSuspension(e, seller)) {
            await adminClient.comment(
              `${seller.name} could not claim task: ${e.message}`,
              'alert',
            );
          }
          return { seller, taskId, mandateId: null, artifact: '', bidPrice, failed: true, failReason: `claim failed: ${e.message}` };
        }

        try {
          const mandate = await clients[buyer.agentId].createMandate({
            accountId: buyer.parentAccountId,
            buyerAgentId: buyer.agentId,
            providerAgentId: seller.agentId,
            providerAccountId: seller.parentAccountId,
            amount: bidPrice,
            currency: 'USDC',
            a2aSessionId: taskId,
            metadata: { simRound: scenarioId, cycle, skillId: skill.id, source: 'marketplace_sim', bidPrice },
          });
          mandateId = mandate.mandate_id || (mandate as any).mandateId || null;
        } catch (e: any) {
          if (!handleSuspension(e, buyer) && !handleSuspension(e, seller)) {
            await adminClient.comment(
              `${buyer.name} could not escrow funds for ${seller.name}: ${e.message}`,
              'alert',
            );
          }
          return { seller, taskId, mandateId: null, artifact: '', bidPrice, failed: true, failReason: `mandate creation failed: ${e.message}` };
        }

        const taskCtx: TaskContext = {
          taskId,
          skillId: skill.id,
          requestText: brief,
          amount: bidPrice,
          currency: 'USDC',
          buyerName: buyer.name,
          sellerName: seller.name,
        };
        // Inject reputation context (full mode only — baseline agents are blind)
        const provPersona: PersonaLike = useReputation
          ? { ...seller, prompt: seller.prompt + agentState.getReputationContext(seller.agentId) }
          : seller;
        const { decision: provDecision } = await processor.processAsProvider(taskCtx, provPersona);

        if (provDecision.action === 'fail' || !provDecision.artifactText) {
          try {
            if (mandateId) await clients[buyer.agentId].cancelMandate(mandateId, {
              metadataMerge: { outcome: 'provider_failed' },
            });
          } catch { /* best-effort */ }
          await adminClient.comment(
            `${seller.name} FAILED to deliver (${provDecision.failureReason || 'no artifact'})`,
            'alert',
          );
          return { seller, taskId, mandateId, artifact: '', bidPrice, failed: true, failReason: provDecision.failureReason };
        }

        try {
          await clients[seller.agentId].completeTask(taskId, provDecision.artifactText);
        } catch (e: any) {
          if (!handleSuspension(e, seller)) {
            await adminClient.comment(
              `${seller.name}'s complete() rejected by platform: ${e.message}`,
              'alert',
            );
          }
          return { seller, taskId, mandateId, artifact: '', bidPrice, failed: true, failReason: `complete failed: ${e.message}` };
        }

        const priceNote = variance > 0 ? ` @ $${bidPrice.toFixed(2)}` : '';
        const modelNote = seller.style ? ` [${seller.style}]` : '';
        await adminClient.comment(
          `${seller.name}${modelNote} delivered (${provDecision.artifactText.length} chars)${priceNote}`,
          'info',
        );
        return { seller, taskId, mandateId, artifact: provDecision.artifactText, bidPrice, failed: false };
      } catch (e: any) {
        const classified = handleSuspension(e, seller) || handleSuspension(e, buyer);
        if (!classified && !dryRun) {
          await adminClient.comment(`Trade ${buyer.name}\u2192${seller.name} crashed: ${e.message}`, 'alert');
        }
        return { seller, taskId, mandateId, artifact: '', bidPrice, failed: true, failReason: e.message };
      }
    };

    const settled = await Promise.all(sellers.map((s) => placeBid(s)));
    bids.push(...settled);
    // NOTE: no shouldStop() check here — once bids are placed, the cycle MUST
    // complete (review + settle + cancel losers) to avoid stranded mandates.
    // shouldStop() is checked at the top of the while loop before the NEXT cycle.

    // ─── 2. Buyer LLM reviews each delivered artifact in parallel.
    type Review = {
      seller: SimAgent;
      score: number;
      bidPrice: number;
      action: 'accept' | 'reject' | 'dispute';
      comment?: string;
      taskId: string | null;
      mandateId: string | null;
      artifact: string;
    };

    const reviews: Review[] = await Promise.all(
      bids.map(async (bid): Promise<Review> => {
        if (bid.failed || !bid.taskId) {
          return { seller: bid.seller, score: 0, bidPrice: bid.bidPrice, action: 'reject', taskId: bid.taskId, mandateId: bid.mandateId, artifact: '' };
        }
        if (dryRun) {
          return { seller: bid.seller, score: 88, bidPrice: bid.bidPrice, action: 'accept', taskId: bid.taskId, mandateId: bid.mandateId, artifact: bid.artifact };
        }
        const taskCtx: TaskContext = {
          taskId: bid.taskId,
          skillId: skill.id,
          requestText: brief,
          amount: bid.bidPrice,
          currency: 'USDC',
          buyerName: buyer.name,
          sellerName: bid.seller.name,
        };
        // Inject seller reputation into buyer evaluation (full mode only)
        const buyerPersona: PersonaLike = useReputation
          ? { ...buyer, prompt: buyer.prompt + agentState.getSellerContext(bid.seller.agentId) }
          : buyer;
        const { decision: buyerDecision } = await processor.processAsBuyer(taskCtx, bid.seller, buyerPersona, bid.artifact);
        return {
          seller: bid.seller,
          score: buyerDecision.score,
          bidPrice: bid.bidPrice,
          action: buyerDecision.action,
          comment: buyerDecision.comment,
          taskId: bid.taskId,
          mandateId: bid.mandateId,
          artifact: bid.artifact,
        };
      }),
    );

    // ─── 3. Pick the winner.
    //   * highest_score (default): the LLM judge's rubric score wins.
    //   * lowest_price: the cheapest accepted bid wins, breaking ties by score.
    // We require an 'accept' action either way — sub-quality bids don't qualify.
    const acceptable = reviews.filter((r) => r.taskId && r.action === 'accept');
    if (auctionMode === 'lowest_price') {
      acceptable.sort((a, b) => (a.bidPrice - b.bidPrice) || (b.score - a.score));
    } else {
      acceptable.sort((a, b) => b.score - a.score);
    }
    const winner = acceptable[0];

    // ─── 4. Settle each task in parallel via the public /respond endpoint.
    const settleOne = async (review: Review): Promise<void> => {
      if (!review.taskId) return;
      if (dryRun) return;
      const isWinner = winner && review === winner;
      const isOutbid = !isWinner && review.action === 'accept';
      let respondAction: 'accept' | 'reject' | 'dispute';
      let respondComment: string | undefined;

      if (isWinner) {
        respondAction = 'accept';
        respondComment = review.comment;
      } else if (isOutbid) {
        respondAction = 'reject';
        respondComment = 'Outbid — lost bake-off to higher-scored bid';
      } else if (review.action === 'dispute') {
        respondAction = 'dispute';
        respondComment = review.comment || 'Buyer disputed the artifact';
      } else {
        respondAction = 'reject';
        respondComment = review.comment || 'Buyer rejected the artifact';
      }

      try {
        await clients[buyer.agentId].respond({
          taskId: review.taskId,
          action: respondAction,
          score: review.score,
          comment: respondComment,
          satisfaction: review.score >= 80 ? 'excellent' : review.score >= 60 ? 'acceptable' : 'partial',
        });
      } catch (e: any) {
        if (!handleSuspension(e, buyer) && !handleSuspension(e, review.seller)) {
          await adminClient.comment(
            `${buyer.name}'s respond() for ${review.seller.name} was rejected by platform: ${e.message}`,
            'alert',
          );
        }
      }

      // Defensive mandate cancel for any non-winner.
      if (!isWinner && review.mandateId) {
        try {
          await clients[buyer.agentId].cancelMandate(review.mandateId, {
            metadataMerge: {
              outcome: isOutbid ? 'outbid' : (review.action === 'dispute' ? 'disputed' : 'rejected'),
              resolvedAt: new Date().toISOString(),
            },
          });
        } catch { /* best-effort */ }
      }

      // Best-effort rating — buyer rates seller
      try {
        await clients[buyer.agentId].rateTask(review.taskId, {
          score: review.score,
          comment: review.comment,
          satisfaction: review.score >= 80 ? 'excellent' : review.score >= 60 ? 'acceptable' : 'partial',
          direction: 'buyer_rates_provider',
        });
      } catch { /* may fail if task already in terminal state */ }
    };

    await Promise.all(reviews.map(settleOne));

    // ─── 4b. Live collusion check — re-run the detector for every
    // provider that just got a rating. Fire-and-forget; won't block the
    // next cycle. Flagged agents get a milestone event that paints a
    // 🚨 badge on their graph node in the live viewer.
    if (!dryRun) {
      for (const review of reviews) {
        if (review.taskId) {
          void maybeFlagCollusion(review.seller.agentId, review.seller.name);
        }
      }
    }

    // ─── 5. Record outcomes for all participants so AgentState can adapt
    for (const review of reviews) {
      if (review.taskId) {
        agentState.recordOutcome(
          review.seller.agentId,
          skill.id,
          !!(winner && review === winner),
          review.score,
        );
      }
    }

    // ─── 6. Track the margin between winner and runner-up
    if (winner && acceptable.length >= 2) {
      const runnerUp = acceptable[1];
      const margin = auctionMode === 'lowest_price'
        ? runnerUp.bidPrice - winner.bidPrice  // price gap (positive = winner cheaper)
        : winner.score - runnerUp.score;       // score gap (positive = winner scored higher)
      margins.push(margin);
      if (Math.abs(margin) < 2) tieCount++;
    }

    // ─── 6. Announce the outcome — credit the actual winning bid price, not
    // the listed skill.price (matters for reverse-auction templates).
    if (winner) {
      completedTrades++;
      totalVolume += winner.bidPrice;

      // On-chain attestation via EAS on Base Sepolia. Fire-and-forget —
      // server persists the result into a2a_tasks.metadata.attestation so the
      // app can surface the PoW hash + BaseScan link on rating rows.
      if (!dryRun && winner.taskId) {
        const artifactHash = sha256(winner.artifact || '');
        fetch(`${baseUrl}/admin/round/attest`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            taskId: winner.taskId,
            buyerAgentId: buyer.agentId,
            sellerAgentId: winner.seller.agentId,
            skill: skill.id,
            amount: winner.bidPrice,
            artifactHash,
            buyerScore: winner.score,
            sellerScore: 85,
          }),
        }).catch(() => { /* best-effort */ });
      }
      if (!dryRun) {
        const losers = reviews
          .filter((r) => r !== winner)
          .map((l) => {
            const priceTag = (skill.priceVariance ?? 0) > 0 ? `@$${l.bidPrice.toFixed(2)}` : '';
            return `${l.seller.name}=${l.score}/${l.action}${priceTag}`;
          })
          .join(', ');
        const winNote = auctionMode === 'lowest_price'
          ? `${winner.seller.name} won lowest-price at $${winner.bidPrice.toFixed(2)} (score ${winner.score})`
          : `settled ${winner.seller.name} at ${winner.score} for $${winner.bidPrice.toFixed(2)}`;
        await adminClient.comment(
          `${buyer.name} ${winNote}${losers ? ' (others: ' + losers + ')' : ''}`,
          'finding',
        );
        if (!firstTradeAnnounced) {
          await adminClient.milestone(
            `First REAL settlement: ${buyer.name} \u2192 ${winner.seller.name} ($${winner.bidPrice.toFixed(2)} via public AP2)`,
            { agentId: winner.seller.agentId, agentName: winner.seller.name, icon: '\u272e' },
          );
          firstTradeAnnounced = true;
        }
      }
    } else if (!dryRun) {
      await adminClient.comment(`${buyer.name} accepted no bids this cycle`, 'alert');
    }

    if (cycle % 3 === 0 && !dryRun) {
      await adminClient.comment(
        `After ${cycle} cycles: ${completedTrades} trades, $${totalVolume.toFixed(2)} settled volume`,
        'finding',
      );
    }

    // Skill adaptation: every 10 cycles, check if any seller should drop underperforming skills
    if (isDynamicPricing && cycle % 10 === 0 && !dryRun) {
      for (const s of providerPool) {
        const toDrop = agentState.getSkillsToDrop(s.agentId, 10, 0.2);
        for (const d of toDrop) {
          await adminClient.comment(
            `⚡ ${s.name} dropping skill "${d.skillId}" (win rate ${Math.round(d.winRate * 100)}% over ${d.attempts} attempts)`,
            'alert',
          );
          await adminClient.deactivateSkill(s.agentId, d.skillId);
        }
      }
    }

    if (dryRun) break; // one cycle is enough for validation
    await new Promise((r) => setTimeout(r, cycleSleepMs * (0.8 + Math.random() * 0.4)));
  }

  if (!dryRun) {
    await adminClient.comment(
      `bake_off complete: ${cycle} cycles, ${completedTrades} settled trades, $${totalVolume.toFixed(2)} total volume`,
      'governance',
    );
    const usage = processor.getTotalUsage();
    if ((usage.costUsd ?? 0) > 0) {
      await adminClient.comment(
        `LLM cost: $${usage.costUsd?.toFixed(4)} (${usage.inputTokens}in/${usage.outputTokens}out)`,
        'governance',
      );
    }
    findings.push(`${completedTrades} settled trades across ${cycle} cycles`);
    findings.push(`$${totalVolume.toFixed(2)} settled volume`);
    findings.push(`${providerPool.length} providers / ${buyerPool.length} buyers in the pool`);
    if ((usage.costUsd ?? 0) > 0) findings.push(`LLM cost: $${usage.costUsd?.toFixed(4)}`);
    // Margin diagnostics
    if (margins.length > 0) {
      const avgMargin = margins.reduce((a, b) => a + b, 0) / margins.length;
      const marginLabel = auctionMode === 'lowest_price' ? 'price' : 'score';
      findings.push(`Avg ${marginLabel} margin: ${avgMargin.toFixed(1)} (${margins.length} contested cycles, ${tieCount} ties)`);
      await adminClient.comment(
        `Rubric margin: avg ${avgMargin.toFixed(1)} ${marginLabel} pts · ${tieCount}/${margins.length} ties (margin < 2)`,
        avgMargin < 3 ? 'alert' : 'finding',
      );
    }
  }

  return { completedTrades, totalVolume, findings };
}
