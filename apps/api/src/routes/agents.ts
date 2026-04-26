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
  getEnv,
} from '../utils/helpers.js';
import { createLimitService } from '../services/limits.js';
import { ValidationError, NotFoundError, LimitExceededError } from '../middleware/error.js';
import { generateAgentToken, hashApiKey, getKeyPrefix } from '../utils/crypto.js';
import { ErrorCode } from '@sly/types';
import { triggerWorkflows } from '../services/workflow-trigger.js';
import { validateProcessingConfig, VALID_PROCESSING_MODES } from '../utils/processing-config-validation.js';
import { trackOp } from '../services/ops/track-op.js';
import { OpType } from '../services/ops/operation-types.js';
import { checkAgentLimit } from '../services/tenant-limits.js';
import { registerAgent } from '../services/erc8004/registry.js';
import { checkT2Eligibility, processEnterpriseOverride } from '../services/kya/verification.js';
import { recordObservation } from '../services/kya/observation.js';
import { cascadeRevokeForAgent } from '../services/auth/scopes/index.js';
import { guardSiblingScope } from '../services/auth/scopes/guard.js';

const agents = new Hono();

// Extract host from a URL without throwing on malformed input.
// Used by x402-sign to derive vendor info for ledger enrichment.
function safeParseHost(url: string): string | null {
  try { return new URL(url).hostname; } catch { return null; }
}

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

// Story 51.1: Accept both accountId (new) and parentAccountId (deprecated).
// Also accept parent_account_id (snake_case) as an additional deprecated
// alias — the rest of the agents payload uses snake_case (wallet_id,
// auto_create_wallet, etc.), so callers naturally reach for snake_case
// here too. Without the alias the API silently dropped the value and
// created a parent-less agent.
// Story 51.6: Add auto_create_wallet option
// Story 59.15: accountId is optional — standalone agents have no parent
const createAgentSchema = z.object({
  accountId: z.string().uuid().optional(),
  parentAccountId: z.string().uuid().optional(), // Deprecated, use accountId
  parent_account_id: z.string().uuid().optional(), // Deprecated, use accountId
  name: z.string().min(1).max(255),
  description: z.string().max(1000).optional(),
  permissions: permissionsSchema,
  wallet_id: z.string().uuid().optional(), // Existing wallet to assign
  auto_create_wallet: z.boolean().optional().default(true), // Story 51.6: Auto-create wallet if not specified
  generate_keypair: z.boolean().optional().default(true), // Epic 72: Auto-generate Ed25519 auth key
  processing_mode: z.enum(['managed', 'webhook', 'manual']).optional(),
  processing_config: z.record(z.unknown()).optional(),
});

const updateAgentSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(1000).optional().nullable(),
  permissions: permissionsSchema,
  dailyLimit: z.number().positive().optional(),
  monthlyLimit: z.number().positive().optional(),
  perTransactionLimit: z.number().positive().optional(),
  processing_mode: z.enum(['managed', 'webhook', 'manual']).optional(),
  processing_config: z.record(z.unknown()).optional(),
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
  const connected = query.connected; // Epic 72: filter by SSE connection status
  const env = query.env; // Epic 82 dashboards — pass `env=all` to span both envs

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

  // env=all opts out of the implicit env filter; everything else
  // (test/live/undefined) keeps the existing per-env scoping.
  if (env !== 'all') {
    dbQuery = dbQuery.eq('environment', getEnv(ctx));
  }
  
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

  // Epic 72: If ?connected=true, filter to only agents with active SSE connections
  let connectedAgentIds: Set<string> | null = null;
  if (connected === 'true') {
    const { data: activeConns } = await (supabase
      .from('agent_connections') as any)
      .select('agent_id')
      .eq('tenant_id', ctx.tenantId)
      .is('disconnected_at', null);
    connectedAgentIds = new Set((activeConns || []).map((c: any) => c.agent_id));
    if (connectedAgentIds.size > 0) {
      dbQuery = dbQuery.in('id', [...connectedAgentIds]);
    } else {
      // No connected agents — return empty result
      return c.json(paginationResponse([], 0, { page, limit }));
    }
  }

  const { data, count, error } = await dbQuery;
  
  if (error) {
    console.error('Error fetching agents:', error);
    throw new Error('Failed to fetch agents from database');
  }
  
  // Batch-fetch on-chain wallet addresses for agents
  const agentIds = (data || []).map(r => r.id);
  const walletMap = new Map<string, string>();
  if (agentIds.length > 0) {
    const { data: wallets } = await supabase
      .from('wallets')
      .select('managed_by_agent_id, wallet_address')
      .in('managed_by_agent_id', agentIds)
      .eq('environment', getEnv(ctx))
      .like('wallet_address', '0x%');
    for (const w of wallets || []) {
      if (w.managed_by_agent_id && w.wallet_address) {
        walletMap.set(w.managed_by_agent_id, w.wallet_address);
      }
    }
  }

  // Epic 72: Batch-fetch liveness (active SSE connections)
  const livenessMap = new Map<string, { connected: boolean; connectedAt?: string; lastHeartbeatAt?: string }>();
  if (agentIds.length > 0) {
    const { data: activeConns } = await (supabase
      .from('agent_connections') as any)
      .select('agent_id, connected_at, last_heartbeat_at')
      .in('agent_id', agentIds)
      .eq('tenant_id', ctx.tenantId)
      .is('disconnected_at', null);
    for (const conn of activeConns || []) {
      livenessMap.set(conn.agent_id, {
        connected: true,
        connectedAt: conn.connected_at,
        lastHeartbeatAt: conn.last_heartbeat_at,
      });
    }
  }

  // Map to response format
  const agents = (data || []).map(row => {
    const agent = mapAgentFromDb(row);
    if (row.accounts) {
      agent.parentAccount = {
        id: row.accounts.id,
        type: row.accounts.type as any,
        name: row.accounts.name,
        verificationTier: (row.accounts.verification_tier ?? 0) as any,
      };
    }
    if (walletMap.has(row.id)) {
      agent.walletAddress = walletMap.get(row.id);
    }
    agent.liveness = livenessMap.get(row.id) || { connected: false };
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

  // Story 51.1: Normalize deprecated field names. Accept both
  // camelCase (parentAccountId) and snake_case (parent_account_id) as
  // aliases for accountId — the rest of this payload is snake_case
  // (wallet_id, auto_create_wallet) so callers naturally try both.
  const { data: normalizedBody, deprecatedFieldsUsed } = normalizeFields(body, {
    parentAccountId: 'accountId',
    parent_account_id: 'accountId',
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

  const { name, description, permissions, wallet_id, auto_create_wallet, processing_mode, processing_config } = parsed.data;
  // Prefer new name; fall back to either deprecated alias.
  const accountId = parsed.data.accountId
    || parsed.data.parentAccountId
    || (parsed.data as any).parent_account_id;

  // Validate processing_mode + processing_config pairing
  if (processing_mode && !processing_config) {
    throw new ValidationError('processing_config is required when processing_mode is provided');
  }
  if (processing_config && !processing_mode) {
    throw new ValidationError('processing_mode is required when processing_config is provided');
  }
  if (processing_mode && processing_config) {
    const configResult = validateProcessingConfig(processing_mode, processing_config);
    if (!configResult.valid) {
      throw new ValidationError(configResult.error!);
    }
  }

  // Story 59.15: Parent account is optional — validate if provided
  let parentAccount: any = null;
  if (accountId) {
    // Verify parent account exists and belongs to tenant
    const { data: pa, error: parentError } = await supabase
      .from('accounts')
      .select('id, type, name, verification_tier')
      .eq('id', accountId)
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
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

  // Check agent limit
  try {
    await checkAgentLimit(ctx.tenantId);
  } catch (err: any) {
    if (err.code === 'AGENT_LIMIT_REACHED') {
      return c.json({ error: err.message, code: err.code, details: err.details }, 403);
    }
    throw err;
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
  const insertData: Record<string, any> = {
    tenant_id: ctx.tenantId,
    environment: getEnv(ctx),
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
  };
  if (processing_mode) {
    insertData.processing_mode = processing_mode;
    insertData.processing_config = processing_config;
  }

  const { data, error } = await supabase
    .from('agents')
    .insert(insertData as any)
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
      .eq('environment', getEnv(ctx))
      .single();

    if (walletError || !wallet) {
      // Rollback agent creation
      await supabase.from('agents').delete().eq('id', data.id).eq('environment', getEnv(ctx));
      throw new NotFoundError('Wallet', wallet_id);
    }

    // Update wallet to be managed by this agent
    await supabase
      .from('wallets')
      .update({ managed_by_agent_id: data.id })
      .eq('id', wallet_id)
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx));

    assignedWalletId = wallet_id;
  } else if (auto_create_wallet !== false && accountId) {
    // Story 51.6: Auto-create a wallet for the agent (requires parent account as owner)
    // Phase 2: Try Circle sandbox wallet first, fall back to internal
    const isSandboxEnv = process.env.PAYOS_ENVIRONMENT === 'sandbox' && !!process.env.CIRCLE_API_KEY;

    if (isSandboxEnv) {
      try {
        const { getCircleClient } = await import('../services/circle/client.js');
        const circle = getCircleClient();

        // Get or create wallet set for this tenant
        const walletSetId = process.env.CIRCLE_WALLET_SET_ID;
        if (walletSetId) {
          const circleWallet = await circle.createWallet(
            walletSetId,
            'BASE',
            `${name} Agent Wallet`,
            data.id,
          );

          const { data: wallet, error: walletError } = await supabase
            .from('wallets')
            .insert({
              tenant_id: ctx.tenantId,
              environment: getEnv(ctx),
              owner_account_id: accountId,
              managed_by_agent_id: data.id,
              balance: 0,
              currency: 'USDC',
              wallet_address: circleWallet.address,
              network: 'base-sepolia',
              status: 'active',
              wallet_type: 'circle_custodial',
              custody_type: 'custodial',
              provider: 'circle',
              provider_wallet_id: circleWallet.id,
              provider_wallet_set_id: walletSetId,
              provider_metadata: {
                circle_wallet_id: circleWallet.id,
                circle_state: circleWallet.state,
                blockchain: 'BASE',
                created_via: 'agent_auto_create',
              },
              name: `${name} Wallet`,
              purpose: `Circle sandbox wallet for agent ${name}`,
            })
            .select('id')
            .single();

          if (!walletError && wallet) {
            assignedWalletId = wallet.id;
            // Also store the on-chain address on the agent
            await supabase
              .from('agents')
              .update({
                wallet_address: circleWallet.address,
                wallet_verification_status: 'verified',
                wallet_verified_at: new Date().toISOString(),
              })
              .eq('id', data.id)
              .eq('tenant_id', ctx.tenantId)
              .eq('environment', getEnv(ctx));
            console.log(`[Agent] Created Circle sandbox wallet ${wallet.id} (${circleWallet.address}) for agent ${data.id}`);
          }
        }
      } catch (circleErr) {
        console.warn('[Agent] Circle wallet creation failed, falling back to internal:', circleErr);
      }
    }

    // Fallback to internal wallet if Circle didn't work
    if (!assignedWalletId) {
      const walletAddress = `internal://payos/${ctx.tenantId}/${accountId}/agent/${data.id}`;

      const { data: wallet, error: walletError } = await supabase
        .from('wallets')
        .insert({
          tenant_id: ctx.tenantId,
          environment: getEnv(ctx),
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
      } else {
        assignedWalletId = wallet.id;
        console.log(`[Agent] Auto-created wallet ${wallet.id} for agent ${data.id}`);
      }
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

  // ERC-8004: Auto-register agent on-chain (fire-and-forget)
  registerAgent(data.id, name, description || '').catch(err =>
    console.warn('[ERC-8004] On-chain registration failed:', err.message)
  );

  trackOp({
    tenantId: ctx.tenantId,
    operation: OpType.ENTITY_AGENT_CREATED,
    subject: `agent/${data.id}`,
    actorType: ctx.actorType,
    actorId: ctx.actorId || ctx.userId || ctx.apiKeyId,
    correlationId: (c as any).get('requestId'),
    success: true,
  });

  // Epic 72: Auto-generate Ed25519 auth key pair
  let authKeyResponse: Record<string, unknown> | undefined;
  if (parsed.data.generate_keypair !== false) {
    try {
      const { generateEd25519KeyPair, generateAuthKeyId, hashApiKey: hashKey } = await import('../utils/crypto.js');
      const { privateKey, publicKey } = generateEd25519KeyPair();
      const authKeyId = generateAuthKeyId(data.id);
      const publicKeyHash = hashKey(publicKey);

      await (supabase.from('agent_auth_keys') as any).insert({
        tenant_id: ctx.tenantId,
        agent_id: data.id,
        key_id: authKeyId,
        algorithm: 'ed25519',
        public_key: publicKey,
        public_key_hash: publicKeyHash,
        status: 'active',
      });

      authKeyResponse = {
        keyId: authKeyId,
        publicKey,
        privateKey,
        algorithm: 'ed25519',
        warning: 'SAVE THIS PRIVATE KEY NOW — it will never be shown again!',
      };
    } catch (e) {
      // Non-fatal: log and continue — the agent is still usable via bearer token
      console.error('Warning: Failed to auto-generate Ed25519 key pair:', (e as Error).message);
    }
  }

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
    ...(authKeyResponse ? { authKey: authKeyResponse } : {}),
  }, 201);
});

// ============================================
// GET /v1/agents/stats/skills-count — Count all active skills
// ============================================
agents.get('/stats/skills-count', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();

  const { count, error } = await supabase
    .from('agent_skills')
    .select('*', { count: 'exact', head: true })
    .eq('tenant_id', ctx.tenantId)
    .eq('status', 'active');

  if (error) throw new Error(error.message);

  return c.json({ data: { count: count || 0 } });
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

  // Epic 82 — sibling reads require tenant_read.
  const denied = await guardSiblingScope(c, supabase, id, 'tenant_read', `GET /v1/agents/${id}`);
  if (denied) return denied;

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
    .eq('environment', getEnv(ctx))
    .single();

  if (error || !data) {
    throw new NotFoundError('Agent', id);
  }

  const agent = mapAgentFromDb(data);
  if (data.accounts) {
    agent.parentAccount = {
      id: data.accounts.id,
      type: data.accounts.type as any,
      name: data.accounts.name,
      verificationTier: (data.accounts.verification_tier ?? 0) as any,
    };
  }

  // Fetch on-chain wallet address
  const { data: agentWallet } = await supabase
    .from('wallets')
    .select('wallet_address')
    .eq('managed_by_agent_id', id)
    .eq('environment', getEnv(ctx))
    .like('wallet_address', '0x%')
    .limit(1)
    .single();
  if (agentWallet?.wallet_address) {
    agent.walletAddress = agentWallet.wallet_address;
  }

  // Fetch active skills for this agent
  const { data: skills } = await supabase
    .from('agent_skills')
    .select('skill_id, name, description, input_modes, output_modes, tags, base_price, currency')
    .eq('agent_id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('status', 'active')
    .order('created_at');

  // Build A2A card URL from request context
  const baseUrl = c.req.url.split('/v1/')[0];
  const a2aCardUrl = `${baseUrl}/a2a/agents/${id}/card`;

  // Include endpoint configuration
  const endpoint = {
    url: data.endpoint_url || null,
    type: data.endpoint_type || 'none',
    enabled: data.endpoint_enabled || false,
    hasSecret: !!data.endpoint_secret,
  };

  // Epic 72: Fetch liveness (active SSE connection)
  const { data: activeConn } = await (supabase
    .from('agent_connections') as any)
    .select('connected_at, last_heartbeat_at')
    .eq('agent_id', id)
    .eq('tenant_id', ctx.tenantId)
    .is('disconnected_at', null)
    .order('connected_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const liveness = activeConn
    ? {
        connected: true,
        connectedAt: activeConn.connected_at,
        lastHeartbeatAt: activeConn.last_heartbeat_at,
        connectionDuration: Math.floor((Date.now() - new Date(activeConn.connected_at).getTime()) / 1000),
      }
    : { connected: false };

  return c.json({ data: { ...agent, skills: skills || [], a2aCardUrl, endpoint, liveness } });
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

  // Epic 82 — mutating a sibling agent requires tenant_write.
  const denied = await guardSiblingScope(c, supabase, id, 'tenant_write', `PATCH /v1/agents/${id}`);
  if (denied) return denied;

  // Check agent exists
  const { data: existing, error: fetchError } = await supabase
    .from('agents')
    .select('*')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
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
      ...((existing.permissions as Record<string, unknown>) || {}),
      ...parsed.data.permissions,
    };
  }

  // Validate processing_mode + processing_config pairing
  const hasMode = parsed.data.processing_mode !== undefined;
  const hasConfig = parsed.data.processing_config !== undefined;
  if (hasMode && !hasConfig) {
    throw new ValidationError('processing_config is required when processing_mode is provided');
  }
  if (hasConfig && !hasMode) {
    throw new ValidationError('processing_mode is required when processing_config is provided');
  }
  if (hasMode && hasConfig) {
    const configResult = validateProcessingConfig(parsed.data.processing_mode!, parsed.data.processing_config!);
    if (!configResult.valid) {
      throw new ValidationError(configResult.error!);
    }
    updates.processing_mode = parsed.data.processing_mode;
    updates.processing_config = parsed.data.processing_config;
  }

  // If any limits are being updated, cap by parent account tier
  const hasLimitUpdate =
    parsed.data.dailyLimit !== undefined ||
    parsed.data.monthlyLimit !== undefined ||
    parsed.data.perTransactionLimit !== undefined;

  if (hasLimitUpdate) {
    // When no parent account exists, use safe KYA-tier-based defaults instead of
    // Infinity. This prevents unbounded limits for orphaned or parentless agents.
    // Tier 0: $10/$50/$200, Tier 1: $100/$500/$2000, Tier 2: $1000/$5000/$20000, Tier 3: $10000/$50000/$200000
    const KYA_DEFAULTS: Record<number, { per_transaction: number; daily: number; monthly: number }> = {
      0: { per_transaction: 10, daily: 50, monthly: 200 },
      1: { per_transaction: 100, daily: 500, monthly: 2000 },
      2: { per_transaction: 1000, daily: 5000, monthly: 20000 },
      3: { per_transaction: 10000, daily: 50000, monthly: 200000 },
    };
    const kyaTier = existing.kya_tier ?? 0;
    let parentLimits = KYA_DEFAULTS[kyaTier] || KYA_DEFAULTS[0];
    if (existing.parent_account_id) {
      const { data: parentAccount } = await supabase
        .from('accounts')
        .select('verification_tier')
        .eq('id', existing.parent_account_id)
        .eq('environment', getEnv(ctx))
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
    .eq('environment', getEnv(ctx))
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
      type: data.accounts.type as any,
      name: data.accounts.name,
      verificationTier: (data.accounts.verification_tier ?? 0) as any,
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
    .eq('environment', getEnv(ctx))
    .single();

  if (fetchError || !existing) {
    throw new NotFoundError('Agent', id);
  }

  // Check for active streams managed by this agent
  const { count: streamCount } = await supabase
    .from('streams')
    .select('*', { count: 'exact', head: true })
    .eq('environment', getEnv(ctx))
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
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx));

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

  trackOp({
    tenantId: ctx.tenantId,
    operation: OpType.ENTITY_AGENT_DELETED,
    subject: `agent/${id}`,
    actorType: ctx.actorType,
    actorId: ctx.actorId || ctx.userId || ctx.apiKeyId,
    correlationId: (c as any).get('requestId'),
    success: true,
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
    .eq('environment', getEnv(ctx))
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
    .eq('environment', getEnv(ctx))
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
      type: data.accounts.type as any,
      name: data.accounts.name,
      verificationTier: (data.accounts.verification_tier ?? 0) as any,
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
    .eq('environment', getEnv(ctx))
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
    .eq('environment', getEnv(ctx))
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
      type: data.accounts.type as any,
      name: data.accounts.name,
      verificationTier: (data.accounts.verification_tier ?? 0) as any,
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
    .eq('environment', getEnv(ctx))
    .single();

  if (agentError || !agent) {
    throw new NotFoundError('Agent', id);
  }

  // Get streams managed by this agent
  const { data, error } = await supabase
    .from('streams')
    .select('*')
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
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
    .eq('environment', getEnv(ctx))
    .single();

  if (!agentExists) {
    throw new NotFoundError('Agent', id);
  }

  const limitService = createLimitService(supabase, getEnv(ctx) as 'test' | 'live');
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
    .eq('environment', getEnv(ctx))
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

  // Fetch transfers initiated by this agent (AP2 mandate executions, external
  // x402 signs, etc.). We match on `initiated_by_id = agent.id` regardless of
  // `initiated_by_type`: agent UUIDs are globally unique, so a tenant-key call
  // that set `initiated_by_id` to the agent's UUID (e.g. /x402-sign) is still
  // "this agent's activity" from the caller's perspective.
  // Exclude ACP-type transfers to avoid duplicating data already fetched above.
  let transferQuery = supabase
    .from('transfers')
    .select('id, type, status, currency, amount, description, created_at, from_account_id, to_account_id, from_account_name, to_account_name, fee_amount, protocol_metadata, settlement_network, tx_hash, environment', { count: 'exact' })
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
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
    .eq('environment', getEnv(ctx))
    .eq('managed_by_agent_id', id);

  const agentWalletIds = (agentWallets || []).map((w: any) => w.id);
  const directTransferIds = new Set((agentTransfers || []).map((t: any) => t.id));

  let walletTransfers: any[] = [];
  let walletTransferTotal = 0;

  if (agentWalletIds.length > 0) {
    let walletTxQuery = supabase
      .from('transfers')
      .select('id, type, status, currency, amount, description, created_at, from_account_id, to_account_id, from_account_name, to_account_name, fee_amount, protocol_metadata, settlement_network, tx_hash, environment', { count: 'exact' })
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
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

  // Fetch A2A tasks involving this agent (as provider or caller)
  let a2aQuery = supabase
    .from('a2a_tasks')
    .select('id, state, status_message, direction, created_at, updated_at, transfer_id, client_agent_id, metadata', { count: 'exact' })
    .eq('tenant_id', ctx.tenantId)
    .or(`agent_id.eq.${id},client_agent_id.eq.${id}`)
    .order('created_at', { ascending: false });

  if (dateFrom) a2aQuery = a2aQuery.gte('created_at', dateFrom);
  if (dateTo) a2aQuery = a2aQuery.lte('created_at', dateTo);

  const { data: a2aTasks, count: a2aTotal } = await a2aQuery.range(offset, offset + limit - 1);

  // Look up transfer amounts for A2A tasks that have linked transfers
  const a2aTransferIds = (a2aTasks || []).map((t: any) => t.transfer_id).filter(Boolean) as string[];
  const a2aTransferAmounts = new Map<string, { amount: number; currency: string }>();
  if (a2aTransferIds.length > 0) {
    const { data: a2aLinkedTransfers } = await supabase
      .from('transfers')
      .select('id, amount, currency')
      .in('id', a2aTransferIds)
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx));
    for (const t of a2aLinkedTransfers || []) {
      a2aTransferAmounts.set(t.id, { amount: Number(t.amount) || 0, currency: t.currency || 'USDC' });
    }
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
    ...([...(agentTransfers || []), ...walletTransfers]).map((t: any) => {
      const pm = t.protocol_metadata || {};
      // External x402 rows have null from/to_account_id — surface the on-chain
      // destination + chain so the dashboard can render a counterparty.
      const isExternal = pm.direction === 'external';
      return {
        id: t.id,
        environment: t.environment || 'test',
        type: t.type as string,
        status: t.status,
        currency: t.currency,
        amount: parseFloat(t.amount) || 0,
        order_id: null,
        created_at: t.created_at,
        description: t.description || `${t.type} transfer`,
        from_account_name: t.from_account_name || null,
        to_account_name: t.to_account_name || null,
        protocol: pm.protocol || t.type || null,
        fee_amount: parseFloat(t.fee_amount) || 0,
        // New: external x402 context (null for all non-external rows).
        external: isExternal ? {
          from_address: pm.from_address || null,
          to_address: pm.to_address || null,
          chain_id: pm.chain_id || null,
          settlement_network: t.settlement_network || null,
          tx_hash: t.tx_hash || null,
        } : null,
      };
    }),
    ...(a2aTasks || []).map((t: any) => {
      const linkedTransfer = t.transfer_id ? a2aTransferAmounts.get(t.transfer_id) : undefined;
      const isProvider = t.direction === 'inbound';
      const stateToStatus: Record<string, string> = {
        completed: 'completed', failed: 'failed', canceled: 'canceled',
        submitted: 'pending', working: 'pending', 'input-required': 'pending',
      };
      return {
        id: t.id,
        type: 'a2a_task' as const,
        status: stateToStatus[t.state] || t.state,
        currency: linkedTransfer?.currency || 'USDC',
        amount: linkedTransfer?.amount || 0,
        order_id: null,
        created_at: t.created_at,
        description: t.status_message || `A2A task (${t.direction})`,
        from_account_name: isProvider ? 'Caller agent' : null,
        to_account_name: isProvider ? null : 'Provider agent',
        protocol: 'a2a',
        fee_amount: 0,
        a2a_state: t.state,
        a2a_direction: t.direction,
      };
    }),
  ].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  return c.json({
    data: transactions,
    pagination: {
      limit,
      offset,
      total: (ucpTotal || 0) + (acpTotal || 0) + (transferTotal || 0) + walletTransferTotal + (a2aTotal || 0),
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
    .eq('environment', getEnv(ctx))
    .single();

  if (fetchError || !existing) {
    throw new NotFoundError('Agent', id);
  }

  // Fetch parent account verification tier
  const { data: parentAccount } = existing.parent_account_id
    ? await supabase
        .from('accounts')
        .select('verification_tier')
        .eq('id', existing.parent_account_id)
        .eq('environment', getEnv(ctx))
        .single()
    : { data: null as { verification_tier: number | null } | null };

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
    .eq('environment', getEnv(ctx))
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
      type: data.accounts.type as any,
      name: data.accounts.name,
      verificationTier: (data.accounts.verification_tier ?? 0) as any,
    };
  }
  
  return c.json({ data: agent });
});

// ============================================
// POST /v1/agents/:id/upgrade - KYA tier upgrade (Story 73.5)
// ============================================
const upgradeSchema = z.object({
  target_tier: z.number().int().min(0).max(3),
  // T1 (DSD) fields
  skill_manifest: z.object({
    protocols: z.array(z.string()),
    action_types: z.array(z.string()),
    domain: z.string(),
    description: z.string(),
  }).optional(),
  spending_policy: z.object({
    per_transaction: z.number().optional(),
    daily: z.number().optional(),
    monthly: z.number().optional(),
    allowlisted_domains: z.array(z.string()).optional(),
  }).optional(),
  escalation_policy: z.enum(['DECLINE', 'SUSPEND_AND_NOTIFY', 'REQUEST_APPROVAL']).optional(),
  use_case_description: z.string().optional(),
  model_family: z.string().optional(),
  model_version: z.string().optional(),
  // T3 fields
  kill_switch_operator: z.object({
    name: z.string(),
    email: z.string().email(),
  }).optional(),
});

agents.post('/:id/upgrade', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  const supabase = createClient();

  if (!isValidUUID(id)) throw new ValidationError('Invalid agent ID format');

  const body = upgradeSchema.parse(await c.req.json());
  const { target_tier } = body;

  // Fetch existing agent
  const { data: existing, error: fetchError } = await supabase
    .from('agents')
    .select('*, accounts!agents_parent_account_id_fkey (id, type, name, verification_tier)')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();

  if (fetchError || !existing) throw new NotFoundError('Agent', id);

  const currentTier = existing.kya_tier || 0;
  if (target_tier <= currentTier) {
    throw new ValidationError(`Agent is already at KYA tier ${currentTier}. Cannot downgrade or stay at same tier.`);
  }

  // Tier-specific validation
  if (target_tier >= 1) {
    if (!body.skill_manifest) {
      throw new ValidationError('KYA T1+ requires a skill_manifest (Delegation Scope Document)');
    }
    if (!body.escalation_policy) {
      throw new ValidationError('KYA T1+ requires an escalation_policy');
    }
  }

  if (target_tier >= 2) {
    // Story 73.17: Use verification service for T2 eligibility
    const eligibility = await checkT2Eligibility(supabase, id);
    if (!eligibility.eligible) {
      throw new ValidationError(
        `KYA T2 upgrade blocked: ${eligibility.blockers.join('; ')}`,
      );
    }
  }

  if (target_tier >= 3) {
    if (!body.kill_switch_operator) {
      throw new ValidationError('KYA T3 requires a designated kill-switch operator');
    }
  }

  // Build update payload
  const parentTier = existing.accounts?.verification_tier ?? 0;
  const { limits: effectiveLimits, capped } = await computeEffectiveLimits(supabase, target_tier, parentTier);

  const updatePayload: Record<string, any> = {
    kya_tier: target_tier,
    kya_status: 'verified',
    kya_verified_at: new Date().toISOString(),
    limit_per_transaction: effectiveLimits.per_transaction,
    limit_daily: effectiveLimits.daily,
    limit_monthly: effectiveLimits.monthly,
    effective_limit_per_tx: effectiveLimits.per_transaction,
    effective_limit_daily: effectiveLimits.daily,
    effective_limit_monthly: effectiveLimits.monthly,
    effective_limits_capped: capped,
  };

  // CAI fields
  if (body.skill_manifest) updatePayload.skill_manifest = body.skill_manifest;
  if (body.escalation_policy) updatePayload.escalation_policy = body.escalation_policy;
  if (body.use_case_description) updatePayload.use_case_description = body.use_case_description;
  if (body.model_family) updatePayload.model_family = body.model_family;
  if (body.model_version) updatePayload.model_version = body.model_version;
  if (body.kill_switch_operator) {
    updatePayload.kill_switch_operator_name = body.kill_switch_operator.name;
    updatePayload.kill_switch_operator_email = body.kill_switch_operator.email;
    updatePayload.kill_switch_operator_id = ctx.userId || ctx.actorId;
  }

  const { data, error } = await supabase
    .from('agents')
    .update(updatePayload)
    .eq('id', id)
    .eq('environment', getEnv(ctx))
    .select('*, accounts!agents_parent_account_id_fkey (id, type, name, verification_tier)')
    .single();

  if (error) throw new Error(`Failed to upgrade agent: ${error.message}`);

  await logAudit(supabase, {
    tenantId: ctx.tenantId,
    entityType: 'agent',
    entityId: id,
    action: 'kya_upgraded',
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    actorName: ctx.actorName,
    changes: {
      before: { kya_tier: currentTier, kya_status: existing.kya_status },
      after: { kya_tier: target_tier, kya_status: 'verified' },
    },
  });

  const agent = mapAgentFromDb(data);
  if (data.accounts) {
    agent.parentAccount = {
      id: data.accounts.id,
      type: data.accounts.type as any,
      name: data.accounts.name,
      verificationTier: (data.accounts.verification_tier ?? 0) as any,
    };
  }

  return c.json({ data: agent });
});

// ============================================
// GET /v1/agents/:id/kya-status - KYA tier status (Story 73.5)
// ============================================
agents.get('/:id/kya-status', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  const supabase = createClient();

  if (!isValidUUID(id)) throw new ValidationError('Invalid agent ID format');

  // Core fields always exist; CAI fields may not exist until migration 20260413_agent_cai_fields is applied
  const { data: agent, error } = await supabase
    .from('agents')
    .select(`
      id, name, kya_tier, kya_status, kya_verified_at,
      limit_per_transaction, limit_daily, limit_monthly,
      effective_limit_per_tx, effective_limit_daily, effective_limit_monthly,
      effective_limits_capped, parent_account_id,
      accounts!agents_parent_account_id_fkey (id, verification_tier, type)
    `)
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();

  if (error || !agent) throw new NotFoundError('Agent', id);

  // Try to fetch CAI fields separately (graceful if columns don't exist yet)
  let caiFields: any = {};
  try {
    const { data: cai } = await supabase
      .from('agents')
      .select('skill_manifest, use_case_description, escalation_policy, model_family, model_version, operational_history_start, policy_violation_count, behavioral_consistency_score, kya_enterprise_override, kya_override_assessed_at, kill_switch_operator_id, kill_switch_operator_name, kill_switch_operator_email')
      .eq('id', id)
      .single();
    if (cai) caiFields = cai;
  } catch { /* CAI columns not yet migrated */ }

  const operationalDays = caiFields.operational_history_start
    ? Math.floor((Date.now() - new Date(caiFields.operational_history_start).getTime()) / (86400 * 1000))
    : 0;

  const parentTier = agent.accounts?.verification_tier ?? 0;
  const kyaTier = agent.kya_tier || 0;

  // Determine upgrade eligibility
  let upgradeEligible = false;
  let nextTier: number | null = null;
  let upgradeBlockers: string[] = [];

  if (kyaTier < 3) {
    nextTier = kyaTier + 1;
    if (nextTier === 1) {
      upgradeEligible = true; // T1 just needs DSD declaration
    } else if (nextTier === 2) {
      if (operationalDays < 30 && !caiFields.kya_enterprise_override) {
        upgradeBlockers.push(`Need ${30 - operationalDays} more days of operational history`);
      }
      if ((caiFields.policy_violation_count || 0) > 0) {
        upgradeBlockers.push(`${caiFields.policy_violation_count} policy violation(s) must be resolved`);
      }
      upgradeEligible = upgradeBlockers.length === 0;
    } else if (nextTier === 3) {
      upgradeEligible = false; // T3 requires manual review
      upgradeBlockers.push('KYA T3 requires security review and kill-switch operator designation');
    }
  }

  return c.json({
    agentId: agent.id,
    name: agent.name,
    tier: kyaTier,
    status: agent.kya_status,
    verifiedAt: agent.kya_verified_at,
    effectiveLimits: {
      perTransaction: Number(agent.effective_limit_per_tx ?? 0) || 0,
      daily: Number(agent.effective_limit_daily ?? 0) || 0,
      monthly: Number(agent.effective_limit_monthly ?? 0) || 0,
      cappedByParent: agent.effective_limits_capped || false,
      parentTier,
    },
    cai: {
      modelFamily: caiFields.model_family || null,
      modelVersion: caiFields.model_version || null,
      skillManifest: caiFields.skill_manifest || null,
      useCaseDescription: caiFields.use_case_description || null,
      escalationPolicy: caiFields.escalation_policy || 'DECLINE',
      operationalDays,
      policyViolationCount: caiFields.policy_violation_count || 0,
      behavioralConsistencyScore: caiFields.behavioral_consistency_score != null
        ? parseFloat(caiFields.behavioral_consistency_score)
        : null,
      enterpriseOverride: caiFields.kya_enterprise_override || false,
      killSwitchEnabled: !!caiFields.kill_switch_operator_id,
    },
    upgrade: {
      eligible: upgradeEligible,
      nextTier,
      blockers: upgradeBlockers,
    },
  });
});

// ============================================
// GET /v1/agents/:id/trust-profile - Cross-org queryable (Story 73.5/73.18)
// Publicly queryable — no auth required for cross-org use.
// ============================================
agents.get('/:id/trust-profile', async (c) => {
  const id = c.req.param('id');
  const supabase = createClient();

  if (!isValidUUID(id)) throw new ValidationError('Invalid agent ID format');

  // Core fields that always exist
  const { data: agent, error } = await supabase
    .from('agents')
    .select(`
      id, kya_tier, kya_status, kya_verified_at,
      accounts!agents_parent_account_id_fkey (verification_tier, type)
    `)
    .eq('id', id)
    .single();

  if (error || !agent) throw new NotFoundError('Agent', id);

  // CAI fields (graceful if columns don't exist yet)
  let cai: any = {};
  try {
    const { data } = await supabase
      .from('agents')
      .select('skill_manifest, model_family, operational_history_start, policy_violation_count, behavioral_consistency_score, kill_switch_operator_id')
      .eq('id', id)
      .single();
    if (data) cai = data;
  } catch { /* CAI columns not yet migrated */ }

  const kyaTier = agent.kya_tier || 0;
  const operationalDays = cai.operational_history_start
    ? Math.floor((Date.now() - new Date(cai.operational_history_start).getTime()) / (86400 * 1000))
    : 0;

  // T0/T1 agents get minimal profiles
  const isMinimal = kyaTier < 2;

  return c.json({
    agentId: agent.id,
    kyaTier,
    parentVerificationTier: agent.accounts?.verification_tier ?? 0,
    parentEntityType: agent.accounts?.type ?? 'person',
    operationalDays,
    policyViolationCount: isMinimal ? null : (cai.policy_violation_count || 0),
    behavioralConsistencyScore: isMinimal ? null : (
      cai.behavioral_consistency_score != null
        ? parseFloat(cai.behavioral_consistency_score)
        : null
    ),
    skillManifest: isMinimal ? null : (cai.skill_manifest || null),
    modelFamily: isMinimal ? null : (cai.model_family || null),
    killSwitchEnabled: !!cai.kill_switch_operator_id,
    lastVerifiedAt: agent.kya_verified_at,
  });
});

// ============================================
// POST /v1/agents/:id/declare-dsd - DSD Declaration (Story 73.15)
// ============================================
const declareDsdSchema = z.object({
  skill_manifest: z.object({
    protocols: z.array(z.string()).min(1, 'At least one protocol required'),
    action_types: z.array(z.string()).min(1, 'At least one action_type required'),
    domain: z.string().min(1, 'Domain is required'),
    description: z.string().min(1, 'Description is required'),
  }),
  spending_policy: z.object({
    per_transaction: z.number().optional(),
    daily: z.number().optional(),
    monthly: z.number().optional(),
    allowlisted_domains: z.array(z.string()).optional(),
  }).optional(),
  escalation_policy: z.enum(['DECLINE', 'SUSPEND_AND_NOTIFY', 'REQUEST_APPROVAL']),
  use_case_description: z.string().min(1, 'Use case description is required'),
  model_family: z.string().optional(),
  model_version: z.string().optional(),
});

agents.post('/:id/declare-dsd', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  const supabase = createClient();

  if (!isValidUUID(id)) throw new ValidationError('Invalid agent ID format');

  const body = declareDsdSchema.parse(await c.req.json());

  // Fetch existing agent
  const { data: existing, error: fetchError } = await supabase
    .from('agents')
    .select('*, accounts!agents_parent_account_id_fkey (id, type, name, verification_tier)')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();

  if (fetchError || !existing) throw new NotFoundError('Agent', id);

  const currentTier = existing.kya_tier || 0;
  const updatePayload: Record<string, any> = {
    skill_manifest: body.skill_manifest,
    escalation_policy: body.escalation_policy,
    use_case_description: body.use_case_description,
    updated_at: new Date().toISOString(),
  };

  if (body.model_family) updatePayload.model_family = body.model_family;
  if (body.model_version) updatePayload.model_version = body.model_version;

  // Auto-upgrade T0 -> T1 if valid DSD is provided
  if (currentTier === 0) {
    const parentTier = existing.accounts?.verification_tier ?? null;
    const { limits: effectiveLimits, capped } = await computeEffectiveLimits(supabase, 1, parentTier);

    updatePayload.kya_tier = 1;
    updatePayload.kya_status = 'verified';
    updatePayload.kya_verified_at = new Date().toISOString();
    updatePayload.limit_per_transaction = effectiveLimits.per_transaction;
    updatePayload.limit_daily = effectiveLimits.daily;
    updatePayload.limit_monthly = effectiveLimits.monthly;
    updatePayload.effective_limit_per_tx = effectiveLimits.per_transaction;
    updatePayload.effective_limit_daily = effectiveLimits.daily;
    updatePayload.effective_limit_monthly = effectiveLimits.monthly;
    updatePayload.effective_limits_capped = capped;
  }

  const { data, error } = await supabase
    .from('agents')
    .update(updatePayload)
    .eq('id', id)
    .eq('environment', getEnv(ctx))
    .select('*, accounts!agents_parent_account_id_fkey (id, type, name, verification_tier)')
    .single();

  if (error) throw new Error(`Failed to declare DSD: ${error.message}`);

  await logAudit(supabase, {
    tenantId: ctx.tenantId,
    entityType: 'agent',
    entityId: id,
    action: currentTier === 0 ? 'dsd_declared_and_upgraded' : 'dsd_declared',
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    actorName: ctx.actorName,
    changes: {
      before: { kya_tier: currentTier, skill_manifest: existing.skill_manifest },
      after: { kya_tier: updatePayload.kya_tier || currentTier, skill_manifest: body.skill_manifest },
    },
  });

  const agent = mapAgentFromDb(data);
  if (data.accounts) {
    agent.parentAccount = {
      id: data.accounts.id,
      type: data.accounts.type as any,
      name: data.accounts.name,
      verificationTier: (data.accounts.verification_tier ?? 0) as any,
    };
  }

  return c.json({ data: agent });
});

