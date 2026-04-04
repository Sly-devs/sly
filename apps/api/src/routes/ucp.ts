/**
 * UCP API Routes
 *
 * Authenticated endpoints for UCP settlement operations.
 *
 * @see Story 43.5: Handler Credential Flow
 * @see Story 18.R3: Multi-Protocol Spending Policy Integration
 * @see https://ucp.dev/specification/overview/
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { createClient } from '../db/client.js';
import { ValidationError, NotFoundError } from '../middleware/error.js';
import { ucpMiddleware, getUCPContext } from '../middleware/ucp.js';
import {
  acquireToken,
  getSettlementQuote,
  validateRecipient,
  getCorridors,
  executeSettlement,
  executeSettlementWithMandate,
  getSettlement,
  listSettlements,
  getToken,
} from '../services/ucp/index.js';
import type { UCPTokenRequest, UCPSettleRequest, UCPMandateSettleRequest } from '../services/ucp/types.js';
import { 
  createSpendingPolicyService,
  type PolicyContext 
} from '../services/spending-policy.js';
import {
  createApprovalWorkflowService
} from '../services/approval-workflow.js';
import { trackOp } from '../services/ops/track-op.js';
import { OpType } from '../services/ops/operation-types.js';

const router = new Hono();

// Apply UCP middleware to all routes
router.use('*', ucpMiddleware());

// =============================================================================
// Schemas
// =============================================================================

const pixRecipientSchema = z.object({
  type: z.literal('pix'),
  pix_key: z.string().min(1).max(77),
  pix_key_type: z.enum(['cpf', 'cnpj', 'email', 'phone', 'evp']),
  name: z.string().min(1).max(200),
  tax_id: z.string().optional(),
});

const speiRecipientSchema = z.object({
  type: z.literal('spei'),
  clabe: z.string().regex(/^[0-9]{18}$/),
  name: z.string().min(1).max(200),
  rfc: z.string().optional(),
});

const recipientSchema = z.discriminatedUnion('type', [pixRecipientSchema, speiRecipientSchema]);

const tokenRequestSchema = z.object({
  corridor: z.enum(['pix', 'spei', 'auto']).optional().default('auto'), // Epic 50.3: corridor now optional, defaults to 'auto'
  amount: z.number().positive().max(100000),
  currency: z.enum(['USD', 'USDC']),
  recipient: recipientSchema,
  metadata: z.record(z.unknown()).optional(),
  defer_settlement: z.boolean().optional().default(false), // Epic 50.3: allow deferring settlement to rules engine
});

const settleRequestSchema = z.object({
  token: z.string().min(1),
  idempotency_key: z.string().max(64).optional(),
});

const quoteRequestSchema = z.object({
  corridor: z.enum(['pix', 'spei', 'auto']).optional(), // Epic 50.3: corridor optional for quotes
  amount: z.number().positive().max(100000),
  currency: z.enum(['USD', 'USDC']),
});

// Story 43.6: AP2 Mandate Settlement Schema
// Epic 50.3: corridor now optional, defaults to 'auto' for rules-based settlement
const mandateSettleRequestSchema = z.object({
  mandate_token: z.string().min(1),
  amount: z.number().positive().max(100000),
  currency: z.enum(['USD', 'USDC']),
  corridor: z.enum(['pix', 'spei', 'auto']).optional().default('auto'),
  recipient: recipientSchema,
  idempotency_key: z.string().max(64).optional(),
  defer_settlement: z.boolean().optional().default(false), // Epic 50.3: defer to rules engine
});

// =============================================================================
// Routes
// =============================================================================

/**
 * POST /v1/ucp/tokens
 *
 * Acquire a settlement token for completing a UCP checkout.
 * Token is valid for 15 minutes.
 */
