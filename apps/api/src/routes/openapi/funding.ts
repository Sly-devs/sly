/**
 * Funding (on-ramp / off-ramp) — OpenAPIHono spec scaffold.
 * Mount: /v1/funding
 * COVERED: 18 endpoints — sources CRUD, transactions, hosted on-ramp/
 * off-ramp sessions across Coinbase / Stripe / Crossmint, fee + FX
 * estimation, providers + conversion rates discovery.
 */

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { authMiddleware } from '../../middleware/auth.js';

const app = new OpenAPIHono();
app.use('*', authMiddleware);

const SourceTypeEnum = z.enum(['card', 'bank_account_us', 'bank_account_eu', 'bank_account_latam', 'crypto_wallet']);
const ProviderEnum = z.enum(['stripe', 'plaid', 'belvo', 'moonpay', 'transak', 'circle', 'coinbase', 'crossmint', 'adyen']);
const SourceStatusEnum = z.enum(['unverified', 'pending_verification', 'verified', 'blocked']);
const TxStatusEnum = z.enum(['pending', 'processing', 'completed', 'failed']);

const FundingSourceSchema = z.object({
  id: z.string(),
  account_id: z.string().uuid(),
  type: SourceTypeEnum,
  provider: ProviderEnum,
  status: SourceStatusEnum,
  last_four: z.string().nullable().optional(),
  bank_name: z.string().nullable().optional(),
  network: z.string().nullable().optional().describe('For crypto_wallet — base, polygon, solana, etc.'),
  wallet_address: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).default({}),
  created_at: z.string().datetime(),
}).openapi('FundingSource');

const FundingTransactionSchema = z.object({
  id: z.string(),
  source_id: z.string(),
  wallet_id: z.string().uuid().nullable().optional(),
  amount_cents: z.number().int(),
  currency: z.string(),
  destination_currency: z.string().nullable().optional(),
  status: TxStatusEnum,
  fees: z.object({ provider: z.number().int(), sly: z.number().int(), total: z.number().int() }),
  estimated_settlement: z.string().datetime().nullable().optional(),
  failure_reason: z.string().nullable().optional(),
  created_at: z.string().datetime(),
  completed_at: z.string().datetime().nullable().optional(),
}).openapi('FundingTransaction');

const CreateSourceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('card'),
    account_id: z.string().uuid(),
    provider: z.enum(['stripe', 'adyen']),
    setup_token: z.string().describe('Tokenized card from your processor'),
  }),
  z.object({
    type: z.enum(['bank_account_us', 'bank_account_eu']),
    account_id: z.string().uuid(),
    provider: z.enum(['plaid', 'stripe']),
    public_token: z.string().optional(),
    link_id: z.string().optional(),
  }),
  z.object({
    type: z.literal('bank_account_latam'),
    account_id: z.string().uuid(),
    provider: z.literal('belvo'),
    link_id: z.string(),
  }),
  z.object({
    type: z.literal('crypto_wallet'),
    account_id: z.string().uuid(),
    provider: z.enum(['circle', 'coinbase']),
    wallet_address: z.string(),
    network: z.string(),
  }),
]).openapi('CreateFundingSourceInput');

const InitiateFundingSchema = z.object({
  source_id: z.string(),
  wallet_id: z.string().uuid().optional(),
  amount_cents: z.number().int().positive().max(100_000_000),
  currency: z.string().min(3).max(4),
  destination_currency: z.string().optional(),
  conversion_quote_id: z.string().optional(),
  idempotency_key: z.string().optional(),
}).openapi('InitiateFundingInput');

const FeeEstimateSchema = z.object({
  provider_fee: z.number().int(),
  sly_fee: z.number().int(),
  fx_spread_cents: z.number().int(),
  total_fee: z.number().int(),
  net_amount_cents: z.number().int(),
}).openapi('FeeEstimate');