// ============================================
// POST /v1/agents/:id/kill-switch - Activate kill switch (Story 73.19)
// ============================================
agents.post('/:id/kill-switch', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  const supabase = createClient();

  if (!isValidUUID(id)) throw new ValidationError('Invalid agent ID format');

  // Fetch the agent
  const { data: agent, error: fetchError } = await supabase
    .from('agents')
    .select('id, name, status, kill_switch_operator_id, kill_switch_operator_name, tenant_id')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();

  if (fetchError || !agent) throw new NotFoundError('Agent', id);

  // Authorization: designated operator, tenant owner/admin, or API key holder.
  // If no operator is designated, any authenticated tenant caller can activate (implicit operator).
  const isDesignatedOperator = agent.kill_switch_operator_id && agent.kill_switch_operator_id === ctx.userId;
  const isTenantOwner = ctx.userRole === 'owner' || ctx.userRole === 'admin';
  const isApiKey = ctx.actorType === 'api_key';
  const noOperatorDesignated = !agent.kill_switch_operator_id;

  if (!isDesignatedOperator && !isTenantOwner && !isApiKey && !noOperatorDesignated) {
    throw new ValidationError(
      'Only the designated kill-switch operator or a tenant owner/admin can activate the kill switch',
    );
  }

  // Suspend the agent
  const { error: updateError } = await supabase
    .from('agents')
    .update({
      status: 'suspended',
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('environment', getEnv(ctx));

  if (updateError) throw new Error(`Failed to suspend agent: ${updateError.message}`);

  // Cancel all pending transactions for this agent
  const { data: cancelledTransfers, error: cancelError } = await supabase
    .from('transfers')
    .update({
      status: 'cancelled',
      updated_at: new Date().toISOString(),
    })
    .eq('agent_id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('status', 'pending')
    .select('id');

  if (cancelError) {
    console.error('Failed to cancel pending transfers during kill switch:', cancelError);
  }

  const pendingCancelled = cancelledTransfers?.length || 0;

  // Epic 82 — cascade-revoke any active scope grants this agent holds.
  // A killed agent must lose every elevation in the same atomic action.
  let scopeGrantsRevoked = 0;
  try {
    const cascade = await cascadeRevokeForAgent(
      supabase,
      ctx.tenantId,
      id,
      ctx.userId || ctx.actorId || 'system',
    );
    scopeGrantsRevoked = cascade.revokedCount;
  } catch (err) {
    console.error('[kill-switch] scope cascade failed:', err);
  }

  await logAudit(supabase, {
    tenantId: ctx.tenantId,
    entityType: 'agent',
    entityId: id,
    action: 'kill_switch_activated',
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    actorName: ctx.actorName,
    metadata: {
      agentName: agent.name,
      pendingTransfersCancelled: pendingCancelled,
      scopeGrantsRevoked,
      activatedBy: ctx.actorName || ctx.actorId,
    },
  });

  return c.json({
    suspended: true,
    pendingCancelled,
    scopeGrantsRevoked,
  });
});

// ============================================
// POST /v1/agents/:id/kill-switch/designate - Designate kill-switch operator (Story 73.19)
// ============================================
const designateKillSwitchSchema = z.object({
  operator_name: z.string().min(1, 'Operator name is required'),
  operator_email: z.string().email('Valid email is required'),
});

agents.post('/:id/kill-switch/designate', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  const supabase = createClient();

  if (!isValidUUID(id)) throw new ValidationError('Invalid agent ID format');

  const body = designateKillSwitchSchema.parse(await c.req.json());

  // Verify agent belongs to tenant
  const { data: agent, error: fetchError } = await supabase
    .from('agents')
    .select('id, name')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();

  if (fetchError || !agent) throw new NotFoundError('Agent', id);

  const { data, error } = await supabase
    .from('agents')
    .update({
      kill_switch_operator_id: ctx.userId || ctx.actorId,
      kill_switch_operator_name: body.operator_name,
      kill_switch_operator_email: body.operator_email,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('environment', getEnv(ctx))
    .select('*, accounts!agents_parent_account_id_fkey (id, type, name, verification_tier)')
    .single();

  if (error) throw new Error(`Failed to designate kill-switch operator: ${error.message}`);

  await logAudit(supabase, {
    tenantId: ctx.tenantId,
    entityType: 'agent',
    entityId: id,
    action: 'kill_switch_operator_designated',
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    actorName: ctx.actorName,
    metadata: {
      operatorName: body.operator_name,
      operatorEmail: body.operator_email,
    },
  });

  const result = mapAgentFromDb(data);
  if (data.accounts) {
    result.parentAccount = {
      id: data.accounts.id,
      type: data.accounts.type as any,
      name: data.accounts.name,
      verificationTier: (data.accounts.verification_tier ?? 0) as any,
    };
  }

  return c.json({ data: result });
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
    .eq('environment', getEnv(ctx))
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
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx));

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
    .eq('environment', getEnv(ctx))
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
    .eq('environment', getEnv(ctx))
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
    .eq('environment', getEnv(ctx))
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
    .eq('environment', getEnv(ctx))
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
  if ((agent.kya_tier ?? 0) < 1) {
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
    const limitService = createLimitService(supabase, getEnv(ctx) as 'test' | 'live');
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
// POST /v1/agents/:id/x402-sign
// Sign an EIP-3009 transferWithAuthorization payload for x402 payments.
// Uses the agent's managed secp256k1 EOA key stored in agent_signing_keys.
// ============================================
agents.post('/:id/x402-sign', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');

  if (!isValidUUID(id)) {
    throw new ValidationError('Invalid agent ID format');
  }

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError('Invalid JSON body');
  }

  const {
    to,
    value,
    chainId,
    validAfter = 0,
    validBefore,
    nonce,
    // Optional enrichment so the ledger row describes WHAT was paid for, not
    // just WHO received money. `x402_fetch` forwards this from the 402
    // challenge (challenge.resource) so the dashboard can render vendor +
    // endpoint instead of just a recipient address.
    resource,
    // Optional agent intent — captured at sign time so the per-call
    // quality rating later has a yardstick: "the agent asked for X, did
    // the response deliver X?". Mirrors A2A's expectedOutcome pattern.
    // No schema change needed — stored at protocol_metadata.intent.
    intent,
  } = body;

  if (!to || !value || !validBefore) {
    throw new ValidationError('Missing required fields: to, value, validBefore');
  }
  if (chainId === undefined || chainId === null || chainId === '') {
    throw new ValidationError(
      'Missing required field: chainId. Pass 8453 for Base mainnet or 84532 for Base Sepolia. ' +
      'No default is applied to prevent silent wrong-network signatures.',
    );
  }
  const chainIdNum = Number(chainId);
  if (!Number.isFinite(chainIdNum)) {
    throw new ValidationError(`Invalid chainId: ${chainId}`);
  }

  const supabase = createClient();

  // Verify caller has permission (agent must own the key OR caller is same tenant API key)
  if (ctx.actorType === 'agent' && ctx.actorId !== id) {
    return c.json({ error: 'Agent can only sign with their own key' }, 403);
  }

  // Use cached agent row from auth middleware if available (avoids re-query)
  const cachedAgent = ctx.actorType === 'agent' && ctx.actorId === id ? (c as any).get('agentRow') : null;
  let agentEnvironment: 'test' | 'live';
  if (cachedAgent) {
    agentEnvironment = (cachedAgent as any).environment === 'live' ? 'live' : 'test';
  } else {
    const { data: agent, error: agentError } = await supabase
      .from('agents')
      .select('id, name, status, kya_tier, tenant_id, parent_account_id, environment')
      .eq('id', id)
      .eq('tenant_id', ctx.tenantId)
      .single();

    if (agentError || !agent) {
      throw new NotFoundError('Agent', id);
    }
    if ((agent as any).status !== 'active') {
      throw new ValidationError('Agent is not active');
    }
    agentEnvironment = (agent as any).environment === 'live' ? 'live' : 'test';
  }

  // Enforce env ↔ chain coherence. Test agents must use Base Sepolia (84532);
  // live agents must use Base mainnet (8453). Without this, a test agent can
  // silently sign mainnet authorizations and drain real USDC if someone
  // manually funded the EOA. The check runs before KYA limits so callers get
  // the most specific error first.
  const expectedChainId = agentEnvironment === 'live' ? 8453 : 84532;
  if (chainIdNum !== expectedChainId) {
    const expectedName = expectedChainId === 8453 ? 'Base mainnet' : 'Base Sepolia';
    throw new ValidationError(
      `chainId ${chainIdNum} is not allowed for a ${agentEnvironment} agent. ` +
      `Use ${expectedChainId} (${expectedName}) instead. ` +
      `Flip the agent's environment if you need to sign on the other chain.`,
    );
  }

  // Check wallet freeze status — block signing if agent's wallet is frozen
  const { data: frozenWallets } = await supabase
    .from('wallets')
    .select('status')
    .eq('managed_by_agent_id', id)
    .eq('status', 'frozen')
    .limit(1);
  if (frozenWallets && frozenWallets.length > 0) {
    return c.json({ error: 'Agent wallet is frozen — signing blocked', code: 'WALLET_FROZEN' }, 403);
  }

  // Enforce KYA spending limits BEFORE signing. `value` is USDC micro-units
  // (6 decimals); the limit service works in whole-USDC units.
  const valueBig = (() => {
    try { return BigInt(String(value)); } catch { throw new ValidationError(`Invalid value: ${value}`); }
  })();
  if (valueBig <= 0n) {
    throw new ValidationError('value must be a positive integer in token micro-units');
  }
  const amountUsdc = Number(valueBig) / 1_000_000;
  const limitService = createLimitService(supabase, getEnv(ctx) as 'test' | 'live');
  const limitCheck = await limitService.checkTransactionLimit(id, amountUsdc);
  if (!limitCheck.allowed) {
    throw new LimitExceededError(
      limitCheck.limitType || 'transaction',
      limitCheck.limit ?? 0,
      limitCheck.requested ?? amountUsdc,
      limitCheck.used,
    );
  }

  // Wallet-level spending policy enforcement. KYA caps run at the agent
  // level; spending_policy runs at the wallet level so tenants can
  // constrain specific signing addresses below the agent's KYA headroom
  // (e.g. "Tina's EOA can only spend $5/day even though her tier allows
  // $20"). Check daily + monthly caps against live spend from the
  // transfers ledger so counters can't drift. Returns a structured
  // response with nearLimit warnings when spending crosses ≥80%.
  // ─────────────────────────────────────────────────────────────────
  let nearLimitWarnings: Array<{ scope: 'daily' | 'monthly'; percent: number; limit: number; spent: number }> = [];
  {
    const { data: eoaWallet } = await supabase
      .from('wallets')
      .select('id, spending_policy, currency')
      .eq('managed_by_agent_id', id)
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', agentEnvironment)
      .eq('wallet_type', 'agent_eoa')
      .eq('status', 'active')
      .maybeSingle();
    const policy: any = (eoaWallet as any)?.spending_policy || {};
    const dailyLimit = policy.dailySpendLimit != null ? Number(policy.dailySpendLimit) : null;
    const monthlyLimit = policy.monthlySpendLimit != null ? Number(policy.monthlySpendLimit) : null;

    if (dailyLimit != null || monthlyLimit != null) {
      const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
      const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
      // Count completed + in-flight x402 spend attributed to this agent.
      // Matches the same type-aware filter the wallet GET handler uses.
      const buildSpendQuery = (sinceIso: string) => supabase
        .from('transfers')
        .select('amount')
        .eq('tenant_id', ctx.tenantId)
        .eq('environment', agentEnvironment)
        .eq('initiated_by_id', id)
        .in('status', ['completed', 'pending', 'processing'])
        .in('type', ['x402', 'internal', 'mpp', 'ucp_settlement', 'acp_settlement'])
        .gte('created_at', sinceIso);
      const [dailyRes, monthlyRes] = await Promise.all([
        dailyLimit != null ? buildSpendQuery(dayStart.toISOString()) : Promise.resolve({ data: [] as any[] }),
        monthlyLimit != null ? buildSpendQuery(monthStart.toISOString()) : Promise.resolve({ data: [] as any[] }),
      ]);
      const sumAmount = (rows: any[] | null) => (rows || []).reduce((acc, r) => acc + (Number(r.amount) || 0), 0);
      const dailySpent = dailyLimit != null ? sumAmount((dailyRes as any).data) : 0;
      const monthlySpent = monthlyLimit != null ? sumAmount((monthlyRes as any).data) : 0;

      // Block when the new sign would cross the cap.
      if (dailyLimit != null && dailySpent + amountUsdc > dailyLimit) {
        return c.json({
          error: {
            code: 'WALLET_DAILY_LIMIT_EXCEEDED',
            message: `Wallet daily cap would be exceeded. Already spent $${dailySpent.toFixed(4)} of $${dailyLimit} today; this sign adds $${amountUsdc.toFixed(4)}.`,
            details: { scope: 'daily', limit: dailyLimit, spent: dailySpent, requested: amountUsdc, remaining: Math.max(0, dailyLimit - dailySpent) },
          },
        }, 403);
      }
      if (monthlyLimit != null && monthlySpent + amountUsdc > monthlyLimit) {
        return c.json({
          error: {
            code: 'WALLET_MONTHLY_LIMIT_EXCEEDED',
            message: `Wallet monthly cap would be exceeded. Already spent $${monthlySpent.toFixed(4)} of $${monthlyLimit} this month; this sign adds $${amountUsdc.toFixed(4)}.`,
            details: { scope: 'monthly', limit: monthlyLimit, spent: monthlySpent, requested: amountUsdc, remaining: Math.max(0, monthlyLimit - monthlySpent) },
          },
        }, 403);
      }

      // Soft warnings at ≥80% post-sign utilization. Don't block.
      const postDaily = dailyLimit != null ? (dailySpent + amountUsdc) / dailyLimit : 0;
      const postMonthly = monthlyLimit != null ? (monthlySpent + amountUsdc) / monthlyLimit : 0;
      if (dailyLimit != null && postDaily >= 0.8) {
        nearLimitWarnings.push({
          scope: 'daily',
          percent: Math.round(postDaily * 100),
          limit: dailyLimit,
          spent: dailySpent + amountUsdc,
        });
      }
      if (monthlyLimit != null && postMonthly >= 0.8) {
        nearLimitWarnings.push({
          scope: 'monthly',
          percent: Math.round(postMonthly * 100),
          limit: monthlyLimit,
          spent: monthlySpent + amountUsdc,
        });
      }
    }
  }

  // Fetch the agent's secp256k1 key
  const { getAgentEvmKey, signTransferWithAuthorization, usdcDomain, generateNonce } =
    await import('../services/x402/signer.js');

  const keyRecord = await getAgentEvmKey(supabase, id);
  if (!keyRecord) {
    return c.json({
      error: 'Agent has no EVM signing key registered',
      code: 'NO_EVM_KEY',
      hint: 'POST /v1/agents/:id/evm-keys to provision one',
    }, 404);
  }

  // Resolve the USDC contract for the requested chain
  let domain;
  try {
    domain = usdcDomain(chainIdNum);
  } catch (e: any) {
    throw new ValidationError(e.message);
  }

  // Sign the EIP-3009 payload
  let signed;
  try {
    signed = await signTransferWithAuthorization(keyRecord, {
      from: keyRecord.ethereum_address,
      to,
      value: String(value),
      validAfter: Number(validAfter),
      validBefore: Number(validBefore),
      nonce: nonce || generateNonce(),
      ...domain,
      chainId: chainIdNum,
    });
  } catch (e: any) {
    return c.json({ error: `Signing failed: ${e.message}` }, 500);
  }

  // Bump signing-key usage stats (fire-and-forget)
  void (supabase.from('agent_signing_keys') as any)
    .update({ last_used_at: new Date().toISOString() })
    .eq('agent_id', id)
    .eq('algorithm', 'secp256k1')
    .then(() => {}, () => {});

  // Write a transfers ledger row reflecting the committed external x402 spend.
  // Status 'pending' matches the transfers check constraint; the facilitator's
  // on-chain settlement is tracked separately — callers POST the settlement
  // receipt back via /v1/transfers/:id/record-settlement once they see the
  // X-PAYMENT-RESPONSE header, which flips status → 'completed' + tx_hash.
  let transferId: string | null = null;
  try {
    // supabase-js resolves with `{ data, error }` on DB rejection instead of
    // throwing — the try/catch alone isn't enough; we must check `.error` too.
    const { data: insertedRow, error: ledgerErr } = await (supabase.from('transfers') as any).insert({
      tenant_id: ctx.tenantId,
      environment: getEnv(ctx),
      type: 'x402',
      status: 'pending',
      from_account_id: null,
      to_account_id: null,
      initiated_by_type: ctx.actorType,
      initiated_by_id: id,
      initiated_by_name: ctx.actorName || null,
      amount: amountUsdc,
      currency: 'USDC',
      // Prefer a human-readable description when the caller enriched with
      // resource info; fall back to the raw recipient address.
      description: (() => {
        if (resource && typeof resource === 'object') {
          const host = resource.host || (resource.url ? safeParseHost(resource.url) : null);
          const desc = resource.description ? String(resource.description).slice(0, 80) : null;
          if (host && desc) return `${host} — ${desc}`;
          if (host) return `${host}${resource.path ? resource.path : ''}`;
          if (desc) return desc;
        }
        return `external x402 auth — ${to}`;
      })(),
      settlement_network: chainIdNum === 8453 ? 'base' : chainIdNum === 84532 ? 'base-sepolia' : `eip155:${chainIdNum}`,
      protocol_metadata: {
        protocol: 'x402',
        direction: 'external',
        to_address: signed.params.to,
        from_address: signed.from,
        chain_id: signed.params.chainId,
        token_address: signed.params.tokenAddress,
        token_value_microunits: signed.params.value,
        valid_after: signed.params.validAfter,
        valid_before: signed.params.validBefore,
        nonce: signed.params.nonce,
        signature_prefix: String(signed.signature).slice(0, 18),
        // Carry the resource block into the ledger when the caller provided
        // it. Dashboard reads this to show "what was paid for" instead of a
        // bare recipient address.
        resource: resource && typeof resource === 'object' ? {
          url: resource.url || null,
          host: resource.host || (resource.url ? safeParseHost(resource.url) : null),
          path: resource.path || null,
          method: resource.method || null,
          description: resource.description || null,
          mime_type: resource.mimeType || resource.mime_type || null,
          marketplace: resource.marketplace || null,
        } : null,
        // Agent intent: why was this call made, and what does the
        // agent expect to find? The quality rating is measured
        // against this, so the dashboard can show the intent alongside
        // the response side-by-side.
        intent: intent && typeof intent === 'object' ? {
          reason: typeof intent.reason === 'string' ? intent.reason.slice(0, 500) : null,
          expected_fields: Array.isArray(intent.expectedFields)
            ? intent.expectedFields.slice(0, 32).map((f: any) => String(f).slice(0, 80))
            : null,
          linked_probe_transfer_id: typeof intent.linkedProbeTransferId === 'string'
            ? intent.linkedProbeTransferId
            : null,
          request_body_hash: typeof intent.requestBodyHash === 'string'
            ? intent.requestBodyHash.slice(0, 128)
            : null,
          captured_at: new Date().toISOString(),
        } : null,
      },
    }).select('id').single();
    if (ledgerErr || !insertedRow?.id) {
      console.error('[x402-sign] ledger insert failed', ledgerErr);
      return c.json({
        error: 'Failed to record signed authorization; signature not returned',
        code: 'LEDGER_WRITE_FAILED',
        details: ledgerErr?.message,
      }, 500);
    }
    transferId = insertedRow.id;
  } catch (ledgerErr: any) {
    // Network-level failures that DO throw (e.g. Supabase unreachable).
    console.error('[x402-sign] ledger insert threw', ledgerErr);
    return c.json({
      error: 'Failed to record signed authorization; signature not returned',
      code: 'LEDGER_WRITE_FAILED',
      details: ledgerErr?.message,
    }, 500);
  }

  // Bump daily/monthly usage counters (fire-and-forget — limit check already
  // validated the request; a counter write failure shouldn't block the sign).
  void limitService.recordUsage(id, amountUsdc).catch((e) => {
    console.error('[x402-sign] recordUsage failed', e);
  });

  return c.json({
    success: true,
    transferId,
    signature: signed.signature,
    v: signed.v,
    r: signed.r,
    s: signed.s,
    from: signed.from,
    to: signed.params.to,
    value: signed.params.value,
    chainId: signed.params.chainId,
    tokenAddress: signed.params.tokenAddress,
    validAfter: signed.params.validAfter,
    validBefore: signed.params.validBefore,
    nonce: signed.params.nonce,
    // Soft warnings when post-sign utilization crosses ≥80% of a
    // wallet-level spending cap. Agents/clients can log or escalate;
    // this does NOT block the sign (which already succeeded).
    warnings: nearLimitWarnings.length > 0 ? nearLimitWarnings.map(w => ({
      code: w.scope === 'daily' ? 'WALLET_DAILY_LIMIT_NEAR' : 'WALLET_MONTHLY_LIMIT_NEAR',
      message: `Wallet ${w.scope} spend will reach ${w.percent}% of cap after this sign ($${w.spent.toFixed(4)} of $${w.limit}).`,
      scope: w.scope,
      percent: w.percent,
      limit: w.limit,
      spent: w.spent,
    })) : undefined,
  });
});

// ============================================
// POST /v1/agents/:id/evm-keys
// Provision a new secp256k1 (EVM EOA) signing key for an agent.
// Idempotent — returns the existing key if one already exists.
// ============================================
agents.post('/:id/evm-keys', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');

  if (!isValidUUID(id)) {
    throw new ValidationError('Invalid agent ID format');
  }

  if (ctx.actorType === 'agent' && ctx.actorId !== id) {
    return c.json({ error: 'Agent can only provision their own EVM key' }, 403);
  }

  const supabase = createClient();

  const { data: agent } = await supabase
    .from('agents')
    .select('id, tenant_id, status, environment, name, parent_account_id')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .single();

  if (!agent) throw new NotFoundError('Agent', id);
  if ((agent as any).status !== 'active') throw new ValidationError('Agent is not active');

  const { getAgentEvmKey, generateAgentEvmKey } = await import('../services/x402/signer.js');

  // Idempotent — return existing key if present
  const existing = await getAgentEvmKey(supabase, id);
  if (existing) {
    return c.json({
      keyId: existing.key_id,
      ethereumAddress: existing.ethereum_address,
      publicKey: existing.public_key,
      created: false,
    });
  }

  // Generate new keypair
  const keyRecord = generateAgentEvmKey(id);

  const { error: insertErr } = await (supabase.from('agent_signing_keys') as any).insert({
    tenant_id: (agent as any).tenant_id,
    agent_id: id,
    key_id: keyRecord.key_id,
    algorithm: 'secp256k1',
    private_key_encrypted: keyRecord.private_key_encrypted,
    public_key: keyRecord.public_key,
    ethereum_address: keyRecord.ethereum_address,
    status: 'active',
  });

  if (insertErr) {
    return c.json({ error: `Failed to store key: ${insertErr.message}` }, 500);
  }

  // Mirror the key as a first-class wallet row so /dashboard/wallets can
  // render it uniformly with the rest of the wallet types. Non-fatal on
  // failure — the key works without the wallet row; it just won't appear
  // on the wallets list until backfilled.
  const env = (agent as any).environment === 'live' ? 'live' : 'test';
  const { error: walletErr } = await (supabase.from('wallets') as any).insert({
    tenant_id: (agent as any).tenant_id,
    owner_account_id: (agent as any).parent_account_id,
    managed_by_agent_id: id,
    wallet_type: 'agent_eoa',
    wallet_address: keyRecord.ethereum_address,
    currency: 'USDC',
    blockchain: env === 'live' ? 'base' : 'base-sepolia',
    environment: env,
    name: `${(agent as any).name || 'Agent'} · x402 EOA`,
    purpose: 'External x402 signing (EIP-3009)',
    status: 'active',
    balance: 0,
    verification_status: 'verified',
  });
  if (walletErr) {
    console.error(`[evm-keys] wallet row creation failed for ${id}:`, walletErr.message);
  }

  return c.json({
    keyId: keyRecord.key_id,
    ethereumAddress: keyRecord.ethereum_address,
    publicKey: keyRecord.public_key,
    created: true,
  });
});

// ============================================
// POST /v1/agents/:id/smart-wallet
// Derive (or fetch) the agent's Coinbase Smart Wallet address.
// The smart wallet is owned by the agent's existing secp256k1 EOA key
// (provisioned in Step 2). CREATE2-deterministic — no deployment required
// to know the address. ERC-4337 compatible for gas abstraction + paymaster,
// ERC-1271 compatible for contract signatures, and the foundation for
// ERC-7710 delegation flows in x402.
// ============================================
agents.post('/:id/smart-wallet', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');

  if (!isValidUUID(id)) {
    throw new ValidationError('Invalid agent ID format');
  }

  if (ctx.actorType === 'agent' && ctx.actorId !== id) {
    return c.json({ error: 'Agent can only provision their own smart wallet' }, 403);
  }

  let body: any = {};
  try { body = await c.req.json(); } catch {}
  const chainId = Number(body.chainId || 84532);

  const supabase = createClient();

  const { data: agent } = await supabase
    .from('agents')
    .select('id, tenant_id, status, parent_account_id')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .single();

  if (!agent) throw new NotFoundError('Agent', id);
  if ((agent as any).status !== 'active') throw new ValidationError('Agent is not active');

  try {
    const { getAgentSmartAccount } = await import('../services/x402/smart-account.js');
    const smartAccount = await getAgentSmartAccount(supabase, id, chainId);

    if (!smartAccount) {
      return c.json({
        error: 'Agent has no EVM key. Provision one first via POST /v1/agents/:id/evm-keys',
        code: 'NO_EVM_KEY',
      }, 400);
    }

    // Persist the smart account address on the agent_signing_keys row
    await (supabase.from('agent_signing_keys') as any)
      .update({
        smart_account_address: smartAccount.address,
        smart_account_deployed: smartAccount.deployed,
        smart_account_chain_id: chainId,
      })
      .eq('agent_id', id)
      .eq('algorithm', 'secp256k1')
      .eq('status', 'active');

    // Also register in the wallets table so the smart wallet is visible
    // alongside Circle, Tempo, BYOW wallets in the unified wallet registry.
    const network = chainId === 84532 ? 'base-sepolia' : 'base-mainnet';
    const walletData = {
      tenant_id: ctx.tenantId,
      owner_account_id: (agent as any).parent_account_id || ctx.tenantId,
      managed_by_agent_id: id,
      wallet_type: 'smart_wallet',
      wallet_address: smartAccount.address,
      network,
      blockchain: 'base',
      currency: 'USDC',
      balance: 0,
      status: 'active',
      purpose: 'default',
      name: `Smart Wallet (${network})`,
      provider: 'coinbase',
      custody_type: 'custodial',
      provider_metadata: {
        owner_eoa: smartAccount.ownerAddress,
        factory: smartAccount.factoryAddress,
        deployed: smartAccount.deployed,
        chain_id: chainId,
      },
    };
    // Check-then-insert (upsert requires a unique constraint we don't have)
    const { data: existingSwRow } = await supabase.from('wallets')
      .select('id').eq('managed_by_agent_id', id).eq('wallet_type', 'smart_wallet').limit(1);
    if (existingSwRow && existingSwRow.length > 0) {
      await supabase.from('wallets').update(walletData as any).eq('id', existingSwRow[0].id).then(() => {}, () => {});
    } else {
      await supabase.from('wallets').insert(walletData as any).then(() => {}, () => {});
    }

    return c.json({
      success: true,
      smartAccountAddress: smartAccount.address,
      ownerAddress: smartAccount.ownerAddress,
      chainId,
      deployed: smartAccount.deployed,
      factoryAddress: smartAccount.factoryAddress,
      explorer: chainId === 84532
        ? `https://sepolia.basescan.org/address/${smartAccount.address}`
        : `https://basescan.org/address/${smartAccount.address}`,
      note: smartAccount.deployed
        ? 'Smart account is deployed on-chain.'
        : 'Smart account address is CREATE2-deterministic; will deploy on first on-chain interaction.',
    });
  } catch (e: any) {
    return c.json({
      error: `Smart wallet derivation failed: ${e.message}`,
      code: 'SMART_WALLET_FAILED',
    }, 500);
  }
});