router.post('/tokens', async (c) => {
  const ctx = c.get('ctx');
  const body = await c.req.json();

  // Validate request
  const parsed = tokenRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError('Invalid token request', parsed.error.flatten());
  }

  const request: UCPTokenRequest = {
    corridor: parsed.data.corridor,
    amount: parsed.data.amount,
    currency: parsed.data.currency,
    recipient: parsed.data.recipient as any,
    metadata: parsed.data.metadata,
  };

  try {
    const token = await acquireToken(ctx.tenantId, request);

    // Include UCP negotiated info if available
    const ucpCtx = getUCPContext(c);
    const response: any = token;
    if (ucpCtx?.negotiated) {
      response.ucp = {
        version: ucpCtx.negotiated.version,
        capabilities: ucpCtx.negotiated.capabilities,
      };
    }

    trackOp({
      tenantId: ctx.tenantId,
      operation: OpType.UCP_TOKEN_ACQUIRED,
      subject: `ucp/token/${token.token || token.id || 'unknown'}`,
      actorType: ctx.actorType,
      actorId: ctx.actorId || ctx.userId || ctx.apiKeyId,
      correlationId: c.get('requestId'),
      success: true,
    });

    return c.json(response, 201);
  } catch (error: any) {
    throw new ValidationError(error.message);
  }
});

/**
 * POST /v1/ucp/settle
 *
 * Complete settlement using a previously acquired token.
 * Story 18.R3: Includes spending policy checks for agent wallets.
 */
router.post('/settle', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();
  const body = await c.req.json();

  // Validate request
  const parsed = settleRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError('Invalid settlement request', parsed.error.flatten());
  }

  const request: UCPSettleRequest = {
    token: parsed.data.token,
    idempotency_key: parsed.data.idempotency_key,
  };

  // ============================================
  // SPENDING POLICY CHECK (Story 18.R3)
  // ============================================
  // Get token to extract amount and check wallet policy
  
  const tokenData = getToken(parsed.data.token);
  if (tokenData && tokenData.tenantId === ctx.tenantId) {
    // Try to find wallet if token was created with wallet context
    const walletId = (body as any).wallet_id;
    
    if (walletId) {
      const spendingPolicyService = createSpendingPolicyService(supabase);
      const approvalWorkflowService = createApprovalWorkflowService(supabase);
      
      const policyContext: PolicyContext = {
        protocol: 'ucp',
        vendor: tokenData.recipient?.name,
        metadata: {
          corridor: tokenData.corridor,
          settlement_id: tokenData.settlementId,
        },
      };

      const policyCheck = await spendingPolicyService.checkPolicy(
        walletId,
        tokenData.amount,
        policyContext,
        c.get('requestId')
      );

      if (!policyCheck.allowed) {
        if (policyCheck.requiresApproval) {
          // Create approval request
          const approval = await approvalWorkflowService.createApproval({
            tenantId: ctx.tenantId,
            walletId,
            protocol: 'ucp',
            amount: tokenData.amount,
            currency: tokenData.currency,
            recipient: {
              corridor: tokenData.corridor,
              settlement_id: tokenData.settlementId,
              name: tokenData.recipient?.name,
            },
            paymentContext: {
              token: parsed.data.token,
              corridor: tokenData.corridor,
              recipient: tokenData.recipient,
              quote: tokenData.quote,
              idempotency_key: parsed.data.idempotency_key,
            },
            requestedByType: ctx.actorType,
            requestedById: ctx.userId || ctx.apiKeyId || ctx.actorId || 'unknown',
            requestedByName: ctx.userName || ctx.actorName || undefined,
            correlationId: c.get('requestId'),
          });

          return c.json({
            status: 'pending_approval',
            message: 'Settlement requires approval',
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
          error: {
            code: 'POLICY_VIOLATION',
            message: 'Settlement blocked by spending policy',
            reason: policyCheck.reason,
            violationType: policyCheck.violationType,
          }
        }, 403);
      }
    }
  }

  try {
    const settlement = await executeSettlement(ctx.tenantId, request, supabase);

    // Record spending if we have a wallet (Story 18.R3)
    const walletId = (body as any).wallet_id;
    if (walletId && tokenData) {
      const spendingPolicyService = createSpendingPolicyService(supabase);
      await spendingPolicyService.recordSpending(walletId, tokenData.amount);
    }

    trackOp({
      tenantId: ctx.tenantId,
      operation: OpType.UCP_SETTLEMENT_EXECUTED,
      subject: `ucp/settlement/${settlement.id || settlement.settlement_id || 'unknown'}`,
      actorType: ctx.actorType,
      actorId: ctx.actorId || ctx.userId || ctx.apiKeyId,
      correlationId: c.get('requestId'),
      success: true,
    });

    return c.json(settlement);
  } catch (error: any) {
    // Handle specific error cases
    if (error.message.includes('not found')) {
      throw new NotFoundError('Token', parsed.data.token);
    }
    if (error.message.includes('expired')) {
      return c.json(
        {
          error: {
            code: 'TOKEN_EXPIRED',
            message: 'Settlement token has expired',
          },
        },
        410
      );
    }
    if (error.message.includes('already been used')) {
      return c.json(
        {
          error: {
            code: 'TOKEN_USED',
            message: 'Settlement token has already been used',
          },
        },
        409
      );
    }
    throw new ValidationError(error.message);
  }
});

