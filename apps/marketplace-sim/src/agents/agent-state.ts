/**
 * AgentState — per-agent mutable state that persists across cycles within a run.
 *
 * Tracks reputation, win rates, current prices, and adaptation decisions.
 * Building blocks query this instead of using static config values, enabling
 * dynamic pricing, reputation-aware behavior, and skill adaptation.
 *
 * Created fresh at the start of each scenario run. Not persisted to DB —
 * it's ephemeral per-run state that resets when the scenario restarts.
 */

import type { SlyClient } from '../sly-client.js';

export interface ReputationSnapshot {
  score: number;      // 0-1000
  tier: string;       // A-F
  confidence: string; // high, medium, low, none
  fetchedAt: number;  // cycle number
}

export interface SkillStats {
  wins: number;
  losses: number;
  totalScore: number;
  attempts: number;
}

export interface AdaptationEvent {
  cycle: number;
  action: string;
  reason: string;
}

export interface DynamicPricingConfig {
  adjustmentRate: number;    // e.g. 0.05 = 5% per adjustment
  minMultiplier: number;     // floor relative to base price (e.g. 0.5)
  maxMultiplier: number;     // ceiling relative to base price (e.g. 1.5)
  checkReputationEvery: number; // cycles between reputation API calls
}

export const DEFAULT_PRICING_CONFIG: DynamicPricingConfig = {
  adjustmentRate: 0.05,
  minMultiplier: 0.5,
  maxMultiplier: 1.5,
  checkReputationEvery: 3,
};

interface AgentRecord {
  reputation: ReputationSnapshot | null;
  skillStats: Record<string, SkillStats>;
  currentPrices: Record<string, number>;
  basePrices: Record<string, number>;
  adaptationLog: AdaptationEvent[];
  lastReputationCycle: number;
}

/**
 * Manages state for all agents in a single run. The building block creates
 * one AgentStateManager at run start and passes it through the cycle loop.
 */
export interface KilledAgentRecord {
  reason: string;       // 'kill_switch' | 'pre_flight' | 'manual'
  at: number;           // Date.now()
}

export class AgentStateManager {
  private agents: Record<string, AgentRecord> = {};
  private slyClient: SlyClient;
  private pricingConfig: DynamicPricingConfig;
  private dynamicPricing: boolean;
  /**
   * Agents we've observed as suspended (kill switch activated) during this run.
   * The scenario blocks use this to filter the active agent pool and stop
   * issuing API calls that would only fail with 403/-32004.
   */
  private killedAgents: Map<string, KilledAgentRecord> = new Map();

  constructor(opts: {
    slyClient: SlyClient;
    dynamicPricing?: boolean;
    pricingConfig?: Partial<DynamicPricingConfig>;
  }) {
    this.slyClient = opts.slyClient;
    this.dynamicPricing = opts.dynamicPricing ?? false;
    this.pricingConfig = { ...DEFAULT_PRICING_CONFIG, ...opts.pricingConfig };
  }

  private ensure(agentId: string): AgentRecord {
    if (!this.agents[agentId]) {
      this.agents[agentId] = {
        reputation: null,
        skillStats: {},
        currentPrices: {},
        basePrices: {},
        adaptationLog: [],
        lastReputationCycle: 0,
      };
    }
    return this.agents[agentId];
  }

  /** Get the cached reputation score for an agent (0 if unknown). */
  getReputationScore(agentId: string): number {
    return this.agents[agentId]?.reputation?.score ?? 0;
  }

  /** Set the base price for a skill (called once at run start from blockConfig). */
  setBasePrice(agentId: string, skillId: string, price: number): void {
    const a = this.ensure(agentId);
    a.basePrices[skillId] = price;
    if (a.currentPrices[skillId] === undefined) {
      a.currentPrices[skillId] = price;
    }
  }

  /** Get the current price for a skill (may differ from base if dynamic pricing is on). */
  getCurrentPrice(agentId: string, skillId: string, fallback: number): number {
    if (!this.dynamicPricing) return fallback;
    const a = this.agents[agentId];
    if (!a || a.currentPrices[skillId] === undefined) return fallback;
    return a.currentPrices[skillId];
  }

  /** Record the outcome of a bake-off or trade for one agent. */
  recordOutcome(agentId: string, skillId: string, won: boolean, score: number): void {
    const a = this.ensure(agentId);
    if (!a.skillStats[skillId]) {
      a.skillStats[skillId] = { wins: 0, losses: 0, totalScore: 0, attempts: 0 };
    }
    const s = a.skillStats[skillId];
    s.attempts++;
    s.totalScore += score;
    if (won) s.wins++;
    else s.losses++;
  }

  /** Get total completed trade count for an agent (used for exploration bonus). */
  getTradeCount(agentId: string): number {
    const a = this.agents[agentId];
    if (!a) return 0;
    return Object.values(a.skillStats).reduce((sum, s) => sum + s.wins, 0);
  }

