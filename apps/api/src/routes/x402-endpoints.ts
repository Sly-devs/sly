/**
 * x402 Endpoints API Routes
 *
 * Enables API providers to register endpoints that accept x402 payments.
 * Spec: https://www.x402.org/x402-whitepaper.pdf
 *
 * Publish lifecycle (One-Click Publish to Bazaar):
 *  - POST   /:id/validate         dry-run readiness check
 *  - POST   /:id/publish          flip facilitator → CDP, trigger first settle
 *  - POST   /:id/unpublish        revert to internal, set publish_status='unpublished'
 *  - GET    /:id/publish-status   current state + last 50 audit events
 *
 * PATCH on a published endpoint with discovery-relevant changes calls
 * publishEndpoint(force=true) automatically (debounced 5s in-memory).
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { createClient } from '../db/client.js';
import { authMiddleware } from '../middleware/auth.js';
import { trackOp } from '../services/ops/track-op.js';
import { OpType } from '../services/ops/operation-types.js';
import { getEnv } from '../utils/helpers.js';
import {
  publishEndpoint,
  unpublishEndpoint,
  validateEndpointForPublish,
  DISCOVERY_FIELDS,
  type DiscoveryField,
} from '../services/publish-x402.js';
import { SlugConflictError } from '../middleware/error.js';

const app = new Hono();

// Apply auth middleware to all routes
app.use('*', authMiddleware);

// ============================================
// Validation Schemas
// ============================================

const SERVICE_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;

const createEndpointSchema = z.object({
  name: z.string().min(1).max(255),
  path: z.string().min(1).max(500).regex(/^\//, 'Path must start with /'),
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ANY']),
  description: z.string().max(1000).optional(),
  accountId: z.string().uuid(),
  basePrice: z.number().positive().min(0.0001).max(999999),
  currency: z.enum(['USDC', 'EURC']).default('USDC'),
  volumeDiscounts: z.array(z.object({
    threshold: z.number().int().positive(),
    priceMultiplier: z.number().positive().max(1)
  })).optional(),
  webhookUrl: z.string().url().optional(),
  network: z.string().default('base-mainnet'),
  serviceSlug: z.string().regex(SERVICE_SLUG_RE).optional(),
  backendUrl: z.string().url().optional(),
  category: z.string().max(64).optional(),
});

const updateEndpointSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(1000).optional(),
  basePrice: z.number().positive().min(0.0001).max(999999).optional(),
  volumeDiscounts: z.array(z.object({
    threshold: z.number().int().positive(),
    priceMultiplier: z.number().positive().max(1)
  })).optional(),
  status: z.enum(['active', 'paused', 'disabled']).optional(),
  webhookUrl: z.string().url().optional(),
  serviceSlug: z.string().regex(SERVICE_SLUG_RE).optional(),
  backendUrl: z.string().url().optional(),
  category: z.string().max(64).optional(),
});

const publishInputSchema = z
  .object({
    metadataOverride: z
      .object({
        description: z.string().optional(),
        category: z.string().optional(),
        bodyType: z.literal('json').optional(),
        input: z
          .object({
            schema: z.record(z.string(), z.unknown()).optional(),
            example: z.unknown().optional(),
          })
          .optional(),
        output: z
          .object({
            schema: z.record(z.string(), z.unknown()).optional(),
            example: z.unknown().optional(),
          })
          .optional(),
      })
      .optional(),
    force: z.boolean().optional(),
  })
  .optional();

// ============================================
// Helpers
// ============================================

function mapEndpointFromDb(row: any) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    accountId: row.account_id,
    name: row.name,
    path: row.path,
    method: row.method,
    description: row.description,
    basePrice: parseFloat(row.base_price),
    currency: row.currency,
    volumeDiscounts: row.volume_discounts || [],
    paymentAddress: row.payment_address,
    assetAddress: row.asset_address,
    network: row.network,
    totalCalls: row.total_calls,
    totalRevenue: parseFloat(row.total_revenue),
    status: row.status,
    webhookUrl: row.webhook_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,

    // Publish lifecycle
    visibility: row.visibility ?? 'private',
    publishStatus: row.publish_status ?? 'draft',
    publishError: row.publish_error ?? null,
    publishedAt: row.published_at ?? null,
    lastIndexedAt: row.last_indexed_at ?? null,
    lastSettleAt: row.last_settle_at ?? null,
    catalogServiceId: row.catalog_service_id ?? null,
    discoveryMetadata: row.discovery_metadata ?? null,
    metadataDirty: row.metadata_dirty ?? false,
    facilitatorMode: row.facilitator_mode ?? 'internal',
    category: row.category ?? null,
    serviceSlug: row.service_slug ?? null,
    backendUrl: row.backend_url ?? null,
    hasBackendAuth: !!row.backend_auth,
  };
}

// In-memory debounce map for auto-republish. Keyed by endpoint id; multiple
// PATCHes within 5s coalesce into one publishEndpoint(force=true) call.
// Acceptable for single-instance API; revisit for multi-replica deploys.
const REPUBLISH_DEBOUNCE_MS = 5000;
const republishTimers = new Map<string, NodeJS.Timeout>();

function scheduleAutoRepublish(
  ctx: any,
  endpointId: string
): void {
  const existing = republishTimers.get(endpointId);
  if (existing) clearTimeout(existing);

  const handle = setTimeout(async () => {
    republishTimers.delete(endpointId);
    try {
      const supabase: any = createClient();
      await publishEndpoint(supabase, ctx, endpointId, { force: true });
    } catch (err: any) {
      console.error(
        `[x402-endpoints] auto-republish failed for ${endpointId}:`,
        err?.message || err
      );
    }
  }, REPUBLISH_DEBOUNCE_MS);
  republishTimers.set(endpointId, handle);
}

/**
 * Map UpdateX402EndpointInput fields to the DISCOVERY_FIELDS list. Returns
 * the subset of fields that, if changed, should mark metadata_dirty +
 * trigger auto-republish. Pure status flips (status, webhookUrl) are
 * deliberately excluded.
 */
