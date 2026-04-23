/**
 * Agents routes — OpenAPIHono spec scaffold.
 *
 * COVERED IN SPEC
 *   ✓ POST  /v1/agents            — create agent (+ optional keypair)
 *   ✓ GET   /v1/agents            — list
 *   ✓ GET   /v1/agents/{id}       — get
 *   ✓ PATCH /v1/agents/{id}       — update
 *   ✓ DELETE /v1/agents/{id}      — delete / revoke
 *   ✓ GET   /v1/agents/{id}/limits       — effective KYA limits
 *   ✓ POST  /v1/agents/{id}/suspend      — freeze
 *   ✓ POST  /v1/agents/{id}/activate     — unfreeze
 *   ⬜ /verify, /challenge, /authenticate, /auth-keys, /connect,
 *     /skills, /transactions — TODO
 */

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { authMiddleware } from '../../middleware/auth.js';

const app = new OpenAPIHono();
app.use('*', authMiddleware);

// ============================================================================
// Schemas
// ============================================================================

const AgentStatusEnum = z.enum(['active', 'frozen', 'suspended', 'revoked']);

const AgentSchema = z
  .object({
    id: z.string().uuid(),
    parent_account_id: z.string().uuid(),
    name: z.string(),
    description: z.string().nullable().optional(),
    status: AgentStatusEnum,
    kya_tier: z.number().int().min(0).max(3),
    skills: z.array(z.string()).default([]),
    metadata: z.record(z.unknown()).default({}),
    public_key: z.string().nullable().optional().describe('Ed25519 public key (base64)'),
    connected: z.boolean().default(false).describe('True iff an SSE session is currently open'),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .openapi('Agent');

const AgentCredentialsSchema = z
  .object({
    token: z.string().describe('Bearer agent_* token — shown ONCE'),
    warning: z.string(),
  })
  .openapi('AgentCredentials');

const AgentAuthKeySchema = z
  .object({
    keyId: z.string(),
    publicKey: z.string().describe('base64 Ed25519 public key'),
    privateKey: z.string().describe('base64 Ed25519 private key — shown ONCE'),
    algorithm: z.literal('ed25519'),
    warning: z.string(),
  })
  .openapi('AgentAuthKey');

const CreateAgentSchema = z
  .object({
    parentAccountId: z.string().uuid(),
    name: z.string().min(1).max(255),
    description: z.string().max(1000).optional(),
    kyaTier: z.number().int().min(0).max(3).default(0),
    generateKeypair: z.boolean().default(false).describe('If true, returns an Ed25519 keypair (private key shown once)'),
    skills: z.array(z.string()).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .openapi('CreateAgentInput');

const UpdateAgentSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    description: z.string().max(1000).nullable().optional(),
    skills: z.array(z.string()).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .openapi('UpdateAgentInput');

const AgentLimitsSchema = z
  .object({
    kya_tier: z.number().int(),
    agent_limits: z.object({ per_tx: z.string(), daily: z.string(), monthly: z.string() }),
    account_limits: z.object({ per_tx: z.string(), daily: z.string(), monthly: z.string() }),
    effective_limits: z.object({ per_tx: z.string(), daily: z.string(), monthly: z.string() }),
    used_today: z.string(),
    used_this_month: z.string(),
  })
  .openapi('AgentLimits');

const ErrorSchema = z
  .object({
    error: z.string(),
    code: z.string().optional(),
    details: z.unknown().optional(),
    request_id: z.string().optional(),
  })
  .openapi('Error');

const PaginationSchema = z.object({
  page: z.number().int(),
  limit: z.number().int(),
  total: z.number().int(),
  totalPages: z.number().int(),
});

const notMigrated = (): z.infer<typeof ErrorSchema> => ({
  error: 'Not yet migrated — use the plain-Hono agents router',
  code: 'NOT_MIGRATED',
});

// ============================================================================
// POST /agents
// ============================================================================

const createAgentRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Agents'],
  summary: 'Create an agent',
  description:
    'Register an AI actor under a parent account. The response contains credentials — the `agent_*` token and (if requested) an Ed25519 keypair. Both the token and the private key are shown **once** and not recoverable.',
  'x-visibility': 'public',
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: CreateAgentSchema } }, required: true },
  },
  responses: {
    201: {
      description: 'Agent created',
      content: {
        'application/json': {
          schema: z.object({
            data: AgentSchema,
            credentials: AgentCredentialsSchema,
            authKey: AgentAuthKeySchema.optional(),
          }),
        },
      },
    },
    400: { description: 'Validation error', content: { 'application/json': { schema: ErrorSchema } } },
    404: { description: 'Parent account not found', content: { 'application/json': { schema: ErrorSchema } } },
  },
});
app.openapi(createAgentRoute, async (c): Promise<any> => c.json(notMigrated(), 400));

// ============================================================================
// GET /agents
// ============================================================================

const listAgentsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Agents'],
  summary: 'List agents',
  'x-visibility': 'public',
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      parent_account_id: z.string().uuid().optional(),
      status: AgentStatusEnum.optional(),
      kya_tier: z.coerce.number().int().min(0).max(3).optional(),
      connected: z.enum(['true', 'false']).optional().describe('Filter to agents currently holding an SSE session'),
      search: z.string().optional(),
      page: z.coerce.number().int().positive().default(1),
      limit: z.coerce.number().int().positive().max(200).default(50),
    }),
  },
  responses: {
    200: {
      description: 'Paginated agents',
      content: {
        'application/json': {
          schema: z.object({ data: z.array(AgentSchema), pagination: PaginationSchema }),
        },
      },
    },
  },
});
app.openapi(listAgentsRoute, async (c): Promise<any> =>
  c.json({ data: [], pagination: { page: 1, limit: 50, total: 0, totalPages: 0 } }, 200),
);

// ============================================================================
// GET /agents/{id}
// ============================================================================

const getAgentRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Agents'],
  summary: 'Get an agent',
  'x-visibility': 'public',
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: {
      description: 'Agent detail',
      content: { 'application/json': { schema: z.object({ data: AgentSchema }) } },
    },
    404: { description: 'Not found', content: { 'application/json': { schema: ErrorSchema } } },
  },
});
app.openapi(getAgentRoute, async (c): Promise<any> => c.json(notMigrated(), 404));

// ============================================================================
// PATCH /agents/{id}
// ============================================================================

const patchAgentRoute = createRoute({
  method: 'patch',
  path: '/{id}',
  tags: ['Agents'],
  summary: 'Update an agent',
  'x-visibility': 'public',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: { content: { 'application/json': { schema: UpdateAgentSchema } }, required: true },
  },
  responses: {
    200: {
      description: 'Updated agent',
      content: { 'application/json': { schema: z.object({ data: AgentSchema }) } },
    },
    400: { description: 'Validation error', content: { 'application/json': { schema: ErrorSchema } } },
    404: { description: 'Not found', content: { 'application/json': { schema: ErrorSchema } } },
  },
});
app.openapi(patchAgentRoute, async (c): Promise<any> => c.json(notMigrated(), 400));

// ============================================================================
// DELETE /agents/{id}
// ============================================================================

const deleteAgentRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Agents'],
  summary: 'Delete (revoke) an agent',
  description:
    "Permanent revocation. All credentials (agent_*, sess_*, Ed25519 keys) are invalidated. Agent wallets are detached but not deleted — funds remain claimable.",
  'x-visibility': 'public',
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: {
      description: 'Revoked',
      content: { 'application/json': { schema: z.object({ message: z.string() }) } },
    },
    404: { description: 'Not found', content: { 'application/json': { schema: ErrorSchema } } },
  },
});
app.openapi(deleteAgentRoute, async (c): Promise<any> => c.json(notMigrated(), 404));

// ============================================================================
// GET /agents/{id}/limits
// ============================================================================

const getLimitsRoute = createRoute({
  method: 'get',
  path: '/{id}/limits',
  tags: ['Agents'],
  summary: "Get effective spending limits",
  description:
    "Returns agent's KYA tier caps, the parent account's KYC tier caps, and the effective (minimum-of-both) limits. Plus spend-to-date against each.",
  'x-visibility': 'public',
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: {
      description: 'Limits + usage',
      content: { 'application/json': { schema: AgentLimitsSchema } },
    },
    404: { description: 'Not found', content: { 'application/json': { schema: ErrorSchema } } },
  },
});
app.openapi(getLimitsRoute, async (c): Promise<any> => c.json(notMigrated(), 404));

// ============================================================================
// POST /agents/{id}/suspend
// ============================================================================

const suspendRoute = createRoute({
  method: 'post',
  path: '/{id}/suspend',
  tags: ['Agents'],
  summary: 'Suspend (freeze) an agent',
  description:
    "Agent can still authenticate and read data; spending is blocked. Non-destructive — unfreeze via /activate. For full revocation use DELETE /agents/:id or DELETE /agents/:id/auth-keys.",
  'x-visibility': 'public',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({ reason: z.string().max(500).optional() }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Suspended',
      content: { 'application/json': { schema: z.object({ data: AgentSchema }) } },
    },
    404: { description: 'Not found', content: { 'application/json': { schema: ErrorSchema } } },
  },
});
app.openapi(suspendRoute, async (c): Promise<any> => c.json(notMigrated(), 404));

// ============================================================================
// POST /agents/{id}/activate
// ============================================================================

const activateRoute = createRoute({
  method: 'post',
  path: '/{id}/activate',
  tags: ['Agents'],
  summary: 'Reactivate a suspended agent',
  'x-visibility': 'public',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({ acknowledgment: z.string().max(500).optional() }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Reactivated',
      content: { 'application/json': { schema: z.object({ data: AgentSchema }) } },
    },
    404: { description: 'Not found', content: { 'application/json': { schema: ErrorSchema } } },
  },
});
app.openapi(activateRoute, async (c): Promise<any> => c.json(notMigrated(), 404));

export default app;
