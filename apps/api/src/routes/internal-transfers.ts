import { Hono } from 'hono';
import { z } from 'zod';
import { createClient } from '../db/client.js';
import {
  mapTransferFromDb,
  logAudit,
  getEnv,
} from '../utils/helpers.js';
import { createBalanceService } from '../services/balances.js';
import { ValidationError, NotFoundError, InsufficientBalanceError } from '../middleware/error.js';

const internalTransfers = new Hono();

// ============================================
// VALIDATION SCHEMAS
// ============================================

const createInternalTransferSchema = z.object({
  fromAccountId: z.string().uuid(),
  toAccountId: z.string().uuid(),
  amount: z.number().positive(),
  description: z.string().max(500).optional(),
});

// ============================================
// POST /v1/internal-transfers - Create internal transfer
// ============================================
// This is a fast, ledger-only transfer between two accounts
// Completes synchronously with < 300ms target
internalTransfers.post('/', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();
  const startTime = Date.now();
  
  // Check for idempotency key
  const idempotencyKey = c.req.header('X-Idempotency-Key');
  
  if (idempotencyKey) {
    // Check for existing transfer with this key
    const { data: existing } = await supabase
      .from('transfers')
      .select('*')
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .eq('idempotency_key', idempotencyKey)
      .single();
    
    if (existing) {
      // Return existing transfer
      return c.json({ 
        data: mapTransferFromDb(existing),
        meta: { cached: true, processingTimeMs: Date.now() - startTime },
      });
    }
  }
  
  // Parse and validate body
  let body;
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError('Invalid JSON body');
  }
  
  const parsed = createInternalTransferSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError('Validation failed', parsed.error.flatten());
  }
  
  const { fromAccountId, toAccountId, amount, description } = parsed.data;
  
  // Can't transfer to self
  if (fromAccountId === toAccountId) {
    throw new ValidationError('Cannot transfer to the same account');
  }
  
  // Fetch both accounts in parallel
  const [fromAccountResult, toAccountResult] = await Promise.all([
    supabase
      .from('accounts')
      .select('id, name, balance_available, tenant_id')
      .eq('id', fromAccountId)
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .single(),
    supabase
      .from('accounts')
      .select('id, name, tenant_id')
      .eq('id', toAccountId)
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .single(),
  ]);
  
  if (fromAccountResult.error || !fromAccountResult.data) {
    throw new NotFoundError('Source account', fromAccountId);
  }
  if (toAccountResult.error || !toAccountResult.data) {
    throw new NotFoundError('Destination account', toAccountId);
  }
  
  const fromAccount = fromAccountResult.data;
  const toAccount = toAccountResult.data;
  
  // Verify both accounts belong to the same tenant
  if (fromAccount.tenant_id !== ctx.tenantId || toAccount.tenant_id !== ctx.tenantId) {
    throw new ValidationError('Both accounts must belong to the same tenant');
  }
  
  // Check sufficient balance
  const availableBalance = parseFloat(fromAccount.balance_available) || 0;
  if (availableBalance < amount) {
    throw new InsufficientBalanceError(availableBalance, amount);
  }
  
  // Create transfer record
  const { data: transfer, error: createError } = await supabase
    .from('transfers')
    .insert({
      tenant_id: ctx.tenantId,
      environment: getEnv(ctx),
      type: 'internal',
      status: 'completed',
      from_account_id: fromAccountId,
      from_account_name: fromAccount.name,
      to_account_id: toAccountId,
      to_account_name: toAccount.name,
      initiated_by_type: ctx.actorType,
      initiated_by_id: ctx.actorId,
      initiated_by_name: ctx.actorName,
      amount,
      currency: 'USDC',
      destination_amount: amount,
      destination_currency: 'USDC',
      fx_rate: 1,
      fee_amount: 0, // No fees for internal transfers
      description: description || 'Internal transfer',
      idempotency_key: idempotencyKey,
      completed_at: new Date().toISOString(),
    })
    .select()
    .single();
  
  if (createError) {
    console.error('Error creating transfer:', createError);
    return c.json({ error: 'Failed to create transfer' }, 500);
  }
  
  // Execute the balance transfer
  const balanceService = createBalanceService(supabase);
  
  try {
    await balanceService.transfer(
      fromAccountId,
      toAccountId,
      amount,
      'transfer',
      transfer.id,
      description || 'Internal transfer'
    );
  } catch (error: any) {
    // Rollback transfer status on failure
    await supabase
      .from('transfers')
      .update({
        status: 'failed',
        failed_at: new Date().toISOString(),
        failure_reason: error.message,
      })
      .eq('id', transfer.id);
    
    // Re-throw the error
    throw error;
  }
  
  // Audit log (fire and forget)
  logAudit(supabase, {
    tenantId: ctx.tenantId,
    entityType: 'transfer',
    entityId: transfer.id,
    action: 'completed',
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    actorName: ctx.actorName,
    metadata: {
      type: 'internal',
      amount,
      from: fromAccount.name,
      to: toAccount.name,
    },
  }).catch(console.error);
  
  const processingTimeMs = Date.now() - startTime;
  
  return c.json({ 
    data: mapTransferFromDb(transfer),
    meta: { 
      processingTimeMs,
      performanceTarget: processingTimeMs < 300 ? 'met' : 'exceeded',
    },
  }, 201);
});

export default internalTransfers;
