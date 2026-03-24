/**
 * AP2 (Agent-to-Agent Protocol) Routes
 * 
 * Google's protocol for agentic payments.
 * 
 * @see Story 40.14: AP2 Reference Setup
 * @see Story 18.R3: Multi-Protocol Spending Policy Integration
 */

import { Hono } from 'hono';
import { getAP2MandateService } from '../services/ap2/index.js';
import { ValidationError } from '../middleware/error.js';
import { randomUUID } from 'crypto';
import { createClient } from '../db/client.js';
import { sanitizeSearchInput, getEnv } from '../utils/helpers.js';
import { 
  createSpendingPolicyService,
  type PolicyContext 
} from '../services/spending-policy.js';
import {
  createApprovalWorkflowService
} from '../services/approval-workflow.js';
import { getLiveFXService } from '../services/fx/live-rates.js';
import { createCheckoutTelemetryService, extractMerchantDomain } from '../services/telemetry/checkout-telemetry.js';
import { trackOp } from '../services/ops/track-op.js';
import { OpType } from '../services/ops/operation-types.js';

const ap2 = new Hono();

// Helper: detect UUID format to avoid Postgres cast errors on the UUID `id` column
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Valid settlement rails for mandate binding
const VALID_SETTLEMENT_RAILS = [
  'auto', 'internal', 'circle_usdc', 'base_chain', 'pix', 'spei',
  'wire', 'ach', 'visa_pull', 'mastercard_pull', 'mock',
];

// =============================================================================
// Discovery
// =============================================================================

/**
 * GET /v1/ap2/agent-card
 * Agent discovery endpoint.
 * Delegates to the A2A agent card service for consistency.
 */
ap2.get('/agent-card', async (c) => {
  const { generatePlatformCard, getBaseUrlFromRequest } = await import('../services/a2a/agent-card.js');
  const card = generatePlatformCard(getBaseUrlFromRequest(c));
  return c.json({ data: card });
});

// =============================================================================
// Mandates
// =============================================================================

/**
 * POST /v1/ap2/mandates
 * Create a new payment mandate (writes to database)
 */
ap2.post('/mandates', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();

  let body;
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError('Invalid JSON body');
  }

  // Accept both AP2 protocol fields and dashboard-friendly fields
  const account_id = body.account_id || body.payer_id;
  const agent_id = body.agent_id || body.payee_id;
  const mandate_type = body.mandate_type || body.type;
  const authorized_amount = body.authorized_amount ?? body.max_amount;
  const currency = body.currency || 'USDC';
  const mandate_id = body.mandate_id || body.mandateId || `mandate_${randomUUID().slice(0, 12)}`;

  if (!account_id || !agent_id) {
    throw new ValidationError('account_id and agent_id are required');
  }
  if (!authorized_amount || Number(authorized_amount) <= 0) {
    throw new ValidationError('authorized_amount must be a positive number');
  }
  if (!mandate_type || !['intent', 'cart', 'payment'].includes(mandate_type)) {
    throw new ValidationError('mandate_type must be one of: intent, cart, payment');
  }

  // Validate optional funding_source_id
  const funding_source_id = body.funding_source_id || null;
  if (funding_source_id) {
    const { data: fs, error: fsError } = await supabase
      .from('funding_sources')
      .select('id, status, account_id')
      .eq('id', funding_source_id)
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .single();
    if (fsError || !fs) {
      throw new ValidationError('funding_source_id not found');
    }
    if (fs.status !== 'active') {
      throw new ValidationError('Funding source is not active');
    }
    if (fs.account_id !== account_id) {
      throw new ValidationError('Funding source does not belong to the specified account');
    }
  }

  // Validate optional settlement_rail
  const settlement_rail = body.settlement_rail || null;
  if (settlement_rail && !VALID_SETTLEMENT_RAILS.includes(settlement_rail)) {
    throw new ValidationError(`settlement_rail must be one of: ${VALID_SETTLEMENT_RAILS.join(', ')}`);
  }

  // Look up agent name
  const { data: agent } = await supabase
    .from('agents')
    .select('name')
    .eq('id', agent_id)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();

  const { data: mandate, error } = await supabase
    .from('ap2_mandates')
    .insert({
      tenant_id: ctx.tenantId,
      environment: getEnv(ctx),
      account_id,
      mandate_id,
      mandate_type,
      agent_id,
      agent_name: body.agent_name || agent?.name || 'Unknown Agent',
      authorized_amount: Number(authorized_amount),
      currency,
      status: 'active',
      expires_at: body.expires_at || body.expiresAt || body.valid_until || null,
      mandate_data: body.mandate_data || {},
      metadata: body.metadata || {},
      funding_source_id,
      settlement_rail,
    })
    .select('*')
    .single();

  if (error) {
    throw new ValidationError(`Failed to create mandate: ${error.message}`);
  }

  trackOp({
    tenantId: ctx.tenantId,
    operation: OpType.AP2_MANDATE_CREATED,
    subject: `ap2/mandate/${mandate.id}`,
    actorType: ctx.actorType,
    actorId: ctx.actorId || ctx.userId || ctx.apiKeyId,
    correlationId: c.get('requestId'),
    success: true,
  });

  return c.json({ data: mandate }, 201);
});

/**
 * GET /v1/ap2/mandates/:id
 * Get mandate details (reads from database)
 */
