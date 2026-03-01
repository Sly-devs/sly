/**
 * A2A Agent Onboarding Handler
 *
 * Handles register_agent, update_agent, get_my_status, manage_wallet,
 * and check_task skills at the platform gateway level (POST /a2a).
 *
 * @see Epic 60: A2A Agent Onboarding Skills
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { A2AJsonRpcResponse } from './types.js';
import { JSON_RPC_ERRORS } from './types.js';
import type { GatewayAuthContext } from './gateway-handler.js';
import { generateAgentToken, hashApiKey, getKeyPrefix } from '../../utils/crypto.js';
import { computeEffectiveLimits, DEFAULT_PERMISSIONS } from '../../routes/agents.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ============================================================================
// Shared response builders
// ============================================================================

function buildSuccessResponse(
  requestId: string | number,
  name: string,
  data: Record<string, unknown>,
): A2AJsonRpcResponse {
  return {
    jsonrpc: '2.0',
    result: {
      id: crypto.randomUUID(),
      status: {
        state: 'completed',
        timestamp: new Date().toISOString(),
      },
      artifacts: [
        {
          artifactId: crypto.randomUUID(),
          name,
          mediaType: 'application/json',
          parts: [{ data }],
        },
      ],
      history: [],
    },
    id: requestId,
  };
}

function buildErrorResponse(
  requestId: string | number,
  code: number,
  message: string,
): A2AJsonRpcResponse {
  return {
    jsonrpc: '2.0',
    error: { code, message },
    id: requestId,
  };
}

// ============================================================================
// register_agent
// ============================================================================

/**
 * Register a new agent via A2A.
 * Requires API key auth (Bearer pk_*).
 *
 * Creates agent + wallet + skills + endpoint in one shot.
 * Auto-verifies KYA tier 1 for immediate x402 capability.
 */
