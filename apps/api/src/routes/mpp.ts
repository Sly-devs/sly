/**
 * MPP (Machine Payments Protocol) Routes
 *
 * Endpoints for governed MPP payments and sessions.
 * Pattern follows apps/api/src/routes/ap2.ts.
 *
 * @see Story 71.8: Session API Endpoints
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { createClient } from '../db/client.js';
import { GovernedMppClient } from '../services/mpp/governed-client.js';
import { MppSessionManager } from '../services/mpp/session-manager.js';
import { MppStreamHandler } from '../services/mpp/stream-handler.js';
import { MppTransferRecorder } from '../services/mpp/transfer-recorder.js';
import { MppWalletProvisioning } from '../services/mpp/wallet-provisioning.js';
import { MppServiceDiscovery } from '../services/mpp/service-discovery.js';
import { MppReceiptReconciler } from '../services/mpp/receipt-reconciler.js';
import { mapTransferFromDb } from '../utils/helpers.js';

const mppRouter = new Hono();

// ============================================
// Validation Schemas
// ============================================

const paySchema = z.object({
  service_url: z.string().url(),
  amount: z.number().positive(),
  currency: z.string().default('USDC'),
  /** Human-readable payment description (preferred) */
  description: z.string().optional(),
  /** @deprecated Use `description` instead — accepted for backward compatibility */
  intent: z.string().optional(),
  agent_id: z.string().uuid(),
  wallet_id: z.string().uuid().optional(),
});

const openSessionSchema = z.object({
  service_url: z.string().url(),
  deposit_amount: z.number().positive(),
  max_budget: z.number().positive().optional(),
  agent_id: z.string().uuid(),
  wallet_id: z.string().uuid(),
  currency: z.string().default('USDC'),
});

const streamSchema = z.object({
  target_url: z.string().url(),
  cost_per_unit: z.number().nonnegative().optional(),
  warning_threshold: z.number().min(0).max(1).optional(),
});

// ============================================
// POST /v1/mpp/pay — One-shot payment
// ============================================

mppRouter.post('/pay', async (c) => {
  const ctx = c.get('ctx');
  const body = await c.req.json();
  const parsed = paySchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const { service_url, amount, currency, description, intent, agent_id, wallet_id } = parsed.data;
  const supabase = createClient();
  const governedClient = new GovernedMppClient(supabase);

  const result = await governedClient.charge({
    serviceUrl: service_url,
    amount,
    currency,
    description: description || intent,
    agentId: agent_id,
    tenantId: ctx.tenantId,
    walletId: wallet_id,
    correlationId: c.get('requestId'),
    actorType: ctx.actorType,
    actorId: ctx.actorType === 'agent' ? ctx.actorId : ctx.userId,
  });

  if (result.requiresApproval) {
    return c.json({
      status: 'approval_required',
      approval_id: result.approvalId,
      message: result.deniedReason,
    }, 202);
  }

  if (!result.executed) {
    const status = result.violationType === 'mpp_client_error' ? 503 : 403;
    return c.json({
      error: status === 503 ? 'MPP service unavailable' : 'Payment denied',
      reason: result.deniedReason,
      violation_type: result.violationType,
    }, status);
  }

  return c.json({
    status: 'completed',
    transfer_id: result.transferId,
    payment: {
      receipt_id: result.payment?.receiptId,
      payment_method: result.payment?.paymentMethod,
      protocol_intent: result.payment?.protocolIntent,
      settlement_network: result.payment?.settlementNetwork,
      settlement_tx_hash: result.payment?.settlementTxHash,
      amount_paid: result.payment?.amountPaid,
      currency: result.payment?.currency,
    },
  });
});

// ============================================
// POST /v1/mpp/sessions — Open session
// ============================================

