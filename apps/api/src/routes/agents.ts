import { Hono } from 'hono';
import { z } from 'zod';
import { createClient } from '../db/client.js';
import {
  mapAgentFromDb,
  mapStreamFromDb,
  logAudit,
  isValidUUID,
  getPaginationParams,
  paginationResponse,
  normalizeFields,
  buildDeprecationHeader,
  sanitizeSearchInput,
} from '../utils/helpers.js';
import { createLimitService } from '../services/limits.js';
import { ValidationError, NotFoundError } from '../middleware/error.js';
import { generateAgentToken, hashApiKey, getKeyPrefix } from '../utils/crypto.js';
import { ErrorCode } from '@sly/types';
import { triggerWorkflows } from '../services/workflow-trigger.js';

const agents = new Hono();

// ============================================
// EFFECTIVE LIMITS CALCULATION
// ============================================

export interface TierLimits {
  per_transaction: number;
  daily: number;
  monthly: number;
}

/**
 * Compute effective limits = min(agent KYA tier limits, parent account tier limits)
 * Story 59.15: When parentVerificationTier is null (standalone agent), use KYA tier only
 */
export async function computeEffectiveLimits(
  supabase: ReturnType<typeof createClient>,
  kyaTier: number,
  parentVerificationTier: number | null,
): Promise<{ limits: TierLimits; capped: boolean }> {
  // Fetch KYA tier limits
  const kyaResult = await supabase.from('kya_tier_limits').select('per_transaction, daily, monthly').eq('tier', kyaTier).single();
  const kyaLimits: TierLimits = kyaResult.data || { per_transaction: 0, daily: 0, monthly: 0 };

  // If no parent (standalone agent), use KYA limits only — no cap
  if (parentVerificationTier === null) {
    return { limits: kyaLimits, capped: false };
  }

  // Fetch parent account tier limits
  const accountResult = await supabase.from('verification_tier_limits').select('per_transaction, daily, monthly').eq('tier', parentVerificationTier).single();
  const accountLimits: TierLimits = accountResult.data || { per_transaction: 0, daily: 0, monthly: 0 };

  const effective: TierLimits = {
    per_transaction: Math.min(kyaLimits.per_transaction, accountLimits.per_transaction),
    daily: Math.min(kyaLimits.daily, accountLimits.daily),
    monthly: Math.min(kyaLimits.monthly, accountLimits.monthly),
  };

  const capped =
    effective.per_transaction < kyaLimits.per_transaction ||
    effective.daily < kyaLimits.daily ||
    effective.monthly < kyaLimits.monthly;

  return { limits: effective, capped };
}

// ============================================
// VALIDATION SCHEMAS
// ============================================

const permissionsSchema = z.object({
  transactions: z.object({
    initiate: z.boolean(),
    approve: z.boolean(),
    view: z.boolean(),
  }).optional(),
  streams: z.object({
    initiate: z.boolean(),
    modify: z.boolean(),
    pause: z.boolean(),
    terminate: z.boolean(),
    view: z.boolean(),
  }).optional(),
  accounts: z.object({
    view: z.boolean(),
    create: z.boolean(),
  }).optional(),
  treasury: z.object({
    view: z.boolean(),
    rebalance: z.boolean(),
  }).optional(),
}).optional();

// Story 51.1: Accept both accountId (new) and parentAccountId (deprecated)
// Story 51.6: Add auto_create_wallet option
// Story 59.15: accountId is optional — standalone agents have no parent
const createAgentSchema = z.object({
  accountId: z.string().uuid().optional(),
  parentAccountId: z.string().uuid().optional(), // Deprecated, use accountId
  name: z.string().min(1).max(255),
  description: z.string().max(1000).optional(),
  permissions: permissionsSchema,
  wallet_id: z.string().uuid().optional(), // Existing wallet to assign
  auto_create_wallet: z.boolean().optional().default(true), // Story 51.6: Auto-create wallet if not specified
});

const updateAgentSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(1000).optional().nullable(),
  permissions: permissionsSchema,
  dailyLimit: z.number().positive().optional(),
  monthlyLimit: z.number().positive().optional(),
  perTransactionLimit: z.number().positive().optional(),
});

// Default permissions for new agents
export const DEFAULT_PERMISSIONS = {
  transactions: { initiate: true, approve: false, view: true },
  streams: { initiate: true, modify: true, pause: true, terminate: true, view: true },
  accounts: { view: true, create: false },
  treasury: { view: false, rebalance: false },
};

// ============================================
// GET /v1/agents - List agents
// ============================================
agents.get('/', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();
  
  // Parse query params
  const query = c.req.query();
  const { page, limit } = getPaginationParams(query);
  const search = query.search;
  const status = query.status;
  const type = query.type;
  const kyaTier = query.kyaTier;
  const parentAccountId = query.parentAccountId;
  
  // Build query with parent account join
  let dbQuery = supabase
    .from('agents')
    .select(`
      *,
      accounts!agents_parent_account_id_fkey (
        id, type, name, verification_tier
      )
    `, { count: 'exact' })
    .eq('tenant_id', ctx.tenantId)
    .order('created_at', { ascending: false })
    .range((page - 1) * limit, page * limit - 1);
  
  if (search) {
    const safe = sanitizeSearchInput(search);
    dbQuery = dbQuery.or(`name.ilike.%${safe}%,description.ilike.%${safe}%`);
  }
  if (status) {
    dbQuery = dbQuery.eq('status', status);
  }
  if (type) {
    dbQuery = dbQuery.eq('type', type);
  }
  if (kyaTier !== undefined) {
    dbQuery = dbQuery.eq('kya_tier', parseInt(kyaTier));
  }
  if (parentAccountId) {
    dbQuery = dbQuery.eq('parent_account_id', parentAccountId);
  }
  
  const { data, count, error } = await dbQuery;
  
  if (error) {
    console.error('Error fetching agents:', error);
    throw new Error('Failed to fetch agents from database');
  }
  
  // Map to response format
  const agents = (data || []).map(row => {
    const agent = mapAgentFromDb(row);
    if (row.accounts) {
      agent.parentAccount = {
        id: row.accounts.id,
        type: row.accounts.type,
        name: row.accounts.name,
        verificationTier: row.accounts.verification_tier,
      };
    }
    return agent;
  });
  
  return c.json(paginationResponse(agents, count || 0, { page, limit }));
});

