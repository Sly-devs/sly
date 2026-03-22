import { Hono } from 'hono';
import { z } from 'zod';
import { createClient } from '../db/client.js';
import { createLimitService } from '../services/limits.js';
import {
  logAudit,
  isValidUUID,
  getEnv,
} from '../utils/helpers.js';
import { ValidationError, NotFoundError } from '../middleware/error.js';
import { ErrorCode, ERROR_METADATA } from '@sly/types';

const support = new Hono();

// ============================================
// RESOLUTION OPTIONS BY ERROR CODE
// ============================================

const RESOLUTION_MAP: Record<string, Array<{
  id: string;
  label: string;
  description: string;
  action: string;
  requires_approval: boolean;
  estimated_time: string;
}>> = {
  DAILY_LIMIT_EXCEEDED: [
    { id: 'wait_reset', label: 'Wait for daily reset', description: 'Your daily limit resets at midnight UTC', action: 'wait', requires_approval: false, estimated_time: 'up to 24 hours' },
    { id: 'request_increase', label: 'Request limit increase', description: 'Submit a request to increase your daily limit', action: 'request_limit_increase', requires_approval: true, estimated_time: '1-2 business days' },
    { id: 'split_transaction', label: 'Split transaction', description: 'Break this into smaller transactions across multiple days', action: 'split', requires_approval: false, estimated_time: 'immediate' },
    { id: 'upgrade_kya', label: 'Upgrade KYA tier', description: 'Higher verification tiers unlock higher limits', action: 'upgrade_kya', requires_approval: true, estimated_time: '1-3 business days' },
  ],
  MONTHLY_LIMIT_EXCEEDED: [
    { id: 'wait_reset', label: 'Wait for monthly reset', description: 'Your monthly limit resets on the 1st of each month', action: 'wait', requires_approval: false, estimated_time: 'up to 30 days' },
    { id: 'request_increase', label: 'Request limit increase', description: 'Submit a request to increase your monthly limit', action: 'request_limit_increase', requires_approval: true, estimated_time: '1-2 business days' },
    { id: 'upgrade_kya', label: 'Upgrade KYA tier', description: 'Higher verification tiers unlock higher limits', action: 'upgrade_kya', requires_approval: true, estimated_time: '1-3 business days' },
  ],
  SINGLE_TRANSFER_LIMIT_EXCEEDED: [
    { id: 'split_transaction', label: 'Split transaction', description: 'Break this into smaller transactions within your per-transaction limit', action: 'split', requires_approval: false, estimated_time: 'immediate' },
    { id: 'request_increase', label: 'Request limit increase', description: 'Submit a request to increase your per-transaction limit', action: 'request_limit_increase', requires_approval: true, estimated_time: '1-2 business days' },
  ],
  INSUFFICIENT_BALANCE: [
    { id: 'top_up', label: 'Top up wallet', description: 'Add funds to your wallet to cover the transaction', action: 'top_up', requires_approval: false, estimated_time: 'depends on funding method' },
    { id: 'reduce_amount', label: 'Reduce amount', description: 'Retry with a smaller amount', action: 'reduce_amount', requires_approval: false, estimated_time: 'immediate' },
  ],
  APPROVAL_REQUIRED: [
    { id: 'check_approval', label: 'Check approval status', description: 'This transaction requires approval from an authorized user', action: 'check_approval', requires_approval: false, estimated_time: 'immediate' },
    { id: 'escalate', label: 'Escalate to human', description: 'Contact support to expedite the approval', action: 'escalate_to_human', requires_approval: false, estimated_time: '1-4 hours' },
  ],
  KYC_REQUIRED: [
    { id: 'start_verification', label: 'Start KYC verification', description: 'Complete identity verification to unlock this feature', action: 'start_verification', requires_approval: false, estimated_time: '1-3 business days' },
    { id: 'escalate', label: 'Escalate to human', description: 'Get help with the verification process', action: 'escalate_to_human', requires_approval: false, estimated_time: '1-4 hours' },
  ],
  KYB_REQUIRED: [
    { id: 'start_verification', label: 'Start KYB verification', description: 'Complete business verification to unlock this feature', action: 'start_verification', requires_approval: false, estimated_time: '3-5 business days' },
    { id: 'escalate', label: 'Escalate to human', description: 'Get help with the verification process', action: 'escalate_to_human', requires_approval: false, estimated_time: '1-4 hours' },
  ],
};