mppRouter.post('/sessions', async (c) => {
  const ctx = c.get('ctx');
  const body = await c.req.json();
  const parsed = openSessionSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const supabase = createClient();
  const sessionManager = new MppSessionManager(supabase);

  const result = await sessionManager.openSession({
    tenantId: ctx.tenantId,
    agentId: parsed.data.agent_id,
    walletId: parsed.data.wallet_id,
    serviceUrl: parsed.data.service_url,
    depositAmount: parsed.data.deposit_amount,
    maxBudget: parsed.data.max_budget,
    currency: parsed.data.currency,
    correlationId: c.get('requestId'),
  });

  if (!result.success) {
    return c.json({
      error: 'Failed to open session',
      reason: result.deniedReason,
      violation_type: result.violationType,
    }, 403);
  }

  return c.json(result.session, 201);
});

// ============================================
// GET /v1/mpp/sessions — List sessions
// ============================================

mppRouter.get('/sessions', async (c) => {
  const ctx = c.get('ctx');
  const agentId = c.req.query('agent_id');
  const status = c.req.query('status');
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');

  const supabase = createClient();
  const sessionManager = new MppSessionManager(supabase);

  const result = await sessionManager.listSessions(ctx.tenantId, {
    agentId: agentId || undefined,
    status: status as any || undefined,
    limit,
    offset,
  });

  return c.json({
    data: result.data,
    pagination: { limit, offset, total: result.total },
  });
});

// ============================================
// GET /v1/mpp/sessions/:sessionId — Session detail
// ============================================

mppRouter.get('/sessions/:sessionId', async (c) => {
  const ctx = c.get('ctx');
  const sessionId = c.req.param('sessionId');

  const supabase = createClient();
  const sessionManager = new MppSessionManager(supabase);

  const session = await sessionManager.getSession(sessionId, ctx.tenantId);
  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }

  // Also get voucher transfers (map through mapTransferFromDb for consistent camelCase)
  const recorder = new MppTransferRecorder(supabase);
  const rawTransfers = await recorder.getBySession(ctx.tenantId, sessionId);
  const transfers = rawTransfers.map(mapTransferFromDb);

  return c.json({
    ...session,
    vouchers: transfers,
  });
});

// ============================================
// POST /v1/mpp/sessions/:sessionId/voucher — Sign a voucher
// ============================================

const voucherSchema = z.object({
  amount: z.number().positive(),
});

mppRouter.post('/sessions/:sessionId/voucher', async (c) => {
  const ctx = c.get('ctx');
  const sessionId = c.req.param('sessionId');
  const body = await c.req.json();
  const parsed = voucherSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const supabase = createClient();
  const sessionManager = new MppSessionManager(supabase);

  const result = await sessionManager.signVoucher({
    sessionId,
    tenantId: ctx.tenantId,
    amount: parsed.data.amount,
    correlationId: c.get('requestId'),
  });

  if (!result.success) {
    return c.json({
      error: 'Voucher denied',
      reason: result.deniedReason,
      cumulative_spent: result.cumulativeSpent,
      remaining_budget: result.remainingBudget,
    }, 403);
  }

  return c.json({
    voucher_index: result.voucherIndex,
    cumulative_spent: result.cumulativeSpent,
    remaining_budget: result.remainingBudget,
    transfer_id: result.transferId,
  });
});

// ============================================
// POST /v1/mpp/sessions/:sessionId/close — Close session
// ============================================

mppRouter.post('/sessions/:sessionId/close', async (c) => {
  const ctx = c.get('ctx');
  const sessionId = c.req.param('sessionId');

  const supabase = createClient();
  const sessionManager = new MppSessionManager(supabase);

  const result = await sessionManager.closeSession(
    sessionId, ctx.tenantId, c.get('requestId')
  );

  if (!result.success) {
    return c.json({ error: result.error }, 400);
  }

  return c.json(result.session);
});

// ============================================
// POST /v1/mpp/sessions/:sessionId/stream — SSE stream
// ============================================

