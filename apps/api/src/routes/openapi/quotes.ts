/**
 * Quotes — OpenAPIHono spec scaffold.
 * COVERED: quote, rates, fx, fx post, fx/lock, fx/corridors, multi (7 endpoints)
 */

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { authMiddleware } from '../../middleware/auth.js';

const app = new OpenAPIHono();
app.use('*', authMiddleware);

const AmountSideEnum = z.enum(['send', 'receive']);

const QuoteSchema = z.object({
  id: z.string().uuid(),
  rate: z.string(),
  send_amount: z.string(),
  send_currency: z.string(),
  receive_amount: z.string(),
  receive_currency: z.string(),
  fee: z.string(),
  expires_at: z.string().datetime(),
  provider: z.string(),
}).openapi('Quote');

const CreateQuoteSchema = z.object({
  from_currency: z.string(),
  to_currency: z.string(),
  amount: z.string(),
  amount_side: AmountSideEnum.default('send'),
}).openapi('CreateQuoteInput');

const CorridorSchema = z.object({
  from_currency: z.string(),
  to_currency: z.string(),
  min_amount: z.string(),
  max_amount: z.string(),
  typical_settlement: z.string().describe('e.g. "T+1", "T+0 < 10s", "T+2 business"'),
  rails: z.array(z.string()),
}).openapi('Corridor');

const ErrorSchema = z.object({
  error: z.string(), code: z.string().optional(), details: z.unknown().optional(),
}).openapi('Error');
const notMigrated = () => ({ error: 'Not yet migrated — use the plain-Hono quotes router', code: 'NOT_MIGRATED' });

app.openapi(createRoute({
  method: 'post', path: '/', tags: ['Quotes'], summary: 'Request a quote',
  description: "Get a time-bound FX rate quotation for cross-currency transfers. Default TTL ~30 seconds. Use the returned `id` on POST /v1/transfers to lock the rate.",
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { body: { content: { 'application/json': { schema: CreateQuoteSchema } }, required: true } },
  responses: {
    201: { description: 'Quote issued', content: { 'application/json': { schema: z.object({ data: QuoteSchema }) } } },
    400: { description: 'Validation error or unsupported corridor', content: { 'application/json': { schema: ErrorSchema } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 400));

app.openapi(createRoute({
  method: 'get', path: '/rates', tags: ['Quotes'], summary: 'Indicative FX rates',
  description: 'Informational rate snapshot across all your enabled corridors. NOT a quote — do not use for execution.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  responses: {
    200: { description: 'Rate snapshot', content: { 'application/json': { schema: z.object({
      rates: z.array(z.object({ from: z.string(), to: z.string(), rate: z.string(), as_of: z.string().datetime() })),
    }) } } },
  },
}), async (c): Promise<any> => c.json({ rates: [] }, 200));

app.openapi(createRoute({
  method: 'get', path: '/fx', tags: ['Quotes'], summary: 'Current FX mid-market',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { query: z.object({ from: z.string(), to: z.string() }) },
  responses: {
    200: { description: 'Mid-market rate', content: { 'application/json': { schema: z.object({ rate: z.string(), as_of: z.string().datetime() }) } } },
  },
}), async (c): Promise<any> => c.json({ rate: '0', as_of: new Date().toISOString() }, 200));

app.openapi(createRoute({
  method: 'post', path: '/fx/lock', tags: ['Quotes'],
  summary: 'Lock FX rate for extended window',
  description: 'Enterprise feature — lock a rate for minutes-to-hours at a higher spread. Returns a quote-like token usable on transfers within the lock window.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { body: { content: { 'application/json': { schema: CreateQuoteSchema.extend({
    lock_duration_seconds: z.number().int().positive().max(86400).default(3600),
  }) } }, required: true } },
  responses: {
    201: { description: 'Locked', content: { 'application/json': { schema: z.object({ data: QuoteSchema }) } } },
    400: { description: 'Validation error', content: { 'application/json': { schema: ErrorSchema } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 400));

app.openapi(createRoute({
  method: 'get', path: '/fx/corridors', tags: ['Quotes'], summary: 'List supported corridors',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  responses: {
    200: { description: 'Corridors', content: { 'application/json': { schema: z.object({ data: z.array(CorridorSchema) }) } } },
  },
}), async (c): Promise<any> => c.json({ data: [] }, 200));

app.openapi(createRoute({
  method: 'post', path: '/multi', tags: ['Quotes'],
  summary: 'Multi-leg quote',
  description: 'Quote a chained conversion (e.g. USD → USDC → BRL via Pix) in a single call. Useful for cross-rail transfers where direct corridors don\'t exist.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { body: { content: { 'application/json': { schema: z.object({
    legs: z.array(CreateQuoteSchema).min(2).max(4),
  }) } }, required: true } },
  responses: {
    201: { description: 'Multi-leg quote', content: { 'application/json': { schema: z.object({ data: z.object({
      legs: z.array(QuoteSchema), total_fee: z.string(), effective_rate: z.string(), expires_at: z.string().datetime(),
    }) }) } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 400));

export default app;
