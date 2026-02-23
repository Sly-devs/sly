/**
 * UCP Checkout Routes
 *
 * REST API for UCP checkout capability.
 *
 * Endpoints:
 * - POST   /v1/ucp/checkouts           - Create checkout session
 * - GET    /v1/ucp/checkouts           - List checkouts
 * - GET    /v1/ucp/checkouts/:id       - Get checkout
 * - PUT    /v1/ucp/checkouts/:id       - Update checkout
 * - POST   /v1/ucp/checkouts/:id/complete - Complete checkout
 * - POST   /v1/ucp/checkouts/:id/cancel   - Cancel checkout
 * - POST   /v1/ucp/checkouts/:id/instruments - Add payment instrument
 * - PUT    /v1/ucp/checkouts/:id/instruments/:instrumentId - Select instrument
 *
 * @see Story 43.2: Checkout Capability
 * @see https://ucp.dev/specification/checkout/
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { RequestContext } from '../middleware/auth.js';
import {
  createCheckout,
  getCheckout,
  updateCheckout,
  completeCheckout,
  cancelCheckout,
  deleteCheckout,
  listCheckouts,
  addPaymentInstrument,
  selectPaymentInstrument,
  type CreateCheckoutRequest,
  type UpdateCheckoutRequest,
  type CheckoutStatus,
} from '../services/ucp/index.js';
import { createClient } from '../db/client.js';
import { getCircleFXService } from '../services/circle/fx.js';
import { createCheckoutTelemetryService } from '../services/telemetry/checkout-telemetry.js';

// =============================================================================
// Validation Schemas
// =============================================================================

const LineItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  quantity: z.number().int().positive(),
  unit_price: z.number().int().min(0),
  total_price: z.number().int().min(0),
  currency: z.string().length(3).optional(),
  image_url: z.string().url().optional(),
  product_url: z.string().url().optional(),
});

const AddressSchema = z.object({
  line1: z.string().min(1),
  line2: z.string().optional(),
  city: z.string().min(1),
  state: z.string().optional(),
  postal_code: z.string().min(1),
  country: z.string().length(2),
});

const BuyerSchema = z.object({
  email: z.string().email().optional(),
  name: z.string().optional(),
  phone: z.string().optional(),
});

const PaymentConfigSchema = z.object({
  handlers: z.array(z.string()).optional(),
  default_handler: z.string().optional(),
  capture_method: z.enum(['automatic', 'manual']).optional(),
});

const LinkSchema = z.object({
  rel: z.string().min(1),
  href: z.string().url(),
  title: z.string().optional(),
});

const PaymentInstrumentSchema = z.object({
  id: z.string().min(1),
  handler: z.string().min(1),
  type: z.string().min(1),
  last4: z.string().optional(),
  brand: z.string().optional(),
  created_at: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const CreateCheckoutSchema = z.object({
  currency: z.string().length(3),
  line_items: z.array(LineItemSchema).optional(),
  buyer: BuyerSchema.optional(),
  shipping_address: AddressSchema.optional(),
  billing_address: AddressSchema.optional(),
  payment_config: PaymentConfigSchema.optional(),
  payment_instruments: z.array(PaymentInstrumentSchema).optional(),
  checkout_type: z.enum(['physical', 'digital', 'service']).optional(),
  continue_url: z.string().url().optional(),
  cancel_url: z.string().url().optional(),
  links: z.array(LinkSchema).optional(),
  metadata: z.record(z.unknown()).optional(),
  expires_in_hours: z.number().int().min(1).max(168).optional(), // 1 hour to 1 week
  agent_id: z.string().optional(),
});

const UpdateCheckoutSchema = z.object({
  line_items: z.array(LineItemSchema).optional(),
  buyer: BuyerSchema.optional(),
  shipping_address: AddressSchema.nullable().optional(),
  billing_address: AddressSchema.nullable().optional(),
  payment_instruments: z.array(z.object({
    id: z.string(),
    handler: z.string(),
    type: z.string(),
    last4: z.string().optional(),
    brand: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
  })).optional(),
  selected_instrument_id: z.string().nullable().optional(),
  continue_url: z.string().url().optional(),
  cancel_url: z.string().url().optional(),
  metadata: z.record(z.unknown()).optional(),
});

// =============================================================================
// Router
// =============================================================================

const router = new Hono<{ Variables: { ctx: RequestContext } }>();

/**
 * POST /v1/ucp/checkouts
 * Create a new checkout session
 */
