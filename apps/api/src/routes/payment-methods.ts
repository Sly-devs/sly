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

const paymentMethods = new Hono();

// Nested router for card transactions
const cardTransactionsRouter = new Hono();

// ============================================
// VALIDATION SCHEMAS
// ============================================

const createPaymentMethodSchema = z.object({
  type: z.enum(['bank_account', 'wallet', 'card']),
  label: z.string().max(100).optional(),
  isDefault: z.boolean().optional().default(false),
  // Bank account fields
  bankCountry: z.string().optional(),
  bankCurrency: z.string().optional(),
  bankAccountLastFour: z.string().length(4).optional(),
  bankRoutingLastFour: z.string().length(4).optional(),
  bankName: z.string().optional(),
  bankAccountHolder: z.string().optional(),
  // Wallet fields
  walletNetwork: z.enum(['base', 'polygon', 'ethereum']).optional(),
  walletAddress: z.string().optional(),
  // Card fields
  cardId: z.string().optional(),
  cardLastFour: z.string().length(4).optional(),
  metadata: z.record(z.any()).optional(),
});

const updatePaymentMethodSchema = z.object({
  label: z.string().max(100).optional(),
  isDefault: z.boolean().optional(),
  metadata: z.record(z.any()).optional(),
});

// ============================================
// GET /payment-methods - List all payment methods for tenant
// ============================================
paymentMethods.get('/', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();

  const typeFilter = c.req.query('type'); // Optional filter: card, bank_account, wallet
  const { page, limit, offset } = getPaginationParams(c);
  const safeOffset = offset || 0; // Ensure offset is never undefined

  let query = supabase
    .from('payment_methods')
    .select('*', { count: 'exact' })
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .order('created_at', { ascending: false })
    .range(safeOffset, safeOffset + limit - 1);

  if (typeFilter) {
    query = query.eq('type', typeFilter);
  }

  const { data, error, count } = await query;

  if (error) {
    throw new Error(`Failed to fetch payment methods: ${error.message}`);
  }

  return c.json({
    data: data || [],
    pagination: paginationResponse(page, limit, count || 0),
  });
});

// ============================================
// GET /payment-methods/:id - Get single payment method
// ============================================
paymentMethods.get('/:id', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();
  const id = c.req.param('id');

  if (!isValidUUID(id)) {
    throw new ValidationError('Invalid payment method ID');
  }

  const { data, error } = await supabase
    .from('payment_methods')
    .select('*')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();

  if (error || !data) {
    throw new NotFoundError('Payment method not found');
  }

  return c.json({ data });
});

// ============================================
// GET /v1/accounts/:accountId/payment-methods - List payment methods
// ============================================
paymentMethods.get('/accounts/:accountId/payment-methods', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();
  const accountId = c.req.param('accountId');

  if (!isValidUUID(accountId)) {
    throw new ValidationError('Invalid account ID format');
  }

  // Verify account belongs to tenant
  const { data: account, error: accountError } = await supabase
    .from('accounts')
    .select('id')
    .eq('id', accountId)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();

  if (accountError || !account) {
    throw new NotFoundError('Account', accountId);
  }

  const { data: methods, error } = await supabase
    .from('payment_methods')
    .select('*')
    .eq('account_id', accountId)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .order('is_default', { ascending: false })
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching payment methods:', error);
    return c.json({ error: 'Failed to fetch payment methods' }, 500);
  }

  return c.json({ data: methods || [] });
});