  /** Add a human-readable note explaining why the agent wasn't selected.
   *  Injected into the agent's context on next task so the LLM can adapt. */
  addAdaptationNote(agentId: string, note: string): void {
    const a = this.ensure(agentId);
    a.adaptationLog.push({ cycle: 0, action: 'not_selected', reason: note });
    // Keep log bounded
    if (a.adaptationLog.length > 20) a.adaptationLog.shift();
  }

  /**
   * Fetch the agent's reputation from the platform. Rate-limited by checkReputationEvery.
   * Returns a change event if the score shifted meaningfully (±50 or tier changed).
   */
  async checkReputation(agentId: string, cycle: number): Promise<{
    snapshot: ReputationSnapshot | null;
    changed?: { from: ReputationSnapshot; to: ReputationSnapshot };
  }> {
    const a = this.ensure(agentId);
    // Skip if we checked recently
    if (a.reputation && cycle - a.lastReputationCycle < this.pricingConfig.checkReputationEvery) {
      return { snapshot: a.reputation };
    }
    try {
      const rep = await this.slyClient.getReputation(agentId);
      if (rep) {
        const prev = a.reputation;
        const next: ReputationSnapshot = {
          score: rep.score ?? 0,
          tier: rep.tier ?? 'F',
          confidence: rep.confidence ?? 'none',
          fetchedAt: cycle,
        };
        a.reputation = next;
        a.lastReputationCycle = cycle;
        // Detect meaningful change
        if (prev && (Math.abs(next.score - prev.score) >= 50 || next.tier !== prev.tier)) {
          return { snapshot: next, changed: { from: prev, to: next } };
        }
      }
      return { snapshot: a.reputation };
    } catch {
      return { snapshot: a.reputation };
    }
  }

  /**
   * Adapt pricing based on recent performance. Called each cycle when
   * dynamicPricing is enabled. Returns a list of price changes for logging.
   * Also writes the new price back to the platform so marketplace discovery
   * reflects the updated price.
   */
  async adaptPricing(agentId: string, cycle: number): Promise<AdaptationEvent[]> {
    if (!this.dynamicPricing) return [];
    const a = this.ensure(agentId);
    const events: AdaptationEvent[] = [];
    const { adjustmentRate, minMultiplier, maxMultiplier } = this.pricingConfig;

    for (const [skillId, stats] of Object.entries(a.skillStats)) {
      if (stats.attempts === 0) continue;
      const base = a.basePrices[skillId];
      if (!base) continue;
      const prev = a.currentPrices[skillId] ?? base;
      const winRate = stats.wins / stats.attempts;

      let newPrice: number;
      if (winRate >= 0.5) {
        // Winning enough — raise price slightly
        newPrice = prev * (1 + adjustmentRate);
      } else {
        // Losing — lower price
        newPrice = prev * (1 - adjustmentRate);
      }

      // Reputation pressure: if score < 500, add downward pressure
      if (a.reputation && a.reputation.score < 500) {
        newPrice *= 0.95; // additional 5% discount for low reputation
      }

      // Clamp to min/max
      newPrice = Math.max(base * minMultiplier, Math.min(base * maxMultiplier, newPrice));
      newPrice = Math.round(newPrice * 100) / 100; // round to cents

      if (newPrice !== prev) {
        a.currentPrices[skillId] = newPrice;
        const direction = newPrice > prev ? 'raised' : 'lowered';
        const reason = `win rate ${Math.round(winRate * 100)}%` +
          (a.reputation ? `, rep ${a.reputation.score}/${a.reputation.tier}` : '');
        const event: AdaptationEvent = {
          cycle,
          action: `${direction} ${skillId}: $${prev.toFixed(2)} → $${newPrice.toFixed(2)}`,
          reason,
        };
        a.adaptationLog.push(event);
        events.push(event);
        // Write back to the platform so marketplace discovery reflects the new price
        this.slyClient.updateSkillPrice(agentId, skillId, newPrice).catch(() => {});
      }
    }
    return events;
  }