router.post('/', async (c) => {
  const ctx = c.get('ctx');

  // Parse and validate request body
  let body: z.infer<typeof CreateCheckoutSchema>;
  try {
    const rawBody = await c.req.json();
    body = CreateCheckoutSchema.parse(rawBody);
  } catch (error: any) {
    return c.json({ error: 'Invalid request body', details: error.errors || error.message }, 400);
  }

  try {
    const supabase = createClient();
    const checkout = await createCheckout(ctx.tenantId, body as CreateCheckoutRequest, supabase);

    return c.json(checkout, 201);
  } catch (error: any) {
    if (error.message?.startsWith('Agent not found')) {
      return c.json({ error: error.message }, 400);
    }
    console.error('[UCP Checkout] Create error:', error);
    const supabase = createClient();
    const telemetry = createCheckoutTelemetryService(supabase);
    telemetry.record({
      protocol: 'ucp',
      event_type: 'checkout.create_failed',
      success: false,
      failure_reason: error.message || 'Failed to create checkout',
      failure_code: 'CREATE_FAILED',
      agent_id: body.agent_id,
      currency: body.currency,
    });
    return c.json({ error: error.message || 'Failed to create checkout' }, 500);
  }
});

/**
 * GET /v1/ucp/checkouts
 * List checkouts for the tenant
 */
router.get('/', async (c) => {
  const ctx = c.get('ctx');

  const status = c.req.query('status') as CheckoutStatus | undefined;
  const agent_id = c.req.query('agent_id') || undefined;
  const limit = parseInt(c.req.query('limit') || '20', 10);
  const offset = parseInt(c.req.query('offset') || '0', 10);

  try {
    const supabase = createClient();
    const result = await listCheckouts(ctx.tenantId, { status, agent_id, limit, offset }, supabase);

    return c.json({
      data: result.data,
      pagination: {
        limit,
        offset,
        total: result.total,
        total_pages: Math.ceil(result.total / limit),
      },
    });
  } catch (error: any) {
    console.error('[UCP Checkout] List error:', error);
    return c.json({ error: error.message || 'Failed to list checkouts' }, 500);
  }
});

/**
 * GET /v1/ucp/checkouts/stats
 * Get aggregate checkout stats with FX-normalized USD volume
 */
router.get('/stats', async (c) => {
  const ctx = c.get('ctx');

  try {
    const supabase = createClient();
    const { data, error } = await supabase
      .from('ucp_checkout_sessions')
      .select('currency, totals, status')
      .eq('tenant_id', ctx.tenantId);

    if (error) {
      return c.json({ error: 'Failed to fetch checkout stats' }, 500);
    }

    const fxService = getCircleFXService();
    let totalVolumeUsd = 0;
    let totalCheckouts = data?.length || 0;
    let completedCheckouts = 0;

    for (const row of data || []) {
      if (row.status === 'completed') completedCheckouts++;

      const totalEntry = (row.totals as any[])?.find((t: any) => t.type === 'total');
      if (!totalEntry) continue;

      const majorUnits = totalEntry.amount / 100;
      const currency = (row.currency || 'USD').toUpperCase();
      try {
        totalVolumeUsd += fxService.toUSD(majorUnits, currency);
      } catch {
        // Unknown currency — skip FX conversion, use raw amount
        totalVolumeUsd += majorUnits;
      }
    }

    return c.json({
      total_checkouts: totalCheckouts,
      completed_checkouts: completedCheckouts,
      total_volume_usd: parseFloat(totalVolumeUsd.toFixed(2)),
    });
  } catch (error: any) {
    console.error('[UCP Checkout] Stats error:', error);
    return c.json({ error: 'Failed to get stats' }, 500);
  }
});

const MAX_BATCH_SIZE = 100;

const BatchCreateSchema = z.object({
  checkouts: z.array(CreateCheckoutSchema).min(1).max(MAX_BATCH_SIZE),
  auto_complete: z.boolean().optional().default(false),
  default_payment_instrument: PaymentInstrumentSchema.optional(),
});

/**
 * POST /v1/ucp/checkouts/batch
 * Batch-create multiple checkout sessions in one call.
 * Optionally auto-complete checkouts that reach ready_for_complete.
 * Max batch size: 100
 */