// ============================================
// POST /v1/accounts/:accountId/payment-methods - Create payment method
// ============================================
paymentMethods.post('/accounts/:accountId/payment-methods', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();
  const accountId = c.req.param('accountId');

  if (!isValidUUID(accountId)) {
    throw new ValidationError('Invalid account ID format');
  }

  // Verify account belongs to tenant
  const { data: account, error: accountError } = await supabase
    .from('accounts')
    .select('id, name')
    .eq('id', accountId)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();

  if (accountError || !account) {
    throw new NotFoundError('Account', accountId);
  }

  let body;
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError('Invalid JSON body');
  }

  const parsed = createPaymentMethodSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError('Validation failed', parsed.error.flatten());
  }

  const {
    type,
    label,
    isDefault,
    bankCountry,
    bankCurrency,
    bankAccountLastFour,
    bankRoutingLastFour,
    bankName,
    bankAccountHolder,
    walletNetwork,
    walletAddress,
    cardId,
    cardLastFour,
    metadata,
  } = parsed.data;

  // Validate type-specific fields
  if (type === 'bank_account') {
    if (!bankAccountLastFour || !bankName) {
      throw new ValidationError('Bank account requires bankAccountLastFour and bankName');
    }
  } else if (type === 'wallet') {
    if (!walletNetwork || !walletAddress) {
      throw new ValidationError('Wallet requires walletNetwork and walletAddress');
    }
  } else if (type === 'card') {
    if (!cardLastFour) {
      throw new ValidationError('Card requires cardLastFour');
    }
  }

  // If setting as default, unset other defaults
  if (isDefault) {
    await supabase
      .from('payment_methods')
      .update({ is_default: false })
      .eq('account_id', accountId)
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx));
  }

  // Create payment method (STUB: no real verification)
  const { data: method, error: createError } = await supabase
    .from('payment_methods')
    .insert({
      tenant_id: ctx.tenantId,
      environment: getEnv(ctx),
      account_id: accountId,
      type,
      label: label || `${type} payment method`,
      is_default: isDefault || false,
      is_verified: false, // STUB: Would require real verification
      bank_country: bankCountry || null,
      bank_currency: bankCurrency || null,
      bank_account_last_four: bankAccountLastFour || null,
      bank_routing_last_four: bankRoutingLastFour || null,
      bank_name: bankName || null,
      bank_account_holder: bankAccountHolder || null,
      wallet_network: walletNetwork || null,
      wallet_address: walletAddress || null,
      card_id: cardId || null,
      card_last_four: cardLastFour || null,
      metadata: metadata || {},
    })
    .select()
    .single();

  if (createError) {
    console.error('Error creating payment method:', createError);
    return c.json({ error: 'Failed to create payment method' }, 500);
  }

  // STUB: In production, trigger verification process here
  // For now, we'll mark it as verified after a delay (mock)
  setTimeout(async () => {
    await supabase
      .from('payment_methods')
      .update({
        is_verified: true,
        verified_at: new Date().toISOString(),
      })
      .eq('id', method.id);
  }, 2000); // Mock 2-second verification delay

  // Audit log
  await logAudit(supabase, {
    tenantId: ctx.tenantId,
    entityType: 'payment_method',
    entityId: method.id,
    action: 'created',
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    actorName: ctx.actorName,
    metadata: {
      type,
      accountId,
    },
  });

  return c.json({ data: method }, 201);
});

// ============================================
// PATCH /v1/payment-methods/:id - Update payment method
// ============================================
paymentMethods.patch('/payment-methods/:id', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();
  const methodId = c.req.param('id');

  if (!isValidUUID(methodId)) {
    throw new ValidationError('Invalid payment method ID format');
  }

  // Verify payment method belongs to tenant
  const { data: method, error: fetchError } = await supabase
    .from('payment_methods')
    .select('*')
    .eq('id', methodId)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();

  if (fetchError || !method) {
    throw new NotFoundError('Payment method', methodId);
  }

  let body;
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError('Invalid JSON body');
  }

  const parsed = updatePaymentMethodSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError('Validation failed', parsed.error.flatten());
  }

  const { label, isDefault, metadata } = parsed.data;

  // If setting as default, unset other defaults
  if (isDefault && !method.is_default) {
    await supabase
      .from('payment_methods')
      .update({ is_default: false })
      .eq('account_id', method.account_id)
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .neq('id', methodId);
  }

  const updates: any = {
    updated_at: new Date().toISOString(),
  };

  if (label !== undefined) updates.label = label;
  if (isDefault !== undefined) updates.is_default = isDefault;
  if (metadata !== undefined) updates.metadata = metadata;

  const { data: updated, error: updateError } = await supabase
    .from('payment_methods')
    .update(updates)
    .eq('id', methodId)
    .eq('environment', getEnv(ctx))
    .select()
    .single();

  if (updateError) {
    console.error('Error updating payment method:', updateError);
    return c.json({ error: 'Failed to update payment method' }, 500);
  }

  await logAudit(supabase, {
    tenantId: ctx.tenantId,
    entityType: 'payment_method',
    entityId: methodId,
    action: 'updated',
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    actorName: ctx.actorName,
  });

  return c.json({ data: updated });
});

