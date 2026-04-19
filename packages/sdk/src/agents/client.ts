/**
 * Agents Client - KYA Tier Management
 *
 * Story 73.20: SDK methods for KYA tier status, trust profiles,
 * tier upgrades, DSD declarations, and kill-switch activation.
 */

import type { PayOSClient } from '../client';
import type { SkillManifest, EscalationPolicy } from '@sly/types';

// ============================================
// Types
// ============================================

export interface KyaStatusResponse {
  agentId: string;
  name: string;
  tier: number;
  status: string;
  verifiedAt: string | null;
  effectiveLimits: {
    perTransaction: number;
    daily: number;
    monthly: number;
    cappedByParent: boolean;
    parentTier: number;
  };
  cai: {
    modelFamily: string | null;
    modelVersion: string | null;
    skillManifest: SkillManifest | null;
    useCaseDescription: string | null;
    escalationPolicy: EscalationPolicy;
    operationalDays: number;
    policyViolationCount: number;
    behavioralConsistencyScore: number | null;
    enterpriseOverride: boolean;
    killSwitchEnabled: boolean;
  };
  upgrade: {
    eligible: boolean;
    nextTier: number | null;
    blockers: string[];
  };
}

export interface TrustProfileResponse {
  agentId: string;
  kyaTier: number;
  parentVerificationTier: number;
  parentEntityType: string;
  operationalDays: number;
  policyViolationCount: number | null;
  behavioralConsistencyScore: number | null;
  skillManifest: SkillManifest | null;
  modelFamily: string | null;
  killSwitchEnabled: boolean;
  lastVerifiedAt: string | null;
}

export interface UpgradeParams {
  targetTier: number;
  skillManifest?: SkillManifest;
  spendingPolicy?: {
    perTransaction?: number;
    daily?: number;
    monthly?: number;
    allowlistedDomains?: string[];
  };
  escalationPolicy?: EscalationPolicy;
  useCaseDescription?: string;
  modelFamily?: string;
  modelVersion?: string;
  killSwitchOperator?: {
    name: string;
    email: string;
  };
}

export interface DeclareDsdParams {
  skillManifest: SkillManifest;
  spendingPolicy?: {
    perTransaction?: number;
    daily?: number;
    monthly?: number;
    allowlistedDomains?: string[];
  };
  escalationPolicy: EscalationPolicy;
  useCaseDescription: string;
  modelFamily?: string;
  modelVersion?: string;
}

export interface KillSwitchResponse {
  suspended: boolean;
  pendingCancelled: number;
}

// ============================================
// Client
// ============================================

export class AgentsClient {
  private client: PayOSClient;

  constructor(client: PayOSClient) {
    this.client = client;
  }

  /**
   * Get an agent's KYA tier status and upgrade eligibility.
   *
   * @example
   * ```typescript
   * const status = await sly.agents.getKyaStatus('agent-uuid');
   * console.log(status.tier, status.upgrade.eligible);
   * ```
   */
  async getKyaStatus(agentId: string): Promise<KyaStatusResponse> {
    return this.client.request<KyaStatusResponse>(
      `/v1/agents/${agentId}/kya-status`,
    );
  }

  /**
   * Get an agent's cross-org trust profile.
   *
   * @example
   * ```typescript
   * const profile = await sly.agents.getTrustProfile('agent-uuid');
   * console.log(profile.kyaTier, profile.behavioralConsistencyScore);
   * ```
   */
  async getTrustProfile(agentId: string): Promise<TrustProfileResponse> {
    return this.client.request<TrustProfileResponse>(
      `/v1/agents/${agentId}/trust-profile`,
    );
  }

  /**
   * Upgrade an agent to a higher KYA tier.
   *
   * @example
   * ```typescript
   * const result = await sly.agents.upgrade('agent-uuid', {
   *   targetTier: 1,
   *   skillManifest: {
   *     protocols: ['x402'],
   *     action_types: ['payment'],
   *     domain: 'commerce',
   *     description: 'Handles micropayments',
   *   },
   *   escalationPolicy: 'DECLINE',
   * });
   * ```
   */
  async upgrade(agentId: string, params: UpgradeParams): Promise<{ data: any }> {
    return this.client.request<{ data: any }>(
      `/v1/agents/${agentId}/upgrade`,
      {
        method: 'POST',
        body: JSON.stringify({
          target_tier: params.targetTier,
          skill_manifest: params.skillManifest,
          spending_policy: params.spendingPolicy
            ? {
                per_transaction: params.spendingPolicy.perTransaction,
                daily: params.spendingPolicy.daily,
                monthly: params.spendingPolicy.monthly,
                allowlisted_domains: params.spendingPolicy.allowlistedDomains,
              }
            : undefined,
          escalation_policy: params.escalationPolicy,
          use_case_description: params.useCaseDescription,
          model_family: params.modelFamily,
          model_version: params.modelVersion,
          kill_switch_operator: params.killSwitchOperator,
        }),
      },
    );
  }

  /**
   * Declare a Delegation Scope Document (DSD) for an agent.
   * Auto-upgrades T0 agents to T1 when a valid DSD is provided.
   *
   * @example
   * ```typescript
   * const result = await sly.agents.declareDsd('agent-uuid', {
   *   skillManifest: {
   *     protocols: ['x402', 'acp'],
   *     action_types: ['payment', 'checkout'],
   *     domain: 'commerce',
   *     description: 'Handles multi-protocol payments',
   *   },
   *   escalationPolicy: 'SUSPEND_AND_NOTIFY',
   *   useCaseDescription: 'Autonomous payment agent for e-commerce',
   * });
   * ```
   */
  async declareDsd(agentId: string, dsd: DeclareDsdParams): Promise<{ data: any }> {
    return this.client.request<{ data: any }>(
      `/v1/agents/${agentId}/declare-dsd`,
      {
        method: 'POST',
        body: JSON.stringify({
          skill_manifest: dsd.skillManifest,
          spending_policy: dsd.spendingPolicy
            ? {
                per_transaction: dsd.spendingPolicy.perTransaction,
                daily: dsd.spendingPolicy.daily,
                monthly: dsd.spendingPolicy.monthly,
                allowlisted_domains: dsd.spendingPolicy.allowlistedDomains,
              }
            : undefined,
          escalation_policy: dsd.escalationPolicy,
          use_case_description: dsd.useCaseDescription,
          model_family: dsd.modelFamily,
          model_version: dsd.modelVersion,
        }),
      },
    );
  }

  /**
   * Activate the kill switch on an agent, suspending it and cancelling all pending transactions.
   * Only callable by the designated kill-switch operator or tenant owner.
   *
   * @example
   * ```typescript
   * const result = await sly.agents.activateKillSwitch('agent-uuid');
   * console.log(result.suspended, result.pendingCancelled);
   * ```
   */
  async activateKillSwitch(agentId: string): Promise<KillSwitchResponse> {
    return this.client.request<KillSwitchResponse>(
      `/v1/agents/${agentId}/kill-switch`,
      { method: 'POST', body: JSON.stringify({}) },
    );
  }
}
