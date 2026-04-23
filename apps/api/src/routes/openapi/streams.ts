/**
 * Streams — OpenAPIHono spec scaffold.
 * COVERED: list, create, get, pause, resume, cancel, top-up, withdraw (8 endpoints)
 */

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { authMiddleware } from '../../middleware/auth.js';

const app = new OpenAPIHono();
app.use('*', authMiddleware);

const StreamStatusEnum = z.enum(['active', 'paused', 'cancelled', 'exhausted']);

const StreamSchema = z.object({
  id: z.string().uuid(),
  from_wallet_id: z.string().uuid(),
  to_wallet_id: z.string().uuid(),
  flow_rate: z.string().describe('Amount per second, as a decimal string'),
  currency: z.string(),
  wrapped_balance: z.string(),
  buffer: z.string(),
  runway_seconds: z.number().int(),
  recipient_balance: z.string(),
  status: StreamStatusEnum,
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
}).openapi('Stream');

const CreateStreamSchema = z.object({
  from_wallet_id: z.string().uuid(),
  to_wallet_id: z.string().uuid(),
  flow_rate: z.string(),
  currency: z.string().default('USDC'),
  initial_deposit: z.string(),
  buffer: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
}).openapi('CreateStreamInput');

const AmountBodySchema = z.object({ amount: z.string() });

const ErrorSchema = z.object({
  error: z.string(), code: z.string().optional(), details: z.unknown().optional(),
}).openapi('Error');

const Pagination = z.object({ page: z.number(), limit: z.number(), total: z.number(), totalPages: z.number() });
const notMigrated = () => ({ error: 'Not yet migrated — use the plain-Hono streams router', code: 'NOT_MIGRATED' });

app.openapi(createRoute({
  method: 'get', path: '/', tags: ['Streams'], summary: 'List streams', 'x-visibility': 'public',
  security: [{ bearerAuth: [] }],
  request: { query: z.object({
    status: StreamStatusEnum.optional(),
    wallet_id: z.string().uuid().optional(),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(200).default(50),
  }) },
  responses: {
    200: { description: 'Paginated streams', content: { 'application/json': { schema: z.object({ data: z.array(StreamSchema), pagination: Pagination }) } } },
  },
}), async (c): Promise<any> => c.json({ data: [], pagination: { page: 1, limit: 50, total: 0, totalPages: 0 } }, 200));

app.openapi(createRoute({
  method: 'post', path: '/', tags: ['Streams'],
  summary: 'Open a stream',
  description: 'Open a continuous payment flow. `initial_deposit` is locked into the stream escrow; flow_rate drains it per second. Returns the stream with computed `runway_seconds`.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { body: { content: { 'application/json': { schema: CreateStreamSchema } }, required: true } },
  responses: {
    201: { description: 'Stream opened', content: { 'application/json': { schema: z.object({ data: StreamSchema }) } } },
    400: { description: 'Validation error', content: { 'application/json': { schema: ErrorSchema } } },
    402: { description: 'Insufficient balance for initial deposit', content: { 'application/json': { schema: ErrorSchema } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 400));

app.openapi(createRoute({
  method: 'get', path: '/{id}', tags: ['Streams'], summary: 'Get a stream', 'x-visibility': 'public',
  security: [{ bearerAuth: [] }], request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { description: 'Stream', content: { 'application/json': { schema: z.object({ data: StreamSchema }) } } },
    404: { description: 'Not found', content: { 'application/json': { schema: ErrorSchema } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 404));

for (const [op, action] of [['pause', 'Pause'], ['resume', 'Resume'], ['cancel', 'Cancel']] as const) {
  app.openapi(createRoute({
    method: 'post', path: `/{id}/${op}`, tags: ['Streams'], summary: `${action} a stream`,
    description: action === 'Cancel'
      ? 'Cancellation transfers accrued balance to recipient and returns unused funds to sender. Stream state becomes `cancelled`.'
      : `${action}s a stream. Paused streams don't accrue balance but wrapped funds stay locked.`,
    'x-visibility': 'public', security: [{ bearerAuth: [] }],
    request: { params: z.object({ id: z.string().uuid() }) },
    responses: {
      200: { description: `${action}d`, content: { 'application/json': { schema: z.object({ data: StreamSchema }) } } },
      404: { description: 'Not found', content: { 'application/json': { schema: ErrorSchema } } },
      409: { description: 'Invalid state transition', content: { 'application/json': { schema: ErrorSchema } } },
    },
  }), async (c): Promise<any> => c.json(notMigrated(), 404));
}

app.openapi(createRoute({
  method: 'post', path: '/{id}/top-up', tags: ['Streams'],
  summary: 'Top up a stream', description: 'Add funds to extend runway. Sender wallet is debited; wrapped_balance increases.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string().uuid() }), body: { content: { 'application/json': { schema: AmountBodySchema } }, required: true } },
  responses: {
    200: { description: 'Topped up', content: { 'application/json': { schema: z.object({ data: StreamSchema }) } } },
    402: { description: 'Insufficient balance on sender wallet', content: { 'application/json': { schema: ErrorSchema } } },
    404: { description: 'Not found', content: { 'application/json': { schema: ErrorSchema } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 404));

app.openapi(createRoute({
  method: 'post', path: '/{id}/withdraw', tags: ['Streams'],
  summary: 'Recipient withdraws accrued balance',
  description: 'Creates a `stream_withdraw` transfer moving accrued recipient_balance into the recipient wallet. Omit amount to withdraw all accrued.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string().uuid() }), body: { content: { 'application/json': { schema: AmountBodySchema.partial() } } } },
  responses: {
    200: { description: 'Withdrawn', content: { 'application/json': { schema: z.object({ data: StreamSchema, transfer_id: z.string() }) } } },
    404: { description: 'Not found', content: { 'application/json': { schema: ErrorSchema } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 404));

export default app;
