import type { SupabaseClient } from '@supabase/supabase-js';
import { LimitExceededError } from '../middleware/error.js';
import { trackOp } from './ops/track-op.js';
import { OpType } from './ops/operation-types.js';

export interface LimitCheckResult {
  allowed: boolean;
  reason?: string;
  limitType?: string;
  limit?: number;
  used?: number;
  requested?: number;
}

export interface AgentLimits {
  perTransaction: number;
  daily: number;
  monthly: number;
}

export interface StreamLimits {
  maxActiveStreams: number;
  maxFlowRatePerStream: number;
  maxTotalOutflow: number;
}

export class LimitService {
  constructor(
    private supabase: SupabaseClient,
    private environment: 'test' | 'live' = 'test',
  ) {}

  /**
   * Get agent with limits and parent account info
   */
  private async getAgent(agentId: string) {
    // Get agent data
    const { data: agent, error: agentError } = await this.supabase
      .from('agents')
      .select(`
        id, name, status, kya_tier, parent_account_id, tenant_id,
        limit_per_transaction, limit_daily, limit_monthly,
        effective_limit_per_tx, effective_limit_daily, effective_limit_monthly,
        effective_limits_capped,
        max_active_streams, max_flow_rate_per_stream, max_total_outflow,
        active_streams_count, total_stream_outflow
      `)
      .eq('id', agentId)
      .eq('environment', this.environment)
      .single();

    if (agentError || !agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    // Get parent account if exists
    let parentAccount = null;
    if (agent.parent_account_id) {
      const { data: account, error: accountError } = await this.supabase
        .from('accounts')
        .select('id, name, verification_tier, verification_status')
        .eq('id', agent.parent_account_id)
        .eq('environment', this.environment)
        .single();
      
      if (accountError) {
        console.error('Failed to get parent account:', accountError);
      }
      parentAccount = account;
    }

    return { ...agent, parentAccount };
  }

  /**
   * Get agent's daily usage
   */
  private async getDailyUsage(agentId: string): Promise<number> {
    const today = new Date().toISOString().split('T')[0];

    const { data } = await this.supabase
      .from('agent_usage')
      .select('daily_amount')
      .eq('agent_id', agentId)
      .eq('date', today)
      .single();

    return parseFloat(data?.daily_amount) || 0;
  }

  /**
   * Get agent's monthly usage
   */
  private async getMonthlyUsage(agentId: string): Promise<number> {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];

    const { data } = await this.supabase
      .from('agent_usage')
      .select('daily_amount')
      .eq('agent_id', agentId)
      .gte('date', startOfMonth);

    const total = (data || []).reduce((sum, row) => sum + (parseFloat(row.daily_amount) || 0), 0);
    return total;
  }

  /**
   * Check if a transaction amount is within agent limits
   */
  async checkTransactionLimit(
    agentId: string,
    amount: number,
    correlationId?: string
  ): Promise<LimitCheckResult> {
    const agent = await this.getAgent(agentId);

    // Check agent is active
    if (agent.status !== 'active') {
      const result: LimitCheckResult = {
        allowed: false,
        reason: 'agent_not_active',
        limitType: 'status',
      };
      trackOp({
        tenantId: agent.tenant_id,
        operation: OpType.GOVERNANCE_LIMIT_CHECK,
        subject: `agent/${agentId}`,
        correlationId,
        success: false,
        data: { amount, reason: result.reason, limitType: result.limitType },
      });
      return result;
    }

    const effectiveLimits: AgentLimits = {
      perTransaction: parseFloat(agent.effective_limit_per_tx) || 0,
      daily: parseFloat(agent.effective_limit_daily) || 0,
      monthly: parseFloat(agent.effective_limit_monthly) || 0,
    };

    // Check KYA tier (tier 0 cannot transact)
    if (agent.kya_tier === 0) {
      const result: LimitCheckResult = {
        allowed: false,
        reason: 'kya_verification_required',
        limitType: 'kya_tier',
      };
      trackOp({
        tenantId: agent.tenant_id,
        operation: OpType.GOVERNANCE_LIMIT_CHECK,
        subject: `agent/${agentId}`,
        correlationId,
        success: false,
        data: { amount, reason: result.reason, limitType: result.limitType },
      });
      return result;
    }

    // Per-transaction check
    if (amount > effectiveLimits.perTransaction) {
      const result: LimitCheckResult = {
        allowed: false,
        reason: 'exceeds_per_transaction',
        limitType: 'per_transaction',
        limit: effectiveLimits.perTransaction,
        requested: amount,
      };
      trackOp({
        tenantId: agent.tenant_id,
        operation: OpType.GOVERNANCE_LIMIT_CHECK,
        subject: `agent/${agentId}`,
        correlationId,
        success: false,
        data: { amount, reason: result.reason, limitType: result.limitType, limit: effectiveLimits.perTransaction },
      });
      return result;
    }

    // Daily usage check
    const dailyUsage = await this.getDailyUsage(agentId);
    if (dailyUsage + amount > effectiveLimits.daily) {
      const result: LimitCheckResult = {
        allowed: false,
        reason: 'exceeds_daily',
        limitType: 'daily',
        limit: effectiveLimits.daily,
        used: dailyUsage,
        requested: amount,
      };
      trackOp({
        tenantId: agent.tenant_id,
        operation: OpType.GOVERNANCE_LIMIT_CHECK,
        subject: `agent/${agentId}`,
        correlationId,
        success: false,
        data: { amount, reason: result.reason, limitType: result.limitType, limit: effectiveLimits.daily, used: dailyUsage },
      });
      return result;
    }

    // Monthly usage check
    const monthlyUsage = await this.getMonthlyUsage(agentId);
    if (monthlyUsage + amount > effectiveLimits.monthly) {
      const result: LimitCheckResult = {
        allowed: false,
        reason: 'exceeds_monthly',
        limitType: 'monthly',
        limit: effectiveLimits.monthly,
        used: monthlyUsage,
        requested: amount,
      };
      trackOp({
        tenantId: agent.tenant_id,
        operation: OpType.GOVERNANCE_LIMIT_CHECK,
        subject: `agent/${agentId}`,
        correlationId,
        success: false,
        data: { amount, reason: result.reason, limitType: result.limitType, limit: effectiveLimits.monthly, used: monthlyUsage },
      });
      return result;
    }

    trackOp({
      tenantId: agent.tenant_id,
      operation: OpType.GOVERNANCE_LIMIT_CHECK,
      subject: `agent/${agentId}`,
      correlationId,
      success: true,
      data: { amount },
    });
    return { allowed: true };
  }

