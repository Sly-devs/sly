/**
 * Capabilities — protocol + tool catalog discovery.
 * Mount: /v1/capabilities
 * COVERED: 3 endpoints.
 */

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { authMiddleware } from '../../middleware/auth.js';

const app = new OpenAPIHono();
app.use('*', authMiddleware);

const CapabilitySchema = z.object({
  name: z.string(),
  category: z.enum(['protocol', 'rail', 'feature', 'integration']),
  enabled: z.boolean(),
  version: z.string().optional(),
  description: z.string().optional(),
}).openapi('Capability');

const FunctionCallSchema = z.object({
  name: z.string(),
  description: z.string(),
  parameters: z.record(z.unknown()),
  required_scope: z.string().optional(),
}).openapi('FunctionCall');

app.openapi(createRoute({
  method: 'get', path: '/', tags: ['Capabilities'], summary: 'List enabled capabilities',
  description:
    'Tenant capability advertisement — what protocols, rails, and features are active. Used by agents to discover what they can do.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  responses: {
    200: { description: 'Capabilities', content: { 'application/json': { schema: z.object({ data: z.array(CapabilitySchema) }) } } },
  },
}), async (c): Promise<any> => c.json({ data: [] }, 200));

app.openapi(createRoute({
  method: 'get', path: '/function-calling', tags: ['Capabilities'],
  summary: 'List function-calling tool definitions',
  description:
    'OpenAI / Anthropic-compatible tool definitions for use with function-calling LLMs. Drop into your agent\'s tool list.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  responses: {
    200: { description: 'Tool definitions', content: { 'application/json': { schema: z.object({ tools: z.array(FunctionCallSchema) }) } } },
  },
}), async (c): Promise<any> => c.json({ tools: [] }, 200));

app.openapi(createRoute({
  method: 'get', path: '/protocols', tags: ['Capabilities'], summary: 'List enabled protocols',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  responses: {
    200: { description: 'Protocols', content: { 'application/json': { schema: z.object({
      data: z.array(z.object({
        protocol: z.string(),
        version: z.string(),
        spec_url: z.string().url(),
        endpoints: z.array(z.string()),
      })),
    }) } } },
  },
}), async (c): Promise<any> => c.json({ data: [] }, 200));

export default app;
