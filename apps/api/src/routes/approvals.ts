/**
 * Approvals API Routes
 * 
 * Story 18.R2: Approval Workflow Infrastructure
 * 
 * Manages the approval queue for high-value agent payments.
 * Provides endpoints to list, view, approve, and reject pending approvals.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { createClient } from '../db/client.js';
import { authMiddleware } from '../middleware/auth.js';
import { 
  createApprovalWorkflowService,
  type ApprovalStatus,
  type PaymentProtocol
} from '../services/approval-workflow.js';

const app = new Hono();

// Apply auth middleware to all routes
app.use('*', authMiddleware);

// ============================================
// Validation Schemas
// ============================================

const listApprovalsSchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'expired', 'executed']).optional(),
  walletId: z.string().uuid().optional(),
  agentId: z.string().uuid().optional(),
  protocol: z.enum(['x402', 'ap2', 'acp', 'ucp']).optional(),
  limit: z.coerce.number().min(1).max(100).default(50),
  offset: z.coerce.number().min(0).default(0)
});

const approveSchema = z.object({
  reason: z.string().max(500).optional()
});

const rejectSchema = z.object({
  reason: z.string().max(500).optional()
});

// ============================================
// Helper Functions
// ============================================

function mapApprovalToResponse(approval: any) {
  return {
    id: approval.id,
    walletId: approval.walletId,
    agentId: approval.agentId,
    protocol: approval.protocol,
    amount: approval.amount,
    currency: approval.currency,
    recipient: approval.recipient,
    paymentContext: approval.paymentContext,
    status: approval.status,
    expiresAt: approval.expiresAt,
    decidedBy: approval.decidedBy,
    decidedAt: approval.decidedAt,
    decisionReason: approval.decisionReason,
    executedTransferId: approval.executedTransferId,
    executedAt: approval.executedAt,
    executionError: approval.executionError,
    requestedBy: {
      type: approval.requestedByType,
      id: approval.requestedById,
      name: approval.requestedByName
    },
    createdAt: approval.createdAt,
    updatedAt: approval.updatedAt
  };
}

// ============================================
// Routes
// ============================================

/**
 * GET /v1/approvals
 * List approval requests with optional filtering
 */
