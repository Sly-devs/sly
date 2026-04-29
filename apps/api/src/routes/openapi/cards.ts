/**
 * Cards (network) — Visa Intelligent Commerce + Mastercard Agent Pay.
 * Mount: /v1/cards
 * COVERED: 11 most-used endpoints (sub-network details deferred).
 *
 * For card-level vault operations (per-account stored cards), see
 * openapi/cards-vault.ts mounted at /v1/cards/vault.
 */

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { authMiddleware } from '../../middleware/auth.js';

const app = new OpenAPIHono();
app.use('*', authMiddleware);

const NetworkEnum = z.enum(['visa', 'mastercard']);

const VerifyRequestSchema = z.object({
  network: NetworkEnum,
  agent_id: z.string().uuid(),
  transaction_intent: z.object({
    merchant_id: z.string(),
    amount: z.string(),
    currency: z.string(),
    description: z.string().optional(),
  }),
  signed_bot_identity: z.string().describe('JWS — signed by the agent\'s Ed25519 key'),
}).openapi('CardVerifyRequest');

const VerifyResponseSchema = z.object({
  verified: z.boolean(),
  network_ref: z.string().nullable().optional().describe('Authorization token to use on the card transaction'),
  network: NetworkEnum,
  expires_at: z.string().datetime().nullable().optional(),
  rejection_reason: z.string().nullable().optional(),
}).openapi('CardVerifyResponse');

const NetworkStatusSchema = z.object({
  network: NetworkEnum,
  active: z.boolean(),
  enrollment_status: z.enum(['enrolled', 'pending', 'inactive', 'not_configured']),
  features: z.array(z.string()),
}).openapi('CardNetworkStatus');

const VisaInstructionSchema = z.object({
  id: z.string(),
  agent_id: z.string().uuid(),
  type: z.enum(['authorize', 'cancel', 'refund']),
  status: z.enum(['pending', 'sent', 'acknowledged', 'failed']),
  payload: z.record(z.unknown()),
  created_at: z.string().datetime(),
}).openapi('VisaInstruction');

const MastercardAgentSchema = z.object({
  id: z.string(),
  agent_id: z.string().uuid(),
  agent_pay_id: z.string().describe('Mastercard-issued Agent Pay identifier'),
  status: z.enum(['active', 'suspended', 'revoked']),
  enrolled_at: z.string().datetime(),
}).openapi('MastercardAgent');

const ErrorSchema = z.object({
  error: z.string(), code: z.string().optional(), details: z.unknown().optional(),
}).openapi('Error');
const notMigrated = () => ({ error: 'Not yet migrated', code: 'NOT_MIGRATED' });

app.openapi(createRoute({
  method: 'post', path: '/verify', tags: ['Cards'], summary: 'Verify Web Bot Auth signature',
  description:
    "Verify an agent's Web Bot Auth on a card transaction. Sly checks the signature against the agent's Ed25519 public key, validates the transaction intent, and returns a network_ref usable as authorization for the card txn.",
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { body: { content: { 'application/json': { schema: VerifyRequestSchema } }, required: true } },
  responses: {
    200: { description: 'Verification result', content: { 'application/json': { schema: z.object({ data: VerifyResponseSchema }) } } },
    400: { description: 'Validation error or signature mismatch', content: { 'application/json': { schema: ErrorSchema } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 400));

app.openapi(createRoute({
  method: 'get', path: '/networks', tags: ['Cards'], summary: 'List configured card networks',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  responses: {
    200: { description: 'Networks', content: { 'application/json': { schema: z.object({ data: z.array(NetworkStatusSchema) }) } } },
  },
}), async (c): Promise<any> => c.json({ data: [] }, 200));

app.openapi(createRoute({
  method: 'post', path: '/networks/{network}/test', tags: ['Cards'], summary: 'Test a card network connection',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { params: z.object({ network: NetworkEnum }) },
  responses: {
    200: { description: 'Test result', content: { 'application/json': { schema: z.object({
      success: z.boolean(), latency_ms: z.number().int(), error: z.string().optional(),
    }) } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 400));

app.openapi(createRoute({
  method: 'post', path: '/networks/{network}/configure', tags: ['Cards'], summary: 'Configure a card network',
  description: 'Provision tenant credentials for VIC or Agent Pay enrollment.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ network: NetworkEnum }),
    body: { content: { 'application/json': { schema: z.object({
      api_key: z.string().optional(),
      api_secret: z.string().optional(),
      merchant_id: z.string().optional(),
      additional_config: z.record(z.unknown()).optional(),
    }) } }, required: true },
  },
  responses: {
    200: { description: 'Configured', content: { 'application/json': { schema: z.object({ data: NetworkStatusSchema }) } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 400));

app.openapi(createRoute({
  method: 'delete', path: '/networks/{network}/disconnect', tags: ['Cards'], summary: 'Disconnect a card network',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { params: z.object({ network: NetworkEnum }) },
  responses: {
    200: { description: 'Disconnected', content: { 'application/json': { schema: z.object({ message: z.string() }) } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 404));

// ============================================================================
// Visa-specific
// ============================================================================

app.openapi(createRoute({
  method: 'post', path: '/visa/instructions', tags: ['Cards'], summary: 'Send a Visa instruction',
  description: 'Submit an authorization, cancellation, or refund instruction to Visa Intelligent Commerce on behalf of an agent.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { body: { content: { 'application/json': { schema: VisaInstructionSchema.omit({ id: true, status: true, created_at: true }) } }, required: true } },
  responses: {
    202: { description: 'Instruction queued', content: { 'application/json': { schema: z.object({ data: VisaInstructionSchema }) } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 400));

app.openapi(createRoute({
  method: 'get', path: '/visa/instructions', tags: ['Cards'], summary: 'List Visa instructions',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { query: z.object({
    agent_id: z.string().uuid().optional(),
    status: z.enum(['pending', 'sent', 'acknowledged', 'failed']).optional(),
  }) },
  responses: {
    200: { description: 'Instructions', content: { 'application/json': { schema: z.object({ data: z.array(VisaInstructionSchema) }) } } },
  },
}), async (c): Promise<any> => c.json({ data: [] }, 200));

app.openapi(createRoute({
  method: 'get', path: '/visa/instructions/{id}', tags: ['Cards'], summary: 'Get a Visa instruction',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: 'Instruction', content: { 'application/json': { schema: z.object({ data: VisaInstructionSchema }) } } },
    404: { description: 'Not found', content: { 'application/json': { schema: ErrorSchema } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 404));

// ============================================================================
// Mastercard-specific
// ============================================================================

app.openapi(createRoute({
  method: 'post', path: '/mastercard/agents', tags: ['Cards'], summary: 'Enroll agent in Mastercard Agent Pay',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { body: { content: { 'application/json': { schema: z.object({
    agent_id: z.string().uuid(),
  }) } }, required: true } },
  responses: {
    201: { description: 'Enrolled', content: { 'application/json': { schema: z.object({ data: MastercardAgentSchema }) } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 400));

app.openapi(createRoute({
  method: 'get', path: '/mastercard/agents', tags: ['Cards'], summary: 'List Mastercard-enrolled agents',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  responses: {
    200: { description: 'Agents', content: { 'application/json': { schema: z.object({ data: z.array(MastercardAgentSchema) }) } } },
  },
}), async (c): Promise<any> => c.json({ data: [] }, 200));

export default app;