const ConversionQuoteSchema = z.object({
  id: z.string(),
  from_currency: z.string(),
  to_currency: z.string(),
  rate: z.string(),
  amount_cents: z.number().int(),
  destination_amount_cents: z.number().int(),
  fee_cents: z.number().int(),
  expires_at: z.string().datetime(),
}).openapi('ConversionQuote');

const HostedSessionSchema = z.object({
  session_url: z.string().url(),
  session_token: z.string().optional(),
  expires_at: z.string().datetime(),
}).openapi('HostedFundingSession');

const ErrorSchema = z.object({
  error: z.string(), code: z.string().optional(), details: z.unknown().optional(),
}).openapi('Error');
const Pagination = z.object({ page: z.number(), limit: z.number(), total: z.number(), totalPages: z.number() });
const notMigrated = () => ({ error: 'Not yet migrated — use plain-Hono funding router', code: 'NOT_MIGRATED' });

// ============================================================================
// Sources
// ============================================================================

app.openapi(createRoute({
  method: 'post', path: '/sources', tags: ['Funding'],
  summary: 'Register a funding source',
  description: 'Card, bank, or crypto wallet that funds Sly accounts. Bank/card sources require verification before they can fund.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { body: { content: { 'application/json': { schema: CreateSourceSchema } }, required: true } },
  responses: {
    201: { description: 'Source registered', content: { 'application/json': { schema: z.object({ data: FundingSourceSchema }) } } },
    400: { description: 'Validation error', content: { 'application/json': { schema: ErrorSchema } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 400));

app.openapi(createRoute({
  method: 'get', path: '/sources', tags: ['Funding'], summary: 'List funding sources',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { query: z.object({
    account_id: z.string().uuid().optional(),
    type: SourceTypeEnum.optional(),
    provider: ProviderEnum.optional(),
    status: SourceStatusEnum.optional(),
  }) },
  responses: {
    200: { description: 'Sources', content: { 'application/json': { schema: z.object({ data: z.array(FundingSourceSchema) }) } } },
  },
}), async (c): Promise<any> => c.json({ data: [] }, 200));

app.openapi(createRoute({
  method: 'get', path: '/sources/{id}', tags: ['Funding'], summary: 'Get a funding source',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: 'Source', content: { 'application/json': { schema: z.object({ data: FundingSourceSchema }) } } },
    404: { description: 'Not found', content: { 'application/json': { schema: ErrorSchema } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 404));

app.openapi(createRoute({
  method: 'post', path: '/sources/{id}/verify', tags: ['Funding'],
  summary: 'Trigger verification',
  description: 'For bank accounts, sends micro-deposits or initiates Plaid identity check. For cards, performs $0 auth. Status updates async via webhook.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: 'Verification started', content: { 'application/json': { schema: z.object({ data: FundingSourceSchema }) } } },
    409: { description: 'Already verified or in invalid state', content: { 'application/json': { schema: ErrorSchema } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 404));

app.openapi(createRoute({
  method: 'delete', path: '/sources/{id}', tags: ['Funding'], summary: 'Remove a funding source',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: 'Removed', content: { 'application/json': { schema: z.object({ message: z.string() }) } } },
    409: { description: 'In-flight transactions still reference this source', content: { 'application/json': { schema: ErrorSchema } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 404));

// ============================================================================
// Embedded widget sessions (Plaid / Belvo Link client SDKs)
// ============================================================================

app.openapi(createRoute({
  method: 'post', path: '/widget-sessions', tags: ['Funding'],
  summary: 'Create an embedded widget session',
  description: 'Returns a short-lived session token to pass to the Plaid Link or Belvo widget client-side. The user completes the link flow in the browser; the resulting public_token is then used with POST /sources.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { body: { content: { 'application/json': { schema: z.object({
    provider: z.enum(['plaid', 'belvo']),
    account_id: z.string().uuid(),
    products: z.array(z.string()).optional().describe('Plaid: ["auth","transactions"]; Belvo: equivalent product list'),
  }) } }, required: true } },
  responses: {
    201: { description: 'Session created', content: { 'application/json': { schema: z.object({
      data: z.object({ link_token: z.string(), expires_at: z.string().datetime() }),
    }) } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 400));

// ============================================================================
// Transactions
// ============================================================================

app.openapi(createRoute({
  method: 'post', path: '/transactions', tags: ['Funding'],
  summary: 'Initiate a funding transaction',
  description:
    'Pulls funds from a verified source into a Sly wallet. Always include `idempotency_key` — duplicate funding is the most expensive bug class.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { body: { content: { 'application/json': { schema: InitiateFundingSchema } }, required: true } },
  responses: {
    201: { description: 'Initiated', content: { 'application/json': { schema: z.object({ data: FundingTransactionSchema }) } } },
    400: { description: 'Validation error', content: { 'application/json': { schema: ErrorSchema } } },
    402: { description: 'Source declined or insufficient', content: { 'application/json': { schema: ErrorSchema } } },
    409: { description: 'Source unverified or idempotency-key collision', content: { 'application/json': { schema: ErrorSchema } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 400));

app.openapi(createRoute({
  method: 'get', path: '/transactions/{id}', tags: ['Funding'], summary: 'Get transaction status',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: 'Transaction', content: { 'application/json': { schema: z.object({ data: FundingTransactionSchema }) } } },
    404: { description: 'Not found', content: { 'application/json': { schema: ErrorSchema } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 404));

app.openapi(createRoute({
  method: 'get', path: '/transactions', tags: ['Funding'], summary: 'List funding transactions',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { query: z.object({
    source_id: z.string().optional(),
    account_id: z.string().uuid().optional(),
    status: TxStatusEnum.optional(),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(200).default(50),
  }) },
  responses: {
    200: { description: 'Paginated transactions', content: { 'application/json': { schema: z.object({ data: z.array(FundingTransactionSchema), pagination: Pagination }) } } },
  },
}), async (c): Promise<any> => c.json({ data: [], pagination: { page: 1, limit: 50, total: 0, totalPages: 0 } }, 200));

// ============================================================================
// Estimation + discovery
// ============================================================================

app.openapi(createRoute({
  method: 'post', path: '/estimate-fees', tags: ['Funding'],
  summary: 'Estimate fees for a funding request',
  description: 'Preview provider + Sly fees + FX spread before committing. Use to display costs to the end user.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { body: { content: { 'application/json': { schema: z.object({
    source_type: SourceTypeEnum,
    amount_cents: z.number().int().positive(),
    currency: z.string(),
    destination_currency: z.string().optional(),
  }) } }, required: true } },
  responses: {
    200: { description: 'Estimate', content: { 'application/json': { schema: z.object({ data: FeeEstimateSchema }) } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 400));

app.openapi(createRoute({
  method: 'post', path: '/conversion-quote', tags: ['Funding'],
  summary: 'Lock an FX conversion quote',
  description: 'Lock a rate for a from→to currency pair. Use the returned `id` on POST /transactions to use the quoted rate.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { body: { content: { 'application/json': { schema: z.object({
    from_currency: z.string(),
    to_currency: z.string(),
    amount_cents: z.number().int().positive(),
  }) } }, required: true } },
  responses: {
    201: { description: 'Quote', content: { 'application/json': { schema: z.object({ data: ConversionQuoteSchema }) } } },
    400: { description: 'Unsupported pair', content: { 'application/json': { schema: ErrorSchema } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 400));

app.openapi(createRoute({
  method: 'get', path: '/providers', tags: ['Funding'], summary: 'List funding providers',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  responses: {
    200: { description: 'Providers', content: { 'application/json': { schema: z.object({
      data: z.array(z.object({
        provider: ProviderEnum,
        types: z.array(SourceTypeEnum),
        regions: z.array(z.string()),
        active: z.boolean(),
      })),
    }) } } },
  },
}), async (c): Promise<any> => c.json({ data: [] }, 200));

app.openapi(createRoute({
  method: 'get', path: '/conversion-rates', tags: ['Funding'], summary: 'List supported conversion pairs',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  responses: {
    200: { description: 'Pairs', content: { 'application/json': { schema: z.object({
      data: z.array(z.object({
        from: z.string(), to: z.string(), min_cents: z.number().int(), max_cents: z.number().int(),
        typical_spread: z.string(),
      })),
    }) } } },
  },
}), async (c): Promise<any> => c.json({ data: [] }, 200));

// ============================================================================
// Hosted sessions
// ============================================================================

app.openapi(createRoute({
  method: 'post', path: '/topup-link', tags: ['Funding'],
  summary: 'Generate a hosted top-up link',
  description: 'Returns a Sly-hosted URL where an end user can fund a wallet without your front-end handling card data. Single-use, expires in 1 hour.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { body: { content: { 'application/json': { schema: z.object({
    wallet_id: z.string().uuid(),
    amount_cents: z.number().int().positive().optional(),
    return_url: z.string().url().optional(),
  }) } }, required: true } },
  responses: {
    201: { description: 'Hosted session', content: { 'application/json': { schema: z.object({ data: HostedSessionSchema }) } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 400));

app.openapi(createRoute({
  method: 'post', path: '/onramp-session', tags: ['Funding'],
  summary: 'Coinbase fiat→USDC on-ramp session',
  description: 'Embedded Coinbase on-ramp. User completes funding in Coinbase\'s flow; wallet credited on confirmation.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { body: { content: { 'application/json': { schema: z.object({
    wallet_id: z.string().uuid(),
    default_amount_usd: z.number().positive().optional(),
    supported_payment_methods: z.array(z.enum(['card', 'ach', 'apple_pay', 'google_pay'])).optional(),
    return_url: z.string().url().optional(),
  }) } }, required: true } },
  responses: {
    201: { description: 'Session', content: { 'application/json': { schema: z.object({ data: HostedSessionSchema }) } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 400));

app.openapi(createRoute({
  method: 'post', path: '/stripe-onramp-session', tags: ['Funding'],
  summary: 'Stripe fiat→crypto on-ramp session',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { body: { content: { 'application/json': { schema: z.object({
    wallet_id: z.string().uuid(),
    default_amount_usd: z.number().positive().optional(),
    return_url: z.string().url().optional(),
  }) } }, required: true } },
  responses: {
    201: { description: 'Session', content: { 'application/json': { schema: z.object({ data: HostedSessionSchema }) } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 400));

app.openapi(createRoute({
  method: 'post', path: '/offramp-session', tags: ['Funding'],
  summary: 'USDC→fiat off-ramp session',
  description: 'Move funds out of a Sly wallet to a registered bank account via the Coinbase off-ramp.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { body: { content: { 'application/json': { schema: z.object({
    wallet_id: z.string().uuid(),
    amount_usd: z.number().positive(),
    destination_bank_account_id: z.string(),
  }) } }, required: true } },
  responses: {
    201: { description: 'Session', content: { 'application/json': { schema: z.object({ data: HostedSessionSchema }) } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 400));

app.openapi(createRoute({
  method: 'post', path: '/crossmint-order', tags: ['Funding'],
  summary: 'Crossmint card→USDC order',
  description: 'Crossmint hosted card-to-USDC flow. Mobile- and web-friendly.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { body: { content: { 'application/json': { schema: z.object({
    wallet_id: z.string().uuid(),
    amount_usd: z.number().positive(),
    return_url: z.string().url().optional(),
  }) } }, required: true } },
  responses: {
    201: { description: 'Order', content: { 'application/json': { schema: z.object({ data: HostedSessionSchema }) } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 400));

export default app;
