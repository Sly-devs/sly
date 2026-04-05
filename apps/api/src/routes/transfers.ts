import { Hono } from 'hono';
import { z } from 'zod';
import { createClient } from '../db/client.js';
import {
  mapTransferFromDb,
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
  InsufficientBalanceError
} from '../middleware/error.js';
import { storeIdempotencyResponse } from '../middleware/idempotency.js';
import { ErrorCode } from '@sly/types';
import { trackFirstEvent } from '../services/beta-access.js';
import { triggerWorkflows } from '../services/workflow-trigger.js';
import {
  sendTransferCompletedEmail,
  sendTransferFailedEmail,
  getNotificationRecipients,
} from '../services/email.js';

const transfers = new Hono();

// ============================================
// VALIDATION SCHEMAS
// ============================================

const createTransferSchema = z.object({
  fromAccountId: z.string().uuid(),
  toAccountId: z.string().uuid(),
  amount: z.number().positive(),
  destinationCurrency: z.string().optional(),
  quoteId: z.string().uuid().optional(),
  description: z.string().max(500).optional(),
});

// ============================================
// GET /v1/transfers - List transfers
// ============================================
transfers.get('/', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();
  
  // Parse query params
  const query = c.req.query();
  const { page, limit } = getPaginationParams(query);
  const status = query.status;
  const type = query.type;
  const fromDate = query.fromDate;
  const toDate = query.toDate;
  
  // Agent/actor filter
  const initiatedById = query.initiated_by_id;
  const initiatedByType = query.initiated_by_type;

  // Wallet filter — find transfers involving a specific wallet's owner account
  const walletId = query.walletId || query.x402_wallet_id;

  // x402-specific filters
  const endpointId = query.endpointId;
  const providerId = query.providerId; // Filter by provider account (endpoint owner)
  const consumerId = query.consumerId; // Filter by consumer account (payer)
  const currency = query.currency;
  const minAmount = query.minAmount;
  const maxAmount = query.maxAmount;
  
  // Build query
  let dbQuery = supabase
    .from('transfers')
    .select('*', { count: 'exact' })
    .eq('environment', getEnv(ctx))
    .order('created_at', { ascending: false })
    .range((page - 1) * limit, page * limit - 1);

  // Agent tokens: scope to transfers the agent initiated OR where
  // the agent's parent account is a party (from/to), including cross-tenant.
  if (ctx.actorType === 'agent' && ctx.actorId) {
    const parentAccountId = ctx.parentAccountId;
    if (parentAccountId) {
      // Agent can see transfers it initiated OR where its parent account is sender/receiver
      dbQuery = dbQuery.or(
        `initiated_by_id.eq.${ctx.actorId},from_account_id.eq.${parentAccountId},to_account_id.eq.${parentAccountId}`
      );
    } else {
      // No parent account — only transfers this agent initiated, scoped to tenant
      dbQuery = dbQuery
        .eq('tenant_id', ctx.tenantId)
        .eq('initiated_by_id', ctx.actorId);
    }
  } else {
    // Non-agent actors: strict tenant scoping
    dbQuery = dbQuery.eq('tenant_id', ctx.tenantId);
  }

  if (status) {
    dbQuery = dbQuery.eq('status', status);
  }
  if (type) {
    dbQuery = dbQuery.eq('type', type);
  }
  if (fromDate) {
    dbQuery = dbQuery.gte('created_at', fromDate);
  }
  if (toDate) {
    dbQuery = dbQuery.lte('created_at', toDate);
  }
  if (currency) {
    dbQuery = dbQuery.eq('currency', currency);
  }
  if (minAmount) {
    dbQuery = dbQuery.gte('amount', minAmount);
  }
  if (maxAmount) {
    dbQuery = dbQuery.lte('amount', maxAmount);
  }
  
  if (initiatedById) {
    dbQuery = dbQuery.eq('initiated_by_id', initiatedById);
  }
  if (initiatedByType) {
    dbQuery = dbQuery.eq('initiated_by_type', initiatedByType);
  }

  // Protocol-specific filters using JSONB metadata
  if (endpointId && isValidUUID(endpointId)) {
    dbQuery = dbQuery.contains('protocol_metadata', { endpoint_id: endpointId });
  }
  if (providerId && isValidUUID(providerId)) {
    dbQuery = dbQuery.eq('to_account_id', providerId);
  }
  if (consumerId && isValidUUID(consumerId)) {
    dbQuery = dbQuery.eq('from_account_id', consumerId);
  }

  // Wallet-based filter: find transfers linked to this wallet via protocol_metadata
  if (walletId && isValidUUID(walletId)) {
    // Verify wallet belongs to this tenant
    const { data: wallet } = await supabase
      .from('wallets')
      .select('id')
      .eq('id', walletId)
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .single();

    if (!wallet) {
      return c.json(paginationResponse([], 0, { page, limit }));
    }

    // Match transfers where this wallet is source or destination in protocol_metadata
    dbQuery = dbQuery.or(
      `protocol_metadata->>source_wallet_id.eq.${walletId},protocol_metadata->>destination_wallet_id.eq.${walletId},protocol_metadata->>x402_wallet_id.eq.${walletId}`
    );
  }

  const { data, count, error } = await dbQuery;
  
  if (error) {
    console.error('Error fetching transfers:', error);
    throw new Error('Failed to fetch transfers from database');
  }
  
  // Batch-fetch agent on-chain IDs and wallet addresses for agent-initiated transfers
  const agentInitiatedIds = [...new Set(
    (data || []).filter(r => r.initiated_by_type === 'agent' && r.initiated_by_id).map(r => r.initiated_by_id)
  )];
  const agentOnChainMap = new Map<string, string>();
  const agentWalletMap = new Map<string, string>();
  if (agentInitiatedIds.length > 0) {
    const [{ data: agents }, { data: wallets }] = await Promise.all([
      supabase.from('agents').select('id, erc8004_agent_id').in('id', agentInitiatedIds).eq('environment', getEnv(ctx)),
      supabase.from('wallets').select('managed_by_agent_id, wallet_address').in('managed_by_agent_id', agentInitiatedIds).eq('environment', getEnv(ctx)).like('wallet_address', '0x%'),
    ]);
    for (const a of agents || []) {
      if (a.erc8004_agent_id) agentOnChainMap.set(a.id, a.erc8004_agent_id);
    }
    for (const w of wallets || []) {
      if (w.managed_by_agent_id && w.wallet_address) agentWalletMap.set(w.managed_by_agent_id, w.wallet_address);
    }
  }

  const transfers = (data || []).map(row => {
    if (row.initiated_by_type === 'agent') {
      if (agentOnChainMap.has(row.initiated_by_id)) {
        row.initiator_erc8004_agent_id = agentOnChainMap.get(row.initiated_by_id);
      }
      if (agentWalletMap.has(row.initiated_by_id)) {
        row.initiator_wallet_address = agentWalletMap.get(row.initiated_by_id);
      }
    }
    return mapTransferFromDb(row);
  });

  return c.json(paginationResponse(transfers, count || 0, { page, limit }));
});