/**
 * POST /v1/ucp/settle/mandate
 *
 * Complete settlement using an AP2 payment mandate.
 * Supports autonomous agent purchases via dev.ucp.shopping.ap2_mandate extension.
 *
 * @see Story 43.6: AP2 Mandate Support in Handler
 * @see Story 18.R3: Multi-Protocol Spending Policy Integration
 */
router.post('/settle/mandate', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();
  const body = await c.req.json();

  // Validate request
  const parsed = mandateSettleRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError('Invalid mandate settlement request', parsed.error.flatten());
  }

  const request: UCPMandateSettleRequest = {
    mandate_token: parsed.data.mandate_token,
    amount: parsed.data.amount,
    currency: parsed.data.currency,
    corridor: parsed.data.corridor,
    recipient: parsed.data.recipient as any,
    idempotency_key: parsed.data.idempotency_key,
  };

  // ============================================
  // SPENDING POLICY CHECK (Story 18.R3)
  // ============================================
  const walletId = (body as any).wallet_id;
  
  if (walletId) {
    const spendingPolicyService = createSpendingPolicyService(supabase);
    const approvalWorkflowService = createApprovalWorkflowService(supabase);
    
    const policyContext: PolicyContext = {
      protocol: 'ucp',
      vendor: parsed.data.recipient.name,
      mandateId: parsed.data.mandate_token,
      metadata: {
        corridor: parsed.data.corridor,
      },
    };

    const policyCheck = await spendingPolicyService.checkPolicy(
      walletId,
      parsed.data.amount,
      policyContext,
      c.get('requestId')
    );

    if (!policyCheck.allowed) {
      if (policyCheck.requiresApproval) {
        // Create approval request
        const approval = await approvalWorkflowService.createApproval({
          tenantId: ctx.tenantId,
          walletId,
          protocol: 'ucp',
          amount: parsed.data.amount,
          currency: parsed.data.currency,
          recipient: {
            corridor: parsed.data.corridor,
            name: parsed.data.recipient.name,
          },
          paymentContext: {
            mandate_token: parsed.data.mandate_token,
            corridor: parsed.data.corridor,
            recipient: parsed.data.recipient,
            idempotency_key: parsed.data.idempotency_key,
          },
          requestedByType: ctx.actorType,
          requestedById: ctx.userId || ctx.apiKeyId || ctx.actorId || 'unknown',
          requestedByName: ctx.userName || ctx.actorName || undefined,
          correlationId: c.get('requestId'),
        });

        return c.json({
          status: 'pending_approval',
          message: 'Settlement requires approval',
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
        error: {
          code: 'POLICY_VIOLATION',
          message: 'Settlement blocked by spending policy',
          reason: policyCheck.reason,
          violationType: policyCheck.violationType,
        }
      }, 403);
    }
  }

  try {
    const settlement = await executeSettlementWithMandate(ctx.tenantId, request, supabase);

    // Record spending if we have a wallet (Story 18.R3)
    if (walletId) {
      const spendingPolicyService = createSpendingPolicyService(supabase);
      await spendingPolicyService.recordSpending(walletId, parsed.data.amount);
    }

    trackOp({
      tenantId: ctx.tenantId,
      operation: OpType.UCP_SETTLEMENT_EXECUTED,
      subject: `ucp/settlement/${settlement.id || settlement.settlement_id || 'unknown'}`,
      actorType: ctx.actorType,
      actorId: ctx.actorId || ctx.userId || ctx.apiKeyId,
      correlationId: c.get('requestId'),
      success: true,
    });

    return c.json(settlement);
  } catch (error: any) {
    // Handle specific error cases
    if (error.message.includes('Mandate not found')) {
      return c.json(
        {
          error: {
            code: 'MANDATE_NOT_FOUND',
            message: 'AP2 mandate not found',
          },
        },
        404
      );
    }
    if (error.message.includes('Mandate invalid')) {
      return c.json(
        {
          error: {
            code: 'MANDATE_INVALID',
            message: error.message,
          },
        },
        400
      );
    }
    if (error.message.includes('exceeds mandate limit')) {
      return c.json(
        {
          error: {
            code: 'AMOUNT_EXCEEDED',
            message: error.message,
          },
        },
        400
      );
    }
    if (error.message.includes('does not match mandate currency')) {
      return c.json(
        {
          error: {
            code: 'CURRENCY_MISMATCH',
            message: error.message,
          },
        },
        400
      );
    }
    throw new ValidationError(error.message);
  }
});

