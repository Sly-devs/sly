/**
 * Epic 63 — External Reputation Bridge Routes
 * GET /v1/reputation/:identifier  — unified trust score
 * GET /v1/reputation/:identifier/sources  — per-source breakdown
 */

import { Hono } from 'hono';
import { createClient } from '../db/client.js';
import { TrustScoreCalculator } from '../services/reputation/trust-score-calculator.js';

const reputation = new Hono();

function getCalculator() {
  const supabase = createClient();
  return new TrustScoreCalculator(supabase);
}

// GET /v1/reputation/:identifier — Unified trust score
reputation.get('/:identifier', async (c) => {
  const identifier = c.req.param('identifier');
  const calculator = getCalculator();
  const score = await calculator.compute(identifier);

  return c.json({
    identifier,
    score: score.score,
    tier: score.tier,
    confidence: score.confidence,
    dimensions: score.dimensions,
    dataPoints: score.dataPoints,
    lastRefreshed: score.lastRefreshed,
    stale: score.stale,
  });
});

// GET /v1/reputation/:identifier/sources — Per-source breakdown
reputation.get('/:identifier/sources', async (c) => {
  const identifier = c.req.param('identifier');
  const calculator = getCalculator();

  const [score, sources] = await Promise.all([
    calculator.compute(identifier),
    calculator.getSourceBreakdown(identifier),
  ]);

  return c.json({
    identifier,
    unifiedScore: score.score,
    tier: score.tier,
    sources: sources.map(s => ({
      source: s.source,
      available: s.available,
      score: s.score,
      dataPoints: s.dataPoints,
      latencyMs: s.latencyMs,
      queriedAt: s.queriedAt,
      rawData: s.rawData,
    })),
  });
});

export default reputation;
