import { Hono } from 'hono';
import { z } from 'zod';
import { createClient } from '../db/client.js';
import {
  logAudit,
  isValidUUID,
  getPaginationParams,
  paginationResponse,
  getEnv,
} from '../utils/helpers.js';
import { ValidationError, NotFoundError } from '../middleware/error.js';
import { ErrorCode } from '@sly/types';

const disputes = new Hono();

// ============================================
// VALIDATION SCHEMAS
// ============================================

const createDisputeSchema = z.object({
  transferId: z.string().uuid(),
  reason: z.enum([
    'service_not_received',
    'duplicate_charge',
    'unauthorized',
    'amount_incorrect',
    'quality_issue',
    'other',
  ]),
  description: z.string().max(2000),
  amountDisputed: z.number().positive().optional(), // Full amount if not specified
  requestedResolution: z.enum(['full_refund', 'partial_refund', 'credit', 'other']).optional(),
  requestedAmount: z.number().positive().optional(),
  evidence: z.array(z.object({
    type: z.enum(['receipt', 'communication', 'screenshot', 'contract', 'other']),
    description: z.string().max(500),
    url: z.string().url().optional(),
    content: z.string().optional(),
  })).optional(),
});

const respondDisputeSchema = z.object({
  response: z.string().max(2000),
  evidence: z.array(z.object({
    type: z.enum(['receipt', 'communication', 'screenshot', 'contract', 'delivery_proof', 'other']),
    description: z.string().max(500),
    url: z.string().url().optional(),
    content: z.string().optional(),
  })).optional(),
  acceptClaim: z.boolean().optional(),
  counterOffer: z.object({
    resolution: z.enum(['full_refund', 'partial_refund', 'credit', 'no_action']),
    amount: z.number().positive().optional(),
    notes: z.string().max(1000).optional(),
  }).optional(),
});

const resolveDisputeSchema = z.object({
  resolution: z.enum(['refund_issued', 'partial_refund', 'no_action', 'credit_issued']),
  resolutionAmount: z.number().nonnegative().optional(),
  resolutionNotes: z.string().max(2000).optional(),
  issueRefund: z.boolean().optional(), // Auto-create refund if resolution involves refund
});