  /**
   * Check if agent can create a new stream
   */
  async checkStreamLimit(
    agentId: string,
    flowRatePerMonth: number,
    correlationId?: string
  ): Promise<LimitCheckResult> {
    const agent = await this.getAgent(agentId);

    // Check agent is active
    if (agent.status !== 'active') {
      const result: LimitCheckResult = {
        allowed: false,
        reason: 'agent_not_active',
        limitType: 'status',
      };
      trackOp({
        tenantId: agent.tenant_id,
        operation: OpType.GOVERNANCE_LIMIT_CHECK,
        subject: `agent/${agentId}/stream`,
        correlationId,
        success: false,
        data: { flowRatePerMonth, reason: result.reason, limitType: result.limitType },
      });
      return result;
    }

    // Check KYA tier
    if (agent.kya_tier === 0) {
      const result: LimitCheckResult = {
        allowed: false,
        reason: 'kya_verification_required',
        limitType: 'kya_tier',
      };
      trackOp({
        tenantId: agent.tenant_id,
        operation: OpType.GOVERNANCE_LIMIT_CHECK,
        subject: `agent/${agentId}/stream`,
        correlationId,
        success: false,
        data: { flowRatePerMonth, reason: result.reason, limitType: result.limitType },
      });
      return result;
    }

    const streamLimits: StreamLimits = {
      maxActiveStreams: agent.max_active_streams || 5,
      maxFlowRatePerStream: parseFloat(agent.max_flow_rate_per_stream) || 5000,
      maxTotalOutflow: parseFloat(agent.max_total_outflow) || 50000,
    };

    // Stream count check
    const currentStreams = agent.active_streams_count || 0;
    if (currentStreams >= streamLimits.maxActiveStreams) {
      const result: LimitCheckResult = {
        allowed: false,
        reason: 'max_streams_reached',
        limitType: 'stream_count',
        limit: streamLimits.maxActiveStreams,
        used: currentStreams,
      };
      trackOp({
        tenantId: agent.tenant_id,
        operation: OpType.GOVERNANCE_LIMIT_CHECK,
        subject: `agent/${agentId}/stream`,
        correlationId,
        success: false,
        data: { flowRatePerMonth, reason: result.reason, limitType: result.limitType },
      });
      return result;
    }

    // Per-stream flow rate check
    if (flowRatePerMonth > streamLimits.maxFlowRatePerStream) {
      const result: LimitCheckResult = {
        allowed: false,
        reason: 'exceeds_max_flow_rate',
        limitType: 'flow_rate',
        limit: streamLimits.maxFlowRatePerStream,
        requested: flowRatePerMonth,
      };
      trackOp({
        tenantId: agent.tenant_id,
        operation: OpType.GOVERNANCE_LIMIT_CHECK,
        subject: `agent/${agentId}/stream`,
        correlationId,
        success: false,
        data: { flowRatePerMonth, reason: result.reason, limitType: result.limitType },
      });
      return result;
    }

    // Total outflow check
    const currentOutflow = parseFloat(agent.total_stream_outflow) || 0;
    const newTotalOutflow = currentOutflow + flowRatePerMonth;
    if (newTotalOutflow > streamLimits.maxTotalOutflow) {
      const result: LimitCheckResult = {
        allowed: false,
        reason: 'exceeds_total_outflow',
        limitType: 'total_outflow',
        limit: streamLimits.maxTotalOutflow,
        used: currentOutflow,
        requested: flowRatePerMonth,
      };
      trackOp({
        tenantId: agent.tenant_id,
        operation: OpType.GOVERNANCE_LIMIT_CHECK,
        subject: `agent/${agentId}/stream`,
        correlationId,
        success: false,
        data: { flowRatePerMonth, reason: result.reason, limitType: result.limitType },
      });
      return result;
    }

    trackOp({
      tenantId: agent.tenant_id,
      operation: OpType.GOVERNANCE_LIMIT_CHECK,
      subject: `agent/${agentId}/stream`,
      correlationId,
      success: true,
      data: { flowRatePerMonth },
    });
    return { allowed: true };
  }