// ============================================
// POST /v1/agents - Create agent
// ============================================
agents.post('/', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();

  // Parse and validate body
  let body;
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError('Invalid JSON body');
  }

  // Story 51.1: Normalize deprecated field names
  const { data: normalizedBody, deprecatedFieldsUsed } = normalizeFields(body, {
    parentAccountId: 'accountId',
  });

  const parsed = createAgentSchema.safeParse(normalizedBody);
  if (!parsed.success) {
    throw new ValidationError('Validation failed', parsed.error.flatten());
  }

  // Story 51.1: Add deprecation warning header if old fields were used
  const deprecationWarning = buildDeprecationHeader(deprecatedFieldsUsed);
  if (deprecationWarning) {
    c.header('Deprecation', deprecationWarning);
    c.header('X-Deprecated-Fields', deprecatedFieldsUsed.join(', '));
  }

  const { name, description, permissions, wallet_id, auto_create_wallet } = parsed.data;
  // Get the account ID (prefer new name, fall back to old)
  const accountId = parsed.data.accountId || parsed.data.parentAccountId;

  // Story 59.15: Parent account is optional — validate if provided
  let parentAccount: any = null;
  if (accountId) {
    // Verify parent account exists and belongs to tenant
    const { data: pa, error: parentError } = await supabase
      .from('accounts')
      .select('id, type, name, verification_tier')
      .eq('id', accountId)
      .eq('tenant_id', ctx.tenantId)
      .single();

    if (parentError || !pa) {
      throw new NotFoundError('Parent account', accountId!);
    }

    // Only business accounts can have agents
    if (pa.type !== 'business') {
      const error: any = new ValidationError('Only business accounts can have agents');
      error.details = {
        account_id: accountId,
        account_type: pa.type,
        required_type: 'business',
      };
      throw error;
    }
    parentAccount = pa;
  }

  // Generate auth credentials (plaintext token - only returned once!)
  const authToken = generateAgentToken();
  const authTokenHash = hashApiKey(authToken);
  const authTokenPrefix = getKeyPrefix(authToken);

  // Merge permissions with defaults
  const mergedPermissions = {
    ...DEFAULT_PERMISSIONS,
    ...permissions,
    transactions: { ...DEFAULT_PERMISSIONS.transactions, ...permissions?.transactions },
    streams: { ...DEFAULT_PERMISSIONS.streams, ...permissions?.streams },
    accounts: { ...DEFAULT_PERMISSIONS.accounts, ...permissions?.accounts },
    treasury: { ...DEFAULT_PERMISSIONS.treasury, ...permissions?.treasury },
  };

  // Create agent - store ONLY the hash, never the plaintext token
  // Story 59.15: parent_account_id is nullable for standalone agents
  const { data, error } = await supabase
    .from('agents')
    .insert({
      tenant_id: ctx.tenantId,
      parent_account_id: accountId || null,
      name,
      description: description || null,
      status: 'active',
      kya_tier: 0, // Start unverified
      kya_status: 'unverified',
      auth_type: 'api_key',
      auth_client_id: authTokenPrefix, // Only store prefix for display
      auth_token_hash: authTokenHash,  // Secure hash for verification
      auth_token_prefix: authTokenPrefix, // Indexed for lookup
      permissions: mergedPermissions,
    })
    .select('*')
    .single();
  
  if (error) {
    console.error('Error creating agent:', error);
    throw new Error('Failed to create agent in database');
  }
  
  // Story 51.6: Handle wallet assignment or auto-creation
  let assignedWalletId: string | null = null;

  if (wallet_id) {
    // Verify wallet exists and belongs to tenant
    const { data: wallet, error: walletError } = await supabase
      .from('wallets')
      .select('id')
      .eq('id', wallet_id)
      .eq('tenant_id', ctx.tenantId)
      .single();

    if (walletError || !wallet) {
      // Rollback agent creation
      await supabase.from('agents').delete().eq('id', data.id);
      throw new NotFoundError('Wallet', wallet_id);
    }

    // Update wallet to be managed by this agent
    await supabase
      .from('wallets')
      .update({ managed_by_agent_id: data.id })
      .eq('id', wallet_id)
      .eq('tenant_id', ctx.tenantId);

    assignedWalletId = wallet_id;
  } else if (auto_create_wallet !== false && accountId) {
    // Story 51.6: Auto-create a wallet for the agent (requires parent account as owner)
    const walletAddress = `internal://payos/${ctx.tenantId}/${accountId}/agent/${data.id}`;

    const { data: wallet, error: walletError } = await supabase
      .from('wallets')
      .insert({
        tenant_id: ctx.tenantId,
        owner_account_id: accountId,
        managed_by_agent_id: data.id,
        balance: 0,
        currency: 'USDC',
        wallet_address: walletAddress,
        network: 'internal',
        status: 'active',
        wallet_type: 'internal',
        name: `${name} Wallet`,
        purpose: `Auto-created wallet for agent ${name}`,
      })
      .select('id')
      .single();

    if (walletError) {
      console.error('Warning: Failed to auto-create wallet for agent:', walletError);
      // Don't fail agent creation, just log the warning
    } else {
      assignedWalletId = wallet.id;
      console.log(`[Agent] Auto-created wallet ${wallet.id} for agent ${data.id}`);
    }
  }

  // Audit log
  await logAudit(supabase, {
    tenantId: ctx.tenantId,
    entityType: 'agent',
    entityId: data.id,
    action: 'created',
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    actorName: ctx.actorName,
    metadata: {
      name,
      parentAccount: parentAccount?.name || null,
      wallet_id: assignedWalletId,
      auto_created_wallet: !wallet_id && auto_create_wallet !== false && !!accountId,
    },
  });

  const agent = mapAgentFromDb(data);
  if (parentAccount) {
    agent.parentAccount = {
      id: parentAccount.id,
      type: parentAccount.type,
      name: parentAccount.name,
      verificationTier: parentAccount.verification_tier,
    };
  }

  // Fire workflow auto-triggers (fire-and-forget)
  triggerWorkflows(supabase, ctx.tenantId, 'agent', 'insert', {
    id: data.id, name, account_id: accountId, kya_tier: 0, status: 'active',
  }).catch(console.error);

  // Include auth credentials in response (only on creation)
  // WARNING: This is the ONLY time the plaintext token is available!
  return c.json({
    data: {
      ...agent,
      wallet_id: assignedWalletId, // Story 51.6: Include wallet_id in response
    },
    credentials: {
      token: authToken,
      prefix: authTokenPrefix,
      warning: '⚠️ SAVE THIS TOKEN NOW - it will never be shown again!',
    },
  }, 201);
});

// ============================================
// GET /v1/agents/:id - Get single agent
// ============================================
agents.get('/:id', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  const supabase = createClient();
  
  if (!isValidUUID(id)) {
    const error: any = new ValidationError('Invalid agent ID format');
    error.details = {
      provided_id: id,
      expected_format: 'UUID',
    };
    throw error;
  }
  
  const { data, error } = await supabase
    .from('agents')
    .select(`
      *,
      accounts!agents_parent_account_id_fkey (
        id, type, name, verification_tier
      )
    `)
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .single();
  
  if (error || !data) {
    throw new NotFoundError('Agent', id);
  }
  
  const agent = mapAgentFromDb(data);
  if (data.accounts) {
    agent.parentAccount = {
      id: data.accounts.id,
      type: data.accounts.type,
      name: data.accounts.name,
      verificationTier: data.accounts.verification_tier,
    };
  }
  
  return c.json({ data: agent });
});

