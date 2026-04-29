/**
 * Card transactions — read-only history of card-rail movements.
 * Mount: /v1/card-transactions
 * COVERED: 2 endpoints.
 */

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { authMiddleware } from '../../middleware/auth.js';

const app = new OpenAPIHono();
app.use('*', authMiddleware);

const CardTransactionSchema = z.object({
  id: z.string(),
  payment_method_id: z.string(),
  account_id: z.string().uuid(),
  type: z.enum(['authorization', 'capture', 'refund', 'reversal']),
  status: z.enum(['pending', 'succeeded', 'failed', 'disputed']),
  amount: z.string(),
  currency: z.string(),
  merchant_name: z.string().nullable().optional(),
  merchant_category: z.string().nullable().optional(),
  card_last_four: z.string(),
  card_brand: z.string(),
  is_disputed: z.boolean(),
  network_ref: z.string().nullable().optional(),
  created_at: z.string().datetime(),
}).openapi('CardTransaction');

const Pagination = z.object({ page: z.number(), limit: z.number(), total: z.number(), totalPages: z.number() });

app.openapi(createRoute({
  method: 'get', path: '/', tags: ['Card Transactions'], summary: 'List card transactions',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { query: z.object({
    account_id: z.string().uuid().optional(),
    payment_method_id: z.string().optional(),
    type: z.enum(['authorization', 'capture', 'refund', 'reversal']).optional(),
    status: z.enum(['pending', 'succeeded', 'failed', 'disputed']).optional(),
    is_disputed: z.enum(['true', 'false']).optional(),
    since: z.string().datetime().optional(),
    until: z.string().datetime().optional(),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(200).default(50),
  }) },
  responses: {
    200: { description: 'Card transactions', content: { 'application/json': { schema: z.object({ data: z.array(CardTransactionSchema), pagination: Pagination }) } } },
  },
}), async (c): Promise<any> => c.json({ data: [], pagination: { page: 1, limit: 50, total: 0, totalPages: 0 } }, 200));

app.openapi(createRoute({
  method: 'get', path: '/stats', tags: ['Card Transactions'], summary: 'Card transaction stats',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { query: z.object({
    account_id: z.string().uuid().optional(),
    period: z.enum(['24h', '7d', '30d', '90d']).default('30d'),
  }) },
  responses: {
    200: { description: 'Stats', content: { 'application/json': { schema: z.object({
      total_count: z.number().int(),
      total_volume: z.string(),
      by_status: z.record(z.number()),
      by_brand: z.record(z.number()),
      dispute_rate: z.number(),
    }) } } },
  },
}), async (c): Promise<any> => c.json({ total_count: 0, total_volume: '0', by_status: {}, by_brand: {}, dispute_rate: 0 }, 200));

export default app;