// ============================================
// POST /v1/transfers - Create transfer
// ============================================
transfers.post('/', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();
  
  // Get idempotency key from middleware context or header (fallback)
  const idempotencyKey = c.get('idempotencyKey') || c.req.header('X-Idempotency-Key');
  const requestHash = c.get('idempotencyRequestHash');
  
  if (idempotencyKey) {
    // Check for existing transfer with this key (legacy check in transfers table)
    const { data: existing } = await supabase
      .from('transfers')
      .select('*')
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .eq('idempotency_key', idempotencyKey)
      .single();
    
    if (existing) {
      // Return existing transfer
      return c.json({ data: mapTransferFromDb(existing) });
    }
  }
  
  // Parse and validate body
  let body;
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError('Invalid JSON body');
  }
  
  const parsed = createTransferSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError('Validation failed', parsed.error.flatten());
  }
  
  const { fromAccountId, toAccountId, amount, destinationCurrency, quoteId, description } = parsed.data;
  
  // Validate accounts exist and belong to tenant
  const { data: fromAccount, error: fromError } = await supabase
    .from('accounts')
    .select('id, name, balance_available, verification_status')
    .eq('id', fromAccountId)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();

  if (fromError || !fromAccount) {
    throw new NotFoundError('Source account', fromAccountId);
  }

  const { data: toAccount, error: toError } = await supabase
    .from('accounts')
    .select('id, name, verification_status, tenant_id')
    .eq('id', toAccountId)
    .eq('environment', getEnv(ctx))
    .single();
  
  if (toError || !toAccount) {
    throw new NotFoundError('Destination account', toAccountId);
  }
  
  // Check sender has sufficient balance
  const availableBalance = parseFloat(fromAccount.balance_available) || 0;
  if (availableBalance < amount) {
    throw new InsufficientBalanceError(
      fromAccountId,
      availableBalance.toString(),
      amount.toString(),
      'USD'
    );
  }
  
  // Determine transfer type
  const isInternal = !destinationCurrency || destinationCurrency === 'USDC' || destinationCurrency === 'USD';
  const transferType = isInternal ? 'internal' : 'cross_border';
  
  // Get quote details if provided
  let fxRate = 1;
  let destinationAmount = amount;
  let feeAmount = 0;
  
  if (quoteId) {
    const { data: quote, error: quoteError } = await supabase
      .from('quotes')
      .select('*')
      .eq('id', quoteId)
      .eq('tenant_id', ctx.tenantId)
      .single();
    
    if (quoteError || !quote) {
      throw new NotFoundError('Quote', quoteId);
    }
    
    // Check quote is not expired
    if (new Date(quote.expires_at) < new Date()) {
      throw new QuoteExpiredError(quoteId, quote.expires_at);
    }
    
    // Check quote is not already used
    if (quote.used_at) {
      const error: any = new ValidationError('Quote has already been used');
      error.details = { quote_id: quoteId, used_at: quote.used_at };
      throw error;
    }
    
    fxRate = parseFloat(quote.fx_rate);
    destinationAmount = parseFloat(quote.to_amount);
    feeAmount = parseFloat(quote.fee_amount);
  } else if (!isInternal) {
    // For cross-border without quote, calculate on the fly (not recommended)
    const { getExchangeRate } = await import('@sly/utils');
    fxRate = getExchangeRate('USD', destinationCurrency!);
    feeAmount = amount * 0.007; // 0.7% fee
    destinationAmount = (amount - feeAmount) * fxRate;
  }
  
  // Create transfer
  const { data: transfer, error: createError } = await supabase
    .from('transfers')
    .insert({
      tenant_id: ctx.tenantId,
      destination_tenant_id: toAccount.tenant_id || ctx.tenantId,
      environment: getEnv(ctx),
      type: transferType,
      status: isInternal ? 'completed' : 'processing', // Internal transfers complete instantly
      from_account_id: fromAccountId,
      from_account_name: fromAccount.name,
      to_account_id: toAccountId,
      to_account_name: toAccount.name,
      initiated_by_type: ctx.actorType,
      initiated_by_id: ctx.actorId,
      initiated_by_name: ctx.actorName,
      amount,
      currency: 'USDC',
      destination_amount: destinationAmount,
      destination_currency: destinationCurrency || 'USDC',
      fx_rate: fxRate,
      fee_amount: feeAmount,
      description,
      idempotency_key: idempotencyKey,
      processing_at: isInternal ? null : new Date().toISOString(),
      completed_at: isInternal ? new Date().toISOString() : null,
    })
    .select()
    .single();
  
  if (createError) {
    console.error('Error creating transfer:', createError);
    throw new Error('Failed to create transfer in database');
  }
  
  // For internal transfers, execute immediately
  if (isInternal) {
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
        .eq('id', transfer.id)
        .eq('environment', getEnv(ctx));

      // Notify tenant admins of failure (fire-and-forget)
      getNotificationRecipients(ctx.tenantId).then(emails => {
        for (const email of emails) {
          sendTransferFailedEmail({
            to: email,
            amount: amount.toString(),
            currency: 'USDC',
            recipientName: toAccount.name,
            transferId: transfer.id,
            reason: error.message,
          }).catch(err => console.error('[email] Transfer failed email error:', err));
        }
      }).catch(() => {});

      throw error;
    }

    // Notify tenant admins of successful transfer (fire-and-forget)
    getNotificationRecipients(ctx.tenantId).then(emails => {
      for (const email of emails) {
        sendTransferCompletedEmail({
          to: email,
          amount: amount.toString(),
          currency: 'USDC',
          recipientName: toAccount.name,
          transferId: transfer.id,
        }).catch(err => console.error('[email] Transfer completed email error:', err));
      }
    }).catch(() => {});
  }
  
  // Mark quote as used
  if (quoteId) {
    await supabase
      .from('quotes')
      .update({
        used_at: new Date().toISOString(),
        transfer_id: transfer.id,
      })
      .eq('id', quoteId);
  }
  
  // Audit log
  await logAudit(supabase, {
    tenantId: ctx.tenantId,
    entityType: 'transfer',
    entityId: transfer.id,
    action: 'created',
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    actorName: ctx.actorName,
    metadata: {
      type: transferType,
      amount,
      from: fromAccount.name,
      to: toAccount.name,
    },
  });
  
  // Track first transaction for beta funnel (fire-and-forget)
  trackFirstEvent(ctx.tenantId, 'first_transaction').catch(() => {});

  // Fire workflow auto-triggers (fire-and-forget)
  triggerWorkflows(supabase, ctx.tenantId, 'transfer', 'insert', {
    id: transfer.id,
    type: transferType,
    amount,
    currency: 'USDC',
    from_account_id: fromAccountId,
    to_account_id: toAccountId,
    description,
    status: transfer.status,
  }).catch(console.error);

  const responseBody = {
    data: mapTransferFromDb(transfer),
    links: {
      self: `/v1/transfers/${transfer.id}`,
      from_account: `/v1/accounts/${fromAccountId}`,
      to_account: `/v1/accounts/${toAccountId}`,
    },
    next_actions: isInternal 
      ? [
          {
            action: 'view_account',
            description: 'View updated account balance',
            endpoint: `/v1/accounts/${toAccountId}/balances`,
          }
        ]
      : [
          {
            action: 'check_status',
            description: 'Poll for transfer completion status',
            endpoint: `/v1/transfers/${transfer.id}`,
            recommended_interval_seconds: 30,
          }
        ],
  };
  
  // Store in idempotency infrastructure for future duplicate detection
  if (idempotencyKey && requestHash) {
    storeIdempotencyResponse(
      ctx.tenantId,
      idempotencyKey,
      requestHash,
      '/v1/transfers',
      'POST',
      201,
      responseBody
    ).catch((err) => console.error('Failed to store idempotency response:', err));
  }
  
  return c.json(responseBody, 201);
});