// ============================================
// GET /v1/disputes - List disputes
// ============================================
disputes.get('/', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();
  
  const query = c.req.query();
  const { page, limit } = getPaginationParams(query);
  const status = query.status;
  const accountId = query.accountId;
  const transferId = query.transferId;
  const reason = query.reason;
  const dueSoon = query.dueSoon === 'true';
  
  let dbQuery = supabase
    .from('disputes')
    .select('*', { count: 'exact' })
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .order('created_at', { ascending: false })
    .range((page - 1) * limit, page * limit - 1);
  
  if (status) {
    dbQuery = dbQuery.eq('status', status);
  }
  if (accountId && isValidUUID(accountId)) {
    dbQuery = dbQuery.or(`claimant_account_id.eq.${accountId},respondent_account_id.eq.${accountId}`);
  }
  if (transferId && isValidUUID(transferId)) {
    dbQuery = dbQuery.eq('transfer_id', transferId);
  }
  if (reason) {
    dbQuery = dbQuery.eq('reason', reason);
  }
  if (dueSoon) {
    // Due within 7 days and not resolved
    const sevenDaysFromNow = new Date();
    sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7);
    dbQuery = dbQuery
      .lte('due_date', sevenDaysFromNow.toISOString())
      .in('status', ['open', 'under_review']);
  }
  
  const { data, count, error } = await dbQuery;
  
  if (error) {
    console.error('Error fetching disputes:', error);
    throw new Error('Failed to fetch disputes from database');
  }
  
  // Transform to API response format
  const disputes = (data || []).map(row => ({
    id: row.id,
    transferId: row.transfer_id,
    status: row.status,
    reason: row.reason,
    description: row.description,
    claimant: {
      accountId: row.claimant_account_id,
      accountName: row.claimant_account_name,
    },
    respondent: {
      accountId: row.respondent_account_id,
      accountName: row.respondent_account_name,
    },
    amountDisputed: parseFloat(row.amount_disputed),
    requestedResolution: row.requested_resolution,
    requestedAmount: row.requested_amount ? parseFloat(row.requested_amount) : null,
    resolution: row.resolution,
    resolutionAmount: row.resolution_amount ? parseFloat(row.resolution_amount) : null,
    resolutionNotes: row.resolution_notes,
    refundId: row.refund_id,
    dueDate: row.due_date,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
  
  return c.json(paginationResponse(disputes, count || 0, { page, limit }));
});

// ============================================
// POST /v1/disputes - Create dispute
// ============================================
disputes.post('/', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();
  
  let body;
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError('Invalid JSON body');
  }
  
  const parsed = createDisputeSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError('Validation failed', parsed.error.flatten());
  }
  
  const {
    transferId,
    reason,
    description,
    amountDisputed,
    requestedResolution,
    requestedAmount,
    evidence,
  } = parsed.data;
  
  // Get original transfer
  const { data: transfer, error: transferError } = await supabase
    .from('transfers')
    .select('*')
    .eq('id', transferId)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();
  
  if (transferError || !transfer) {
    throw new NotFoundError('Transfer', transferId);
  }
  
  // Check if transfer is completed
  if (transfer.status !== 'completed') {
    const error: any = new ValidationError('Only completed transfers can be disputed');
    error.code = ErrorCode.TRANSFER_NOT_COMPLETED;
    error.details = {
      transfer_id: transferId,
      current_status: transfer.status,
      required_status: 'completed',
    };
    throw error;
  }
  
  // Get tenant settings for dispute windows
  const { data: settings } = await supabase
    .from('tenant_settings')
    .select('disputes_filing_window_days, disputes_response_window_days')
    .eq('tenant_id', ctx.tenantId)
    .single();
  
  const filingWindowDays = settings?.disputes_filing_window_days || 120;
  const responseWindowDays = settings?.disputes_response_window_days || 30;
  
  // Check filing window
  const completedAt = new Date(transfer.completed_at);
  const daysSinceTransfer = Math.floor((Date.now() - completedAt.getTime()) / (1000 * 60 * 60 * 1000));
  
  if (daysSinceTransfer > filingWindowDays) {
    const error: any = new ValidationError(`Dispute filing window expired`);
    error.code = ErrorCode.DISPUTE_WINDOW_EXPIRED;
    error.details = {
      transfer_id: transferId,
      completed_at: transfer.completed_at,
      days_since_transfer: daysSinceTransfer,
      filing_window_days: filingWindowDays,
      expired_on: new Date(completedAt.getTime() + filingWindowDays * 24 * 60 * 60 * 1000).toISOString(),
    };
    throw error;
  }
  
  // Check for existing open dispute on this transfer
  const { data: existingDispute } = await supabase
    .from('disputes')
    .select('id, status, due_date')
    .eq('transfer_id', transferId)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .in('status', ['open', 'under_review'])
    .single();
  
  if (existingDispute) {
    const error: any = new ValidationError('An open dispute already exists for this transfer');
    error.code = ErrorCode.DISPUTE_ALREADY_EXISTS;
    error.details = {
      transfer_id: transferId,
      existing_dispute_id: existingDispute.id,
      dispute_status: existingDispute.status,
      due_date: existingDispute.due_date,
    };
    throw error;
  }
  
  // Calculate dispute amount (default to full transfer amount)
  const disputeAmount = amountDisputed || parseFloat(transfer.amount);
  
  if (disputeAmount > parseFloat(transfer.amount)) {
    const error: any = new ValidationError('Disputed amount cannot exceed transfer amount');
    error.details = {
      transfer_id: transferId,
      transfer_amount: parseFloat(transfer.amount),
      disputed_amount: disputeAmount,
      currency: transfer.currency,
    };
    throw error;
  }
  
  // Calculate due date (response window from now)
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + responseWindowDays);
  
  // Determine claimant and respondent
  // The payer (from_account) is typically the claimant
  const claimantAccountId = transfer.from_account_id;
  const respondentAccountId = transfer.to_account_id;
  
  // Create dispute
  const { data: dispute, error: createError } = await supabase
    .from('disputes')
    .insert({
      tenant_id: ctx.tenantId,
      environment: getEnv(ctx),
      transfer_id: transferId,
      status: 'open',
      reason,
      description,
      claimant_account_id: claimantAccountId,
      claimant_account_name: transfer.from_account_name,
      respondent_account_id: respondentAccountId,
      respondent_account_name: transfer.to_account_name,
      amount_disputed: disputeAmount,
      requested_resolution: requestedResolution,
      requested_amount: requestedAmount,
      claimant_evidence: evidence || [],
      respondent_evidence: [],
      due_date: dueDate.toISOString(),
      filing_window_days: filingWindowDays,
      response_window_days: responseWindowDays,
    })
    .select()
    .single();
  
  if (createError) {
    console.error('Error creating dispute:', createError);
    throw new Error('Failed to create dispute in database');
  }
  
  // Audit log
  await logAudit(supabase, {
    tenantId: ctx.tenantId,
    entityType: 'dispute',
    entityId: dispute.id,
    action: 'created',
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    actorName: ctx.actorName,
    metadata: {
      transferId,
      reason,
      amountDisputed: disputeAmount,
    },
  });
  
  return c.json({
    data: {
      id: dispute.id,
      transferId: dispute.transfer_id,
      status: dispute.status,
      reason: dispute.reason,
      description: dispute.description,
      claimant: {
        accountId: dispute.claimant_account_id,
        accountName: dispute.claimant_account_name,
      },
      respondent: {
        accountId: dispute.respondent_account_id,
        accountName: dispute.respondent_account_name,
      },
      amountDisputed: parseFloat(dispute.amount_disputed),
      requestedResolution: dispute.requested_resolution,
      requestedAmount: dispute.requested_amount ? parseFloat(dispute.requested_amount) : null,
      dueDate: dispute.due_date,
      createdAt: dispute.created_at,
    },
    links: {
      self: `/v1/disputes/${dispute.id}`,
      transfer: `/v1/transfers/${transferId}`,
      claimant_account: `/v1/accounts/${dispute.claimant_account_id}`,
      respondent_account: `/v1/accounts/${dispute.respondent_account_id}`,
    },
    next_actions: [
      {
        action: 'add_evidence',
        description: 'Add supporting evidence to strengthen your case',
        endpoint: `/v1/disputes/${dispute.id}/evidence`,
        method: 'POST',
      },
      {
        action: 'check_status',
        description: 'Monitor dispute resolution progress',
        endpoint: `/v1/disputes/${dispute.id}`,
        due_date: dispute.due_date,
      },
    ],
  }, 201);
});

