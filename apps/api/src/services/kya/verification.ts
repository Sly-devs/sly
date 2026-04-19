/**
 * KYA Tier Verification Service
 * Story 73.17: T2 eligibility checks and enterprise override processing.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { checkBehavioralConsistency } from './observation.js';

export interface T2EligibilityResult {
  eligible: boolean;
  blockers: string[];
  operationalDays: number;
  behavioralConsistencyScore: number;
  policyViolationCount: number;
  hasEnterpriseOverride: boolean;
}

/**
 * Check whether an agent meets T2 upgrade requirements:
 * - 30 days of operational history (or enterprise override)
 * - Zero policy violations
 * - Behavioral consistency score >= 0.7
 */
export async function checkT2Eligibility(
  supabase: SupabaseClient,
  agentId: string,
): Promise<T2EligibilityResult> {
  // Fetch current agent state
  const { data: agent, error } = await supabase
    .from('agents')
    .select('operational_history_start, policy_violation_count, behavioral_consistency_score, kya_enterprise_override')
    .eq('id', agentId)
    .single();

  if (error || !agent) {
    return {
      eligible: false,
      blockers: ['Agent not found'],
      operationalDays: 0,
      behavioralConsistencyScore: 0,
      policyViolationCount: 0,
      hasEnterpriseOverride: false,
    };
  }

  const blockers: string[] = [];
  const hasOverride = agent.kya_enterprise_override === true;

  // Check operational history (30 days)
  let operationalDays = 0;
  if (agent.operational_history_start) {
    operationalDays = Math.floor(
      (Date.now() - new Date(agent.operational_history_start).getTime()) / (86400 * 1000),
    );
  }

  if (operationalDays < 30 && !hasOverride) {
    blockers.push(`Need ${30 - operationalDays} more days of operational history (or enterprise override)`);
  }

  // Check policy violations
  const violationCount = agent.policy_violation_count || 0;
  if (violationCount > 0) {
    blockers.push(`${violationCount} policy violation(s) must be resolved before T2 upgrade`);
  }

  // Check behavioral consistency (recompute fresh)
  const { score } = await checkBehavioralConsistency(supabase, agentId);
  if (score < 0.7) {
    blockers.push(`Behavioral consistency score ${score.toFixed(2)} is below 0.70 minimum`);
  }

  return {
    eligible: blockers.length === 0,
    blockers,
    operationalDays,
    behavioralConsistencyScore: score,
    policyViolationCount: violationCount,
    hasEnterpriseOverride: hasOverride,
  };
}

/**
 * Process an enterprise override for T2 upgrade.
 * Bypasses the 30-day operational history requirement but still checks behavioral consistency.
 */
export async function processEnterpriseOverride(
  supabase: SupabaseClient,
  agentId: string,
  assessorId: string,
): Promise<{ success: boolean; score: number; blockers: string[] }> {
  const blockers: string[] = [];

  // Run consistency check even for enterprise override
  const { score } = await checkBehavioralConsistency(supabase, agentId);
  if (score < 0.7) {
    blockers.push(`Behavioral consistency score ${score.toFixed(2)} is below 0.70 minimum (even with enterprise override)`);
  }

  // Check violations
  const { data: agent } = await supabase
    .from('agents')
    .select('policy_violation_count')
    .eq('id', agentId)
    .single();

  if (agent && (agent.policy_violation_count || 0) > 0) {
    blockers.push(`${agent.policy_violation_count} policy violation(s) must be resolved`);
  }

  if (blockers.length > 0) {
    return { success: false, score, blockers };
  }

  // Set the enterprise override flag
  await supabase
    .from('agents')
    .update({
      kya_enterprise_override: true,
      kya_override_assessed_at: new Date().toISOString(),
      kya_override_assessor_id: assessorId,
    })
    .eq('id', agentId);

  return { success: true, score, blockers: [] };
}