// ============================================
// POST /v1/agents/:id/smart-wallet-sign
// Sign a message or EIP-712 typed data via the agent's smart wallet.
// Produces an ERC-1271 compatible signature that verifiers check via
// IERC1271.isValidSignature() on the smart account contract.
// ============================================
agents.post('/:id/smart-wallet-sign', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');

  if (!isValidUUID(id)) {
    throw new ValidationError('Invalid agent ID format');
  }

  if (ctx.actorType === 'agent' && ctx.actorId !== id) {
    return c.json({ error: 'Agent can only sign with their own smart wallet' }, 403);
  }

  let body: any;
  try { body = await c.req.json(); } catch {
    throw new ValidationError('Invalid JSON body');
  }

  const { message, typedData, chainId = 84532 } = body;

  if (!message && !typedData) {
    throw new ValidationError('Either message or typedData is required');
  }

  const supabase = createClient();

  const { data: agent } = await supabase
    .from('agents')
    .select('id, tenant_id, status')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .single();

  if (!agent) throw new NotFoundError('Agent', id);
  if ((agent as any).status !== 'active') throw new ValidationError('Agent is not active');

  const { data: keyRow } = await (supabase.from('agent_signing_keys') as any)
    .select('private_key_encrypted, ethereum_address')
    .eq('agent_id', id)
    .eq('algorithm', 'secp256k1')
    .eq('status', 'active')
    .maybeSingle();

  if (!keyRow) {
    return c.json({ error: 'Agent has no EVM key', code: 'NO_EVM_KEY' }, 400);
  }

  try {
    const { signMessageViaSmartAccount, signTypedDataViaSmartAccount } =
      await import('../services/x402/smart-account.js');
    const { deserializeAndDecrypt } = await import('../services/credential-vault/index.js');

    const decrypted = deserializeAndDecrypt(keyRow.private_key_encrypted);
    const privateKey = decrypted.privateKey as `0x${string}`;

    const result = message
      ? await signMessageViaSmartAccount(privateKey, message, Number(chainId))
      : await signTypedDataViaSmartAccount(privateKey, typedData, Number(chainId));

    return c.json({
      success: true,
      signature: result.signature,
      smartAccountAddress: result.smartAccountAddress,
      ownerAddress: result.ownerAddress,
      chainId: Number(chainId),
      note: 'This is an ERC-1271 contract signature. Verify via IERC1271.isValidSignature() on the smart account contract, NOT via ecrecover.',
    });
  } catch (e: any) {
    return c.json({
      error: `Smart wallet signing failed: ${e.message}`,
      code: 'SMART_SIGN_FAILED',
    }, 500);
  }
});