export async function handleRegisterAgent(
  requestId: string | number,
  payload: Record<string, unknown>,
  supabase: SupabaseClient,
  baseUrl: string,
  authContext?: GatewayAuthContext,
): Promise<A2AJsonRpcResponse> {
  // Require API key auth
  if (!authContext || authContext.authType !== 'api_key') {
    return buildErrorResponse(
      requestId,
      JSON_RPC_ERRORS.UNAUTHORIZED,
      'register_agent requires API key authentication (Bearer pk_*)',
    );
  }

  const tenantId = authContext.tenantId;
  const name = payload.name as string | undefined;

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return buildErrorResponse(
      requestId,
      JSON_RPC_ERRORS.INVALID_PARAMS,
      'name is required and must be a non-empty string',
    );
  }

  // Validate optional accountId
  const accountId = payload.accountId as string | undefined;
  if (accountId && !UUID_RE.test(accountId)) {
    return buildErrorResponse(
      requestId,
      JSON_RPC_ERRORS.INVALID_PARAMS,
      'accountId must be a valid UUID',
    );
  }

  // Resolve parent business account
  let parentAccountId: string | null = null;
  let parentVerificationTier: number | null = null;

  if (accountId) {
    // Validate belongs to tenant and is a business account
    const { data: account, error: accountError } = await supabase
      .from('accounts')
      .select('id, type, name, verification_tier')
      .eq('id', accountId)
      .eq('tenant_id', tenantId)
      .single();

    if (accountError || !account) {
      return buildErrorResponse(
        requestId,
        JSON_RPC_ERRORS.INVALID_PARAMS,
        `Account ${accountId} not found or does not belong to your tenant`,
      );
    }

    if (account.type !== 'business') {
      return buildErrorResponse(
        requestId,
        JSON_RPC_ERRORS.INVALID_PARAMS,
        'Only business accounts can have agents',
      );
    }

    parentAccountId = account.id;
    parentVerificationTier = account.verification_tier;
  } else {
    // Auto-select first business account in tenant
    const { data: accounts } = await supabase
      .from('accounts')
      .select('id, verification_tier')
      .eq('tenant_id', tenantId)
      .eq('type', 'business')
      .order('created_at')
      .limit(1);

    if (accounts?.length) {
      parentAccountId = accounts[0].id;
      parentVerificationTier = accounts[0].verification_tier;
    }
  }

  // Generate auth credentials
  const authToken = generateAgentToken();
  const authTokenHash = hashApiKey(authToken);
  const authTokenPrefix = getKeyPrefix(authToken);

  const description = (payload.description as string) || null;

  // Create agent
  const { data: agent, error: agentError } = await supabase
    .from('agents')
    .insert({
      tenant_id: tenantId,
      parent_account_id: parentAccountId,
      name: name.trim(),
      description,
      status: 'active',
      kya_tier: 1, // Auto-verify tier 1 for x402 capability
      kya_status: 'verified',
      auth_type: 'api_key',
      auth_client_id: authTokenPrefix,
      auth_token_hash: authTokenHash,
      auth_token_prefix: authTokenPrefix,
      permissions: DEFAULT_PERMISSIONS,
    })
    .select('id, name, description, status, kya_tier, kya_status, created_at')
    .single();

  if (agentError) {
    console.error('[A2A Onboarding] Failed to create agent:', agentError);
    return buildErrorResponse(
      requestId,
      JSON_RPC_ERRORS.INTERNAL_ERROR,
      'Failed to create agent',
    );
  }

  // Auto-create wallet if parent account exists
  let walletId: string | null = null;
  if (parentAccountId) {
    const walletAddress = `internal://sly/${tenantId}/${parentAccountId}/agent/${agent.id}`;
    const { data: wallet, error: walletError } = await supabase
      .from('wallets')
      .insert({
        tenant_id: tenantId,
        owner_account_id: parentAccountId,
        managed_by_agent_id: agent.id,
        balance: 0,
        currency: 'USDC',
        wallet_address: walletAddress,
        network: 'internal',
        status: 'active',
        wallet_type: 'internal',
        name: `${name.trim()} Wallet`,
        purpose: `Auto-created via A2A register_agent`,
      })
      .select('id')
      .single();

    if (!walletError && wallet) {
      walletId = wallet.id;
    }
  }

  // Batch-upsert skills if provided
  const skills = payload.skills as Array<Record<string, unknown>> | undefined;
  const upsertedSkills: string[] = [];
  if (Array.isArray(skills) && skills.length > 0) {
    const skillRows = skills.map((s) => ({
      tenant_id: tenantId,
      agent_id: agent.id,
      skill_id: String(s.id || s.skill_id || ''),
      name: String(s.name || s.id || s.skill_id || ''),
      description: s.description ? String(s.description) : null,
      base_price: Number(s.base_price ?? s.price ?? 0),
      currency: String(s.currency || 'USDC'),
      tags: Array.isArray(s.tags) ? s.tags : [],
      input_modes: Array.isArray(s.input_modes) ? s.input_modes : ['text'],
      output_modes: Array.isArray(s.output_modes) ? s.output_modes : ['text', 'data'],
      input_schema: (s.input_schema as Record<string, unknown>) || null,
      handler_type: String(s.handler_type || 'agent_provided'),
      status: 'active',
    })).filter((s) => s.skill_id);

    if (skillRows.length > 0) {
      const { error: skillError } = await supabase
        .from('agent_skills')
        .upsert(skillRows, { onConflict: 'tenant_id,agent_id,skill_id' });

      if (!skillError) {
        upsertedSkills.push(...skillRows.map((s) => s.skill_id));
      }
    }
  }

  // Store endpoint in dedicated columns (used by task processor for forwarding)
  // AND in metadata (used by agent card responses).
  // Also set processing_mode = 'managed' so the worker auto-dispatches via
  // the task processor, which reads endpoint_url/endpoint_enabled for forwarding.
  const endpoint = payload.endpoint as Record<string, unknown> | undefined;
  if (endpoint?.url) {
    const endpointType = String(endpoint.type || 'a2a');
    await supabase
      .from('agents')
      .update({
        endpoint_url: String(endpoint.url),
        endpoint_type: endpointType,
        endpoint_secret: endpoint.secret ? String(endpoint.secret) : (endpoint.auth ? String(endpoint.auth) : null),
        endpoint_enabled: true,
        processing_mode: 'managed',
        metadata: {
          a2a_endpoint: String(endpoint.url),
          a2a_endpoint_auth: endpoint.auth || null,
        },
      })
      .eq('id', agent.id)
      .eq('tenant_id', tenantId);
  }

  // Compute effective limits
  const { limits, capped } = await computeEffectiveLimits(supabase, 1, parentVerificationTier);

  return buildSuccessResponse(requestId, 'register_agent_result', {
    agent: {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      status: agent.status,
      kyaTier: agent.kya_tier,
      kyaStatus: agent.kya_status,
      parentAccountId,
      cardUrl: `${baseUrl}/a2a/${agent.id}/.well-known/agent.json`,
      a2aEndpoint: `${baseUrl}/a2a/${agent.id}`,
    },
    credentials: {
      token: authToken,
      prefix: authTokenPrefix,
      warning: 'SAVE THIS TOKEN NOW - it will never be shown again!',
    },
    wallet: walletId ? { id: walletId, currency: 'USDC', balance: 0 } : null,
    skills: upsertedSkills,
    limits: {
      effective: limits,
      capped,
      tier: 1,
    },
  });
}