// ============================================
// PATCH /v1/agents/:id - Update agent
// ============================================
agents.patch('/:id', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  const supabase = createClient();
  
  if (!isValidUUID(id)) {
    const error: any = new ValidationError('Invalid agent ID format');
    error.details = {
      provided_id: id,
      expected_format: 'UUID',
    };
    throw error;
  }
  
  // Check agent exists
  const { data: existing, error: fetchError } = await supabase
    .from('agents')
    .select('*')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .single();
  
  if (fetchError || !existing) {
    throw new NotFoundError('Agent', id);
  }
  
  // Parse and validate body
  let body;
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError('Invalid JSON body');
  }
  
  const parsed = updateAgentSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError('Validation failed', parsed.error.flatten());
  }
  
  const updates: Record<string, any> = {};
  if (parsed.data.name !== undefined) updates.name = parsed.data.name;
  if (parsed.data.description !== undefined) updates.description = parsed.data.description;
  if (parsed.data.permissions !== undefined) {
    // Merge with existing permissions
    updates.permissions = {
      ...existing.permissions,
      ...parsed.data.permissions,
    };
  }
  // If any limits are being updated, cap by parent account tier
  const hasLimitUpdate =
    parsed.data.dailyLimit !== undefined ||
    parsed.data.monthlyLimit !== undefined ||
    parsed.data.perTransactionLimit !== undefined;

  if (hasLimitUpdate) {
    // Story 59.15: Only fetch parent limits if agent has a parent account
    let parentLimits = { per_transaction: Infinity, daily: Infinity, monthly: Infinity };
    if (existing.parent_account_id) {
      const { data: parentAccount } = await supabase
        .from('accounts')
        .select('verification_tier')
        .eq('id', existing.parent_account_id)
        .single();

      const parentTier = parentAccount?.verification_tier ?? 0;
      const { data: accountTierLimits } = await supabase
        .from('verification_tier_limits')
        .select('per_transaction, daily, monthly')
        .eq('tier', parentTier)
        .single();

      parentLimits = accountTierLimits || { per_transaction: 0, daily: 0, monthly: 0 };
    }

    if (parsed.data.perTransactionLimit !== undefined) {
      updates.limit_per_transaction = parsed.data.perTransactionLimit;
      updates.effective_limit_per_tx = Math.min(parsed.data.perTransactionLimit, parentLimits.per_transaction);
    }
    if (parsed.data.dailyLimit !== undefined) {
      updates.limit_daily = parsed.data.dailyLimit;
      updates.effective_limit_daily = Math.min(parsed.data.dailyLimit, parentLimits.daily);
    }
    if (parsed.data.monthlyLimit !== undefined) {
      updates.limit_monthly = parsed.data.monthlyLimit;
      updates.effective_limit_monthly = Math.min(parsed.data.monthlyLimit, parentLimits.monthly);
    }

    // Check if any effective limit was capped
    updates.effective_limits_capped =
      (updates.effective_limit_per_tx !== undefined && updates.effective_limit_per_tx < (updates.limit_per_transaction ?? existing.limit_per_transaction)) ||
      (updates.effective_limit_daily !== undefined && updates.effective_limit_daily < (updates.limit_daily ?? existing.limit_daily)) ||
      (updates.effective_limit_monthly !== undefined && updates.effective_limit_monthly < (updates.limit_monthly ?? existing.limit_monthly));
  }

  if (Object.keys(updates).length === 0) {
    const agent = mapAgentFromDb(existing);
    return c.json({ data: agent });
  }
  
  // Update agent
  const { data, error } = await supabase
    .from('agents')
    .update(updates)
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .select(`
      *,
      accounts!agents_parent_account_id_fkey (
        id, type, name, verification_tier
      )
    `)
    .single();
  
  if (error) {
    console.error('Error updating agent:', error);
    throw new Error('Failed to update agent in database');
  }
  
  // Audit log
  await logAudit(supabase, {
    tenantId: ctx.tenantId,
    entityType: 'agent',
    entityId: id,
    action: 'updated',
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    actorName: ctx.actorName,
    changes: {
      before: { name: existing.name, description: existing.description },
      after: { name: data.name, description: data.description },
    },
  });
  
  const agent = mapAgentFromDb(data);
  if (data.accounts) {
    agent.parentAccount = {
      id: data.accounts.id,
      type: data.accounts.type,
      name: data.accounts.name,
      verificationTier: data.accounts.verification_tier,
    };
  }

  // Fire workflow auto-triggers (fire-and-forget)
  triggerWorkflows(supabase, ctx.tenantId, 'agent', 'update', {
    id: data.id, name: data.name, kya_tier: data.kya_tier, status: data.status,
    account_id: data.parent_account_id,
  }).catch(console.error);

  return c.json({ data: agent });
});

// ============================================
// DELETE /v1/agents/:id - Delete agent
// ============================================
agents.delete('/:id', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  const supabase = createClient();
  
  if (!isValidUUID(id)) {
    const error: any = new ValidationError('Invalid agent ID format');
    error.details = {
      provided_id: id,
      expected_format: 'UUID',
    };
    throw error;
  }
  
  // Check agent exists
  const { data: existing, error: fetchError } = await supabase
    .from('agents')
    .select('*')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .single();
  
  if (fetchError || !existing) {
    throw new NotFoundError('Agent', id);
  }
  
  // Check for active streams managed by this agent
  const { count: streamCount } = await supabase
    .from('streams')
    .select('*', { count: 'exact', head: true })
    .eq('managed_by_type', 'agent')
    .eq('managed_by_id', id)
    .eq('status', 'active');
  
  if (streamCount && streamCount > 0) {
    const error: any = new ValidationError('Cannot delete agent with active managed streams');
    error.details = {
      agent_id: id,
      active_streams: streamCount,
      message: 'Transfer stream management or cancel streams before deleting',
    };
    throw error;
  }
  
  // Delete agent
  const { error } = await supabase
    .from('agents')
    .delete()
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId);
  
  if (error) {
    console.error('Error deleting agent:', error);
    throw new Error('Failed to delete agent from database');
  }
  
  // Audit log
  await logAudit(supabase, {
    tenantId: ctx.tenantId,
    entityType: 'agent',
    entityId: id,
    action: 'deleted',
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    actorName: ctx.actorName,
    metadata: { name: existing.name },
  });
  
  return c.json({ data: { id, deleted: true } });
});

// ============================================
// POST /v1/agents/:id/suspend - Suspend agent
// ============================================
agents.post('/:id/suspend', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  const supabase = createClient();
  
  if (!isValidUUID(id)) {
    const error: any = new ValidationError('Invalid agent ID format');
    error.details = {
      provided_id: id,
      expected_format: 'UUID',
    };
    throw error;
  }
  
  const { data: existing, error: fetchError } = await supabase
    .from('agents')
    .select('*')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .single();
  
  if (fetchError || !existing) {
    throw new NotFoundError('Agent', id);
  }
  
  if (existing.status === 'suspended') {
    const error: any = new ValidationError('Agent is already suspended');
    error.details = {
      agent_id: id,
      current_status: existing.status,
    };
    throw error;
  }
  
  const { data, error } = await supabase
    .from('agents')
    .update({ status: 'suspended' })
    .eq('id', id)
    .select(`
      *,
      accounts!agents_parent_account_id_fkey (
        id, type, name, verification_tier
      )
    `)
    .single();
  
  if (error) {
    console.error('Error suspending agent:', error);
    throw new Error('Failed to suspend agent in database');
  }
  
  // Audit log
  await logAudit(supabase, {
    tenantId: ctx.tenantId,
    entityType: 'agent',
    entityId: id,
    action: 'suspended',
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    actorName: ctx.actorName,
    changes: { before: { status: existing.status }, after: { status: 'suspended' } },
  });
  
  const agent = mapAgentFromDb(data);
  if (data.accounts) {
    agent.parentAccount = {
      id: data.accounts.id,
      type: data.accounts.type,
      name: data.accounts.name,
      verificationTier: data.accounts.verification_tier,
    };
  }
  
  return c.json({ data: agent });
});