// ============================================
// GET /v1/disputes/:id - Get single dispute
// ============================================
disputes.get('/:id', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();
  const disputeId = c.req.param('id');
  
  if (!isValidUUID(disputeId)) {
    throw new ValidationError('Invalid dispute ID format');
  }
  
  const { data: dispute, error } = await supabase
    .from('disputes')
    .select('*')
    .eq('id', disputeId)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();

  if (error || !dispute) {
    throw new NotFoundError('Dispute', disputeId);
  }

  // Get timeline events from audit log
  const { data: timeline } = await supabase
    .from('audit_log')
    .select('action, actor_type, actor_name, metadata, created_at')
    .eq('entity_type', 'dispute')
    .eq('entity_id', disputeId)
    .order('created_at', { ascending: true });
  
  return c.json({
    data: {
      id: dispute.id,
      transferId: dispute.transfer_id,
      status: dispute.status,
      reason: dispute.reason,
      description: dispute.description,
      claimant: {
        accountId: dispute.claimant_account_id,
        accountName: dispute.claimant_account_name,
      },
      respondent: {
        accountId: dispute.respondent_account_id,
        accountName: dispute.respondent_account_name,
      },
      amountDisputed: parseFloat(dispute.amount_disputed),
      requestedResolution: dispute.requested_resolution,
      requestedAmount: dispute.requested_amount ? parseFloat(dispute.requested_amount) : null,
      claimantEvidence: dispute.claimant_evidence,
      respondentEvidence: dispute.respondent_evidence,
      resolution: dispute.resolution,
      resolutionAmount: dispute.resolution_amount ? parseFloat(dispute.resolution_amount) : null,
      resolutionNotes: dispute.resolution_notes,
      refundId: dispute.refund_id,
      dueDate: dispute.due_date,
      resolvedAt: dispute.resolved_at,
      createdAt: dispute.created_at,
      updatedAt: dispute.updated_at,
      timeline: (timeline || []).map(event => ({
        action: event.action,
        actorType: event.actor_type,
        actorName: event.actor_name,
        metadata: event.metadata,
        timestamp: event.created_at,
      })),
    },
  });
});