// ============================================================================
// update_agent
// ============================================================================

/**
 * Update the calling agent's profile.
 * Requires agent token auth (Bearer agent_*).
 * Self-sovereign: target agent is always the authenticated agent.
 */
export async function handleUpdateAgent(
  requestId: string | number,
  payload: Record<string, unknown>,
  supabase: SupabaseClient,
  baseUrl: string,
  authContext?: GatewayAuthContext,
): Promise<A2AJsonRpcResponse> {
  // Require agent token auth
  if (!authContext || authContext.authType !== 'agent' || !authContext.agentId) {
    return buildErrorResponse(
      requestId,
      JSON_RPC_ERRORS.UNAUTHORIZED,
      'update_agent requires agent token authentication (Bearer agent_*)',
    );
  }

  const agentId = authContext.agentId;
  const tenantId = authContext.tenantId;

  // Build partial update
  const updates: Record<string, unknown> = {};
  if (typeof payload.name === 'string' && payload.name.trim()) {
    updates.name = payload.name.trim();
  }
  if (typeof payload.description === 'string') {
    updates.description = payload.description || null;
  }

  // Store endpoint in dedicated columns (used by task processor for forwarding)
  // Also set processing_mode = 'managed' for auto-dispatch via task processor.
  const endpoint = payload.endpoint as Record<string, unknown> | undefined;
  if (endpoint?.url) {
    const endpointType = String(endpoint.type || 'a2a');
    updates.endpoint_url = String(endpoint.url);
    updates.endpoint_type = endpointType;
    updates.endpoint_secret = endpoint.secret ? String(endpoint.secret) : (endpoint.auth ? String(endpoint.auth) : null);
    updates.endpoint_enabled = true;
    updates.processing_mode = 'managed';
    // Also keep metadata in sync for agent card responses
    updates.metadata = {
      a2a_endpoint: String(endpoint.url),
      a2a_endpoint_auth: endpoint.auth || null,
    };
  }

  // Apply updates if any
  if (Object.keys(updates).length > 0) {
    updates.updated_at = new Date().toISOString();
    const { error } = await supabase
      .from('agents')
      .update(updates)
      .eq('id', agentId)
      .eq('tenant_id', tenantId);

    if (error) {
      return buildErrorResponse(requestId, JSON_RPC_ERRORS.INTERNAL_ERROR, 'Failed to update agent');
    }
  }

  // Upsert add_skills (also accept "skills" as alias for convenience)
  const addSkills = (payload.add_skills || payload.skills) as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(addSkills) && addSkills.length > 0) {
    const skillRows = addSkills.map((s) => ({
      tenant_id: tenantId,
      agent_id: agentId,
      skill_id: String(s.id || s.skill_id || ''),
      name: String(s.name || s.id || s.skill_id || ''),
      description: s.description ? String(s.description) : null,
      base_price: Number(s.base_price ?? s.price ?? 0),
      currency: String(s.currency || 'USDC'),
      tags: Array.isArray(s.tags) ? s.tags : [],
      input_modes: Array.isArray(s.input_modes) ? s.input_modes : ['text'],
      output_modes: Array.isArray(s.output_modes) ? s.output_modes : ['text', 'data'],
      input_schema: (s.input_schema as Record<string, unknown>) || null,
      handler_type: String(s.handler_type || 'agent_provided'),
      status: 'active',
    })).filter((s) => s.skill_id);

    if (skillRows.length > 0) {
      await supabase
        .from('agent_skills')
        .upsert(skillRows, { onConflict: 'tenant_id,agent_id,skill_id' });
    }
  }

  // Remove skills
  const removeSkills = payload.remove_skills as string[] | undefined;
  if (Array.isArray(removeSkills) && removeSkills.length > 0) {
    await supabase
      .from('agent_skills')
      .delete()
      .eq('agent_id', agentId)
      .eq('tenant_id', tenantId)
      .in('skill_id', removeSkills);
  }

  // Fetch updated state
  const { data: agent, error: fetchError } = await supabase
    .from('agents')
    .select('id, name, description, status, kya_tier, kya_status, metadata')
    .eq('id', agentId)
    .eq('tenant_id', tenantId)
    .single();

  if (fetchError || !agent) {
    return buildErrorResponse(requestId, JSON_RPC_ERRORS.INTERNAL_ERROR, 'Failed to fetch updated agent');
  }

  const { data: skills } = await supabase
    .from('agent_skills')
    .select('skill_id, name, description, base_price, currency, tags, status')
    .eq('agent_id', agentId)
    .eq('tenant_id', tenantId)
    .order('created_at');

  const agentMetadata = (agent.metadata || {}) as Record<string, any>;

  return buildSuccessResponse(requestId, 'update_agent_result', {
    agent: {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      status: agent.status,
      kyaTier: agent.kya_tier,
      kyaStatus: agent.kya_status,
      a2aEndpoint: agentMetadata.a2a_endpoint || `${baseUrl}/a2a/${agent.id}`,
      cardUrl: `${baseUrl}/a2a/${agent.id}/.well-known/agent.json`,
    },
    skills: (skills || []).map((s: any) => ({
      id: s.skill_id,
      name: s.name,
      description: s.description,
      basePrice: s.base_price,
      currency: s.currency,
      tags: s.tags,
      status: s.status,
    })),
  });
}