/**
 * GET /v1/ucp/settlements/:id
 *
 * Get settlement status by ID.
 */
router.get('/settlements/:id', async (c) => {
  const ctx = c.get('ctx');
  const settlementId = c.req.param('id');
  const supabase = createClient();

  const settlement = await getSettlement(settlementId, ctx.tenantId, supabase);
  if (!settlement) {
    throw new NotFoundError('Settlement', settlementId);
  }

  return c.json(settlement);
});

/**
 * GET /v1/ucp/settlements
 *
 * List settlements for the tenant.
 */
router.get('/settlements', async (c) => {
  const ctx = c.get('ctx');
  const query = c.req.query();
  const supabase = createClient();

  const status = query.status as string | undefined;
  const corridor = query.corridor as string | undefined;
  const limit = query.limit ? parseInt(query.limit) : 20;
  const offset = query.offset ? parseInt(query.offset) : 0;

  const result = await listSettlements(ctx.tenantId, {
    status,
    corridor,
    limit: Math.min(limit, 100),
    offset,
  }, supabase);

  return c.json({
    data: result.data,
    pagination: {
      limit,
      offset,
      total: result.total,
    },
  });
});

/**
 * POST /v1/ucp/quote
 *
 * Get an FX quote for a settlement corridor.
 */
router.post('/quote', async (c) => {
  const body = await c.req.json();

  // Validate request
  const parsed = quoteRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError('Invalid quote request', parsed.error.flatten());
  }

  const quote = getSettlementQuote(
    parsed.data.amount,
    parsed.data.currency,
    parsed.data.corridor
  );

  // Add expiration (quotes valid for 30 seconds)
  const expiresAt = new Date(Date.now() + 30 * 1000);

  return c.json({
    from_amount: quote.fromAmount,
    from_currency: quote.fromCurrency,
    to_amount: quote.toAmount,
    to_currency: quote.toCurrency,
    fx_rate: quote.fxRate,
    fees: quote.fees,
    expires_at: expiresAt.toISOString(),
  });
});

/**
 * GET /v1/ucp/corridors
 *
 * List available settlement corridors.
 */
