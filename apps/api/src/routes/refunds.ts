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
import { createBalanceService } from '../services/balances.js';
import { 
  ValidationError, 
  NotFoundError,
  InsufficientBalanceError,
} from '../middleware/error.js';
import { ErrorCode } from '@sly/types';

const refunds = new Hono();

// ============================================
// VALIDATION SCHEMAS
// ============================================

const createRefundSchema = z.object({
  originalTransferId: z.string().uuid(),
  amount: z.number().positive().optional(), // If not provided, full refund
  reason: z.enum(['duplicate_payment', 'service_not_rendered', 'customer_request', 'error', 'other']),
  reasonDetails: z.string().max(1000).optional(),
});

// ============================================
// GET /v1/refunds - List refunds
// ============================================
refunds.get('/', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();
  
  const query = c.req.query();
  const { page, limit } = getPaginationParams(query);
  const status = query.status;
  const accountId = query.accountId;
  const fromDate = query.fromDate;
  const toDate = query.toDate;
  
  let dbQuery = supabase
    .from('refunds')
    .select('*', { count: 'exact' })
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .order('created_at', { ascending: false })
    .range((page - 1) * limit, page * limit - 1);
  
  if (status) {
    dbQuery = dbQuery.eq('status', status);
  }
  if (accountId && isValidUUID(accountId)) {
    dbQuery = dbQuery.or(`from_account_id.eq.${accountId},to_account_id.eq.${accountId}`);
  }
  if (fromDate) {
    dbQuery = dbQuery.gte('created_at', fromDate);
  }
  if (toDate) {
    dbQuery = dbQuery.lte('created_at', toDate);
  }
  
  const { data, count, error } = await dbQuery;
  
  if (error) {
    console.error('Error fetching refunds:', error);
    throw new Error('Failed to fetch refunds from database');
  }
  
  return c.json(paginationResponse(data || [], count || 0, { page, limit }));
});

