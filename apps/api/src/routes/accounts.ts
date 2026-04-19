import { Hono } from 'hono';
import { z } from 'zod';
import { createClient } from '../db/client.js';
import {
  mapAccountFromDb,
  mapAgentFromDb,
  mapStreamFromDb,
  logAudit,
  isValidUUID,
  isValidEmail,
  getPaginationParams,
  paginationResponse,
  sanitizeSearchInput,
  getEnv,
} from '../utils/helpers.js';
import { ValidationError, NotFoundError, ForbiddenError } from '../middleware/error.js';
import { ErrorCode } from '@sly/types';
import { onboardEntity, type OnboardingInput } from '../services/entity-onboarding.js';
import { triggerWorkflows } from '../services/workflow-trigger.js';
import { trackOp } from '../services/ops/track-op.js';
import { OpType } from '../services/ops/operation-types.js';
import { verifyT1 } from '../services/kyc/t1-verification.js';
import { initiatePersonaVerification, initiatePersonaKYB } from '../services/kyc/persona.js';
import { createEDDReview } from '../services/kyc/enterprise-review.js';
import { isSanctionedCountry } from '../services/kyc/screening.js';

const accounts = new Hono();

// ============================================
// VALIDATION SCHEMAS
// ============================================

const createAccountSchema = z.object({
  type: z.enum(['person', 'business']),
  name: z.string().min(1).max(255),
  email: z.string().email().optional(),
  metadata: z.record(z.any()).optional(),
});

const updateAccountSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  email: z.string().email().optional().nullable(),
  metadata: z.record(z.any()).optional(),
});

// ============================================
// GET /v1/accounts - List accounts
// ============================================
accounts.get('/', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();
  
  // Parse query params
  const query = c.req.query();
  const type = query.type as 'person' | 'business' | undefined;
  const search = query.search;
  const status = query.status;
  const { page, limit } = getPaginationParams(query);
  
  // Build query
  let dbQuery = supabase
    .from('accounts')
    .select('*', { count: 'exact' })
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .order('created_at', { ascending: false })
    .range((page - 1) * limit, page * limit - 1);
  
  // Apply filters
  if (type) {
    dbQuery = dbQuery.eq('type', type);
  }
  if (search) {
    const safe = sanitizeSearchInput(search);
    dbQuery = dbQuery.or(`name.ilike.%${safe}%,email.ilike.%${safe}%`);
  }
  if (status) {
    dbQuery = dbQuery.eq('verification_status', status);
  }
  
  const { data, count, error } = await dbQuery;
  
  if (error) {
    console.error('Error fetching accounts:', error);
    throw new Error('Failed to fetch accounts from database');
  }
  
  // Get agent counts for each account
  const accountIds = data?.map(a => a.id) || [];
  let agentCounts: Record<string, { count: number; active: number }> = {};
  
  if (accountIds.length > 0) {
    const { data: agentData } = await supabase
      .from('agents')
      .select('parent_account_id, status')
      .in('parent_account_id', accountIds)
      .eq('environment', getEnv(ctx));
    
    if (agentData) {
      for (const agent of agentData) {
        if (!agentCounts[agent.parent_account_id]) {
          agentCounts[agent.parent_account_id] = { count: 0, active: 0 };
        }
        agentCounts[agent.parent_account_id].count++;
        if (agent.status === 'active') {
          agentCounts[agent.parent_account_id].active++;
        }
      }
    }
  }
  
  // Map to response format
  const accounts = (data || []).map(row => {
    const account = mapAccountFromDb(row);
    account.agents = agentCounts[row.id] || { count: 0, active: 0 };
    return account;
  });
  
  return c.json(paginationResponse(accounts, count || 0, { page, limit }));
});

// ============================================
// POST /v1/accounts - Create account
// ============================================
accounts.post('/', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();
  
  // Parse and validate body
  let body;
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError('Invalid JSON body');
  }
  
  const parsed = createAccountSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError('Validation failed', parsed.error.flatten());
  }
  
  const { type, name, email, metadata } = parsed.data;
  
  // Check for duplicate email if provided
  if (email) {
    const { data: existing } = await supabase
      .from('accounts')
      .select('id')
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .eq('email', email)
      .single();
    
    if (existing) {
      throw new ValidationError('An account with this email already exists');
    }
  }
  
  // Create account
  const { data, error } = await supabase
    .from('accounts')
    .insert({
      tenant_id: ctx.tenantId,
      environment: getEnv(ctx),
      type,
      name,
      email: email || null,
      verification_type: type === 'person' ? 'kyc' : 'kyb',
      metadata: metadata || {},
    })
    .select()
    .single();
  
  if (error) {
    console.error('Error creating account:', error);
    throw new Error('Failed to create account in database');
  }
  
  // Audit log
  await logAudit(supabase, {
    tenantId: ctx.tenantId,
    entityType: 'account',
    entityId: data.id,
    action: 'created',
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    actorName: ctx.actorName,
    metadata: { type, name },
  });
  
  // Fire workflow auto-triggers (fire-and-forget)
  triggerWorkflows(supabase, ctx.tenantId, 'account', 'insert', {
    id: data.id, name, type, email,
  }).catch(console.error);

  const account = mapAccountFromDb(data);

  trackOp({
    tenantId: ctx.tenantId,
    operation: OpType.ENTITY_ACCOUNT_CREATED,
    subject: `account/${data.id}`,
    actorType: ctx.actorType,
    actorId: ctx.actorId || ctx.userId || ctx.apiKeyId,
    correlationId: c.get('requestId'),
    success: true,
  });

  return c.json({
    data: account,
    links: {
      self: `/v1/accounts/${data.id}`,
      balances: `/v1/accounts/${data.id}/balances`,
      transfers: `/v1/accounts/${data.id}/transfers`,
      agents: `/v1/accounts/${data.id}/agents`,
    },
    next_actions: [
      {
        action: 'add_funds',
        description: 'Fund this account to start making transfers',
        endpoint: `/v1/accounts/${data.id}/deposits`,
      },
      {
        action: 'create_agent',
        description: 'Create an AI agent for this account',
        endpoint: `/v1/agents`,
      },
      {
        action: 'verify_account',
        description: 'Complete KYC/KYB verification to increase limits',
        endpoint: `/v1/accounts/${data.id}/verify`,
      },
    ],
  }, 201);
});