const FALLBACK_RESOLUTION = [
  { id: 'escalate', label: 'Escalate to human', description: 'Contact support for assistance with this issue', action: 'escalate_to_human', requires_approval: false, estimated_time: '1-4 hours' },
];

// ============================================
// GET /support/explain-rejection
// ============================================

support.get('/explain-rejection', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();

  const errorCode = c.req.query('error_code');
  const transactionId = c.req.query('transaction_id');
  const agentId = c.req.query('agent_id');

  if (!errorCode && !transactionId && !agentId) {
    throw new ValidationError('At least one of error_code, transaction_id, or agent_id is required');
  }

  let transferInfo: any = null;
  let usageStats: any = null;
  let resolvedErrorCode = errorCode;

  // Look up transfer if transaction_id provided
  if (transactionId) {
    if (!isValidUUID(transactionId)) {
      throw new ValidationError('Invalid transaction_id format');
    }
    const { data: transfer } = await supabase
      .from('transfers')
      .select('id, status, amount, currency, failure_reason, created_at')
      .eq('id', transactionId)
      .eq('tenant_id', ctx.tenantId)
      .single();

    if (transfer) {
      transferInfo = {
        id: transfer.id,
        status: transfer.status,
        amount: parseFloat(transfer.amount),
        currency: transfer.currency,
        failure_reason: transfer.failure_reason,
      };
      // Use failure_reason as error code if not explicitly provided
      if (!resolvedErrorCode && transfer.failure_reason) {
        resolvedErrorCode = transfer.failure_reason;
      }
    }
  }

  // Get agent usage stats if agent_id provided
  if (agentId) {
    if (!isValidUUID(agentId)) {
      throw new ValidationError('Invalid agent_id format');
    }
    try {
      const limitService = createLimitService(supabase, getEnv(ctx) as 'test' | 'live');
      usageStats = await limitService.getUsageStats(agentId);
    } catch {
      // Agent not found or stats unavailable — continue without
    }
  }

  // Build explanation from ERROR_METADATA
  const metadata = resolvedErrorCode
    ? ERROR_METADATA[resolvedErrorCode as ErrorCode]
    : null;

  // Build plain-language explanation
  let explanation: string;
  if (metadata) {
    explanation = metadata.description;
    // Enrich with usage data when available
    if (usageStats && resolvedErrorCode === 'DAILY_LIMIT_EXCEEDED') {
      explanation = `Your daily spending limit of $${usageStats.effectiveLimits.daily.toLocaleString()} has been reached. You've spent $${usageStats.usage.daily.toLocaleString()} today, and this transaction would exceed it. The limit resets at midnight UTC.`;
    } else if (usageStats && resolvedErrorCode === 'MONTHLY_LIMIT_EXCEEDED') {
      explanation = `Your monthly spending limit of $${usageStats.effectiveLimits.monthly.toLocaleString()} has been reached. You've spent $${usageStats.usage.monthly.toLocaleString()} this month. The limit resets on the 1st of next month.`;
    } else if (usageStats && resolvedErrorCode === 'SINGLE_TRANSFER_LIMIT_EXCEEDED') {
      explanation = `This transaction exceeds your per-transaction limit of $${usageStats.effectiveLimits.perTransaction.toLocaleString()}.`;
    }
  } else {
    explanation = resolvedErrorCode
      ? `Transaction was rejected with error code: ${resolvedErrorCode}. Please contact support for more details.`
      : 'Unable to determine the specific rejection reason. Please provide an error code or transaction ID for a detailed explanation.';
  }

  // Build details
  const details: Record<string, any> = {};
  if (usageStats) {
    details.limits = usageStats.effectiveLimits;
    details.usage = usageStats.usage;
    details.kya_tier = usageStats.kyaTier;
  }
  if (transferInfo) {
    details.transaction = transferInfo;
  }
  if (metadata) {
    details.error_code = resolvedErrorCode;
    details.category = metadata.category;
    details.retryable = metadata.retryable;
  }

  // Get resolution options
  const resolutionOptions = resolvedErrorCode
    ? (RESOLUTION_MAP[resolvedErrorCode] || FALLBACK_RESOLUTION)
    : FALLBACK_RESOLUTION;

  return c.json({
    explanation,
    details,
    resolution_options: resolutionOptions,
  });
});