// ============================================
// POST /v1/agents/:id/activate - Activate agent
// ============================================
agents.post('/:id/activate', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  const supabase = createClient();
  
  if (!isValidUUID(id)) {
    const error: any = new ValidationError('Invalid agent ID format');
    error.details = {
      provided_id: id,
      expected_format: 'UUID',
    };
    throw error;
  }
  
  const { data: existing, error: fetchError } = await supabase
    .from('agents')
    .select('*')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .single();
  
  if (fetchError || !existing) {
    throw new NotFoundError('Agent', id);
  }
  
  if (existing.status === 'active') {
    const error: any = new ValidationError('Agent is already active');
    error.details = {
      agent_id: id,
      current_status: existing.status,
    };
    throw error;
  }
  
  const { data, error } = await supabase
    .from('agents')
    .update({ status: 'active' })
    .eq('id', id)
    .select(`
      *,
      accounts!agents_parent_account_id_fkey (
        id, type, name, verification_tier
      )
    `)
    .single();
  
  if (error) {
    console.error('Error activating agent:', error);
    throw new Error('Failed to activate agent in database');
  }
  
  // Audit log
  await logAudit(supabase, {
    tenantId: ctx.tenantId,
    entityType: 'agent',
    entityId: id,
    action: 'activated',
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    actorName: ctx.actorName,
    changes: { before: { status: existing.status }, after: { status: 'active' } },
  });
  
  const agent = mapAgentFromDb(data);
  if (data.accounts) {
    agent.parentAccount = {
      id: data.accounts.id,
      type: data.accounts.type,
      name: data.accounts.name,
      verificationTier: data.accounts.verification_tier,
    };
  }
  
  return c.json({ data: agent });
});

// ============================================
// GET /v1/agents/:id/streams - Agent's managed streams
// ============================================
agents.get('/:id/streams', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  const supabase = createClient();
  
  if (!isValidUUID(id)) {
    const error: any = new ValidationError('Invalid agent ID format');
    error.details = {
      provided_id: id,
      expected_format: 'UUID',
    };
    throw error;
  }
  
  // Verify agent exists
  const { data: agent, error: agentError } = await supabase
    .from('agents')
    .select('id, name')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .single();
  
  if (agentError || !agent) {
    throw new NotFoundError('Agent', id);
  }
  
  // Get streams managed by this agent
  const { data, error } = await supabase
    .from('streams')
    .select('*')
    .eq('tenant_id', ctx.tenantId)
    .eq('managed_by_type', 'agent')
    .eq('managed_by_id', id)
    .order('created_at', { ascending: false });
  
  if (error) {
    console.error('Error fetching agent streams:', error);
    throw new Error('Failed to fetch agent streams from database');
  }
  
  const streams = (data || []).map(row => mapStreamFromDb(row));
  
  return c.json({ data: streams });
});

// ============================================
// GET /v1/agents/:id/limits - Agent's current limits & usage
// ============================================
agents.get('/:id/limits', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  const supabase = createClient();
  
  if (!isValidUUID(id)) {
    const error: any = new ValidationError('Invalid agent ID format');
    error.details = {
      provided_id: id,
      expected_format: 'UUID',
    };
    throw error;
  }
  
  // Verify agent exists
  const { data: agentExists } = await supabase
    .from('agents')
    .select('id')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .single();
  
  if (!agentExists) {
    throw new NotFoundError('Agent', id);
  }
  
  const limitService = createLimitService(supabase);
  const stats = await limitService.getUsageStats(id);
  
  return c.json({ data: stats });
});

