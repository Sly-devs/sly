/**
 * Reputation — agent reputation lookup.
 * Mount: /v1/reputation
 * COVERED: 2 endpoints.
 */

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { authMiddleware } from '../../middleware/auth.js';

const app = new OpenAPIHono();
app.use('*', authMiddleware);

const ReputationSchema = z.object({
  identifier: z.string().describe('Agent ID, ERC-8004 ID, or public key'),
  rating: z.number().min(0).max(5),
  completed_tasks: z.number().int(),
  disputes: z.number().int(),
  attestations: z.array(z.object({
    issuer: z.string(),
    type: z.string(),
    count: z.number().int(),
    last_issued_at: z.string().datetime(),
  })),
  on_chain_score: z.number().nullable().optional(),
}).openapi('Reputation');

const ReputationSourceSchema = z.object({
  type: z.enum(['platform_rating', 'eas_attestation', 'on_chain_score', 'community_review']),
  weight: z.number(),
  raw_data: z.record(z.unknown()),
}).openapi('ReputationSource');

const ErrorSchema = z.object({
  error: z.string(), code: z.string().optional(),
}).openapi('Error');

app.openapi(createRoute({
  method: 'get', path: '/{identifier}', tags: ['Reputation'], summary: 'Get reputation',
  description:
    'Agents can be identified by Sly UUID, ERC-8004 on-chain ID, or Ed25519 public key. Sly returns aggregated reputation across all sources.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { params: z.object({ identifier: z.string() }) },
  responses: {
    200: { description: 'Reputation', content: { 'application/json': { schema: z.object({ data: ReputationSchema }) } } },
    404: { description: 'Not found', content: { 'application/json': { schema: ErrorSchema } } },
  },
}), async (c): Promise<any> => c.json({ error: 'Not yet migrated' }, 404));

app.openapi(createRoute({
  method: 'get', path: '/{identifier}/sources', tags: ['Reputation'], summary: 'List reputation sources',
  description: 'Per-source breakdown — useful when partners want to display weighted contributions.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { params: z.object({ identifier: z.string() }) },
  responses: {
    200: { description: 'Sources', content: { 'application/json': { schema: z.object({ data: z.array(ReputationSourceSchema) }) } } },
  },
}), async (c): Promise<any> => c.json({ data: [] }, 200));

export default app;