// ============================================
// GET /v1/transfers/:id - Get single transfer
// ============================================
transfers.get('/:id', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  const supabase = createClient();
  
  if (!isValidUUID(id)) {
    throw new ValidationError('Invalid transfer ID format');
  }
  
  let singleQuery = supabase
    .from('transfers')
    .select('*')
    .eq('id', id)
    .eq('environment', getEnv(ctx));

  // For agents, allow cross-tenant access (verified below); others get strict tenant scoping
  if (ctx.actorType !== 'agent') {
    singleQuery = singleQuery.eq('tenant_id', ctx.tenantId);
  }

  const { data, error } = await singleQuery.single();

  if (error || !data) {
    throw new NotFoundError('Transfer', id);
  }

  // For agent actors, verify they are a party to this transfer
  if (ctx.actorType === 'agent') {
    const parentAccountId = ctx.parentAccountId;
    const isParty =
      data.initiated_by_id === ctx.actorId ||
      (parentAccountId && (
        data.from_account_id === parentAccountId ||
        data.to_account_id === parentAccountId
      ));
    if (!isParty) {
      throw new NotFoundError('Transfer', id);
    }
  }

  // Enrich missing account names
  if (!data.from_account_name && data.from_account_id) {
    const { data: fromAcct } = await supabase.from('accounts').select('name').eq('id', data.from_account_id).eq('environment', getEnv(ctx)).single();
    if (fromAcct?.name) data.from_account_name = fromAcct.name;
  }
  if (!data.to_account_name && data.to_account_id) {
    const { data: toAcct } = await supabase.from('accounts').select('name').eq('id', data.to_account_id).eq('environment', getEnv(ctx)).single();
    if (toAcct?.name) data.to_account_name = toAcct.name;
  }

  // Enrich with agent's on-chain identity and wallet if initiated by an agent
  if (data.initiated_by_type === 'agent' && data.initiated_by_id) {
    const { data: agent } = await supabase
      .from('agents')
      .select('erc8004_agent_id')
      .eq('id', data.initiated_by_id)
      .eq('environment', getEnv(ctx))
      .single();
    if (agent?.erc8004_agent_id) {
      data.initiator_erc8004_agent_id = agent.erc8004_agent_id;
    }
    const { data: wallet } = await supabase
      .from('wallets')
      .select('wallet_address')
      .eq('managed_by_agent_id', data.initiated_by_id)
      .eq('environment', getEnv(ctx))
      .like('wallet_address', '0x%')
      .limit(1)
      .single();
    if (wallet?.wallet_address) {
      data.initiator_wallet_address = wallet.wallet_address;
    }
  }

  const transfer = mapTransferFromDb(data);
  const responseBody: any = {
    data: transfer,
    links: {
      self: `/v1/transfers/${id}`,
      from_account: `/v1/accounts/${data.from_account_id}`,
      to_account: `/v1/accounts/${data.to_account_id}`,
      ...(data.tx_hash ? { explorer: `https://sepolia.basescan.org/tx/${data.tx_hash}` } : {}),
    },
  };
  
  // Add next actions based on transfer status
  if (data.status === 'processing') {
    responseBody.next_actions = [
      {
        action: 'check_status',
        description: 'Poll for transfer completion status',
        endpoint: `/v1/transfers/${id}`,
        recommended_interval_seconds: 30,
      }
    ];
  } else if (data.status === 'pending') {
    responseBody.next_actions = [
      {
        action: 'cancel_transfer',
        description: 'Cancel this pending transfer',
        endpoint: `/v1/transfers/${id}/cancel`,
      },
      {
        action: 'check_status',
        description: 'Check transfer status',
        endpoint: `/v1/transfers/${id}`,
      }
    ];
  }
  
  return c.json(responseBody);
});

