import { Hono } from 'hono';
import { z } from 'zod';
import { runAgentShoppingTest } from '../demand/synthetic-tests.js';
import { normalizeDomain } from '../scanner.js';
import * as queries from '../db/queries.js';

export const testsRouter = new Hono();

const testRequestSchema = z.object({
  domain: z.string().min(1).max(253),
  test_type: z.enum(['browse', 'search', 'add_to_cart', 'checkout', 'full_flow']).optional(),
});

// POST /v1/scanner/tests — run a synthetic agent shopping test
testsRouter.post('/tests', async (c) => {
  const body = await c.req.json();
  const parsed = testRequestSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Validation error', details: parsed.error.flatten() }, 400);
  }

  const { tenantId } = c.get('ctx');
  const result = await runAgentShoppingTest(tenantId, parsed.data.domain, parsed.data.test_type);
  return c.json(result);
});

// GET /v1/scanner/tests/:domain — get test results for a domain
testsRouter.get('/tests/:domain', async (c) => {
  const domain = normalizeDomain(c.req.param('domain'));
  const limit = Math.min(parseInt(c.req.query('limit') || '10'), 50);

  const results = await queries.getAgentShoppingTests(domain, limit);
  return c.json({ data: results });
});
