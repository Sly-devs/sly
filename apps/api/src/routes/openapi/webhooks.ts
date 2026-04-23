/**
 * Webhooks — OpenAPIHono spec scaffold.
 * COVERED: stats, events, replay, dlq list, dlq purge, create, list, get (8 endpoints)
 */

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { authMiddleware } from '../../middleware/auth.js';

const app = new OpenAPIHono();
app.use('*', authMiddleware);

const WebhookStatusEnum = z.enum(['active', 'disabled', 'failing']);
const DeliveryStatusEnum = z.enum(['pending', 'processing', 'delivered', 'failed', 'dlq']);

const WebhookSchema = z.object({
  id: z.string().uuid(),
  url: z.string().url(),
  name: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  events: z.array(z.string()).describe('Supports wildcards like "transfer.*"'),
  status: WebhookStatusEnum,
  consecutive_failures: z.number().int(),
  created_at: z.string().datetime(),
}).openapi('Webhook');

const CreateWebhookSchema = z.object({
  url: z.string().url(),
  events: z.array(z.string()).min(1),
  description: z.string().max(500).optional(),
}).openapi('CreateWebhookInput');

const WebhookWithSecretSchema = WebhookSchema.extend({
  secret: z.string().describe('whsec_* — shown ONCE on creation; used for HMAC-SHA256 signature verification'),
}).openapi('WebhookWithSecret');

const DeliverySchema = z.object({
  id: z.string().uuid(),
  event_id: z.string().uuid(),
  event_type: z.string(),
  status: DeliveryStatusEnum,
  attempts: z.number().int(),
  max_attempts: z.number().int(),
  last_response_code: z.number().int().nullable().optional(),
  last_response_body: z.string().nullable().optional(),
  last_attempt_at: z.string().datetime().nullable().optional(),
  next_retry_at: z.string().datetime().nullable().optional(),
  dlq_at: z.string().datetime().nullable().optional(),
  dlq_reason: z.string().nullable().optional(),
  created_at: z.string().datetime(),
  delivered_at: z.string().datetime().nullable().optional(),
}).openapi('WebhookDelivery');

const ErrorSchema = z.object({
  error: z.string(), code: z.string().optional(), details: z.unknown().optional(),
}).openapi('Error');
const Pagination = z.object({ page: z.number(), limit: z.number(), total: z.number(), totalPages: z.number() });
const notMigrated = () => ({ error: 'Not yet migrated — use the plain-Hono webhooks router', code: 'NOT_MIGRATED' });

app.openapi(createRoute({
  method: 'post', path: '/', tags: ['Webhooks'],
  summary: 'Create a webhook subscription',
  description: 'Returns `secret` (whsec_*) shown once — save it to verify signatures. See [signature verification](/sdks/webhook-verification).',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { body: { content: { 'application/json': { schema: CreateWebhookSchema } }, required: true } },
  responses: {
    201: { description: 'Webhook created', content: { 'application/json': { schema: z.object({ data: WebhookWithSecretSchema }) } } },
    400: { description: 'Validation error', content: { 'application/json': { schema: ErrorSchema } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 400));

app.openapi(createRoute({
  method: 'get', path: '/', tags: ['Webhooks'], summary: 'List webhooks',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { query: z.object({ status: WebhookStatusEnum.optional() }) },
  responses: {
    200: { description: 'Webhooks', content: { 'application/json': { schema: z.object({ data: z.array(WebhookSchema) }) } } },
  },
}), async (c): Promise<any> => c.json({ data: [] }, 200));

app.openapi(createRoute({
  method: 'get', path: '/{id}', tags: ['Webhooks'], summary: 'Get a webhook',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { description: 'Webhook', content: { 'application/json': { schema: z.object({ data: WebhookSchema }) } } },
    404: { description: 'Not found', content: { 'application/json': { schema: ErrorSchema } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 404));

app.openapi(createRoute({
  method: 'get', path: '/events', tags: ['Webhooks'],
  summary: 'List supported event types',
  description: 'Returns the machine-readable catalog of event types your tenant can subscribe to.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  responses: {
    200: { description: 'Event catalog', content: { 'application/json': { schema: z.object({
      events: z.array(z.object({ type: z.string(), description: z.string() })),
    }) } } },
  },
}), async (c): Promise<any> => c.json({ events: [] }, 200));

app.openapi(createRoute({
  method: 'get', path: '/stats', tags: ['Webhooks'],
  summary: 'Delivery stats',
  description: 'Per-endpoint and tenant-wide delivery counters (delivered, failed, retrying, DLQ).',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  responses: {
    200: { description: 'Stats', content: { 'application/json': { schema: z.object({
      delivered: z.number(), failed: z.number(), retrying: z.number(), dlq: z.number(),
    }) } } },
  },
}), async (c): Promise<any> => c.json({ delivered: 0, failed: 0, retrying: 0, dlq: 0 }, 200));

app.openapi(createRoute({
  method: 'post', path: '/replay', tags: ['Webhooks'],
  summary: 'Bulk replay deliveries',
  description: 'Replay events from a time window. Use `only_failed: true` to skip already-delivered events. Replays carry the same `X-Sly-Event-Id`; your dedupe protects against double-processing.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { body: { content: { 'application/json': { schema: z.object({
    webhook_id: z.string().uuid().optional(),
    since: z.string().datetime(),
    until: z.string().datetime().optional(),
    event_types: z.array(z.string()).optional(),
    only_failed: z.boolean().default(true),
    override_url: z.string().url().optional().describe('Redirect replays to a different URL — useful when testing a new endpoint against real traffic'),
  }) } }, required: true } },
  responses: {
    202: { description: 'Replay scheduled', content: { 'application/json': { schema: z.object({ queued: z.number() }) } } },
  },
}), async (c): Promise<any> => c.json({ queued: 0 }, 202));

app.openapi(createRoute({
  method: 'get', path: '/deliveries/dlq', tags: ['Webhooks'],
  summary: 'List dead-letter queue',
  description: 'Deliveries that exhausted all retries. Subscribe to `webhook.dlq` for real-time alerts.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { query: z.object({
    webhook_id: z.string().uuid().optional(),
    since: z.string().datetime().optional(),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(200).default(50),
  }) },
  responses: {
    200: { description: 'DLQ entries', content: { 'application/json': { schema: z.object({ data: z.array(DeliverySchema), pagination: Pagination }) } } },
  },
}), async (c): Promise<any> => c.json({ data: [], pagination: { page: 1, limit: 50, total: 0, totalPages: 0 } }, 200));

app.openapi(createRoute({
  method: 'delete', path: '/deliveries/dlq', tags: ['Webhooks'],
  summary: 'Purge dead-letter queue',
  description: 'Permanently removes DLQ entries. Usually done after manual review confirms the events are either truly failed or have been processed manually.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { query: z.object({
    webhook_id: z.string().uuid().optional(),
    older_than: z.string().datetime().optional(),
  }) },
  responses: {
    200: { description: 'Purged', content: { 'application/json': { schema: z.object({ deleted: z.number() }) } } },
  },
}), async (c): Promise<any> => c.json({ deleted: 0 }, 200));

export default app;