// ============================================
// POST /support/limit-requests
// ============================================

const createLimitRequestSchema = z.object({
  agent_id: z.string().uuid(),
  limit_type: z.enum(['per_transaction', 'daily', 'monthly']),
  requested_amount: z.number().positive(),
  reason: z.string().min(1).max(2000),
  duration: z.enum(['temporary_24h', 'temporary_7d', 'permanent']).optional().default('permanent'),
});

support.post('/limit-requests', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();

  let body;
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError('Invalid JSON body');
  }

  const parsed = createLimitRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError('Validation failed', parsed.error.flatten());
  }

  const { agent_id, limit_type, requested_amount, reason, duration } = parsed.data;

  // Verify agent exists and belongs to tenant
  const { data: agent, error: agentError } = await supabase
    .from('agents')
    .select('id, name, tenant_id')
    .eq('id', agent_id)
    .eq('tenant_id', ctx.tenantId)
    .single();

  if (agentError || !agent) {
    throw new NotFoundError('Agent', agent_id);
  }

  // Get current limits
  const limitService = createLimitService(supabase);
  const stats = await limitService.getUsageStats(agent_id);

  const limitTypeMap: Record<string, number> = {
    per_transaction: stats.effectiveLimits.perTransaction,
    daily: stats.effectiveLimits.daily,
    monthly: stats.effectiveLimits.monthly,
  };
  const currentLimit = limitTypeMap[limit_type] || 0;

  // Check for duplicate pending request
  const { data: existing } = await supabase
    .from('limit_increase_requests')
    .select('id')
    .eq('agent_id', agent_id)
    .eq('limit_type', limit_type)
    .eq('status', 'pending')
    .single();

  if (existing) {
    throw new ValidationError('A pending limit increase request already exists for this agent and limit type');
  }

  // Insert request
  const { data: request, error: insertError } = await supabase
    .from('limit_increase_requests')
    .insert({
      tenant_id: ctx.tenantId,
      agent_id,
      limit_type,
      current_limit: currentLimit,
      requested_amount,
      reason,
      duration,
      status: 'pending',
    })
    .select()
    .single();

  if (insertError) {
    console.error('Error creating limit request:', insertError);
    throw new Error('Failed to create limit increase request');
  }

  await logAudit(supabase, {
    tenantId: ctx.tenantId,
    entityType: 'limit_increase_request',
    entityId: request.id,
    action: 'created',
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    actorName: ctx.actorName,
    metadata: { agent_id, limit_type, requested_amount, duration },
  });

  return c.json({
    id: request.id,
    status: 'pending',
    current_limit: parseFloat(request.current_limit),
    requested_amount: parseFloat(request.requested_amount),
    estimated_response_time: '1-2 business days',
  }, 201);
});

// ============================================
// GET /support/limit-requests/:id
// ============================================

support.get('/limit-requests/:id', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();
  const requestId = c.req.param('id');

  if (!isValidUUID(requestId)) {
    throw new ValidationError('Invalid request ID format');
  }

  const { data: request, error } = await supabase
    .from('limit_increase_requests')
    .select('*')
    .eq('id', requestId)
    .eq('tenant_id', ctx.tenantId)
    .single();

  if (error || !request) {
    throw new NotFoundError('Limit increase request', requestId);
  }

  return c.json({
    id: request.id,
    agent_id: request.agent_id,
    limit_type: request.limit_type,
    current_limit: parseFloat(request.current_limit),
    requested_amount: parseFloat(request.requested_amount),
    reason: request.reason,
    duration: request.duration,
    status: request.status,
    decided_by: request.decided_by,
    decided_at: request.decided_at,
    decision_reason: request.decision_reason,
    expires_at: request.expires_at,
    created_at: request.created_at,
    updated_at: request.updated_at,
  });
});

