/**
 * Tier limits — tenant configuration for KYA/KYC tier caps.
 * Mount: /v1/tier-limits
 * COVERED: 5 endpoints.
 */

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { authMiddleware } from '../../middleware/auth.js';

const app = new OpenAPIHono();
app.use('*', authMiddleware);

const TierLimitSchema = z.object({
  tier: z.number().int().min(0).max(3),
  per_tx_cents: z.number().int(),
  daily_cents: z.number().int(),
  monthly_cents: z.number().int(),
  currency: z.string().default('USD'),
  is_default: z.boolean().describe('True if using platform-default; false if tenant-overridden'),
}).openapi('TierLimit');

const ErrorSchema = z.object({
  error: z.string(), code: z.string().optional(), details: z.unknown().optional(),
}).openapi('Error');
const notMigrated = () => ({ error: 'Not yet migrated', code: 'NOT_MIGRATED' });

app.openapi(createRoute({
  method: 'get', path: '/', tags: ['Tier Limits'], summary: 'Get tier limits config',
  description: 'Returns both KYA (agent) and verification (account) tier caps for your tenant. Includes platform defaults and any tenant-specific overrides.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  responses: {
    200: { description: 'Tier config', content: { 'application/json': { schema: z.object({
      kya: z.array(TierLimitSchema), verification: z.array(TierLimitSchema),
    }) } } },
  },
}), async (c): Promise<any> => c.json({ kya: [], verification: [] }, 200));

app.openapi(createRoute({
  method: 'patch', path: '/kya/{tier}', tags: ['Tier Limits'], summary: 'Override KYA tier cap',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ tier: z.string().describe('0–3') }),
    body: { content: { 'application/json': { schema: z.object({
      per_tx_cents: z.number().int().positive().optional(),
      daily_cents: z.number().int().positive().optional(),
      monthly_cents: z.number().int().positive().optional(),
      currency: z.string().optional(),
    }) } }, required: true },
  },
  responses: {
    200: { description: 'Updated', content: { 'application/json': { schema: z.object({ data: TierLimitSchema }) } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 400));

app.openapi(createRoute({
  method: 'patch', path: '/verification/{tier}', tags: ['Tier Limits'], summary: 'Override verification (account) tier cap',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ tier: z.string() }),
    body: { content: { 'application/json': { schema: z.object({
      per_tx_cents: z.number().int().positive().optional(),
      daily_cents: z.number().int().positive().optional(),
      monthly_cents: z.number().int().positive().optional(),
    }) } }, required: true },
  },
  responses: {
    200: { description: 'Updated', content: { 'application/json': { schema: z.object({ data: TierLimitSchema }) } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 400));

app.openapi(createRoute({
  method: 'delete', path: '/kya/{tier}', tags: ['Tier Limits'], summary: 'Reset KYA tier override to platform default',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { params: z.object({ tier: z.string() }) },
  responses: {
    200: { description: 'Reset', content: { 'application/json': { schema: z.object({ data: TierLimitSchema }) } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 404));

app.openapi(createRoute({
  method: 'delete', path: '/verification/{tier}', tags: ['Tier Limits'], summary: 'Reset verification tier override',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { params: z.object({ tier: z.string() }) },
  responses: {
    200: { description: 'Reset', content: { 'application/json': { schema: z.object({ data: TierLimitSchema }) } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 404));

export default app;