// ============================================================================
// get_my_status
// ============================================================================

/**
 * Get the calling agent's full status.
 * Requires agent token auth (Bearer agent_*).
 */
export async function handleGetMyStatus(
  requestId: string | number,
  supabase: SupabaseClient,
  baseUrl: string,
  authContext?: GatewayAuthContext,
): Promise<A2AJsonRpcResponse> {
  // Require agent token auth
  if (!authContext || authContext.authType !== 'agent' || !authContext.agentId) {
    return buildErrorResponse(
      requestId,
      JSON_RPC_ERRORS.UNAUTHORIZED,
      'get_my_status requires agent token authentication (Bearer agent_*)',
    );
  }

  const agentId = authContext.agentId;
  const tenantId = authContext.tenantId;

  // Parallel queries: agent row, wallets, skills
  const [agentResult, walletsResult, skillsResult] = await Promise.all([
    supabase
      .from('agents')
      .select('id, name, description, status, kya_tier, kya_status, parent_account_id, metadata, permissions, created_at')
      .eq('id', agentId)
      .eq('tenant_id', tenantId)
      .single(),
    supabase
      .from('wallets')
      .select('id, balance, currency, status, wallet_type, name')
      .eq('managed_by_agent_id', agentId)
      .eq('tenant_id', tenantId),
    supabase
      .from('agent_skills')
      .select('skill_id, name, description, base_price, currency, tags, status')
      .eq('agent_id', agentId)
      .eq('tenant_id', tenantId)
      .order('created_at'),
  ]);

  const agent = agentResult.data;
  if (!agent) {
    return buildErrorResponse(requestId, JSON_RPC_ERRORS.INTERNAL_ERROR, 'Agent not found');
  }

  // Compute effective limits
  let parentVerificationTier: number | null = null;
  if (agent.parent_account_id) {
    const { data: parentAccount } = await supabase
      .from('accounts')
      .select('verification_tier')
      .eq('id', agent.parent_account_id)
      .single();
    parentVerificationTier = parentAccount?.verification_tier ?? null;
  }

  const { limits, capped } = await computeEffectiveLimits(supabase, agent.kya_tier, parentVerificationTier);

  const wallets = (walletsResult.data || []).map((w: any) => ({
    id: w.id,
    balance: Number(w.balance),
    currency: w.currency,
    status: w.status,
    type: w.wallet_type,
    name: w.name,
  }));

  const skills = (skillsResult.data || []).map((s: any) => ({
    id: s.skill_id,
    name: s.name,
    description: s.description,
    basePrice: s.base_price,
    currency: s.currency,
    tags: s.tags,
    status: s.status,
  }));

  const agentMetadata = (agent.metadata || {}) as Record<string, any>;

  return buildSuccessResponse(requestId, 'get_my_status_result', {
    agent: {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      status: agent.status,
      kyaTier: agent.kya_tier,
      kyaStatus: agent.kya_status,
      parentAccountId: agent.parent_account_id,
      a2aEndpoint: agentMetadata.a2a_endpoint || `${baseUrl}/a2a/${agent.id}`,
      cardUrl: `${baseUrl}/a2a/${agent.id}/.well-known/agent.json`,
      createdAt: agent.created_at,
    },
    wallets,
    skills,
    limits: {
      effective: limits,
      capped,
      tier: agent.kya_tier,
    },
  });
}