router.post('/batch', async (c) => {
  const ctx = c.get('ctx');

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const parsed = BatchCreateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      error: 'Validation failed',
      details: parsed.error.errors.map(e => ({ path: e.path.join('.'), message: e.message })),
    }, 400);
  }

  const { checkouts, auto_complete, default_payment_instrument } = parsed.data;
  const supabase = createClient();
  const results: Array<{ checkout_id: string; order_id?: string; status: string; error?: string }> = [];

  for (const spec of checkouts) {
    try {
      // Merge default_payment_instrument if checkout has no payment_instruments
      const checkoutSpec: CreateCheckoutRequest = {
        ...spec,
        payment_instruments: spec.payment_instruments?.length
          ? spec.payment_instruments
          : default_payment_instrument
            ? [default_payment_instrument]
            : undefined,
      } as CreateCheckoutRequest;

      const checkout = await createCheckout(ctx.tenantId, checkoutSpec, supabase);

      // Auto-complete if requested and checkout is ready
      if (auto_complete && checkout.status === 'ready_for_complete') {
        try {
          const completed = await completeCheckout(ctx.tenantId, checkout.id, supabase);
          results.push({
            checkout_id: completed.id,
            order_id: completed.order_id || undefined,
            status: completed.status,
          });
        } catch (completeErr: any) {
          // Created but failed to complete
          results.push({
            checkout_id: checkout.id,
            status: checkout.status,
            error: `Auto-complete failed: ${completeErr.message}`,
          });
        }
      } else {
        results.push({
          checkout_id: checkout.id,
          order_id: checkout.order_id || undefined,
          status: checkout.status,
        });
      }
    } catch (err: any) {
      console.error('[UCP Batch Create] Item error:', err);
      results.push({
        checkout_id: 'failed',
        status: 'error',
        error: err.message || 'Failed to create checkout',
      });
    }
  }

  return c.json({
    total: checkouts.length,
    created: results.filter(r => r.status !== 'error').length,
    completed: results.filter(r => r.status === 'completed').length,
    failed: results.filter(r => r.status === 'error' || r.error).length,
    results,
  });
});

const BatchCompleteSchema = z.union([
  z.object({
    checkout_ids: z.array(z.string().min(1)).min(1).max(MAX_BATCH_SIZE),
    default_payment_instrument: PaymentInstrumentSchema,
  }),
  z.object({
    checkouts: z.array(z.object({
      checkout_id: z.string().min(1),
      payment_instrument: PaymentInstrumentSchema,
    })).min(1).max(MAX_BATCH_SIZE),
  }),
]);

/**
 * POST /v1/ucp/checkouts/batch-complete
 * Batch-complete multiple pending checkouts — add payment instrument + complete in one call.
 * Supports two request shapes:
 *   1. { checkout_ids, default_payment_instrument } — same instrument for all
 *   2. { checkouts: [{ checkout_id, payment_instrument }] } — per-checkout instrument
 * Max batch size: 100
 */
router.post('/batch-complete', async (c) => {
  const ctx = c.get('ctx');

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const parsed = BatchCompleteSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      error: 'Validation failed',
      details: parsed.error.errors.map(e => ({ path: e.path.join('.'), message: e.message })),
    }, 400);
  }

  // Normalise into array of { checkout_id, payment_instrument }
  type Item = { checkout_id: string; payment_instrument: { id: string; handler: string; type: string } };
  let items: Item[];

  const validated = parsed.data;
  if ('checkouts' in validated) {
    items = validated.checkouts;
  } else {
    items = validated.checkout_ids.map((id) => ({
      checkout_id: id,
      payment_instrument: validated.default_payment_instrument,
    }));
  }

  const supabase = createClient();
  const results: Array<{ checkout_id: string; order_id?: string; status: string; error?: string }> = [];

  for (const item of items) {
    try {
      // Add payment instrument
      await addPaymentInstrument(ctx.tenantId, item.checkout_id, {
        id: item.payment_instrument.id,
        handler: item.payment_instrument.handler,
        type: item.payment_instrument.type,
      }, supabase);

      // Complete checkout
      const completed = await completeCheckout(ctx.tenantId, item.checkout_id, supabase);
      results.push({
        checkout_id: completed.id,
        order_id: completed.order_id || undefined,
        status: completed.status,
      });
    } catch (err: any) {
      console.error(`[UCP Batch] Failed to complete ${item.checkout_id}:`, err);
      results.push({
        checkout_id: item.checkout_id,
        status: 'failed',
        error: 'Failed to complete checkout',
      });
    }
  }

  return c.json({
    total: items.length,
    completed: results.filter(r => r.status === 'completed').length,
    failed: results.filter(r => r.status === 'failed' || r.error).length,
    results,
  });
});

