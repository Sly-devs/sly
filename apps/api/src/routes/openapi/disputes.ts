/**
 * Disputes — OpenAPIHono spec scaffold.
 * COVERED: list, create, get, respond, resolve, escalate, stats (7 endpoints)
 */

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { authMiddleware } from '../../middleware/auth.js';

const app = new OpenAPIHono();
app.use('*', authMiddleware);

const DisputeReasonEnum = z.enum([
  'service_not_received',
  'duplicate_charge',
  'unauthorized',
  'amount_incorrect',
  'quality_issue',
  'other',
]);
const DisputeStatusEnum = z.enum(['open', 'under_review', 'escalated', 'resolved']);
const ResolutionEnum = z.enum(['full_refund', 'partial_refund', 'credit', 'no_refund', 'other']);

const EvidenceSchema = z.object({
  type: z.string(),
  description: z.string(),
  url: z.string().url().optional(),
  content: z.string().optional(),
}).openapi('DisputeEvidence');

const DisputeSchema = z.object({
  id: z.string().uuid(),
  transfer_id: z.string().uuid(),
  status: DisputeStatusEnum,
  reason: DisputeReasonEnum,
  description: z.string(),
  amount_disputed: z.string(),
  currency: z.string(),
  requested_resolution: ResolutionEnum.optional(),
  evidence: z.array(EvidenceSchema).default([]),
  response_window_ends_at: z.string().datetime(),
  created_at: z.string().datetime(),
  resolved_at: z.string().datetime().nullable().optional(),
  resolution: ResolutionEnum.nullable().optional(),
}).openapi('Dispute');

const CreateDisputeSchema = z.object({
  transferId: z.string().uuid(),
  reason: DisputeReasonEnum,
  description: z.string().max(2000),
  amountDisputed: z.number().positive().optional(),
  evidence: z.array(EvidenceSchema).optional(),
  requestedResolution: ResolutionEnum.optional(),
}).openapi('CreateDisputeInput');

const ErrorSchema = z.object({
  error: z.string(), code: z.string().optional(), details: z.unknown().optional(),
}).openapi('Error');
const Pagination = z.object({ page: z.number(), limit: z.number(), total: z.number(), totalPages: z.number() });
const notMigrated = () => ({ error: 'Not yet migrated — use the plain-Hono disputes router', code: 'NOT_MIGRATED' });

app.openapi(createRoute({
  method: 'get', path: '/', tags: ['Disputes'], summary: 'List disputes',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { query: z.object({
    status: DisputeStatusEnum.optional(),
    reason: DisputeReasonEnum.optional(),
    account_id: z.string().uuid().optional(),
    due_soon: z.enum(['true', 'false']).optional().describe('Filter to disputes with response window expiring in <72h'),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(200).default(50),
  }) },
  responses: {
    200: { description: 'Paginated disputes', content: { 'application/json': { schema: z.object({ data: z.array(DisputeSchema), pagination: Pagination }) } } },
  },
}), async (c): Promise<any> => c.json({ data: [], pagination: { page: 1, limit: 50, total: 0, totalPages: 0 } }, 200));

app.openapi(createRoute({
  method: 'post', path: '/', tags: ['Disputes'], summary: 'File a dispute',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { body: { content: { 'application/json': { schema: CreateDisputeSchema } }, required: true } },
  responses: {
    201: { description: 'Dispute filed', content: { 'application/json': { schema: z.object({ data: DisputeSchema }) } } },
    400: { description: 'Validation error', content: { 'application/json': { schema: ErrorSchema } } },
    409: { description: 'Dispute window expired or duplicate dispute', content: { 'application/json': { schema: ErrorSchema } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 400));

app.openapi(createRoute({
  method: 'get', path: '/{id}', tags: ['Disputes'], summary: 'Get dispute detail',
  description: 'Includes full timeline from audit log.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { description: 'Dispute', content: { 'application/json': { schema: z.object({ data: DisputeSchema }) } } },
    404: { description: 'Not found', content: { 'application/json': { schema: ErrorSchema } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 404));

app.openapi(createRoute({
  method: 'post', path: '/{id}/respond', tags: ['Disputes'],
  summary: 'Respond to a dispute',
  description: 'The counterparty submits their side with counter-evidence. Must be within `response_window_ends_at`; missing the window auto-resolves in the filer\'s favor.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: { content: { 'application/json': { schema: z.object({
      response: z.string().max(2000),
      counterEvidence: z.array(EvidenceSchema).optional(),
    }) } }, required: true },
  },
  responses: {
    200: { description: 'Response recorded', content: { 'application/json': { schema: z.object({ data: DisputeSchema }) } } },
    409: { description: 'Response window expired or dispute already resolved', content: { 'application/json': { schema: ErrorSchema } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 404));

app.openapi(createRoute({
  method: 'post', path: '/{id}/resolve', tags: ['Disputes'], summary: 'Resolve a dispute',
  description: 'Terminal action. If `resolution` is `full_refund` or `partial_refund`, auto-creates a [refund](#tag/Refunds).',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: { content: { 'application/json': { schema: z.object({
      resolution: ResolutionEnum,
      refundAmount: z.number().positive().optional(),
      notes: z.string().max(1000).optional(),
      cancelMandate: z.boolean().optional().describe('If the dispute relates to an AP2 mandate, optionally revoke it'),
    }) } }, required: true },
  },
  responses: {
    200: { description: 'Resolved', content: { 'application/json': { schema: z.object({ data: DisputeSchema, refund_id: z.string().optional() }) } } },
    409: { description: 'Invalid resolution or already resolved', content: { 'application/json': { schema: ErrorSchema } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 404));

app.openapi(createRoute({
  method: 'post', path: '/{id}/escalate', tags: ['Disputes'], summary: 'Escalate to human review',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: { content: { 'application/json': { schema: z.object({ reason: z.string().max(1000) }) } }, required: true },
  },
  responses: {
    200: { description: 'Escalated', content: { 'application/json': { schema: z.object({ data: DisputeSchema }) } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 404));

app.openapi(createRoute({
  method: 'get', path: '/stats/summary', tags: ['Disputes'], summary: 'Aggregate dispute stats',
  description: 'Counts by status, reason, resolution outcome, and average resolution time. Useful for product/ops dashboards.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  responses: {
    200: { description: 'Summary', content: { 'application/json': { schema: z.object({
      by_status: z.record(z.number()),
      by_reason: z.record(z.number()),
      by_resolution: z.record(z.number()),
      avg_resolution_hours: z.number(),
    }) } } },
  },
}), async (c): Promise<any> => c.json({ by_status: {}, by_reason: {}, by_resolution: {}, avg_resolution_hours: 0 }, 200));

export default app;
