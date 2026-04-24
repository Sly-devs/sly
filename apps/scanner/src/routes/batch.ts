import { Hono } from 'hono';
import { z } from 'zod';
import { BatchProcessor } from '../queue/batch-processor.js';
import * as queries from '../db/queries.js';
import { chargeCredits } from '../middleware/credits.js';
import { computeBatchCost } from '../billing/credit-costs.js';
import { refund } from '../billing/ledger.js';
import { waitUntil } from '../utils/wait-until.js';

export const batchRouter = new Hono();

const batchProcessor = new BatchProcessor();

const batchRequestSchema = z.object({
  domains: z.array(z.object({
    domain: z.string().min(1),
    merchant_name: z.string().optional(),
    merchant_category: z.string().optional(),
    country_code: z.string().optional(),
    region: z.string().optional(),
  })).min(1).max(parseInt(process.env.SCANNER_MAX_BATCH_SIZE || '500')),
  name: z.string().optional(),
  description: z.string().optional(),
  skip_if_fresh: z.boolean().optional().default(true),
});

// POST /v1/scanner/scan/batch — submit a batch scan
batchRouter.post('/scan/batch', async (c) => {
  const { tenantId, scannerKeyId } = c.get('ctx');

  // Check content type for CSV upload
  const contentType = c.req.header('content-type') || '';

  if (contentType.includes('multipart/form-data')) {
    const formData = await c.req.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return c.json({ error: 'No file provided' }, 400);
    }

    const csvText = await file.text();
    const { parseCSV } = await import('../queue/csv-parser.js');
    const domains = await parseCSV(csvText);

    if (domains.length === 0) {
      return c.json({ error: 'No valid domains found in CSV' }, 400);
    }

    const cost = computeBatchCost(domains.length);
    const charge = await chargeCredits(c, cost, `batch:csv`, {
      targets: domains.length,
      key_id: scannerKeyId ?? null,
    });
    if (!charge.ok) {
      return c.json(
        { error: 'insufficient_credits', balance: charge.balance, required: cost },
        402,
      );
    }

    const batch = await queries.createBatch(tenantId, {
      name: formData.get('name')?.toString() || `CSV Batch ${new Date().toISOString()}`,
      description: formData.get('description')?.toString(),
      target_domains: domains.map(d => d.domain),
    });

    // Hand the batch off to Vercel's background runtime so the HTTP response
    // can return immediately. Without waitUntil, Node holds the response open
    // until the fire-and-forget promise resolves.
    waitUntil(
      Promise.resolve(batchProcessor.processBatch(batch.id, tenantId, domains)),
    );

    return c.json({
      batch_id: batch.id,
      status: 'pending',
      total_targets: domains.length,
      credits_charged: cost,
      message: 'Batch scan started',
    }, 202);
  }

  // JSON body
  const body = await c.req.json();
  const parsed = batchRequestSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Validation error', details: parsed.error.flatten() }, 400);
  }

  const cost = computeBatchCost(parsed.data.domains.length);
  const charge = await chargeCredits(c, cost, `batch:json`, {
    targets: parsed.data.domains.length,
    key_id: scannerKeyId ?? null,
  });
  if (!charge.ok) {
    return c.json(
      { error: 'insufficient_credits', balance: charge.balance, required: cost },
      402,
    );
  }

  const batch = await queries.createBatch(tenantId, {
    name: parsed.data.name || `Batch ${new Date().toISOString()}`,
    description: parsed.data.description,
    target_domains: parsed.data.domains.map(d => d.domain),
  });

  waitUntil(
    Promise.resolve(
      batchProcessor.processBatch(
        batch.id,
        tenantId,
        parsed.data.domains,
        { skipIfFresh: parsed.data.skip_if_fresh },
      ),
    ),
  );

  return c.json({
    batch_id: batch.id,
    status: 'pending',
    total_targets: parsed.data.domains.length,
    credits_charged: cost,
    message: 'Batch scan started',
  }, 202);
});

// GET /v1/scanner/scan/batch/:id — batch progress
batchRouter.get('/scan/batch/:id', async (c) => {
  const id = c.req.param('id');
  const batch = await queries.getBatch(id);

  if (!batch) {
    return c.json({ error: 'Batch not found' }, 404);
  }

  return c.json(batch);
});

// DELETE /v1/scanner/scan/batch/:id — cancel batch (refunds unprocessed targets)
batchRouter.delete('/scan/batch/:id', async (c) => {
  const { tenantId } = c.get('ctx');
  const id = c.req.param('id');
  const batch = await queries.getBatch(id);

  if (!batch) {
    return c.json({ error: 'Batch not found' }, 404);
  }

  if (batch.status === 'completed' || batch.status === 'cancelled') {
    return c.json({ error: `Batch is already ${batch.status}` }, 400);
  }

  if (batch.tenant_id !== tenantId) {
    return c.json({ error: 'Batch belongs to another tenant' }, 403);
  }

  batchProcessor.cancelBatch(id);
  await queries.updateBatch(id, { status: 'cancelled' });

  const unprocessed = (batch.total_targets ?? 0) - (batch.completed_targets ?? 0) - (batch.failed_targets ?? 0);
  let refunded = 0;
  if (unprocessed > 0) {
    refunded = computeBatchCost(unprocessed);
    try {
      await refund(tenantId, refunded, `batch_cancelled:${id}`, { batch_id: id });
    } catch (err) {
      console.error('[scanner-batch] Refund failed:', (err as Error).message);
      refunded = 0;
    }
  }

  return c.json({ status: 'cancelled', batch_id: id, credits_refunded: refunded });
});
