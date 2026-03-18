/**
 * Epic 63, Story 63.5 — Escrow History Source (STUB)
 * Returns unavailable until escrow contract integration is live.
 * When live: reads EscrowCompleted/EscrowDisputed events from AgentEscrowProtocol on Base.
 */

import type { ReputationSource, ReputationSourceResult } from '../types.js';

export const escrowHistorySource: ReputationSource = {
  name: 'escrow_history',

  async query(identifier: string): Promise<ReputationSourceResult> {
    const start = Date.now();

    // TODO: Read EscrowCompleted/EscrowDisputed events from Base
    // Calculate completion rate, dispute frequency → Payment Reliability dimension

    return {
      source: 'escrow_history',
      available: false,
      score: null,
      rawData: { reason: 'Escrow contract integration pending' },
      dataPoints: 0,
      queriedAt: new Date().toISOString(),
      latencyMs: Date.now() - start,
    };
  },
};
