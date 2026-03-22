/**
 * Settlement Trigger Engine
 * Epic 50, Story 50.2: Settlement Trigger Engine
 *
 * Evaluates settlement rules and triggers settlements based on configured conditions.
 * Supports: schedule (cron), threshold (balance), manual, and immediate triggers.
 *
 * @see docs/prd/epics/epic-50-settlement-decoupling.md
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { createSettlementRouter, SettlementResponse } from './settlement-router.js';

// ============================================
// Types
// ============================================

export type TriggerType = 'schedule' | 'threshold' | 'manual' | 'immediate';
export type SettlementRail = 'auto' | 'ach' | 'pix' | 'spei' | 'wire' | 'usdc';
export type SettlementPriority = 'standard' | 'expedited';
export type ExecutionStatus = 'pending' | 'executing' | 'completed' | 'failed' | 'skipped';

export interface ScheduleConfig {
  cron: string;  // e.g., "0 17 * * *" (5pm daily)
}

export interface ThresholdConfig {
  amount: number;  // Threshold amount in smallest unit
  currency: string;
}

export interface ImmediateConfig {
  transfer_types: string[];  // e.g., ["payout", "withdrawal"]
}

export interface SettlementRule {
  id: string;
  tenant_id: string;
  wallet_id?: string;
  name: string;
  description?: string;
  trigger_type: TriggerType;
  trigger_config: ScheduleConfig | ThresholdConfig | ImmediateConfig | Record<string, never>;
  settlement_rail: SettlementRail;
  settlement_priority: SettlementPriority;
  minimum_amount?: number;
  minimum_currency?: string;
  maximum_amount?: number;
  maximum_currency?: string;
  enabled: boolean;
  priority: number;
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface SettlementRuleExecution {
  id: string;
  tenant_id: string;
  rule_id: string;
  status: ExecutionStatus;
  trigger_reason: string;
  trigger_context: Record<string, unknown>;
  amount?: number;
  currency?: string;
  settlement_rail?: string;
  settlement_id?: string;
  error_message?: string;
  error_code?: string;
  started_at: string;
  completed_at?: string;
}

export interface CreateRuleInput {
  tenant_id: string;
  wallet_id?: string;
  name: string;
  description?: string;
  trigger_type: TriggerType;
  trigger_config: Record<string, unknown>;
  settlement_rail?: SettlementRail;
  settlement_priority?: SettlementPriority;
  minimum_amount?: number;
  minimum_currency?: string;
  maximum_amount?: number;
  maximum_currency?: string;
  enabled?: boolean;
  priority?: number;
  metadata?: Record<string, unknown>;
}

export interface UpdateRuleInput {
  name?: string;
  description?: string;
  trigger_config?: Record<string, unknown>;
  settlement_rail?: SettlementRail;
  settlement_priority?: SettlementPriority;
  minimum_amount?: number;
  minimum_currency?: string;
  maximum_amount?: number;
  maximum_currency?: string;
  enabled?: boolean;
  priority?: number;
  metadata?: Record<string, unknown>;
}

export interface RuleFilters {
  trigger_type?: TriggerType;
  enabled_only?: boolean;
  wallet_id?: string;
}

export interface ExecutionFilters {
  rule_id?: string;
  status?: string;
  limit: number;
  offset: number;
}

// ============================================
// CRUD Operations
// ============================================

/**
 * Get all settlement rules for a tenant
 */
export async function getSettlementRules(
  supabase: SupabaseClient,
  tenantId: string,
  filters?: RuleFilters
): Promise<{ data: SettlementRule[]; error?: string }> {
  let query = supabase
    .from('settlement_rules')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('priority', { ascending: true });

  if (filters?.trigger_type) {
    query = query.eq('trigger_type', filters.trigger_type);
  }

  if (filters?.enabled_only) {
    query = query.eq('enabled', true);
  }

  if (filters?.wallet_id) {
    query = query.or(`wallet_id.eq.${filters.wallet_id},wallet_id.is.null`);
  }

  const { data, error } = await query;

  if (error) {
    console.error('[Settlement Triggers] Error fetching rules:', error);
    return { data: [], error: error.message };
  }

  return { data: data as SettlementRule[] };
}

/**
 * Get a single settlement rule
 */