  /**
   * Record usage for an agent (after successful transaction).
   * Direct upsert into agent_usage table (unique on agent_id + date).
   */
  async recordUsage(agentId: string, amount: number): Promise<void> {
    const today = new Date().toISOString().split('T')[0];

    // Look up tenant_id from the agent record
    const { data: agent, error: agentError } = await this.supabase
      .from('agents')
      .select('tenant_id')
      .eq('id', agentId)
      .eq('environment', this.environment)
      .single();

    if (agentError || !agent) {
      console.error('Failed to find agent for usage recording:', agentError);
      return;
    }

    // Check if a row already exists for today
    const { data: existing } = await this.supabase
      .from('agent_usage')
      .select('id, daily_amount, transaction_count')
      .eq('agent_id', agentId)
      .eq('date', today)
      .single();

    if (existing) {
      const { error } = await this.supabase
        .from('agent_usage')
        .update({
          daily_amount: (parseFloat(existing.daily_amount) || 0) + amount,
          transaction_count: (existing.transaction_count || 0) + 1,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id);

      if (error) {
        console.error('Failed to update agent usage:', error);
      }
    } else {
      const { error } = await this.supabase
        .from('agent_usage')
        .insert({
          agent_id: agentId,
          tenant_id: agent.tenant_id,
          date: today,
          daily_amount: amount,
          transaction_count: 1,
        });

      if (error) {
        console.error('Failed to insert agent usage:', error);
      }
    }
  }

  /**
   * Update agent stream stats
   */
  async updateAgentStreamStats(
    agentId: string,
    streamCountDelta: number,
    outflowDelta: number
  ): Promise<void> {
    const { error } = await this.supabase.rpc('update_agent_stream_stats', {
      p_agent_id: agentId,
      p_stream_count_delta: streamCountDelta,
      p_outflow_delta: outflowDelta,
    });

    if (error) {
      // Fallback to direct update
      const agent = await this.getAgent(agentId);
      await this.supabase
        .from('agents')
        .update({
          active_streams_count: Math.max(0, (agent.active_streams_count || 0) + streamCountDelta),
          total_stream_outflow: Math.max(0, parseFloat(agent.total_stream_outflow || '0') + outflowDelta),
        })
        .eq('id', agentId);
    }
  }

  /**
   * Get agent's current usage stats with effective limits
   */
  async getUsageStats(agentId: string) {
    const agent = await this.getAgent(agentId);
    const dailyUsage = await this.getDailyUsage(agentId);
    const monthlyUsage = await this.getMonthlyUsage(agentId);

    // Agent's own limits based on KYA tier
    const agentLimits = {
      perTransaction: parseFloat(agent.limit_per_transaction) || 0,
      daily: parseFloat(agent.limit_daily) || 0,
      monthly: parseFloat(agent.limit_monthly) || 0,
    };

    // Effective limits (min of agent and parent)
    const effectiveLimits = {
      perTransaction: parseFloat(agent.effective_limit_per_tx) || 0,
      daily: parseFloat(agent.effective_limit_daily) || 0,
      monthly: parseFloat(agent.effective_limit_monthly) || 0,
      cappedByParent: agent.effective_limits_capped || false,
    };

    // Parent account info
    const parentAccount = agent.parentAccount ? {
      id: agent.parentAccount.id,
      name: agent.parentAccount.name,
      verificationTier: agent.parentAccount.verification_tier,
      verificationStatus: agent.parentAccount.verification_status,
    } : null;

    return {
      agentId,
      kyaTier: agent.kya_tier,
      status: agent.status,
      // Agent's base limits from KYA tier
      limits: agentLimits,
      // Effective limits (capped by parent if applicable)
      effectiveLimits,
      // Parent account info for transparency
      parentAccount,
      usage: {
        daily: dailyUsage,
        monthly: monthlyUsage,
        dailyRemaining: Math.max(0, effectiveLimits.daily - dailyUsage),
        monthlyRemaining: Math.max(0, effectiveLimits.monthly - monthlyUsage),
      },
      streams: {
        active: agent.active_streams_count || 0,
        maxActive: agent.max_active_streams || 5,
        totalOutflow: parseFloat(agent.total_stream_outflow) || 0,
        maxTotalOutflow: parseFloat(agent.max_total_outflow) || 50000,
      },
    };
  }
}

/**
 * Create a limit service instance
 */
export function createLimitService(supabase: SupabaseClient, environment: 'test' | 'live' = 'test'): LimitService {
  return new LimitService(supabase, environment);
}

