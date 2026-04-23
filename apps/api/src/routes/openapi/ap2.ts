/**
 * AP2 (Google Agent Payment Protocol) — mandate-based spending.
 * Mount: /v1/ap2
 * COVERED: 14 endpoints.
 */

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { authMiddleware } from '../../middleware/auth.js';

const app = new OpenAPIHono();
app.use('*', authMiddleware);

const MandateStatusEnum = z.enum(['active', 'paused', 'suspended', 'cancelled', 'revoked', 'expired']);

const MandateScopeSchema = z.object({
  max_per_tx: z.string(),
  max_per_day: z.string(),
  max_per_month: z.string(),
  currency: z.string(),
  allowed_merchant_categories: z.array(z.string()).optional(),
  allowed_merchants: z.array(z.string()).optional(),
  blocked_merchants: z.array(z.string()).optional(),
}).openapi('AP2MandateScope');

const MandateSchema = z.object({
  id: z.string(),
  account_id: z.string().uuid(),
  agent_id: z.string().uuid(),
  status: MandateStatusEnum,
  mandate_jwt: z.string().describe('Ed25519-signed JWT verifiable offline via the JWKS endpoint'),
  scope: MandateScopeSchema,
  metadata: z.record(z.unknown()).default({}),
  expires_at: z.string().datetime(),
  created_at: z.string().datetime(),
}).openapi('AP2Mandate');

const MandateExecutionSchema = z.object({
  id: z.string(),
  mandate_id: z.string(),
  agent_id: z.string().uuid(),
  merchant_id: z.string(),
  amount: z.string(),
  currency: z.string(),
  description: z.string().nullable().optional(),
  transfer_id: z.string().uuid().nullable().optional(),
  status: z.enum(['pending', 'completed', 'failed']),
  executed_at: z.string().datetime(),
  remaining_daily: z.string(),
  remaining_monthly: z.string(),
}).openapi('AP2MandateExecution');

const CreateMandateSchema = z.object({
  account_id: z.string().uuid(),
  agent_id: z.string().uuid(),
  scope: MandateScopeSchema,
  expires_at: z.string().datetime(),
  metadata: z.record(z.unknown()).optional(),
}).openapi('CreateAP2MandateInput');

const ExecuteMandateSchema = z.object({
  merchant_id: z.string(),
  amount: z.number().positive(),
  currency: z.string(),
  description: z.string().optional(),
  idempotency_key: z.string().optional(),
}).openapi('ExecuteAP2MandateInput');

const AgentCardSchema = z.object({
  issuer: z.string(),
  public_key: z.string(),
  jwks_url: z.string().url(),
  supported_scopes: z.array(z.string()),
}).openapi('AP2AgentCard');

const AP2PaymentSchema = z.object({
  id: z.string(),
  mandate_id: z.string(),
  amount: z.string(),
  currency: z.string(),
  status: z.enum(['pending', 'settled', 'failed']),
  settled_at: z.string().datetime().nullable().optional(),
  created_at: z.string().datetime(),
}).openapi('AP2Payment');

const ErrorSchema = z.object({
  error: z.string(), code: z.string().optional(), details: z.unknown().optional(),
}).openapi('Error');
const Pagination = z.object({ page: z.number(), limit: z.number(), total: z.number(), totalPages: z.number() });
const notMigrated = () => ({ error: 'Not yet migrated — use plain-Hono AP2 router', code: 'NOT_MIGRATED' });

app.openapi(createRoute({
  method: 'get', path: '/agent-card', tags: ['AP2'], summary: 'AP2 agent card',
  description: 'Public AP2 capability advertisement — issuer, public key, supported scopes. Used by merchants to verify mandates offline.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  responses: {
    200: { description: 'Agent card', content: { 'application/json': { schema: AgentCardSchema } } },
  },
}), async (c): Promise<any> => c.json({ issuer: '', public_key: '', jwks_url: '', supported_scopes: [] }, 200));

