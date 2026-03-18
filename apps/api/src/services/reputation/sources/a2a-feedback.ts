/**
 * Epic 63, Story 63.8 — A2A Feedback Reputation Source
 * Queries a2a_task_feedback table to compute Service Quality dimension.
 * Feeds into the "service_quality" dimension at 15% weight.
 */

import { createClient } from '../../../db/client.js';
import type { ReputationSource, ReputationSourceResult } from '../types.js';

export const a2aFeedbackSource: ReputationSource = {
  name: 'a2a_feedback',

  async query(identifier: string): Promise<ReputationSourceResult> {
    const start = Date.now();

    // Only works for agent UUIDs (not wallet addresses)
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
    if (!isUuid) {
      return {
        source: 'a2a_feedback',
        available: false,
        score: null,
        rawData: { reason: 'identifier is not an agent UUID' },
        dataPoints: 0,
        queriedAt: new Date().toISOString(),
        latencyMs: Date.now() - start,
      };
    }

    try {
      const supabase = createClient();

      // Get all feedback for this agent as provider
      const { data: feedback, error } = await supabase
        .from('a2a_task_feedback')
        .select('action, satisfaction, score')
        .eq('provider_agent_id', identifier);

      if (error || !feedback || feedback.length === 0) {
        return {
          source: 'a2a_feedback',
          available: false,
          score: null,
          rawData: { reason: error?.message || 'No feedback data', feedbackCount: 0 },
          dataPoints: 0,
          queriedAt: new Date().toISOString(),
          latencyMs: Date.now() - start,
        };
      }

      const total = feedback.length;
      const rejections = feedback.filter(f => f.action === 'reject').length;
      const rejectionRate = rejections / total;

      // Average score from entries that have a numeric score (0-100)
      const scored = feedback.filter(f => f.score != null);
      const avgScore100 = scored.length > 0
        ? scored.reduce((sum, f) => sum + (f.score ?? 0), 0) / scored.length
        : null;

      // Map 0-100 avg score to 0-1000
      const serviceQualityScore = avgScore100 !== null
        ? Math.round(avgScore100 * 10)
        : null;

      // Also factor in acceptance rate: penalize high rejection
      let finalScore = serviceQualityScore;
      if (finalScore !== null) {
        // Apply rejection penalty: each 10% rejection rate reduces score by 50 points
        const penalty = Math.round(rejectionRate * 500);
        finalScore = Math.max(0, finalScore - penalty);
      } else {
        // No scores, use acceptance rate only: 100% acceptance → 700, 0% → 200
        finalScore = Math.round(700 - rejectionRate * 500);
      }

      return {
        source: 'a2a_feedback',
        available: true,
        score: finalScore,
        rawData: {
          totalFeedback: total,
          rejections,
          rejectionRate: Math.round(rejectionRate * 100) / 100,
          avgScore100,
          scoredCount: scored.length,
        },
        dataPoints: total,
        queriedAt: new Date().toISOString(),
        latencyMs: Date.now() - start,
        dimensions: {
          service_quality: finalScore,
        },
      };
    } catch (error: any) {
      return {
        source: 'a2a_feedback',
        available: false,
        score: null,
        rawData: { error: error.message },
        dataPoints: 0,
        queriedAt: new Date().toISOString(),
        latencyMs: Date.now() - start,
      };
    }
  },
};