// ============================================
// POST /v1/agents/:id/smart-wallet/send-usdc
// Send USDC from the agent's smart wallet via an ERC-4337 UserOperation.
// The bundler handles wrapping, gas, and on-chain submission. Smart wallet
// is deployed atomically with the first userOp.
// ============================================
agents.post('/:id/smart-wallet/send-usdc', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');

  if (!isValidUUID(id)) {
    throw new ValidationError('Invalid agent ID format');
  }

  const supabase = createClient();

  // Epic 82 — sending from a sibling's smart wallet is the canonical
  // treasury action. Default agent scope blocks it; an explicit
  // `treasury` grant (always one_shot, never standing) is the only
  // path. Same-agent (self-spend) keeps its existing semantics.
  if (ctx.actorType === 'agent' && ctx.actorId !== id) {
    const denied = await guardSiblingScope(c, supabase, id, 'treasury', `POST /v1/agents/${id}/smart-wallet/send-usdc`);
    if (denied) return denied;
  }

  let body: any;
  try { body = await c.req.json(); } catch {
    throw new ValidationError('Invalid JSON body');
  }

  const { to, value, chainId = 84532 } = body;
  if (!to || !value) {
    throw new ValidationError('Missing required fields: to, value (USDC units as decimal string)');
  }

  // Use cached agent row from auth middleware if available (avoids re-query)
  const cachedAgent = ctx.actorType === 'agent' && ctx.actorId === id ? (c as any).get('agentRow') : null;
  if (!cachedAgent) {
    const { data: agent } = await supabase
      .from('agents')
      .select('id, tenant_id, status')
      .eq('id', id)
      .eq('tenant_id', ctx.tenantId)
      .single();
    if (!agent) throw new NotFoundError('Agent', id);
    if ((agent as any).status !== 'active') throw new ValidationError('Agent is not active');
  }

  // Check wallet freeze status — block UserOp execution if frozen
  const { data: frozenWalletRows } = await supabase
    .from('wallets')
    .select('status')
    .eq('managed_by_agent_id', id)
    .eq('status', 'frozen')
    .limit(1);
  if (frozenWalletRows && frozenWalletRows.length > 0) {
    return c.json({ error: 'Agent wallet is frozen — UserOp execution blocked', code: 'WALLET_FROZEN' }, 403);
  }

  const { data: keyRow } = await (supabase.from('agent_signing_keys') as any)
    .select('private_key_encrypted, smart_account_address')
    .eq('agent_id', id)
    .eq('algorithm', 'secp256k1')
    .eq('status', 'active')
    .maybeSingle();

  if (!keyRow) return c.json({ error: 'Agent has no EVM key', code: 'NO_EVM_KEY' }, 400);

  try {
    const { sendUsdcViaSmartAccount } = await import('../services/x402/smart-account.js');
    const { deserializeAndDecrypt } = await import('../services/credential-vault/index.js');

    const decrypted = deserializeAndDecrypt(keyRow.private_key_encrypted);
    const privateKey = decrypted.privateKey as `0x${string}`;

    const result = await sendUsdcViaSmartAccount({
      ownerPrivateKey: privateKey,
      to: to as `0x${string}`,
      valueUnits: BigInt(value),
      chainId: Number(chainId),
    });

    // Sync smart wallet balance in wallets table after UserOp (fire-and-forget)
    if (result.smartAccountAddress) {
      import('../services/x402/smart-account.js').then(({ syncSmartWalletBalance }) => {
        syncSmartWalletBalance(supabase, result.smartAccountAddress, Number(chainId))
          .catch(() => {});
      }).catch(() => {});
    }

    return c.json({
      success: true,
      userOpHash: result.userOpHash,
      txHash: result.txHash || null,
      smartAccountAddress: result.smartAccountAddress,
      status: result.status,
      blockNumber: result.blockNumber ? String(result.blockNumber) : null,
      explorer: result.txHash
        ? `https://sepolia.basescan.org/tx/${result.txHash}`
        : null,
    });
  } catch (e: any) {
    return c.json({
      error: `UserOp submission failed: ${e.message}`,
      code: 'USEROP_FAILED',
    }, 500);
  }
});