ap2.get('/mandates/:id', async (c) => {
  const id = c.req.param('id');
  const ctx = c.get('ctx');
  const supabase = createClient();

  // Query by UUID id or user-defined mandate_id (avoid UUID cast error)
  const col = UUID_RE.test(id) ? 'id' : 'mandate_id';
  const { data: mandate, error } = await supabase
    .from('ap2_mandates')
    .select('*')
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .eq(col, id)
    .single();

  if (error || !mandate) {
    // Fallback to in-memory service for mandates created via API
    const mandateService = getAP2MandateService();
    const inMemMandate = await mandateService.getMandate(id);
    if (!inMemMandate) {
      return c.json({ error: 'Mandate not found' }, 404);
    }
    return c.json({ data: inMemMandate });
  }

  // Fetch executions for this mandate
  const { data: executions } = await supabase
    .from('ap2_mandate_executions')
    .select('*')
    .eq('mandate_id', mandate.id)
    .order('execution_index', { ascending: true });

  // Join funding source display info if bound
  let funding_source = null;
  if (mandate.funding_source_id) {
    const { data: fs } = await supabase
      .from('funding_sources')
      .select('id, type, provider, display_name, last_four, brand, status')
      .eq('id', mandate.funding_source_id)
      .single();
    if (fs) {
      funding_source = fs;
    }
  }

  return c.json({ data: { ...mandate, executions: executions || [], funding_source } });
});

/**
 * PATCH /v1/ap2/mandates/:id
 * Update a mandate (authorized_amount, expires_at, status, metadata)
 */
ap2.patch('/mandates/:id', async (c) => {
  const id = c.req.param('id');
  const ctx = c.get('ctx');
  const supabase = createClient();

  let body;
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError('Invalid JSON body');
  }

  // Build update object from allowed fields
  const updates: Record<string, any> = { updated_at: new Date().toISOString() };
  if (body.authorized_amount !== undefined) updates.authorized_amount = Number(body.authorized_amount);
  if (body.status !== undefined) updates.status = body.status;
  if (body.expires_at !== undefined) updates.expires_at = body.expires_at;
  if (body.metadata !== undefined) updates.metadata = body.metadata;
  if (body.mandate_data !== undefined) updates.mandate_data = body.mandate_data;

  // Handle funding_source_id (null clears it)
  if (body.funding_source_id !== undefined) {
    if (body.funding_source_id) {
      const { data: fs, error: fsError } = await supabase
        .from('funding_sources')
        .select('id, status')
        .eq('id', body.funding_source_id)
        .eq('tenant_id', ctx.tenantId)
        .single();
      if (fsError || !fs) throw new ValidationError('funding_source_id not found');
      if (fs.status !== 'active') throw new ValidationError('Funding source is not active');
    }
    updates.funding_source_id = body.funding_source_id;
  }

  // Handle settlement_rail (null clears it)
  if (body.settlement_rail !== undefined) {
    if (body.settlement_rail && !VALID_SETTLEMENT_RAILS.includes(body.settlement_rail)) {
      throw new ValidationError(`settlement_rail must be one of: ${VALID_SETTLEMENT_RAILS.join(', ')}`);
    }
    updates.settlement_rail = body.settlement_rail;
  }

  // Look up by UUID id or user-defined mandate_id (avoid UUID cast error)
  const col = UUID_RE.test(id) ? 'id' : 'mandate_id';
  const { data: mandate, error } = await supabase
    .from('ap2_mandates')
    .update(updates)
    .eq(col, id)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .select('*')
    .single();

  if (error || !mandate) {
    return c.json({ error: error?.message || 'Mandate not found' }, 404);
  }

  trackOp({
    tenantId: ctx.tenantId,
    operation: OpType.AP2_MANDATE_UPDATED,
    subject: `ap2/mandate/${mandate.id}`,
    actorType: ctx.actorType,
    actorId: ctx.actorId || ctx.userId || ctx.apiKeyId,
    correlationId: c.get('requestId'),
    success: true,
  });

  return c.json({ data: mandate });
});

/**
 * PATCH /v1/ap2/mandates/:id/cancel
 * Cancel a mandate
 */