app.openapi(createRoute({
  method: 'post', path: '/mandates', tags: ['AP2'], summary: 'Create a mandate',
  description: 'Issue a signed mandate authorizing an agent to spend within a scope. Returns `mandate_jwt` — present on every execution.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { body: { content: { 'application/json': { schema: CreateMandateSchema } }, required: true } },
  responses: {
    201: { description: 'Mandate created', content: { 'application/json': { schema: z.object({ data: MandateSchema }) } } },
    400: { description: 'Validation error', content: { 'application/json': { schema: ErrorSchema } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 400));

app.openapi(createRoute({
  method: 'get', path: '/mandates', tags: ['AP2'], summary: 'List mandates',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { query: z.object({
    agent_id: z.string().uuid().optional(),
    account_id: z.string().uuid().optional(),
    status: MandateStatusEnum.optional(),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(200).default(50),
  }) },
  responses: {
    200: { description: 'Paginated mandates', content: { 'application/json': { schema: z.object({ data: z.array(MandateSchema), pagination: Pagination }) } } },
  },
}), async (c): Promise<any> => c.json({ data: [], pagination: { page: 1, limit: 50, total: 0, totalPages: 0 } }, 200));

app.openapi(createRoute({
  method: 'get', path: '/mandates/{id}', tags: ['AP2'], summary: 'Get a mandate',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: 'Mandate', content: { 'application/json': { schema: z.object({ data: MandateSchema }) } } },
    404: { description: 'Not found', content: { 'application/json': { schema: ErrorSchema } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 404));

app.openapi(createRoute({
  method: 'patch', path: '/mandates/{id}', tags: ['AP2'], summary: 'Update mandate scope',
  description: 'Modify caps or merchant rules in-place. Prior scope retained in audit log.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { 'application/json': { schema: z.object({
      scope: MandateScopeSchema.partial().optional(),
      expires_at: z.string().datetime().optional(),
      metadata: z.record(z.unknown()).optional(),
    }) } }, required: true },
  },
  responses: {
    200: { description: 'Updated', content: { 'application/json': { schema: z.object({ data: MandateSchema }) } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 404));

for (const [op, action, desc] of [
  ['cancel', 'Cancel', 'Soft-cancel — mandate goes to `cancelled`, audit trail preserved.'],
  ['activate', 'Activate', 'Resume a paused or suspended mandate.'],
  ['suspend', 'Suspend', 'Temporarily disable — no executions allowed until resumed.'],
  ['revoke', 'Revoke', 'Hard revoke — mandate state `revoked`, cannot be reactivated.'],
] as const) {
  app.openapi(createRoute({
    method: op === 'cancel' ? 'patch' : 'post',
    path: `/mandates/{id}/${op}`,
    tags: ['AP2'],
    summary: `${action} a mandate`,
    description: desc,
    'x-visibility': 'public', security: [{ bearerAuth: [] }],
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: { description: `${action}d`, content: { 'application/json': { schema: z.object({ data: MandateSchema }) } } },
      409: { description: 'Invalid state transition', content: { 'application/json': { schema: ErrorSchema } } },
    },
  }), async (c): Promise<any> => c.json(notMigrated(), 404));
}

app.openapi(createRoute({
  method: 'post', path: '/mandates/{id}/execute', tags: ['AP2'], summary: 'Execute a mandate',
  description:
    "Each execution re-checks scope (amount within caps, merchant allowed, not expired) + day/month running totals + KYA tier + wallet policy. If any check fails, returns 403 with the specific reason.",
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { 'application/json': { schema: ExecuteMandateSchema } }, required: true },
  },
  responses: {
    201: { description: 'Executed', content: { 'application/json': { schema: z.object({ data: MandateExecutionSchema }) } } },
    403: { description: 'Scope, policy, or KYA tier check failed', content: { 'application/json': { schema: ErrorSchema } } },
    409: { description: 'Mandate inactive or expired', content: { 'application/json': { schema: ErrorSchema } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 400));

app.openapi(createRoute({
  method: 'post', path: '/payments', tags: ['AP2'], summary: 'Initiate an AP2 payment',
  description: 'Low-level payment primitive used by mandate executions. Rarely called directly — use /mandates/:id/execute.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { body: { content: { 'application/json': { schema: z.object({
    mandate_id: z.string(),
    amount: z.number().positive(),
    currency: z.string(),
  }) } }, required: true } },
  responses: {
    201: { description: 'Payment initiated', content: { 'application/json': { schema: z.object({ data: AP2PaymentSchema }) } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 400));

app.openapi(createRoute({
  method: 'get', path: '/payments/{id}', tags: ['AP2'], summary: 'Get a payment',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: 'Payment', content: { 'application/json': { schema: z.object({ data: AP2PaymentSchema }) } } },
    404: { description: 'Not found', content: { 'application/json': { schema: ErrorSchema } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 404));

app.openapi(createRoute({
  method: 'post', path: '/payments/{id}/settle', tags: ['AP2'], summary: 'Settle an AP2 payment',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: 'Settled', content: { 'application/json': { schema: z.object({ data: AP2PaymentSchema }) } } },
    409: { description: 'Already settled or in invalid state', content: { 'application/json': { schema: ErrorSchema } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 400));

app.openapi(createRoute({
  method: 'get', path: '/analytics', tags: ['AP2'], summary: 'AP2 analytics',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { query: z.object({ period: z.enum(['24h', '7d', '30d', '90d']).default('30d') }) },
  responses: {
    200: { description: 'Stats', content: { 'application/json': { schema: z.object({
      active_mandates: z.number(), executions_total: z.number(), volume: z.string(),
      top_merchants: z.array(z.object({ merchant_id: z.string(), count: z.number(), volume: z.string() })),
    }) } } },
  },
}), async (c): Promise<any> => c.json({ active_mandates: 0, executions_total: 0, volume: '0', top_merchants: [] }, 200));

export default app;