// ============================================
// POST /v1/disputes/:id/respond - Submit response
// ============================================
disputes.post('/:id/respond', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();
  const disputeId = c.req.param('id');
  
  if (!isValidUUID(disputeId)) {
    throw new ValidationError('Invalid dispute ID format');
  }
  
  // Get dispute
  const { data: dispute, error: fetchError } = await supabase
    .from('disputes')
    .select('*')
    .eq('id', disputeId)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();

  if (fetchError || !dispute) {
    throw new NotFoundError('Dispute', disputeId);
  }

  // Check if dispute is open for responses
  if (dispute.status !== 'open') {
    throw new ValidationError('Dispute is not open for responses');
  }
  
  // Check if response deadline has passed
  if (new Date(dispute.due_date) < new Date()) {
    throw new ValidationError('Response deadline has passed');
  }
  
  let body;
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError('Invalid JSON body');
  }
  
  const parsed = respondDisputeSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError('Validation failed', parsed.error.flatten());
  }
  
  const { response, evidence, acceptClaim, counterOffer } = parsed.data;
  
  // Update dispute with response
  const existingEvidence = dispute.respondent_evidence || [];
  const newEvidence = evidence || [];
  
  const updates: any = {
    status: 'under_review',
    respondent_evidence: [...existingEvidence, ...newEvidence],
    respondent_response: response,
    updated_at: new Date().toISOString(),
  };
  
  if (acceptClaim) {
    updates.respondent_accepted_claim = true;
  }
  
  if (counterOffer) {
    updates.counter_offer = counterOffer;
  }
  
  const { data: updated, error: updateError } = await supabase
    .from('disputes')
    .update(updates)
    .eq('id', disputeId)
    .eq('environment', getEnv(ctx))
    .select()
    .single();

  if (updateError) {
    console.error('Error updating dispute:', updateError);
    return c.json({ error: 'Failed to submit response' }, 500);
  }
  
  // Audit log
  await logAudit(supabase, {
    tenantId: ctx.tenantId,
    entityType: 'dispute',
    entityId: disputeId,
    action: 'evidence_submitted',
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    actorName: ctx.actorName,
    metadata: {
      acceptedClaim: acceptClaim,
      hasCounterOffer: !!counterOffer,
      evidenceCount: newEvidence.length,
    },
  });
  
  return c.json({
    data: {
      id: updated.id,
      status: updated.status,
      message: 'Response submitted successfully',
    },
  });
});

// ============================================
// POST /v1/disputes/:id/resolve - Resolve dispute
// ============================================
disputes.post('/:id/resolve', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();
  const disputeId = c.req.param('id');
  
  if (!isValidUUID(disputeId)) {
    throw new ValidationError('Invalid dispute ID format');
  }
  
  // Get dispute
  const { data: dispute, error: fetchError } = await supabase
    .from('disputes')
    .select('*')
    .eq('id', disputeId)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();

  if (fetchError || !dispute) {
    throw new NotFoundError('Dispute', disputeId);
  }

  // Check if dispute can be resolved
  if (dispute.status === 'resolved') {
    throw new ValidationError('Dispute is already resolved');
  }
  
  let body;
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError('Invalid JSON body');
  }
  
  const parsed = resolveDisputeSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError('Validation failed', parsed.error.flatten());
  }
  
  const { resolution, resolutionAmount, resolutionNotes, issueRefund } = parsed.data;
  
  // Validate resolution amount for refund resolutions
  if ((resolution === 'refund_issued' || resolution === 'partial_refund') && !resolutionAmount) {
    throw new ValidationError('Resolution amount required for refund resolutions');
  }
  
  if (resolutionAmount && resolutionAmount > parseFloat(dispute.amount_disputed)) {
    throw new ValidationError('Resolution amount cannot exceed disputed amount');
  }
  
  const updates: any = {
    status: 'resolved',
    resolution,
    resolution_amount: resolutionAmount || null,
    resolution_notes: resolutionNotes || null,
    resolved_at: new Date().toISOString(),
    resolved_by_type: ctx.actorType,
    resolved_by_id: ctx.actorId,
    resolved_by_name: ctx.actorName,
    updated_at: new Date().toISOString(),
  };
  
  // Create refund if requested and resolution involves refund
  let refundId = null;
  if (issueRefund && (resolution === 'refund_issued' || resolution === 'partial_refund')) {
    // Get original transfer for refund
    const { data: transfer } = await supabase
      .from('transfers')
      .select('*')
      .eq('id', dispute.transfer_id)
      .single();
    
    if (transfer) {
      // Create refund record (simplified - in production would call refund service)
      const { data: refund, error: refundError } = await supabase
        .from('refunds')
        .insert({
          tenant_id: ctx.tenantId,
          environment: getEnv(ctx),
          original_transfer_id: dispute.transfer_id,
          amount: resolutionAmount,
          currency: transfer.currency,
          reason: 'dispute_resolution',
          reason_details: `Dispute ${disputeId}: ${resolution}`,
          from_account_id: transfer.to_account_id,
          to_account_id: transfer.from_account_id,
          status: 'pending',
          dispute_id: disputeId,
        })
        .select()
        .single();
      
      if (!refundError && refund) {
        refundId = refund.id;
        updates.refund_id = refundId;
      }
    }
  }
  
  const { data: updated, error: updateError } = await supabase
    .from('disputes')
    .update(updates)
    .eq('id', disputeId)
    .eq('environment', getEnv(ctx))
    .select()
    .single();

  if (updateError) {
    console.error('Error resolving dispute:', updateError);
    return c.json({ error: 'Failed to resolve dispute' }, 500);
  }
  
  // Audit log
  await logAudit(supabase, {
    tenantId: ctx.tenantId,
    entityType: 'dispute',
    entityId: disputeId,
    action: 'resolved',
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    actorName: ctx.actorName,
    metadata: {
      resolution,
      resolutionAmount,
      refundId,
    },
  });
  
  return c.json({
    data: {
      id: updated.id,
      status: updated.status,
      resolution: updated.resolution,
      resolutionAmount: updated.resolution_amount ? parseFloat(updated.resolution_amount) : null,
      resolvedAt: updated.resolved_at,
      refundId,
    },
  });
});