router.get('/corridors', (c) => {
  const corridors = getCorridors();

  return c.json({
    corridors: corridors.map((corridor) => ({
      id: corridor.id,
      name: corridor.name,
      source_currency: corridor.source_currency,
      destination_currency: corridor.destination_currency,
      destination_country: corridor.destination_country,
      rail: corridor.rail,
      estimated_settlement: corridor.estimated_settlement,
    })),
  });
});

/**
 * GET /v1/ucp/info
 *
 * Get UCP handler information.
 */
router.get('/info', (c) => {
  const ucpCtx = getUCPContext(c);

  return c.json({
    handler: {
      id: 'sly_latam',
      name: 'com.payos.latam_settlement',
      version: '2026-01-11',
    },
    supported_corridors: ['pix', 'spei'],
    supported_currencies: ['USD', 'USDC'],
    token_expiry_seconds: 900, // 15 minutes
    ucp: ucpCtx?.agent
      ? {
          agent: ucpCtx.agent.name,
          version: ucpCtx.agent.version,
        }
      : undefined,
  });
});

/**
 * GET /v1/ucp/analytics
 *
 * Get UCP settlement analytics.
 */
router.get('/analytics', async (c) => {
  const ctx = c.get('ctx');
  const query = c.req.query();
  const period = query.period || '30d';
  const supabase = createClient();

  // Calculate date range based on period
  const now = new Date();
  let startDate: Date;
  switch (period) {
    case '24h':
      startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      break;
    case '7d':
      startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    case '90d':
      startDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
      break;
    case '1y':
      startDate = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
      break;
    case '30d':
    default:
      startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  }

  // Get all settlements for analytics
  const result = await listSettlements(ctx.tenantId, {
    limit: 1000,
    offset: 0,
  }, supabase);

  // Filter by date range
  const settlements = result.data.filter(s => new Date(s.created_at) >= startDate);

  // Calculate analytics
  const completed = settlements.filter(s => s.status === 'completed');
  const failed = settlements.filter(s => s.status === 'failed');
  const pending = settlements.filter(s => s.status === 'pending' || s.status === 'processing');
  const deferred = settlements.filter(s => s.status === 'deferred');

  const pixSettlements = settlements.filter(s => s.corridor === 'pix');
  const speiSettlements = settlements.filter(s => s.corridor === 'spei');

  const totalVolume = completed.reduce((sum, s) => sum + s.amount.source, 0);
  const totalFees = completed.reduce((sum, s) => sum + s.amount.fees, 0);

  // Calculate average settlement time (in seconds) for completed settlements
  let avgSettlementTime = 0;
  if (completed.length > 0) {
    const times = completed
      .filter(s => s.completed_at)
      .map(s => new Date(s.completed_at!).getTime() - new Date(s.created_at).getTime());
    if (times.length > 0) {
      avgSettlementTime = Math.round(times.reduce((a, b) => a + b, 0) / times.length / 1000);
    }
  }

  return c.json({
    data: {
      period,
      summary: {
        totalVolume,
        totalSettlements: settlements.length,
        completedSettlements: completed.length,
        failedSettlements: failed.length,
        pendingSettlements: pending.length + deferred.length,
        averageSettlementTime: avgSettlementTime,
        totalFees,
      },
      byStatus: {
        pending: pending.filter(s => s.status === 'pending').length,
        processing: pending.filter(s => s.status === 'processing').length,
        completed: completed.length,
        failed: failed.length,
        deferred: deferred.length,
      },
      byCorridor: {
        pix: {
          count: pixSettlements.length,
          volume: pixSettlements.filter(s => s.status === 'completed').reduce((sum, s) => sum + s.amount.source, 0),
        },
        spei: {
          count: speiSettlements.length,
          volume: speiSettlements.filter(s => s.status === 'completed').reduce((sum, s) => sum + s.amount.source, 0),
        },
      },
      startDate: startDate.toISOString(),
      endDate: now.toISOString(),
    },
  });
});

export default router;
