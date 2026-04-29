/**
 * Portal tokens — scoped tokens for customer-facing dashboards.
 * Mount: /v1/portal-tokens
 * COVERED: 4 endpoints.
 */

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { authMiddleware } from '../../middleware/auth.js';

const app = new OpenAPIHono();
app.use('*', authMiddleware);

const PortalTokenSchema = z.object({
  id: z.string(),
  customer_reference: z.string(),
  scopes: z.array(z.string()),
  expires_at: z.string().datetime(),
  created_at: z.string().datetime(),
  revoked_at: z.string().datetime().nullable().optional(),
}).openapi('PortalToken');

const PortalTokenWithSecretSchema = PortalTokenSchema.extend({
  token: z.string().describe('portal_* — shown ONCE'),
}).openapi('PortalTokenWithSecret');

const ErrorSchema = z.object({
  error: z.string(), code: z.string().optional(), details: z.unknown().optional(),
}).openapi('Error');
const notMigrated = () => ({ error: 'Not yet migrated', code: 'NOT_MIGRATED' });

app.openapi(createRoute({
  method: 'post', path: '/', tags: ['Portal Tokens'],
  summary: 'Mint a portal token',
  description:
    'Customer-scoped, operation-scoped credential safe to ship to a browser. Use for embedded customer dashboards.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { body: { content: { 'application/json': { schema: z.object({
    customer_reference: z.string().min(1).max(255),
    scopes: z.array(z.string()).min(1),
    expires_in: z.number().int().positive().max(86400).default(3600),
  }) } }, required: true } },
  responses: {
    201: { description: 'Token minted', content: { 'application/json': { schema: z.object({ data: PortalTokenWithSecretSchema }) } } },
    400: { description: 'Validation error', content: { 'application/json': { schema: ErrorSchema } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 400));

app.openapi(createRoute({
  method: 'get', path: '/', tags: ['Portal Tokens'], summary: 'List portal tokens',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { query: z.object({
    customer_reference: z.string().optional(),
    include_revoked: z.enum(['true', 'false']).optional(),
  }) },
  responses: {
    200: { description: 'Tokens', content: { 'application/json': { schema: z.object({ data: z.array(PortalTokenSchema) }) } } },
  },
}), async (c): Promise<any> => c.json({ data: [] }, 200));

app.openapi(createRoute({
  method: 'get', path: '/{id}', tags: ['Portal Tokens'], summary: 'Get a portal token',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: 'Token', content: { 'application/json': { schema: z.object({ data: PortalTokenSchema }) } } },
    404: { description: 'Not found', content: { 'application/json': { schema: ErrorSchema } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 404));

app.openapi(createRoute({
  method: 'delete', path: '/{id}', tags: ['Portal Tokens'], summary: 'Revoke a portal token',
  description: 'Instant revocation — portal tokens aren\'t cached.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: 'Revoked', content: { 'application/json': { schema: z.object({ message: z.string() }) } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 404));

export default app;