// ============================================
// GET /v1/agents/:id/transactions - Agent transaction history
// ============================================
agents.get('/:id/transactions', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  const supabase = createClient();

  if (!isValidUUID(id)) {
    throw new ValidationError('Invalid agent ID format');
  }

  // Verify agent exists and belongs to tenant
  const { data: agent } = await supabase
    .from('agents')
    .select('id, name')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .single();

  if (!agent) {
    throw new NotFoundError('Agent', id);
  }

  const limit = parseInt(c.req.query('limit') || '20', 10);
  const offset = parseInt(c.req.query('offset') || '0', 10);
  const dateFrom = c.req.query('from') || undefined;
  const dateTo = c.req.query('to') || undefined;

  // Fetch UCP checkouts attributed to this agent
  let ucpQuery = supabase
    .from('ucp_checkout_sessions')
    .select('id, status, currency, totals, created_at, order_id, metadata', { count: 'exact' })
    .eq('tenant_id', ctx.tenantId)
    .eq('agent_id', id)
    .order('created_at', { ascending: false });

  if (dateFrom) ucpQuery = ucpQuery.gte('created_at', dateFrom);
  if (dateTo) ucpQuery = ucpQuery.lte('created_at', dateTo);

  const { data: ucpCheckouts, count: ucpTotal } = await ucpQuery.range(offset, offset + limit - 1);

  // Fetch ACP checkouts attributed to this agent
  let acpQuery = supabase
    .from('acp_checkouts')
    .select('id, status, currency, total_amount, created_at, metadata', { count: 'exact' })
    .eq('tenant_id', ctx.tenantId)
    .eq('agent_id', id)
    .order('created_at', { ascending: false });

  if (dateFrom) acpQuery = acpQuery.gte('created_at', dateFrom);
  if (dateTo) acpQuery = acpQuery.lte('created_at', dateTo);

  const { data: acpCheckouts, count: acpTotal } = await acpQuery.range(offset, offset + limit - 1);

  // Fetch transfers initiated by this agent (AP2 mandate executions, etc.)
  // Exclude ACP-type transfers to avoid duplicating data already fetched above
  let transferQuery = supabase
    .from('transfers')
    .select('id, type, status, currency, amount, description, created_at, from_account_id, to_account_id, from_account_name, to_account_name, fee_amount, protocol_metadata', { count: 'exact' })
    .eq('tenant_id', ctx.tenantId)
    .eq('initiated_by_type', 'agent')
    .eq('initiated_by_id', id)
    .not('type', 'eq', 'acp')
    .order('created_at', { ascending: false });

  if (dateFrom) transferQuery = transferQuery.gte('created_at', dateFrom);
  if (dateTo) transferQuery = transferQuery.lte('created_at', dateTo);

  const { data: agentTransfers, count: transferTotal } = await transferQuery.range(offset, offset + limit - 1);

  // Also fetch x402 transfers made via wallets managed by this agent
  // (These may have initiated_by_type='api_key' when called via MCP/API,
  //  but the wallet is agent-managed, so we attribute to the agent)
  const { data: agentWallets } = await supabase
    .from('wallets')
    .select('id')
    .eq('tenant_id', ctx.tenantId)
    .eq('managed_by_agent_id', id);

  const agentWalletIds = (agentWallets || []).map((w: any) => w.id);
  const directTransferIds = new Set((agentTransfers || []).map((t: any) => t.id));

  let walletTransfers: any[] = [];
  let walletTransferTotal = 0;

  if (agentWalletIds.length > 0) {
    let walletTxQuery = supabase
      .from('transfers')
      .select('id, type, status, currency, amount, description, created_at, from_account_id, to_account_id, from_account_name, to_account_name, fee_amount, protocol_metadata', { count: 'exact' })
      .eq('tenant_id', ctx.tenantId)
      .eq('type', 'x402')
      .order('created_at', { ascending: false });

    if (agentWalletIds.length === 1) {
      walletTxQuery = walletTxQuery.contains('protocol_metadata', { wallet_id: agentWalletIds[0] });
    } else {
      // Multiple wallets: use OR filter
      walletTxQuery = walletTxQuery.or(
        agentWalletIds.map((wid: string) => `protocol_metadata.cs.{"wallet_id":"${wid}"}`).join(',')
      );
    }

    if (dateFrom) walletTxQuery = walletTxQuery.gte('created_at', dateFrom);
    if (dateTo) walletTxQuery = walletTxQuery.lte('created_at', dateTo);

    const { data: wTransfers, count: wTotal } = await walletTxQuery.range(offset, offset + limit - 1);
    // Deduplicate: exclude any already found in agentTransfers
    walletTransfers = (wTransfers || []).filter((t: any) => !directTransferIds.has(t.id));
    walletTransferTotal = Math.max(0, (wTotal || 0) - ((wTransfers || []).length - walletTransfers.length));
  }

  // Normalize into unified transaction format
  const transactions = [
    ...(ucpCheckouts || []).map((c: any) => {
      const totalLine = (c.totals || []).find((t: any) => t.type === 'total');
      return {
        id: c.id,
        type: 'ucp_checkout' as const,
        status: c.status,
        currency: c.currency,
        amount: totalLine?.amount || 0,
        order_id: c.order_id,
        created_at: c.created_at,
        description: c.metadata?.description || c.metadata?.vendor || null,
        from_account_name: null,
        to_account_name: null,
        protocol: 'ucp',
        fee_amount: 0,
      };
    }),
    ...(acpCheckouts || []).map((c: any) => ({
      id: c.id,
      type: 'acp_checkout' as const,
      status: c.status,
      currency: c.currency,
      amount: parseFloat(c.total_amount) || 0,
      order_id: null,
      created_at: c.created_at,
      description: c.metadata?.description || null,
      from_account_name: null,
      to_account_name: null,
      protocol: 'acp',
      fee_amount: 0,
    })),
    ...([...(agentTransfers || []), ...walletTransfers]).map((t: any) => ({
      id: t.id,
      type: t.type as string,
      status: t.status,
      currency: t.currency,
      amount: parseFloat(t.amount) || 0,
      order_id: null,
      created_at: t.created_at,
      description: t.description || `${t.type} transfer`,
      from_account_name: t.from_account_name || null,
      to_account_name: t.to_account_name || null,
      protocol: t.protocol_metadata?.protocol || t.type || null,
      fee_amount: parseFloat(t.fee_amount) || 0,
    })),
  ].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  return c.json({
    data: transactions,
    pagination: {
      limit,
      offset,
      total: (ucpTotal || 0) + (acpTotal || 0) + (transferTotal || 0) + walletTransferTotal,
    },
  });
});

// ============================================
// POST /v1/agents/:id/verify - Mock KYA verification
// ============================================
agents.post('/:id/verify', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  const supabase = createClient();
  
  if (!isValidUUID(id)) {
    const error: any = new ValidationError('Invalid agent ID format');
    error.details = {
      provided_id: id,
      expected_format: 'UUID',
    };
    throw error;
  }
  
  // Parse body for tier
  let body;
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  
  const tier = body.tier ?? 1; // Default to tier 1
  if (tier < 0 || tier > 3) {
    const error: any = new ValidationError('KYA tier must be between 0 and 3');
    error.details = {
      provided_tier: tier,
      valid_range: '0-3',
    };
    throw error;
  }
  
  const { data: existing, error: fetchError } = await supabase
    .from('agents')
    .select('*')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .single();
  
  if (fetchError || !existing) {
    throw new NotFoundError('Agent', id);
  }
  
  // Fetch parent account verification tier
  const { data: parentAccount } = await supabase
    .from('accounts')
    .select('verification_tier')
    .eq('id', existing.parent_account_id)
    .single();

  const parentTier = parentAccount?.verification_tier ?? 0;

  // Compute effective limits = min(KYA tier limits, parent account tier limits)
  const { limits: effectiveLimits, capped } = await computeEffectiveLimits(supabase, tier, parentTier);

  // Update KYA status and effective limits
  const { data, error } = await supabase
    .from('agents')
    .update({
      kya_tier: tier,
      kya_status: tier > 0 ? 'verified' : 'unverified',
      kya_verified_at: tier > 0 ? new Date().toISOString() : null,
      limit_per_transaction: effectiveLimits.per_transaction,
      limit_daily: effectiveLimits.daily,
      limit_monthly: effectiveLimits.monthly,
      effective_limit_per_tx: effectiveLimits.per_transaction,
      effective_limit_daily: effectiveLimits.daily,
      effective_limit_monthly: effectiveLimits.monthly,
      effective_limits_capped: capped,
    })
    .eq('id', id)
    .select(`
      *,
      accounts!agents_parent_account_id_fkey (
        id, type, name, verification_tier
      )
    `)
    .single();

  if (error) {
    console.error('Error verifying agent:', error);
    throw new Error('Failed to verify agent in database');
  }
  
  // Audit log
  await logAudit(supabase, {
    tenantId: ctx.tenantId,
    entityType: 'agent',
    entityId: id,
    action: 'kya_verified',
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    actorName: ctx.actorName,
    changes: {
      before: { kya_tier: existing.kya_tier, kya_status: existing.kya_status },
      after: { kya_tier: tier, kya_status: tier > 0 ? 'verified' : 'unverified' },
    },
  });
  
  const agent = mapAgentFromDb(data);
  if (data.accounts) {
    agent.parentAccount = {
      id: data.accounts.id,
      type: data.accounts.type,
      name: data.accounts.name,
      verificationTier: data.accounts.verification_tier,
    };
  }
  
  return c.json({ data: agent });
});