mppRouter.post('/sessions/:sessionId/stream', async (c) => {
  const ctx = c.get('ctx');
  const sessionId = c.req.param('sessionId');
  const body = await c.req.json();
  const parsed = streamSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const supabase = createClient();
  const streamHandler = new MppStreamHandler(supabase);

  const stream = streamHandler.createStream({
    sessionId,
    tenantId: ctx.tenantId,
    targetUrl: parsed.data.target_url,
    costPerUnit: parsed.data.cost_per_unit,
    warningThreshold: parsed.data.warning_threshold,
    correlationId: c.get('requestId'),
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
});

// ============================================
// GET /v1/mpp/transfers — List MPP transfers
// ============================================

mppRouter.get('/transfers', async (c) => {
  const ctx = c.get('ctx');
  const serviceUrl = c.req.query('service_url');
  const sessionId = c.req.query('session_id');
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');

  const supabase = createClient();
  const recorder = new MppTransferRecorder(supabase);

  if (sessionId) {
    const rawTransfers = await recorder.getBySession(ctx.tenantId, sessionId);
    const transfers = rawTransfers.map(mapTransferFromDb);
    return c.json({ data: transfers, total: transfers.length });
  }

  if (serviceUrl) {
    const rawTransfers = await recorder.getByService(ctx.tenantId, serviceUrl, { limit, offset });
    const transfers = rawTransfers.map(mapTransferFromDb);
    return c.json({ data: transfers, total: transfers.length });
  }

  // Default: all MPP transfers
  const { data, error, count } = await supabase
    .from('transfers')
    .select('*', { count: 'exact' })
    .eq('tenant_id', ctx.tenantId)
    .eq('type', 'mpp')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  return c.json({
    data: (data || []).map(mapTransferFromDb),
    pagination: { limit, offset, total: count || 0 },
  });
});

// ============================================
// POST /v1/mpp/wallets/provision — Provision Tempo wallet
// ============================================

mppRouter.post('/wallets/provision', async (c) => {
  const ctx = c.get('ctx');
  const body = await c.req.json();

  const schema = z.object({
    agent_id: z.string().uuid(),
    owner_account_id: z.string().uuid(),
    testnet: z.boolean().optional(),
    initial_balance: z.number().nonnegative().optional(),
  });

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const supabase = createClient();
  const provisioning = new MppWalletProvisioning(supabase);

  const wallet = await provisioning.provisionTempoWallet({
    tenantId: ctx.tenantId,
    ownerAccountId: parsed.data.owner_account_id,
    agentId: parsed.data.agent_id,
    testnet: parsed.data.testnet,
    initialBalance: parsed.data.initial_balance,
  });

  return c.json(wallet, 201);
});

// ============================================
// GET /v1/mpp/services — Browse MPP directory
// ============================================

mppRouter.get('/services', async (c) => {
  const category = c.req.query('category');
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');

  const discovery = new MppServiceDiscovery();
  const services = await discovery.browseDirectory({ category, limit, offset });

  return c.json({ data: services, total: services.length });
});

// ============================================
// GET /v1/mpp/services/:domain/pricing — Probe service pricing
// ============================================

mppRouter.get('/services/:domain/pricing', async (c) => {
  const domain = c.req.param('domain');

  const discovery = new MppServiceDiscovery();
  const info = await discovery.probePricing(`https://${domain}`);

  if (!info) {
    return c.json({ error: 'Failed to probe service' }, 502);
  }

  return c.json(info);
});

// ============================================
// POST /v1/mpp/receipts/verify — Verify a receipt
// ============================================

mppRouter.post('/receipts/verify', async (c) => {
  const ctx = c.get('ctx');
  const body = await c.req.json();

  const schema = z.object({
    receipt_id: z.string().min(1),
  });

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const supabase = createClient();
  const reconciler = new MppReceiptReconciler(supabase);

  const result = await reconciler.verifyReceipt(parsed.data.receipt_id, ctx.tenantId);
  return c.json(result);
});

// ============================================
// GET /v1/mpp/analytics — Analytics summary
// ============================================

mppRouter.get('/analytics', async (c) => {
  const ctx = c.get('ctx');
  const period = c.req.query('period') || '30d';

  const supabase = createClient();

  // Calculate date range
  const now = new Date();
  let start: Date;
  switch (period) {
    case '24h': start = new Date(now.getTime() - 24 * 60 * 60 * 1000); break;
    case '7d': start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); break;
    case '90d': start = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000); break;
    case '1y': start = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000); break;
    default: start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  }
  const startDate = start.toISOString();
  const endDate = now.toISOString();

  // Fetch MPP transfers in period
  const { data: transfers, count: transferCount } = await supabase
    .from('transfers')
    .select('*', { count: 'exact' })
    .eq('tenant_id', ctx.tenantId)
    .eq('type', 'mpp')
    .gte('created_at', startDate)
    .lte('created_at', endDate);

  const txList = transfers || [];
  const completedTx = txList.filter(t => t.status === 'completed');
  const totalRevenue = completedTx.reduce((sum, t) => sum + (Number(t.amount) || 0), 0);
  const totalFees = completedTx.reduce((sum, t) => sum + (Number(t.fee_amount) || 0), 0);

  const paymentsByStatus = {
    completed: txList.filter(t => t.status === 'completed').length,
    pending: txList.filter(t => t.status === 'pending').length,
    failed: txList.filter(t => t.status === 'failed').length,
  };

  // Unique agents and services from protocol_metadata
  const agentIds = new Set<string>();
  const serviceUrls = new Set<string>();
  for (const t of txList) {
    const meta = t.protocol_metadata as Record<string, any> | null;
    if (meta?.agent_id) agentIds.add(meta.agent_id);
    if (meta?.service_url) serviceUrls.add(meta.service_url);
    if (t.from_account_id) agentIds.add(t.from_account_id);
  }

  // Fetch MPP sessions
  const sessionManager = new MppSessionManager(supabase);
  const allSessions = await sessionManager.listSessions(ctx.tenantId, { limit: 10000, offset: 0 });
  const sessionList = allSessions.data || [];

  const sessionsByStatus = {
    open: sessionList.filter((s: any) => s.status === 'open').length,
    active: sessionList.filter((s: any) => s.status === 'active').length,
    closed: sessionList.filter((s: any) => s.status === 'closed').length,
    exhausted: sessionList.filter((s: any) => s.status === 'exhausted').length,
    error: sessionList.filter((s: any) => s.status === 'error').length,
  };

  const totalDeposited = sessionList.reduce((sum: number, s: any) => sum + (Number(s.depositAmount ?? s.deposit_amount) || 0), 0);
  const totalSpent = sessionList.reduce((sum: number, s: any) => sum + (Number(s.spentAmount ?? s.spent_amount) || 0), 0);
  const budgetUtilization = totalDeposited > 0 ? (totalSpent / totalDeposited) * 100 : 0;

  // Count unique services from sessions too
  for (const s of sessionList) {
    const url = (s as any).serviceUrl || (s as any).service_url;
    if (url) serviceUrls.add(url);
    const aid = (s as any).agentId || (s as any).agent_id;
    if (aid) agentIds.add(aid);
  }

  return c.json({
    period,
    summary: {
      totalRevenue,
      totalFees,
      netRevenue: totalRevenue - totalFees,
      transactionCount: transferCount || txList.length,
      totalSessions: allSessions.total || sessionList.length,
      activeSessions: sessionsByStatus.open + sessionsByStatus.active,
      closedSessions: sessionsByStatus.closed,
      totalDeposited,
      totalSpent,
      budgetUtilization: Math.round(budgetUtilization * 10) / 10,
      uniqueAgents: agentIds.size,
      uniqueServices: serviceUrls.size,
    },
    sessionsByStatus,
    paymentsByStatus,
    startDate,
    endDate,
  });
});

// ============================================
// GET /v1/mpp/reconciliation — Reconcile receipts
// ============================================

mppRouter.get('/reconciliation', async (c) => {
  const ctx = c.get('ctx');
  const startDate = c.req.query('start_date');
  const endDate = c.req.query('end_date');
  const sessionId = c.req.query('session_id');

  const supabase = createClient();
  const reconciler = new MppReceiptReconciler(supabase);

  const results = await reconciler.reconcile(ctx.tenantId, {
    startDate: startDate || undefined,
    endDate: endDate || undefined,
    sessionId: sessionId || undefined,
  });

  return c.json({
    data: results,
    summary: {
      total: results.length,
      matched: results.filter(r => r.status === 'matched').length,
      unmatched: results.filter(r => r.status === 'unmatched').length,
    },
  });
});

export default mppRouter;