// ============================================
// GET /v1/accounts/:id - Get single account
// ============================================
accounts.get('/:id', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  const supabase = createClient();
  
  if (!isValidUUID(id)) {
    throw new ValidationError('Invalid account ID format');
  }
  
  const { data, error } = await supabase
    .from('accounts')
    .select('*')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();

  if (error || !data) {
    throw new NotFoundError('Account', id);
  }

  // Get agent counts
  const { data: agentData } = await supabase
    .from('agents')
    .select('status')
    .eq('parent_account_id', id)
    .eq('environment', getEnv(ctx));
  
  const agentCount = agentData?.length || 0;
  const activeAgentCount = agentData?.filter(a => a.status === 'active').length || 0;
  
  const account = mapAccountFromDb(data);
  account.agents = { count: agentCount, active: activeAgentCount };
  
  return c.json({ 
    data: account,
    links: {
      self: `/v1/accounts/${id}`,
      balances: `/v1/accounts/${id}/balances`,
      transfers: `/v1/accounts/${id}/transfers`,
      agents: `/v1/accounts/${id}/agents`,
      streams: `/v1/accounts/${id}/streams`,
      transactions: `/v1/accounts/${id}/transactions`,
    },
  });
});

// ============================================
// PATCH /v1/accounts/:id - Update account
// ============================================
accounts.patch('/:id', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  const supabase = createClient();
  
  if (!isValidUUID(id)) {
    throw new ValidationError('Invalid account ID format');
  }
  
  // Check account exists
  const { data: existing, error: fetchError } = await supabase
    .from('accounts')
    .select('*')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();

  if (fetchError || !existing) {
    throw new NotFoundError('Account', id);
  }

  // Parse and validate body
  let body;
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError('Invalid JSON body');
  }

  const parsed = updateAccountSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError('Validation failed', parsed.error.flatten());
  }

  const updates: Record<string, any> = {};
  if (parsed.data.name !== undefined) updates.name = parsed.data.name;
  if (parsed.data.email !== undefined) updates.email = parsed.data.email;
  if (parsed.data.metadata !== undefined) updates.metadata = parsed.data.metadata;

  if (Object.keys(updates).length === 0) {
    return c.json({ data: mapAccountFromDb(existing) });
  }

  // Check for duplicate email if updating
  if (updates.email && updates.email !== existing.email) {
    const { data: duplicate } = await supabase
      .from('accounts')
      .select('id')
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .eq('email', updates.email)
      .neq('id', id)
      .single();
    
    if (duplicate) {
      throw new ValidationError('An account with this email already exists');
    }
  }
  
  // Update account
  const { data, error } = await supabase
    .from('accounts')
    .update(updates)
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .select()
    .single();

  if (error) {
    console.error('Error updating account:', error);
    throw new Error('Failed to update account in database');
  }

  // Audit log
  await logAudit(supabase, {
    tenantId: ctx.tenantId,
    entityType: 'account',
    entityId: id,
    action: 'updated',
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    actorName: ctx.actorName,
    changes: {
      before: { name: existing.name, email: existing.email },
      after: { name: data.name, email: data.email },
    },
  });

  // Fire workflow auto-triggers (fire-and-forget)
  triggerWorkflows(supabase, ctx.tenantId, 'account', 'update', {
    id: data.id, name: data.name, email: data.email, type: data.type,
  }).catch(console.error);

  trackOp({
    tenantId: ctx.tenantId,
    operation: OpType.ENTITY_ACCOUNT_UPDATED,
    subject: `account/${id}`,
    actorType: ctx.actorType,
    actorId: ctx.actorId || ctx.userId || ctx.apiKeyId,
    correlationId: c.get('requestId'),
    success: true,
  });

  return c.json({
    data: mapAccountFromDb(data),
    links: {
      self: `/v1/accounts/${id}`,
      balances: `/v1/accounts/${id}/balances`,
    },
  });
});

