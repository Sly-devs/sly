/**
 * Epic 63, Story 63.6 — Trust Score Calculator
 * Aggregates results from all reputation sources into a unified 0-1000 score.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ReputationSource,
  ReputationSourceResult,
  ReputationDimension,
  UnifiedTrustScore,
  TrustTier,
  ConfidenceLevel,
} from './types.js';
import {
  TIER_THRESHOLDS,
  BASE_WEIGHTS,
  WEIGHTS_WITH_SERVICE_QUALITY,
  SOURCE_DIMENSION_MAP,
} from './types.js';
import { getCached, setCached, cacheKey } from './cache.js';

import { erc8004Source } from './sources/erc8004.js';
import { mnemomSource } from './sources/mnemom.js';
import { vouchedSource } from './sources/vouched.js';
import { escrowHistorySource } from './sources/escrow-history.js';
import { a2aFeedbackSource } from './sources/a2a-feedback.js';

const SOURCE_TIMEOUT_MS = 5000;

export class TrustScoreCalculator {
  private supabase: SupabaseClient;
  private sources: ReputationSource[];

  constructor(supabase: SupabaseClient) {
    this.supabase = supabase;
    this.sources = [
      erc8004Source,
      mnemomSource,
      vouchedSource,
      escrowHistorySource,
      a2aFeedbackSource,
    ];
  }

  /**
   * Compute the unified trust score for an agent or external identifier.
   * Uses cache with stale-while-revalidate.
   */
  async compute(identifier: string): Promise<UnifiedTrustScore> {
    const key = cacheKey(identifier);

    // Check in-memory cache
    const cached = getCached(key);
    if (cached && !cached.stale) {
      return cached.value;
    }

    // Check DB cache
    const dbCached = await this.loadFromDb(identifier);
    if (dbCached && !this.isExpired(dbCached.lastRefreshed)) {
      const score = { ...dbCached, stale: false };
      setCached(key, score);
      return score;
    }

    // Background refresh for stale cache (return stale immediately)
    if (cached?.stale) {
      this.refreshInBackground(identifier);
      return cached.value;
    }

    // Full computation
    return this.computeFresh(identifier);
  }

  /** Get per-source breakdown for an identifier */
  async getSourceBreakdown(identifier: string): Promise<ReputationSourceResult[]> {
    const ctx = await this.resolveAgentContext(identifier);
    return this.queryAllSources(identifier, ctx.walletAddress, ctx.erc8004AgentId);
  }

  private async computeFresh(identifier: string): Promise<UnifiedTrustScore> {
    const ctx = await this.resolveAgentContext(identifier);
    const results = await this.queryAllSources(identifier, ctx.walletAddress, ctx.erc8004AgentId);

    // Log queries
    await this.logQueries(identifier, results);

    const availableResults = results.filter(r => r.available && r.score !== null);
    const availableSources = new Set(availableResults.map(r => r.source));
    const hasServiceQuality = availableSources.has('a2a_feedback');
    const totalDataPoints = results.reduce((sum, r) => sum + r.dataPoints, 0);

    if (availableResults.length === 0) {
      const score: UnifiedTrustScore = {
        score: 0,
        tier: 'F',
        confidence: 'none',
        dimensions: [],
        dataPoints: 0,
        lastRefreshed: new Date().toISOString(),
        stale: false,
      };
      setCached(cacheKey(identifier), score);
      await this.persistToDb(identifier, score, results);
      return score;
    }

    // Pick weight set based on available sources
    const baseWeights = hasServiceQuality ? WEIGHTS_WITH_SERVICE_QUALITY : BASE_WEIGHTS;

    // Determine which dimensions have data
    const dimensionScores: Record<string, { total: number; count: number; sources: string[] }> = {};
    for (const result of availableResults) {
      if (!result.dimensions) continue;
      for (const [dim, score] of Object.entries(result.dimensions)) {
        if (score === undefined) continue;
        if (!dimensionScores[dim]) {
          dimensionScores[dim] = { total: 0, count: 0, sources: [] };
        }
        dimensionScores[dim].total += score;
        dimensionScores[dim].count += 1;
        dimensionScores[dim].sources.push(result.source);
      }
    }

    // Build dimension list with redistributed weights
    const activeDimensions = Object.keys(dimensionScores);
    const totalActiveWeight = activeDimensions.reduce((sum, dim) => sum + (baseWeights[dim] || 0), 0);

    const dimensions: ReputationDimension[] = activeDimensions.map(dim => {
      const d = dimensionScores[dim];
      const avgScore = Math.round(d.total / d.count);
      // Redistribute weight proportionally
      const rawWeight = baseWeights[dim] || 0;
      const normalizedWeight = totalActiveWeight > 0 ? rawWeight / totalActiveWeight : 0;
      return {
        name: dim as ReputationDimension['name'],
        score: avgScore,
        weight: Math.round(normalizedWeight * 100) / 100,
        sources: d.sources,
        dataPoints: d.count,
      };
    });

    // Compute unified score from dimensions
    const unifiedScore = Math.round(
      dimensions.reduce((sum, d) => sum + d.score * d.weight, 0)
    );
    const tier = this.scoreToTier(unifiedScore);
    const confidence = this.computeConfidence(availableResults.length);

    const result: UnifiedTrustScore = {
      score: unifiedScore,
      tier,
      confidence,
      dimensions,
      dataPoints: totalDataPoints,
      lastRefreshed: new Date().toISOString(),
      stale: false,
    };

    setCached(cacheKey(identifier), result);
    await this.persistToDb(identifier, result, results);
    return result;
  }

  /** On-chain sources need a wallet address; off-chain sources use the agent UUID */
  private static ON_CHAIN_SOURCES = new Set(['erc8004', 'escrow_history']);

  private async queryAllSources(
    identifier: string,
    walletAddress?: string | null,
    erc8004AgentId?: string | null,
  ): Promise<ReputationSourceResult[]> {
    const promises = this.sources.map(source => {
      // On-chain sources get the wallet address if available, otherwise the raw identifier
      const queryId = (TrustScoreCalculator.ON_CHAIN_SOURCES.has(source.name) && walletAddress)
        ? walletAddress
        : identifier;
      // ERC-8004 source can use the stored on-chain agent ID for fast-path lookup
      const queryFn = source.name === 'erc8004' && erc8004AgentId
        ? (erc8004Source as any).query(queryId, erc8004AgentId)
        : source.query(queryId);
      return Promise.race([
        queryFn,
        new Promise<ReputationSourceResult>((resolve) =>
          setTimeout(() => resolve({
            source: source.name,
            available: false,
            score: null,
            rawData: { error: 'timeout' },
            dataPoints: 0,
            queriedAt: new Date().toISOString(),
            latencyMs: SOURCE_TIMEOUT_MS,
          }), SOURCE_TIMEOUT_MS)
        ),
      ]);
    });
    return Promise.all(promises);
  }

  /** If the identifier is an agent UUID, look up wallet_address and erc8004_agent_id */
  private async resolveAgentContext(identifier: string): Promise<{
    walletAddress: string | null;
    erc8004AgentId: string | null;
  }> {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
    if (!isUuid) return { walletAddress: null, erc8004AgentId: null };
    try {
      const { data } = await this.supabase
        .from('agents')
        .select('wallet_address, erc8004_agent_id')
        .eq('id', identifier)
        .maybeSingle();
      return {
        walletAddress: data?.wallet_address || null,
        erc8004AgentId: data?.erc8004_agent_id || null,
      };
    } catch {
      return { walletAddress: null, erc8004AgentId: null };
    }
  }

  private scoreToTier(score: number): TrustTier {
    for (const t of TIER_THRESHOLDS) {
      if (score >= t.min) return t.tier;
    }
    return 'F';
  }

  private computeConfidence(availableCount: number): ConfidenceLevel {
    if (availableCount >= 3) return 'high';
    if (availableCount >= 2) return 'medium';
    if (availableCount >= 1) return 'low';
    return 'none';
  }

  private isExpired(lastRefreshed: string): boolean {
    const age = Date.now() - new Date(lastRefreshed).getTime();
    return age > 5 * 60 * 1000; // 5 minutes
  }

  private async loadFromDb(identifier: string): Promise<UnifiedTrustScore | null> {
    try {
      // Try as agent_id first, then as external_identifier
      const { data } = await this.supabase
        .from('reputation_scores')
        .select('*')
        .or(`agent_id.eq.${identifier},external_identifier.eq.${identifier}`)
        .maybeSingle();

      if (!data) return null;

      return {
        score: data.unified_score ?? 0,
        tier: data.unified_tier ?? 'F',
        confidence: data.confidence ?? 'none',
        dimensions: data.dimensions ?? [],
        dataPoints: data.data_points ?? 0,
        lastRefreshed: data.last_refreshed,
        stale: false,
      };
    } catch {
      return null;
    }
  }

  private async persistToDb(
    identifier: string,
    score: UnifiedTrustScore,
    sourceResults: ReputationSourceResult[]
  ): Promise<void> {
    try {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
      const record = {
        ...(isUuid ? { agent_id: identifier } : { external_identifier: identifier }),
        unified_score: score.score,
        unified_tier: score.tier,
        confidence: score.confidence,
        dimensions: score.dimensions,
        source_data: Object.fromEntries(sourceResults.map(r => [r.source, r.rawData])),
        data_points: score.dataPoints,
        last_refreshed: score.lastRefreshed,
        updated_at: new Date().toISOString(),
      };

      const conflictCol = isUuid ? 'agent_id' : 'external_identifier';
      // Use upsert based on the unique index
      await this.supabase
        .from('reputation_scores')
        .upsert(record, { onConflict: conflictCol })
        .select();
    } catch {
      // Non-critical: cache still works if DB write fails
    }
  }

  private async logQueries(identifier: string, results: ReputationSourceResult[]): Promise<void> {
    try {
      const rows = results.map(r => ({
        identifier,
        source_type: r.source,
        cache_hit: false,
        latency_ms: r.latencyMs,
        error: r.available ? null : (r.rawData?.error as string || r.rawData?.reason as string || null),
      }));
      await this.supabase.from('reputation_queries').insert(rows);
    } catch {
      // Non-critical
    }
  }

  private refreshInBackground(identifier: string): void {
    // Fire-and-forget refresh
    this.computeFresh(identifier).catch(() => {});
  }
}
