/**
 * Agent Wallet Policy Routes
 *
 * Epic 18: Agent Wallets & Contract Policies
 *
 * Convenience routes (Story 18.2):
 *   GET    /v1/agents/:agentId/wallet           — get agent's wallet
 *   POST   /v1/agents/:agentId/wallet/freeze     — freeze wallet
 *   POST   /v1/agents/:agentId/wallet/unfreeze   — unfreeze wallet
 *   PUT    /v1/agents/:agentId/wallet/policy      — set contract policy
 *
 * Negotiation guardrails (Story 18.9):
 *   POST   /v1/agents/:agentId/wallet/policy/evaluate — dry-run policy evaluation
 *
 * Exposure & audit (Story 18.8):
 *   GET    /v1/agents/:agentId/wallet/exposures — list counterparty exposures
 *   GET    /v1/agents/:agentId/wallet/policy/evaluations — audit log
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { createClient } from '../db/client.js';
import { createContractPolicyEngine } from '../services/contract-policy-engine.js';
import { createCounterpartyExposureService } from '../services/counterparty-exposure.service.js';
import { negotiationEvaluateRequestSchema, contractPolicySchema } from '../schemas/contract-policy.schema.js';
import { invalidatePolicyCache } from '../services/spending-policy.js';
import { ValidationError, NotFoundError } from '../middleware/error.js';
import { isValidUUID, getPaginationParams, paginationResponse, getEnv } from '../utils/helpers.js';

function mapWalletFromDb(row: any) {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    owner_account_id: row.owner_account_id,
    managed_by_agent_id: row.managed_by_agent_id,
    balance: parseFloat(row.balance),
    currency: row.currency,
    spending_policy: row.spending_policy,
    wallet_address: row.wallet_address,
    network: row.network,
    status: row.status,
    name: row.name,
    purpose: row.purpose,
    wallet_type: row.wallet_type,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const agentWallets = new Hono();

// ============================================
// Helper: find agent's managed wallet
// ============================================

async function getAgentWallet(supabase: any, agentId: string, tenantId: string, environment?: string, requireActive = false) {
  let query = supabase
    .from('wallets')
    .select('*')
    .eq('managed_by_agent_id', agentId)
    .eq('tenant_id', tenantId);

  if (environment) {
    query = query.eq('environment', environment);
  }

  if (requireActive) {
    query = query.eq('status', 'active');
  }

  const { data, error } = await query.maybeSingle();
  if (error || !data) return null;
  return data;
}

// ============================================
// GET /agents/:agentId/wallet
// Story 18.2: Get agent's wallet (convenience)
// ============================================

agentWallets.get('/:agentId/wallet', async (c) => {
  const ctx = c.get('ctx');
  const { agentId } = c.req.param();

  if (!isValidUUID(agentId)) {
    throw new ValidationError('Invalid agent ID format');
  }

  const supabase = createClient();
  const wallet = await getAgentWallet(supabase, agentId, ctx.tenantId, getEnv(ctx));

  if (!wallet) {
    throw new NotFoundError('Agent does not have a wallet');
  }

  return c.json(mapWalletFromDb(wallet));
});

// ============================================
// POST /agents/:agentId/wallet/freeze
// Story 18.2: Freeze agent's wallet
// ============================================

agentWallets.post('/:agentId/wallet/freeze', async (c) => {
  const ctx = c.get('ctx');
  const { agentId } = c.req.param();

  if (!isValidUUID(agentId)) {
    throw new ValidationError('Invalid agent ID format');
  }

  const supabase = createClient();
  const wallet = await getAgentWallet(supabase, agentId, ctx.tenantId, getEnv(ctx));

  if (!wallet) {
    throw new NotFoundError('Agent does not have a wallet');
  }

  if (wallet.status === 'frozen') {
    return c.json(mapWalletFromDb(wallet));
  }

  const { data: updated, error } = await supabase
    .from('wallets')
    .update({ status: 'frozen', updated_at: new Date().toISOString() })
    .eq('id', wallet.id)
    .eq('tenant_id', ctx.tenantId)
    .select()
    .single();

  if (error) throw new Error('Failed to freeze wallet');
  return c.json(mapWalletFromDb(updated));
});

// ============================================
// POST /agents/:agentId/wallet/unfreeze
// Story 18.2: Unfreeze agent's wallet
// ============================================

agentWallets.post('/:agentId/wallet/unfreeze', async (c) => {
  const ctx = c.get('ctx');
  const { agentId } = c.req.param();

  if (!isValidUUID(agentId)) {
    throw new ValidationError('Invalid agent ID format');
  }

  const supabase = createClient();
  const wallet = await getAgentWallet(supabase, agentId, ctx.tenantId, getEnv(ctx));

  if (!wallet) {
    throw new NotFoundError('Agent does not have a wallet');
  }

  if (wallet.status === 'active') {
    return c.json(mapWalletFromDb(wallet));
  }

  const { data: updated, error } = await supabase
    .from('wallets')
    .update({ status: 'active', updated_at: new Date().toISOString() })
    .eq('id', wallet.id)
    .eq('tenant_id', ctx.tenantId)
    .select()
    .single();

  if (error) throw new Error('Failed to unfreeze wallet');
  return c.json(mapWalletFromDb(updated));
});

// ============================================
// PUT /agents/:agentId/wallet/policy
// Story 18.2: Set contract policy on agent's wallet
// ============================================

const setPolicySchema = z.object({
  dailySpendLimit: z.number().positive().optional(),
  monthlySpendLimit: z.number().positive().optional(),
  requiresApprovalAbove: z.number().positive().optional(),
  approvedVendors: z.array(z.string()).optional(),
  approvedCategories: z.array(z.string()).optional(),
  approvedEndpoints: z.array(z.string()).optional(),
  contractPolicy: contractPolicySchema.optional(),
});

agentWallets.put('/:agentId/wallet/policy', async (c) => {
  const ctx = c.get('ctx');
  const { agentId } = c.req.param();

  if (!isValidUUID(agentId)) {
    throw new ValidationError('Invalid agent ID format');
  }

  const body = await c.req.json();
  const parsed = setPolicySchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError('Invalid policy', parsed.error.format());
  }

  const supabase = createClient();
  const wallet = await getAgentWallet(supabase, agentId, ctx.tenantId, getEnv(ctx));

  if (!wallet) {
    throw new NotFoundError('Agent does not have a wallet');
  }

  // Merge with existing policy (keep counters like dailySpent)
  const existingPolicy = wallet.spending_policy || {};
  const mergedPolicy = {
    ...existingPolicy,
    ...parsed.data,
    // Preserve spend counters
    dailySpent: existingPolicy.dailySpent || 0,
    monthlySpent: existingPolicy.monthlySpent || 0,
    dailyResetAt: existingPolicy.dailyResetAt,
    monthlyResetAt: existingPolicy.monthlyResetAt,
  };

  const { data: updated, error } = await supabase
    .from('wallets')
    .update({
      spending_policy: mergedPolicy,
      updated_at: new Date().toISOString(),
    })
    .eq('id', wallet.id)
    .eq('tenant_id', ctx.tenantId)
    .select()
    .single();

  if (error) throw new Error('Failed to update policy');

  invalidatePolicyCache(wallet.id);

  return c.json({
    wallet_id: updated.id,
    spending_policy: updated.spending_policy,
  });
});

// ============================================
// POST /agents/:agentId/wallet/policy/evaluate
// Story 18.9: Negotiation guardrails — dry-run policy evaluation
// ============================================

agentWallets.post('/:agentId/wallet/policy/evaluate', async (c) => {
  const ctx = c.get('ctx');
  const { agentId } = c.req.param();

  if (!isValidUUID(agentId)) {
    throw new ValidationError('Invalid agent ID format');
  }

  const body = await c.req.json();
  const parsed = negotiationEvaluateRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError('Invalid request body', parsed.error.format());
  }

  const supabase = createClient();

  // Find the agent's wallet
  const { data: wallet } = await supabase
    .from('wallets')
    .select('id')
    .eq('managed_by_agent_id', agentId)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .eq('status', 'active')
    .maybeSingle();

  if (!wallet) {
    throw new NotFoundError('Agent does not have an active wallet');
  }

  const engine = createContractPolicyEngine(supabase);
  const result = await engine.evaluate({
    walletId: wallet.id,
    agentId,
    tenantId: ctx.tenantId,
    amount: parsed.data.amount,
    currency: parsed.data.currency,
    actionType: parsed.data.action_type,
    contractType: parsed.data.contract_type,
    counterpartyAgentId: parsed.data.counterparty_agent_id,
    counterpartyAddress: parsed.data.counterparty_address,
    protocol: parsed.data.protocol,
    correlationId: c.get('requestId'),
    dryRun: true,
  });

  return c.json({
    decision: result.decision,
    reasons: result.reasons,
    checks: result.checks,
    suggested_counter_offer: result.suggestedCounterOffer
      ? { max_amount: result.suggestedCounterOffer.maxAmount, reason: result.suggestedCounterOffer.reason }
      : null,
    evaluation_ms: result.evaluationMs,
  });
});

// ============================================
// GET /agents/:agentId/wallet/exposures
// Story 18.8: List counterparty exposures for an agent's wallet
// ============================================

agentWallets.get('/:agentId/wallet/exposures', async (c) => {
  const ctx = c.get('ctx');
  const { agentId } = c.req.param();

  if (!isValidUUID(agentId)) {
    throw new ValidationError('Invalid agent ID format');
  }

  const supabase = createClient();

  const { data: wallet } = await supabase
    .from('wallets')
    .select('id')
    .eq('managed_by_agent_id', agentId)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .eq('status', 'active')
    .maybeSingle();

  if (!wallet) {
    throw new NotFoundError('Agent does not have an active wallet');
  }

  const exposureService = createCounterpartyExposureService(supabase);
  const exposures = await exposureService.listExposures(wallet.id, ctx.tenantId);

  return c.json({
    data: exposures.map((e) => ({
      id: e.id,
      wallet_id: e.walletId,
      counterparty_agent_id: e.counterpartyAgentId,
      counterparty_address: e.counterpartyAddress,
      exposure_24h: e.exposure24h,
      exposure_7d: e.exposure7d,
      exposure_30d: e.exposure30d,
      active_contracts: e.activeContracts,
      active_escrows: e.activeEscrows,
      total_volume: e.totalVolume,
      transaction_count: e.transactionCount,
      currency: e.currency,
    })),
  });
});

// ============================================
// GET /agents/:agentId/wallet/policy/evaluations
// Audit log of policy decisions
// ============================================

agentWallets.get('/:agentId/wallet/policy/evaluations', async (c) => {
  const ctx = c.get('ctx');
  const { agentId } = c.req.param();

  if (!isValidUUID(agentId)) {
    throw new ValidationError('Invalid agent ID format');
  }

  const { page, limit } = getPaginationParams(c);
  const supabase = createClient();

  // Find wallet
  const { data: wallet } = await supabase
    .from('wallets')
    .select('id')
    .eq('managed_by_agent_id', agentId)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .maybeSingle();

  if (!wallet) {
    throw new NotFoundError('Agent does not have a wallet');
  }

  // Query evaluations
  const countQuery = supabase
    .from('policy_evaluations')
    .select('id', { count: 'exact', head: true })
    .eq('wallet_id', wallet.id)
    .eq('tenant_id', ctx.tenantId);

  const dataQuery = supabase
    .from('policy_evaluations')
    .select('*')
    .eq('wallet_id', wallet.id)
    .eq('tenant_id', ctx.tenantId)
    .order('created_at', { ascending: false })
    .range((page - 1) * limit, page * limit - 1);

  const [countResult, dataResult] = await Promise.all([countQuery, dataQuery]);
  const total = countResult.count || 0;

  return c.json({
    data: (dataResult.data || []).map((row: any) => ({
      id: row.id,
      action_type: row.action_type,
      amount: parseFloat(row.amount),
      currency: row.currency,
      contract_type: row.contract_type,
      counterparty_agent_id: row.counterparty_agent_id,
      counterparty_address: row.counterparty_address,
      decision: row.decision,
      decision_reasons: row.decision_reasons,
      suggested_counter_offer: row.suggested_counter_offer,
      checks_performed: row.checks_performed,
      evaluation_ms: row.evaluation_ms,
      created_at: row.created_at,
    })),
    pagination: paginationResponse(page, limit, total),
  });
});

export default agentWallets;