// ============================================
// DELETE /v1/accounts/:id - Delete account
// ============================================
accounts.delete('/:id', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  const supabase = createClient();
  
  if (!isValidUUID(id)) {
    throw new ValidationError('Invalid account ID format');
  }
  
  // Check account exists
  const { data: existing, error: fetchError } = await supabase
    .from('accounts')
    .select('*')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();

  if (fetchError || !existing) {
    throw new NotFoundError('Account', id);
  }

  // Check for non-zero balance
  const balance = parseFloat(existing.balance_total) || 0;
  if (balance > 0) {
    throw new ValidationError('Cannot delete account with non-zero balance', {
      balance,
      message: 'Transfer all funds before deleting',
    });
  }

  // Check for active streams
  const { count: streamCount } = await supabase
    .from('streams')
    .select('*', { count: 'exact', head: true })
    .eq('environment', getEnv(ctx))
    .eq('status', 'active')
    .or(`sender_account_id.eq.${id},receiver_account_id.eq.${id}`);

  if (streamCount && streamCount > 0) {
    throw new ValidationError('Cannot delete account with active streams', {
      activeStreams: streamCount,
      message: 'Cancel all streams before deleting',
    });
  }

  // Check for agents
  const { count: agentCount } = await supabase
    .from('agents')
    .select('*', { count: 'exact', head: true })
    .eq('parent_account_id', id)
    .eq('environment', getEnv(ctx));

  if (agentCount && agentCount > 0) {
    throw new ValidationError('Cannot delete account with registered agents', {
      agentCount,
      message: 'Delete all agents before deleting account',
    });
  }

  // Delete account (cascades to ledger_entries)
  const { error } = await supabase
    .from('accounts')
    .delete()
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx));
  
  if (error) {
    console.error('Error deleting account:', error);
    throw new Error('Failed to delete account from database');
  }
  
  // Audit log
  await logAudit(supabase, {
    tenantId: ctx.tenantId,
    entityType: 'account',
    entityId: id,
    action: 'deleted',
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    actorName: ctx.actorName,
    metadata: { name: existing.name, type: existing.type },
  });
  
  return c.json({ data: { id, deleted: true } });
});

// ============================================
// GET /v1/accounts/:id/balances - Balance breakdown
// ============================================
accounts.get('/:id/balances', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  const supabase = createClient();
  
  if (!isValidUUID(id)) {
    throw new ValidationError('Invalid account ID format');
  }
  
  const { data, error } = await supabase
    .from('accounts')
    .select('id, name, balance_total, balance_available, balance_in_streams, balance_buffer')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();

  if (error || !data) {
    throw new NotFoundError('Account', id);
  }

  // Get stream counts
  const { data: streams } = await supabase
    .from('streams')
    .select('id, status, flow_rate_per_month, sender_account_id, receiver_account_id')
    .eq('environment', getEnv(ctx))
    .eq('status', 'active')
    .or(`sender_account_id.eq.${id},receiver_account_id.eq.${id}`);
  
  const outgoingStreams = streams?.filter(s => s.sender_account_id === id) || [];
  const incomingStreams = streams?.filter(s => s.receiver_account_id === id) || [];
  
  const outflowPerMonth = outgoingStreams.reduce((sum, s) => sum + parseFloat(s.flow_rate_per_month), 0);
  const inflowPerMonth = incomingStreams.reduce((sum, s) => sum + parseFloat(s.flow_rate_per_month), 0);
  const availableBalance = parseFloat(data.balance_available) || 0;
  
  const responseBody: any = {
    data: {
      accountId: data.id,
      accountName: data.name,
      balance: {
        total: parseFloat(data.balance_total) || 0,
        available: availableBalance,
        inStreams: {
          total: parseFloat(data.balance_in_streams) || 0,
          buffer: parseFloat(data.balance_buffer) || 0,
          streaming: (parseFloat(data.balance_in_streams) || 0) - (parseFloat(data.balance_buffer) || 0),
        },
        currency: 'USDC',
      },
      streams: {
        outgoing: {
          count: outgoingStreams.length,
          totalFlowPerMonth: outflowPerMonth,
        },
        incoming: {
          count: incomingStreams.length,
          totalFlowPerMonth: inflowPerMonth,
        },
        netFlowPerMonth: inflowPerMonth - outflowPerMonth,
      },
    },
    links: {
      self: `/v1/accounts/${id}/balances`,
      account: `/v1/accounts/${id}`,
      streams: `/v1/accounts/${id}/streams`,
      transactions: `/v1/accounts/${id}/transactions`,
    },
  };
  
  // Add next actions based on balance state
  if (availableBalance < 100) {
    responseBody.next_actions = [
      {
        action: 'add_funds',
        description: 'Add funds to this account',
        endpoint: `/v1/accounts/${id}/deposits`,
      }
    ];
  }
  
  return c.json(responseBody);
});

