import { Hono } from 'hono';
import { z } from 'zod';
import { scanDomain, normalizeDomain } from '../scanner.js';
import * as queries from '../db/queries.js';

export const scanRouter = new Hono();

// Validation schemas
const scanRequestSchema = z.object({
  domain: z.string().min(1).max(253),
  merchant_name: z.string().optional(),
  merchant_category: z.enum([
    'retail', 'saas', 'marketplace', 'restaurant', 'b2b',
    'travel', 'fintech', 'healthcare', 'media', 'other',
  ]).optional(),
  country_code: z.string().length(2).optional(),
  region: z.enum(['latam', 'north_america', 'europe', 'apac', 'africa', 'mena']).optional(),
  skip_if_fresh: z.boolean().optional(),
});

// POST /v1/scanner/scan — scan a single domain
scanRouter.post('/scan', async (c) => {
  const body = await c.req.json();
  const parsed = scanRequestSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Validation error', details: parsed.error.flatten() }, 400);
  }

  const { tenantId } = c.get('ctx');

  const result = await scanDomain({
    tenantId,
    domain: parsed.data.domain,
    merchant_name: parsed.data.merchant_name,
    merchant_category: parsed.data.merchant_category,
    country_code: parsed.data.country_code,
    region: parsed.data.region,
    skipIfFresh: parsed.data.skip_if_fresh,
  });

  return c.json(result);
});

// GET /v1/scanner/scan/:id — get scan results by ID
scanRouter.get('/scan/:id', async (c) => {
  const id = c.req.param('id');
  const scan = await queries.getMerchantScanWithDetails(id);

  if (!scan) {
    return c.json({ error: 'Scan not found' }, 404);
  }

  return c.json(scan);
});

// GET /v1/scanner/scans — list scans with filters (reads shared corpus)
scanRouter.get('/scans', async (c) => {
  const category = c.req.query('category');
  const region = c.req.query('region');
  const status = c.req.query('status');
  const minScore = c.req.query('min_score');
  const maxScore = c.req.query('max_score');
  const page = parseInt(c.req.query('page') || '1');
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 100);

  const result = await queries.listMerchantScans({
    category: category || undefined,
    region: region || undefined,
    status: status || undefined,
    min_score: minScore ? parseInt(minScore) : undefined,
    max_score: maxScore ? parseInt(maxScore) : undefined,
    page,
    limit,
  });

  return c.json({
    data: result.data,
    pagination: {
      page,
      limit,
      total: result.total,
      totalPages: Math.ceil(result.total / limit),
    },
  });
});

// GET /v1/scanner/scans/stats — aggregate statistics (shared corpus)
scanRouter.get('/scans/stats', async (c) => {
  const stats = await queries.getScanStats();
  return c.json(stats);
});

// GET /v1/scanner/scans/by-domain/:domain — lookup by domain (shared corpus)
scanRouter.get('/scans/by-domain/:domain', async (c) => {
  const domain = normalizeDomain(c.req.param('domain'));
  const scan = await queries.getMerchantScanByDomain(domain);

  if (!scan) {
    return c.json({ error: 'No scan found for this domain' }, 404);
  }

  const full = await queries.getMerchantScanWithDetails(scan.id);
  return c.json(full);
});

// GET /v1/scanner/scans/protocol-adoption — protocol adoption rates (shared corpus)
scanRouter.get('/scans/protocol-adoption', async (c) => {
  const adoption = await queries.getProtocolAdoption();
  return c.json(adoption);
});
