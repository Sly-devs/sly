/**
 * Wallets routes — OpenAPIHono spec scaffold.
 *
 * COVERED IN SPEC
 *   ✓ POST  /v1/wallets              — create wallet
 *   ✓ POST  /v1/wallets/external     — register external wallet
 *   ✓ GET   /v1/wallets              — list
 *   ✓ GET   /v1/wallets/{id}         — get
 *   ✓ GET   /v1/wallets/{id}/balance — balance snapshot
 *   ✓ PATCH /v1/wallets/{id}         — update
 *   ✓ POST  /v1/wallets/{id}/deposit  — deposit (internal transfer in)
 *   ✓ POST  /v1/wallets/{id}/withdraw — withdraw (internal transfer out)
 *   ✓ DELETE /v1/wallets/{id}        — delete
 *   ⬜ /verify — TODO
 */

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { authMiddleware } from '../../middleware/auth.js';

const app = new OpenAPIHono();
app.use('*', authMiddleware);

// ============================================================================
// Schemas
// ============================================================================

const WalletOwnerTypeEnum = z.enum(['account', 'agent']);
const WalletStatusEnum = z.enum(['active', 'frozen', 'deactivated']);

const WalletSchema = z
  .object({
    id: z.string().uuid(),
    owner_type: WalletOwnerTypeEnum,
    owner_id: z.string().uuid(),
    currency: z.string(),
    balance_available: z.string(),
    balance_pending: z.string(),
    network: z.string().nullable().optional(),
    address: z.string().nullable().optional().describe('On-chain address (stablecoin wallets only)'),
    status: WalletStatusEnum,
    name: z.string().nullable().optional(),
    metadata: z.record(z.unknown()).default({}),
    frozen_at: z.string().datetime().nullable().optional(),
    frozen_reason: z.string().nullable().optional(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .openapi('Wallet');

const CreateWalletSchema = z
  .object({
    owner_type: WalletOwnerTypeEnum,
    owner_id: z.string().uuid(),
    currency: z.string().default('USDC'),
    network: z.string().optional().describe('Auto-selected based on currency + tenant config if omitted'),
    name: z.string().max(255).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .openapi('CreateWalletInput');

const CreateExternalWalletSchema = z
  .object({
    owner_type: WalletOwnerTypeEnum,
    owner_id: z.string().uuid(),
    currency: z.string(),
    network: z.string(),
    address: z.string().describe('The customer-owned on-chain address'),
    name: z.string().max(255).optional(),
  })
  .openapi('CreateExternalWalletInput');

const UpdateWalletSchema = z
  .object({
    name: z.string().max(255).nullable().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .openapi('UpdateWalletInput');

const DepositSchema = z
  .object({
    source_wallet_id: z.string().uuid(),
    amount: z.string(),
    currency: z.string().optional(),
    idempotency_key: z.string().optional(),
  })
  .openapi('WalletDepositInput');

const WithdrawSchema = z
  .object({
    destination_wallet_id: z.string().uuid().optional(),
    destination_address: z.string().optional(),
    amount: z.string(),
    currency: z.string().optional(),
    idempotency_key: z.string().optional(),
  })
  .openapi('WalletWithdrawInput');

const BalanceSchema = z
  .object({
    wallet_id: z.string().uuid(),
    currency: z.string(),
    available: z.string(),
    pending: z.string(),
    total: z.string(),
    held: z.string(),
    as_of: z.string().datetime(),
  })
  .openapi('WalletBalance');

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
  error: 'Not yet migrated — use the plain-Hono wallets router',
  code: 'NOT_MIGRATED',
});

// ============================================================================
// POST /wallets
// ============================================================================

app.openapi(
  createRoute({
    method: 'post',
    path: '/',
    tags: ['Wallets'],
    summary: 'Create a wallet',
    description:
      "Create a wallet under an account or agent. Network auto-selects based on currency + tenant config if not specified. Stablecoin wallets get an on-chain address; fiat-ledger wallets don't.",
    'x-visibility': 'public',
    security: [{ bearerAuth: [] }],
    request: {
      body: { content: { 'application/json': { schema: CreateWalletSchema } }, required: true },
    },
    responses: {
      201: {
        description: 'Wallet created',
        content: { 'application/json': { schema: z.object({ data: WalletSchema }) } },
      },
      400: { description: 'Validation error', content: { 'application/json': { schema: ErrorSchema } } },
      404: { description: 'Owner (account or agent) not found', content: { 'application/json': { schema: ErrorSchema } } },
    },
  }),
  async (c): Promise<any> => c.json(notMigrated(), 400),
);

// ============================================================================
// POST /wallets/external
// ============================================================================

app.openapi(
  createRoute({
    method: 'post',
    path: '/external',
    tags: ['Wallets'],
    summary: 'Register an external (customer-owned) wallet',
    description:
      'Register an on-chain address the customer already controls — Sly tracks it but does not custody funds. Useful for payouts to user-controlled wallets.',
    'x-visibility': 'public',
    security: [{ bearerAuth: [] }],
    request: {
      body: { content: { 'application/json': { schema: CreateExternalWalletSchema } }, required: true },
    },
    responses: {
      201: {
        description: 'External wallet registered',
        content: { 'application/json': { schema: z.object({ data: WalletSchema }) } },
      },
      400: { description: 'Validation error', content: { 'application/json': { schema: ErrorSchema } } },
    },
  }),
  async (c): Promise<any> => c.json(notMigrated(), 400),
);

// ============================================================================
// GET /wallets
// ============================================================================

app.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['Wallets'],
    summary: 'List wallets',
    'x-visibility': 'public',
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        owner_type: WalletOwnerTypeEnum.optional(),
        owner_id: z.string().uuid().optional(),
        currency: z.string().optional(),
        status: WalletStatusEnum.optional(),
        page: z.coerce.number().int().positive().default(1),
        limit: z.coerce.number().int().positive().max(200).default(50),
      }),
    },
    responses: {
      200: {
        description: 'Paginated wallets',
        content: {
          'application/json': {
            schema: z.object({ data: z.array(WalletSchema), pagination: PaginationSchema }),
          },
        },
      },
    },
  }),
  async (c): Promise<any> =>
    c.json({ data: [], pagination: { page: 1, limit: 50, total: 0, totalPages: 0 } }, 200),
);

