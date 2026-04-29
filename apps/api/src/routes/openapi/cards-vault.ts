/**
 * Cards vault — tokenized card storage per account.
 * Mount: /v1/cards/vault
 * COVERED: 8 most-used endpoints.
 */

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { authMiddleware } from '../../middleware/auth.js';

const app = new OpenAPIHono();
app.use('*', authMiddleware);

const VaultedCardSchema = z.object({
  id: z.string(),
  account_id: z.string().uuid(),
  processor: z.enum(['stripe', 'adyen']),
  processor_token: z.string().describe('Tokenized reference at the processor — never PAN'),
  card_last_four: z.string(),
  card_brand: z.string(),
  expiry_month: z.number().int().min(1).max(12),
  expiry_year: z.number().int(),
  label: z.string().nullable().optional(),
  billing_address: z.object({
    line1: z.string(),
    city: z.string(),
    postal_code: z.string(),
    country: z.string(),
  }).nullable().optional(),
  visa_token_id: z.string().nullable().optional(),
  mastercard_token_id: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).default({}),
  created_at: z.string().datetime(),
}).openapi('VaultedCard');

const CardLimitsSchema = z.object({
  per_tx_cap: z.string(),
  daily_cap: z.string(),
  monthly_cap: z.string(),
  currency: z.string(),
  allowed_merchant_categories: z.array(z.string()).optional(),
  blocked_merchant_categories: z.array(z.string()).optional(),
}).openapi('CardLimits');

const ErrorSchema = z.object({
  error: z.string(), code: z.string().optional(), details: z.unknown().optional(),
}).openapi('Error');
const notMigrated = () => ({ error: 'Not yet migrated', code: 'NOT_MIGRATED' });

app.openapi(createRoute({
  method: 'post', path: '/', tags: ['Cards Vault'], summary: 'Vault a card',
  description: 'Store a card by reference to a processor token. Sly never sees PAN or CVV.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { body: { content: { 'application/json': { schema: z.object({
    accountId: z.string().uuid(),
    processor: z.enum(['stripe', 'adyen']),
    processorToken: z.string(),
    cardLastFour: z.string().length(4),
    cardBrand: z.string(),
    expiryMonth: z.number().int().min(1).max(12),
    expiryYear: z.number().int(),
    label: z.string().max(255).optional(),
    billingAddress: z.object({
      line1: z.string(), city: z.string(), postal_code: z.string(), country: z.string(),
      line2: z.string().optional(), state: z.string().optional(),
    }).optional(),
    metadata: z.record(z.unknown()).optional(),
  }) } }, required: true } },
  responses: {
    201: { description: 'Vaulted', content: { 'application/json': { schema: z.object({ data: VaultedCardSchema }) } } },
    400: { description: 'Validation error', content: { 'application/json': { schema: ErrorSchema } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 400));

app.openapi(createRoute({
  method: 'get', path: '/', tags: ['Cards Vault'], summary: 'List vaulted cards',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { query: z.object({ account_id: z.string().uuid().optional() }) },
  responses: {
    200: { description: 'Cards', content: { 'application/json': { schema: z.object({ data: z.array(VaultedCardSchema) }) } } },
  },
}), async (c): Promise<any> => c.json({ data: [] }, 200));

app.openapi(createRoute({
  method: 'get', path: '/{id}', tags: ['Cards Vault'], summary: 'Get a vaulted card',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: 'Card', content: { 'application/json': { schema: z.object({ data: VaultedCardSchema }) } } },
    404: { description: 'Not found', content: { 'application/json': { schema: ErrorSchema } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 404));

app.openapi(createRoute({
  method: 'patch', path: '/{id}', tags: ['Cards Vault'], summary: 'Update vaulted card metadata',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { 'application/json': { schema: z.object({
      label: z.string().max(255).optional(),
      metadata: z.record(z.unknown()).optional(),
    }) } }, required: true },
  },
  responses: {
    200: { description: 'Updated', content: { 'application/json': { schema: z.object({ data: VaultedCardSchema }) } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 404));

app.openapi(createRoute({
  method: 'delete', path: '/{id}', tags: ['Cards Vault'], summary: 'Remove a vaulted card',
  description: 'Revokes the token at your processor. Pending authorizations on the card continue; new ones rejected.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: 'Removed', content: { 'application/json': { schema: z.object({ message: z.string() }) } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 404));

app.openapi(createRoute({
  method: 'post', path: '/{id}/tokenize/visa', tags: ['Cards Vault'], summary: 'Get a Visa network token',
  description: 'Tokenize the vaulted card with Visa for use in Intelligent Commerce flows.',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: 'Visa token', content: { 'application/json': { schema: z.object({
      visa_token_id: z.string(), tokenized_at: z.string().datetime(),
    }) } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 400));

app.openapi(createRoute({
  method: 'post', path: '/{id}/tokenize/mastercard', tags: ['Cards Vault'], summary: 'Get a Mastercard network token',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: 'Mastercard token', content: { 'application/json': { schema: z.object({
      mastercard_token_id: z.string(), tokenized_at: z.string().datetime(),
    }) } } },
  },
}), async (c): Promise<any> => c.json(notMigrated(), 400));

app.openapi(createRoute({
  method: 'get', path: '/{id}/tokens', tags: ['Cards Vault'], summary: 'List network tokens for card',
  'x-visibility': 'public', security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: 'Tokens', content: { 'application/json': { schema: z.object({
      visa: z.object({ token_id: z.string(), at: z.string().datetime() }).nullable(),
      mastercard: z.object({ token_id: z.string(), at: z.string().datetime() }).nullable(),
    }) } } },
  },
}), async (c): Promise<any> => c.json({ visa: null, mastercard: null }, 200));

export default app;