  /**
   * Build a reputation context string to inject into the LLM persona prompt.
   * Gives the model awareness of its own standing in the marketplace.
   */
  getReputationContext(agentId: string): string {
    const a = this.agents[agentId];
    if (!a) return '';
    const parts: string[] = [];

    if (a.reputation) {
      const r = a.reputation;
      parts.push(`[YOUR REPUTATION: ${r.score}/1000, Tier ${r.tier}, confidence: ${r.confidence}]`);
      if (r.score < 500) {
        parts.push('Your reputation is LOW. Invest extra effort in quality to recover.');
      } else if (r.score >= 800) {
        parts.push('Your reputation is STRONG. Maintain your quality standard.');
      }
    }

    const skillEntries = Object.entries(a.skillStats).filter(([, s]) => s.attempts > 0);
    if (skillEntries.length > 0) {
      const skillLines = skillEntries.map(([sid, s]) => {
        const wr = Math.round((s.wins / s.attempts) * 100);
        const avg = Math.round(s.totalScore / s.attempts);
        return `  ${sid}: ${s.wins}/${s.attempts} wins (${wr}%), avg score ${avg}`;
      });
      parts.push('Recent performance:\n' + skillLines.join('\n'));
    }

    if (this.dynamicPricing) {
      const priceLines = Object.entries(a.currentPrices)
        .filter(([sid]) => a.basePrices[sid] !== undefined)
        .map(([sid, price]) => {
          const base = a.basePrices[sid];
          const pct = Math.round((price / base) * 100);
          return `  ${sid}: $${price.toFixed(2)} (${pct}% of base $${base.toFixed(2)})`;
        });
      if (priceLines.length > 0) {
        parts.push('Your current prices:\n' + priceLines.join('\n'));
      }
    }

    // Include recent non-selection feedback so the seller can adapt
    const recentNotes = a.adaptationLog
      .filter((e) => e.action === 'not_selected')
      .slice(-3);
    if (recentNotes.length > 0) {
      parts.push('Recent selection feedback (why buyers passed on you):');
      for (const n of recentNotes) {
        parts.push(`  - ${n.reason}`);
      }
      parts.push('Use this feedback to adjust your pricing or improve quality.');
    }

    return parts.length > 0 ? '\n\n' + parts.join('\n') : '';
  }

  /**
   * Build a seller context string for the buyer's evaluation prompt.
   * Tells the buyer about the seller's reputation so it can factor it in.
   */
  getSellerContext(sellerId: string): string {
    const a = this.agents[sellerId];
    if (!a || !a.reputation) return '';
    const r = a.reputation;
    return `\n[SELLER REPUTATION: ${r.score}/1000, Tier ${r.tier}` +
      (r.score < 500 ? ' — LOW reputation, be skeptical of quality claims' : '') +
      (r.score >= 800 ? ' — HIGH reputation, established track record' : '') +
      ']';
  }

  /**
   * Check if an agent should drop underperforming skills.
   * Called after pricing adaptation. Returns skills to drop (if any).
   * The caller is responsible for calling PATCH /v1/agents/:id/skills/:skillId
   * to deactivate the skill on the platform.
   */
  getSkillsToDrop(agentId: string, minAttempts: number = 10, minWinRate: number = 0.2): Array<{ skillId: string; winRate: number; attempts: number }> {
    const a = this.agents[agentId];
    if (!a) return [];
    const toDrop: Array<{ skillId: string; winRate: number; attempts: number }> = [];
    for (const [skillId, stats] of Object.entries(a.skillStats)) {
      if (stats.attempts < minAttempts) continue;
      const winRate = stats.wins / stats.attempts;
      if (winRate < minWinRate) {
        toDrop.push({ skillId, winRate, attempts: stats.attempts });
      }
    }
    return toDrop;
  }

  /** Get the adaptation log for an agent (for findings/reporting). */
  getAdaptationLog(agentId: string): AdaptationEvent[] {
    return this.agents[agentId]?.adaptationLog || [];
  }

  /**
   * Mark an agent as killed (suspended) for the remainder of this run.
   * Idempotent: the second call is a no-op and returns false. The first call
   * returns true so the caller can decide whether to emit a milestone.
   *
   * We also fire-and-forget a milestone to the live viewer so operators can
   * see the kill land in real time (same pattern as collusion flags).
   */
  markKilled(
    agentId: string,
    reason: string,
    opts: { agentName?: string; emitMilestone?: boolean } = {},
  ): boolean {
    if (this.killedAgents.has(agentId)) return false;
    this.killedAgents.set(agentId, { reason, at: Date.now() });
    if (opts.emitMilestone !== false) {
      const name = opts.agentName || agentId.slice(0, 8);
      const text = reason === 'pre_flight'
        ? `Pre-flight: ${name} already suspended, excluding from run`
        : `KILL SWITCH: ${name} suspended (${reason})`;
      this.slyClient
        .milestone(text, { agentId, agentName: opts.agentName, icon: '\u26a1' })
        .catch(() => {});
    }
    return true;
  }

  /** True if the agent has been marked killed during this run. */
  isKilled(agentId: string): boolean {
    return this.killedAgents.has(agentId);
  }

  /** Filter a pool down to agents that are still alive (not killed this run). */
  activeAgents<T extends { agentId: string }>(pool: T[]): T[] {
    if (this.killedAgents.size === 0) return pool;
    return pool.filter((a) => !this.killedAgents.has(a.agentId));
  }

  /** Count of agents killed during this run (for reporting). */
  killedCount(): number {
    return this.killedAgents.size;
  }

  /** Get all agents' state summary for reporting. */
  getSummary(): Record<string, {
    reputation: ReputationSnapshot | null;
    skillStats: Record<string, SkillStats>;
    currentPrices: Record<string, number>;
    adaptations: number;
  }> {
    const out: Record<string, any> = {};
    for (const [id, a] of Object.entries(this.agents)) {
      out[id] = {
        reputation: a.reputation,
        skillStats: a.skillStats,
        currentPrices: a.currentPrices,
        adaptations: a.adaptationLog.length,
      };
    }
    return out;
  }
}