// ============================================
// GET /v1/accounts/:id/agents - Account's agents
// ============================================
accounts.get('/:id/agents', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  const supabase = createClient();
  
  if (!isValidUUID(id)) {
    throw new ValidationError('Invalid account ID format');
  }
  
  // Verify account exists and belongs to tenant
  const { data: account, error: accountError } = await supabase
    .from('accounts')
    .select('id, name, type, verification_tier')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();

  if (accountError || !account) {
    throw new NotFoundError('Account', id);
  }

  // Get agents
  const { data, error } = await supabase
    .from('agents')
    .select('*')
    .eq('parent_account_id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .order('created_at', { ascending: false });
  
  if (error) {
    console.error('Error fetching agents:', error);
    throw new Error('Failed to fetch agents from database');
  }
  
  const agents = (data || []).map(row => {
    const agent = mapAgentFromDb(row);
    agent.parentAccount = {
      id: account.id,
      type: account.type,
      name: account.name,
      verificationTier: account.verification_tier,
    };
    return agent;
  });
  
  return c.json({ data: agents });
});

// ============================================
// GET /v1/accounts/:id/streams - Account's streams
// ============================================
accounts.get('/:id/streams', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  const supabase = createClient();
  
  if (!isValidUUID(id)) {
    throw new ValidationError('Invalid account ID format');
  }
  
  // Verify account exists
  const { data: account, error: accountError } = await supabase
    .from('accounts')
    .select('id')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();

  if (accountError || !account) {
    throw new NotFoundError('Account', id);
  }

  // Parse query params
  const query = c.req.query();
  const status = query.status;
  const direction = query.direction as 'incoming' | 'outgoing' | undefined;

  // Get streams where account is sender or receiver
  let dbQuery = supabase
    .from('streams')
    .select('*')
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .order('created_at', { ascending: false });
  
  if (direction === 'outgoing') {
    dbQuery = dbQuery.eq('sender_account_id', id);
  } else if (direction === 'incoming') {
    dbQuery = dbQuery.eq('receiver_account_id', id);
  } else {
    dbQuery = dbQuery.or(`sender_account_id.eq.${id},receiver_account_id.eq.${id}`);
  }
  
  if (status) {
    dbQuery = dbQuery.eq('status', status);
  }
  
  const { data, error } = await dbQuery;
  
  if (error) {
    console.error('Error fetching streams:', error);
    throw new Error('Failed to fetch streams from database');
  }
  
  const streams = (data || []).map(row => mapStreamFromDb(row));
  
  return c.json({ data: streams });
});

// ============================================
// GET /v1/accounts/:id/transactions - Account's ledger entries (audit trail)
// ============================================
accounts.get('/:id/transactions', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  const supabase = createClient();
  
  if (!isValidUUID(id)) {
    throw new ValidationError('Invalid account ID format');
  }
  
  // Verify account exists and belongs to tenant
  const { data: account, error: accountError } = await supabase
    .from('accounts')
    .select('id, name')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();

  if (accountError || !account) {
    throw new NotFoundError('Account', id);
  }

  // Parse query params
  const query = c.req.query();
  const { page, limit } = getPaginationParams(query);
  const referenceType = query.referenceType || query.type;
  
  // Get ledger entries (not transfers - ledger is the source of truth)
  let dbQuery = supabase
    .from('ledger_entries')
    .select('*', { count: 'exact' })
    .eq('tenant_id', ctx.tenantId)
    .eq('account_id', id)
    .order('created_at', { ascending: false })
    .range((page - 1) * limit, page * limit - 1);
  
  if (referenceType) {
    dbQuery = dbQuery.eq('reference_type', referenceType);
  }
  
  const { data, count, error } = await dbQuery;
  
  if (error) {
    console.error('Error fetching transactions:', error);
    throw new Error('Failed to fetch transactions from database');
  }
  
  // Map ledger entries to transaction format
  const transactions = (data || []).map(entry => ({
    id: entry.id,
    type: entry.type, // credit or debit
    amount: parseFloat(entry.amount),
    currency: entry.currency || 'USDC',
    balanceAfter: parseFloat(entry.balance_after),
    referenceType: entry.reference_type,
    referenceId: entry.reference_id,
    description: entry.description,
    createdAt: entry.created_at,
  }));
  
  return c.json(paginationResponse(transactions, count || 0, { page, limit }));
});