/**
 * GET /v1/ucp/checkouts/:id
 * Get checkout by ID
 */
router.get('/:id', async (c) => {
  const ctx = c.get('ctx');
  const checkoutId = c.req.param('id');

  try {
    const supabase = createClient();
    const checkout = await getCheckout(ctx.tenantId, checkoutId, supabase);

    if (!checkout) {
      return c.json({ error: 'Checkout not found' }, 404);
    }

    return c.json(checkout);
  } catch (error: any) {
    console.error('[UCP Checkout] Get error:', error);
    return c.json({ error: error.message || 'Failed to get checkout' }, 500);
  }
});

/**
 * PUT /v1/ucp/checkouts/:id
 * Update checkout
 */
router.put('/:id', async (c) => {
  const ctx = c.get('ctx');
  const checkoutId = c.req.param('id');

  // Parse and validate request body
  let body: z.infer<typeof UpdateCheckoutSchema>;
  try {
    const rawBody = await c.req.json();
    body = UpdateCheckoutSchema.parse(rawBody);
  } catch (error: any) {
    return c.json({ error: 'Invalid request body', details: error.errors || error.message }, 400);
  }

  try {
    const supabase = createClient();
    const checkout = await updateCheckout(ctx.tenantId, checkoutId, body as UpdateCheckoutRequest, supabase);

    return c.json(checkout);
  } catch (error: any) {
    if (error.message === 'Checkout not found') {
      return c.json({ error: 'Checkout not found' }, 404);
    }
    if (error.message.includes('Cannot modify')) {
      return c.json({ error: error.message }, 409);
    }
    console.error('[UCP Checkout] Update error:', error);
    return c.json({ error: error.message || 'Failed to update checkout' }, 500);
  }
});

/**
 * POST /v1/ucp/checkouts/:id/complete
 * Complete checkout - process payment and create order
 */
router.post('/:id/complete', async (c) => {
  const ctx = c.get('ctx');
  const checkoutId = c.req.param('id');

  try {
    const supabase = createClient();
    const checkout = await completeCheckout(ctx.tenantId, checkoutId, supabase);

    // Record successful checkout telemetry
    const telemetry = createCheckoutTelemetryService(supabase);
    telemetry.record({
      protocol: 'ucp',
      event_type: 'checkout.completed',
      success: true,
      agent_id: checkout.agent_id,
      currency: checkout.currency,
      protocol_metadata: { checkout_id: checkoutId },
    });

    return c.json(checkout);
  } catch (error: any) {
    if (error.message === 'Checkout not found') {
      return c.json({ error: 'Checkout not found' }, 404);
    }
    if (error.message.includes('Cannot complete')) {
      return c.json({ error: error.message }, 409);
    }
    if (error.message.includes('Payment failed')) {
      const supabase = createClient();
      const telemetry = createCheckoutTelemetryService(supabase);
      telemetry.record({
        protocol: 'ucp',
        event_type: 'checkout.complete_failed',
        success: false,
        failure_reason: error.message,
        failure_code: 'PAYMENT_FAILED',
        protocol_metadata: { checkout_id: checkoutId },
      });
      return c.json({ error: error.message }, 402); // Payment Required
    }
    console.error('[UCP Checkout] Complete error:', error);
    const supabase = createClient();
    const telemetry = createCheckoutTelemetryService(supabase);
    telemetry.record({
      protocol: 'ucp',
      event_type: 'checkout.complete_failed',
      success: false,
      failure_reason: error.message || 'Failed to complete checkout',
      failure_code: 'COMPLETE_FAILED',
      protocol_metadata: { checkout_id: checkoutId },
    });
    return c.json({ error: error.message || 'Failed to complete checkout' }, 500);
  }
});

/**
 * POST /v1/ucp/checkouts/:id/cancel
 * Cancel checkout
 */
router.post('/:id/cancel', async (c) => {
  const ctx = c.get('ctx');
  const checkoutId = c.req.param('id');

  try {
    const supabase = createClient();
    const checkout = await cancelCheckout(ctx.tenantId, checkoutId, supabase);

    return c.json(checkout);
  } catch (error: any) {
    if (error.message === 'Checkout not found') {
      return c.json({ error: 'Checkout not found' }, 404);
    }
    if (error.message.includes('Cannot cancel')) {
      return c.json({ error: error.message }, 409);
    }
    console.error('[UCP Checkout] Cancel error:', error);
    return c.json({ error: error.message || 'Failed to cancel checkout' }, 500);
  }
});

