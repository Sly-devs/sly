/**
 * API Keys — OpenAPIHono spec scaffold.
 * COVERED: create, list, get, delete, rotate (5 endpoints)
 */

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { authMiddleware } from '../../middleware/auth.js';

const app = new OpenAPIHono();
app.use('*', authMiddleware);

const EnvironmentEnum = z.enum(['test', 'live']);

const ApiKeySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  prefix: z.string().describe('First 12 chars of the key — safe to display'),
  environment: EnvironmentEnum,
  scopes: z.array(z.string()),
  last_used_at: z.string().datetime().nullable().optional(),
  created_at: z.string().datetime(),
  revoked_at: z.string().datetime().nullable().optional(),
}).openapi('ApiKey');

const ApiKeyWithSecretSchema = ApiKeySchema.extend({
  key: z.string().describe('pk_test_* or pk_live_* — shown ONCE'),
  warning: z.string(),
}).openapi('ApiKeyWithSecret');

const CreateApiKeySchema = z.object({
  name: z.string().min(1).max(255),
  environment: EnvironmentEnum,
  scopes: z.array(z.string()).default(['*:*']).describe('Resource scopes like "accounts:*", "transfers:read", "webhooks:*"'),
}).openapi('CreateApiKeyInput');

const ErrorSchema = z.object({
  error: z.string(), code: z.string().optional(), details: z.unknown().optional(),
}).openapi('Error');
const notMigrated = () => ({ error: 'Not yet migrated — use the plain-Hono api-keys router', code: 'NOT_MIGRATED' });

app.openapi(createRoute({
  method: 'post', path: '/', tags: ['API Keys'], summary: 'Create an API key',
  description:
    'Returns the plaintext key **once**. Save it to your secrets manager immediately — Sly stores only a hash. Use narrow scopes in production.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { body: { content: { 'application/json': { schema: CreateApiKeySchema } }, required: true } },
  responses: {
    201: { description: 'Key created', content: { 'application/json': { schema: z.object({ data: ApiKeyWithSecretSchema }) } } },
    400: { description: 'Validation error', content: { 'application/json': { schema: ErrorSchema } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 400));

app.openapi(createRoute({
  method: 'get', path: '/', tags: ['API Keys'], summary: 'List API keys',
  description: 'Returns metadata only (prefix is safe to display). The plaintext keys are never retrievable after creation.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { query: z.object({
    environment: EnvironmentEnum.optional(),
    include_revoked: z.enum(['true', 'false']).optional(),
  }) },
  responses: {
    200: { description: 'API keys', content: { 'application/json': { schema: z.object({ data: z.array(ApiKeySchema) }) } } },
  },
}), async (c): Promise<any> => c.json({ data: [] }, 200));

app.openapi(createRoute({
  method: 'get', path: '/{id}', tags: ['API Keys'], summary: 'Get an API key',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { description: 'API key', content: { 'application/json': { schema: z.object({ data: ApiKeySchema }) } } },
    404: { description: 'Not found', content: { 'application/json': { schema: ErrorSchema } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 404));

app.openapi(createRoute({
  method: 'delete', path: '/{id}', tags: ['API Keys'], summary: 'Revoke an API key',
  description:
    'Permanent. The key is invalidated instantly; cached verifications may persist up to 60s. Use alongside [overlap rotation](/authentication/api-keys#rotate-a-key) for zero-downtime swaps.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { description: 'Revoked', content: { 'application/json': { schema: z.object({ message: z.string() }) } } },
    404: { description: 'Not found', content: { 'application/json': { schema: ErrorSchema } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 404));

app.openapi(createRoute({
  method: 'post', path: '/{id}/rotate', tags: ['API Keys'], summary: 'Rotate an API key',
  description:
    'Issues a new key with the same scopes and name, then invalidates the old one. Returns the new plaintext key **once**.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: { content: { 'application/json': { schema: z.object({
      strategy: z.enum(['immediate', 'overlap']).default('immediate'),
      overlap_seconds: z.number().int().positive().max(86400).default(300),
    }) } } },
  },
  responses: {
    200: { description: 'Rotated', content: { 'application/json': { schema: z.object({ data: ApiKeyWithSecretSchema }) } } },
    404: { description: 'Not found', content: { 'application/json': { schema: ErrorSchema } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 404));

export default app;