// ============================================
// GET /v1/accounts/:id/transfers - Account's transfers (sent & received)
// ============================================
accounts.get('/:id/transfers', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  const supabase = createClient();
  
  if (!isValidUUID(id)) {
    throw new ValidationError('Invalid account ID format');
  }
  
  // Verify account exists and belongs to tenant
  const { data: account, error: accountError } = await supabase
    .from('accounts')
    .select('id, name')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();

  if (accountError || !account) {
    throw new NotFoundError('Account', id);
  }

  // Parse query params
  const query = c.req.query();
  const { page, limit } = getPaginationParams(query);
  const type = query.type; // Optional filter by transfer type
  const status = query.status; // Optional filter by status
  const direction = query.direction; // 'sent' | 'received' | 'all' (default: 'all')

  // Build query - get transfers where account is sender OR receiver
  // Filter in SQL for performance (not client-side)
  let dbQuery = supabase
    .from('transfers')
    .select('*', { count: 'exact' })
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .order('created_at', { ascending: false })
    .range((page - 1) * limit, page * limit - 1);
  
  // Filter by direction
  if (direction === 'sent') {
    dbQuery = dbQuery.eq('from_account_id', id);
  } else if (direction === 'received') {
    dbQuery = dbQuery.eq('to_account_id', id);
  } else {
    // Default: both sent and received
    dbQuery = dbQuery.or(`from_account_id.eq.${id},to_account_id.eq.${id}`);
  }
  
  // Apply additional filters
  if (type) {
    dbQuery = dbQuery.eq('type', type);
  }
  if (status) {
    dbQuery = dbQuery.eq('status', status);
  }
  
  const { data, count, error } = await dbQuery;
  
  if (error) {
    console.error('Error fetching transfers:', error);
    throw new Error('Failed to fetch transfers from database');
  }
  
  // Map transfers to response format
  const transfers = (data || []).map(transfer => ({
    id: transfer.id,
    type: transfer.type,
    status: transfer.status,
    fromAccountId: transfer.from_account_id,
    fromAccountName: transfer.from_account_name,
    toAccountId: transfer.to_account_id,
    toAccountName: transfer.to_account_name,
    amount: parseFloat(transfer.amount),
    currency: transfer.currency || 'USDC',
    description: transfer.description,
    createdAt: transfer.created_at,
    completedAt: transfer.completed_at,
    failedAt: transfer.failed_at,
    failureReason: transfer.failure_reason,
    // Include direction from perspective of this account
    direction: transfer.from_account_id === id ? 'sent' : 'received',
    // Include protocol metadata if present
    protocolMetadata: transfer.protocol_metadata || undefined,
    // @deprecated - for backward compatibility
    x402Metadata: transfer.protocol_metadata || transfer.x402_metadata || undefined,
  }));
  
  return c.json(paginationResponse(transfers, count || 0, { page, limit }));
});

// ============================================
// POST /v1/accounts/:id/verify - Mock KYC/KYB verification
// ============================================
const verifyAccountSchema = z.object({
  tier: z.number().min(0).max(3),
  verificationData: z.object({
    documentType: z.string().optional(),
    documentId: z.string().optional(),
    notes: z.string().optional(),
  }).optional(),
});

accounts.post('/:id/verify', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  const supabase = createClient();
  
  if (!isValidUUID(id)) {
    throw new ValidationError('Invalid account ID format');
  }
  
  // Parse and validate body
  let body;
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError('Invalid JSON body');
  }
  
  const parsed = verifyAccountSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError('Validation failed', parsed.error.flatten());
  }
  
  const { tier, verificationData } = parsed.data;
  
  // Get existing account
  const { data: existing, error: fetchError } = await supabase
    .from('accounts')
    .select('id, name, type, verification_tier, verification_status, tenant_id')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();

  if (fetchError || !existing) {
    throw new NotFoundError('Account', id);
  }

  // Determine verification type based on account type
  const verificationType = existing.type === 'business' ? 'kyb' : 'kyc';

  // Update verification status
  const { data, error } = await supabase
    .from('accounts')
    .update({
      verification_tier: tier,
      verification_status: tier > 0 ? 'verified' : 'unverified',
      verification_type: verificationType,
      metadata: {
        ...((existing as any).metadata || {}),
        verificationData,
        verifiedAt: tier > 0 ? new Date().toISOString() : null,
        verifiedBy: ctx.actorId,
      },
    })
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .select('*')
    .single();

  if (error) {
    console.error('Error verifying account:', error);
    throw new Error('Failed to verify account in database');
  }

  // Update effective limits for all agents under this account
  // This triggers the calculate_agent_effective_limits function
  await supabase
    .from('agents')
    .update({ updated_at: new Date().toISOString() })
    .eq('parent_account_id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx));
  
  // Audit log
  await logAudit(supabase, {
    tenantId: ctx.tenantId,
    entityType: 'account',
    entityId: id,
    action: 'verified',
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    actorName: ctx.actorName,
    changes: {
      before: { 
        verification_tier: existing.verification_tier, 
        verification_status: existing.verification_status 
      },
      after: { 
        verification_tier: tier, 
        verification_status: tier > 0 ? 'verified' : 'unverified' 
      },
    },
  });
  
  return c.json({
    data: {
      id: data.id,
      name: data.name,
      type: data.type,
      verificationTier: data.verification_tier,
      verificationStatus: data.verification_status,
      verificationType: data.verification_type,
      message: tier > 0 
        ? `Account verified at tier ${tier}` 
        : 'Account verification reset',
    },
  });
});

// ============================================
// POST /v1/accounts/:id/upgrade - Account tier upgrade (Story 73.5)
// ============================================
const upgradeAccountSchema = z.object({
  target_tier: z.number().int().min(1).max(3),
  verification_data: z.object({
    // T1 fields
    legal_name: z.string().optional(),
    date_of_birth: z.string().optional(),
    country: z.string().optional(),
    company_name: z.string().optional(),
    // T2+ handled by Persona/external flow
  }).optional(),
  verification_path: z.enum(['standard', 'partner_reliance', 'enterprise']).optional(),
  compliance_contact: z.object({
    name: z.string(),
    email: z.string().email(),
  }).optional(),
  // T2: redirect URL for Persona verification flow
  redirect_url: z.string().url().optional(),
});