// ============================================
// GET /v1/agents/:id/smart-wallet/balance
// Read USDC balance of the agent's smart wallet (ERC-20 balanceOf call,
// works even if the smart account is not yet deployed).
// ============================================
agents.get('/:id/smart-wallet/balance', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  const chainId = Number(c.req.query('chainId') || '84532');

  if (!isValidUUID(id)) throw new ValidationError('Invalid agent ID format');

  const supabase = createClient();
  const { data: keyRow } = await (supabase.from('agent_signing_keys') as any)
    .select('smart_account_address')
    .eq('agent_id', id)
    .eq('algorithm', 'secp256k1')
    .eq('status', 'active')
    .maybeSingle();

  if (!keyRow?.smart_account_address) {
    return c.json({ error: 'Agent has no smart wallet provisioned', code: 'NO_SMART_WALLET' }, 400);
  }

  try {
    const { getSmartAccountUsdcBalance } = await import('../services/x402/smart-account.js');
    const balanceUnits = await getSmartAccountUsdcBalance(keyRow.smart_account_address, chainId);
    return c.json({
      smartAccountAddress: keyRow.smart_account_address,
      chainId,
      balanceUnits: String(balanceUnits),
      balanceUsdc: (Number(balanceUnits) / 1_000_000).toFixed(6),
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ============================================
// POST /v1/agents/:id/wallet/refill-faucet
// Request a Circle faucet drip to top up the agent's Circle custodial wallet
// with testnet USDC + native gas. Idempotency: Circle's faucet has its own
// per-address rate limit (~1 drip per 2 hours), so repeated calls within
// that window return an error from Circle.
// ============================================
agents.post('/:id/wallet/refill-faucet', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');

  if (!isValidUUID(id)) {
    throw new ValidationError('Invalid agent ID format');
  }

  if (ctx.actorType === 'agent' && ctx.actorId !== id) {
    return c.json({ error: 'Agent can only refill their own wallet' }, 403);
  }

  const supabase = createClient();

  const { data: agent } = await supabase
    .from('agents')
    .select('id, tenant_id, status')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .single();

  if (!agent) throw new NotFoundError('Agent', id);
  if ((agent as any).status !== 'active') throw new ValidationError('Agent is not active');

  // Find the agent's Circle custodial wallet
  const { data: circleWallet } = await (supabase.from('wallets') as any)
    .select('id, wallet_address, blockchain')
    .eq('managed_by_agent_id', id)
    .eq('wallet_type', 'circle_custodial')
    .eq('status', 'active')
    .maybeSingle();

  if (!circleWallet || !circleWallet.wallet_address) {
    return c.json({
      error: 'Agent has no Circle custodial wallet',
      code: 'NO_CIRCLE_WALLET',
    }, 400);
  }

  try {
    const { getCircleClient } = await import('../services/circle/client.js');
    const circle = getCircleClient();

    // Map chain to Circle faucet blockchain identifier
    const chainMap: Record<string, string> = {
      base: 'BASE-SEPOLIA',
      eth: 'ETH-SEPOLIA',
      polygon: 'MATIC-AMOY',
    };
    const faucetChain = chainMap[circleWallet.blockchain] || 'BASE-SEPOLIA';

    await circle.requestFaucetDrip(circleWallet.wallet_address, faucetChain as any, {
      usdc: true,
      native: true,
    });

    return c.json({
      success: true,
      walletAddress: circleWallet.wallet_address,
      blockchain: faucetChain,
      note: 'Faucet drip requested. Typically ~20 USDC + gas arrives within 30-60s. Circle rate-limits ~1 drip per 2 hours per address.',
    });
  } catch (e: any) {
    return c.json({
      error: `Faucet request failed: ${e.message}`,
      code: 'FAUCET_FAILED',
    }, 500);
  }
});

// ============================================
// POST /v1/agents/:id/fund-eoa
// Transfer USDC from the tenant's Circle master wallet to the agent's
// managed EVM EOA. Sources from Circle Payouts API (blockchain destination),
// not from a per-agent Circle custodial wallet — one funding surface, scaled
// by KYA limits per agent.
//
// Body: { amount: string }  (USDC in whole units, e.g. "0.50")
//
// Returns: { success, circlePayoutId, destinationAddress, amount, transferRowId,
//            estimatedSettlementSeconds, note }
// ============================================
agents.post('/:id/fund-eoa', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');

  if (!isValidUUID(id)) {
    throw new ValidationError('Invalid agent ID format');
  }

  const supabase = createClient();

  // Epic 82 — funding a sibling's EOA pulls money from the tenant
  // treasury INTO another agent's wallet. That's the same blast
  // radius as treasury moves; gate it accordingly. Self-fund keeps
  // its existing pre-Epic-82 behavior (any agent can top up itself).
  if (ctx.actorType === 'agent' && ctx.actorId !== id) {
    const denied = await guardSiblingScope(c, supabase, id, 'treasury', `POST /v1/agents/${id}/fund-eoa`);
    if (denied) return denied;
  }

  let body: any = {};
  try { body = await c.req.json(); } catch {}
  const amountStr = body.amount ? String(body.amount) : '1';
  const amountNum = parseFloat(amountStr);
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    throw new ValidationError('amount must be a positive number');
  }

  // Verify agent exists, is active, and belongs to the caller's tenant
  const { data: agent } = await supabase
    .from('agents')
    .select('id, tenant_id, status, environment')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .single();

  if (!agent) throw new NotFoundError('Agent', id);
  if ((agent as any).status !== 'active') throw new ValidationError('Agent is not active');
  const agentEnvironment: 'test' | 'live' = (agent as any).environment === 'live' ? 'live' : 'test';

  // KYA limit check — fund-eoa is an agent-attributed spend. Apply the same
  // per-transaction cap that gates x402 signing so a runaway caller can't
  // quietly move $10k into one agent's EOA.
  const limitService = createLimitService(supabase, getEnv(ctx) as 'test' | 'live');
  const limitCheck = await limitService.checkTransactionLimit(id, amountNum);
  if (!limitCheck.allowed) {
    throw new LimitExceededError(
      limitCheck.limitType || 'transaction',
      limitCheck.limit ?? 0,
      limitCheck.requested ?? amountNum,
      limitCheck.used,
    );
  }

  // Get the agent's EVM key (destination)
  const { getAgentEvmKey } = await import('../services/x402/signer.js');
  const keyRecord = await getAgentEvmKey(supabase, id);
  if (!keyRecord) {
    return c.json({
      error: 'Agent has no EVM key. Provision one first via POST /v1/agents/:id/evm-keys',
      code: 'NO_EVM_KEY',
    }, 400);
  }

  // Wallet freeze check — don't fund a frozen agent.
  const { data: frozenWallets } = await supabase
    .from('wallets')
    .select('status')
    .eq('managed_by_agent_id', id)
    .eq('status', 'frozen')
    .limit(1);
  if (frozenWallets && frozenWallets.length > 0) {
    return c.json({ error: 'Agent wallet is frozen — funding blocked', code: 'WALLET_FROZEN' }, 403);
  }

  // Pick chain based on agent environment. Circle's master wallet config
  // dictates whether 'BASE' maps to mainnet (live API key) or sepolia
  // (sandbox key); we mirror that convention via the agent's env flag so
  // a test agent's EOA on Sepolia gets funded from sandbox Circle, and a
  // live agent's EOA on Base mainnet gets funded from production Circle.
  const chain = agentEnvironment === 'live' ? 'BASE' : 'BASE-SEPOLIA';

  try {
    const { getCirclePayoutsClient } = await import('../services/circle/payouts.js');
    const circle = getCirclePayoutsClient();

    // Preflight: check master wallet has sufficient USDC. Fail fast with a
    // useful error instead of letting Circle reject opaquely.
    const masterBalances = await circle.getMasterWalletBalance();
    const usdcMaster = masterBalances.find(b => b.currency === 'USD' || b.currency === 'USDC');
    const masterUsdc = usdcMaster ? parseFloat(usdcMaster.amount) : 0;
    if (masterUsdc < amountNum) {
      return c.json({
        error: `Tenant master wallet underfunded. Master has $${masterUsdc.toFixed(4)} USDC, requested $${amountStr}. Top up via Circle dashboard or increase deposit.`,
        code: 'MASTER_UNDERFUNDED',
        available: masterUsdc,
        requested: amountNum,
      }, 400);
    }

    // Execute: Circle Payouts transfers from master wallet to any on-chain
    // address. Returns a payout record with pending status; settles in ~60s.
    const payout = await circle.createUsdcTransfer({
      amount: amountStr,
      destinationAddress: keyRecord.ethereum_address,
      chain: chain as any,
      metadata: {
        tenant_id: ctx.tenantId,
        agent_id: id,
        source: 'sly_fund_eoa',
        environment: agentEnvironment,
      },
    });

    // Record in transfers ledger as an internal deposit. Status tracks the
    // Circle payout lifecycle — a reconciler updates tx_hash + status when
    // on-chain settlement confirms. For MVP we leave as 'pending' and rely
    // on polling / webhook (phase 2).
    const { data: transferRow } = await (supabase.from('transfers') as any).insert({
      tenant_id: ctx.tenantId,
      environment: getEnv(ctx),
      type: 'deposit',
      status: 'pending',
      from_account_id: null,
      to_account_id: null,
      initiated_by_type: ctx.actorType,
      initiated_by_id: id,
      initiated_by_name: ctx.actorName || null,
      amount: amountNum,
      currency: 'USDC',
      description: `Fund agent EOA from Circle master`,
      settlement_network: chain === 'BASE' ? 'base' : 'base-sepolia',
      protocol_metadata: {
        protocol: 'circle_payouts',
        direction: 'internal_deposit',
        to_address: keyRecord.ethereum_address,
        chain,
        circle_payout_id: payout.id,
        circle_payout_status: (payout as any).state || (payout as any).status,
        source: 'tenant_master',
      },
    }).select('id').single();

    // Record usage for KYA accounting — this counts against the agent's
    // daily/monthly spend buckets.
    void limitService.recordUsage(id, amountNum).catch((e) => {
      console.error('[fund-eoa] recordUsage failed', e);
    });

    return c.json({
      success: true,
      circlePayoutId: payout.id,
      state: (payout as any).state || (payout as any).status,
      destinationAddress: keyRecord.ethereum_address,
      chain,
      amount: amountStr,
      currency: 'USDC',
      transferRowId: transferRow?.id || null,
      estimatedSettlementSeconds: 90,
      note: `Circle payout initiated — expect on-chain settlement to ${keyRecord.ethereum_address} on ${chain} in ~60-120s.`,
    });
  } catch (e: any) {
    console.error('[fund-eoa] Circle payout failed', e);
    return c.json({
      error: `Circle payout failed: ${e.message}`,
      code: 'CIRCLE_PAYOUT_FAILED',
    }, 500);
  }
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

// =============================================================================
// Feedback Endpoints (Epic 69 — Result Acceptance & Quality Feedback)
// =============================================================================

/**
 * GET /v1/agents/:id/feedback/summary — Aggregated feedback stats
 */
agents.get('/:id/feedback/summary', async (c) => {
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
    .eq('environment', getEnv(ctx))
    .single();

  if (!agent) throw new NotFoundError('Agent');

  const skillId = c.req.query('skill_id');

  let query = supabase
    .from('a2a_task_feedback')
    .select('action, satisfaction, score')
    .eq('tenant_id', ctx.tenantId)
    .eq('provider_agent_id', id);

  if (skillId) query = query.eq('skill_id', skillId);

  const { data: rows, error } = await query;
  if (error) throw new Error(error.message);

  const feedback = rows || [];
  const total = feedback.length;
  const rejections = feedback.filter(r => r.action === 'reject').length;
  const scores = feedback.filter(r => r.score !== null).map(r => r.score as number);
  const avgScore = scores.length > 0 ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null;

  const distribution: Record<string, number> = { excellent: 0, acceptable: 0, partial: 0, unacceptable: 0 };
  for (const row of feedback) {
    if (row.satisfaction && distribution[row.satisfaction] !== undefined) {
      distribution[row.satisfaction]++;
    }
  }

  return c.json({
    data: {
      agent_id: id,
      skill_id: skillId || null,
      avg_score: avgScore,
      total_reviews: total,
      satisfaction_distribution: distribution,
      rejection_rate: total > 0 ? Math.round((rejections / total) * 1000) / 1000 : 0,
    },
  });
});

/**
 * GET /v1/agents/:id/feedback — Paginated feedback list
 */
agents.get('/:id/feedback', async (c) => {
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
    .eq('environment', getEnv(ctx))
    .single();

  if (!agent) throw new NotFoundError('Agent');

  const queryParams = c.req.query();
  const { page, limit } = getPaginationParams(queryParams);
  const offset = (page - 1) * limit;

  let query = supabase
    .from('a2a_task_feedback')
    .select('*', { count: 'exact' })
    .eq('tenant_id', ctx.tenantId)
    .eq('provider_agent_id', id)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  const skillId = c.req.query('skill_id');
  if (skillId) query = query.eq('skill_id', skillId);

  const satisfaction = c.req.query('satisfaction');
  if (satisfaction) query = query.eq('satisfaction', satisfaction);

  const dateFrom = c.req.query('date_from');
  if (dateFrom) query = query.gte('created_at', dateFrom);

  const dateTo = c.req.query('date_to');
  if (dateTo) query = query.lte('created_at', dateTo);

  const { data: rows, count, error } = await query;
  if (error) throw new Error(error.message);

  const total = count || 0;
  return c.json(paginationResponse(rows || [], total, { page, limit }));
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
    .eq('environment', getEnv(ctx))
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

  // Verify agent belongs to tenant and get parent account + KYA tier
  const { data: agent } = await supabase
    .from('agents')
    .select('id, parent_account_id, kya_tier, skill_manifest, accounts!agents_parent_account_id_fkey (id, verification_tier)')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();

  if (!agent) throw new NotFoundError('Agent');

  // Story 73.15: Build a skill_manifest from the skill data for DSD purposes
  // If the agent is T0 and this is the first skill with valid manifest data, auto-upgrade
  const skillManifestFromBody = body.skill_manifest || body.metadata?.skill_manifest;
  if (skillManifestFromBody && (agent.kya_tier || 0) === 0) {
    const manifest = skillManifestFromBody;
    // Validate it has the required DSD fields
    if (manifest.protocols?.length > 0 && manifest.action_types?.length > 0 && manifest.domain && manifest.description) {
      const parentTier = (agent as any).accounts?.verification_tier ?? null;
      const { limits: effectiveLimits, capped } = await computeEffectiveLimits(supabase, 1, parentTier);

      await supabase
        .from('agents')
        .update({
          skill_manifest: manifest,
          kya_tier: 1,
          kya_status: 'verified',
          kya_verified_at: new Date().toISOString(),
          limit_per_transaction: effectiveLimits.per_transaction,
          limit_daily: effectiveLimits.daily,
          limit_monthly: effectiveLimits.monthly,
          effective_limit_per_tx: effectiveLimits.per_transaction,
          effective_limit_daily: effectiveLimits.daily,
          effective_limit_monthly: effectiveLimits.monthly,
          effective_limits_capped: capped,
        })
        .eq('id', id)
        .eq('environment', getEnv(ctx));
    }
  }

  // Auto-create x402 endpoint for paid skills
  let x402EndpointId: string | null = null;
  const basePrice = Number(parsed.data.base_price || 0);
  if (basePrice > 0 && agent.parent_account_id) {
    const endpointPath = `/v1/agents/${id}/skills/${parsed.data.skill_id}`;
    // Check if endpoint already exists for this path
    const { data: existing } = await supabase
      .from('x402_endpoints')
      .select('id')
      .eq('tenant_id', ctx.tenantId)
      .eq('path', endpointPath)
      .eq('method', 'POST')
      .maybeSingle();

    if (existing) {
      // Update price on existing endpoint
      await supabase
        .from('x402_endpoints')
        .update({ base_price: basePrice, status: 'active' })
        .eq('id', existing.id);
      x402EndpointId = existing.id;
    } else {
      // Create new x402 endpoint
      const { data: endpoint } = await supabase
        .from('x402_endpoints')
        .insert({
          tenant_id: ctx.tenantId,
          environment: getEnv(ctx),
          account_id: agent.parent_account_id,
          name: parsed.data.name || parsed.data.skill_id,
          description: parsed.data.description || `Paid skill: ${parsed.data.skill_id}`,
          path: endpointPath,
          method: 'POST',
          base_price: basePrice,
          currency: parsed.data.currency || 'USDC',
          status: 'active',
          payment_address: `internal://payos/${ctx.tenantId}/${agent.parent_account_id}`,
        })
        .select('id')
        .single();
      if (endpoint) x402EndpointId = endpoint.id;
    }
  }

  const { data: skill, error } = await supabase
    .from('agent_skills')
    .upsert({
      tenant_id: ctx.tenantId,
      agent_id: id,
      ...parsed.data,
      ...(x402EndpointId ? { x402_endpoint_id: x402EndpointId } : {}),
    } as any, { onConflict: 'tenant_id,agent_id,skill_id' })
    .select('*')
    .single();

  if (error) throw new Error(error.message);

  logAudit(supabase, {
    tenantId: ctx.tenantId,
    entityType: 'agent_skill',
    entityId: id,
    action: 'agent.skill.created',
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    actorName: ctx.actorName,
    metadata: { agentId: id, skillId: parsed.data.skill_id },
  });
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

  // Sync x402 endpoint price if linked
  if (skill.x402_endpoint_id && updates.base_price !== undefined) {
    const newPrice = Number(updates.base_price);
    if (newPrice > 0) {
      await supabase.from('x402_endpoints').update({ base_price: newPrice }).eq('id', skill.x402_endpoint_id);
    } else {
      // Price set to 0 — deactivate the endpoint
      await supabase.from('x402_endpoints').update({ status: 'disabled' }).eq('id', skill.x402_endpoint_id);
    }
  }

  logAudit(supabase, {
    tenantId: ctx.tenantId,
    entityType: 'agent_skill',
    entityId: id,
    action: 'agent.skill.updated',
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    actorName: ctx.actorName,
    metadata: { agentId: id, skillId },
  });
  return c.json(skill);
});

/**
 * GET /v1/agents/:id/ratings — Rating history for an agent.
 * Returns all a2a_task_feedback entries where this agent was the provider,
 * ordered by time. Used by the dashboard and the sim to show reputation trends.
 */
agents.get('/:id/ratings', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  if (!isValidUUID(id)) throw new ValidationError('Invalid agent ID');
  const limit = Math.min(parseInt(c.req.query('limit') || '100', 10), 500);

  const supabase = createClient();
  const { data, error } = await supabase
    .from('a2a_task_feedback')
    .select('id, task_id, score, satisfaction, action, comment, direction, revealed, created_at, skill_id, caller_agent_id, provider_agent_id')
    .eq('provider_agent_id', id)
    .eq('tenant_id', ctx.tenantId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new ValidationError(`Failed to fetch ratings: ${error.message}`);

  const rawRatings = (data || []) as any[];

  // Resolve rater names in a single lookup
  const raterIds = Array.from(new Set(rawRatings.map(r => r.caller_agent_id).filter(Boolean)));
  const raterById: Record<string, { id: string; name: string }> = {};
  if (raterIds.length > 0) {
    const { data: raters } = await supabase
      .from('agents')
      .select('id, name')
      .in('id', raterIds) as any;
    for (const r of (raters as any[]) ?? []) raterById[r.id] = r;
  }

  // Fetch attestation metadata for each task in one call
  const taskIds = Array.from(new Set(rawRatings.map(r => r.task_id).filter(Boolean)));
  const attestationByTask: Record<string, any> = {};
  if (taskIds.length > 0) {
    const { data: tasks } = await supabase
      .from('a2a_tasks')
      .select('id, metadata')
      .in('id', taskIds) as any;
    for (const t of (tasks as any[]) ?? []) {
      const att = (t.metadata as any)?.attestation;
      if (att) attestationByTask[t.id] = att;
    }
  }

  const ratings = rawRatings.map(r => ({
    ...r,
    rater: r.caller_agent_id ? (raterById[r.caller_agent_id] ?? { id: r.caller_agent_id, name: 'Unknown' }) : null,
    attestation: r.task_id ? (attestationByTask[r.task_id] ?? null) : null,
  }));
  const scores = ratings.filter((r: any) => typeof r.score === 'number').map((r: any) => r.score);
  const avgScore = scores.length > 0 ? Math.round(scores.reduce((a: number, b: number) => a + b, 0) / scores.length) : null;
  const acceptCount = ratings.filter((r: any) => r.action === 'accept').length;
  const rejectCount = ratings.filter((r: any) => r.action === 'reject').length;

  return c.json({
    data: ratings,
    aggregate: {
      total: ratings.length,
      avgScore,
      acceptCount,
      rejectCount,
      acceptRate: ratings.length > 0 ? Math.round((acceptCount / ratings.length) * 100) : null,
    },
  });
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

  // Get linked x402 endpoint before deleting
  const { data: existingSkill } = await supabase
    .from('agent_skills')
    .select('x402_endpoint_id')
    .eq('agent_id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('skill_id', skillId)
    .maybeSingle();

  const { error } = await supabase
    .from('agent_skills')
    .delete()
    .eq('agent_id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('skill_id', skillId);

  if (error) throw new Error(error.message);

  // Clean up linked x402 endpoint
  if (existingSkill?.x402_endpoint_id) {
    await supabase.from('x402_endpoints').delete().eq('id', existingSkill.x402_endpoint_id);
  }

  logAudit(supabase, {
    tenantId: ctx.tenantId,
    entityType: 'agent_skill',
    entityId: id,
    action: 'agent.skill.deleted',
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    actorName: ctx.actorName,
    metadata: { agentId: id, skillId },
  });
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
    .eq('environment', getEnv(ctx))
    .single();

  if (!agent) throw new NotFoundError('Agent');

  const { data, error } = await supabase
    .from('agents')
    .update({
      endpoint_url: parsed.data.endpoint_url,
      endpoint_type: parsed.data.endpoint_type,
      endpoint_secret: parsed.data.endpoint_secret || null,
      endpoint_enabled: true,
      processing_mode: 'managed',
    })
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
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
    .eq('environment', getEnv(ctx))
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
    .eq('environment', getEnv(ctx))
    .single();

  if (!agent) throw new NotFoundError('Agent');

  const { error } = await supabase
    .from('agents')
    .update({
      endpoint_url: null,
      endpoint_type: 'none',
      endpoint_secret: null,
      endpoint_enabled: false,
      processing_mode: 'manual',
    })
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx));

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

// ============================================
// GET /v1/agents/:id/wallet - Get agent wallet details
// ============================================
agents.get('/:id/wallet', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  const supabase = createClient();

  if (!isValidUUID(id)) {
    throw new ValidationError('Invalid agent ID format');
  }

  // Verify agent exists
  const { data: agent, error: agentError } = await supabase
    .from('agents')
    .select('id, name')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();

  if (agentError || !agent) {
    throw new NotFoundError('Agent', id);
  }

  // Fetch all wallets managed by this agent. Returns the complete set in
  // `all_wallets` so the dashboard tab can render every wallet (Circle,
  // agent_eoa, etc.) uniformly. The `primary` field excludes agent_eoa
  // because historical callers treated `primary` as the custodial Circle
  // wallet; EOAs have their own dedicated surface.
  const { data: wallets } = await supabase
    .from('wallets')
    .select('*')
    .eq('managed_by_agent_id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .eq('status', 'active')
    .order('created_at', { ascending: false });

  if (!wallets || wallets.length === 0) {
    return c.json(null);
  }

  // Primary = Tempo > Circle > internal, excluding agent_eoa.
  const primaryCandidates = (wallets as any[]).filter(w => w.wallet_type !== 'agent_eoa');
  const sorted = [...primaryCandidates].sort((a, b) => {
    const priority = (w: any) => {
      if (w.provider === 'tempo') return 0;
      if (w.provider === 'circle') return 1;
      return 2;
    };
    return priority(a) - priority(b);
  });

  // If the agent has ONLY an EOA (no Circle/Tempo), fall back to returning
  // null so the frontend's "No Circle wallet" banner still triggers — the
  // EOA comes through all_wallets regardless.
  if (sorted.length === 0) {
    return c.json({
      id: null,
      all_wallets: (wallets as any[]).map((w: any) => ({
        id: w.id,
        name: w.name,
        balance: parseFloat(w.balance),
        currency: w.currency,
        network: w.network,
        status: w.status,
        address: w.wallet_address,
        wallet_address: w.wallet_address,
        wallet_type: w.wallet_type,
        blockchain: w.blockchain,
        environment: w.environment,
        provider: w.provider,
        purpose: w.purpose,
      })),
    });
  }

  const primary = sorted[0];
  return c.json({
    id: primary.id,
    name: primary.name,
    balance: parseFloat(primary.balance),
    currency: primary.currency,
    network: primary.network,
    status: primary.status,
    address: primary.wallet_address,
    wallet_address: primary.wallet_address,
    wallet_type: primary.wallet_type,
    blockchain: primary.blockchain,
    provider: primary.provider,
    token_contract: primary.token_contract,
    spending_policy: primary.spending_policy,
    all_wallets: (wallets as any[]).map((w: any) => ({
      id: w.id,
      name: w.name,
      balance: parseFloat(w.balance),
      currency: w.currency,
      network: w.network,
      status: w.status,
      address: w.wallet_address,
      wallet_address: w.wallet_address,
      wallet_type: w.wallet_type,
      blockchain: w.blockchain,
      environment: w.environment,
      provider: w.provider,
      purpose: w.purpose,
    })),
  });
});

// ============================================
// GET /v1/agents/:id/wallet/exposures - Counterparty exposures
// ============================================
agents.get('/:id/wallet/exposures', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  const supabase = createClient();

  if (!isValidUUID(id)) {
    throw new ValidationError('Invalid agent ID format');
  }

  // Aggregate exposure data from completed MPP transfers for this agent
  const { data: transfers } = await supabase
    .from('transfers')
    .select('to_account_id, amount, currency, created_at')
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .eq('type', 'mpp')
    .eq('status', 'completed')
    .or(`from_account_id.eq.${id},protocol_metadata->>agent_id.eq.${id}`)
    .order('created_at', { ascending: false });

  if (!transfers || transfers.length === 0) {
    return c.json({ data: [], exposures: [] });
  }

  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const exposureMap = new Map<string, any>();

  for (const t of transfers) {
    const cp = t.to_account_id || 'unknown';
    const existing = exposureMap.get(cp) || {
      counterparty_id: cp,
      volume_24h: 0, volume_7d: 0, volume_30d: 0,
      total_volume: 0, active_contracts: 0, active_escrows: 0,
    };
    const amt = Number(t.amount) || 0;
    const age = now - new Date(t.created_at ?? 0).getTime();
    if (age <= day) existing.volume_24h += amt;
    if (age <= 7 * day) existing.volume_7d += amt;
    if (age <= 30 * day) existing.volume_30d += amt;
    existing.total_volume += amt;
    exposureMap.set(cp, existing);
  }

  const exposures = Array.from(exposureMap.values());
  return c.json({ data: exposures, exposures });
});

// ============================================
// GET /v1/agents/:id/wallet/policy/evaluations - Policy evaluation log
// ============================================
agents.get('/:id/wallet/policy/evaluations', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');

  if (!isValidUUID(id)) {
    throw new ValidationError('Invalid agent ID format');
  }

  // Return empty until policy evaluation logging is implemented
  return c.json({ data: [], evaluations: [], total: 0, pagination: { page: 1, limit: 20, total: 0 } });
});

// ============================================
// POST /v1/agents/:id/wallet - Link wallet address
// Epic 61.1: Agent BYOW (Bring Your Own Wallet)
// ============================================
agents.post('/:id/wallet', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  const supabase = createClient();

  if (!isValidUUID(id)) {
    throw new ValidationError('Invalid agent ID format');
  }

  let body;
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError('Invalid JSON body');
  }

  const walletAddress = body.wallet_address as string;
  if (!walletAddress || !walletAddress.startsWith('0x') || walletAddress.length !== 42) {
    throw new ValidationError('wallet_address must be a valid Ethereum address (0x... 42 chars)');
  }

  // Verify agent exists and belongs to tenant
  const { data: agent, error: agentError } = await supabase
    .from('agents')
    .select('id, name, wallet_address, wallet_verification_status')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();

  if (agentError || !agent) {
    throw new NotFoundError('Agent', id);
  }

  // Generate verification challenge
  const { getWalletVerificationService } = await import('../services/wallet/index.js');
  const verificationService = getWalletVerificationService();
  const challenge = verificationService.generateChallenge(walletAddress);

  // Store pending wallet address on agent
  await supabase
    .from('agents')
    .update({
      wallet_address: walletAddress.toLowerCase(),
      wallet_verification_status: 'pending',
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx));

  return c.json({
    data: {
      agent_id: id,
      wallet_address: walletAddress.toLowerCase(),
      verification_status: 'pending',
      challenge,
    },
  });
});

// ============================================
// POST /v1/agents/:id/wallet/verify - Verify wallet ownership
// Epic 61.2: Verify via EIP-191 signature
// ============================================
agents.post('/:id/wallet/verify', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  const supabase = createClient();

  if (!isValidUUID(id)) {
    throw new ValidationError('Invalid agent ID format');
  }

  let body;
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError('Invalid JSON body');
  }

  const signature = body.signature as string;
  const message = body.message as string;
  if (!signature || !message) {
    throw new ValidationError('signature and message are required');
  }

  // Fetch agent with pending wallet
  const { data: agent, error: agentError } = await supabase
    .from('agents')
    .select('id, name, wallet_address, wallet_verification_status, tenant_id')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();

  if (agentError || !agent) {
    throw new NotFoundError('Agent', id);
  }

  if (!agent.wallet_address) {
    throw new ValidationError('No wallet address linked to this agent. Call POST /v1/agents/:id/wallet first.');
  }

  // Verify signature
  const { getWalletVerificationService } = await import('../services/wallet/index.js');
  const verificationService = getWalletVerificationService();
  const result = await verificationService.verifyPersonalSign(
    agent.wallet_address,
    signature,
    message,
  );

  if (!result.verified) {
    return c.json({
      error: 'Wallet verification failed',
      details: result.error,
      code: 'VERIFICATION_FAILED',
    }, 400);
  }

  const now = new Date().toISOString();

  // Update agent verification status
  await supabase
    .from('agents')
    .update({
      wallet_verification_status: 'verified',
      wallet_verified_at: now,
      updated_at: now,
    })
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx));

  // Create or update external wallet record linked to this agent
  const { data: existingWallet } = await supabase
    .from('wallets')
    .select('id')
    .eq('managed_by_agent_id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .eq('wallet_type', 'external')
    .limit(1)
    .maybeSingle();

  if (existingWallet) {
    // Update existing external wallet
    await supabase
      .from('wallets')
      .update({
        wallet_address: agent.wallet_address,
        verification_status: 'verified',
        verified_at: now,
        updated_at: now,
      })
      .eq('id', existingWallet.id)
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx));
  } else {
    // Find owner account (agent's parent or first business account)
    const { data: agentFull } = await supabase
      .from('agents')
      .select('parent_account_id')
      .eq('id', id)
      .eq('environment', getEnv(ctx))
      .single();

    let ownerAccountId = agentFull?.parent_account_id;
    if (!ownerAccountId) {
      const { data: accounts } = await supabase
        .from('accounts')
        .select('id')
        .eq('tenant_id', ctx.tenantId)
        .eq('environment', getEnv(ctx))
        .eq('type', 'business')
        .limit(1);
      ownerAccountId = accounts?.[0]?.id;
    }

    if (ownerAccountId) {
      await supabase.from('wallets').insert({
        tenant_id: ctx.tenantId,
        environment: getEnv(ctx),
        owner_account_id: ownerAccountId,
        managed_by_agent_id: id,
        balance: 0,
        currency: 'USDC',
        wallet_address: agent.wallet_address,
        network: 'base-sepolia',
        status: 'active',
        wallet_type: 'external',
        custody_type: 'self',
        provider: 'byow',
        verification_status: 'verified',
        verified_at: now,
        name: `${agent.name} BYOW Wallet`,
        purpose: 'Agent BYOW wallet verified via EIP-191',
      });
    }
  }

  // Audit log
  await logAudit(supabase, {
    tenantId: ctx.tenantId,
    entityType: 'agent',
    entityId: id,
    action: 'wallet_verified',
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    actorName: ctx.actorName,
    metadata: {
      wallet_address: agent.wallet_address,
      verification_method: 'eip191',
    },
  });

  return c.json({
    data: {
      agent_id: id,
      wallet_address: agent.wallet_address,
      verification_status: 'verified',
      verified_at: now,
    },
  });
});

