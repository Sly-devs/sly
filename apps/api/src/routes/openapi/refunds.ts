/**
 * Refunds — OpenAPIHono spec scaffold.
 * COVERED: list, create, get (3 endpoints)
 */

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { authMiddleware } from '../../middleware/auth.js';

const app = new OpenAPIHono();
app.use('*', authMiddleware);

const RefundReasonEnum = z.enum([
  'duplicate_payment',
  'service_not_rendered',
  'customer_request',
  'error',
  'other',
]);

const RefundStatusEnum = z.enum(['pending', 'completed', 'failed']);

const RefundSchema = z.object({
  id: z.string().uuid(),
  original_transfer_id: z.string().uuid(),
  amount: z.string(),
  currency: z.string(),
  reason: RefundReasonEnum,
  reason_details: z.string().nullable().optional(),
  status: RefundStatusEnum,
  refund_transfer_id: z.string().uuid().nullable().optional(),
  created_at: z.string().datetime(),
  completed_at: z.string().datetime().nullable().optional(),
}).openapi('Refund');

const CreateRefundSchema = z.object({
  originalTransferId: z.string().uuid(),
  amount: z.number().positive().optional().describe('Omit for full refund'),
  reason: RefundReasonEnum,
  reasonDetails: z.string().max(1000).optional(),
}).openapi('CreateRefundInput');

const ErrorSchema = z.object({
  error: z.string(), code: z.string().optional(), details: z.unknown().optional(),
}).openapi('Error');

const Pagination = z.object({ page: z.number(), limit: z.number(), total: z.number(), totalPages: z.number() });
const notMigrated = () => ({ error: 'Not yet migrated — use the plain-Hono refunds router', code: 'NOT_MIGRATED' });

app.openapi(createRoute({
  method: 'get', path: '/', tags: ['Refunds'], summary: 'List refunds',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { query: z.object({
    status: RefundStatusEnum.optional(),
    account_id: z.string().uuid().optional(),
    since: z.string().datetime().optional(),
    until: z.string().datetime().optional(),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(200).default(50),
  }) },
  responses: {
    200: { description: 'Paginated refunds', content: { 'application/json': { schema: z.object({ data: z.array(RefundSchema), pagination: Pagination }) } } },
  },
}), async (c): Promise<any> => c.json({ data: [], pagination: { page: 1, limit: 50, total: 0, totalPages: 0 } }, 200));

app.openapi(createRoute({
  method: 'post', path: '/', tags: ['Refunds'], summary: 'Issue a refund',
  description:
    'Initiate a refund against a completed transfer. Omit `amount` for full refund. Multiple partial refunds per transfer are supported as long as the cumulative total ≤ original amount. Always send `X-Idempotency-Key`.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: {
    headers: z.object({ 'x-idempotency-key': z.string().optional() }),
    body: { content: { 'application/json': { schema: CreateRefundSchema } }, required: true },
  },
  responses: {
    201: { description: 'Refund initiated', content: { 'application/json': { schema: z.object({ data: RefundSchema }) } } },
    400: { description: 'Validation error', content: { 'application/json': { schema: ErrorSchema } } },
    402: { description: 'Insufficient balance in source wallet', content: { 'application/json': { schema: ErrorSchema } } },
    404: { description: 'Original transfer not found', content: { 'application/json': { schema: ErrorSchema } } },
    409: { description: 'Refund window expired, amount exceeds remaining, or state transition invalid', content: { 'application/json': { schema: ErrorSchema } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 400));

app.openapi(createRoute({
  method: 'get', path: '/{id}', tags: ['Refunds'], summary: 'Get a refund',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { description: 'Refund detail', content: { 'application/json': { schema: z.object({ data: RefundSchema }) } } },
    404: { description: 'Not found', content: { 'application/json': { schema: ErrorSchema } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 404));

export default app;