/**
 * PATCH /v1/ucp/checkouts/:id/edit
 * Edit checkout session fields (sandbox/development only — for demo date editing etc.)
 */
router.patch('/:id/edit', async (c) => {
  if (process.env.NODE_ENV === 'production') {
    return c.json({ error: 'Edit is not available in production' }, 403);
  }

  const ctx = c.get('ctx');
  const checkoutId = c.req.param('id');

  let body: Record<string, any>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  try {
    const supabase = createClient();

    // Allowlist of editable fields
    const allowed: Record<string, boolean> = {
      created_at: true,
      updated_at: true,
      status: true,
      currency: true,
      metadata: true,
      line_items: true,
      totals: true,
    };

    const updates: Record<string, any> = {};
    for (const [key, value] of Object.entries(body)) {
      if (allowed[key]) updates[key] = value;
    }

    if (Object.keys(updates).length === 0) {
      return c.json({ error: 'No valid fields to update' }, 400);
    }

    const { data, error } = await supabase
      .from('ucp_checkout_sessions')
      .update(updates)
      .eq('id', checkoutId)
      .eq('tenant_id', ctx.tenantId)
      .select('*')
      .single();

    if (error || !data) {
      return c.json({ error: 'Checkout not found', details: error?.message }, 404);
    }

    return c.json({ data });
  } catch (error: any) {
    console.error('[UCP Checkout] Edit error:', error);
    return c.json({ error: error.message || 'Failed to edit checkout' }, 500);
  }
});

/**
 * DELETE /v1/ucp/checkouts/:id
 * Delete a checkout session (sandbox/development only)
 */
router.delete('/:id', async (c) => {
  if (process.env.NODE_ENV === 'production') {
    return c.json({ error: 'Delete is not available in production' }, 403);
  }

  const ctx = c.get('ctx');
  const checkoutId = c.req.param('id');

  try {
    const supabase = createClient();
    const success = await deleteCheckout(ctx.tenantId, checkoutId, supabase);

    if (!success) {
      return c.json({ error: 'Failed to delete checkout' }, 500);
    }

    return c.json({ success: true });
  } catch (error: any) {
    console.error('[UCP Checkout] Delete error:', error);
    return c.json({ error: error.message || 'Failed to delete checkout' }, 500);
  }
});

/**
 * POST /v1/ucp/checkouts/:id/instruments
 * Add payment instrument to checkout
 */
router.post('/:id/instruments', async (c) => {
  const ctx = c.get('ctx');
  const checkoutId = c.req.param('id');

  // Parse and validate request body
  let body: z.infer<typeof PaymentInstrumentSchema>;
  try {
    const rawBody = await c.req.json();
    body = PaymentInstrumentSchema.parse(rawBody);
  } catch (error: any) {
    return c.json({ error: 'Invalid request body', details: error.errors || error.message }, 400);
  }

  try {
    const supabase = createClient();
    const checkout = await addPaymentInstrument(ctx.tenantId, checkoutId, body, supabase);

    return c.json(checkout);
  } catch (error: any) {
    if (error.message === 'Checkout not found') {
      return c.json({ error: 'Checkout not found' }, 404);
    }
    if (error.message.includes('Cannot modify')) {
      return c.json({ error: error.message }, 409);
    }
    console.error('[UCP Checkout] Add instrument error:', error);
    return c.json({ error: error.message || 'Failed to add payment instrument' }, 500);
  }
});

/**
 * PUT /v1/ucp/checkouts/:id/instruments/:instrumentId
 * Select payment instrument
 */
router.put('/:id/instruments/:instrumentId', async (c) => {
  const ctx = c.get('ctx');
  const checkoutId = c.req.param('id');
  const instrumentId = c.req.param('instrumentId');

  try {
    const supabase = createClient();
    const checkout = await selectPaymentInstrument(ctx.tenantId, checkoutId, instrumentId, supabase);

    return c.json(checkout);
  } catch (error: any) {
    if (error.message === 'Checkout not found') {
      return c.json({ error: 'Checkout not found' }, 404);
    }
    if (error.message === 'Payment instrument not found') {
      return c.json({ error: 'Payment instrument not found' }, 404);
    }
    if (error.message.includes('Cannot modify')) {
      return c.json({ error: error.message }, 409);
    }
    console.error('[UCP Checkout] Select instrument error:', error);
    return c.json({ error: error.message || 'Failed to select payment instrument' }, 500);
  }
});

export default router;
