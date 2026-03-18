/**
 * Epic 63, Story 63.3 — Mnemom Agent Integrity Source (STUB)
 * Returns unavailable until MNEMOM_API_KEY is configured.
 * When live: queries @mnemom/agent-integrity-protocol for trust rating.
 */

import type { ReputationSource, ReputationSourceResult } from '../types.js';

export const mnemomSource: ReputationSource = {
  name: 'mnemom',

  async query(identifier: string): Promise<ReputationSourceResult> {
    const start = Date.now();

    if (!process.env.MNEMOM_API_KEY) {
      return {
        source: 'mnemom',
        available: false,
        score: null,
        rawData: { reason: 'MNEMOM_API_KEY not configured' },
        dataPoints: 0,
        queriedAt: new Date().toISOString(),
        latencyMs: Date.now() - start,
      };
    }

    // TODO: Integrate with @mnemom/agent-integrity-protocol SDK
    // const rating = await mnemom.getAgentTrustRating(identifier);
    // return { source: 'mnemom', available: true, score: rating.score, ... };

    return {
      source: 'mnemom',
      available: false,
      score: null,
      rawData: { reason: 'SDK integration pending' },
      dataPoints: 0,
      queriedAt: new Date().toISOString(),
      latencyMs: Date.now() - start,
    };
  },
};
