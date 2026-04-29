/**
 * Approvals — human-in-the-loop spend approval queue.
 * Mount: /v1/approvals
 * COVERED: 6 endpoints.
 */

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { authMiddleware } from '../../middleware/auth.js';

const app = new OpenAPIHono();
app.use('*', authMiddleware);

const ApprovalStatusEnum = z.enum(['pending', 'approved', 'rejected', 'expired', 'auto_approved']);

const ApprovalSchema = z.object({
  id: z.string(),
  status: ApprovalStatusEnum,
  amount: z.string(),
  currency: z.string(),
  agent: z.object({ id: z.string().uuid(), name: z.string() }),
  merchant: z.object({ id: z.string(), name: z.string() }).nullable().optional(),
  description: z.string().nullable().optional(),
  context: z.record(z.unknown()).default({}),
  approver_role: z.enum(['owner', 'admin']),
  created_at: z.string().datetime(),
  expires_at: z.string().datetime(),
  decided_at: z.string().datetime().nullable().optional(),
  decided_by: z.string().nullable().optional(),
  comment: z.string().nullable().optional(),
}).openapi('Approval');

const ErrorSchema = z.object({
  error: z.string(), code: z.string().optional(), details: z.unknown().optional(),
}).openapi('Error');
const Pagination = z.object({ page: z.number(), limit: z.number(), total: z.number(), totalPages: z.number() });
const notMigrated = () => ({ error: 'Not yet migrated', code: 'NOT_MIGRATED' });

app.openapi(createRoute({
  method: 'get', path: '/', tags: ['Approvals'], summary: 'List approvals',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { query: z.object({
    status: ApprovalStatusEnum.optional(),
    agent_id: z.string().uuid().optional(),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(200).default(50),
  }) },
  responses: {
    200: { description: 'Paginated approvals', content: { 'application/json': { schema: z.object({ data: z.array(ApprovalSchema), pagination: Pagination }) } } },
  },
}), async (c): Promise<any> => c.json({ data: [], pagination: { page: 1, limit: 50, total: 0, totalPages: 0 } }, 200));

app.openapi(createRoute({
  method: 'get', path: '/pending', tags: ['Approvals'], summary: 'Pending approvals only',
  description: 'Subset of GET / filtered to status=pending and not-yet-expired. Use as the queue page for approvers.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  responses: {
    200: { description: 'Pending list', content: { 'application/json': { schema: z.object({ data: z.array(ApprovalSchema) }) } } },
  },
}), async (c): Promise<any> => c.json({ data: [] }, 200));

app.openapi(createRoute({
  method: 'get', path: '/{id}', tags: ['Approvals'], summary: 'Get approval detail',
  description: 'Includes full context — agent spend history, merchant trust, prior approvals at the merchant — to inform the decision.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: 'Approval', content: { 'application/json': { schema: z.object({ data: ApprovalSchema }) } } },
    404: { description: 'Not found', content: { 'application/json': { schema: ErrorSchema } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 404));

app.openapi(createRoute({
  method: 'post', path: '/{id}/approve', tags: ['Approvals'], summary: 'Approve a pending request',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { 'application/json': { schema: z.object({ comment: z.string().max(1000).optional() }) } } },
  },
  responses: {
    200: { description: 'Approved + execution triggered', content: { 'application/json': { schema: z.object({ data: ApprovalSchema, transfer_id: z.string().optional() }) } } },
    409: { description: 'Already decided or expired', content: { 'application/json': { schema: ErrorSchema } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 404));

app.openapi(createRoute({
  method: 'post', path: '/{id}/reject', tags: ['Approvals'], summary: 'Reject a pending request',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { 'application/json': { schema: z.object({ reason: z.string().max(1000) }) } }, required: true },
  },
  responses: {
    200: { description: 'Rejected', content: { 'application/json': { schema: z.object({ data: ApprovalSchema }) } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 404));

app.openapi(createRoute({
  method: 'post', path: '/expire', tags: ['Approvals'], summary: 'Expire stale approvals',
  description: 'Internal-facing — sweeps approvals past their `expires_at` and applies the configured timeout policy (reject or auto-approve).',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  responses: {
    200: { description: 'Expired count', content: { 'application/json': { schema: z.object({ expired: z.number().int() }) } } },
  },
}), async (c): Promise<any> => c.json({ expired: 0 }, 200));

export default app;