// ============================================================================
// GET /wallets/{id}
// ============================================================================

app.openapi(
  createRoute({
    method: 'get',
    path: '/{id}',
    tags: ['Wallets'],
    summary: 'Get a wallet',
    'x-visibility': 'public',
    security: [{ bearerAuth: [] }],
    request: { params: z.object({ id: z.string().uuid() }) },
    responses: {
      200: {
        description: 'Wallet detail',
        content: { 'application/json': { schema: z.object({ data: WalletSchema }) } },
      },
      404: { description: 'Not found', content: { 'application/json': { schema: ErrorSchema } } },
    },
  }),
  async (c): Promise<any> => c.json(notMigrated(), 404),
);

// ============================================================================
// GET /wallets/{id}/balance
// ============================================================================

app.openapi(
  createRoute({
    method: 'get',
    path: '/{id}/balance',
    tags: ['Wallets'],
    summary: 'Get wallet balance',
    description: 'Point-in-time balance snapshot. `available` = spendable now; `pending` = held by in-flight transfers.',
    'x-visibility': 'public',
    security: [{ bearerAuth: [] }],
    request: { params: z.object({ id: z.string().uuid() }) },
    responses: {
      200: {
        description: 'Balance',
        content: { 'application/json': { schema: z.object({ data: BalanceSchema }) } },
      },
      404: { description: 'Not found', content: { 'application/json': { schema: ErrorSchema } } },
    },
  }),
  async (c): Promise<any> => c.json(notMigrated(), 404),
);