function patchTouchesDiscovery(
  validated: z.infer<typeof updateEndpointSchema>
): boolean {
  const fieldMap: Record<keyof z.infer<typeof updateEndpointSchema>, DiscoveryField | null> = {
    name: 'name',
    description: 'description',
    basePrice: 'basePrice',
    volumeDiscounts: 'volumeDiscounts',
    status: null,
    webhookUrl: null,
    serviceSlug: 'serviceSlug',
    backendUrl: 'backendUrl',
    category: 'category',
  };
  for (const k of Object.keys(validated) as Array<keyof typeof validated>) {
    if (validated[k] === undefined) continue;
    if (fieldMap[k] && DISCOVERY_FIELDS.includes(fieldMap[k]!)) return true;
  }
  return false;
}

// ============================================
// Routes
// ============================================

/**
 * POST /v1/x402/endpoints
 * Register a new x402 endpoint
 */
app.post('/', async (c) => {
  try {
    const ctx = c.get('ctx');
    const body = await c.req.json();
    const validated = createEndpointSchema.parse(body);

    const supabase: any = createClient();

    // Verify account belongs to tenant
    const { data: account, error: accountError } = await supabase
      .from('accounts')
      .select('id')
      .eq('id', validated.accountId)
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .single();

    if (accountError || !account) {
      return c.json({
        error: 'Account not found or does not belong to your tenant',
      }, 404);
    }

    // Duplicate path+method guard
    const { data: existing } = await supabase
      .from('x402_endpoints')
      .select('id')
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .eq('path', validated.path)
      .eq('method', validated.method)
      .single();
    if (existing) {
      return c.json({
        error: 'Endpoint with this path and method already exists',
        details: { path: validated.path, method: validated.method },
      }, 409);
    }

    // Service-slug uniqueness within tenant
    if (validated.serviceSlug) {
      const { data: slugExists } = await supabase
        .from('x402_endpoints')
        .select('id')
        .eq('tenant_id', ctx.tenantId)
        .eq('service_slug', validated.serviceSlug)
        .single();
      if (slugExists) {
        throw new SlugConflictError(validated.serviceSlug);
      }
    }

    const paymentAddress = `internal://payos/${ctx.tenantId}/${account.id}`;

    const { data: endpoint, error: createError } = await supabase
      .from('x402_endpoints')
      .insert({
        tenant_id: ctx.tenantId,
        environment: getEnv(ctx),
        account_id: validated.accountId,
        name: validated.name,
        path: validated.path,
        method: validated.method,
        description: validated.description,
        base_price: validated.basePrice,
        currency: validated.currency,
        volume_discounts: validated.volumeDiscounts || null,
        payment_address: paymentAddress,
        network: validated.network,
        webhook_url: validated.webhookUrl,
        status: 'active',
        service_slug: validated.serviceSlug ?? null,
        backend_url: validated.backendUrl ?? null,
        category: validated.category ?? null,
      })
      .select()
      .single();

    if (createError) {
      console.error('Error creating x402 endpoint:', createError);
      return c.json({
        error: 'Failed to create endpoint',
        details: createError.message,
      }, 500);
    }

    trackOp({
      tenantId: ctx.tenantId,
      operation: OpType.X402_ENDPOINT_CREATED,
      subject: `x402-endpoint/${endpoint.id}`,
      actorType: ctx.actorType,
      actorId: ctx.actorId || ctx.userId || ctx.apiKeyId,
      correlationId: c.get('requestId'),
      success: true,
    });

    return c.json({ data: mapEndpointFromDb(endpoint) }, 201);
  } catch (error) {
    if (error instanceof SlugConflictError) throw error;
    if (error instanceof z.ZodError) {
      return c.json({ error: 'Validation failed', details: error.errors }, 400);
    }
    console.error('Error in POST /v1/x402/endpoints:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * GET /v1/x402/endpoints — list
 */
app.get('/', async (c) => {
  try {
    const ctx = c.get('ctx');
    const supabase: any = createClient();

    const status = c.req.query('status');
    const accountId = c.req.query('account_id');
    const visibility = c.req.query('visibility');
    const publishStatus = c.req.query('publish_status');
    const page = parseInt(c.req.query('page') || '1');
    const limit = parseInt(c.req.query('limit') || '50');
    const offset = (page - 1) * limit;

    let query = supabase
      .from('x402_endpoints')
      .select('*', { count: 'exact' })
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .order('created_at', { ascending: false });

    if (status) query = query.eq('status', status);
    if (accountId) query = query.eq('account_id', accountId);
    if (visibility) query = query.eq('visibility', visibility);
    if (publishStatus) query = query.eq('publish_status', publishStatus);

    query = query.range(offset, offset + limit - 1);

    const { data: endpoints, error, count } = await query;

    if (error) {
      console.error('Error fetching x402 endpoints:', error);
      return c.json({ error: 'Failed to fetch endpoints' }, 500);
    }

    return c.json({
      data: endpoints?.map(mapEndpointFromDb) || [],
      pagination: {
        page,
        limit,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limit),
      },
    });
  } catch (error) {
    console.error('Error in GET /v1/x402/endpoints:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * GET /v1/x402/endpoints/:id — single endpoint with recent transactions
 */
app.get('/:id', async (c) => {
  try {
    const ctx = c.get('ctx');
    const id = c.req.param('id');
    const supabase: any = createClient();

    const { data: endpoint, error } = await supabase
      .from('x402_endpoints')
      .select('*')
      .eq('id', id)
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .single();

    if (error || !endpoint) {
      return c.json({ error: 'Endpoint not found' }, 404);
    }

    const { data: recentTxs } = await supabase
      .from('transfers')
      .select('id, from_account_id, amount, currency, status, created_at, protocol_metadata')
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .eq('type', 'x402')
      .contains('protocol_metadata', { endpoint_id: id })
      .order('created_at', { ascending: false })
      .limit(10);

    const response = {
      ...mapEndpointFromDb(endpoint),
      recentTransactions:
        recentTxs?.map((tx: any) => ({
          id: tx.id,
          fromAccountId: tx.from_account_id,
          amount: parseFloat(tx.amount),
          currency: tx.currency,
          status: tx.status,
          requestId: tx.protocol_metadata?.request_id,
          createdAt: tx.created_at,
        })) || [],
    };

    return c.json({ data: response });
  } catch (error) {
    console.error('Error in GET /v1/x402/endpoints/:id:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Publish lifecycle
// ────────────────────────────────────────────────────────────────────────────

/**
 * POST /v1/x402/endpoints/:id/validate
 * Dry-run readiness check (no side effects).
 */
app.post('/:id/validate', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  const supabase: any = createClient();
  try {
    const result = await validateEndpointForPublish(supabase, ctx, id);
    return c.json(result);
  } catch (err: any) {
    if (err?.message?.includes('not found')) {
      return c.json({ error: 'Endpoint not found' }, 404);
    }
    console.error('Error in POST /v1/x402/endpoints/:id/validate:', err);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * POST /v1/x402/endpoints/:id/publish
 * Drive the publish state machine. Returns the new lifecycle status.
 */
app.post('/:id/publish', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  const supabase: any = createClient();

  try {
    const body = await c.req.json().catch(() => ({}));
    const opts = publishInputSchema.parse(body);
    const result = await publishEndpoint(supabase, ctx, id, opts || {});

    trackOp({
      tenantId: ctx.tenantId,
      operation: OpType.X402_ENDPOINT_UPDATED,
      subject: `x402-endpoint/${id}`,
      actorType: ctx.actorType,
      actorId: ctx.actorId || ctx.userId || ctx.apiKeyId,
      correlationId: c.get('requestId'),
      success: result.status === 'ok',
      data: { action: 'publish', publishStatus: result.publishStatus },
    });

    return c.json(result);
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return c.json({ error: 'Validation failed', details: err.errors }, 400);
    }
    if (err?.message?.includes('not found')) {
      return c.json({ error: 'Endpoint not found' }, 404);
    }
    if (err?.name === 'BazaarValidationError' || err?.name === 'WalletRequiredError') {
      // The error handler will format these consistently — re-throw.
      throw err;
    }
    console.error('Error in POST /v1/x402/endpoints/:id/publish:', err);
    return c.json({ error: 'Internal server error', details: err?.message }, 500);
  }
});

/**
 * POST /v1/x402/endpoints/:id/unpublish
 * Flip back to private/internal. Catalog entry may persist briefly.
 */
app.post('/:id/unpublish', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  const supabase: any = createClient();

  try {
    const result = await unpublishEndpoint(supabase, ctx, id);

    trackOp({
      tenantId: ctx.tenantId,
      operation: OpType.X402_ENDPOINT_UPDATED,
      subject: `x402-endpoint/${id}`,
      actorType: ctx.actorType,
      actorId: ctx.actorId || ctx.userId || ctx.apiKeyId,
      correlationId: c.get('requestId'),
      success: true,
      data: { action: 'unpublish' },
    });

    return c.json(result);
  } catch (err: any) {
    if (err?.message?.includes('not found')) {
      return c.json({ error: 'Endpoint not found' }, 404);
    }
    console.error('Error in POST /v1/x402/endpoints/:id/unpublish:', err);
    return c.json({ error: 'Internal server error', details: err?.message }, 500);
  }
});

/**
 * GET /v1/x402/endpoints/:id/publish-status
 * Current state + last 50 events.
 */
app.get('/:id/publish-status', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  const supabase: any = createClient();

  const { data: ep, error } = await supabase
    .from('x402_endpoints')
    .select(
      'id, tenant_id, publish_status, publish_error, published_at, last_indexed_at, last_settle_at, catalog_service_id, service_slug'
    )
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .single();

  if (error || !ep) {
    return c.json({ error: 'Endpoint not found' }, 404);
  }

  const { data: tenant } = await supabase
    .from('tenants')
    .select('slug')
    .eq('id', ctx.tenantId)
    .single();

  const gatewayUrl =
    tenant?.slug && ep.service_slug
      ? `https://${tenant.slug}.x402.getsly.ai/${ep.service_slug}`
      : null;

  const { data: events } = await supabase
    .from('x402_publish_events')
    .select('id, tenant_id, endpoint_id, actor_type, actor_id, event, details, created_at')
    .eq('endpoint_id', id)
    .eq('tenant_id', ctx.tenantId)
    .order('created_at', { ascending: false })
    .limit(50);

  return c.json({
    publishStatus: ep.publish_status,
    publishError: ep.publish_error,
    publishedAt: ep.published_at,
    lastIndexedAt: ep.last_indexed_at,
    lastSettleAt: ep.last_settle_at,
    catalogServiceId: ep.catalog_service_id,
    gatewayUrl,
    events:
      (events || []).map((e: any) => ({
        id: e.id,
        tenantId: e.tenant_id,
        endpointId: e.endpoint_id,
        actorType: e.actor_type,
        actorId: e.actor_id,
        event: e.event,
        details: e.details,
        createdAt: e.created_at,
      })) || [],
  });
});

/**
 * PATCH /v1/x402/endpoints/:id
 * Update metadata. If endpoint is public AND the patch touches a
 * discovery-relevant field, mark dirty + schedule auto-republish.
 */
app.patch('/:id', async (c) => {
  try {
    const ctx = c.get('ctx');
    const id = c.req.param('id');
    const body = await c.req.json();
    const validated = updateEndpointSchema.parse(body);

    const supabase: any = createClient();

    const { data: existing, error: fetchError } = await supabase
      .from('x402_endpoints')
      .select('id, visibility, service_slug, tenant_id')
      .eq('id', id)
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .single();

    if (fetchError || !existing) {
      return c.json({ error: 'Endpoint not found' }, 404);
    }

    // Slug uniqueness re-check on rename
    if (
      validated.serviceSlug &&
      validated.serviceSlug !== existing.service_slug
    ) {
      const { data: slugExists } = await supabase
        .from('x402_endpoints')
        .select('id')
        .eq('tenant_id', ctx.tenantId)
        .eq('service_slug', validated.serviceSlug)
        .neq('id', id)
        .single();
      if (slugExists) {
        throw new SlugConflictError(validated.serviceSlug);
      }
    }

    const touchesDiscovery = patchTouchesDiscovery(validated);
    const isPublic = existing.visibility === 'public';

    const { data: updated, error: updateError } = await supabase
      .from('x402_endpoints')
      .update({
        ...(validated.name && { name: validated.name }),
        ...(validated.description !== undefined && { description: validated.description }),
        ...(validated.basePrice && { base_price: validated.basePrice }),
        ...(validated.volumeDiscounts !== undefined && { volume_discounts: validated.volumeDiscounts }),
        ...(validated.status && { status: validated.status }),
        ...(validated.webhookUrl !== undefined && { webhook_url: validated.webhookUrl }),
        ...(validated.serviceSlug !== undefined && { service_slug: validated.serviceSlug }),
        ...(validated.backendUrl !== undefined && { backend_url: validated.backendUrl }),
        ...(validated.category !== undefined && { category: validated.category }),
        ...(touchesDiscovery && isPublic ? { metadata_dirty: true } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .select()
      .single();

    if (updateError) {
      console.error('Error updating x402 endpoint:', updateError);
      return c.json({ error: 'Failed to update endpoint' }, 500);
    }

    trackOp({
      tenantId: ctx.tenantId,
      operation: OpType.X402_ENDPOINT_UPDATED,
      subject: `x402-endpoint/${id}`,
      actorType: ctx.actorType,
      actorId: ctx.actorId || ctx.userId || ctx.apiKeyId,
      correlationId: c.get('requestId'),
      success: true,
    });

    // Auto-republish hook (Phase 1: in-memory debounce)
    if (touchesDiscovery && isPublic) {
      scheduleAutoRepublish(ctx, id);
    }

    return c.json({ data: mapEndpointFromDb(updated) });
  } catch (error) {
    if (error instanceof SlugConflictError) throw error;
    if (error instanceof z.ZodError) {
      return c.json({ error: 'Validation failed', details: error.errors }, 400);
    }
    console.error('Error in PATCH /v1/x402/endpoints/:id:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * DELETE /v1/x402/endpoints/:id
 */
app.delete('/:id', async (c) => {
  try {
    const ctx = c.get('ctx');
    const id = c.req.param('id');
    const supabase: any = createClient();

    const { data: existing, error: fetchError } = await supabase
      .from('x402_endpoints')
      .select('id, total_calls')
      .eq('id', id)
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .single();

    if (fetchError || !existing) {
      return c.json({ error: 'Endpoint not found' }, 404);
    }

    if (existing.total_calls > 0) {
      const force = c.req.query('force') === 'true';
      if (!force) {
        return c.json({
          error: 'Endpoint has transaction history',
          message: 'This endpoint has received payments. Add ?force=true to delete anyway.',
          totalCalls: existing.total_calls,
        }, 409);
      }
    }

    const { error: deleteError } = await supabase
      .from('x402_endpoints')
      .delete()
      .eq('id', id)
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx));

    if (deleteError) {
      console.error('Error deleting x402 endpoint:', deleteError);
      return c.json({ error: 'Failed to delete endpoint' }, 500);
    }

    return c.json({ message: 'Endpoint deleted successfully' }, 200);
  } catch (error) {
    console.error('Error in DELETE /v1/x402/endpoints/:id:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// Test-only export so the auto-republish debounce path is observable in
// unit tests without exposing internals to other modules.
export const __testing = { scheduleAutoRepublish, patchTouchesDiscovery };

export default app;
