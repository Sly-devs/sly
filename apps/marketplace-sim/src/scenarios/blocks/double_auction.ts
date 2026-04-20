/**
 * double_auction — full marketplace simulation with N buyers and M sellers.
 *
 * Unlike bake_off (one buyer, many sellers compete) or one_to_one (single
 * pair per cycle), the double auction simulates a real marketplace where:
 *
 *   - Multiple buyers post tasks simultaneously each cycle
 *   - Multiple sellers see all open tasks and CHOOSE which to bid on
 *     (based on price, buyer reputation, and task fit)
 *   - Both sides build reputation: buyers get rated on fairness,
 *     sellers get rated on quality
 *   - Prices are dynamic: sellers set their own ask, buyers set budgets
 *   - Agents with negative P&L accumulate losses and may exit
 *   - Repeat relationships emerge from positive bilateral history
 *
 * In baseline mode ("no Sly"): agents are blind to reputation, can't see
 * market data, every trade is with a stranger, no price adaptation.
 * In full mode ("with Sly"): agents see reputation, market data, history,
 * and adapt accordingly.
 *
 * Configuration:
 *   {
 *     buyersPerCycle: 3,       // how many buyers post tasks each cycle
 *     sellersPerTask: 4,       // how many sellers can bid on each task
 *     briefs: [...],           // task descriptions rotated through
 *     basePrice: 2.0,          // starting price for tasks
 *     exitThreshold: -10,      // cumulative P&L at which an agent exits
 *     defaults: { cycleSleepMs, styleFilter }
 *   }
 */

import { createHash } from 'node:crypto';
import { SlyClient, isSuspensionError, isStaleAgentTokenError } from '../../sly-client.js';
import type { TaskContext, SimAgent, PersonaLike } from '../../processors/types.js';
import type { ScenarioContext, ScenarioResult } from '../types.js';
import { filterByStyle, createAgentClient } from '../../agents/registry.js';
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

/** Explain why a candidate was not selected relative to the winner */
function getSelectionReason(
  winner: { breakdown: { skillMatch: number; reputation: number; price: number; exploration: number }; askPrice: number },
  loser: { breakdown: { skillMatch: number; reputation: number; price: number; exploration: number }; askPrice: number },
): string {
  const diffs: string[] = [];
  if (loser.breakdown.reputation < winner.breakdown.reputation - 10)
    diffs.push(`lower reputation (${Math.round(loser.breakdown.reputation)} vs ${Math.round(winner.breakdown.reputation)})`);
  if (loser.breakdown.skillMatch < winner.breakdown.skillMatch - 10)
    diffs.push(`weaker skill match`);
  if (loser.askPrice > winner.askPrice + 0.5)
    diffs.push(`higher price ($${loser.askPrice.toFixed(2)} vs $${winner.askPrice.toFixed(2)})`);
  return diffs.length > 0 ? diffs.join(', ') : 'lower overall score';
}

/** Brief with skill routing — buyers select a skill and only matching sellers bid */
export interface SkillBrief {
  text: string;
  skill_id: string;
}

export interface DoubleAuctionConfig {
  buyersPerCycle: number;
  sellersPerTask: number;
  briefs: (string | SkillBrief)[];
  basePrice: number;
  /** Cumulative loss at which an agent "exits" (stops being selected). Default -10. */
  exitThreshold?: number;
  pricingMode?: 'static' | 'dynamic';
  dynamicPricing?: Partial<DynamicPricingConfig>;
  defaults?: {
    cycleSleepMs?: number;
    styleFilter?: SimAgent['style'][];
  };
  hooks?: Record<string, unknown>;
}

export interface RunDoubleAuctionOptions {
  scenarioId: string;
  config: DoubleAuctionConfig;
  dryRun?: boolean;
}