// ============================================
// PUBLIC: Agent Card (ERC-8004 registration metadata)
// Mounted outside auth middleware in app.ts
// ============================================

export const agentCardRouter = new Hono();

agentCardRouter.get('/:id/card.json', async (c) => {
  const id = c.req.param('id');
  if (!isValidUUID(id)) {
    return c.json({ error: 'Invalid agent ID' }, 400);
  }

  const supabase = createClient();
  const { data } = await supabase
    .from('agents')
    .select('id, name, description, status, endpoint_url, erc8004_agent_id')
    .eq('id', id)
    .single();

  if (!data || data.status !== 'active') {
    return c.json({ error: 'Agent not found' }, 404);
  }

  // Fetch on-chain wallet address
  const { data: wallet } = await supabase
    .from('wallets')
    .select('wallet_address')
    .eq('managed_by_agent_id', id)
    .like('wallet_address', '0x%')
    .limit(1)
    .single();

  const baseUrl = process.env.API_BASE_URL || 'http://localhost:4000';
  const endpoints: { name: string; endpoint: string }[] = [];
  if (data.endpoint_url) {
    endpoints.push({ name: 'A2A', endpoint: data.endpoint_url });
  }
  endpoints.push({ name: 'API', endpoint: `${baseUrl}/v1/agents/${id}` });

  const registryContract = process.env.ERC8004_REGISTRY_CONTRACT || '0x13b52042ef3e0e84d7ad49fdc1b71848b187a89c';
  const network = process.env.PAYOS_ENVIRONMENT === 'production' ? 'base' : 'base-sepolia';
  const explorerBase = network === 'base' ? 'https://basescan.org' : 'https://sepolia.basescan.org';

  // Return raw JSON (bypass response wrapper) — BaseScan/ERC-721 expects name/description at root
  const cardJson = {
    name: data.name,
    description: data.description || '',
    ...(data.erc8004_agent_id ? { agentId: data.erc8004_agent_id } : {}),
    registryContract,
    ...(wallet?.wallet_address ? { walletAddress: wallet.wallet_address } : {}),
    network,
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    endpoints,
    supportedTrust: ['reputation'],
    links: {
      ...(data.erc8004_agent_id ? { identity: `${explorerBase}/nft/${registryContract}/${data.erc8004_agent_id}` } : {}),
      ...(wallet?.wallet_address ? { wallet: `${explorerBase}/address/${wallet.wallet_address}` } : {}),
    },
  };
  return new Response(JSON.stringify(cardJson), {
    headers: { 'Content-Type': 'application/json' },
  });
});