// ============================================================================
// PATCH /wallets/{id}
// ============================================================================

app.openapi(
  createRoute({
    method: 'patch',
    path: '/{id}',
    tags: ['Wallets'],
    summary: 'Update a wallet',
    'x-visibility': 'public',
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ id: z.string().uuid() }),
      body: { content: { 'application/json': { schema: UpdateWalletSchema } }, required: true },
    },
    responses: {
      200: {
        description: 'Updated wallet',
        content: { 'application/json': { schema: z.object({ data: WalletSchema }) } },
      },
      404: { description: 'Not found', content: { 'application/json': { schema: ErrorSchema } } },
    },
  }),
  async (c): Promise<any> => c.json(notMigrated(), 404),
);

// ============================================================================
// POST /wallets/{id}/deposit
// ============================================================================

app.openapi(
  createRoute({
    method: 'post',
    path: '/{id}/deposit',
    tags: ['Wallets'],
    summary: 'Deposit funds into this wallet',
    description: 'Creates an internal transfer from the specified source wallet to this wallet. Both wallets must be same currency.',
    'x-visibility': 'public',
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ id: z.string().uuid() }),
      body: { content: { 'application/json': { schema: DepositSchema } }, required: true },
    },
    responses: {
      200: {
        description: 'Deposited',
        content: { 'application/json': { schema: z.object({ data: WalletSchema, transfer_id: z.string() }) } },
      },
      400: { description: 'Validation error', content: { 'application/json': { schema: ErrorSchema } } },
      402: { description: 'Insufficient balance on source', content: { 'application/json': { schema: ErrorSchema } } },
      404: { description: 'Not found', content: { 'application/json': { schema: ErrorSchema } } },
    },
  }),
  async (c): Promise<any> => c.json(notMigrated(), 400),
);

// ============================================================================
// POST /wallets/{id}/withdraw
// ============================================================================

app.openapi(
  createRoute({
    method: 'post',
    path: '/{id}/withdraw',
    tags: ['Wallets'],
    summary: 'Withdraw funds from this wallet',
    description:
      'Move funds out — to another Sly wallet (internal) or an on-chain address (external). For large amounts may trigger [compliance hold](/settlement/overview#degraded-modes).',
    'x-visibility': 'public',
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ id: z.string().uuid() }),
      body: { content: { 'application/json': { schema: WithdrawSchema } }, required: true },
    },
    responses: {
      200: {
        description: 'Withdrawal initiated',
        content: { 'application/json': { schema: z.object({ data: WalletSchema, transfer_id: z.string() }) } },
      },
      400: { description: 'Validation error', content: { 'application/json': { schema: ErrorSchema } } },
      402: { description: 'Insufficient balance', content: { 'application/json': { schema: ErrorSchema } } },
      403: { description: 'Wallet policy / KYA tier blocked', content: { 'application/json': { schema: ErrorSchema } } },
      404: { description: 'Not found', content: { 'application/json': { schema: ErrorSchema } } },
    },
  }),
  async (c): Promise<any> => c.json(notMigrated(), 400),
);

// ============================================================================
// DELETE /wallets/{id}
// ============================================================================

app.openapi(
  createRoute({
    method: 'delete',
    path: '/{id}',
    tags: ['Wallets'],
    summary: 'Delete a wallet',
    description: "Fails if the wallet has a non-zero balance. Drain first via /withdraw.",
    'x-visibility': 'public',
    security: [{ bearerAuth: [] }],
    request: { params: z.object({ id: z.string().uuid() }) },
    responses: {
      200: {
        description: 'Deleted',
        content: { 'application/json': { schema: z.object({ message: z.string() }) } },
      },
      404: { description: 'Not found', content: { 'application/json': { schema: ErrorSchema } } },
      409: { description: 'Non-zero balance', content: { 'application/json': { schema: ErrorSchema } } },
    },
  }),
  async (c): Promise<any> => c.json(notMigrated(), 404),
);

export default app;