// ============================================
// POST /v1/refunds - Create refund
// ============================================
refunds.post('/', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();
  
  // Check for idempotency key
  const idempotencyKey = c.req.header('X-Idempotency-Key');
  
  if (idempotencyKey) {
    const { data: existing } = await supabase
      .from('refunds')
      .select('*')
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .eq('idempotency_key', idempotencyKey)
      .single();
    
    if (existing) {
      return c.json({ data: existing });
    }
  }
  
  let body;
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError('Invalid JSON body');
  }
  
  const parsed = createRefundSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError('Validation failed', parsed.error.flatten());
  }
  
  const { originalTransferId, amount, reason, reasonDetails } = parsed.data;
  
  // Get original transfer
  const { data: transfer, error: transferError } = await supabase
    .from('transfers')
    .select('*')
    .eq('id', originalTransferId)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .eq('status', 'completed')
    .single();
  
  if (transferError || !transfer) {
    throw new NotFoundError('Transfer not found or not refundable', originalTransferId);
  }
  
  // Get tenant settings for refund window
  const { data: settings } = await supabase
    .from('tenant_settings')
    .select('refunds_window_days')
    .eq('tenant_id', ctx.tenantId)
    .single();
  
  const refundWindowDays = settings?.refunds_window_days || 90;
  
  // Check time limit
  const completedAt = new Date(transfer.completed_at);
  const daysSinceTransfer = Math.floor((Date.now() - completedAt.getTime()) / (1000 * 60 * 60 * 24));
  
  if (daysSinceTransfer > refundWindowDays) {
    const error: any = new ValidationError(`Refund window expired (${refundWindowDays} days)`);
    error.code = ErrorCode.REFUND_WINDOW_EXPIRED;
    error.details = {
      transfer_id: originalTransferId,
      completed_at: transfer.completed_at,
      days_since_transfer: daysSinceTransfer,
      window_days: refundWindowDays,
      expired_on: new Date(completedAt.getTime() + refundWindowDays * 24 * 60 * 60 * 1000).toISOString(),
    };
    throw error;
  }
  
  // Calculate refund amount (default to full if not specified)
  const refundAmount = amount || parseFloat(transfer.amount);
  
  // Check for existing refunds
  const { data: existingRefunds } = await supabase
    .from('refunds')
    .select('amount')
    .eq('original_transfer_id', originalTransferId)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .eq('status', 'completed');
  
  const totalRefunded = existingRefunds?.reduce((sum, r) => sum + parseFloat(r.amount), 0) || 0;
  const transferAmount = parseFloat(transfer.amount);
  
  if (totalRefunded + refundAmount > transferAmount) {
    const error: any = new ValidationError(
      `Refund amount exceeds remaining refundable amount`
    );
    error.code = ErrorCode.REFUND_EXCEEDS_ORIGINAL;
    error.details = {
      transfer_id: originalTransferId,
      original_amount: transferAmount.toString(),
      already_refunded: totalRefunded.toString(),
      requested_amount: refundAmount.toString(),
      remaining_refundable: (transferAmount - totalRefunded).toString(),
      currency: transfer.currency,
    };
    throw error;
  }
  
  // Check source account balance (the account that received the original transfer)
  const balanceService = createBalanceService(supabase);
  const sourceBalance = await balanceService.getBalance(transfer.to_account_id);
  
  if (sourceBalance.available < refundAmount) {
    throw new InsufficientBalanceError(
      transfer.to_account_id,
      sourceBalance.available.toString(),
      refundAmount.toString(),
      transfer.currency
    );
  }
  
  // Create refund record
  const { data: refund, error: createError } = await supabase
    .from('refunds')
    .insert({
      tenant_id: ctx.tenantId,
      environment: getEnv(ctx),
      original_transfer_id: originalTransferId,
      amount: refundAmount,
      currency: transfer.currency,
      reason,
      reason_details: reasonDetails,
      from_account_id: transfer.to_account_id,  // Reverse direction
      to_account_id: transfer.from_account_id,  // Reverse direction
      idempotency_key: idempotencyKey,
      status: 'pending',
    })
    .select()
    .single();
  
  if (createError) {
    console.error('Error creating refund:', createError);
    throw new Error('Failed to create refund in database');
  }
  
  // Process refund (reverse the transfer)
  try {
    await balanceService.transfer(
      transfer.to_account_id,  // From: original recipient
      transfer.from_account_id, // To: original sender
      refundAmount,
      'refund',
      refund.id,
      `Refund: ${reasonDetails || reason}`
    );
    
    // Update refund status
    await supabase
      .from('refunds')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
      })
      .eq('id', refund.id);
    
    refund.status = 'completed';
    refund.completed_at = new Date().toISOString();
    
    // Audit log
    await logAudit(supabase, {
      tenantId: ctx.tenantId,
      entityType: 'refund',
      entityId: refund.id,
      action: 'completed',
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      actorName: ctx.actorName,
      metadata: {
        originalTransferId,
        amount: refundAmount,
        reason,
      },
    });
    
  } catch (error: any) {
    // Mark refund as failed
    await supabase
      .from('refunds')
      .update({
        status: 'failed',
        failed_at: new Date().toISOString(),
        failure_reason: error.message,
      })
      .eq('id', refund.id);
    
    throw error;
  }
  
  return c.json({ 
    data: refund,
    links: {
      self: `/v1/refunds/${refund.id}`,
      original_transfer: `/v1/transfers/${originalTransferId}`,
      from_account: `/v1/accounts/${refund.from_account_id}`,
      to_account: `/v1/accounts/${refund.to_account_id}`,
    },
    next_actions: [
      {
        action: 'view_original_transfer',
        description: 'View the original transfer that was refunded',
        endpoint: `/v1/transfers/${originalTransferId}`,
      },
      {
        action: 'check_balance',
        description: 'Check updated account balance',
        endpoint: `/v1/accounts/${refund.to_account_id}/balances`,
      },
    ],
  }, 201);
});

// ============================================
// GET /v1/refunds/:id - Get single refund
// ============================================
refunds.get('/:id', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();
  const refundId = c.req.param('id');
  
  if (!isValidUUID(refundId)) {
    throw new ValidationError('Invalid refund ID format');
  }
  
  const { data: refund, error } = await supabase
    .from('refunds')
    .select('*')
    .eq('id', refundId)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();
  
  if (error || !refund) {
    throw new NotFoundError('Refund', refundId);
  }
  
  return c.json({ 
    data: refund,
    links: {
      self: `/v1/refunds/${refundId}`,
      original_transfer: `/v1/transfers/${refund.original_transfer_id}`,
      from_account: `/v1/accounts/${refund.from_account_id}`,
      to_account: `/v1/accounts/${refund.to_account_id}`,
    },
  });
});

export default refunds;