// ============================================
// POST /v1/agents/:id/rotate-token - Rotate agent token
// ============================================
agents.post('/:id/rotate-token', async (c) => {
  const ctx = c.get('ctx');
  const { id } = c.req.param();
  const supabase = createClient();

  if (!isValidUUID(id)) {
    const error: any = new ValidationError('Invalid agent ID format');
    error.details = {
      provided_id: id,
      expected_format: 'UUID',
    };
    throw error;
  }

  // Get existing agent
  const { data: existing, error: fetchError } = await supabase
    .from('agents')
    .select('id, name, tenant_id, status, auth_token_prefix')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .single();

  if (fetchError || !existing) {
    throw new NotFoundError('Agent');
  }

  // Only users (API key holders) can rotate tokens, not agents themselves
  if (ctx.actorType !== 'user') {
    const error: any = new ValidationError('Only API key holders can rotate agent tokens');
    error.details = {
      actor_type: ctx.actorType,
      required_actor_type: 'user',
    };
    throw error;
  }

  // Generate new token
  const newToken = generateAgentToken();
  const newTokenHash = hashApiKey(newToken);
  const newTokenPrefix = getKeyPrefix(newToken);

  // Update with new token
  const { error: updateError } = await supabase
    .from('agents')
    .update({
      auth_client_id: newTokenPrefix, // For display only
      auth_token_hash: newTokenHash,
      auth_token_prefix: newTokenPrefix,
    })
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId);

  if (updateError) {
    console.error('Error rotating token:', updateError);
    throw new Error('Failed to rotate token in database');
  }

  // Audit log
  await logAudit(supabase, {
    tenantId: ctx.tenantId,
    entityType: 'agent',
    entityId: id,
    action: 'token_rotated',
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    actorName: ctx.actorName,
    metadata: {
      oldPrefix: existing.auth_token_prefix,
      newPrefix: newTokenPrefix,
    },
  });

  // Return new token (only time it's visible!)
  return c.json({
    success: true,
    credentials: {
      token: newToken,
      prefix: newTokenPrefix,
      warning: '⚠️ SAVE THIS TOKEN NOW - it will never be shown again!',
    },
    previousTokenRevoked: true,
  });
});

// ============================================
// POST /v1/agents/:id/signing-keys - Generate signing key
// ============================================
agents.post('/:id/signing-keys', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  const supabase = createClient();

  if (!isValidUUID(id)) {
    const error: any = new ValidationError('Invalid agent ID format');
    error.details = {
      provided_id: id,
      expected_format: 'UUID',
    };
    throw error;
  }

  // Parse body
  let body;
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  const algorithm = body.algorithm || 'ed25519';
  if (!['ed25519', 'rsa-sha256'].includes(algorithm)) {
    throw new ValidationError('Algorithm must be "ed25519" or "rsa-sha256"');
  }

  // Verify agent exists and belongs to tenant
  const { data: agent, error: agentError } = await supabase
    .from('agents')
    .select('id, name, status, kya_tier')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .single();

  if (agentError || !agent) {
    throw new NotFoundError('Agent', id);
  }

  // Check if signing key already exists
  const { data: existingKey } = await supabase
    .from('agent_signing_keys')
    .select('id, key_id')
    .eq('agent_id', id)
    .eq('tenant_id', ctx.tenantId)
    .single();

  if (existingKey) {
    const error: any = new ValidationError('Agent already has a signing key');
    error.details = {
      agent_id: id,
      existing_key_id: existingKey.key_id,
      message: 'Use DELETE /v1/agents/:id/signing-keys first to replace',
    };
    throw error;
  }

  // Generate key pair
  const { generateAgentKeyPair } = await import('@sly/cards');
  const keyPair = await generateAgentKeyPair(algorithm as 'ed25519' | 'rsa-sha256');

  // Create key ID
  const keyId = `payos_agent_${id.slice(0, 8)}`;

  // Encrypt private key using credential-vault
  const { encryptAndSerialize } = await import('../services/credential-vault/index.js');
  const encryptedPrivateKey = encryptAndSerialize({ privateKey: keyPair.privateKey });

  // Store signing key
  const { data: signingKey, error: insertError } = await supabase
    .from('agent_signing_keys')
    .insert({
      tenant_id: ctx.tenantId,
      agent_id: id,
      key_id: keyId,
      algorithm,
      private_key_encrypted: encryptedPrivateKey,
      public_key: keyPair.publicKey,
      status: 'active',
    })
    .select('id, key_id, algorithm, public_key, status, created_at')
    .single();

  if (insertError) {
    console.error('Error creating signing key:', insertError);
    throw new Error('Failed to create signing key in database');
  }

  // Audit log
  await logAudit(supabase, {
    tenantId: ctx.tenantId,
    entityType: 'agent',
    entityId: id,
    action: 'signing_key_created',
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    actorName: ctx.actorName,
    metadata: {
      keyId,
      algorithm,
    },
  });

  return c.json({
    keyId: signingKey.key_id,
    publicKey: signingKey.public_key,
    algorithm: signingKey.algorithm,
    status: signingKey.status,
    registeredNetworks: [],
    createdAt: signingKey.created_at,
  }, 201);
});

// ============================================
// GET /v1/agents/:id/signing-keys - Get signing key status
// ============================================
agents.get('/:id/signing-keys', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  const supabase = createClient();

  if (!isValidUUID(id)) {
    const error: any = new ValidationError('Invalid agent ID format');
    error.details = {
      provided_id: id,
      expected_format: 'UUID',
    };
    throw error;
  }

  // Verify agent exists
  const { data: agent, error: agentError } = await supabase
    .from('agents')
    .select('id')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .single();

  if (agentError || !agent) {
    throw new NotFoundError('Agent', id);
  }

  // Get signing key
  const { data: signingKey, error: keyError } = await supabase
    .from('agent_signing_keys')
    .select('id, key_id, algorithm, public_key, status, registered_networks, use_count, last_used_at, created_at')
    .eq('agent_id', id)
    .eq('tenant_id', ctx.tenantId)
    .single();

  if (keyError || !signingKey) {
    return c.json({
      hasKey: false,
    });
  }

  return c.json({
    hasKey: true,
    keyId: signingKey.key_id,
    publicKey: signingKey.public_key,
    algorithm: signingKey.algorithm,
    status: signingKey.status,
    registeredNetworks: signingKey.registered_networks || [],
    stats: {
      useCount: signingKey.use_count || 0,
      lastUsedAt: signingKey.last_used_at,
    },
    createdAt: signingKey.created_at,
  });
});