// ============================================================================
// manage_wallet
// ============================================================================

/**
 * Manage the calling agent's wallet (check_balance or fund).
 * Requires agent token auth (Bearer agent_*).
 */
export async function handleManageWallet(
  requestId: string | number,
  payload: Record<string, unknown>,
  supabase: SupabaseClient,
  _baseUrl: string,
  authContext?: GatewayAuthContext,
): Promise<A2AJsonRpcResponse> {
  // Require agent token auth
  if (!authContext || authContext.authType !== 'agent' || !authContext.agentId) {
    return buildErrorResponse(
      requestId,
      JSON_RPC_ERRORS.UNAUTHORIZED,
      'manage_wallet requires agent token authentication (Bearer agent_*)',
    );
  }

  const agentId = authContext.agentId;
  const tenantId = authContext.tenantId;
  const action = (payload.action as string) || 'check_balance';

  switch (action) {
    case 'check_balance':
      return handleWalletCheckBalance(requestId, agentId, tenantId, supabase);
    case 'fund':
      return handleWalletFund(requestId, payload, agentId, tenantId, supabase);
    default:
      return buildErrorResponse(
        requestId,
        JSON_RPC_ERRORS.INVALID_PARAMS,
        `Unknown manage_wallet action: ${action}. Supported: check_balance, fund`,
      );
  }
}

async function handleWalletCheckBalance(
  requestId: string | number,
  agentId: string,
  tenantId: string,
  supabase: SupabaseClient,
): Promise<A2AJsonRpcResponse> {
  const { data: wallets, error } = await supabase
    .from('wallets')
    .select('id, balance, currency, status')
    .eq('managed_by_agent_id', agentId)
    .eq('tenant_id', tenantId);

  if (error) {
    return buildErrorResponse(requestId, JSON_RPC_ERRORS.INTERNAL_ERROR, 'Failed to query wallets');
  }

  return buildSuccessResponse(requestId, 'manage_wallet_result', {
    action: 'check_balance',
    wallets: (wallets || []).map((w: any) => ({
      id: w.id,
      balance: Number(w.balance),
      currency: w.currency,
      status: w.status,
    })),
  });
}

async function handleWalletFund(
  requestId: string | number,
  payload: Record<string, unknown>,
  agentId: string,
  tenantId: string,
  supabase: SupabaseClient,
): Promise<A2AJsonRpcResponse> {
  // Environment gate: allow in dev, or when tenant uses test API keys
  const isDevOrSandbox = process.env.NODE_ENV !== 'production' || !!process.env.SANDBOX_MODE;

  if (!isDevOrSandbox) {
    // In production without SANDBOX_MODE, check if tenant has test API keys
    const { data: apiKey } = await supabase
      .from('api_keys')
      .select('environment')
      .eq('tenant_id', tenantId)
      .eq('environment', 'test')
      .limit(1)
      .single();

    if (!apiKey) {
      return buildErrorResponse(
        requestId,
        JSON_RPC_ERRORS.INVALID_PARAMS,
        'Test funding is only available for sandbox tenants (pk_test_* keys)',
      );
    }
  }

  const amount = Number(payload.amount);
  if (!amount || amount <= 0 || amount > 100_000) {
    return buildErrorResponse(
      requestId,
      JSON_RPC_ERRORS.INVALID_PARAMS,
      'amount is required and must be between 0 and 100,000',
    );
  }

  const currency = (payload.currency as string) || 'USDC';

  // Find agent's wallet
  const { data: wallet, error: walletError } = await supabase
    .from('wallets')
    .select('id, balance, currency, status')
    .eq('managed_by_agent_id', agentId)
    .eq('tenant_id', tenantId)
    .limit(1)
    .single();

  if (walletError || !wallet) {
    return buildErrorResponse(
      requestId,
      JSON_RPC_ERRORS.INVALID_PARAMS,
      'No wallet found for this agent. Register with a parent account first.',
    );
  }

  const previousBalance = Number(wallet.balance);
  const newBalance = previousBalance + amount;

  // Update balance
  const { error: updateError } = await supabase
    .from('wallets')
    .update({
      balance: newBalance,
      status: 'active',
      updated_at: new Date().toISOString(),
    })
    .eq('id', wallet.id)
    .eq('tenant_id', tenantId);

  if (updateError) {
    return buildErrorResponse(requestId, JSON_RPC_ERRORS.INTERNAL_ERROR, 'Failed to update wallet balance');
  }

  // Create audit log entry
  await supabase.from('audit_log').insert({
    tenant_id: tenantId,
    entity_type: 'wallet',
    entity_id: wallet.id,
    action: 'test_fund',
    actor_type: 'agent',
    actor_id: agentId,
    actor_name: `agent:${agentId}`,
    changes: {
      previous_balance: previousBalance,
      funded_amount: amount,
      new_balance: newBalance,
      currency,
    },
    metadata: {
      environment: 'sandbox',
      source: 'a2a_manage_wallet',
    },
  });

  return buildSuccessResponse(requestId, 'manage_wallet_result', {
    action: 'fund',
    wallet_id: wallet.id,
    previous_balance: previousBalance,
    funded_amount: amount,
    new_balance: newBalance,
    currency,
  });
}