export async function getSettlementRule(
  supabase: SupabaseClient,
  tenantId: string,
  ruleId: string
): Promise<{ data?: SettlementRule; error?: string }> {
  const { data, error } = await supabase
    .from('settlement_rules')
    .select('*')
    .eq('id', ruleId)
    .eq('tenant_id', tenantId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      return { error: 'Rule not found' };
    }
    return { error: error.message };
  }

  return { data: data as SettlementRule };
}

/**
 * Create a new settlement rule
 */
export async function createSettlementRule(
  supabase: SupabaseClient,
  input: CreateRuleInput
): Promise<{ data?: SettlementRule; error?: string }> {
  // Validate trigger config based on type
  const configError = validateTriggerConfig(input.trigger_type, input.trigger_config);
  if (configError) {
    return { error: configError };
  }

  const { data, error } = await supabase
    .from('settlement_rules')
    .insert({
      tenant_id: input.tenant_id,
      wallet_id: input.wallet_id,
      name: input.name,
      description: input.description,
      trigger_type: input.trigger_type,
      trigger_config: input.trigger_config,
      settlement_rail: input.settlement_rail || 'auto',
      settlement_priority: input.settlement_priority || 'standard',
      minimum_amount: input.minimum_amount,
      minimum_currency: input.minimum_currency,
      maximum_amount: input.maximum_amount,
      maximum_currency: input.maximum_currency,
      enabled: input.enabled ?? true,
      priority: input.priority ?? 100,
      metadata: input.metadata,
    })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      return { error: 'A rule with this name already exists' };
    }
    console.error('[Settlement Triggers] Error creating rule:', error);
    return { error: error.message };
  }

  console.log(`[Settlement Triggers] Created rule "${input.name}" for tenant ${input.tenant_id}`);
  return { data: data as SettlementRule };
}

/**
 * Update a settlement rule
 */
export async function updateSettlementRule(
  supabase: SupabaseClient,
  tenantId: string,
  ruleId: string,
  updates: UpdateRuleInput
): Promise<{ data?: SettlementRule; error?: string }> {
  // First verify rule exists and belongs to tenant
  const { error: checkError } = await getSettlementRule(supabase, tenantId, ruleId);
  if (checkError) {
    return { error: checkError };
  }

  const { data, error } = await supabase
    .from('settlement_rules')
    .update(updates)
    .eq('id', ruleId)
    .eq('tenant_id', tenantId)
    .select()
    .single();

  if (error) {
    console.error('[Settlement Triggers] Error updating rule:', error);
    return { error: error.message };
  }

  console.log(`[Settlement Triggers] Updated rule ${ruleId}`);
  return { data: data as SettlementRule };
}

/**
 * Delete a settlement rule
 */
export async function deleteSettlementRule(
  supabase: SupabaseClient,
  tenantId: string,
  ruleId: string
): Promise<{ success: boolean; error?: string }> {
  const { error } = await supabase
    .from('settlement_rules')
    .delete()
    .eq('id', ruleId)
    .eq('tenant_id', tenantId);

  if (error) {
    console.error('[Settlement Triggers] Error deleting rule:', error);
    return { success: false, error: error.message };
  }

  console.log(`[Settlement Triggers] Deleted rule ${ruleId}`);
  return { success: true };
}

// ============================================
// Execution History
// ============================================

/**
 * Get rule executions
 */
export async function getRuleExecutions(
  supabase: SupabaseClient,
  tenantId: string,
  filters: ExecutionFilters
): Promise<{ data: SettlementRuleExecution[]; total: number; error?: string }> {
  let query = supabase
    .from('settlement_rule_executions')
    .select('*', { count: 'exact' })
    .eq('tenant_id', tenantId)
    .order('started_at', { ascending: false });

  if (filters.rule_id) {
    query = query.eq('rule_id', filters.rule_id);
  }

  if (filters.status) {
    query = query.eq('status', filters.status);
  }

  query = query.range(filters.offset, filters.offset + filters.limit - 1);

  const { data, count, error } = await query;

  if (error) {
    console.error('[Settlement Triggers] Error fetching executions:', error);
    return { data: [], total: 0, error: error.message };
  }

  return { data: data as SettlementRuleExecution[], total: count || 0 };
}