accounts.post('/:id/upgrade', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  const supabase = createClient();

  if (!isValidUUID(id)) throw new ValidationError('Invalid account ID format');

  const body = upgradeAccountSchema.parse(await c.req.json());
  const { target_tier, verification_data, verification_path, compliance_contact } = body;

  const { data: existing, error: fetchError } = await supabase
    .from('accounts')
    .select('id, name, type, verification_tier, verification_status, tenant_id')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();

  if (fetchError || !existing) throw new NotFoundError('Account', id);

  const currentTier = existing.verification_tier || 0;
  if (target_tier <= currentTier) {
    throw new ValidationError(`Account is already at tier ${currentTier}. Cannot downgrade or stay at same tier.`);
  }

  // ============================================
  // T1 validation: lightweight KYC (Story 73.8)
  // ============================================
  if (target_tier >= 1 && currentTier < 1) {
    if (!verification_data?.legal_name) {
      throw new ValidationError('Tier 1 upgrade requires legal_name in verification_data');
    }
    if (!verification_data?.country) {
      throw new ValidationError('Tier 1 upgrade requires country in verification_data');
    }
    if (!verification_data?.date_of_birth) {
      throw new ValidationError('Tier 1 upgrade requires date_of_birth in verification_data');
    }

    const t1Result = await verifyT1({
      legal_name: verification_data.legal_name,
      date_of_birth: verification_data.date_of_birth,
      country: verification_data.country,
      company_name: verification_data.company_name,
    });

    if (!t1Result.approved) {
      throw new ValidationError(t1Result.reason || 'T1 verification failed');
    }
  }

  // ============================================
  // T2 validation: Persona verification (Stories 73.10/73.11)
  // ============================================
  if (target_tier >= 2 && currentTier < 2 && verification_path !== 'partner_reliance') {
    // For T2, initiate a Persona verification flow and return the inquiry URL.
    // The actual upgrade happens asynchronously via webhook when Persona completes.
    const redirectUrl = body.redirect_url || `${process.env.DASHBOARD_URL || 'https://app.getsly.ai'}/verification/callback`;

    let inquiry;
    if (existing.type === 'business') {
      inquiry = await initiatePersonaKYB(id, redirectUrl);
    } else {
      inquiry = await initiatePersonaVerification(id, redirectUrl);
    }

    // Store the inquiry ID in account metadata for webhook matching
    const existingMeta = (existing as any).metadata || {};
    await supabase
      .from('accounts')
      .update({
        verification_status: 'pending',
        metadata: {
          ...existingMeta,
          persona_inquiry_id: inquiry.inquiryId,
          verification_initiated_at: new Date().toISOString(),
          verification_initiated_by: ctx.actorId,
        },
      })
      .eq('id', id)
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx));

    await logAudit(supabase, {
      tenantId: ctx.tenantId,
      entityType: 'account',
      entityId: id,
      action: 'persona_verification_initiated',
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      actorName: ctx.actorName,
      metadata: { target_tier, inquiryId: inquiry.inquiryId },
    });

    return c.json({
      data: {
        id: existing.id,
        name: existing.name,
        verificationStatus: 'pending',
        message: 'Verification initiated. Complete the identity check at the provided URL.',
        inquiryUrl: inquiry.inquiryUrl,
        inquiryId: inquiry.inquiryId,
      },
    });
  }

  // ============================================
  // T3 validation: Enterprise EDD (Story 73.14)
  // ============================================
  if (target_tier >= 3 && currentTier < 3) {
    if (!compliance_contact) {
      throw new ValidationError('Tier 3 upgrade requires a compliance_contact');
    }

    // Create an EDD review ticket — account stays at current tier until approved
    const eddReview = await createEDDReview(supabase, id, ctx.tenantId);

    // Store compliance contact
    await supabase
      .from('accounts')
      .update({
        verification_status: 'pending',
        verification_path: verification_path || 'enterprise',
        compliance_contact_name: compliance_contact.name,
        compliance_contact_email: compliance_contact.email,
      })
      .eq('id', id)
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx));

    await logAudit(supabase, {
      tenantId: ctx.tenantId,
      entityType: 'account',
      entityId: id,
      action: 'edd_review_created',
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      actorName: ctx.actorName,
      metadata: { target_tier, reviewId: eddReview.id },
    });

    return c.json({
      data: {
        id: existing.id,
        name: existing.name,
        verificationStatus: 'pending',
        message: 'Enhanced Due Diligence review initiated. A compliance team member will review your application.',
        reviewId: eddReview.id,
        checklist: eddReview.checklist,
      },
    });
  }

  // ============================================
  // Direct upgrade (T1 only, or partner_reliance for T2)
  // ============================================
  const verificationType = existing.type === 'business' ? 'kyb' : 'kyc';

  const updatePayload: Record<string, any> = {
    verification_tier: target_tier,
    verification_status: 'verified',
    verification_type: verificationType,
    metadata: {
      ...((existing as any).metadata || {}),
      verificationData: verification_data,
      verifiedAt: new Date().toISOString(),
      verifiedBy: ctx.actorId,
    },
  };

  if (verification_path) updatePayload.verification_path = verification_path;
  if (compliance_contact) {
    updatePayload.compliance_contact_name = compliance_contact.name;
    updatePayload.compliance_contact_email = compliance_contact.email;
  }

  const { data, error } = await supabase
    .from('accounts')
    .update(updatePayload)
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .select('*')
    .single();

  if (error) throw new Error(`Failed to upgrade account: ${error.message}`);

  // DB trigger (account_verification_tier_recalc) now handles recalculating
  // effective limits for all child agents automatically.

  await logAudit(supabase, {
    tenantId: ctx.tenantId,
    entityType: 'account',
    entityId: id,
    action: 'tier_upgraded',
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    actorName: ctx.actorName,
    changes: {
      before: { verification_tier: currentTier, verification_status: existing.verification_status },
      after: { verification_tier: target_tier, verification_status: 'verified' },
    },
  });

  return c.json({
    data: {
      id: data.id,
      name: data.name,
      type: data.type,
      verificationTier: data.verification_tier,
      verificationStatus: data.verification_status,
      verificationType: data.verification_type,
      verificationPath: data.verification_path || 'standard',
      message: `Account upgraded to tier ${target_tier}`,
    },
  });
});