// ============================================
// AGENT AVATAR UPLOAD / DELETE
// ============================================

const AVATAR_BUCKET = 'agent-avatars';
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const AVATAR_ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);

/** Owner/admin user OR the agent itself may upload. */
async function canManageAvatar(
  ctx: { tenantId: string; actorType: string; userRole?: string; actorId?: string },
  agent: { id: string; tenant_id: string }
): Promise<boolean> {
  if (agent.tenant_id !== ctx.tenantId) return false;
  if (ctx.actorType === 'user') {
    return ctx.userRole === 'owner' || ctx.userRole === 'admin';
  }
  if (ctx.actorType === 'agent') {
    return ctx.actorId === agent.id;
  }
  // api_key: allowed (full-tenant scope)
  return ctx.actorType === 'api_key';
}

/**
 * POST /v1/agents/:id/avatar — Upload or replace an agent avatar.
 * Accepts multipart/form-data with a `file` field. Image only, ≤2 MB.
 */
agents.post('/:id/avatar', async (c) => {
  const ctx = c.get('ctx') as any;
  const id = c.req.param('id');
  if (!isValidUUID(id)) throw new ValidationError('Invalid agent ID');

  const supabase = createClient();
  // avatar_url may not exist yet (migration pending) — select it separately
  // so a missing column doesn't take down existence check.
  // Filter by tenant in the query so cross-tenant lookups return 404 instead
  // of 403 — avoids leaking agent existence via response-code timing.
  const { data: agent } = await supabase
    .from('agents')
    .select('id, tenant_id')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .maybeSingle() as any;
  if (!agent) throw new NotFoundError('Agent not found');

  let priorAvatarUrl: string | null = null;
  try {
    const { data: priorRow } = await (supabase as any)
      .from('agents').select('avatar_url').eq('id', id).maybeSingle();
    priorAvatarUrl = priorRow?.avatar_url ?? null;
  } catch { /* column may not exist yet */ }

  if (!(await canManageAvatar(ctx, agent))) {
    return c.json({ error: 'Not authorized to update this agent avatar' }, 403);
  }

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    throw new ValidationError('Expected multipart/form-data with a "file" field');
  }
  const file = form.get('file');
  if (!(file instanceof File)) {
    throw new ValidationError('Missing "file" field or not a file upload');
  }
  if (!AVATAR_ALLOWED_MIME.has(file.type)) {
    throw new ValidationError(`Unsupported MIME type "${file.type}". Use PNG, JPEG, or WebP.`);
  }
  if (file.size > AVATAR_MAX_BYTES) {
    throw new ValidationError(`File too large (${file.size} bytes). Max 2 MB.`);
  }

  const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
  const objectPath = `${agent.tenant_id}/${agent.id}-${Date.now()}.${ext}`;
  const bytes = new Uint8Array(await file.arrayBuffer());

  const { error: uploadErr } = await (supabase as any).storage
    .from(AVATAR_BUCKET)
    .upload(objectPath, bytes, {
      contentType: file.type,
      cacheControl: 'public, max-age=31536000, immutable',
      upsert: false,
    });
  if (uploadErr) {
    return c.json({ error: `Upload failed: ${uploadErr.message}` }, 500);
  }

  const { data: urlData } = (supabase as any).storage.from(AVATAR_BUCKET).getPublicUrl(objectPath);
  const publicUrl: string = urlData?.publicUrl ?? '';

  // Best-effort: delete the previous object so the bucket doesn't grow unbounded
  if (priorAvatarUrl) {
    try {
      const prefix = (supabase as any).storage.from(AVATAR_BUCKET).getPublicUrl('').data?.publicUrl ?? '';
      if (prefix && priorAvatarUrl.startsWith(prefix)) {
        const prevPath = priorAvatarUrl.slice(prefix.length);
        await (supabase as any).storage.from(AVATAR_BUCKET).remove([prevPath]);
      }
    } catch { /* best-effort */ }
  }

  const { error: updateErr } = await (supabase as any)
    .from('agents')
    .update({ avatar_url: publicUrl })
    .eq('id', agent.id);
  if (updateErr) {
    const columnMissing = /avatar_url.*(does not exist|not.*find)/i.test(updateErr.message);
    return c.json({
      error: columnMissing
        ? 'avatar_url column is missing. Run the migration apps/api/supabase/migrations/20260416_agent_avatars.sql in the Supabase SQL editor.'
        : `Failed to persist avatar URL: ${updateErr.message}`,
    }, columnMissing ? 503 : 500);
  }

  return c.json({ data: { avatar_url: publicUrl, avatarUrl: publicUrl } });
});

/**
 * DELETE /v1/agents/:id/avatar — Remove the avatar, fall back to default icon.
 */
agents.delete('/:id/avatar', async (c) => {
  const ctx = c.get('ctx') as any;
  const id = c.req.param('id');
  if (!isValidUUID(id)) throw new ValidationError('Invalid agent ID');

  const supabase = createClient();
  // Filter by tenant in the query so cross-tenant lookups return 404 instead
  // of 403 — avoids leaking agent existence via response-code timing.
  const { data: agent } = await supabase
    .from('agents')
    .select('id, tenant_id')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .maybeSingle() as any;
  if (!agent) throw new NotFoundError('Agent not found');

  if (!(await canManageAvatar(ctx, agent))) {
    return c.json({ error: 'Not authorized to delete this agent avatar' }, 403);
  }

  let priorAvatarUrl: string | null = null;
  try {
    const { data: priorRow } = await (supabase as any)
      .from('agents').select('avatar_url').eq('id', id).maybeSingle();
    priorAvatarUrl = priorRow?.avatar_url ?? null;
  } catch { /* column may not exist yet */ }

  if (priorAvatarUrl) {
    try {
      const prefix = (supabase as any).storage.from(AVATAR_BUCKET).getPublicUrl('').data?.publicUrl ?? '';
      if (prefix && priorAvatarUrl.startsWith(prefix)) {
        const objectPath = priorAvatarUrl.slice(prefix.length);
        await (supabase as any).storage.from(AVATAR_BUCKET).remove([objectPath]);
      }
    } catch { /* best-effort */ }
  }

  const { error: updateErr } = await (supabase as any)
    .from('agents').update({ avatar_url: null }).eq('id', agent.id);
  if (updateErr && !/column .*avatar_url.* does not exist/i.test(updateErr.message)) {
    return c.json({ error: updateErr.message }, 500);
  }

  return c.json({ data: { avatar_url: null } });
});

// ============================================
// GET /v1/organization/circle/master-balance
// Returns the tenant's Circle master wallet balance. Used as preflight
// before auto-refilling agent EOAs. Tenant-admin scoped (any caller in
// tenant can read since the balance is a shared tenant resource).
// Mounted here for proximity to the fund-eoa route; logically it's an
// org-level resource — in Phase 2 move to /v1/organization/circle/*.
// ============================================
agents.get('/circle/master-balance', async (c) => {
  try {
    const { getCirclePayoutsClient } = await import('../services/circle/payouts.js');
    const circle = getCirclePayoutsClient();
    const balances = await circle.getMasterWalletBalance();
    const usdc = balances.find(b => b.currency === 'USD' || b.currency === 'USDC');
    return c.json({
      success: true,
      balances,
      usdcAvailable: usdc ? parseFloat(usdc.amount) : 0,
      note: 'Single master wallet per Circle API key. Live API key => Base mainnet; sandbox key => Base Sepolia. Fund via Circle dashboard wire/deposit/mint.',
    });
  } catch (e: any) {
    return c.json({
      error: `Circle master balance check failed: ${e.message}`,
      code: 'CIRCLE_HEALTH_FAILED',
    }, 500);
  }
});

// ============================================
// GET /v1/agents/:id/auto-refill
// PATCH /v1/agents/:id/auto-refill
// Per-agent auto-refill policy. When enabled, a background worker checks
// the agent's EOA on-chain balance every few minutes; if below threshold,
// tops up to target from the tenant's Circle master wallet, capped by a
// per-day ceiling.
// ============================================
agents.get('/:id/auto-refill', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  if (!isValidUUID(id)) throw new ValidationError('Invalid agent ID format');

  const supabase = createClient();
  const { data: agent } = await supabase
    .from('agents')
    .select('id, auto_refill_enabled, auto_refill_threshold, auto_refill_target, auto_refill_daily_cap, auto_refill_daily_spent, auto_refill_daily_reset_at, auto_refill_last_at, auto_refill_last_status, auto_refill_last_error')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .single();
  if (!agent) throw new NotFoundError('Agent', id);

  const a = agent as any;
  return c.json({
    data: {
      enabled: a.auto_refill_enabled ?? false,
      threshold: a.auto_refill_threshold != null ? Number(a.auto_refill_threshold) : null,
      target: a.auto_refill_target != null ? Number(a.auto_refill_target) : null,
      dailyCap: a.auto_refill_daily_cap != null ? Number(a.auto_refill_daily_cap) : null,
      dailySpent: Number(a.auto_refill_daily_spent ?? 0),
      dailyResetAt: a.auto_refill_daily_reset_at,
      lastRunAt: a.auto_refill_last_at,
      lastStatus: a.auto_refill_last_status,
      lastError: a.auto_refill_last_error,
    },
  });
});

agents.patch('/:id/auto-refill', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  if (!isValidUUID(id)) throw new ValidationError('Invalid agent ID format');

  // Writes to auto-refill policy are tenant-admin operations; agents should
  // not be able to raise their own budgets.
  if (ctx.actorType === 'agent') {
    return c.json({ error: 'Agents cannot modify their own auto-refill policy' }, 403);
  }

  let body: any = {};
  try { body = await c.req.json(); } catch { throw new ValidationError('Invalid JSON body'); }

  // Accept both short ("threshold") and qualified ("thresholdUsdc") forms —
  // internal callers settled on the short names; older callers may still
  // use the Usdc-suffixed ones.
  const enabled = body.enabled;
  const thresholdIn = body.threshold ?? body.thresholdUsdc;
  const targetIn = body.target ?? body.targetUsdc;
  const dailyCapIn = body.dailyCap ?? body.dailyCapUsdc;
  const patch: any = {};

  if (typeof enabled === 'boolean') patch.auto_refill_enabled = enabled;
  if (thresholdIn != null) {
    const v = Number(thresholdIn);
    if (!Number.isFinite(v) || v < 0) throw new ValidationError('threshold must be a non-negative number');
    patch.auto_refill_threshold = v;
  }
  if (targetIn != null) {
    const v = Number(targetIn);
    if (!Number.isFinite(v) || v <= 0) throw new ValidationError('target must be a positive number');
    patch.auto_refill_target = v;
  }
  if (dailyCapIn != null) {
    const v = Number(dailyCapIn);
    if (!Number.isFinite(v) || v < 0) throw new ValidationError('dailyCap must be a non-negative number');
    patch.auto_refill_daily_cap = v;
  }

  // Semantic validation: target must exceed threshold, daily cap should be
  // at least one target-worth of headroom, KYA caps must not be exceeded.
  const supabase = createClient();
  const { data: current } = await supabase
    .from('agents')
    .select('auto_refill_threshold, auto_refill_target, auto_refill_daily_cap, effective_limit_daily')
    .eq('id', id).eq('tenant_id', ctx.tenantId).single();
  if (!current) throw new NotFoundError('Agent', id);

  const nextThreshold = patch.auto_refill_threshold ?? (current as any).auto_refill_threshold;
  const nextTarget = patch.auto_refill_target ?? (current as any).auto_refill_target;
  const nextDailyCap = patch.auto_refill_daily_cap ?? (current as any).auto_refill_daily_cap;
  if (nextThreshold != null && nextTarget != null && Number(nextThreshold) >= Number(nextTarget)) {
    throw new ValidationError('threshold must be less than target');
  }
  if (nextDailyCap != null && nextTarget != null && Number(nextDailyCap) < Number(nextTarget)) {
    throw new ValidationError('dailyCap must be at least target — otherwise a single refill exhausts the cap');
  }
  const dailyKyaLimit = parseFloat((current as any).effective_limit_daily) || 0;
  if (nextDailyCap != null && dailyKyaLimit > 0 && Number(nextDailyCap) > dailyKyaLimit) {
    throw new ValidationError(`dailyCap ($${nextDailyCap}) exceeds agent's daily KYA limit ($${dailyKyaLimit}). Raise the KYA tier first.`);
  }

  const { data: updated, error: updateErr } = await (supabase.from('agents') as any)
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id).eq('tenant_id', ctx.tenantId)
    .select('auto_refill_enabled, auto_refill_threshold, auto_refill_target, auto_refill_daily_cap, auto_refill_daily_spent, auto_refill_daily_reset_at, auto_refill_last_at, auto_refill_last_status, auto_refill_last_error')
    .single();
  if (updateErr || !updated) {
    console.error('[auto-refill] update failed', updateErr);
    throw new Error('Failed to update auto-refill policy');
  }

  await logAudit(supabase, {
    tenantId: ctx.tenantId, entityType: 'agent', entityId: id,
    action: 'auto_refill_policy_updated', actorType: ctx.actorType,
    actorId: ctx.actorId, actorName: ctx.actorName,
    metadata: patch,
  });

  const u = updated as any;
  return c.json({
    data: {
      enabled: u.auto_refill_enabled ?? false,
      threshold: u.auto_refill_threshold != null ? Number(u.auto_refill_threshold) : null,
      target: u.auto_refill_target != null ? Number(u.auto_refill_target) : null,
      dailyCap: u.auto_refill_daily_cap != null ? Number(u.auto_refill_daily_cap) : null,
      dailySpent: Number(u.auto_refill_daily_spent ?? 0),
      dailyResetAt: u.auto_refill_daily_reset_at,
      lastRunAt: u.auto_refill_last_at,
      lastStatus: u.auto_refill_last_status,
      lastError: u.auto_refill_last_error,
    },
  });
});

export default agents;
