/**
 * MPP (Machine Payments Protocol) — session-based M2M payments.
 * Mount: /v1/mpp
 * COVERED: 14 endpoints.
 */

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { authMiddleware } from '../../middleware/auth.js';

const app = new OpenAPIHono();
app.use('*', authMiddleware);

const SessionStatusEnum = z.enum(['open', 'active', 'closed', 'exhausted', 'error']);

const MPPSessionSchema = z.object({
  id: z.string(),
  service_url: z.string().url(),
  agent_id: z.string().uuid(),
  wallet_id: z.string().uuid(),
  deposit_amount: z.string(),
  currency: z.string(),
  budget_remaining: z.string(),
  budget_used: z.string(),
  status: SessionStatusEnum,
  voucher_key: z.string().describe('Ed25519 public key for voucher verification'),
  expires_at: z.string().datetime(),
  created_at: z.string().datetime(),
}).openapi('MPPSession');

const MPPVoucherSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  amount: z.string(),
  description: z.string().nullable().optional(),
  request_id: z.string().nullable().optional(),
  signed_voucher: z.string().describe('Signed voucher the service verifies to collect payment'),
  created_at: z.string().datetime(),
}).openapi('MPPVoucher');

const MPPTransferSchema = z.object({
  id: z.string(),
  session_id: z.string().nullable().optional(),
  service_url: z.string().url(),
  amount: z.string(),
  currency: z.string(),
  status: z.enum(['pending', 'completed', 'failed']),
  created_at: z.string().datetime(),
}).openapi('MPPTransfer');

const MPPServiceSchema = z.object({
  domain: z.string(),
  name: z.string().optional(),
  category: z.string().optional(),
  pricing: z.object({
    base_price: z.string(),
    currency: z.string(),
    unit: z.string(),
  }),
  accepts_sessions: z.boolean(),
  min_deposit: z.string().nullable().optional(),
}).openapi('MPPService');

const ErrorSchema = z.object({
  error: z.string(), code: z.string().optional(), details: z.unknown().optional(),
}).openapi('Error');
const Pagination = z.object({ page: z.number(), limit: z.number(), total: z.number(), totalPages: z.number() });
const notMigrated = () => ({ error: 'Not yet migrated — use plain-Hono MPP router', code: 'NOT_MIGRATED' });