// ============================================
// POST /v1/disputes/:id/escalate - Escalate dispute
// ============================================
disputes.post('/:id/escalate', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();
  const disputeId = c.req.param('id');
  
  if (!isValidUUID(disputeId)) {
    throw new ValidationError('Invalid dispute ID format');
  }
  
  const { data: dispute, error: fetchError } = await supabase
    .from('disputes')
    .select('*')
    .eq('id', disputeId)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();

  if (fetchError || !dispute) {
    throw new NotFoundError('Dispute', disputeId);
  }

  if (dispute.status === 'resolved') {
    throw new ValidationError('Cannot escalate a resolved dispute');
  }
  
  if (dispute.status === 'escalated') {
    throw new ValidationError('Dispute is already escalated');
  }
  
  const { data: updated, error: updateError } = await supabase
    .from('disputes')
    .update({
      status: 'escalated',
      escalated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', disputeId)
    .eq('environment', getEnv(ctx))
    .select()
    .single();

  if (updateError) {
    console.error('Error escalating dispute:', updateError);
    return c.json({ error: 'Failed to escalate dispute' }, 500);
  }
  
  await logAudit(supabase, {
    tenantId: ctx.tenantId,
    entityType: 'dispute',
    entityId: disputeId,
    action: 'escalated',
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    actorName: ctx.actorName,
  });
  
  return c.json({
    data: {
      id: updated.id,
      status: updated.status,
      escalatedAt: updated.escalated_at,
    },
  });
});

// ============================================
// GET /v1/disputes/stats - Get dispute statistics
// ============================================
disputes.get('/stats/summary', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();
  
  // Get all disputes for stats
  const { data: allDisputes, error } = await supabase
    .from('disputes')
    .select('status, reason, amount_disputed, resolution, created_at, resolved_at')
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx));
  
  if (error) {
    console.error('Error fetching dispute stats:', error);
    return c.json({ error: 'Failed to fetch statistics' }, 500);
  }
  
  const disputes = allDisputes || [];
  
  // Calculate stats
  const totalDisputes = disputes.length;
  const openDisputes = disputes.filter(d => d.status === 'open').length;
  const underReview = disputes.filter(d => d.status === 'under_review').length;
  const escalated = disputes.filter(d => d.status === 'escalated').length;
  const resolved = disputes.filter(d => d.status === 'resolved').length;
  
  const totalAmountDisputed = disputes.reduce((sum, d) => sum + parseFloat(d.amount_disputed), 0);
  
  // By reason breakdown
  const byReason = disputes.reduce((acc: Record<string, number>, d) => {
    acc[d.reason] = (acc[d.reason] || 0) + 1;
    return acc;
  }, {});
  
  // Resolution breakdown
  const byResolution = disputes
    .filter(d => d.resolution)
    .reduce((acc: Record<string, number>, d) => {
      acc[d.resolution!] = (acc[d.resolution!] || 0) + 1;
      return acc;
    }, {});
  
  // Average resolution time (in days)
  const resolvedDisputes = disputes.filter(d => d.resolved_at);
  const avgResolutionDays = resolvedDisputes.length > 0
    ? resolvedDisputes.reduce((sum, d) => {
        const created = new Date(d.created_at).getTime();
        const resolved = new Date(d.resolved_at!).getTime();
        return sum + (resolved - created) / (1000 * 60 * 60 * 24);
      }, 0) / resolvedDisputes.length
    : 0;
  
  return c.json({
    data: {
      total: totalDisputes,
      byStatus: {
        open: openDisputes,
        underReview,
        escalated,
        resolved,
      },
      totalAmountDisputed,
      byReason,
      byResolution,
      averageResolutionDays: Math.round(avgResolutionDays * 10) / 10,
    },
  });
});

export default disputes;