// ============================================================================
// verify_agent
// ============================================================================

/**
 * Verify an agent's KYA tier (self-sovereign or admin).
 * Agent token auth: verifies self (agentId from auth context).
 * API key auth: verifies specified agent_id.
 */
export async function handleVerifyAgent(
  requestId: string | number,
  payload: Record<string, unknown>,
  supabase: SupabaseClient,
  baseUrl: string,
  authContext?: GatewayAuthContext,
): Promise<A2AJsonRpcResponse> {
  if (!authContext) {
    return buildErrorResponse(
      requestId,
      JSON_RPC_ERRORS.UNAUTHORIZED,
      'verify_agent requires authentication (Bearer agent_* or pk_*)',
    );
  }

  let agentId: string;
  const tenantId = authContext.tenantId;

  if (authContext.authType === 'agent' && authContext.agentId) {
    // Self-sovereign: verify the calling agent
    agentId = authContext.agentId;
  } else if (authContext.authType === 'api_key') {
    // Admin: must provide agent_id in payload
    const targetAgentId = payload.agent_id as string | undefined;
    if (!targetAgentId || !UUID_RE.test(targetAgentId)) {
      return buildErrorResponse(
        requestId,
        JSON_RPC_ERRORS.INVALID_PARAMS,
        'agent_id is required (UUID) when using API key auth',
      );
    }
    agentId = targetAgentId;
  } else {
    return buildErrorResponse(
      requestId,
      JSON_RPC_ERRORS.UNAUTHORIZED,
      'verify_agent requires agent token or API key authentication',
    );
  }

  const requestedTier = Number(payload.tier ?? 1);
  if (requestedTier < 0 || requestedTier > 3 || !Number.isInteger(requestedTier)) {
    return buildErrorResponse(
      requestId,
      JSON_RPC_ERRORS.INVALID_PARAMS,
      'tier must be an integer between 0 and 3',
    );
  }

  // Fetch the agent
  const { data: agent, error: agentError } = await supabase
    .from('agents')
    .select('id, name, status, kya_tier, kya_status, parent_account_id')
    .eq('id', agentId)
    .eq('tenant_id', tenantId)
    .single();

  if (agentError || !agent) {
    return buildErrorResponse(
      requestId,
      JSON_RPC_ERRORS.INVALID_PARAMS,
      `Agent ${agentId} not found`,
    );
  }

  // Fetch parent account's verification_tier
  let parentVerificationTier: number | null = null;
  if (agent.parent_account_id) {
    const { data: parentAccount } = await supabase
      .from('accounts')
      .select('verification_tier')
      .eq('id', agent.parent_account_id)
      .single();
    parentVerificationTier = parentAccount?.verification_tier ?? null;
  }

  // Compute effective limits
  const { limits, capped } = await computeEffectiveLimits(supabase, requestedTier, parentVerificationTier);

  // Update agent KYA tier, status, and effective limits
  const { error: updateError } = await supabase
    .from('agents')
    .update({
      kya_tier: requestedTier,
      kya_status: 'verified',
      effective_limit_per_tx: limits.per_transaction,
      effective_limit_daily: limits.daily,
      effective_limit_monthly: limits.monthly,
      effective_limits_capped: capped,
      updated_at: new Date().toISOString(),
    })
    .eq('id', agentId)
    .eq('tenant_id', tenantId);

  if (updateError) {
    return buildErrorResponse(requestId, JSON_RPC_ERRORS.INTERNAL_ERROR, 'Failed to update agent KYA tier');
  }

  // Audit log
  await supabase.from('audit_log').insert({
    tenant_id: tenantId,
    entity_type: 'agent',
    entity_id: agentId,
    action: 'kya_verification',
    actor_type: authContext.authType === 'agent' ? 'agent' : 'api_key',
    actor_id: authContext.authType === 'agent' ? agentId : authContext.apiKeyId || 'unknown',
    actor_name: authContext.authType === 'agent' ? `agent:${agentId}` : 'api_key',
    changes: {
      previous_tier: agent.kya_tier,
      new_tier: requestedTier,
      kya_status: 'verified',
    },
    metadata: {
      source: 'a2a_verify_agent',
      self_sovereign: authContext.authType === 'agent',
    },
  });

  return buildSuccessResponse(requestId, 'verify_agent_result', {
    agent_id: agentId,
    kya_tier: requestedTier,
    kya_status: 'verified',
    effective_limits: limits,
    capped,
  });
}