// ============================================
// POST /support/limit-requests/:id/approve
// ============================================

support.post('/limit-requests/:id/approve', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();
  const requestId = c.req.param('id');

  if (!isValidUUID(requestId)) {
    throw new ValidationError('Invalid request ID format');
  }

  let body: { reason?: string } = {};
  try {
    body = await c.req.json();
  } catch {
    // Optional body
  }

  // Get the request
  const { data: request, error: fetchError } = await supabase
    .from('limit_increase_requests')
    .select('*')
    .eq('id', requestId)
    .eq('tenant_id', ctx.tenantId)
    .single();

  if (fetchError || !request) {
    throw new NotFoundError('Limit increase request', requestId);
  }

  if (request.status !== 'pending') {
    throw new ValidationError(`Request is already ${request.status}`);
  }

  // Update request status
  const { data: updated, error: updateError } = await supabase
    .from('limit_increase_requests')
    .update({
      status: 'approved',
      decided_by: ctx.userId || null,
      decided_at: new Date().toISOString(),
      decision_reason: body.reason || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', requestId)
    .select()
    .single();

  if (updateError) {
    console.error('Error approving limit request:', updateError);
    throw new Error('Failed to approve limit increase request');
  }

  // Apply the new limit via wallet spending_policy update
  const limitFieldMap: Record<string, string> = {
    per_transaction: 'perTransaction',
    daily: 'daily',
    monthly: 'monthly',
  };
  const policyField = limitFieldMap[request.limit_type];

  // Get the agent's wallet
  const { data: wallet } = await supabase
    .from('wallets')
    .select('id, spending_policy')
    .eq('agent_id', request.agent_id)
    .eq('tenant_id', ctx.tenantId)
    .single();

  if (wallet) {
    const existingPolicy = wallet.spending_policy || {};
    const mergedPolicy = {
      ...existingPolicy,
      [policyField]: parseFloat(request.requested_amount),
      // Preserve spend counters
      dailySpent: existingPolicy.dailySpent || 0,
      monthlySpent: existingPolicy.monthlySpent || 0,
      dailyResetAt: existingPolicy.dailyResetAt,
      monthlyResetAt: existingPolicy.monthlyResetAt,
    };

    await supabase
      .from('wallets')
      .update({
        spending_policy: mergedPolicy,
        updated_at: new Date().toISOString(),
      })
      .eq('id', wallet.id)
      .eq('tenant_id', ctx.tenantId);
  }

  await logAudit(supabase, {
    tenantId: ctx.tenantId,
    entityType: 'limit_increase_request',
    entityId: requestId,
    action: 'approved',
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    actorName: ctx.actorName,
    metadata: {
      agent_id: request.agent_id,
      limit_type: request.limit_type,
      new_limit: parseFloat(request.requested_amount),
      reason: body.reason,
    },
  });

  return c.json({
    id: updated.id,
    status: 'approved',
    agent_id: updated.agent_id,
    limit_type: updated.limit_type,
    new_limit: parseFloat(updated.requested_amount),
    decided_at: updated.decided_at,
  });
});

// ============================================
// POST /support/limit-requests/:id/reject
// ============================================

support.post('/limit-requests/:id/reject', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();
  const requestId = c.req.param('id');

  if (!isValidUUID(requestId)) {
    throw new ValidationError('Invalid request ID format');
  }

  let body: { reason?: string } = {};
  try {
    body = await c.req.json();
  } catch {
    // Optional body
  }

  const { data: request, error: fetchError } = await supabase
    .from('limit_increase_requests')
    .select('*')
    .eq('id', requestId)
    .eq('tenant_id', ctx.tenantId)
    .single();

  if (fetchError || !request) {
    throw new NotFoundError('Limit increase request', requestId);
  }

  if (request.status !== 'pending') {
    throw new ValidationError(`Request is already ${request.status}`);
  }

  const { data: updated, error: updateError } = await supabase
    .from('limit_increase_requests')
    .update({
      status: 'rejected',
      decided_by: ctx.userId || null,
      decided_at: new Date().toISOString(),
      decision_reason: body.reason || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', requestId)
    .select()
    .single();

  if (updateError) {
    console.error('Error rejecting limit request:', updateError);
    throw new Error('Failed to reject limit increase request');
  }

  await logAudit(supabase, {
    tenantId: ctx.tenantId,
    entityType: 'limit_increase_request',
    entityId: requestId,
    action: 'rejected',
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    actorName: ctx.actorName,
    metadata: {
      agent_id: request.agent_id,
      limit_type: request.limit_type,
      reason: body.reason,
    },
  });

  return c.json({
    id: updated.id,
    status: 'rejected',
    decision_reason: updated.decision_reason,
    decided_at: updated.decided_at,
  });
});

// ============================================
// POST /support/escalations
// ============================================

const createEscalationSchema = z.object({
  agent_id: z.string().uuid().optional(),
  reason: z.enum(['complex_issue', 'agent_requested', 'security_concern', 'policy_exception', 'bug_report']),
  summary: z.string().min(1).max(5000),
  priority: z.enum(['low', 'medium', 'high', 'critical']).optional().default('medium'),
});

const RESPONSE_TIME_BY_PRIORITY: Record<string, string> = {
  critical: '1 hour',
  high: '4 hours',
  medium: '24 hours',
  low: '48 hours',
};

support.post('/escalations', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();

  let body;
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError('Invalid JSON body');
  }

  const parsed = createEscalationSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError('Validation failed', parsed.error.flatten());
  }

  const { agent_id, reason, summary, priority } = parsed.data;

  // Validate agent if provided
  if (agent_id) {
    const { data: agent } = await supabase
      .from('agents')
      .select('id')
      .eq('id', agent_id)
      .eq('tenant_id', ctx.tenantId)
      .single();

    if (!agent) {
      throw new NotFoundError('Agent', agent_id);
    }
  }

  const estimatedResponseTime = RESPONSE_TIME_BY_PRIORITY[priority] || '24 hours';

  const { data: escalation, error: insertError } = await supabase
    .from('support_escalations')
    .insert({
      tenant_id: ctx.tenantId,
      agent_id: agent_id || null,
      reason,
      summary,
      priority,
      status: 'open',
      estimated_response_time: estimatedResponseTime,
    })
    .select()
    .single();

  if (insertError) {
    console.error('Error creating escalation:', insertError);
    throw new Error('Failed to create support escalation');
  }

  await logAudit(supabase, {
    tenantId: ctx.tenantId,
    entityType: 'support_escalation',
    entityId: escalation.id,
    action: 'created',
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    actorName: ctx.actorName,
    metadata: { agent_id, reason, priority },
  });

  return c.json({
    id: escalation.id,
    status: 'open',
    priority,
    estimated_response_time: estimatedResponseTime,
  }, 201);
});

// ============================================
// GET /support/escalations/:id
// ============================================

support.get('/escalations/:id', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();
  const escalationId = c.req.param('id');

  if (!isValidUUID(escalationId)) {
    throw new ValidationError('Invalid escalation ID format');
  }

  const { data: escalation, error } = await supabase
    .from('support_escalations')
    .select('*')
    .eq('id', escalationId)
    .eq('tenant_id', ctx.tenantId)
    .single();

  if (error || !escalation) {
    throw new NotFoundError('Support escalation', escalationId);
  }

  return c.json({
    id: escalation.id,
    agent_id: escalation.agent_id,
    reason: escalation.reason,
    summary: escalation.summary,
    priority: escalation.priority,
    status: escalation.status,
    assigned_to: escalation.assigned_to,
    estimated_response_time: escalation.estimated_response_time,
    resolved_at: escalation.resolved_at,
    resolution_notes: escalation.resolution_notes,
    created_at: escalation.created_at,
    updated_at: escalation.updated_at,
  });
});

export default support;