// ============================================
// Trigger Evaluation Engine
// ============================================

/**
 * Evaluate all scheduled rules (called by cron worker)
 */
export async function evaluateScheduledRules(
  supabase: SupabaseClient,
  environment: 'test' | 'live' = 'test'
): Promise<{ processed: number; triggered: number }> {
  // Get all enabled schedule rules
  const { data: rules, error } = await supabase
    .from('settlement_rules')
    .select('*, tenants!inner(id)')
    .eq('trigger_type', 'schedule')
    .eq('enabled', true);

  if (error || !rules) {
    console.error('[Settlement Triggers] Error fetching scheduled rules:', error);
    return { processed: 0, triggered: 0 };
  }

  let triggered = 0;

  for (const rule of rules) {
    const config = rule.trigger_config as ScheduleConfig;

    // Check if cron matches current time
    if (shouldTriggerCron(config.cron)) {
      const result = await executeRule(supabase, rule as SettlementRule, 'schedule', {
        cron: config.cron,
        triggered_at: new Date().toISOString(),
      });

      if (result.success) {
        triggered++;
      }
    }
  }

  console.log(`[Settlement Triggers] Processed ${rules.length} scheduled rules, triggered ${triggered}`);
  return { processed: rules.length, triggered };
}

/**
 * Evaluate threshold rules for a wallet balance change
 */
export async function evaluateThresholdRules(
  supabase: SupabaseClient,
  tenantId: string,
  walletId: string,
  currentBalance: number,
  currency: string,
  environment: 'test' | 'live' = 'test'
): Promise<{ triggered: boolean; executions: string[] }> {
  // Use database function to find applicable threshold rules
  const { data: rules, error } = await supabase
    .rpc('check_threshold_rules', {
      p_tenant_id: tenantId,
      p_wallet_id: walletId,
      p_balance: currentBalance,
      p_currency: currency,
    });

  if (error || !rules || rules.length === 0) {
    return { triggered: false, executions: [] };
  }

  const executions: string[] = [];

  for (const ruleInfo of rules) {
    // Get full rule
    const { data: rule } = await getSettlementRule(supabase, tenantId, ruleInfo.rule_id);
    if (!rule) continue;

    const result = await executeRule(supabase, rule, 'threshold_exceeded', {
      balance: currentBalance,
      threshold: ruleInfo.threshold_amount,
      currency,
      wallet_id: walletId,
    });

    if (result.execution_id) {
      executions.push(result.execution_id);
    }
  }

  return { triggered: executions.length > 0, executions };
}

/**
 * Evaluate immediate rules for a transfer
 */
export async function evaluateImmediateRules(
  supabase: SupabaseClient,
  tenantId: string,
  walletId: string,
  transferType: string,
  transferId: string,
  amount: number,
  currency: string,
  environment: 'test' | 'live' = 'test'
): Promise<{ triggered: boolean; execution_id?: string }> {
  // Find applicable immediate rules
  const { data: rules } = await supabase
    .rpc('find_applicable_settlement_rules', {
      p_tenant_id: tenantId,
      p_wallet_id: walletId,
      p_transfer_type: transferType,
    });

  if (!rules || rules.length === 0) {
    return { triggered: false };
  }

  // Find the first immediate rule that matches
  const immediateRule = rules.find(
    (r: SettlementRule) => r.trigger_type === 'immediate'
  );

  if (!immediateRule) {
    return { triggered: false };
  }

  const result = await executeRule(supabase, immediateRule, 'immediate', {
    transfer_id: transferId,
    transfer_type: transferType,
    amount,
    currency,
    wallet_id: walletId,
  });

  return { triggered: result.success, execution_id: result.execution_id };
}

/**
 * Request a manual settlement/withdrawal
 */