ap2.patch('/mandates/:id/cancel', async (c) => {
  const id = c.req.param('id');
  const ctx = c.get('ctx');
  const supabase = createClient();

  // Look up by UUID id or user-defined mandate_id (avoid UUID cast error)
  const col = UUID_RE.test(id) ? 'id' : 'mandate_id';
  const { data: mandate, error } = await supabase
    .from('ap2_mandates')
    .update({ status: 'cancelled', cancelled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq(col, id)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .eq('status', 'active')
    .select('*')
    .single();

  if (error || !mandate) {
    return c.json({ error: error?.message || 'Mandate not found or not active' }, 404);
  }

  trackOp({
    tenantId: ctx.tenantId,
    operation: OpType.AP2_MANDATE_CANCELLED,
    subject: `ap2/mandate/${mandate.id}`,
    actorType: ctx.actorType,
    actorId: ctx.actorId || ctx.userId || ctx.apiKeyId,
    correlationId: c.get('requestId'),
    success: true,
  });

  return c.json({ data: mandate });
});

/**
 * POST /v1/ap2/mandates/:id/activate
 * Activate a mandate
 */
ap2.post('/mandates/:id/activate', async (c) => {
  const id = c.req.param('id');
  
  let body: { credential?: any } = {};
  try {
    body = await c.req.json();
  } catch {
    // Credential is optional
  }
  
  const mandateService = getAP2MandateService();
  
  try {
    const mandate = await mandateService.activateMandate(id, body.credential);
    return c.json({ data: mandate });
  } catch (error: any) {
    return c.json({ error: error.message }, 400);
  }
});

/**
 * POST /v1/ap2/mandates/:id/suspend
 * Suspend a mandate
 */
ap2.post('/mandates/:id/suspend', async (c) => {
  const id = c.req.param('id');
  
  let body: { reason?: string } = {};
  try {
    body = await c.req.json();
  } catch {}
  
  const mandateService = getAP2MandateService();
  
  try {
    const mandate = await mandateService.suspendMandate(id, body.reason);
    return c.json({ data: mandate });
  } catch (error: any) {
    return c.json({ error: error.message }, 400);
  }
});

/**
 * POST /v1/ap2/mandates/:id/revoke
 * Revoke a mandate
 */
ap2.post('/mandates/:id/revoke', async (c) => {
  const id = c.req.param('id');
  const mandateService = getAP2MandateService();
  
  try {
    const mandate = await mandateService.revokeMandate(id);
    return c.json({ data: mandate });
  } catch (error: any) {
    return c.json({ error: error.message }, 400);
  }
});

/**
 * GET /v1/ap2/mandates
 * List mandates for current tenant (reads from database)
 */
ap2.get('/mandates', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();

  // Parse query params
  const page = parseInt(c.req.query('page') || '1');
  const limit = parseInt(c.req.query('limit') || '20');
  const status = c.req.query('status');
  const agentId = c.req.query('agent_id');
  const accountId = c.req.query('account_id');
  const search = c.req.query('search');
  const offset = (page - 1) * limit;

  // Build query
  let query = supabase
    .from('ap2_mandates')
    .select('*', { count: 'exact' })
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) {
    query = query.eq('status', status);
  }
  if (agentId) {
    query = query.eq('agent_id', agentId);
  }
  if (accountId) {
    query = query.eq('account_id', accountId);
  }
  if (search) {
    const safe = sanitizeSearchInput(search);
    query = query.or(`mandate_id.ilike.%${safe}%,agent_name.ilike.%${safe}%`);
  }

  const { data: mandates, error, count } = await query;

  if (error) {
    console.error('[AP2] List mandates error:', error);
    return c.json({ error: 'Failed to fetch mandates' }, 500);
  }

  const total = count || 0;

  return c.json({
    data: mandates || [],
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
});

/**
 * POST /v1/ap2/mandates/:id/execute
 * Execute a payment against a mandate (updates used_amount, creates execution record)
 */
ap2.post('/mandates/:id/execute', async (c) => {
  const id = c.req.param('id');
  const ctx = c.get('ctx');
  const supabase = createClient();

  let body;
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError('Invalid JSON body');
  }

  const { amount, currency, description, order_ids, destination_currency, to_account_id } = body;
  if (!amount || Number(amount) <= 0) {
    throw new ValidationError('amount must be a positive number');
  }

  // Look up by UUID id or user-defined mandate_id (avoid UUID cast error)
  const col = UUID_RE.test(id) ? 'id' : 'mandate_id';
  const { data: mandate, error: findError } = await supabase
    .from('ap2_mandates')
    .select('*')
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .eq(col, id)
    .single();

  if (findError || !mandate) {
    const telemetry = createCheckoutTelemetryService(supabase);
    telemetry.record({
      protocol: 'ap2',
      event_type: 'mandate.not_found',
      success: false,
      failure_reason: 'Mandate not found',
      failure_code: 'MANDATE_NOT_FOUND',
      amount: Number(amount),
      currency: currency,
      protocol_metadata: { mandate_id: id },
    });
    return c.json({ error: 'Mandate not found' }, 404);
  }

  if (mandate.status !== 'active') {
    const telemetry = createCheckoutTelemetryService(supabase);
    telemetry.record({
      protocol: 'ap2',
      event_type: 'mandate.not_active',
      success: false,
      merchant_domain: extractMerchantDomain(mandate.description || mandate.mandate_id || '') || undefined,
      failure_reason: `Mandate is ${mandate.status}`,
      failure_code: 'MANDATE_NOT_ACTIVE',
      agent_id: mandate.agent_id,
      agent_name: mandate.agent_name,
      amount: Number(amount),
      currency: currency || mandate.currency,
      protocol_metadata: { mandate_id: mandate.id, mandate_status: mandate.status },
    });
    return c.json({ error: `Mandate is ${mandate.status}, not active` }, 400);
  }

  const execAmount = Number(amount);
  const currentUsed = Number(mandate.used_amount || 0);
  const remaining = Number(mandate.authorized_amount) - currentUsed;

  if (execAmount > remaining) {
    const telemetry = createCheckoutTelemetryService(supabase);
    telemetry.record({
      protocol: 'ap2',
      event_type: 'mandate.budget_exceeded',
      success: false,
      merchant_domain: extractMerchantDomain(mandate.description || mandate.mandate_id || '') || undefined,
      failure_reason: 'Amount exceeds remaining mandate budget',
      failure_code: 'BUDGET_EXCEEDED',
      agent_id: mandate.agent_id,
      agent_name: mandate.agent_name,
      amount: execAmount,
      currency: currency || mandate.currency,
      protocol_metadata: { mandate_id: mandate.id, remaining, requested: execAmount },
    });
    return c.json({ error: 'Amount exceeds remaining mandate budget' }, 400);
  }

  const newExecIndex = (mandate.execution_count || 0) + 1;

  // Insert execution record — a DB trigger (update_ap2_mandate_usage) automatically
  // updates the mandate's used_amount, execution_count, and remaining_amount
  const { error: execError } = await supabase
    .from('ap2_mandate_executions')
    .insert({
      tenant_id: ctx.tenantId,
      environment: getEnv(ctx),
      mandate_id: mandate.id,
      execution_index: newExecIndex,
      amount: execAmount,
      currency: currency || mandate.currency,
      status: 'completed',
      completed_at: new Date().toISOString(),
      order_ids: Array.isArray(order_ids) && order_ids.length > 0 ? order_ids : null,
    });

  if (execError) {
    console.error('[AP2] Mandate execution insert error:', execError);
    return c.json({ error: 'Failed to execute mandate payment' }, 500);
  }

  const newUsed = currentUsed + execAmount;
  const newRemaining = Number(mandate.authorized_amount) - newUsed;

  // ============================================
  // Cross-border detection & FX resolution
  // ============================================
  const destCurrency = destination_currency || mandate.mandate_data?.destination_currency;
  const destAccountId = to_account_id || mandate.mandate_data?.destination_account_id;
  const isCrossBorder = !!destCurrency && !['USD', 'USDC'].includes(destCurrency.toUpperCase());

  let crossBorderInfo: {
    to_account_id?: string;
    to_account_name?: string;
    destination_amount: number;
    destination_currency: string;
    fx_rate: number;
    fee_amount: number;
    corridor_id: string;
  } | null = null;

  if (isCrossBorder) {
    // Look up destination account
    let destAccountName = 'Unknown Recipient';
    if (destAccountId) {
      const { data: destAccount } = await supabase
        .from('accounts')
        .select('name')
        .eq('id', destAccountId)
        .eq('tenant_id', ctx.tenantId)
        .eq('environment', getEnv(ctx))
        .single();
      if (destAccount) destAccountName = destAccount.name;
    }

    // Get live FX rate
    const liveFX = getLiveFXService();
    const fxRate = await liveFX.getRate('USD', destCurrency);
    const feePercent = 0.7; // 0.7% remittance corridor fee
    const feeAmount = parseFloat((execAmount * feePercent / 100).toFixed(2));
    const netAmount = execAmount - feeAmount;
    const destinationAmount = parseFloat((netAmount * fxRate).toFixed(2));

    crossBorderInfo = {
      to_account_id: destAccountId,
      to_account_name: destAccountName,
      destination_amount: destinationAmount,
      destination_currency: destCurrency,
      fx_rate: parseFloat(fxRate.toFixed(4)),
      fee_amount: feeAmount,
      corridor_id: `USDC_${destCurrency}`,
    };
  }

  // ============================================
  // Funding source charge (if bound to mandate)
  // ============================================
  let fundingSourceCharge: { fundingSourceId: string; fundingTransactionId: string } | null = null;
  let skipWalletDeduction = false;

  if (mandate.funding_source_id) {
    // Check if the funding source is still active
    const { data: fs } = await supabase
      .from('funding_sources')
      .select('id, status, provider, type, account_id')
      .eq('id', mandate.funding_source_id)
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .single();

    if (fs && fs.status === 'active') {
      // Create a funding_transactions record (mock: instant completion)
      const { data: fundingTx } = await supabase
        .from('funding_transactions')
        .insert({
          tenant_id: ctx.tenantId,
          environment: getEnv(ctx),
          funding_source_id: fs.id,
          account_id: fs.account_id,
          amount_cents: Math.round(execAmount * 100),
          currency: currency || mandate.currency,
          status: 'completed',
          provider: fs.provider,
          provider_transaction_id: `mock_${randomUUID().slice(0, 12)}`,
          completed_at: new Date().toISOString(),
        })
        .select('id')
        .single();

      if (fundingTx) {
        fundingSourceCharge = {
          fundingSourceId: fs.id,
          fundingTransactionId: fundingTx.id,
        };
        skipWalletDeduction = true;
      }
    }
    // If funding source inactive, fall through to wallet deduction
  }

  // ============================================
  // Wallet deduction (settle funds from agent wallet)
  // ============================================
  let walletDeduction: { walletId: string; previousBalance: number; newBalance: number; transferId?: string } | null = null;
  let settlementTxHash: string | undefined;
  let settlementNetwork: string | undefined;

  // Find wallet: prefer the mandate agent's wallet, fall back to account-owned wallet
  let wallet: any = null;
  if (!skipWalletDeduction) {
    // First try: wallet managed by the mandate's agent, preferring currency match
    const mandateCurrency = currency || mandate.currency;
    const { data: agentWallets } = await supabase
      .from('wallets')
      .select('id, balance, currency, owner_account_id, status')
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .eq('managed_by_agent_id', mandate.agent_id)
      .eq('status', 'active');

    if (agentWallets && agentWallets.length > 0) {
      // Prefer wallet matching mandate currency, fall back to first available
      wallet = agentWallets.find(w => w.currency === mandateCurrency) || agentWallets[0];
    } else {
      // Fallback: wallet owned by the mandate's account, preferring currency match
      const { data: accountWallets } = await supabase
        .from('wallets')
        .select('id, balance, currency, owner_account_id, status')
        .eq('tenant_id', ctx.tenantId)
        .eq('environment', getEnv(ctx))
        .eq('owner_account_id', mandate.account_id)
        .eq('status', 'active')
        .order('managed_by_agent_id', { ascending: false, nullsFirst: false });

      if (accountWallets && accountWallets.length > 0) {
        wallet = accountWallets.find(w => w.currency === mandateCurrency) || accountWallets[0];
      }
    }
  }

  if (wallet) {
    const currentBalance = Number(wallet.balance);
    if (currentBalance >= execAmount) {
      const updatedBalance = currentBalance - execAmount;
      const updatedStatus = updatedBalance === 0 ? 'depleted' : 'active';

      // Look up account name and agent name for the transfer record
      const [{ data: fromAccount }, { data: agentRecord }] = await Promise.all([
        supabase.from('accounts').select('name').eq('id', wallet.owner_account_id).eq('tenant_id', ctx.tenantId).eq('environment', getEnv(ctx)).single(),
        supabase.from('agents').select('name').eq('id', mandate.agent_id).eq('tenant_id', ctx.tenantId).eq('environment', getEnv(ctx)).single(),
      ]);

      const { error: walletUpdateError } = await supabase
        .from('wallets')
        .update({
          balance: updatedBalance,
          status: updatedStatus,
          updated_at: new Date().toISOString(),
        })
        .eq('id', wallet.id)
        .eq('tenant_id', ctx.tenantId);

      if (walletUpdateError) {
        console.error('[AP2] Wallet deduction error:', walletUpdateError);
      } else {
        // Build transfer record — cross-border or internal
        const now = new Date().toISOString();
        const transferInsert: Record<string, any> = {
          tenant_id: ctx.tenantId,
          environment: getEnv(ctx),
          from_account_id: wallet.owner_account_id,
          from_account_name: fromAccount?.name || '',
          amount: execAmount,
          currency: currency || mandate.currency,
          type: isCrossBorder ? 'cross_border' : 'ap2',
          status: 'completed',
          completed_at: now,
          initiated_by_type: 'agent',
          initiated_by_id: mandate.agent_id,
          initiated_by_name: agentRecord?.name || '',
          description: description || `Mandate execution #${newExecIndex}`,
          protocol_metadata: {
            protocol: 'ap2',
            wallet_id: wallet.id,
            operation: 'mandate_execution',
            mandate_id: mandate.id,
            execution_index: newExecIndex,
          },
        };

        // Attach cross-border fields
        if (crossBorderInfo) {
          transferInsert.to_account_id = crossBorderInfo.to_account_id;
          transferInsert.to_account_name = crossBorderInfo.to_account_name;
          transferInsert.destination_amount = crossBorderInfo.destination_amount;
          transferInsert.destination_currency = crossBorderInfo.destination_currency;
          transferInsert.fx_rate = crossBorderInfo.fx_rate;
          transferInsert.corridor_id = crossBorderInfo.corridor_id;
          transferInsert.fee_amount = crossBorderInfo.fee_amount;
          transferInsert.settled_at = now;
          transferInsert.settlement_metadata = {
            corridor: crossBorderInfo.corridor_id,
            rail: mandate.settlement_rail || 'raast',
            fx_rate: crossBorderInfo.fx_rate,
            fx_source: 'live_exchangerate_api',
            destination_amount: crossBorderInfo.destination_amount,
            destination_currency: crossBorderInfo.destination_currency,
            fee_percent: 0.7,
            fee_amount: crossBorderInfo.fee_amount,
            settled_at: now,
          };
        }

        const { data: transfer } = await supabase
          .from('transfers')
          .insert(transferInsert)
          .select('id')
          .single();

        // ============================================
        // On-chain Tempo settlement (if wallet has private key)
        // ============================================

        const walletMeta = await supabase
          .from('wallets')
          .select('provider_metadata, wallet_address, network')
          .eq('id', wallet.id)
          .single();

        const encryptedKey = walletMeta.data?.provider_metadata?.encrypted_private_key;
        if (encryptedKey && walletMeta.data?.network?.startsWith('tempo')) {
          try {
            // Resolve recipient wallet address (counterparty agent)
            const recipientAgentId = mandate.metadata?.recipientAgentId
              || mandate.mandate_data?.recipient_agent_id
              || mandate.metadata?.providerAgentId
              || mandate.mandate_data?.provider_agent_id;

            // Find recipient agent's wallet address
            const { data: recipientWallet } = await supabase
              .from('wallets')
              .select('wallet_address, network')
              .eq('managed_by_agent_id', recipientAgentId)
              .eq('tenant_id', ctx.tenantId)
              .eq('environment', getEnv(ctx))
              .like('network', 'tempo-%')
              .eq('status', 'active')
              .limit(1)
              .single();

            const recipientAddress = recipientWallet?.wallet_address
              || mandate.metadata?.recipientAddress
              || mandate.mandate_data?.recipient_address;

            if (recipientAddress) {
              const isTestnet = walletMeta.data.network === 'tempo-testnet';
              const rpcUrl = isTestnet
                ? 'https://rpc.moderato.tempo.xyz'
                : 'https://rpc.tempo.xyz';
              const tokenContract = isTestnet
                ? '0x20c0000000000000000000000000000000000000'
                : '0x20C000000000000000000000b9537d11c60E8b50';
              const chainId = isTestnet ? 42431 : 4217;

              // Use viem directly for ERC20 token transfer
              const { privateKeyToAccount } = await import('viem/accounts');
              const { createPublicClient, createWalletClient, http, defineChain } = await import('viem');

              const tempoChain = defineChain({
                id: chainId,
                name: isTestnet ? 'Tempo Testnet' : 'Tempo',
                nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
                rpcUrls: { default: { http: [rpcUrl] } },
              });

              const senderAccount = privateKeyToAccount(encryptedKey as `0x${string}`);
              const walletClient = createWalletClient({
                account: senderAccount,
                chain: tempoChain,
                transport: http(rpcUrl),
              });
              const publicClient = createPublicClient({
                chain: tempoChain,
                transport: http(rpcUrl),
              });

              // Convert amount to token units (6 decimals for pathUSD/USDC)
              const amountUnits = BigInt(Math.round(execAmount * 1e6));

              const txHash = await walletClient.writeContract({
                address: tokenContract as `0x${string}`,
                abi: [{
                  name: 'transfer',
                  type: 'function',
                  inputs: [
                    { name: 'to', type: 'address' },
                    { name: 'amount', type: 'uint256' },
                  ],
                  outputs: [{ name: 'success', type: 'bool' }],
                  stateMutability: 'nonpayable',
                }],
                functionName: 'transfer',
                args: [recipientAddress as `0x${string}`, amountUnits],
              });

              // Wait for confirmation
              await publicClient.waitForTransactionReceipt({ hash: txHash });

              settlementTxHash = txHash;
              settlementNetwork = walletMeta.data.network;

              console.log(`[AP2] On-chain settlement: ${txHash} on ${settlementNetwork}`);

              // Update transfer record with tx hash
              if (transfer?.id) {
                await supabase
                  .from('transfers')
                  .update({
                    tx_hash: txHash,
                    settlement_network: settlementNetwork,
                    protocol_metadata: {
                      ...transferInsert.protocol_metadata,
                      settlement: 'on_chain',
                      settlement_network: settlementNetwork,
                      settlement_tx_hash: txHash,
                    },
                  })
                  .eq('id', transfer.id);
              }

              // Update execution record with settlement tx hash
              await supabase
                .from('ap2_mandate_executions')
                .update({
                  authorization_proof: txHash,
                  settlement_tx_hash: txHash,
                  settlement_network: settlementNetwork,
                })
                .eq('mandate_id', mandate.id)
                .eq('execution_index', newExecIndex);
            }
          } catch (settlementError: any) {
            console.warn('[AP2] On-chain settlement failed (ledger deduction still applied):', settlementError.message);
            // Settlement failure is non-fatal — ledger deduction already succeeded
          }
        }

        walletDeduction = {
          walletId: wallet.id,
          previousBalance: currentBalance,
          newBalance: updatedBalance,
          transferId: transfer?.id,
        };

        // Update sender account balance
        const { data: account } = await supabase
          .from('accounts')
          .select('balance_total, balance_available')
          .eq('id', wallet.owner_account_id)
          .eq('tenant_id', ctx.tenantId)
          .eq('environment', getEnv(ctx))
          .single();

        if (account) {
          const newTotal = Math.max(0, Number(account.balance_total) - execAmount);
          const newAvailable = Math.max(0, Number(account.balance_available) - execAmount);
          await supabase
            .from('accounts')
            .update({
              balance_total: newTotal,
              balance_available: newAvailable,
              updated_at: new Date().toISOString(),
            })
            .eq('id', wallet.owner_account_id)
            .eq('tenant_id', ctx.tenantId)
            .eq('environment', getEnv(ctx));

          // Debit ledger entry for sender
          await supabase
            .from('ledger_entries')
            .insert({
              tenant_id: ctx.tenantId,
              account_id: wallet.owner_account_id,
              type: 'debit',
              amount: execAmount,
              currency: currency || mandate.currency,
              balance_after: newTotal,
              reference_type: transfer ? 'transfer' : 'mandate_execution',
              reference_id: transfer?.id || mandate.id,
              description: description || `Mandate execution #${newExecIndex}`,
            });
        }

        // Credit destination account (cross-border)
        if (crossBorderInfo?.to_account_id && transfer?.id) {
          const { data: destAcct } = await supabase
            .from('accounts')
            .select('balance_total, balance_available, currency')
            .eq('id', crossBorderInfo.to_account_id)
            .eq('tenant_id', ctx.tenantId)
            .eq('environment', getEnv(ctx))
            .single();

          if (destAcct) {
            const newDestTotal = Number(destAcct.balance_total) + crossBorderInfo.destination_amount;
            const newDestAvailable = Number(destAcct.balance_available) + crossBorderInfo.destination_amount;
            await supabase
              .from('accounts')
              .update({
                balance_total: newDestTotal,
                balance_available: newDestAvailable,
                updated_at: new Date().toISOString(),
              })
              .eq('id', crossBorderInfo.to_account_id)
              .eq('tenant_id', ctx.tenantId)
              .eq('environment', getEnv(ctx));

            // Credit ledger entry for recipient
            await supabase
              .from('ledger_entries')
              .insert({
                tenant_id: ctx.tenantId,
                account_id: crossBorderInfo.to_account_id,
                type: 'credit',
                amount: crossBorderInfo.destination_amount,
                currency: crossBorderInfo.destination_currency,
                balance_after: newDestTotal,
                reference_type: 'transfer',
                reference_id: transfer.id,
                description: `Inbound remittance from ${fromAccount?.name || 'sender'}`,
              });
          }
        }
      }
    } else {
      console.warn(`[AP2] Wallet ${wallet.id} has insufficient balance (${currentBalance}) for execution amount (${execAmount})`);
      const telemetry = createCheckoutTelemetryService(supabase);
      telemetry.record({
        protocol: 'ap2',
        event_type: 'mandate.insufficient_balance',
        success: false,
        merchant_domain: extractMerchantDomain(mandate.description || mandate.mandate_id || '') || undefined,
        failure_reason: 'Insufficient wallet balance',
        failure_code: 'INSUFFICIENT_BALANCE',
        agent_id: mandate.agent_id,
        agent_name: mandate.agent_name,
        amount: execAmount,
        currency: currency || mandate.currency,
        protocol_metadata: { mandate_id: mandate.id, wallet_id: wallet.id, available: currentBalance },
      });
    }
  }

  // Build response
  const responseData: Record<string, any> = {
    mandate_id: id,
    execution_index: newExecIndex,
    amount: execAmount,
    currency: currency || mandate.currency,
    status: 'completed',
    used_amount: newUsed,
    remaining_amount: newRemaining,
    description,
    order_ids: order_ids || [],
    wallet_deduction: walletDeduction,
    funding_source_charge: fundingSourceCharge,
    settlement_rail: mandate.settlement_rail || null,
    settlement_tx_hash: settlementTxHash || undefined,
    settlement_network: settlementNetwork || undefined,
  };

  // Record successful mandate execution telemetry
  {
    const telemetry = createCheckoutTelemetryService(supabase);
    telemetry.record({
      protocol: 'ap2',
      event_type: 'mandate.executed',
      success: true,
      merchant_domain: extractMerchantDomain(mandate.description || mandate.mandate_id || '') || undefined,
      agent_id: mandate.agent_id,
      agent_name: mandate.agent_name,
      amount: execAmount,
      currency: currency || mandate.currency,
      protocol_metadata: { mandate_id: mandate.id, execution_index: newExecIndex },
    });
  }

  // Enrich with cross-border details
  if (crossBorderInfo) {
    responseData.destination_amount = crossBorderInfo.destination_amount;
    responseData.destination_currency = crossBorderInfo.destination_currency;
    responseData.fx_rate = crossBorderInfo.fx_rate;
    responseData.corridor = crossBorderInfo.corridor_id;
    responseData.fee_amount = crossBorderInfo.fee_amount;
    responseData.to_account_id = crossBorderInfo.to_account_id;
    responseData.to_account_name = crossBorderInfo.to_account_name;
  }

  trackOp({
    tenantId: ctx.tenantId,
    operation: OpType.AP2_MANDATE_EXECUTED,
    subject: `ap2/mandate/${mandate.id}`,
    actorType: ctx.actorType,
    actorId: ctx.actorId || ctx.userId || ctx.apiKeyId,
    correlationId: c.get('requestId'),
    success: true,
  });

  return c.json({ data: responseData }, 201);
});

// =============================================================================
// Payments
// =============================================================================

/**
 * POST /v1/ap2/payments
 * Request payment using a mandate
 * 
 * Story 18.R3: Includes spending policy checks for agent wallets
 */
ap2.post('/payments', async (c) => {
  const ctx = c.get('ctx');
  
  let body;
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError('Invalid JSON body');
  }
  
  const { mandate_id, amount, currency, description, reference, destination, metadata, wallet_id } = body;
  
  if (!mandate_id || !amount || !currency) {
    throw new ValidationError('mandate_id, amount, and currency are required');
  }

  const supabase = createClient();
  const mandateService = getAP2MandateService();

  // Get mandate to check payer info
  const mandate = await mandateService.getMandate(mandate_id);
  if (!mandate) {
    return c.json({ error: 'Mandate not found' }, 404);
  }

  // ============================================
  // SPENDING POLICY CHECK (Story 18.R3)
  // ============================================
  // If wallet_id is provided or we can resolve agent wallet, check spending policy
  
  let walletId = wallet_id;
  
  // Try to find agent wallet if not provided
  if (!walletId && mandate.payer.agent_id) {
    const { data: wallet } = await supabase
      .from('wallets')
      .select('id')
      .eq('managed_by_agent_id', mandate.payer.agent_id)
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .eq('status', 'active')
      .single();
    
    if (wallet) {
      walletId = wallet.id;
    }
  }

  // Check spending policy if we have a wallet
  if (walletId) {
    const spendingPolicyService = createSpendingPolicyService(supabase);
    const approvalWorkflowService = createApprovalWorkflowService(supabase);
    
    const policyContext: PolicyContext = {
      protocol: 'ap2',
      vendor: mandate.payee.name,
      mandateId: mandate_id,
    };

    const policyCheck = await spendingPolicyService.checkPolicy(
      walletId,
      amount,
      policyContext,
      c.get('requestId')
    );

    if (!policyCheck.allowed) {
      if (policyCheck.requiresApproval) {
        // Create approval request
        const approval = await approvalWorkflowService.createApproval({
          tenantId: ctx.tenantId,
          walletId,
          agentId: mandate.payer.agent_id,
          protocol: 'ap2',
          amount,
          currency,
          recipient: {
            mandate_id,
            merchant: mandate.payee.name,
          },
          paymentContext: {
            mandate_id,
            amount,
            currency,
            description,
            reference,
            destination,
            metadata,
            mandate: {
              id: mandate.id,
              payee: mandate.payee,
              payer: mandate.payer,
            },
          },
          requestedByType: ctx.actorType,
          requestedById: ctx.userId || ctx.apiKeyId || ctx.actorId || 'unknown',
          requestedByName: ctx.userName || ctx.actorName || undefined,
          correlationId: c.get('requestId'),
        });

        return c.json({
          status: 'pending_approval',
          message: 'Payment requires approval',
          reason: policyCheck.reason,
          code: 'APPROVAL_REQUIRED',
          approval: {
            id: approval.id,
            expiresAt: approval.expiresAt,
            amount: approval.amount,
            currency: approval.currency,
          }
        }, 202);
      }

      // Hard limit exceeded
      return c.json({
        error: 'Payment blocked by spending policy',
        reason: policyCheck.reason,
        code: 'POLICY_VIOLATION',
        violationType: policyCheck.violationType,
      }, 403);
    }
  }

  // Proceed with mandate payment
  const response = await mandateService.requestPayment({
    id: `req_${randomUUID()}`,
    mandate_id,
    amount,
    currency,
    description,
    reference,
    destination,
    metadata,
  });

  // Record spending if payment authorized and we have a wallet
  if (walletId && response.status === 'authorized') {
    const spendingPolicyService = createSpendingPolicyService(supabase);
    await spendingPolicyService.recordSpending(walletId, amount);
  }
  
  return c.json({ data: response }, response.status === 'rejected' ? 400 : 201);
});

