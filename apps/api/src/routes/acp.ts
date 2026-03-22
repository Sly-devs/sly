/**
 * ACP (Agentic Commerce Protocol) API
 * 
 * Stripe/OpenAI's checkout protocol for agentic commerce.
 * Enables agents to manage shopping carts and complete checkout flows.
 * 
 * @module routes/acp
 * @see Story 18.R3: Multi-Protocol Spending Policy Integration
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { createClient } from '../db/client.js';
import { authMiddleware } from '../middleware/auth.js';
import { getStripeClient, isStripeConfigured } from '../services/stripe/index.js';
import {
  createSpendingPolicyService,
  type PolicyContext
} from '../services/spending-policy.js';
import {
  createApprovalWorkflowService
} from '../services/approval-workflow.js';
import { createLimitService } from '../services/limits.js';
import { createCheckoutTelemetryService, extractMerchantDomain } from '../services/telemetry/checkout-telemetry.js';
import { trackOp } from '../services/ops/track-op.js';
import { OpType } from '../services/ops/operation-types.js';
import { getEnv } from '../utils/helpers.js';

const app = new Hono();

// Apply auth middleware
app.use('*', authMiddleware);

// ============================================
// Validation Schemas
// ============================================

const checkoutItemSchema = z.object({
  item_id: z.string().optional(),
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  image_url: z.string().url().optional(),
  quantity: z.number().int().positive(),
  unit_price: z.number().positive(),
  total_price: z.number().positive(),
  currency: z.string().min(3).max(10).optional().default('USDC'),
  item_data: z.record(z.any()).optional(),
});

const createCheckoutSchema = z.object({
  checkout_id: z.string().min(1).max(255),
  session_id: z.string().optional(),
  agent_id: z.string().min(1).max(255),
  agent_name: z.string().min(1).max(255).optional(),
  customer_id: z.string().optional(),
  customer_email: z.string().email().optional(),
  account_id: z.string().uuid(),
  merchant_id: z.string().min(1).max(255),
  merchant_name: z.string().min(1).max(255).optional(),
  merchant_url: z.string().url().optional(),
  items: z.array(checkoutItemSchema).min(1),
  tax_amount: z.number().nonnegative().optional().default(0),
  shipping_amount: z.number().nonnegative().optional().default(0),
  discount_amount: z.number().nonnegative().optional().default(0),
  currency: z.string().min(3).max(10).optional().default('USDC'),
  shared_payment_token: z.string().optional(),
  payment_method: z.string().optional(),
  checkout_data: z.record(z.any()).optional(),
  shipping_address: z.record(z.any()).optional(),
  metadata: z.record(z.any()).optional(),
  expires_at: z.string().datetime().optional(),
});

const completeCheckoutSchema = z.object({
  shared_payment_token: z.string().min(1),
  payment_method: z.string().optional(),
  idempotency_key: z.string().optional(),
});

// ============================================
// Routes
// ============================================

/**
 * POST /v1/acp/checkouts
 * Create a new ACP checkout session
 */