// ============================================
// DELETE /v1/payment-methods/:id - Delete payment method
// ============================================
paymentMethods.delete('/payment-methods/:id', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();
  const methodId = c.req.param('id');

  if (!isValidUUID(methodId)) {
    throw new ValidationError('Invalid payment method ID format');
  }

  // Verify payment method belongs to tenant
  const { data: method, error: fetchError } = await supabase
    .from('payment_methods')
    .select('*')
    .eq('id', methodId)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();

  if (fetchError || !method) {
    throw new NotFoundError('Payment method', methodId);
  }

  // Check if it's being used in any active schedules
  const { data: schedules } = await supabase
    .from('transfer_schedules')
    .select('id')
    .eq('to_payment_method_id', methodId)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .eq('status', 'active')
    .limit(1);

  if (schedules && schedules.length > 0) {
    throw new ValidationError('Cannot delete payment method that is used in active scheduled transfers');
  }

  const { error: deleteError } = await supabase
    .from('payment_methods')
    .delete()
    .eq('id', methodId)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx));

  if (deleteError) {
    console.error('Error deleting payment method:', deleteError);
    return c.json({ error: 'Failed to delete payment method' }, 500);
  }

  await logAudit(supabase, {
    tenantId: ctx.tenantId,
    entityType: 'payment_method',
    entityId: methodId,
    action: 'deleted',
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    actorName: ctx.actorName,
  });

  return c.json({ data: { id: methodId, deleted: true } });
});

// ============================================
// GET /v1/payment-methods/:id - Get single payment method
// ============================================
paymentMethods.get('/payment-methods/:id', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();
  const methodId = c.req.param('id');

  if (!isValidUUID(methodId)) {
    throw new ValidationError('Invalid payment method ID format');
  }

  const { data: method, error } = await supabase
    .from('payment_methods')
    .select('*')
    .eq('id', methodId)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();

  if (error || !method) {
    throw new NotFoundError('Payment method', methodId);
  }

  return c.json({ data: method });
});

// ============================================
// GET /payment-methods/:id/transactions - Get card transactions
// ============================================
cardTransactionsRouter.get('/', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();
  const methodId = c.req.param('id');

  if (!isValidUUID(methodId)) {
    throw new ValidationError('Invalid payment method ID format');
  }

  const { limit, offset } = getPaginationParams(c.req.query(), { defaultLimit: 20, maxLimit: 100 });

  // Verify payment method exists and belongs to tenant
  const { data: method, error: methodError } = await supabase
    .from('payment_methods')
    .select('id, type')
    .eq('id', methodId)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();

  if (methodError || !method) {
    throw new NotFoundError('Payment method', methodId);
  }

  // Get transactions using direct table query instead of RPC
  const { data: transactions, error: txError } = await supabase
    .from('card_transactions')
    .select('id, type, status, amount, currency, merchant_name, merchant_category, transaction_time, created_at, is_disputed, card_last_four, description:merchant_name') // Added description alias for frontend compatibility if needed, though frontend uses merchant?.name
    .eq('payment_method_id', methodId)
    .eq('environment', getEnv(ctx))
    .order('transaction_time', { ascending: false })
    .range(offset, offset + limit - 1);

  if (txError) {
    console.error('Error fetching card transactions:', txError);
    return c.json({ error: 'Failed to fetch card transactions' }, 500);
  }

  // Get total count for pagination
  const { count } = await supabase
    .from('card_transactions')
    .select('id', { count: 'exact', head: true })
    .eq('payment_method_id', methodId)
    .eq('environment', getEnv(ctx));

  return c.json(paginationResponse(transactions || [], count || 0, limit, offset));
});

// ============================================
// GET /payment-methods/:id/spending-summary - Get spending summary
// ============================================
cardTransactionsRouter.get('/spending-summary', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();
  const methodId = c.req.param('id');
  const days = parseInt(c.req.query('days') || '30', 10);

  if (!isValidUUID(methodId)) {
    throw new ValidationError('Invalid payment method ID format');
  }

  // Verify payment method exists and belongs to tenant
  const { data: method, error: methodError } = await supabase
    .from('payment_methods')
    .select('id, type')
    .eq('id', methodId)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();

  if (methodError || !method) {
    throw new NotFoundError('Payment method', methodId);
  }

  // Get spending summary using the database function
  const { data: summary, error: summaryError } = await supabase
    .rpc('get_card_spending_summary', {
      p_payment_method_id: methodId,
      p_days: Math.min(Math.max(days, 1), 365), // Clamp between 1 and 365
    });

  if (summaryError) {
    console.error('Error fetching spending summary:', summaryError);
    return c.json({ error: 'Failed to fetch spending summary' }, 500);
  }

  return c.json({ data: summary?.[0] || {} });
});

// Mount card transactions routes
paymentMethods.route('/:id/transactions', cardTransactionsRouter);

export default paymentMethods;