// ============================================
// POST /v1/accounts/:id/suspend - Suspend account and cascade to agents
// ============================================
accounts.post('/:id/suspend', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  const supabase = createClient();
  
  if (!isValidUUID(id)) {
    throw new ValidationError('Invalid account ID format');
  }
  
  // Get existing account
  const { data: existing, error: fetchError } = await supabase
    .from('accounts')
    .select('id, name, verification_status, tenant_id')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();

  if (fetchError || !existing) {
    throw new NotFoundError('Account', id);
  }

  // Update account status
  const { error: updateError } = await supabase
    .from('accounts')
    .update({ verification_status: 'suspended' })
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx));

  if (updateError) {
    console.error('Error suspending account:', updateError);
    throw new Error('Failed to suspend account in database');
  }

  // CASCADE: Suspend all agents under this account
  const { data: suspendedAgents, error: agentError } = await supabase
    .from('agents')
    .update({ status: 'suspended' })
    .eq('parent_account_id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .eq('status', 'active')
    .select('id, name');
  
  if (agentError) {
    console.error('Error suspending agents:', agentError);
  }
  
  // Audit log
  await logAudit(supabase, {
    tenantId: ctx.tenantId,
    entityType: 'account',
    entityId: id,
    action: 'suspended',
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    actorName: ctx.actorName,
    metadata: {
      cascadedAgents: (suspendedAgents || []).map(a => ({ id: a.id, name: a.name })),
    },
  });
  
  return c.json({
    data: {
      accountId: id,
      status: 'suspended',
      cascadedAgents: (suspendedAgents || []).length,
      message: `Account suspended. ${(suspendedAgents || []).length} agent(s) also suspended.`,
    },
  });
});

// ============================================
// POST /v1/accounts/:id/activate - Reactivate account
// ============================================
accounts.post('/:id/activate', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  const supabase = createClient();
  
  if (!isValidUUID(id)) {
    throw new ValidationError('Invalid account ID format');
  }
  
  // Get existing account
  const { data: existing, error: fetchError } = await supabase
    .from('accounts')
    .select('id, name, verification_tier, verification_status, tenant_id')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();

  if (fetchError || !existing) {
    throw new NotFoundError('Account', id);
  }

  if (existing.verification_status !== 'suspended') {
    throw new ValidationError('Account is not suspended');
  }

  // Restore status based on verification tier
  const newStatus = existing.verification_tier > 0 ? 'verified' : 'unverified';

  const { error: updateError } = await supabase
    .from('accounts')
    .update({ verification_status: newStatus })
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx));

  if (updateError) {
    console.error('Error activating account:', updateError);
    throw new Error('Failed to activate account in database');
  }
  
  // Note: Agents remain suspended - must be reactivated individually for security
  
  // Audit log
  await logAudit(supabase, {
    tenantId: ctx.tenantId,
    entityType: 'account',
    entityId: id,
    action: 'activated',
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    actorName: ctx.actorName,
  });
  
  return c.json({
    data: {
      accountId: id,
      status: newStatus,
      message: 'Account reactivated. Note: Agents must be reactivated individually.',
    },
  });
});

// ============================================
// Story 51.3: POST /v1/accounts/onboard - Unified Entity Onboarding
// ============================================

const paymentMethodSchema = z.object({
  type: z.enum(['pix', 'spei', 'bank_account']),
  pix_key: z.string().optional(),
  pix_key_type: z.enum(['cpf', 'cnpj', 'email', 'phone', 'evp']).optional(),
  clabe: z.string().optional(),
  bank_code: z.string().optional(),
  account_number: z.string().optional(),
  routing_number: z.string().optional(),
}).refine(
  (data) => {
    if (data.type === 'pix') return data.pix_key && data.pix_key_type;
    if (data.type === 'spei') return data.clabe;
    if (data.type === 'bank_account') return data.bank_code && data.account_number;
    return true;
  },
  { message: 'Missing required fields for payment method type' }
);