app.post('/checkouts', async (c) => {
  try {
    const ctx = c.get('ctx');
    const body = await c.req.json();
    const validated = createCheckoutSchema.parse(body);

    const supabase = createClient();

    // Check for duplicate checkout_id
    const { data: existing } = await supabase
      .from('acp_checkouts')
      .select('id')
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .eq('checkout_id', validated.checkout_id)
      .single();

    if (existing) {
      return c.json({ error: 'Checkout ID already exists' }, 409);
    }

    // Verify account exists and belongs to tenant
    const { data: account, error: accountError } = await supabase
      .from('accounts')
      .select('id')
      .eq('id', validated.account_id)
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .single();

    if (accountError || !account) {
      const telemetry = createCheckoutTelemetryService(supabase);
      telemetry.record({
        protocol: 'acp',
        event_type: 'checkout.account_not_found',
        success: false,
        merchant_id: validated.merchant_id,
        merchant_domain: validated.merchant_url,
        merchant_name: validated.merchant_name,
        failure_reason: 'Account not found',
        failure_code: 'ACCOUNT_NOT_FOUND',
        agent_id: validated.agent_id,
        agent_name: validated.agent_name,
      });
      return c.json({ error: 'Account not found' }, 404);
    }

    // Calculate totals
    const subtotal = validated.items.reduce((sum, item) => sum + item.total_price, 0);
    const total_amount = subtotal + validated.tax_amount + validated.shipping_amount - validated.discount_amount;

    // Create checkout
    const { data: checkout, error: checkoutError } = await supabase
      .from('acp_checkouts')
      .insert({
        tenant_id: ctx.tenantId,
        environment: getEnv(ctx),
        checkout_id: validated.checkout_id,
        session_id: validated.session_id,
        agent_id: validated.agent_id,
        agent_name: validated.agent_name,
        customer_id: validated.customer_id,
        customer_email: validated.customer_email,
        account_id: validated.account_id,
        merchant_id: validated.merchant_id,
        merchant_name: validated.merchant_name,
        merchant_url: validated.merchant_url,
        subtotal,
        tax_amount: validated.tax_amount,
        shipping_amount: validated.shipping_amount,
        discount_amount: validated.discount_amount,
        total_amount,
        currency: validated.currency,
        shared_payment_token: validated.shared_payment_token,
        payment_method: validated.payment_method,
        checkout_data: validated.checkout_data,
        shipping_address: validated.shipping_address,
        metadata: validated.metadata,
        expires_at: validated.expires_at,
      })
      .select()
      .single();

    if (checkoutError) {
      console.error('[ACP] Create checkout error:', checkoutError);
      const telemetry = createCheckoutTelemetryService(supabase);
      telemetry.record({
        protocol: 'acp',
        event_type: 'checkout.create_failed',
        success: false,
        merchant_id: validated.merchant_id,
        merchant_domain: validated.merchant_url,
        merchant_name: validated.merchant_name,
        failure_reason: 'Failed to create checkout',
        failure_code: 'CREATE_FAILED',
        error_details: { message: checkoutError.message },
        agent_id: validated.agent_id,
        agent_name: validated.agent_name,
        amount: total_amount,
        currency: validated.currency,
      });
      return c.json({ error: 'Failed to create checkout' }, 500);
    }

    // Create checkout items
    const itemsToInsert = validated.items.map(item => ({
      tenant_id: ctx.tenantId,
      checkout_id: checkout.id,
      item_id: item.item_id,
      name: item.name,
      description: item.description,
      image_url: item.image_url,
      quantity: item.quantity,
      unit_price: item.unit_price,
      total_price: item.total_price,
      currency: item.currency,
      item_data: item.item_data,
    }));

    const { data: items, error: itemsError } = await supabase
      .from('acp_checkout_items')
      .insert(itemsToInsert)
      .select();

    if (itemsError) {
      console.error('[ACP] Create checkout items error:', itemsError);
      // Checkout created but items failed - consider rollback
      return c.json({ error: 'Failed to create checkout items' }, 500);
    }

    trackOp({
      tenantId: ctx.tenantId,
      operation: OpType.ACP_CHECKOUT_CREATED,
      subject: `acp/checkout/${checkout.id}`,
      actorType: ctx.actorType,
      actorId: ctx.actorId || ctx.userId || ctx.apiKeyId,
      correlationId: c.get('requestId'),
      success: true,
    });

    return c.json({
      data: {
        id: checkout.id,
        checkout_id: checkout.checkout_id,
        agent_id: checkout.agent_id,
        agent_name: checkout.agent_name,
        merchant_id: checkout.merchant_id,
        merchant_name: checkout.merchant_name,
        subtotal: parseFloat(checkout.subtotal),
        tax_amount: parseFloat(checkout.tax_amount),
        shipping_amount: parseFloat(checkout.shipping_amount),
        discount_amount: parseFloat(checkout.discount_amount),
        total_amount: parseFloat(checkout.total_amount),
        currency: checkout.currency,
        status: checkout.status,
        items: items?.map(item => ({
          id: item.id,
          item_id: item.item_id,
          name: item.name,
          quantity: item.quantity,
          unit_price: parseFloat(item.unit_price),
          total_price: parseFloat(item.total_price),
        })),
        created_at: checkout.created_at,
        expires_at: checkout.expires_at,
      },
    }, 201);
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return c.json({ error: 'Validation failed', details: error.errors }, 400);
    }
    console.error('[ACP] Create checkout error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

const MAX_BATCH_SIZE = 100;

const batchCreateCheckoutSchema = z.object({
  checkouts: z.array(createCheckoutSchema).min(1).max(MAX_BATCH_SIZE),
});

/**
 * POST /v1/acp/checkouts/batch
 * Batch-create multiple ACP checkout sessions in one call.
 * Max batch size: 100
 */
app.post('/checkouts/batch', async (c) => {
  try {
    const ctx = c.get('ctx');
    const body = await c.req.json();
    const validated = batchCreateCheckoutSchema.parse(body);

    const supabase = createClient();
    const results: Array<{ checkout_id?: string; id?: string; status: string; error?: string }> = [];

    // Batch-verify all unique account_ids upfront
    const uniqueAccountIds = [...new Set(validated.checkouts.map(co => co.account_id))];
    const { data: validAccounts } = await supabase
      .from('accounts')
      .select('id')
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .in('id', uniqueAccountIds);
    const validAccountSet = new Set((validAccounts || []).map(a => a.id));

    for (const spec of validated.checkouts) {
      try {
        // Verify account
        if (!validAccountSet.has(spec.account_id)) {
          results.push({
            checkout_id: spec.checkout_id,
            status: 'error',
            error: `Account not found: ${spec.account_id}`,
          });
          continue;
        }

        // Check for duplicate checkout_id
        const { data: existing } = await supabase
          .from('acp_checkouts')
          .select('id')
          .eq('tenant_id', ctx.tenantId)
          .eq('environment', getEnv(ctx))
          .eq('checkout_id', spec.checkout_id)
          .single();

        if (existing) {
          results.push({
            checkout_id: spec.checkout_id,
            status: 'error',
            error: 'Checkout ID already exists',
          });
          continue;
        }

        // Calculate totals
        const subtotal = spec.items.reduce((sum, item) => sum + item.total_price, 0);
        const total_amount = subtotal + (spec.tax_amount ?? 0) + (spec.shipping_amount ?? 0) - (spec.discount_amount ?? 0);

        // Create checkout
        const { data: checkout, error: checkoutError } = await supabase
          .from('acp_checkouts')
          .insert({
            tenant_id: ctx.tenantId,
            environment: getEnv(ctx),
            checkout_id: spec.checkout_id,
            session_id: spec.session_id,
            agent_id: spec.agent_id,
            agent_name: spec.agent_name,
            customer_id: spec.customer_id,
            customer_email: spec.customer_email,
            account_id: spec.account_id,
            merchant_id: spec.merchant_id,
            merchant_name: spec.merchant_name,
            merchant_url: spec.merchant_url,
            subtotal,
            tax_amount: spec.tax_amount ?? 0,
            shipping_amount: spec.shipping_amount ?? 0,
            discount_amount: spec.discount_amount ?? 0,
            total_amount,
            currency: spec.currency,
            shared_payment_token: spec.shared_payment_token,
            payment_method: spec.payment_method,
            checkout_data: spec.checkout_data,
            shipping_address: spec.shipping_address,
            metadata: spec.metadata,
            expires_at: spec.expires_at,
          })
          .select()
          .single();

        if (checkoutError || !checkout) {
          results.push({
            checkout_id: spec.checkout_id,
            status: 'error',
            error: checkoutError?.message || 'Failed to create checkout',
          });
          continue;
        }

        // Create checkout items
        const itemsToInsert = spec.items.map(item => ({
          tenant_id: ctx.tenantId,
          checkout_id: checkout.id,
          item_id: item.item_id,
          name: item.name,
          description: item.description,
          image_url: item.image_url,
          quantity: item.quantity,
          unit_price: item.unit_price,
          total_price: item.total_price,
          currency: item.currency,
          item_data: item.item_data,
        }));

        const { error: itemsError } = await supabase
          .from('acp_checkout_items')
          .insert(itemsToInsert);

        if (itemsError) {
          results.push({
            checkout_id: spec.checkout_id,
            id: checkout.id,
            status: 'error',
            error: 'Created checkout but failed to create items',
          });
          continue;
        }

        results.push({
          checkout_id: spec.checkout_id,
          id: checkout.id,
          status: checkout.status,
        });
      } catch (err: any) {
        console.error('[ACP Batch] Item error:', err);
        results.push({
          checkout_id: spec.checkout_id,
          status: 'error',
          error: err.message || 'Failed to create checkout',
        });
      }
    }

    trackOp({
      tenantId: ctx.tenantId,
      operation: OpType.ACP_BATCH_INITIATED,
      subject: `acp/batch/${validated.checkouts.length}`,
      actorType: ctx.actorType,
      actorId: ctx.actorId || ctx.userId || ctx.apiKeyId,
      correlationId: c.get('requestId'),
      success: true,
    });

    return c.json({
      total: validated.checkouts.length,
      created: results.filter(r => r.status !== 'error').length,
      failed: results.filter(r => r.status === 'error').length,
      results,
    }, 201);
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return c.json({ error: 'Validation failed', details: error.errors }, 400);
    }
    console.error('[ACP] Batch create error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * GET /v1/acp/checkouts
 * List ACP checkouts with optional filters
 */
app.get('/checkouts', async (c) => {
  try {
    const ctx = c.get('ctx');
    const supabase = createClient();

    // Query parameters
    const limit = parseInt(c.req.query('limit') || '20');
    const offset = parseInt(c.req.query('offset') || '0');
    const status = c.req.query('status');
    const agent_id = c.req.query('agent_id');
    const merchant_id = c.req.query('merchant_id');
    const customer_id = c.req.query('customer_id');

    let query = supabase
      .from('acp_checkouts')
      .select('*', { count: 'exact' })
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) query = query.eq('status', status);
    if (agent_id) query = query.eq('agent_id', agent_id);
    if (merchant_id) query = query.eq('merchant_id', merchant_id);
    if (customer_id) query = query.eq('customer_id', customer_id);

    const { data: checkouts, error, count } = await query;

    if (error) {
      console.error('[ACP] List checkouts error:', error);
      return c.json({ error: 'Failed to list checkouts' }, 500);
    }

    // Batch-query item counts for all checkouts
    const checkoutIds = checkouts?.map(co => co.id) || [];
    let itemCounts: Record<string, number> = {};
    if (checkoutIds.length > 0) {
      const { data: items } = await supabase
        .from('acp_checkout_items')
        .select('checkout_id')
        .in('checkout_id', checkoutIds);
      for (const item of items || []) {
        itemCounts[item.checkout_id] = (itemCounts[item.checkout_id] || 0) + 1;
      }
    }

    return c.json({
      data: checkouts?.map(co => ({
        id: co.id,
        checkout_id: co.checkout_id,
        agent_id: co.agent_id,
        agent_name: co.agent_name,
        merchant_id: co.merchant_id,
        merchant_name: co.merchant_name,
        customer_id: co.customer_id,
        customer_email: co.customer_email,
        total_amount: parseFloat(co.total_amount),
        currency: co.currency,
        status: co.status,
        transfer_id: co.transfer_id || null,
        item_count: itemCounts[co.id] || 0,
        created_at: co.created_at,
        completed_at: co.completed_at,
      })) || [],
      pagination: {
        total: count || 0,
        limit,
        offset,
      },
    });
  } catch (error) {
    console.error('[ACP] List checkouts error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * GET /v1/acp/checkouts/:id
 * Get a specific checkout with items
 */
app.get('/checkouts/:id', async (c) => {
  try {
    const ctx = c.get('ctx');
    const { id } = c.req.param();
    const supabase = createClient();

    // Fetch checkout
    const { data: checkout, error: checkoutError } = await supabase
      .from('acp_checkouts')
      .select('*')
      .eq('id', id)
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .single();

    if (checkoutError || !checkout) {
      return c.json({ error: 'Checkout not found' }, 404);
    }

    // Fetch items
    const { data: items } = await supabase
      .from('acp_checkout_items')
      .select('*')
      .eq('checkout_id', id)
      .order('created_at');

    return c.json({
      data: {
        id: checkout.id,
        checkout_id: checkout.checkout_id,
        session_id: checkout.session_id,
        agent_id: checkout.agent_id,
        agent_name: checkout.agent_name,
        customer_id: checkout.customer_id,
        customer_email: checkout.customer_email,
        account_id: checkout.account_id,
        merchant_id: checkout.merchant_id,
        merchant_name: checkout.merchant_name,
        merchant_url: checkout.merchant_url,
        subtotal: parseFloat(checkout.subtotal),
        tax_amount: parseFloat(checkout.tax_amount),
        shipping_amount: parseFloat(checkout.shipping_amount),
        discount_amount: parseFloat(checkout.discount_amount),
        total_amount: parseFloat(checkout.total_amount),
        currency: checkout.currency,
        status: checkout.status,
        shared_payment_token: checkout.shared_payment_token,
        payment_method: checkout.payment_method,
        transfer_id: checkout.transfer_id,
        checkout_data: checkout.checkout_data,
        shipping_address: checkout.shipping_address,
        metadata: checkout.metadata,
        created_at: checkout.created_at,
        updated_at: checkout.updated_at,
        completed_at: checkout.completed_at,
        cancelled_at: checkout.cancelled_at,
        expires_at: checkout.expires_at,
        items: items?.map(item => ({
          id: item.id,
          item_id: item.item_id,
          name: item.name,
          description: item.description,
          image_url: item.image_url,
          quantity: item.quantity,
          unit_price: parseFloat(item.unit_price),
          total_price: parseFloat(item.total_price),
          currency: item.currency,
          item_data: item.item_data,
          created_at: item.created_at,
        })) || [],
      },
    });
  } catch (error) {
    console.error('[ACP] Get checkout error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * POST /v1/acp/checkouts/:id/complete
 * Complete a checkout with SharedPaymentToken and create transfer
 * 
 * This endpoint processes the ACP SharedPaymentToken (SPT) through Stripe
 * and creates the corresponding PayOS transfer record.
 */
app.post('/checkouts/:id/complete', async (c) => {
  try {
    const ctx = c.get('ctx');
    const { id } = c.req.param();
    const body = await c.req.json();
    const validated = completeCheckoutSchema.parse(body);

    const supabase = createClient();

    // Fetch and validate checkout
    const { data: checkout, error: checkoutError } = await supabase
      .from('acp_checkouts')
      .select('*')
      .eq('id', id)
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .single();

    if (checkoutError || !checkout) {
      return c.json({ error: 'Checkout not found' }, 404);
    }

    // Check checkout validity
    const { data: isValid } = await supabase
      .rpc('check_acp_checkout_valid', { p_checkout_id: id });

    if (!isValid) {
      return c.json({
        error: 'Checkout invalid or expired',
        details: {
          status: checkout.status,
          expires_at: checkout.expires_at,
        },
      }, 400);
    }

    // Fetch items for protocol metadata
    const { data: items } = await supabase
      .from('acp_checkout_items')
      .select('name, quantity, unit_price')
      .eq('checkout_id', id);

    // ============================================
    // SPENDING POLICY CHECK (Story 18.R3)
    // ============================================
    // If this checkout is from an agent wallet, check spending policy
    
    // Try to find agent wallet for the agent
    let walletId: string | null = null;
    if (checkout.agent_id) {
      // Look for agent in agents table
      const { data: agent } = await supabase
        .from('agents')
        .select('id')
        .eq('name', checkout.agent_id)
        .eq('tenant_id', ctx.tenantId)
        .eq('environment', getEnv(ctx))
        .single();

      if (agent) {
        // Look for wallet managed by this agent
        const { data: wallet } = await supabase
          .from('wallets')
          .select('id')
          .eq('managed_by_agent_id', agent.id)
          .eq('tenant_id', ctx.tenantId)
          .eq('environment', getEnv(ctx))
          .eq('status', 'active')
          .single();

        if (wallet) {
          walletId = wallet.id;
        }
      }
    }

    // Check spending policy if we have a wallet
    if (walletId) {
      const spendingPolicyService = createSpendingPolicyService(supabase);
      const approvalWorkflowService = createApprovalWorkflowService(supabase);
      
      const checkoutAmount = parseFloat(checkout.total_amount);
      const policyContext: PolicyContext = {
        protocol: 'acp',
        vendor: checkout.merchant_name || checkout.merchant_id,
        merchantId: checkout.merchant_id,
      };

      const policyCheck = await spendingPolicyService.checkPolicy(
        walletId,
        checkoutAmount,
        policyContext,
        c.get('requestId')
      );

      if (!policyCheck.allowed) {
        if (policyCheck.requiresApproval) {
          // Create approval request
          const approval = await approvalWorkflowService.createApproval({
            tenantId: ctx.tenantId,
            walletId,
            protocol: 'acp',
            amount: checkoutAmount,
            currency: checkout.currency,
            recipient: {
              checkout_id: checkout.checkout_id,
              merchant_id: checkout.merchant_id,
              merchant_name: checkout.merchant_name,
            },
            paymentContext: {
              checkout_id: checkout.id,
              checkout_uuid: id,
              merchant_id: checkout.merchant_id,
              merchant_name: checkout.merchant_name,
              agent_id: checkout.agent_id,
              items: items?.map(i => ({
                name: i.name,
                quantity: i.quantity,
                price: parseFloat(i.unit_price),
              })),
              shared_payment_token: validated.shared_payment_token,
            },
            requestedByType: ctx.actorType,
            requestedById: ctx.userId || ctx.apiKeyId || ctx.actorId || 'unknown',
            requestedByName: ctx.userName || ctx.actorName || undefined,
            correlationId: c.get('requestId'),
          });

          return c.json({
            status: 'pending_approval',
            message: 'Checkout requires approval',
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
        const telemetry = createCheckoutTelemetryService(supabase);
        telemetry.record({
          protocol: 'acp',
          event_type: 'checkout.policy_blocked',
          success: false,
          merchant_id: checkout.merchant_id,
          merchant_domain: checkout.merchant_url,
          merchant_name: checkout.merchant_name,
          failure_reason: policyCheck.reason || 'Spending policy violation',
          failure_code: 'POLICY_VIOLATION',
          agent_id: checkout.agent_id,
          agent_name: checkout.agent_name,
          amount: parseFloat(checkout.total_amount),
          currency: checkout.currency,
        });
        return c.json({
          error: 'Checkout blocked by spending policy',
          reason: policyCheck.reason,
          code: 'POLICY_VIOLATION',
          violationType: policyCheck.violationType,
        }, 403);
      }
    }

    // Process SharedPaymentToken through Stripe (if configured)
    let stripePaymentIntent = null;
    let paymentStatus = 'completed';
    
    if (isStripeConfigured()) {
      try {
        const stripe = getStripeClient();
        
        // Convert amount to cents for Stripe (assuming USDC amounts are in dollars)
        const amountInCents = Math.round(parseFloat(checkout.total_amount) * 100);
        
        // Map currency (USDC → USD for Stripe)
        const stripeCurrency = checkout.currency === 'USDC' ? 'usd' : checkout.currency.toLowerCase();
        
        stripePaymentIntent = await stripe.processSharedPaymentToken({
          token: validated.shared_payment_token,
          amount: amountInCents,
          currency: stripeCurrency,
          description: `ACP checkout: ${checkout.merchant_name || checkout.merchant_id}`,
          metadata: {
            checkout_id: checkout.checkout_id,
            payos_checkout_uuid: checkout.id,
            merchant_id: checkout.merchant_id,
            agent_id: checkout.agent_id,
            source: 'acp',
          },
          idempotencyKey: validated.idempotency_key || `acp-${checkout.id}`,
        });
        
        console.log(`[ACP] Stripe PaymentIntent created: ${stripePaymentIntent.id} (${stripePaymentIntent.status})`);
        
        // Set payment status based on Stripe response
        if (stripePaymentIntent.status === 'succeeded') {
          paymentStatus = 'completed';
        } else if (stripePaymentIntent.status === 'requires_action' || stripePaymentIntent.status === 'requires_confirmation') {
          paymentStatus = 'pending';
        } else if (stripePaymentIntent.status === 'processing') {
          paymentStatus = 'processing';
        } else {
          paymentStatus = 'pending';
        }
      } catch (stripeError: any) {
        console.error('[ACP] Stripe payment failed:', stripeError.message);

        // Update checkout with failure
        await supabase
          .from('acp_checkouts')
          .update({
            status: 'failed',
            checkout_data: {
              ...(checkout.checkout_data || {}),
              stripe_error: stripeError.message,
            },
          })
          .eq('id', id);

        const telemetry = createCheckoutTelemetryService(supabase);
        telemetry.record({
          protocol: 'acp',
          event_type: 'checkout.payment_failed',
          success: false,
          merchant_id: checkout.merchant_id,
          merchant_domain: checkout.merchant_url,
          merchant_name: checkout.merchant_name,
          failure_reason: stripeError.message,
          failure_code: 'PAYMENT_FAILED',
          agent_id: checkout.agent_id,
          agent_name: checkout.agent_name,
          amount: parseFloat(checkout.total_amount),
          currency: checkout.currency,
        });

        return c.json({
          error: 'Payment processing failed',
          details: stripeError.message,
        }, 402);
      }
    } else {
      // No Stripe configured - simulate success for demo purposes
      console.log('[ACP] Stripe not configured - simulating payment success');
    }

    // Create transfer record
    const { data: transfer, error: transferError } = await supabase
      .from('transfers')
      .insert({
        tenant_id: ctx.tenantId,
        environment: getEnv(ctx),
        from_account_id: checkout.account_id,
        to_account_id: checkout.account_id, // TODO: Determine recipient from merchant
        amount: checkout.total_amount,
        currency: checkout.currency,
        type: 'acp',
        status: paymentStatus,
        description: `ACP checkout: ${checkout.merchant_name || checkout.merchant_id}`,
        idempotency_key: validated.idempotency_key,
        protocol_metadata: {
          protocol: 'acp',
          checkout_id: checkout.checkout_id,
          merchant_id: checkout.merchant_id,
          merchant_name: checkout.merchant_name,
          agent_id: checkout.agent_id,
          customer_id: checkout.customer_id,
          cart_items: items?.map(i => ({
            name: i.name,
            quantity: i.quantity,
            price: parseFloat(i.unit_price),
          })),
          shared_payment_token: validated.shared_payment_token,
          stripe_payment_intent_id: stripePaymentIntent?.id,
        },
        initiated_by_type: ctx.actorType,
        initiated_by_id: ctx.userId || ctx.apiKeyId || ctx.actorId || 'unknown',
        initiated_by_name: ctx.userName || ctx.actorName || null,
      })
      .select()
      .single();

    if (transferError) {
      console.error('[ACP] Transfer creation error:', transferError);
      return c.json({ error: 'Failed to create transfer' }, 500);
    }

    // Update checkout status
    const { data: updatedCheckout, error: updateError } = await supabase
      .from('acp_checkouts')
      .update({
        status: paymentStatus === 'completed' ? 'completed' : 'processing',
        transfer_id: transfer.id,
        shared_payment_token: validated.shared_payment_token,
        payment_method: validated.payment_method || 'stripe',
        completed_at: paymentStatus === 'completed' ? new Date().toISOString() : null,
        checkout_data: {
          ...(checkout.checkout_data || {}),
          stripe_payment_intent_id: stripePaymentIntent?.id,
          stripe_payment_status: stripePaymentIntent?.status,
        },
      })
      .eq('id', id)
      .select()
      .single();

    if (updateError) {
      console.error('[ACP] Update checkout error:', updateError);
      return c.json({ error: 'Failed to update checkout' }, 500);
    }

    // Record spending if payment completed and we have a wallet (Story 18.R3)
    if (walletId && paymentStatus === 'completed') {
      const spendingPolicyService = createSpendingPolicyService(supabase);
      await spendingPolicyService.recordSpending(walletId, parseFloat(checkout.total_amount));
    }

    // Record agent daily usage when payment completed
    if (paymentStatus === 'completed' && checkout.agent_id) {
      const limitService = createLimitService(supabase, getEnv(ctx) as 'test' | 'live');
      await limitService.recordUsage(checkout.agent_id, parseFloat(checkout.total_amount));
    }

    // Record successful checkout telemetry
    const telemetry = createCheckoutTelemetryService(supabase);
    telemetry.record({
      protocol: 'acp',
      event_type: 'checkout.completed',
      success: true,
      merchant_id: checkout.merchant_id,
      merchant_domain: checkout.merchant_url,
      merchant_name: checkout.merchant_name,
      agent_id: checkout.agent_id,
      agent_name: checkout.agent_name,
      amount: parseFloat(checkout.total_amount),
      currency: checkout.currency,
    });

    trackOp({
      tenantId: ctx.tenantId,
      operation: OpType.ACP_CHECKOUT_COMPLETED,
      subject: `acp/checkout/${id}`,
      actorType: ctx.actorType,
      actorId: ctx.actorId || ctx.userId || ctx.apiKeyId,
      correlationId: c.get('requestId'),
      success: true,
    });

    return c.json({
      data: {
        checkout_id: updatedCheckout.id,
        transfer_id: transfer.id,
        status: updatedCheckout.status,
        payment_status: paymentStatus,
        stripe_payment_intent_id: stripePaymentIntent?.id,
        completed_at: updatedCheckout.completed_at,
        total_amount: parseFloat(updatedCheckout.total_amount),
        currency: updatedCheckout.currency,
      },
    }, 200);
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return c.json({ error: 'Validation failed', details: error.errors }, 400);
    }
    console.error('[ACP] Complete checkout error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * PATCH /v1/acp/checkouts/:id/cancel
 * Cancel a checkout
 */
app.patch('/checkouts/:id/cancel', async (c) => {
  try {
    const ctx = c.get('ctx');
    const { id } = c.req.param();
    const supabase = createClient();

    const { data: checkout, error } = await supabase
      .from('acp_checkouts')
      .update({
        status: 'cancelled',
        cancelled_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .select('id, status, cancelled_at')
      .single();

    if (error || !checkout) {
      return c.json({ error: 'Checkout not found or already completed' }, 404);
    }

    trackOp({
      tenantId: ctx.tenantId,
      operation: OpType.ACP_CHECKOUT_CANCELLED,
      subject: `acp/checkout/${id}`,
      actorType: ctx.actorType,
      actorId: ctx.actorId || ctx.userId || ctx.apiKeyId,
      correlationId: c.get('requestId'),
      success: true,
    });

    return c.json({
      data: checkout,
    });
  } catch (error) {
    console.error('[ACP] Cancel checkout error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * PATCH /v1/acp/checkouts/:id
 * Update checkout fields (sandbox/development only — for demo date editing etc.)
 */
app.patch('/checkouts/:id', async (c) => {
  try {
    if (process.env.NODE_ENV === 'production') {
      return c.json({ error: 'Edit is not available in production' }, 403);
    }

    const ctx = c.get('ctx');
    const { id } = c.req.param();
    const body = await c.req.json();
    const supabase = createClient();

    // Allowlist of editable fields
    const allowed: Record<string, boolean> = {
      created_at: true,
      completed_at: true,
      cancelled_at: true,
      expires_at: true,
      status: true,
      merchant_name: true,
      total_amount: true,
      subtotal: true,
      tax_amount: true,
      shipping_amount: true,
      discount_amount: true,
      payment_method: true,
      checkout_data: true,
    };

    const updates: Record<string, any> = {};
    for (const [key, value] of Object.entries(body)) {
      if (allowed[key]) updates[key] = value;
    }

    if (Object.keys(updates).length === 0) {
      return c.json({ error: 'No valid fields to update' }, 400);
    }

    const { data: checkout, error } = await supabase
      .from('acp_checkouts')
      .update(updates)
      .eq('id', id)
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .select('*')
      .single();

    if (error || !checkout) {
      return c.json({ error: 'Checkout not found', details: error?.message }, 404);
    }

    // If created_at was updated and there's a linked transfer, update it too
    if (updates.created_at && checkout.transfer_id) {
      await supabase.from('transfers').update({ created_at: updates.created_at }).eq('id', checkout.transfer_id);
    }

    // Record agent usage when status changes to completed
    if (updates.status === 'completed' && checkout.agent_id && checkout.total_amount) {
      const limitService = createLimitService(supabase, getEnv(ctx) as 'test' | 'live');
      await limitService.recordUsage(checkout.agent_id, parseFloat(checkout.total_amount));
    }

    return c.json({ data: checkout });
  } catch (error) {
    console.error('[ACP] Update checkout error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * DELETE /v1/acp/checkouts/:id
 * Delete a checkout (sandbox/development only)
 */
app.delete('/checkouts/:id', async (c) => {
  try {
    if (process.env.NODE_ENV === 'production') {
      return c.json({ error: 'Delete is not available in production' }, 403);
    }

    const ctx = c.get('ctx');
    const { id } = c.req.param();
    const supabase = createClient();

    // Verify checkout exists and belongs to tenant
    const { data: checkout, error: fetchErr } = await supabase
      .from('acp_checkouts')
      .select('id, transfer_id')
      .eq('id', id)
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .single();

    if (fetchErr || !checkout) {
      return c.json({ error: 'Checkout not found' }, 404);
    }

    const transferId = checkout.transfer_id;

    // 1. Null out transfer_id FK so the transfer can be deleted later
    if (transferId) {
      await supabase.from('acp_checkouts').update({ transfer_id: null }).eq('id', id);
    }

    // 2. Delete checkout items (also cascades via ON DELETE CASCADE, but be explicit)
    await supabase.from('acp_checkout_items').delete().eq('checkout_id', id);

    // 3. Delete the checkout
    const { error: deleteErr } = await supabase
      .from('acp_checkouts')
      .delete()
      .eq('id', id)
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx));

    if (deleteErr) {
      console.error('[ACP] Delete checkout error:', deleteErr);
      return c.json({ error: 'Failed to delete checkout', details: deleteErr.message }, 500);
    }

    // 4. Clean up orphaned transfer (best-effort)
    if (transferId) {
      // Delete ledger entries and refunds first (they FK → transfers)
      await supabase.from('ledger_entries').delete().eq('reference_id', transferId).eq('tenant_id', ctx.tenantId);
      await supabase.from('refunds').delete().eq('transfer_id', transferId).eq('tenant_id', ctx.tenantId);
      await supabase.from('transfers').delete().eq('id', transferId).eq('tenant_id', ctx.tenantId).eq('environment', getEnv(ctx));
    }

    return c.json({ success: true });
  } catch (error) {
    console.error('[ACP] Delete checkout error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * GET /v1/acp/analytics
 * ACP-specific analytics
 */
app.get('/analytics', async (c) => {
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

    // Fetch ACP transfers
    const { data: transfers } = await supabase
      .from('transfers')
      .select('id, amount, fee_amount, created_at, protocol_metadata')
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .eq('type', 'acp')
      .eq('status', 'completed')
      .gte('created_at', start.toISOString())
      .lte('created_at', end.toISOString());

    // Fetch checkouts
    const { data: checkouts } = await supabase
      .from('acp_checkouts')
      .select('*')
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx));

    const revenue = transfers?.reduce((sum, t) => sum + parseFloat(t.amount), 0) || 0;
    const fees = transfers?.reduce((sum, t) => sum + parseFloat(t.fee_amount || '0'), 0) || 0;

    const completedCheckouts = checkouts?.filter(c => c.status === 'completed').length || 0;
    const pendingCheckouts = checkouts?.filter(c => c.status === 'pending').length || 0;
    const averageOrderValue = completedCheckouts > 0 ? revenue / completedCheckouts : 0;

    // Get unique merchants and agents
    const uniqueMerchants = new Set(checkouts?.map(c => c.merchant_id)).size;
    const uniqueAgents = new Set(checkouts?.map(c => c.agent_id)).size;

    return c.json({
      data: {
        period,
        summary: {
          totalRevenue: parseFloat(revenue.toFixed(8)),
          totalFees: parseFloat(fees.toFixed(8)),
          netRevenue: parseFloat((revenue - fees).toFixed(8)),
          transactionCount: transfers?.length || 0,
          completedCheckouts,
          pendingCheckouts,
          averageOrderValue: parseFloat(averageOrderValue.toFixed(8)),
          uniqueMerchants,
          uniqueAgents,
        },
        checkoutsByStatus: {
          pending: checkouts?.filter(c => c.status === 'pending').length || 0,
          completed: checkouts?.filter(c => c.status === 'completed').length || 0,
          cancelled: checkouts?.filter(c => c.status === 'cancelled').length || 0,
          expired: checkouts?.filter(c => c.status === 'expired').length || 0,
          failed: checkouts?.filter(c => c.status === 'failed').length || 0,
        },
        startDate: start.toISOString(),
        endDate: end.toISOString(),
      },
    });
  } catch (error) {
    console.error('[ACP] Analytics error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

export default app;


