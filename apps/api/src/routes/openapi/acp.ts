/**
 * ACP (Agentic Commerce Protocol) — Stripe + OpenAI checkout.
 * Mount: /v1/acp
 * COVERED: 9 endpoints.
 */

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { authMiddleware } from '../../middleware/auth.js';

const app = new OpenAPIHono();
app.use('*', authMiddleware);

const ACPStatusEnum = z.enum(['created', 'pending_payment', 'paid', 'fulfilled', 'failed', 'expired', 'cancelled']);

const ACPItem = z.object({
  sku: z.string(),
  quantity: z.number().int().positive(),
  unit_price: z.string(),
  currency: z.string(),
}).openapi('ACPItem');

const ACPAddress = z.object({
  line1: z.string(),
  line2: z.string().optional(),
  city: z.string(),
  state: z.string().optional(),
  postal_code: z.string(),
  country: z.string().length(2),
}).openapi('ACPAddress');

const ACPCheckoutSchema = z.object({
  id: z.string(),
  merchant_id: z.string(),
  status: ACPStatusEnum,
  items: z.array(ACPItem),
  total: z.string(),
  currency: z.string(),
  shipping_address: ACPAddress.nullable().optional(),
  payment_method: z.enum(['card', 'bank', 'stablecoin']).default('card'),
  client_secret: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).default({}),
  expires_at: z.string().datetime(),
  created_at: z.string().datetime(),
}).openapi('ACPCheckout');

const CreateACPCheckoutSchema = z.object({
  merchant_id: z.string(),
  items: z.array(ACPItem).min(1),
  shipping_address: ACPAddress.optional(),
  payment_method: z.enum(['card', 'bank', 'stablecoin']).default('card'),
  metadata: z.record(z.unknown()).optional(),
}).openapi('CreateACPCheckoutInput');

const ErrorSchema = z.object({
  error: z.string(), code: z.string().optional(), details: z.unknown().optional(),
}).openapi('Error');
const Pagination = z.object({ page: z.number(), limit: z.number(), total: z.number(), totalPages: z.number() });
const notMigrated = () => ({ error: 'Not yet migrated — use plain-Hono ACP router', code: 'NOT_MIGRATED' });

app.openapi(createRoute({
  method: 'post', path: '/checkouts', tags: ['ACP'], summary: 'Create a checkout session',
  description: 'Opens an Agentic Commerce Protocol session. Returns `client_secret` — use with Stripe.js / Stripe Elements to collect payment client-side.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { body: { content: { 'application/json': { schema: CreateACPCheckoutSchema } }, required: true } },
  responses: {
    201: { description: 'Checkout created', content: { 'application/json': { schema: z.object({ data: ACPCheckoutSchema }) } } },
    400: { description: 'Validation error', content: { 'application/json': { schema: ErrorSchema } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 400));

app.openapi(createRoute({
  method: 'post', path: '/checkouts/batch', tags: ['ACP'], summary: 'Batch-create checkouts',
  description: 'Create up to 100 checkouts in one call. Useful for marketplace baskets where one agent purchase spans many merchants.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { body: { content: { 'application/json': { schema: z.object({
    checkouts: z.array(CreateACPCheckoutSchema).min(1).max(100),
    idempotency_key: z.string().optional(),
  }) } }, required: true } },
  responses: {
    201: { description: 'Batch created', content: { 'application/json': { schema: z.object({ data: z.array(ACPCheckoutSchema) }) } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 400));

app.openapi(createRoute({
  method: 'get', path: '/checkouts', tags: ['ACP'], summary: 'List checkouts',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { query: z.object({
    status: ACPStatusEnum.optional(),
    merchant_id: z.string().optional(),
    since: z.string().datetime().optional(),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(200).default(50),
  }) },
  responses: {
    200: { description: 'Paginated checkouts', content: { 'application/json': { schema: z.object({ data: z.array(ACPCheckoutSchema), pagination: Pagination }) } } },
  },
}), async (c): Promise<any> => c.json({ data: [], pagination: { page: 1, limit: 50, total: 0, totalPages: 0 } }, 200));

app.openapi(createRoute({
  method: 'get', path: '/checkouts/{id}', tags: ['ACP'], summary: 'Get a checkout',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: 'Checkout', content: { 'application/json': { schema: z.object({ data: ACPCheckoutSchema }) } } },
    404: { description: 'Not found', content: { 'application/json': { schema: ErrorSchema } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 404));

app.openapi(createRoute({
  method: 'post', path: '/checkouts/{id}/complete', tags: ['ACP'],
  summary: 'Complete payment',
  description: 'Execute payment. For card checkouts, pass `payment_method_id` (typically from Stripe Elements or SetupIntent). For stablecoin, pass `from_wallet_id`.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { 'application/json': { schema: z.object({
      payment_method_id: z.string().optional(),
      from_wallet_id: z.string().uuid().optional(),
      idempotency_key: z.string().optional(),
    }) } }, required: true },
  },
  responses: {
    200: { description: 'Paid', content: { 'application/json': { schema: z.object({ data: ACPCheckoutSchema }) } } },
    402: { description: 'Card declined or balance insufficient', content: { 'application/json': { schema: ErrorSchema } } },
    403: { description: 'KYA tier or wallet policy blocked', content: { 'application/json': { schema: ErrorSchema } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 400));

app.openapi(createRoute({
  method: 'patch', path: '/checkouts/{id}/cancel', tags: ['ACP'], summary: 'Cancel a checkout',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: 'Cancelled', content: { 'application/json': { schema: z.object({ data: ACPCheckoutSchema }) } } },
    409: { description: 'Already paid or cancelled', content: { 'application/json': { schema: ErrorSchema } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 404));

app.openapi(createRoute({
  method: 'patch', path: '/checkouts/{id}', tags: ['ACP'], summary: 'Update checkout',
  description: 'Swap items, shipping address, or payment method before completion.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { 'application/json': { schema: CreateACPCheckoutSchema.partial() } }, required: true },
  },
  responses: {
    200: { description: 'Updated', content: { 'application/json': { schema: z.object({ data: ACPCheckoutSchema }) } } },
    409: { description: 'Invalid state for update', content: { 'application/json': { schema: ErrorSchema } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 404));

app.openapi(createRoute({
  method: 'delete', path: '/checkouts/{id}', tags: ['ACP'], summary: 'Delete a checkout',
  description: 'Allowed only for un-paid checkouts. Soft-delete retains audit trail.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: 'Deleted', content: { 'application/json': { schema: z.object({ message: z.string() }) } } },
    409: { description: 'Cannot delete paid checkout', content: { 'application/json': { schema: ErrorSchema } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 404));

app.openapi(createRoute({
  method: 'get', path: '/analytics', tags: ['ACP'], summary: 'ACP checkout analytics',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { query: z.object({ period: z.enum(['24h', '7d', '30d', '90d']).default('30d') }) },
  responses: {
    200: { description: 'Analytics', content: { 'application/json': { schema: z.object({
      total_checkouts: z.number(), total_volume: z.string(), completion_rate: z.number(),
      by_status: z.record(z.number()),
    }) } } },
  },
}), async (c): Promise<any> => c.json({ total_checkouts: 0, total_volume: '0', completion_rate: 0, by_status: {} }, 200));

export default app;
