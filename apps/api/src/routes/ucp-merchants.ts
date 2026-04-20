/**
 * UCP Merchant Catalog Endpoints
 *
 * Exposes merchant discovery and product catalogs for AI agents.
 * Merchants are accounts with pos_provider metadata.
 *
 * GET /v1/ucp/merchants           — list merchants (filterable by type, country)
 * GET /v1/ucp/merchants/:id       — merchant detail with full catalog
 */

import { Hono } from 'hono';
import { createClient } from '../db/client.js';
import { NotFoundError } from '../middleware/error.js';
import { trackOp } from '../services/ops/track-op.js';
import { OpType } from '../services/ops/operation-types.js';
import { logCatalogView, viewerFromCtx } from '../services/catalog-view-log.js';

const router = new Hono();

// ============================================
// GET /v1/ucp/merchants — List merchants
// ============================================
router.get('/', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();

  const type = c.req.query('type');         // restaurant, bar, hotel, retail
  const country = c.req.query('country');   // PA, CR
  const search = c.req.query('search');     // free text name search
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 100);
  const page = Math.max(parseInt(c.req.query('page') || '1', 10), 1);
  const offset = (page - 1) * limit;

  let query = supabase
    .from('accounts')
    .select('id, name, currency, metadata', { count: 'exact' })
    .eq('tenant_id', ctx.tenantId)
    .not('metadata->pos_provider', 'is', null);

  if (type) {
    query = query.eq('metadata->>merchant_type', type);
  }
  if (country) {
    query = query.eq('metadata->>country', country);
  }
  if (search) {
    query = query.ilike('name', `%${search}%`);
  }

  query = query.order('name').range(offset, offset + limit - 1);

  const { data: accounts, count, error } = await query;

  if (error) throw error;

  const merchants = (accounts || []).map((a: any) => ({
    id: a.id,
    name: a.name,
    merchant_id: a.metadata?.invu_merchant_id,
    type: a.metadata?.merchant_type,
    country: a.metadata?.country,
    city: a.metadata?.city,
    currency: a.currency,
    description: a.metadata?.description,
    pos_provider: a.metadata?.pos_provider,
    product_count: Array.isArray(a.metadata?.catalog) ? a.metadata.catalog.length : 0,
  }));

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

// ============================================
// GET /v1/ucp/merchants/:id — Merchant detail with catalog
// ============================================
router.get('/:id', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  const supabase = createClient();

  // Support lookup by account UUID or by invu_merchant_id (e.g. "invu_merch_003")
  const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

  let query = supabase
    .from('accounts')
    .select('id, name, currency, metadata')
    .eq('tenant_id', ctx.tenantId);

  if (isUUID) {
    query = query.eq('id', id);
  } else {
    query = query.eq('metadata->>invu_merchant_id', id);
  }

  const { data: account, error } = await query.single();

  if (error || !account) {
    throw new NotFoundError('Merchant', id);
  }

  const meta = account.metadata || {};
  const catalog = Array.isArray(meta.catalog) ? meta.catalog : [];

  // Group products by category
  const categories: Record<string, any[]> = {};
  for (const product of catalog) {
    const cat = product.category || 'Other';
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(product);
  }

  trackOp({
    tenantId: ctx.tenantId,
    operation: OpType.UCP_MERCHANT_DISCOVERED,
    subject: `merchant/${account.id}`,
    actorType: ctx.actorType,
    actorId: ctx.actorId || ctx.userId || ctx.apiKeyId,
    correlationId: c.get('requestId'),
    success: true,
    data: { merchantId: meta.invu_merchant_id, name: account.name, type: meta.merchant_type },
  });

  // Also log as a catalog view for the merchant Discovery panel.
  if ((account as any).subtype === 'merchant' || meta.pos_provider) {
    const { viewerType, viewerAgentId } = viewerFromCtx(ctx);
    logCatalogView(supabase, {
      tenantId: ctx.tenantId,
      merchantAccountId: (account as any).id,
      endpoint: 'detail',
      viewerType,
      viewerAgentId,
      refererSku: c.req.query('sku') || undefined,
    });
  }

  return c.json({
    id: account.id,
    name: account.name,
    merchant_id: meta.invu_merchant_id,
    type: meta.merchant_type,
    country: meta.country,
    city: meta.city,
    currency: account.currency,
    description: meta.description,
    pos_provider: meta.pos_provider,
    catalog: {
      total_products: catalog.length,
      categories: Object.keys(categories),
      products: catalog,
    },
  });
});

export default router;