// ============================================================================
// check_task
// ============================================================================

/**
 * Check the status of an A2A task by ID.
 * Requires agent token auth (Bearer agent_*).
 * Agent can view tasks it owns (agent_id) or initiated (client_agent_id).
 */
export async function handleCheckTask(
  requestId: string | number,
  payload: Record<string, unknown>,
  supabase: SupabaseClient,
  _baseUrl: string,
  authContext?: GatewayAuthContext,
): Promise<A2AJsonRpcResponse> {
  // Require agent token auth
  if (!authContext || authContext.authType !== 'agent' || !authContext.agentId) {
    return buildErrorResponse(
      requestId,
      JSON_RPC_ERRORS.UNAUTHORIZED,
      'check_task requires agent token authentication (Bearer agent_*)',
    );
  }

  const taskId = payload.task_id as string | undefined;
  if (!taskId || !UUID_RE.test(taskId)) {
    return buildErrorResponse(
      requestId,
      JSON_RPC_ERRORS.INVALID_PARAMS,
      'task_id is required and must be a valid UUID',
    );
  }

  const agentId = authContext.agentId;
  const tenantId = authContext.tenantId;

  // Query task — must belong to tenant
  const { data: task, error: taskError } = await supabase
    .from('a2a_tasks')
    .select('id, state, status_message, direction, agent_id, client_agent_id, created_at, updated_at, processing_duration_ms')
    .eq('id', taskId)
    .eq('tenant_id', tenantId)
    .single();

  if (taskError || !task) {
    return buildErrorResponse(
      requestId,
      JSON_RPC_ERRORS.TASK_NOT_FOUND,
      `Task ${taskId} not found`,
    );
  }

  // Scope check: agent must own or have initiated the task
  if (task.agent_id !== agentId && task.client_agent_id !== agentId) {
    return buildErrorResponse(
      requestId,
      JSON_RPC_ERRORS.TASK_NOT_FOUND,
      `Task ${taskId} not found`,
    );
  }

  // Fetch message history and artifacts in parallel
  const [messagesResult, artifactsResult] = await Promise.all([
    supabase
      .from('a2a_messages')
      .select('role, parts, created_at')
      .eq('task_id', taskId)
      .eq('tenant_id', tenantId)
      .order('created_at')
      .limit(20),
    supabase
      .from('a2a_artifacts')
      .select('label, mime_type, parts')
      .eq('task_id', taskId)
      .eq('tenant_id', tenantId)
      .order('created_at'),
  ]);

  return buildSuccessResponse(requestId, 'check_task_result', {
    task: {
      id: task.id,
      state: task.state,
      status_message: task.status_message,
      direction: task.direction,
      created_at: task.created_at,
      updated_at: task.updated_at,
      processing_duration_ms: task.processing_duration_ms,
    },
    history: (messagesResult.data || []).map((m: any) => ({
      role: m.role,
      parts: m.parts,
      created_at: m.created_at,
    })),
    artifacts: (artifactsResult.data || []).map((a: any) => ({
      label: a.label,
      mime_type: a.mime_type,
      parts: a.parts,
    })),
  });
}