const verificationSchema = z.object({
  skip_kyb: z.boolean().optional(),
  skip_kyc: z.boolean().optional(),
  documents: z.array(z.object({
    type: z.string(),
    url: z.string().url(),
  })).optional(),
}).optional();

const personOnboardingSchema = z.object({
  type: z.literal('person'),
  first_name: z.string().min(1).max(100),
  last_name: z.string().min(1).max(100),
  email: z.string().email().optional(),
  country: z.string().length(2),
  tax_id: z.string().optional(),
  payment_methods: z.array(paymentMethodSchema).optional(),
  verification: verificationSchema,
  metadata: z.record(z.unknown()).optional(),
});

const businessOnboardingSchema = z.object({
  type: z.literal('business'),
  business_name: z.string().min(1).max(255),
  email: z.string().email().optional(),
  country: z.string().length(2),
  tax_id: z.string().optional(),
  payment_methods: z.array(paymentMethodSchema).optional(),
  verification: verificationSchema,
  metadata: z.record(z.unknown()).optional(),
});

const onboardingSchema = z.discriminatedUnion('type', [
  personOnboardingSchema,
  businessOnboardingSchema,
]);

/**
 * Onboard a new entity (person or business) in a single call.
 * Creates account + payment methods + triggers verification.
 *
 * @see Story 51.3: Unified Entity Onboarding Endpoint
 */
accounts.post('/onboard', async (c) => {
  const ctx = c.get('ctx');

  let body;
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError('Invalid JSON body');
  }

  const parsed = onboardingSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError('Validation failed', parsed.error.flatten());
  }

  const input = parsed.data as OnboardingInput;
  const supabase = createClient();

  const result = await onboardEntity(ctx.tenantId, input, supabase);

  return c.json(result, 201);
});

// ============================================
// POST /v1/accounts/partner-import - Partner Reliance Path (Story 73.12)
// ============================================
const partnerImportSchema = z.object({
  name: z.string().min(1).max(255),
  email: z.string().email(),
  country: z.string().length(2),
  entity_type: z.enum(['person', 'business']),
  partner_id: z.string().uuid(),
  partner_agreement_date: z.string(), // ISO date string
});

accounts.post('/partner-import', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();

  let body;
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError('Invalid JSON body');
  }

  const parsed = partnerImportSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError('Validation failed', parsed.error.flatten());
  }

  const { name, email, country, entity_type, partner_id, partner_agreement_date } = parsed.data;

  // Validate country is not sanctioned
  if (isSanctionedCountry(country)) {
    throw new ValidationError('Service is not available in the specified country');
  }

  // Validate partner_id is a known partner (look up in tenants table)
  const { data: partner, error: partnerError } = await supabase
    .from('tenants')
    .select('id, name')
    .eq('id', partner_id)
    .single();

  if (partnerError || !partner) {
    throw new ValidationError('Unknown partner_id. The partner must be a registered tenant.');
  }

  // Validate agreement date is a valid date
  const agreementDate = new Date(partner_agreement_date);
  if (isNaN(agreementDate.getTime())) {
    throw new ValidationError('Invalid partner_agreement_date format. Use ISO 8601 date string.');
  }

  // Check for duplicate email within this tenant
  const { data: existingAccount } = await supabase
    .from('accounts')
    .select('id')
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .eq('email', email)
    .single();

  if (existingAccount) {
    throw new ValidationError('An account with this email already exists in this tenant');
  }

  // Create account at T2 with partner_reliance path
  const verificationType = entity_type === 'business' ? 'kyb' : 'kyc';

  const { data, error } = await supabase
    .from('accounts')
    .insert({
      tenant_id: ctx.tenantId,
      environment: getEnv(ctx),
      type: entity_type,
      name,
      email,
      verification_tier: 2,
      verification_status: 'verified',
      verification_type: verificationType,
      verification_path: 'partner_reliance',
      reliance_partner_id: partner_id,
      reliance_agreement_date: agreementDate.toISOString(),
      metadata: {
        imported_via: 'partner_reliance',
        partner_name: partner.name,
        country,
        imported_at: new Date().toISOString(),
        imported_by: ctx.actorId,
      },
    })
    .select()
    .single();

  if (error) {
    console.error('Error creating partner-imported account:', error);
    throw new Error('Failed to create account');
  }

  await logAudit(supabase, {
    tenantId: ctx.tenantId,
    entityType: 'account',
    entityId: data.id,
    action: 'partner_imported',
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    actorName: ctx.actorName,
    metadata: {
      partner_id,
      partner_name: partner.name,
      verification_path: 'partner_reliance',
      country,
    },
  });

  return c.json({
    data: {
      id: data.id,
      name: data.name,
      email: data.email,
      type: data.type,
      verificationTier: 2,
      verificationStatus: 'verified',
      verificationPath: 'partner_reliance',
      reliancePartnerId: partner_id,
      relianceAgreementDate: agreementDate.toISOString(),
      message: 'Account imported via partner reliance at Tier 2',
    },
  }, 201);
});

export default accounts;