// ============================================
// DELETE /v1/agents/:id/signing-keys - Revoke signing key
// ============================================
agents.delete('/:id/signing-keys', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  const supabase = createClient();

  if (!isValidUUID(id)) {
    const error: any = new ValidationError('Invalid agent ID format');
    error.details = {
      provided_id: id,
      expected_format: 'UUID',
    };
    throw error;
  }

  // Verify agent exists
  const { data: agent, error: agentError } = await supabase
    .from('agents')
    .select('id')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .single();

  if (agentError || !agent) {
    throw new NotFoundError('Agent', id);
  }

  // Get existing signing key
  const { data: existingKey, error: keyError } = await supabase
    .from('agent_signing_keys')
    .select('id, key_id')
    .eq('agent_id', id)
    .eq('tenant_id', ctx.tenantId)
    .single();

  if (keyError || !existingKey) {
    throw new NotFoundError('Signing key');
  }

  // Delete the signing key
  const { error: deleteError } = await supabase
    .from('agent_signing_keys')
    .delete()
    .eq('id', existingKey.id)
    .eq('tenant_id', ctx.tenantId);

  if (deleteError) {
    console.error('Error deleting signing key:', deleteError);
    throw new Error('Failed to delete signing key from database');
  }

  // Audit log
  await logAudit(supabase, {
    tenantId: ctx.tenantId,
    entityType: 'agent',
    entityId: id,
    action: 'signing_key_revoked',
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    actorName: ctx.actorName,
    metadata: {
      keyId: existingKey.key_id,
    },
  });

  return c.json({
    success: true,
    message: 'Signing key revoked',
    keyId: existingKey.key_id,
  });
});

// ============================================
// POST /v1/agents/:id/sign-request - Sign a request
// ============================================
agents.post('/:id/sign-request', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  const supabase = createClient();

  if (!isValidUUID(id)) {
    const error: any = new ValidationError('Invalid agent ID format');
    error.details = {
      provided_id: id,
      expected_format: 'UUID',
    };
    throw error;
  }

  // Parse body
  let body;
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError('Invalid JSON body');
  }

  const { method, path, host, headers: reqHeaders, body: reqBody, payment } = body;

  if (!method || !path) {
    throw new ValidationError('Missing required fields: method, path');
  }

  // Verify agent exists and is active
  const { data: agent, error: agentError } = await supabase
    .from('agents')
    .select('id, name, status, kya_tier')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .single();

  if (agentError || !agent) {
    throw new NotFoundError('Agent', id);
  }

  // Check agent is active
  if (agent.status !== 'active') {
    const error: any = new ValidationError('Agent is not active');
    error.details = {
      agent_id: id,
      status: agent.status,
      required_status: 'active',
    };
    throw error;
  }

  // Check KYA tier >= 1 (unverified agents cannot sign)
  if (agent.kya_tier < 1) {
    const error: any = new ValidationError('Agent must be KYA verified (tier >= 1) to sign requests');
    error.details = {
      agent_id: id,
      kya_tier: agent.kya_tier,
      required_tier: 1,
    };
    throw error;
  }

  // Check spending limits if payment info provided
  if (payment && payment.amount) {
    const limitService = createLimitService(supabase);
    const limitCheck = await limitService.checkTransactionLimit(id, payment.amount);

    if (!limitCheck.allowed) {
      const error: any = new ValidationError(`Spending limit exceeded: ${limitCheck.reason}`);
      error.details = {
        agent_id: id,
        limit_type: limitCheck.limitType,
        limit: limitCheck.limit,
        used: limitCheck.used,
        requested: limitCheck.requested,
      };
      throw error;
    }
  }

  // Get signing key
  const { data: signingKey, error: keyError } = await supabase
    .from('agent_signing_keys')
    .select('id, key_id, algorithm, private_key_encrypted, status')
    .eq('agent_id', id)
    .eq('tenant_id', ctx.tenantId)
    .single();

  if (keyError || !signingKey) {
    throw new NotFoundError('Signing key for agent. Generate one first with POST /v1/agents/:id/signing-keys');
  }

  if (signingKey.status !== 'active') {
    const error: any = new ValidationError('Signing key is not active');
    error.details = {
      key_id: signingKey.key_id,
      status: signingKey.status,
    };
    throw error;
  }

  // Decrypt private key
  const { deserializeAndDecrypt } = await import('../services/credential-vault/index.js');
  const decryptedKey = deserializeAndDecrypt(signingKey.private_key_encrypted);
  const privateKey = decryptedKey.privateKey as string;

  // Sign the request
  const { WebBotAuthSigner } = await import('@sly/cards');
  const signer = new WebBotAuthSigner({
    keyId: signingKey.key_id,
    privateKey,
    algorithm: signingKey.algorithm as 'ed25519' | 'rsa-sha256',
  });

  const signResult = await signer.sign({
    method,
    path,
    host,
    headers: reqHeaders || {},
    body: reqBody,
  });

  // Log the signing request
  const { data: signingRequest, error: logError } = await supabase
    .from('agent_signing_requests')
    .insert({
      tenant_id: ctx.tenantId,
      agent_id: id,
      signing_key_id: signingKey.id,
      request_method: method,
      request_path: path,
      request_host: host || null,
      signature_input: signResult.signatureInput,
      signature: signResult.signature,
      content_digest: signResult.contentDigest || null,
      amount: payment?.amount || null,
      currency: payment?.currency || null,
      merchant_name: payment?.merchantName || null,
      status: 'signed',
      expires_at: signResult.expiresAt,
    })
    .select('id')
    .single();

  if (logError) {
    console.error('Warning: Failed to log signing request:', logError);
  }

  // Update signing key usage stats
  await supabase.rpc('update_signing_key_usage', { p_key_id: signingKey.id });

  return c.json({
    signatureInput: signResult.signatureInput,
    signature: signResult.signature,
    contentDigest: signResult.contentDigest,
    headers: signResult.headers,
    expiresAt: signResult.expiresAt,
    signingRequestId: signingRequest?.id,
  });
});

// ============================================
// AGENT SKILLS CRUD
// ============================================

// Known Sly-native skill IDs that can be processed locally
const SLY_NATIVE_SKILL_IDS = new Set([
  'agent_info', 'check_balance', 'transaction_history', 'get_quote',
  'lookup_account', 'make_payment', 'create_checkout', 'access_api',
  'create_mandate', 'research',
]);

const skillSchema = z.object({
  skill_id: z.string().min(1).max(255),
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  input_modes: z.array(z.string()).optional().default(['text']),
  output_modes: z.array(z.string()).optional().default(['text', 'data']),
  tags: z.array(z.string()).optional().default([]),
  input_schema: z.record(z.unknown()).optional(),
  base_price: z.number().min(0).default(0),
  currency: z.string().max(10).optional().default('USDC'),
  status: z.enum(['active', 'disabled']).optional().default('active'),
  handler_type: z.enum(['sly_native', 'agent_provided']).optional().default('agent_provided'),
  metadata: z.record(z.unknown()).optional(),
});

/**
 * GET /v1/agents/:id/skills — List agent's skills
 */
agents.get('/:id/skills', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  if (!isValidUUID(id)) throw new ValidationError('Invalid agent ID');

  const supabase = createClient();

  // Verify agent belongs to tenant
  const { data: agent } = await supabase
    .from('agents')
    .select('id')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .single();

  if (!agent) throw new NotFoundError('Agent');

  const { data: skills, error } = await supabase
    .from('agent_skills')
    .select('*')
    .eq('agent_id', id)
    .eq('tenant_id', ctx.tenantId)
    .order('created_at');

  if (error) throw new Error(error.message);

  return c.json({ data: skills || [] });
});