app.openapi(createRoute({
  method: 'post', path: '/pay', tags: ['MPP'], summary: 'One-shot micropayment',
  description: 'Single M2M payment without opening a session. Useful for first-call or one-off payments.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { body: { content: { 'application/json': { schema: z.object({
    service_url: z.string().url(),
    amount: z.number().positive(),
    currency: z.string().default('USDC'),
    agent_id: z.string().uuid(),
    wallet_id: z.string().uuid(),
    description: z.string().optional(),
  }) } }, required: true } },
  responses: {
    201: { description: 'Paid', content: { 'application/json': { schema: z.object({ data: MPPTransferSchema }) } } },
    400: { description: 'Validation error', content: { 'application/json': { schema: ErrorSchema } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 400));

app.openapi(createRoute({
  method: 'post', path: '/sessions', tags: ['MPP'], summary: 'Open a session',
  description: 'Pre-deposit a budget for streaming micropayments to a service. Sign vouchers via /sessions/:id/voucher for each call. Close via /sessions/:id/close.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { body: { content: { 'application/json': { schema: z.object({
    service_url: z.string().url(),
    deposit_amount: z.number().positive(),
    currency: z.string().default('USDC'),
    agent_id: z.string().uuid(),
    wallet_id: z.string().uuid(),
  }) } }, required: true } },
  responses: {
    201: { description: 'Session opened', content: { 'application/json': { schema: z.object({ data: MPPSessionSchema }) } } },
    402: { description: 'Wallet balance insufficient for deposit', content: { 'application/json': { schema: ErrorSchema } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 400));

app.openapi(createRoute({
  method: 'get', path: '/sessions', tags: ['MPP'], summary: 'List sessions',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { query: z.object({
    agent_id: z.string().uuid().optional(),
    status: SessionStatusEnum.optional(),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(200).default(50),
  }) },
  responses: {
    200: { description: 'Paginated sessions', content: { 'application/json': { schema: z.object({ data: z.array(MPPSessionSchema), pagination: Pagination }) } } },
  },
}), async (c): Promise<any> => c.json({ data: [], pagination: { page: 1, limit: 50, total: 0, totalPages: 0 } }, 200));

app.openapi(createRoute({
  method: 'get', path: '/sessions/{sessionId}', tags: ['MPP'], summary: 'Get a session',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { params: z.object({ sessionId: z.string() }) },
  responses: {
    200: { description: 'Session + voucher list', content: { 'application/json': { schema: z.object({
      data: MPPSessionSchema, vouchers: z.array(MPPVoucherSchema),
    }) } } },
    404: { description: 'Not found', content: { 'application/json': { schema: ErrorSchema } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 404));

app.openapi(createRoute({
  method: 'post', path: '/sessions/{sessionId}/voucher', tags: ['MPP'], summary: 'Sign a voucher',
  description: 'Sign a voucher for a unit of service. Budget decrements; remaining balance returned in response.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ sessionId: z.string() }),
    body: { content: { 'application/json': { schema: z.object({
      amount: z.number().positive(),
      description: z.string().optional(),
      request_id: z.string().optional(),
    }) } }, required: true },
  },
  responses: {
    201: { description: 'Voucher signed', content: { 'application/json': { schema: z.object({ data: MPPVoucherSchema, budget_remaining: z.string() }) } } },
    402: { description: 'Insufficient session balance', content: { 'application/json': { schema: ErrorSchema } } },
    409: { description: 'Session closed / exhausted', content: { 'application/json': { schema: ErrorSchema } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 400));

app.openapi(createRoute({
  method: 'post', path: '/sessions/{sessionId}/close', tags: ['MPP'], summary: 'Close session',
  description: 'Finalize all signed vouchers, debit the agent wallet, return unspent deposit.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { params: z.object({ sessionId: z.string() }) },
  responses: {
    200: { description: 'Closed', content: { 'application/json': { schema: z.object({
      data: MPPSessionSchema, refunded: z.string(), settled: z.string(),
    }) } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 404));

app.openapi(createRoute({
  method: 'post', path: '/sessions/{sessionId}/stream', tags: ['MPP'], summary: 'Stream session events',
  description: 'Server-sent event stream of voucher activity for a session. Useful for live dashboards during a long-running session.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { params: z.object({ sessionId: z.string() }) },
  responses: {
    200: {
      description: 'SSE stream — each event includes voucher_id, amount, budget_remaining',
      content: { 'text/event-stream': { schema: z.string() } },
    },
  },
}), async (c): Promise<any> => c.text('', 200));

app.openapi(createRoute({
  method: 'get', path: '/transfers', tags: ['MPP'], summary: 'List MPP transfers',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { query: z.object({
    session_id: z.string().optional(),
    service_url: z.string().optional(),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(200).default(50),
  }) },
  responses: {
    200: { description: 'Paginated transfers', content: { 'application/json': { schema: z.object({ data: z.array(MPPTransferSchema), pagination: Pagination }) } } },
  },
}), async (c): Promise<any> => c.json({ data: [], pagination: { page: 1, limit: 50, total: 0, totalPages: 0 } }, 200));

app.openapi(createRoute({
  method: 'post', path: '/wallets/provision', tags: ['MPP'], summary: 'Provision MPP wallet',
  description: 'Provision a Tempo wallet capable of voucher signing. One-time per agent.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { body: { content: { 'application/json': { schema: z.object({ agent_id: z.string().uuid() }) } }, required: true } },
  responses: {
    201: { description: 'Provisioned', content: { 'application/json': { schema: z.object({ wallet_id: z.string().uuid(), voucher_key: z.string() }) } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 400));

app.openapi(createRoute({
  method: 'get', path: '/services', tags: ['MPP'], summary: 'Discover MPP services',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { query: z.object({
    category: z.string().optional(),
    search: z.string().optional(),
  }) },
  responses: {
    200: { description: 'Services', content: { 'application/json': { schema: z.object({ data: z.array(MPPServiceSchema) }) } } },
  },
}), async (c): Promise<any> => c.json({ data: [] }, 200));

app.openapi(createRoute({
  method: 'get', path: '/services/{domain}/pricing', tags: ['MPP'], summary: 'Probe service pricing',
  description: 'Live-probe a service\'s MPP pricing endpoint (HEAD / well-known probe).',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { params: z.object({ domain: z.string() }) },
  responses: {
    200: { description: 'Pricing', content: { 'application/json': { schema: MPPServiceSchema } } },
    404: { description: 'Service does not advertise MPP', content: { 'application/json': { schema: ErrorSchema } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 404));

app.openapi(createRoute({
  method: 'post', path: '/receipts/verify', tags: ['MPP'], summary: 'Verify a receipt',
  description: 'Service-side: verify a voucher claim against the issuing session.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { body: { content: { 'application/json': { schema: z.object({ voucher_id: z.string() }) } }, required: true } },
  responses: {
    200: { description: 'Verification result', content: { 'application/json': { schema: z.object({
      valid: z.boolean(),
      session_id: z.string().optional(),
      amount: z.string().optional(),
      issued_at: z.string().datetime().optional(),
      expires_at: z.string().datetime().optional(),
      reason: z.string().optional(),
    }) } } },
  },
}), async (c): Promise<any> => c.json({ valid: false }, 200));

app.openapi(createRoute({
  method: 'get', path: '/analytics', tags: ['MPP'], summary: 'MPP analytics',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { query: z.object({ period: z.enum(['24h', '7d', '30d', '90d', '1y']).default('30d') }) },
  responses: {
    200: { description: 'Summary', content: { 'application/json': { schema: z.object({
      transfer_volume: z.string(),
      fees: z.string(),
      sessions_opened: z.number(),
      budget_utilization: z.number().describe('Average ratio of budget spent to deposited'),
    }) } } },
  },
}), async (c): Promise<any> => c.json({ transfer_volume: '0', fees: '0', sessions_opened: 0, budget_utilization: 0 }, 200));

app.openapi(createRoute({
  method: 'get', path: '/reconciliation', tags: ['MPP'], summary: 'Receipt-level reconciliation',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { query: z.object({
    session_id: z.string().optional(),
    since: z.string().datetime().optional(),
    until: z.string().datetime().optional(),
  }) },
  responses: {
    200: { description: 'Reconciliation', content: { 'application/json': { schema: z.object({
      matched: z.number(), unmatched_ledger: z.number(), unmatched_receipts: z.number(),
      discrepancies: z.array(z.object({ id: z.string(), type: z.string() })),
    }) } } },
  },
}), async (c): Promise<any> => c.json({ matched: 0, unmatched_ledger: 0, unmatched_receipts: 0, discrepancies: [] }, 200));

export default app;