/**
 * GET /v1/ap2/payments/:id
 * Get payment status
 */
ap2.get('/payments/:id', async (c) => {
  const id = c.req.param('id');
  const mandateService = getAP2MandateService();
  
  const payment = await mandateService.getPayment(id);
  
  if (!payment) {
    return c.json({ error: 'Payment not found' }, 404);
  }
  
  return c.json({ data: payment });
});

/**
 * POST /v1/ap2/payments/:id/settle
 * Trigger settlement for an authorized payment
 */
ap2.post('/payments/:id/settle', async (c) => {
  const id = c.req.param('id');
  const mandateService = getAP2MandateService();
  
  const payment = await mandateService.getPayment(id);
  
  if (!payment) {
    return c.json({ error: 'Payment not found' }, 404);
  }
  
  if (payment.status !== 'authorized') {
    return c.json({ 
      error: `Cannot settle payment in ${payment.status} status` 
    }, 400);
  }
  
  // Update to processing
  const updated = await mandateService.updatePayment(id, {
    status: 'processing',
  });
  
  // In real implementation, this would trigger actual settlement
  // For PoC, simulate completion after short delay
  setTimeout(async () => {
    await mandateService.updatePayment(id, {
      status: 'completed',
      transfer_id: `txn_${randomUUID()}`,
    });
  }, 1000);

    return c.json({
    data: updated,
    message: 'Settlement initiated',
  });
});

