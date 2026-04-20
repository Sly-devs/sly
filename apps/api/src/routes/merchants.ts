/**
 * Merchant-facing tenant API.
 *
 * Merchants are accounts with `subtype='merchant'` (or legacy
 * `metadata.pos_provider` set). This router exposes:
 *
 *   GET /v1/accounts/:id/merchant-stats — per-merchant analytics
 *                                          (volume, top buyers, recent sales,
 *                                          x402 endpoints). Mounted at
 *                                          /v1/accounts prefix in app.ts.
 *
 *   GET /v1/merchants                   — alias for /v1/ucp/merchants to
 *   GET /v1/merchants/:id                 give the cleaner namespace. The
 *                                          UCP paths still work unchanged.
 *
 * Auth: tenant-key or agent-key (via authMiddleware — mounted at /v1/ prefix).
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { createClient } from '../db/client.js';
import { computeMerchantStats } from '../services/merchant-stats.js';
import { addProduct, updateProduct, deleteProduct } from '../services/merchant-catalog.js';
import { logCatalogView, viewerFromCtx } from '../services/catalog-view-log.js';
import type { RequestContext } from '../middleware/auth.js';

// Routes attached under /v1/accounts (for the :id/merchant-stats path).
export const merchantStatsOnAccountsRouter = new Hono<{ Variables: { ctx: RequestContext } }>();

// ─── Product CRUD ──────────────────────────────────────────────────────
// Operates on accounts.metadata.catalog.products. Owner/admin dashboard
// users only — agents can't edit merchant catalogs.

const productInputSchema = z.object({
  name: z.string().min(1).max(255),
  category: z.string().min(1).max(100),
  unit_price_cents: z.number().int().min(0),
  currency: z.string().min(3).max(10).optional(),
  sku: z.string().max(100).optional(),
  description: z.string().max(2000).optional(),
});
const productPatchSchema = productInputSchema.partial();

function assertOwnerOrAdmin(ctx: RequestContext): { ok: true } | { ok: false; reason: string } {
  if (ctx.actorType !== 'user') {
    return { ok: false, reason: 'Only dashboard users can edit merchant catalogs (agents and API keys are rejected)' };
  }
  if (ctx.userRole !== 'owner' && ctx.userRole !== 'admin') {
    return { ok: false, reason: 'Owner or admin role required to edit merchant catalogs' };
  }
  return { ok: true };
}

merchantStatsOnAccountsRouter.post('/:id/products', async (c) => {
  const ctx = c.get('ctx');
  const auth = assertOwnerOrAdmin(ctx);
  if (!auth.ok) return c.json({ error: auth.reason }, 403);

  const accountId = c.req.param('id');
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  const parsed = productInputSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid product', details: parsed.error.format() }, 400);

  const supabase = createClient();
  try {
    const product = await addProduct(supabase, accountId, ctx.tenantId, parsed.data);
    return c.json({ data: product }, 201);
  } catch (e: any) {
    return c.json({ error: e.message || 'Failed to add product' }, 500);
  }
});

merchantStatsOnAccountsRouter.patch('/:id/products/:productId', async (c) => {
  const ctx = c.get('ctx');
  const auth = assertOwnerOrAdmin(ctx);
  if (!auth.ok) return c.json({ error: auth.reason }, 403);

  const accountId = c.req.param('id');
  const productId = c.req.param('productId');
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  const parsed = productPatchSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid patch', details: parsed.error.format() }, 400);
  if (Object.keys(parsed.data).length === 0) return c.json({ error: 'At least one field required' }, 400);

  const supabase = createClient();
  try {
    const updated = await updateProduct(supabase, accountId, ctx.tenantId, productId, parsed.data);
    if (!updated) return c.json({ error: 'Product not found' }, 404);
    return c.json({ data: updated });
  } catch (e: any) {
    return c.json({ error: e.message || 'Failed to update product' }, 500);
  }
});

merchantStatsOnAccountsRouter.delete('/:id/products/:productId', async (c) => {
  const ctx = c.get('ctx');
  const auth = assertOwnerOrAdmin(ctx);
  if (!auth.ok) return c.json({ error: auth.reason }, 403);

  const accountId = c.req.param('id');
  const productId = c.req.param('productId');

  const supabase = createClient();
  try {
    const ok = await deleteProduct(supabase, accountId, ctx.tenantId, productId);
    if (!ok) return c.json({ error: 'Product not found' }, 404);
    return c.json({ data: { deleted: true, productId } });
  } catch (e: any) {
    return c.json({ error: e.message || 'Failed to delete product' }, 500);
  }
});

merchantStatsOnAccountsRouter.get('/:id/merchant-stats', async (c) => {
  const ctx = c.get('ctx');
  const accountId = c.req.param('id');
  const minutes = Math.max(1, Math.min(43200, parseInt(c.req.query('minutes') || '1440', 10))); // default 24h, max 30d
  const cutoff = new Date(Date.now() - minutes * 60 * 1000).toISOString();

  const supabase = createClient();
  const stats = await computeMerchantStats(supabase, {
    accountId,
    cutoff,
    tenantId: ctx.tenantId, // enforce tenant isolation — caller can only read their own accounts
  });

  if (!stats.merchant) {
    return c.json({ error: 'Account not found' }, 404);
  }
  if (!stats.isMerchant) {
    // Client decides how to render — this is intentional 404 so the UI can
    // hide the merchant sections without ambiguity vs. genuine "no account".
    return c.json({ error: 'Account is not a merchant' }, 404);
  }

  return c.json({
    data: {
      ...stats,
      windowMinutes: minutes,
    },
  });
});

// Routes attached under /v1/merchants (alias for /v1/ucp/merchants).
export const merchantsAliasRouter = new Hono<{ Variables: { ctx: RequestContext } }>();

merchantsAliasRouter.get('/', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();

  const type = c.req.query('type');
  const country = c.req.query('country');
  const search = c.req.query('search');
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 100);
  const page = Math.max(parseInt(c.req.query('page') || '1', 10), 1);
  const offset = (page - 1) * limit;

  let query = (supabase.from('accounts') as any)
    .select('id, name, currency, subtype, metadata', { count: 'exact' })
    .eq('tenant_id', ctx.tenantId)
    .eq('subtype', 'merchant');

  if (type) query = query.eq('metadata->>merchant_type', type);
  if (country) query = query.eq('metadata->>country', country);
  if (search) query = query.ilike('name', `%${search}%`);

  query = query.order('name').range(offset, offset + limit - 1);

  const { data: accounts, count } = await query;
  const merchants = (accounts || []).map((a: any) => {
    const rawCatalog = a.metadata?.catalog;
    const products: any[] = Array.isArray(rawCatalog)
      ? rawCatalog
      : Array.isArray(rawCatalog?.products) ? rawCatalog.products : [];
    return {
      id: a.id,
      name: a.name,
      subtype: a.subtype,
      merchant_id: a.metadata?.invu_merchant_id,
      type: a.metadata?.merchant_type,
      country: a.metadata?.country,
      city: a.metadata?.city,
      currency: a.currency,
      description: a.metadata?.description,
      pos_provider: a.metadata?.pos_provider,
      rating: typeof a.metadata?.rating === 'number' ? a.metadata.rating : undefined,
      product_count: products.length,
    };
  });

  return c.json({
    data: merchants,
    pagination: {
      page,
      limit,
      total: count || 0,
      totalPages: Math.ceil((count || 0) / limit),
    },
  });
});

// ─── Merchant ratings ───────────────────────────────────────────────────
// Agents write ratings; tenant users read aggregates + recent entries.

const RATING_DIMS = ['navigation', 'price_accuracy', 'response_speed', 'fulfillment', 'error_clarity'] as const;
type RatingDim = typeof RATING_DIMS[number];

merchantsAliasRouter.post('/:id/ratings', async (c) => {
  const ctx = c.get('ctx');
  const accountId = c.req.param('id');
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }

  // Only agent-authed callers may rate.
  if (ctx.actorType !== 'agent' || !ctx.actorId) {
    return c.json({ error: 'Only agents can submit merchant ratings' }, 403);
  }

  // Accept any subset of the 5 dimensions. Each must be 1..5 if provided.
  const dims: Partial<Record<RatingDim, number>> = {};
  for (const k of RATING_DIMS) {
    const v = body?.[k];
    if (v === undefined || v === null) continue;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 5) {
      return c.json({ error: `${k} must be an integer 1-5` }, 400);
    }
    dims[k] = n;
  }
  if (Object.keys(dims).length === 0) {
    return c.json({ error: 'At least one rating dimension is required' }, 400);
  }

  const supabase = createClient();

  // Verify the merchant exists in the caller's tenant.
  const { data: merchant } = await (supabase.from('accounts') as any)
    .select('id, subtype, metadata')
    .eq('id', accountId)
    .eq('tenant_id', ctx.tenantId)
    .maybeSingle();
  if (!merchant) return c.json({ error: 'Merchant not found' }, 404);
  const isMerchant = merchant.subtype === 'merchant' || merchant.metadata?.pos_provider != null;
  if (!isMerchant) return c.json({ error: 'Account is not a merchant' }, 404);

  // Anti-spam gate: the rater must have actually transacted with this
  // merchant. Check acp_checkouts + ucp_checkout_sessions + x402 transfers.
  const [acpCountRes, ucpCountRes, txCountRes] = await Promise.all([
    (supabase.from('acp_checkouts') as any).select('id', { count: 'exact', head: true })
      .eq('tenant_id', ctx.tenantId)
      .eq('agent_id', ctx.actorId)
      .or(`merchant_account_id.eq.${accountId},merchant_id.eq.${merchant.metadata?.invu_merchant_id ?? ''}`),
    (supabase.from('ucp_checkout_sessions') as any).select('id', { count: 'exact', head: true })
      .eq('tenant_id', ctx.tenantId)
      .eq('agent_id', ctx.actorId),
    (supabase.from('transfers') as any).select('id', { count: 'exact', head: true })
      .eq('tenant_id', ctx.tenantId)
      .eq('to_account_id', accountId),
  ]);
  const didTransact = (acpCountRes.count || 0) + (ucpCountRes.count || 0) + (txCountRes.count || 0) > 0;
  if (!didTransact) {
    return c.json({ error: 'Agent has not transacted with this merchant' }, 403);
  }

  const { data: inserted, error } = await (supabase.from('merchant_ratings') as any)
    .insert({
      tenant_id: ctx.tenantId,
      merchant_account_id: accountId,
      rater_agent_id: ctx.actorId,
      checkout_id: typeof body.checkout_id === 'string' ? body.checkout_id : null,
      checkout_protocol: ['acp', 'ucp', 'x402'].includes(body.checkout_protocol) ? body.checkout_protocol : null,
      ...dims,
      comment: typeof body.comment === 'string' ? body.comment.slice(0, 2000) : null,
    })
    .select('id, created_at')
    .single();

  if (error) return c.json({ error: `Failed to insert rating: ${error.message}` }, 500);
  return c.json({ data: inserted }, 201);
});

merchantsAliasRouter.get('/:id/ratings', async (c) => {
  const ctx = c.get('ctx');
  const accountId = c.req.param('id');
  const limit = Math.max(1, Math.min(100, parseInt(c.req.query('limit') || '20', 10)));

  const supabase = createClient();

  // Verify tenant ownership.
  const { data: merchant } = await (supabase.from('accounts') as any)
    .select('id, subtype, metadata')
    .eq('id', accountId)
    .eq('tenant_id', ctx.tenantId)
    .maybeSingle();
  if (!merchant) return c.json({ error: 'Merchant not found' }, 404);

  // Log the ratings-page view — agents checking reputation before buying.
  if (merchant.subtype === 'merchant' || merchant.metadata?.pos_provider) {
    const { viewerType, viewerAgentId } = viewerFromCtx(ctx);
    logCatalogView(supabase, {
      tenantId: ctx.tenantId,
      merchantAccountId: accountId,
      endpoint: 'ratings',
      viewerType,
      viewerAgentId,
    });
  }

  const [recentRes, allRes] = await Promise.all([
    (supabase.from('merchant_ratings') as any)
      .select('id, rater_agent_id, checkout_id, checkout_protocol, navigation, price_accuracy, response_speed, fulfillment, error_clarity, comment, created_at')
      .eq('merchant_account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(limit),
    // Full set for averaging. For a very heavy merchant this could be large;
    // 5000 is a reasonable cap for demo scale.
    (supabase.from('merchant_ratings') as any)
      .select('navigation, price_accuracy, response_speed, fulfillment, error_clarity')
      .eq('merchant_account_id', accountId)
      .limit(5000),
  ]);

  const recent = (recentRes.data || []) as any[];
  const all = (allRes.data || []) as any[];

  // Per-dim averages (nulls skipped).
  const averages: Record<RatingDim, number | null> = {
    navigation: null, price_accuracy: null, response_speed: null, fulfillment: null, error_clarity: null,
  };
  for (const dim of RATING_DIMS) {
    const vals = all.map((r) => r[dim]).filter((v) => typeof v === 'number') as number[];
    averages[dim] = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }
  const availableDims = (Object.values(averages) as Array<number | null>).filter((v) => v !== null) as number[];
  const overallAverage = availableDims.length > 0 ? availableDims.reduce((a, b) => a + b, 0) / availableDims.length : null;

  // Attach rater agent names.
  const raterIds = Array.from(new Set(recent.map((r) => r.rater_agent_id)));
  const raterNames: Record<string, string> = {};
  if (raterIds.length > 0) {
    const { data: agents } = await (supabase.from('agents') as any)
      .select('id, name')
      .in('id', raterIds);
    for (const a of (agents || []) as any[]) raterNames[a.id] = a.name;
  }
  const recentWithNames = recent.map((r) => ({ ...r, rater_name: raterNames[r.rater_agent_id] || r.rater_agent_id.slice(0, 8) }));

  return c.json({
    data: {
      averages,
      overallAverage,
      totalRatings: all.length,
      recent: recentWithNames,
    },
  });
});

merchantsAliasRouter.get('/:id', async (c) => {
  const ctx = c.get('ctx');
  const accountId = c.req.param('id');
  const supabase = createClient();

  const { data: account } = await (supabase.from('accounts') as any)
    .select('id, name, currency, subtype, metadata')
    .eq('id', accountId)
    .eq('tenant_id', ctx.tenantId)
    .maybeSingle();

  if (!account) return c.json({ error: 'Merchant not found' }, 404);

  // Fire-and-forget: log the catalog view so the merchant can see who
  // browsed without buying. Only for merchants, only on detail endpoints.
  if (account.subtype === 'merchant' || account.metadata?.pos_provider) {
    const { viewerType, viewerAgentId } = viewerFromCtx(ctx);
    logCatalogView(supabase, {
      tenantId: ctx.tenantId,
      merchantAccountId: accountId,
      endpoint: 'detail',
      viewerType,
      viewerAgentId,
      refererSku: c.req.query('sku') || undefined,
    });
  }

  const rawCatalog = account.metadata?.catalog;
  const products: any[] = Array.isArray(rawCatalog)
    ? rawCatalog
    : Array.isArray(rawCatalog?.products) ? rawCatalog.products : [];

  return c.json({
    data: {
      id: account.id,
      name: account.name,
      subtype: account.subtype,
      merchant_id: account.metadata?.invu_merchant_id,
      type: account.metadata?.merchant_type,
      country: account.metadata?.country,
      city: account.metadata?.city,
      currency: account.currency,
      description: account.metadata?.description,
      pos_provider: account.metadata?.pos_provider,
      rating: typeof account.metadata?.rating === 'number' ? account.metadata.rating : undefined,
      catalog: {
        total_products: products.length,
        products,
      },
    },
  });
});