app.get('/', async (c) => {
  try {
    const ctx = c.get('ctx');
    const query = c.req.query();
    
    // Parse and validate query params
    const params = listApprovalsSchema.parse({
      status: query.status,
      walletId: query.walletId || query.wallet_id,
      agentId: query.agentId || query.agent_id,
      protocol: query.protocol,
      limit: query.limit,
      offset: query.offset
    });

    const supabase = createClient();
    const approvalService = createApprovalWorkflowService(supabase);

    const { data, total } = await approvalService.listApprovals(ctx.tenantId, {
      status: params.status as ApprovalStatus,
      walletId: params.walletId,
      agentId: params.agentId,
      protocol: params.protocol as PaymentProtocol,
      limit: params.limit,
      offset: params.offset
    });

    return c.json({
      data: data.map(mapApprovalToResponse),
      pagination: {
        total,
        limit: params.limit,
        offset: params.offset,
        hasMore: params.offset + data.length < total
      }
    });

  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json({
        error: 'Validation failed',
        details: error.errors
      }, 400);
    }
    console.error('Error in GET /v1/approvals:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * GET /v1/approvals/pending
 * Get pending approvals count and summary
 */
app.get('/pending', async (c) => {
  try {
    const ctx = c.get('ctx');
    const supabase = createClient();
    const approvalService = createApprovalWorkflowService(supabase);

    const { data, total } = await approvalService.listApprovals(ctx.tenantId, {
      status: 'pending',
      limit: 100
    });

    // Calculate summary
    const byProtocol: Record<string, { count: number; totalAmount: number }> = {};
    let totalPendingAmount = 0;

    for (const approval of data) {
      totalPendingAmount += approval.amount;
      
      if (!byProtocol[approval.protocol]) {
        byProtocol[approval.protocol] = { count: 0, totalAmount: 0 };
      }
      byProtocol[approval.protocol].count++;
      byProtocol[approval.protocol].totalAmount += approval.amount;
    }

    return c.json({
      data: {
        count: total,
        totalAmount: totalPendingAmount,
        byProtocol,
        oldestPending: data.length > 0 ? data[data.length - 1].createdAt : null,
        newestPending: data.length > 0 ? data[0].createdAt : null
      }
    });

  } catch (error) {
    console.error('Error in GET /v1/approvals/pending:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * GET /v1/approvals/:id
 * Get a specific approval request
 */
app.get('/:id', async (c) => {
  try {
    const ctx = c.get('ctx');
    const { id } = c.req.param();

    const supabase = createClient();
    const approvalService = createApprovalWorkflowService(supabase);

    const approval = await approvalService.getApproval(id, ctx.tenantId);

    if (!approval) {
      return c.json({ error: 'Approval not found' }, 404);
    }

    return c.json({
      data: mapApprovalToResponse(approval)
    });

  } catch (error) {
    console.error('Error in GET /v1/approvals/:id:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * POST /v1/approvals/:id/approve
 * Approve a pending payment request
 */
app.post('/:id/approve', async (c) => {
  try {
    const ctx = c.get('ctx');
    const { id } = c.req.param();
    const body = await c.req.json().catch(() => ({}));

    const validated = approveSchema.parse(body);

    const supabase = createClient();
    const approvalService = createApprovalWorkflowService(supabase);

    // Determine who is approving
    const decidedBy = ctx.userId || ctx.apiKeyId || 'unknown';

    const approval = await approvalService.decide({
      approvalId: id,
      decision: 'approve',
      decidedBy,
      reason: validated.reason
    });

    return c.json({
      success: true,
      message: 'Payment approved',
      data: mapApprovalToResponse(approval)
    });

  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json({
        error: 'Validation failed',
        details: error.errors
      }, 400);
    }
    if (error instanceof Error) {
      if (error.message === 'Approval not found') {
        return c.json({ error: 'Approval not found' }, 404);
      }
      if (error.message.includes('not pending')) {
        return c.json({ error: error.message }, 400);
      }
      if (error.message === 'Approval has expired') {
        return c.json({ error: 'Approval has expired' }, 410);
      }
    }
    console.error('Error in POST /v1/approvals/:id/approve:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * POST /v1/approvals/:id/reject
 * Reject a pending payment request
 */
app.post('/:id/reject', async (c) => {
  try {
    const ctx = c.get('ctx');
    const { id } = c.req.param();
    const body = await c.req.json().catch(() => ({}));

    const validated = rejectSchema.parse(body);

    const supabase = createClient();
    const approvalService = createApprovalWorkflowService(supabase);

    // Determine who is rejecting
    const decidedBy = ctx.userId || ctx.apiKeyId || 'unknown';

    const approval = await approvalService.decide({
      approvalId: id,
      decision: 'reject',
      decidedBy,
      reason: validated.reason
    });

    return c.json({
      success: true,
      message: 'Payment rejected',
      data: mapApprovalToResponse(approval)
    });

  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json({
        error: 'Validation failed',
        details: error.errors
      }, 400);
    }
    if (error instanceof Error) {
      if (error.message === 'Approval not found') {
        return c.json({ error: 'Approval not found' }, 404);
      }
      if (error.message.includes('not pending')) {
        return c.json({ error: error.message }, 400);
      }
      if (error.message === 'Approval has expired') {
        return c.json({ error: 'Approval has expired' }, 410);
      }
    }
    console.error('Error in POST /v1/approvals/:id/reject:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * POST /v1/approvals/expire
 * Manually trigger expiration of old pending approvals (admin only)
 */
app.post('/expire', async (c) => {
  try {
    const ctx = c.get('ctx');
    
    // Only allow users with admin role (or service calls)
    if (ctx.actorType === 'user' && ctx.userRole !== 'owner' && ctx.userRole !== 'admin') {
      return c.json({ error: 'Admin access required' }, 403);
    }

    const supabase = createClient();
    const approvalService = createApprovalWorkflowService(supabase);

    const expiredCount = await approvalService.expirePendingApprovals();

    return c.json({
      success: true,
      message: `Expired ${expiredCount} pending approvals`,
      data: { expiredCount }
    });

  } catch (error) {
    console.error('Error in POST /v1/approvals/expire:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

export default app;