/**
 * POST /v1/agents/:id/skills — Register a new skill
 */
agents.post('/:id/skills', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  if (!isValidUUID(id)) throw new ValidationError('Invalid agent ID');

  const body = await c.req.json();
  const parsed = skillSchema.safeParse(body);
  if (!parsed.success) throw new ValidationError('Invalid skill data: ' + parsed.error.message);

  // Validate sly_native skill IDs are known handlers
  if (parsed.data.handler_type === 'sly_native' && !SLY_NATIVE_SKILL_IDS.has(parsed.data.skill_id)) {
    throw new ValidationError(
      `Unknown sly_native skill_id: "${parsed.data.skill_id}". ` +
      `Valid sly_native skills: ${[...SLY_NATIVE_SKILL_IDS].join(', ')}`,
    );
  }

  const supabase = createClient();

  // Verify agent belongs to tenant
  const { data: agent } = await supabase
    .from('agents')
    .select('id')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .single();

  if (!agent) throw new NotFoundError('Agent');

  const { data: skill, error } = await supabase
    .from('agent_skills')
    .upsert({
      tenant_id: ctx.tenantId,
      agent_id: id,
      ...parsed.data,
    }, { onConflict: 'tenant_id,agent_id,skill_id' })
    .select('*')
    .single();

  if (error) throw new Error(error.message);

  logAudit(supabase, ctx, 'agent.skill.created', { agentId: id, skillId: parsed.data.skill_id });
  return c.json(skill, 201);
});

/**
 * PATCH /v1/agents/:id/skills/:skillId — Update a skill
 */
agents.patch('/:id/skills/:skillId', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  const skillId = c.req.param('skillId');
  if (!isValidUUID(id)) throw new ValidationError('Invalid agent ID');

  const body = await c.req.json();
  const allowed = ['name', 'description', 'base_price', 'currency', 'status', 'tags', 'input_modes', 'output_modes', 'input_schema', 'metadata', 'handler_type'];
  const updates: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in body) updates[key] = body[key];
  }

  // Validate handler_type if provided
  if (updates.handler_type && !['sly_native', 'agent_provided'].includes(updates.handler_type as string)) {
    throw new ValidationError('handler_type must be "sly_native" or "agent_provided"');
  }

  if (Object.keys(updates).length === 0) throw new ValidationError('No valid fields to update');

  updates.updated_at = new Date().toISOString();

  const supabase = createClient();

  const { data: skill, error } = await supabase
    .from('agent_skills')
    .update(updates)
    .eq('agent_id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('skill_id', skillId)
    .select('*')
    .single();

  if (error || !skill) throw new NotFoundError('Skill');

  logAudit(supabase, ctx, 'agent.skill.updated', { agentId: id, skillId });
  return c.json(skill);
});

/**
 * DELETE /v1/agents/:id/skills/:skillId — Remove a skill
 */
agents.delete('/:id/skills/:skillId', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  const skillId = c.req.param('skillId');
  if (!isValidUUID(id)) throw new ValidationError('Invalid agent ID');

  const supabase = createClient();

  const { error } = await supabase
    .from('agent_skills')
    .delete()
    .eq('agent_id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('skill_id', skillId);

  if (error) throw new Error(error.message);

  logAudit(supabase, ctx, 'agent.skill.deleted', { agentId: id, skillId });
  return c.json({ deleted: true });
});

// ============================================
// AGENT ENDPOINT MANAGEMENT
// ============================================

const endpointSchema = z.object({
  endpoint_url: z.string().url().max(1024),
  endpoint_type: z.enum(['webhook', 'a2a', 'x402']),
  endpoint_secret: z.string().max(255).optional(),
});

/**
 * PUT /v1/agents/:id/endpoint — Register or update agent endpoint
 */
agents.put('/:id/endpoint', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  if (!isValidUUID(id)) throw new ValidationError('Invalid agent ID');

  const body = await c.req.json();
  const parsed = endpointSchema.safeParse(body);
  if (!parsed.success) throw new ValidationError('Invalid endpoint data: ' + parsed.error.message);

  // Validate URL protocol
  const url = new URL(parsed.data.endpoint_url);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new ValidationError('endpoint_url must use HTTPS (or localhost for development)');
  }

  const supabase = createClient();

  // Verify agent belongs to tenant
  const { data: agent } = await supabase
    .from('agents')
    .select('id, name')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .single();

  if (!agent) throw new NotFoundError('Agent');

  const { data, error } = await supabase
    .from('agents')
    .update({
      endpoint_url: parsed.data.endpoint_url,
      endpoint_type: parsed.data.endpoint_type,
      endpoint_secret: parsed.data.endpoint_secret || null,
      endpoint_enabled: true,
    })
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .select('id, endpoint_url, endpoint_type, endpoint_enabled')
    .single();

  if (error) throw new Error(error.message);

  await logAudit(supabase, {
    tenantId: ctx.tenantId,
    entityType: 'agent',
    entityId: id,
    action: 'endpoint_configured',
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    actorName: ctx.actorName,
    metadata: { endpoint_type: parsed.data.endpoint_type, endpoint_url: parsed.data.endpoint_url },
  });

  return c.json({
    data: {
      id: data.id,
      endpoint_url: data.endpoint_url,
      endpoint_type: data.endpoint_type,
      endpoint_enabled: data.endpoint_enabled,
      has_secret: !!parsed.data.endpoint_secret,
    },
  });
});

/**
 * GET /v1/agents/:id/endpoint — Get current endpoint configuration
 */
agents.get('/:id/endpoint', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  if (!isValidUUID(id)) throw new ValidationError('Invalid agent ID');

  const supabase = createClient();

  const { data: agent, error } = await supabase
    .from('agents')
    .select('id, endpoint_url, endpoint_type, endpoint_enabled, endpoint_secret')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .single();

  if (error || !agent) throw new NotFoundError('Agent');

  return c.json({
    data: {
      id: agent.id,
      endpoint_url: agent.endpoint_url,
      endpoint_type: agent.endpoint_type || 'none',
      endpoint_enabled: agent.endpoint_enabled || false,
      has_secret: !!agent.endpoint_secret,
    },
  });
});

/**
 * DELETE /v1/agents/:id/endpoint — Disable and clear endpoint
 */
agents.delete('/:id/endpoint', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  if (!isValidUUID(id)) throw new ValidationError('Invalid agent ID');

  const supabase = createClient();

  // Verify agent belongs to tenant
  const { data: agent } = await supabase
    .from('agents')
    .select('id')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .single();

  if (!agent) throw new NotFoundError('Agent');

  const { error } = await supabase
    .from('agents')
    .update({
      endpoint_url: null,
      endpoint_type: 'none',
      endpoint_secret: null,
      endpoint_enabled: false,
    })
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId);

  if (error) throw new Error(error.message);

  await logAudit(supabase, {
    tenantId: ctx.tenantId,
    entityType: 'agent',
    entityId: id,
    action: 'endpoint_removed',
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    actorName: ctx.actorName,
  });

  return c.json({ data: { id, endpoint_enabled: false } });
});

export default agents;