export async function runDoubleAuction(
  ctx: ScenarioContext,
  opts: RunDoubleAuctionOptions,
): Promise<ScenarioResult> {
  const { narrator, processor, agents, durationMs, params, shouldStop, baseline = false } = ctx;
  const { scenarioId, config, dryRun = false } = opts;
  const baseUrl = process.env.SLY_API_URL!;
  const adminKey = process.env.SLY_PLATFORM_ADMIN_KEY!;

  if (!Array.isArray(config.briefs) || config.briefs.length === 0) {
    throw new Error('double_auction: config.briefs is required and must be non-empty');
  }

  const defaults = config.defaults || {};
  const cycleSleepMs = (params.cycleSleepMs as number) || defaults.cycleSleepMs || 2000;
  const styleFilter = (params.styleFilter as SimAgent['style'][]) || defaults.styleFilter ||
    ['honest', 'quality-reviewer', 'whale', 'mm', 'rogue-disputer', 'rogue-spam'];
  const buyersPerCycle = config.buyersPerCycle || 3;
  const sellersPerTask = config.sellersPerTask || 4;
  const exitThreshold = config.exitThreshold ?? -10;
  const isDynamicPricing = baseline ? false : config.pricingMode === 'dynamic';
  const useReputation = !baseline;

  const adminClient = new SlyClient({ baseUrl, adminKey });
  const clients: Record<string, SlyClient> = {};
  for (const a of agents) {
    clients[a.agentId] = createAgentClient(a, baseUrl, adminKey);
  }

  // Live collusion flagging — re-run the detector after each new rating
  // and emit a milestone the first time an agent trips the heuristics.
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

  const agentState = new AgentStateManager({
    slyClient: adminClient,
    dynamicPricing: isDynamicPricing,
    pricingConfig: config.dynamicPricing,
  });

  const pool = filterByStyle(agents, styleFilter);

  // Load skill IDs per agent for skill-aware matching.
  // Use the dedicated /admin/round/agent/:id endpoint which bypasses pagination.
  await Promise.all(pool.map(async (a) => {
    try {
      const res = await fetch(`${baseUrl}/admin/round/agent/${a.agentId}`, {
        headers: { Authorization: `Bearer ${adminKey}` },
      });
      if (res.ok) {
        const d = await res.json();
        const skills = (d?.data?.skills || []) as Array<{ skill_id: string }>;
        (a as any)._skillIds = skills.map((s) => s.skill_id);
      }
    } catch {}
  }));

  if (pool.length < buyersPerCycle + sellersPerTask) {
    if (!dryRun) {
      await adminClient.comment(
        `Need at least ${buyersPerCycle + sellersPerTask} agents (have ${pool.length}).`,
        'alert',
      );
    }
    return { completedTrades: 0, totalVolume: 0, findings: ['Insufficient pool'] };
  }

  // Initialize base prices for all agents
  for (const a of pool) {
    agentState.setBasePrice(a.agentId, 'default', config.basePrice);
  }

  // Track per-agent P&L for exit logic
  const pnl: Record<string, number> = {};
  const exited: Set<string> = new Set();
  for (const a of pool) pnl[a.agentId] = 0;

  // In baseline mode ("no Sly"), ALL agents should trade without restrictions.
  // Upgrade rogue/newcomer agents to tier 2 so KYA caps don't fire — simulating
  // the absence of an identity verification layer.
  if (baseline && !dryRun) {
    for (const a of pool) {
      if (a.style === 'rogue-disputer' || a.style === 'rogue-spam' || a.style === 'honest') {
        // Best-effort: try to upgrade the agent's KYA tier on the platform
        try {
          await adminClient.updateAgentTier(a.agentId, 2);
        } catch {}
      }
    }
  }

  if (!dryRun) {
    const modeLabel = baseline ? 'BASELINE (no Sly — all protections off)' : 'FULL (with Sly)';
    const features = baseline
      ? 'no reputation, no dynamic pricing, no KYA enforcement, no velocity limits, no escrow holds'
      : 'reputation ON, dynamic pricing ON, KYA enforcement ON, velocity limits ON, escrow protection ON';
    await adminClient.comment(
      `double_auction [${modeLabel}]: ${pool.length} agents · ${buyersPerCycle} buyers/cycle · ${sellersPerTask} sellers/task · basePrice=$${config.basePrice}\n  Features: ${features}`,
      'governance',
    );
  }

  let cycle = 0;
  let completedTrades = 0;
  let totalVolume = 0;
  let briefIdx = 0;
  const findings: string[] = [];
  const startedAt = Date.now();

  while (!shouldStop() && Date.now() - startedAt < durationMs) {
    cycle++;
    // Filter both agents that exited (negative P&L) and agents killed by the kill switch.
    const activePool = pool.filter((a) => !exited.has(a.agentId) && !agentState.isKilled(a.agentId));
    if (activePool.length < buyersPerCycle + 2) {
      if (!dryRun) {
        const killed = agentState.killedCount();
        const killedNote = killed > 0 ? ` (${killed} suspended)` : '';
        await adminClient.comment(`Market collapsed — only ${activePool.length} active agents remain${killedNote}`, 'alert');
      }
      break;
    }

    // ─── Reputation check for all active agents ───
    if (!dryRun && useReputation) {
      await Promise.all(activePool.map((a) => agentState.checkReputation(a.agentId, cycle)));
      if (isDynamicPricing) {
        for (const a of activePool) {
          const events = await agentState.adaptPricing(a.agentId, cycle);
          for (const ev of events) {
            await adminClient.comment(`💰 ${a.name} ${ev.action} (${ev.reason})`, 'finding');
          }
        }
      }
    }

    // ─── 1. Select N buyers for this cycle ───
    const shuffledPool = shuffle(activePool);
    const buyers = shuffledPool.slice(0, buyersPerCycle);
    const sellerPool = shuffledPool.slice(buyersPerCycle);

    if (dryRun) { completedTrades++; break; }

    // Collect all unique skills available in the seller pool for intent generation
    const allPoolSkills = new Set<string>();
    for (const s of sellerPool) {
      for (const sk of ((s as any)._skillIds || [])) allPoolSkills.add(sk);
    }
    const availableSkillsList = [...allPoolSkills];

    // Classify suspended-agent errors so the cycle stops picking killed agents.
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

    // ─── 2. Each buyer forms intent and posts a task ───
    for (const buyer of buyers) {
      // LLM-driven intent: buyer decides what they need based on their persona
      let brief: string;
      let requestedSkill: string | null;
      let intentData: import('../../processors/types.js').BuyerIntent | null = null;
      let acceptanceCriteria: string[] = [];

      if (processor.processAsBuyerIntent && availableSkillsList.length > 0 && !dryRun) {
        try {
          const { intent } = await processor.processAsBuyerIntent(buyer, availableSkillsList);
          intentData = intent;
          brief = intent.brief;
          requestedSkill = intent.skillNeeded;
          acceptanceCriteria = intent.acceptanceCriteria;
        } catch {
          // Fallback to hardcoded briefs
          const rawBrief = config.briefs[briefIdx % config.briefs.length];
          briefIdx++;
          brief = typeof rawBrief === 'string' ? rawBrief : rawBrief.text;
          requestedSkill = typeof rawBrief === 'object' ? rawBrief.skill_id : null;
        }
      } else {
        // Fallback: rotate through template briefs
        const rawBrief = config.briefs[briefIdx % config.briefs.length];
        briefIdx++;
        brief = typeof rawBrief === 'string' ? rawBrief : rawBrief.text;
        requestedSkill = typeof rawBrief === 'object' ? rawBrief.skill_id : null;
      }

      const buyerBudget = intentData?.maxBudget || agentState.getCurrentPrice(buyer.agentId, requestedSkill || 'default', config.basePrice);

      // Skill-aware seller matching. Keep exact-skill matches at the top of
      // the list, but top up to sellersPerTask with the remaining pool so the
      // buyer always has a meaningful shortlist to evaluate (avoids the
      // "only 2 candidates" symptom when a niche skill is requested).
      let eligibleSellers = [...sellerPool];
      if (requestedSkill) {
        const matching = sellerPool.filter((s) => {
          const agentSkills: string[] = (s as any)._skillIds || [];
          return agentSkills.includes(requestedSkill!);
        });
        if (matching.length >= sellersPerTask) {
          eligibleSellers = matching;
        } else {
          // Pad with non-matching sellers (they'll score lower on skillMatch,
          // but the buyer still gets a proper competitive set to choose from).
          const seen = new Set(matching.map((s) => s.agentId));
          const padded = [...matching];
          for (const s of sellerPool) {
            if (padded.length >= Math.max(sellersPerTask, 3)) break;
            if (!seen.has(s.agentId)) {
              padded.push(s);
              seen.add(s.agentId);
            }
          }
          eligibleSellers = padded.length > 0 ? padded : [...sellerPool];
        }
      }

      // ─── 3. Buyer SELECTS a seller using multi-factor ranking ───
      // Formula: (skillMatch * 0.35) + (reputation * 0.35) + (price * 0.15) + (exploration * 0.15)
      // This balances quality (reputation), relevance (skill match), affordability (price),
      // and newcomer discovery (exploration bonus for agents with few trades).
      type ScoredCandidate = {
        seller: SimAgent;
        askPrice: number;
        score: number;
        breakdown: { skillMatch: number; reputation: number; price: number; exploration: number };
      };

      let candidates: ScoredCandidate[];
      if (useReputation) {
        // Collect all ask prices to compute price competitiveness
        const allPrices = eligibleSellers.map((s) =>
          agentState.getCurrentPrice(s.agentId, requestedSkill || 'default', config.basePrice)
        );
        const minPrice = Math.min(...allPrices, config.basePrice);
        const maxPrice = Math.max(...allPrices, config.basePrice);
        const priceRange = Math.max(maxPrice - minPrice, 0.01);

        candidates = eligibleSellers.map((s) => {
          const askPrice = agentState.getCurrentPrice(s.agentId, requestedSkill || 'default', config.basePrice);
          const agentSkills: string[] = (s as any)._skillIds || [];
          const tradeCount = agentState.getTradeCount(s.agentId);
          const rawRep = agentState.getReputationScore(s.agentId);

          // Skill match: exact match = 100, has related skills = 50, nothing = 10
          const skillMatch = requestedSkill && agentSkills.includes(requestedSkill) ? 100
            : agentSkills.length > 0 ? 50
            : 10;

          // Reputation: normalize to 0-100. Agents with < 5 trades start at 50 (neutral)
          const reputation = tradeCount < 5
            ? Math.max(50, rawRep > 0 ? Math.min(rawRep / 10, 100) : 50)
            : rawRep > 0 ? Math.min(rawRep / 10, 100) : 30;

          // Price competitiveness: cheapest = 100, most expensive = 0
          const price = 100 * (1 - (askPrice - minPrice) / priceRange);

          // Exploration bonus: 100 for 0 trades, decays to 0 at 10 trades
          const exploration = Math.max(0, 100 * (1 - tradeCount / 10));

          const total = (skillMatch * 0.35) + (reputation * 0.35) + (price * 0.15) + (exploration * 0.15);
          return { seller: s, askPrice, score: total, breakdown: { skillMatch, reputation, price, exploration } };
        }).sort((a, b) => b.score - a.score);
      } else {
        // Without Sly: blind random selection (no reputation to guide choice)
        candidates = shuffle([...eligibleSellers]).map((s) => ({
          seller: s,
          askPrice: agentState.getCurrentPrice(s.agentId, requestedSkill || 'default', config.basePrice),
          score: 50,
          breakdown: { skillMatch: 50, reputation: 50, price: 50, exploration: 50 },
        }));
      }
      const topCandidates = candidates.slice(0, Math.min(sellersPerTask, candidates.length));
      if (topCandidates.length === 0) continue;

      // Buyer picks the top-ranked seller
      const selected = topCandidates[0];
      const notSelected = topCandidates.slice(1);

      // Build selection log for audit trail
      const selectionLog = {
        candidatesEvaluated: topCandidates.map((c, i) => ({
          agentId: c.seller.agentId,
          name: c.seller.name,
          rank: i + 1,
          scores: c.breakdown,
          total: Math.round(c.score * 10) / 10,
          askPrice: c.askPrice,
          selected: c === selected,
          ...(c !== selected ? { reason: getSelectionReason(selected, c) } : {}),
        })),
        marketplaceSnapshot: { totalAgents: pool.length, agentsWithSkill: eligibleSellers.length, priceRange: [Math.min(...topCandidates.map(c => c.askPrice)), Math.max(...topCandidates.map(c => c.askPrice))] },
      };

      const shortBrief = brief.length > 80 ? brief.slice(0, 77) + '\u2026' : brief;
      const skillLabel = requestedSkill ? ` [${requestedSkill}]` : '';
      const sellerList = topCandidates.map((c) => c.seller.name.replace('sim-', '')).join(', ');
      const { breakdown: wb } = selected;
      const intentReason = intentData?.reasoning ? ` — "${intentData.reasoning}"` : '';
      await adminClient.comment(
        `Cycle ${cycle}: ${buyer.name} needs${skillLabel} ($${buyerBudget.toFixed(2)})${intentReason} — evaluating ${topCandidates.length} sellers — selects ${selected.seller.name} (skill:${Math.round(wb.skillMatch)} rep:${Math.round(wb.reputation)} price:${Math.round(wb.price)} explore:${Math.round(wb.exploration)} = ${Math.round(selected.score)})`,
        'info',
      );

      // ─── 3a. Make the shortlist visible in the graph ───
      // Create ghost tasks for non-selected candidates and immediately cancel
      // them with `outcome: 'not_selected'`. The viewer renders these as grey
      // dashed "considered" edges alongside the live winner edge, so the user
      // can see that the buyer actually evaluated multiple sellers (the
      // selection log is also on the task, but most people look at the graph).
      if (!dryRun && notSelected.length > 0) {
        await Promise.allSettled(
          notSelected.map(async (loser) => {
            try {
              const ghost = await clients[buyer.agentId].createTask({
                agentId: loser.seller.agentId,
                message: {
                  role: 'user',
                  parts: [{ type: 'text', text: `[shortlist preview] ${brief.slice(0, 120)}` }],
                  metadata: {
                    simRound: scenarioId,
                    cycle,
                    considered: true,
                    outcome: 'not_selected',
                    skillId: requestedSkill || 'general',
                    reason: getSelectionReason(selected, loser),
                    score: Math.round(loser.score * 10) / 10,
                    rank: topCandidates.indexOf(loser) + 1,
                  },
                },
              });
              // Cancel immediately — no work, no mandate, no escrow
              try { await clients[buyer.agentId].cancelTask(ghost.id, { reason: 'not_selected' }); } catch {}
            } catch { /* best-effort; don't block the cycle if one ghost fails */ }
          })
        );
      }

      // ─── 4. Create task + escrow for the selected seller only ───
      let taskId: string | null = null;
      let mandateId: string | null = null;
      let tradeCompleted = false;

      try {
        const created = await clients[buyer.agentId].createTask({
          agentId: selected.seller.agentId,
          message: {
            role: 'user',
            parts: [{ type: 'text', text: brief }],
            metadata: {
              simRound: scenarioId,
              cycle,
              buyerStyle: buyer.style,
              sellerStyle: selected.seller.style,
              externallyManaged: true,
              askPrice: selected.askPrice,
              buyerBudget: buyerBudget,
              skillId: requestedSkill || 'general',
              intent: intentData ? {
                skillNeeded: intentData.skillNeeded,
                brief: intentData.brief,
                acceptanceCriteria: intentData.acceptanceCriteria,
                maxBudget: intentData.maxBudget,
                reasoning: intentData.reasoning,
              } : undefined,
              selectionLog,
            },
          },
        });
        taskId = created.id;

        try { await clients[selected.seller.agentId].claimTask(taskId); } catch (e) { handleSuspension(e, selected.seller); }

        // Create escrow (mandate) for this one trade
        try {
          const mandate = await clients[buyer.agentId].createMandate({
            accountId: buyer.parentAccountId,
            buyerAgentId: buyer.agentId,
            providerAgentId: selected.seller.agentId,
            providerAccountId: selected.seller.parentAccountId,
            amount: selected.askPrice,
            currency: 'USDC',
            a2aSessionId: taskId,
            metadata: { simRound: scenarioId, cycle, source: 'marketplace_sim', askPrice: selected.askPrice, skillId: requestedSkill },
          });
          mandateId = mandate.mandate_id || (mandate as any).mandateId || null;
        } catch {}

        // ─── 5. Selected seller produces the work ───
        const taskCtx: TaskContext = {
          taskId,
          skillId: requestedSkill || undefined,
          requestText: brief,
          amount: selected.askPrice,
          currency: 'USDC',
          buyerName: buyer.name,
          sellerName: selected.seller.name,
        };
        const costContext = useReputation
          ? `\n\n[ECONOMICS] You were selected for this ${requestedSkill || 'general'} task at $${selected.askPrice.toFixed(2)}. ` +
            `The buyer chose you from ${topCandidates.length} candidates based on your reputation and price. ` +
            `Deliver quality work to maintain your reputation and justify your pricing.`
          : '';
        const provPersona: PersonaLike = useReputation
          ? { ...selected.seller, prompt: selected.seller.prompt + agentState.getReputationContext(selected.seller.agentId) + costContext }
          : selected.seller;
        const { decision: provDecision, usage: provUsage } = await processor.processAsProvider(taskCtx, provPersona);
        const inferenceCost = provUsage?.costUsd || 0;

        if (provDecision.action === 'fail' || !provDecision.artifactText) {
          // Seller failed to produce work — cancel mandate
          if (mandateId) {
            try { await clients[buyer.agentId].cancelMandate(mandateId, { metadataMerge: { outcome: 'provider_failed' } }); } catch {}
          }
          await adminClient.comment(`${selected.seller.name} failed to deliver for ${buyer.name}`, 'alert');
        } else {
          try { await clients[selected.seller.agentId].completeTask(taskId, provDecision.artifactText); } catch (e) { handleSuspension(e, selected.seller); }

          // ─── 6. Buyer reviews the delivered work ───
          const buyerPersona: PersonaLike = useReputation
            ? { ...buyer, prompt: buyer.prompt + agentState.getSellerContext(selected.seller.agentId) }
            : buyer;
          const { decision: buyerDecision } = await processor.processAsBuyer(taskCtx, selected.seller, buyerPersona, provDecision.artifactText);

          // Accept or reject
          try {
            await clients[buyer.agentId].respond({
              taskId,
              action: buyerDecision.action === 'dispute' ? 'dispute' : buyerDecision.action,
              score: buyerDecision.score,
              comment: buyerDecision.comment,
              satisfaction: buyerDecision.score >= 80 ? 'excellent' : buyerDecision.score >= 60 ? 'acceptable' : 'partial',
            });
          } catch {}

          // Bidirectional ratings
          try {
            await clients[buyer.agentId].rateTask(taskId, {
              score: buyerDecision.score, comment: buyerDecision.comment,
              satisfaction: buyerDecision.score >= 80 ? 'excellent' : buyerDecision.score >= 60 ? 'acceptable' : 'partial',
              direction: 'buyer_rates_provider',
            });
          } catch {}
          if (buyerDecision.action === 'accept') {
            // Seller rates buyer: fair payment
            try {
              await clients[selected.seller.agentId].rateTask(taskId, {
                score: 85, comment: 'Fair buyer, paid promptly',
                satisfaction: 'excellent', direction: 'provider_rates_buyer',
              });
            } catch {}

            tradeCompleted = true;
            completedTrades++;
            totalVolume += selected.askPrice;
            pnl[selected.seller.agentId] = (pnl[selected.seller.agentId] || 0) + selected.askPrice - inferenceCost;
            pnl[buyer.agentId] = (pnl[buyer.agentId] || 0) - selected.askPrice;

            // Proof of work: hash the artifact + trade details
            const artifactHash = sha256(provDecision.artifactText || '');

            // On-chain attestation via EAS on Base Sepolia (fire-and-forget)
            let easUrl = '';
            try {
              const attestRes = await fetch(`${baseUrl}/admin/round/attest`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  taskId,
                  buyerAgentId: buyer.agentId,
                  sellerAgentId: selected.seller.agentId,
                  skill: requestedSkill || 'general',
                  amount: selected.askPrice,
                  artifactHash,
                  buyerScore: buyerDecision.score,
                  sellerScore: 85, // seller rated buyer
                }),
              });
              if (attestRes.ok) {
                const attestData = await attestRes.json();
                easUrl = attestData?.data?.eascanUrl || '';
              }
            } catch {}

            const easLabel = easUrl ? ` [eas:${easUrl.split('/').pop()?.slice(0, 12)}]` : ` [pow:${artifactHash.slice(0, 12)}]`;
            await adminClient.comment(
              `${buyer.name} → ${selected.seller.name}: score ${buyerDecision.score}${skillLabel} @ $${selected.askPrice.toFixed(2)} (net: $${(selected.askPrice - inferenceCost).toFixed(3)})${easLabel}`,
              'finding',
            );

            // Live collusion check — both parties just got a rating.
            // Fire-and-forget so we never delay the next cycle.
            void maybeFlagCollusion(selected.seller.agentId, selected.seller.name);
            void maybeFlagCollusion(buyer.agentId, buyer.name);
          } else {
            // Seller rates buyer: harsh/unfair rejection
            try {
              await clients[selected.seller.agentId].rateTask(taskId, {
                score: buyerDecision.action === 'dispute' ? 20 : 40,
                comment: buyerDecision.action === 'dispute' ? 'Buyer disputed — lost escrow and work' : 'Buyer rejected completed work',
                satisfaction: 'unacceptable', direction: 'provider_rates_buyer',
              });
            } catch {}

            // Rejected — cancel mandate, buyer keeps money
            if (mandateId) {
              try { await clients[buyer.agentId].cancelMandate(mandateId, { metadataMerge: { outcome: 'quality_rejected' } }); } catch {}
            }
            pnl[selected.seller.agentId] = (pnl[selected.seller.agentId] || 0) - inferenceCost;
            await adminClient.comment(
              `${buyer.name} rejected ${selected.seller.name}: score ${buyerDecision.score} — "${(buyerDecision.comment || '').slice(0, 60)}"`,
              'alert',
            );

            // Both parties still got ratings (seller rated buyer harshly,
            // buyer rated seller in the /respond call above). Re-check.
            void maybeFlagCollusion(selected.seller.agentId, selected.seller.name);
            void maybeFlagCollusion(buyer.agentId, buyer.name);
          }
        }

        agentState.recordOutcome(selected.seller.agentId, requestedSkill || 'default', tradeCompleted, tradeCompleted ? 80 : 30);

        // Feedback for non-selected sellers: tell them WHY they lost so they can adapt.
        // This is the marketplace's value — transparent selection signals.
        for (let ci = 0; ci < notSelected.length; ci++) {
          const c = notSelected[ci];
          const selectedRep = agentState.getReputationScore(selected.seller.agentId);
          const theirRep = agentState.getReputationScore(c.seller.agentId);
          const priceDiff = c.askPrice - selected.askPrice;

          let reason: string;
          if (theirRep < selectedRep && priceDiff > 0) {
            reason = `Lower reputation (${theirRep} vs ${selectedRep}) and higher price ($${c.askPrice.toFixed(2)} vs $${selected.askPrice.toFixed(2)})`;
          } else if (theirRep < selectedRep) {
            reason = `Lower reputation score (${theirRep} vs winner's ${selectedRep})`;
          } else if (priceDiff > 0.5) {
            reason = `Price too high ($${c.askPrice.toFixed(2)} vs winner's $${selected.askPrice.toFixed(2)})`;
          } else {
            reason = `Ranked #${ci + 2} of ${topCandidates.length} — winner had better value ratio`;
          }

          // Inject the feedback into the seller's state so their LLM can adapt
          agentState.recordOutcome(c.seller.agentId, requestedSkill || 'default', false, 0);
          agentState.addAdaptationNote(c.seller.agentId, `Not selected for ${requestedSkill || 'task'}: ${reason}`);
        }
      } catch (e: any) {
        // If the crash was a suspended-agent error, mark the seller (most
        // likely target) as killed so we stop selecting them.
        if (selected?.seller) handleSuspension(e, selected.seller);
        else handleSuspension(e, buyer);
        if (mandateId) {
          try { await clients[buyer.agentId].cancelMandate(mandateId, { metadataMerge: { outcome: 'crash' } }); } catch {}
        }
      }
    }

    // ─── 7. Check for agent exits ───
    for (const a of activePool) {
      if (!exited.has(a.agentId) && (pnl[a.agentId] || 0) <= exitThreshold) {
        exited.add(a.agentId);
        if (!dryRun) {
          await adminClient.comment(
            `🚪 ${a.name} exited the marketplace (P&L: $${(pnl[a.agentId] || 0).toFixed(2)})`,
            'alert',
          );
        }
      }
    }

    // Periodic summary
    if (cycle % 5 === 0 && !dryRun) {
      await adminClient.comment(
        `After ${cycle} cycles: ${completedTrades} trades, $${totalVolume.toFixed(2)} volume, ${exited.size} exits, ${activePool.length - exited.size} active`,
        'finding',
      );
    }

    await new Promise((r) => setTimeout(r, cycleSleepMs * (0.8 + Math.random() * 0.4)));
  }

  if (!dryRun) {
    const modeLabel = baseline ? 'BASELINE' : 'WITH SLY';
    await adminClient.comment(
      `double_auction [${modeLabel}] complete: ${cycle} cycles, ${completedTrades} trades, $${totalVolume.toFixed(2)} volume, ${exited.size} exits`,
      'governance',
    );
    const usage = processor.getTotalUsage();
    if ((usage.costUsd ?? 0) > 0) {
      await adminClient.comment(
        `LLM cost: $${usage.costUsd?.toFixed(4)} (${usage.inputTokens}in/${usage.outputTokens}out)`,
        'governance',
      );
      findings.push(`LLM cost: $${usage.costUsd?.toFixed(4)}`);
    }

    findings.push(`${cycle} cycles · ${completedTrades} trades · $${totalVolume.toFixed(2)} volume`);
    findings.push(`${exited.size} agents exited (P&L below $${exitThreshold})`);
    findings.push(`${pool.length - exited.size} agents survived`);

    // P&L leaderboard
    const sorted = Object.entries(pnl)
      .filter(([id]) => !exited.has(id))
      .sort((a, b) => b[1] - a[1]);
    const topEarner = sorted[0];
    const bottomEarner = sorted[sorted.length - 1];
    if (topEarner) {
      const name = pool.find((a) => a.agentId === topEarner[0])?.name || topEarner[0].slice(0, 8);
      findings.push(`Top earner: ${name} at $${topEarner[1].toFixed(2)}`);
    }
    if (bottomEarner) {
      const name = pool.find((a) => a.agentId === bottomEarner[0])?.name || bottomEarner[0].slice(0, 8);
      findings.push(`Bottom earner: ${name} at $${bottomEarner[1].toFixed(2)}`);
    }
  }

  return { completedTrades, totalVolume, findings };
}