// =============================================================================
// Analytics
// =============================================================================

/**
 * GET /v1/ap2/analytics
 * AP2-specific analytics
 */
ap2.get('/analytics', async (c) => {
  try {
    const ctx = c.get('ctx');
    const period = c.req.query('period') || '30d';
    const supabase = createClient();

    // Calculate date range
    const end = new Date();
    const start = new Date();
    switch (period) {
      case '24h': start.setHours(start.getHours() - 24); break;
      case '7d': start.setDate(start.getDate() - 7); break;
      case '30d': start.setDate(start.getDate() - 30); break;
      case '90d': start.setDate(start.getDate() - 90); break;
      case '1y': start.setFullYear(start.getFullYear() - 1); break;
    }
    
    // Fetch AP2 transfers (these come from mandate payments)
    const { data: transfers } = await supabase
      .from('transfers')
      .select('id, amount, fee_amount, created_at, protocol_metadata')
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .eq('type', 'ap2')
      .eq('status', 'completed')
      .gte('created_at', start.toISOString())
      .lte('created_at', end.toISOString());

    // Fetch AP2 mandates from database (if stored there)
    const { data: mandates } = await supabase
      .from('ap2_mandates')
      .select('*')
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx));

    // Calculate revenue and fees
    const revenue = transfers?.reduce((sum, t) => sum + parseFloat(t.amount), 0) || 0;
    const fees = transfers?.reduce((sum, t) => sum + parseFloat(t.fee_amount || '0'), 0) || 0;

    // Mandate stats (from DB or empty if table doesn't exist)
    const mandateList = mandates || [];
    const activeMandates = mandateList.filter((m: any) => m.status === 'active').length;
    const revokedMandates = mandateList.filter((m: any) => m.status === 'revoked').length;
    const totalAuthorized = mandateList.reduce((sum: number, m: any) => sum + parseFloat(m.authorized_amount || '0'), 0);
    const totalUsed = mandateList.reduce((sum: number, m: any) => sum + parseFloat(m.used_amount || '0'), 0);

    // Unique agents and accounts
    const uniqueAgents = new Set(mandateList.map((m: any) => m.agent_id).filter(Boolean)).size;
    const uniqueAccounts = new Set(mandateList.map((m: any) => m.account_id).filter(Boolean)).size;

    return c.json({
      data: {
        period,
        summary: {
          totalRevenue: parseFloat(revenue.toFixed(8)),
          totalFees: parseFloat(fees.toFixed(8)),
          netRevenue: parseFloat((revenue - fees).toFixed(8)),
          transactionCount: transfers?.length || 0,
          totalMandates: mandateList.length,
          activeMandates,
          revokedMandates,
          totalAuthorized: parseFloat(totalAuthorized.toFixed(8)),
          totalUsed: parseFloat(totalUsed.toFixed(8)),
          utilizationRate: totalAuthorized > 0 ? parseFloat(((totalUsed / totalAuthorized) * 100).toFixed(2)) : 0,
          uniqueAgents,
          uniqueAccounts,
        },
        mandatesByStatus: {
          active: activeMandates,
          revoked: revokedMandates,
          pending: mandateList.filter((m: any) => m.status === 'pending').length,
        },
        paymentsByStatus: {
          completed: transfers?.length || 0,
          pending: 0,
          failed: 0,
          pending_approval: 0,
        },
        startDate: start.toISOString(),
        endDate: end.toISOString(),
      },
    });
  } catch (error) {
    console.error('[AP2] Analytics error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

export default ap2;