export async function requestManualSettlement(
  supabase: SupabaseClient,
  tenantId: string,
  walletId: string,
  amount: number,
  currency: string,
  environment: 'test' | 'live' = 'test'
): Promise<{
  success: boolean;
  execution_id?: string;
  settlement_id?: string;
  amount?: number;
  currency?: string;
  rail?: string;
  error?: string;
}> {
  // Find manual withdrawal rule for this tenant
  const { data: rules } = await getSettlementRules(supabase, tenantId, {
    trigger_type: 'manual',
    enabled_only: true,
    wallet_id: walletId,
  });

  const rule = rules.find((r) => r.trigger_type === 'manual');

  if (!rule) {
    return { success: false, error: 'No manual withdrawal rule configured' };
  }

  // Check minimum amount
  if (rule.minimum_amount && amount < rule.minimum_amount) {
    return {
      success: false,
      error: `Amount below minimum (${rule.minimum_amount} ${rule.minimum_currency || currency})`,
    };
  }

  // Check maximum amount
  if (rule.maximum_amount && amount > rule.maximum_amount) {
    return {
      success: false,
      error: `Amount exceeds maximum (${rule.maximum_amount} ${rule.maximum_currency || currency})`,
    };
  }

  // Verify wallet exists and has sufficient balance
  const { data: wallet, error: walletError } = await supabase
    .from('wallets')
    .select('id, balance, currency')
    .eq('id', walletId)
    .eq('tenant_id', tenantId)
    .eq('environment', environment)
    .single();

  if (walletError || !wallet) {
    return { success: false, error: 'Wallet not found' };
  }

  if (wallet.balance < amount) {
    return { success: false, error: 'Insufficient balance' };
  }

  // Execute the settlement
  const result = await executeRule(supabase, rule, 'manual_request', {
    wallet_id: walletId,
    requested_amount: amount,
    currency,
    wallet_balance: wallet.balance,
  });

  if (!result.success) {
    return { success: false, error: result.error };
  }

  return {
    success: true,
    execution_id: result.execution_id,
    settlement_id: result.settlement_id,
    amount,
    currency,
    rail: rule.settlement_rail,
  };
}

// ============================================
// Core Execution
// ============================================

/**
 * Execute a settlement rule
 */
async function executeRule(
  supabase: SupabaseClient,
  rule: SettlementRule,
  triggerReason: string,
  triggerContext: Record<string, unknown>,
  environment: 'test' | 'live' = 'test'
): Promise<{
  success: boolean;
  execution_id?: string;
  settlement_id?: string;
  error?: string;
}> {
  // Create execution record
  const { data: execution, error: insertError } = await supabase
    .from('settlement_rule_executions')
    .insert({
      tenant_id: rule.tenant_id,
      rule_id: rule.id,
      status: 'pending',
      trigger_reason: triggerReason,
      trigger_context: triggerContext,
    })
    .select()
    .single();

  if (insertError || !execution) {
    console.error('[Settlement Triggers] Failed to create execution:', insertError);
    return { success: false, error: 'Failed to create execution record' };
  }

  const executionId = execution.id;

  try {
    // Update to executing status
    await supabase
      .from('settlement_rule_executions')
      .update({ status: 'executing' })
      .eq('id', executionId);

    // Determine amount to settle
    const walletId = rule.wallet_id || (triggerContext.wallet_id as string);

    let settleAmount: number;
    let settleCurrency: string;

    if (triggerContext.requested_amount) {
      // Manual withdrawal with specific amount
      settleAmount = triggerContext.requested_amount as number;
      settleCurrency = triggerContext.currency as string;
    } else {
      // Get wallet balance for automatic settlement
      const { data: wallet } = await supabase
        .from('wallets')
        .select('balance, currency')
        .eq('id', walletId)
        .eq('tenant_id', rule.tenant_id)
        .eq('environment', environment)
        .single();

      if (!wallet) {
        throw new Error('Wallet not found');
      }

      settleAmount = wallet.balance;
      settleCurrency = wallet.currency;
    }

    // Check minimum threshold
    if (rule.minimum_amount && settleAmount < rule.minimum_amount) {
      await supabase
        .from('settlement_rule_executions')
        .update({
          status: 'skipped',
          completed_at: new Date().toISOString(),
          error_message: `Amount ${settleAmount} below minimum ${rule.minimum_amount}`,
        })
        .eq('id', executionId);

      return { success: true, execution_id: executionId };
    }

    // Cap at maximum if configured
    if (rule.maximum_amount && settleAmount > rule.maximum_amount) {
      settleAmount = rule.maximum_amount;
    }

    // Create a transfer for the settlement
    const { data: transfer, error: transferError } = await supabase
      .from('transfers')
      .insert({
        tenant_id: rule.tenant_id,
        environment,
        type: 'settlement',
        status: 'pending',
        amount: settleAmount,
        currency: settleCurrency,
        from_wallet_id: walletId,
        metadata: {
          rule_id: rule.id,
          execution_id: executionId,
          trigger_reason: triggerReason,
          settlement_rail: rule.settlement_rail,
        },
      })
      .select()
      .single();

    if (transferError || !transfer) {
      throw new Error(`Failed to create transfer: ${transferError?.message}`);
    }

    // Execute settlement via router
    const router = createSettlementRouter(supabase);
    const settlementResult: SettlementResponse = await router.settleTransfer({
      transferId: transfer.id,
      tenantId: rule.tenant_id,
      protocol: 'internal',
      amount: settleAmount,
      currency: settleCurrency,
    });

    // Update execution with result
    await supabase
      .from('settlement_rule_executions')
      .update({
        status: settlementResult.success ? 'completed' : 'failed',
        amount: settleAmount,
        currency: settleCurrency,
        settlement_rail: settlementResult.rail,
        settlement_id: transfer.id,
        completed_at: new Date().toISOString(),
        error_message: settlementResult.error?.message,
        error_code: settlementResult.error?.code,
      })
      .eq('id', executionId);

    console.log(
      `[Settlement Triggers] Executed rule "${rule.name}": ${settleAmount} ${settleCurrency} via ${settlementResult.rail}`
    );

    return {
      success: settlementResult.success,
      execution_id: executionId,
      settlement_id: transfer.id,
    };
  } catch (error: any) {
    console.error(`[Settlement Triggers] Execution failed for rule ${rule.id}:`, error);

    await supabase
      .from('settlement_rule_executions')
      .update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        error_message: error.message,
        error_code: 'EXECUTION_ERROR',
      })
      .eq('id', executionId);

    return { success: false, execution_id: executionId, error: error.message };
  }
}