// ============================================
// POST /v1/transfers/:id/cancel - Cancel pending transfer
// ============================================
transfers.post('/:id/cancel', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  const supabase = createClient();
  
  if (!isValidUUID(id)) {
    throw new ValidationError('Invalid transfer ID format');
  }
  
  const { data: transfer, error: fetchError } = await supabase
    .from('transfers')
    .select('*')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();

  if (fetchError || !transfer) {
    throw new NotFoundError('Transfer', id);
  }

  // Can only cancel pending transfers
  if (transfer.status !== 'pending') {
    const error: any = new ValidationError(`Cannot cancel transfer with status: ${transfer.status}`);
    error.details = {
      transfer_id: id,
      current_status: transfer.status,
      cancellable_statuses: ['pending'],
    };
    throw error;
  }
  
  // Update status
  const { data, error } = await supabase
    .from('transfers')
    .update({
      status: 'cancelled',
      failed_at: new Date().toISOString(),
      failure_reason: 'Cancelled by user',
    })
    .eq('id', id)
    .eq('environment', getEnv(ctx))
    .select()
    .single();
  
  if (error) {
    console.error('Error cancelling transfer:', error);
    throw new Error('Failed to cancel transfer in database');
  }
  
  // Audit log
  await logAudit(supabase, {
    tenantId: ctx.tenantId,
    entityType: 'transfer',
    entityId: id,
    action: 'cancelled',
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    actorName: ctx.actorName,
  });
  
  return c.json({ 
    data: mapTransferFromDb(data),
    links: {
      self: `/v1/transfers/${id}`,
      from_account: `/v1/accounts/${data.from_account_id}`,
      to_account: `/v1/accounts/${data.to_account_id}`,
    },
  });
});

export default transfers;