// ============================================
// Helpers
// ============================================

/**
 * Validate trigger configuration based on type
 */
function validateTriggerConfig(
  triggerType: TriggerType,
  config: Record<string, unknown>
): string | null {
  switch (triggerType) {
    case 'schedule':
      if (!config.cron || typeof config.cron !== 'string') {
        return 'schedule trigger requires "cron" field';
      }
      if (!isValidCron(config.cron as string)) {
        return 'Invalid cron expression';
      }
      break;

    case 'threshold':
      if (typeof config.amount !== 'number' || config.amount <= 0) {
        return 'threshold trigger requires positive "amount" field';
      }
      if (!config.currency || typeof config.currency !== 'string') {
        return 'threshold trigger requires "currency" field';
      }
      break;

    case 'immediate':
      if (!Array.isArray(config.transfer_types) || config.transfer_types.length === 0) {
        return 'immediate trigger requires "transfer_types" array';
      }
      break;

    case 'manual':
      // No validation needed for manual
      break;

    default:
      return `Unknown trigger type: ${triggerType}`;
  }

  return null;
}

/**
 * Check if a cron expression is valid
 */
function isValidCron(cron: string): boolean {
  // Basic cron validation (5 fields: minute hour day month weekday)
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const patterns = [
    /^(\*|[0-5]?\d)$/,           // minute (0-59)
    /^(\*|1?\d|2[0-3])$/,        // hour (0-23)
    /^(\*|[1-9]|[12]\d|3[01])$/, // day (1-31)
    /^(\*|[1-9]|1[0-2])$/,       // month (1-12)
    /^(\*|[0-6])$/,              // weekday (0-6)
  ];

  return parts.every((part, i) => patterns[i].test(part));
}

/**
 * Check if a cron expression should trigger now
 * Note: Simplified implementation - production would use a proper cron library
 */
function shouldTriggerCron(cron: string): boolean {
  const now = new Date();
  const parts = cron.split(/\s+/);

  const [minute, hour, day, month, weekday] = parts;

  const matches = (pattern: string, value: number): boolean => {
    if (pattern === '*') return true;
    return parseInt(pattern, 10) === value;
  };

  return (
    matches(minute, now.getMinutes()) &&
    matches(hour, now.getHours()) &&
    matches(day, now.getDate()) &&
    matches(month, now.getMonth() + 1) &&
    matches(weekday, now.getDay())
  );
}
