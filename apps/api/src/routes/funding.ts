/**
 * Funding API Routes
 * Epic 41, Story 41.3: Funding API Endpoints
 *
 * REST API for managing funding sources and transactions.
 * Supports multiple providers: Stripe, Plaid, Belvo, MoonPay, Transak, Circle.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { createClient } from '../db/client.js';
import {
  createFundingOrchestrator,
  createConversionService,
  createFundingFeeService,
} from '../services/funding/index.js';
import {
  createOnrampToken,
  BLOCKCHAIN_TO_COINBASE,
  createStripeOnrampSession,
  BLOCKCHAIN_TO_STRIPE,
} from '../services/funding/stripe-payment-intent.js';
import {
  createCrossmintOrder,
} from '../services/funding/crossmint.js';
import type {
  FundingSourceType,
  FundingProvider,
  FundingSourceStatus,
  FundingTransactionStatus,
} from '../services/funding/types.js';

const app = new Hono();

// ============================================
// Validation Schemas
// ============================================

const createSourceSchema = z.object({
  account_id: z.string().uuid(),
  type: z.enum(['card', 'bank_account_us', 'bank_account_eu', 'bank_account_latam', 'crypto_wallet']),
  provider: z.enum(['stripe', 'plaid', 'belvo', 'moonpay', 'transak', 'circle']),
  setup_token: z.string().optional(),
  public_token: z.string().optional(),
  link_id: z.string().optional(),
  wallet_address: z.string().optional(),
  network: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const verifySourceSchema = z.object({
  amounts: z.array(z.number()).optional(),
  public_token: z.string().optional(),
});

const initiateFundingSchema = z.object({
  source_id: z.string().uuid(),
  amount_cents: z.number().int().positive().max(100_000_000), // Max $1M
  currency: z.string().min(3).max(4),
  wallet_id: z.string().uuid().optional(),
  idempotency_key: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const onrampSessionSchema = z.object({
  wallet_id: z.string().uuid(),
  source_amount: z.string().optional(),
  source_currency: z.string().optional(),
});

const crossmintOrderSchema = z.object({
  wallet_id: z.string().uuid(),
  amount: z.string().default('5.00'),
  receipt_email: z.string().email().optional(),
});

const estimateFeesSchema = z.object({
  source_id: z.string().uuid(),
  amount_cents: z.number().int().positive(),
  currency: z.string().min(3).max(4),
});

const widgetSessionSchema = z.object({
  provider: z.enum(['plaid', 'belvo', 'moonpay', 'transak']),
  source_type: z.enum(['card', 'bank_account_us', 'bank_account_eu', 'bank_account_latam', 'crypto_wallet']),
  account_id: z.string().uuid(),
  amount_cents: z.number().int().positive().optional(),
  currency: z.string().optional(),
  redirect_url: z.string().url().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const conversionQuoteSchema = z.object({
  from_currency: z.string().min(3).max(4),
  to_currency: z.string().min(3).max(4).default('USDC'),
  amount_cents: z.number().int().positive(),
});

// ============================================
// Funding Sources
// ============================================

/**
 * POST /v1/funding/sources - Add funding source
 */
app.post('/sources', async (c) => {
  const ctx = c.get('ctx') as any;
  const body = await c.req.json();
  const parsed = createSourceSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  try {
    const supabase = createClient();
    const orchestrator = createFundingOrchestrator(supabase);
    const source = await orchestrator.createSource(ctx.tenantId, parsed.data);

    return c.json(mapSourceResponse(source), 201);
  } catch (error: any) {
    return c.json({ error: error.message }, error.message.includes('not found') ? 404 : 400);
  }
});

/**
 * GET /v1/funding/sources - List funding sources
 */
app.get('/sources', async (c) => {
  const ctx = c.get('ctx') as any;
  const accountId = c.req.query('account_id');
  const type = c.req.query('type') as FundingSourceType | undefined;
  const provider = c.req.query('provider') as FundingProvider | undefined;
  const status = c.req.query('status') as FundingSourceStatus | undefined;
  const page = parseInt(c.req.query('page') || '1');
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 100);

  try {
    const supabase = createClient();
    const orchestrator = createFundingOrchestrator(supabase);
    const { data, total } = await orchestrator.listSources(ctx.tenantId, {
      account_id: accountId,
      type,
      provider,
      status,
      page,
      limit,
    });

    return c.json({
      data: data.map(mapSourceResponse),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

/**
 * GET /v1/funding/sources/:id - Get funding source
 */
app.get('/sources/:id', async (c) => {
  const ctx = c.get('ctx') as any;
  const id = c.req.param('id');

  try {
    const supabase = createClient();
    const orchestrator = createFundingOrchestrator(supabase);
    const source = await orchestrator.getSource(ctx.tenantId, id);

    return c.json(mapSourceResponse(source));
  } catch (error: any) {
    return c.json({ error: error.message }, 404);
  }
});

/**
 * POST /v1/funding/sources/:id/verify - Trigger verification
 */
app.post('/sources/:id/verify', async (c) => {
  const ctx = c.get('ctx') as any;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const parsed = verifySourceSchema.safeParse(body);

  try {
    const supabase = createClient();
    const orchestrator = createFundingOrchestrator(supabase);
    const source = await orchestrator.verifySource(ctx.tenantId, {
      source_id: id,
      ...(parsed.success ? parsed.data : {}),
    });

    return c.json(mapSourceResponse(source));
  } catch (error: any) {
    return c.json({ error: error.message }, 400);
  }
});

/**
 * DELETE /v1/funding/sources/:id - Remove funding source
 */
app.delete('/sources/:id', async (c) => {
  const ctx = c.get('ctx') as any;
  const id = c.req.param('id');

  try {
    const supabase = createClient();
    const orchestrator = createFundingOrchestrator(supabase);
    await orchestrator.removeSource(ctx.tenantId, id);

    return c.json({ success: true });
  } catch (error: any) {
    return c.json({ error: error.message }, 404);
  }
});

// ============================================
// Widget Sessions
// ============================================

/**
 * POST /v1/funding/widget-sessions - Create a widget session
 */
app.post('/widget-sessions', async (c) => {
  const ctx = c.get('ctx') as any;
  const body = await c.req.json();
  const parsed = widgetSessionSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  try {
    const supabase = createClient();
    const orchestrator = createFundingOrchestrator(supabase);
    const session = await orchestrator.createWidgetSession(
      ctx.tenantId,
      parsed.data.provider as FundingProvider,
      parsed.data.source_type as FundingSourceType,
      {
        account_id: parsed.data.account_id,
        amount_cents: parsed.data.amount_cents,
        currency: parsed.data.currency,
        redirect_url: parsed.data.redirect_url,
        metadata: parsed.data.metadata,
      }
    );

    return c.json(session, 201);
  } catch (error: any) {
    return c.json({ error: error.message }, 400);
  }
});

// ============================================
// Funding Transactions
// ============================================

/**
 * POST /v1/funding/transactions - Initiate funding
 */
app.post('/transactions', async (c) => {
  const ctx = c.get('ctx') as any;
  const body = await c.req.json();
  const parsed = initiateFundingSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  try {
    const supabase = createClient();
    const orchestrator = createFundingOrchestrator(supabase);
    const transaction = await orchestrator.initiateFunding(ctx.tenantId, parsed.data);

    return c.json(mapTransactionResponse(transaction), 201);
  } catch (error: any) {
    if (error.message.includes('limit')) {
      return c.json({ error: error.message }, 429);
    }
    if (error.message.includes('not found') || error.message.includes('must be active')) {
      return c.json({ error: error.message }, 400);
    }
    return c.json({ error: error.message }, 500);
  }
});

/**
 * GET /v1/funding/transactions/:id - Get transaction status
 */
app.get('/transactions/:id', async (c) => {
  const ctx = c.get('ctx') as any;
  const id = c.req.param('id');

  try {
    const supabase = createClient();
    const orchestrator = createFundingOrchestrator(supabase);
    const transaction = await orchestrator.getTransaction(ctx.tenantId, id);

    return c.json(mapTransactionResponse(transaction));
  } catch (error: any) {
    return c.json({ error: error.message }, 404);
  }
});

/**
 * GET /v1/funding/transactions - List transaction history
 */
app.get('/transactions', async (c) => {
  const ctx = c.get('ctx') as any;
  const sourceId = c.req.query('source_id');
  const accountId = c.req.query('account_id');
  const status = c.req.query('status') as FundingTransactionStatus | undefined;
  const page = parseInt(c.req.query('page') || '1');
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 100);

  try {
    const supabase = createClient();
    const orchestrator = createFundingOrchestrator(supabase);
    const { data, total } = await orchestrator.listTransactions(ctx.tenantId, {
      source_id: sourceId,
      account_id: accountId,
      status,
      page,
      limit,
    });

    return c.json({
      data: data.map(mapTransactionResponse),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// ============================================
// Fee Estimation
// ============================================

/**
 * POST /v1/funding/estimate-fees - Estimate fees for a funding
 */
app.post('/estimate-fees', async (c) => {
  const ctx = c.get('ctx') as any;
  const body = await c.req.json();
  const parsed = estimateFeesSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  try {
    const supabase = createClient();
    const orchestrator = createFundingOrchestrator(supabase);
    const estimate = await orchestrator.estimateFees(
      ctx.tenantId,
      parsed.data.source_id,
      parsed.data.amount_cents,
      parsed.data.currency
    );

    return c.json(estimate);
  } catch (error: any) {
    return c.json({ error: error.message }, 400);
  }
});

// ============================================
// Conversion Quotes
// ============================================

/**
 * POST /v1/funding/conversion-quote - Get a conversion quote
 */
app.post('/conversion-quote', async (c) => {
  const body = await c.req.json();
  const parsed = conversionQuoteSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  try {
    const supabase = createClient();
    const conversion = createConversionService(supabase);
    const quote = await conversion.getQuote(
      parsed.data.from_currency,
      parsed.data.to_currency,
      parsed.data.amount_cents
    );

    return c.json(quote);
  } catch (error: any) {
    return c.json({ error: error.message }, 400);
  }
});

/**
 * GET /v1/funding/providers - List available providers
 */
app.get('/providers', async (c) => {
  const supabase = createClient();
  const orchestrator = createFundingOrchestrator(supabase);
  return c.json({ data: orchestrator.listProviders() });
});

/**
 * GET /v1/funding/conversion-rates - List conversion rates
 */
app.get('/conversion-rates', async (c) => {
  const supabase = createClient();
  const conversion = createConversionService(supabase);
  return c.json({ data: conversion.getSupportedPairs() });
});

// ============================================
// Crypto Onramp (Stripe Crypto Onramp)
// ============================================

/**
 * POST /v1/funding/onramp-session - Create Coinbase Onramp Session Token
 *
 * Returns a session token and wallet details for embedding the Coinbase onramp widget.
 * Coinbase handles fiat payment, USDC purchase, and delivery to the wallet address.
 * Sly never holds money.
 */
app.post('/onramp-session', async (c) => {
  const ctx = c.get('ctx') as any;
  const body = await c.req.json();
  const parsed = onrampSessionSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  try {
    const supabase = createClient();

    // Get wallet with on-chain address info
    const { data: wallet, error: walletError } = await supabase
      .from('wallets')
      .select('id, tenant_id, owner_account_id, status, wallet_address, blockchain, wallet_type')
      .eq('id', parsed.data.wallet_id)
      .eq('tenant_id', ctx.tenantId)
      .single();

    if (walletError || !wallet) {
      return c.json({ error: 'Wallet not found' }, 404);
    }

    if (wallet.status !== 'active') {
      return c.json({ error: `Wallet is ${wallet.status}, must be active` }, 400);
    }

    // Check wallet has a real on-chain address
    if (!wallet.wallet_address || wallet.wallet_address.startsWith('internal://')) {
      return c.json({
        error: 'no_onchain_address',
        message: 'This wallet does not have an on-chain address. Create a Circle wallet to deposit real USDC.',
      }, 400);
    }

    // Create Coinbase Onramp session token
    const tokenResult = await createOnrampToken({
      wallet_address: wallet.wallet_address,
      blockchain: wallet.blockchain || 'base',
    });

    const network = BLOCKCHAIN_TO_COINBASE[wallet.blockchain || 'base'] || 'base';

    return c.json({
      session_token: tokenResult.token,
      wallet_address: wallet.wallet_address,
      blockchain: wallet.blockchain,
      network,
    }, 201);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

/**
 * POST /v1/funding/stripe-onramp-session - Create Stripe Crypto Onramp Session
 *
 * Returns a client_secret for embedding Stripe's crypto onramp widget.
 * Stripe handles fiat payment, USDC purchase, and delivery to the wallet address.
 */
app.post('/stripe-onramp-session', async (c) => {
  const ctx = c.get('ctx') as any;
  const body = await c.req.json();
  const parsed = onrampSessionSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  try {
    const supabase = createClient();

    const { data: wallet, error: walletError } = await supabase
      .from('wallets')
      .select('id, tenant_id, owner_account_id, status, wallet_address, blockchain, wallet_type')
      .eq('id', parsed.data.wallet_id)
      .eq('tenant_id', ctx.tenantId)
      .single();

    if (walletError || !wallet) {
      return c.json({ error: 'Wallet not found' }, 404);
    }

    if (wallet.status !== 'active') {
      return c.json({ error: `Wallet is ${wallet.status}, must be active` }, 400);
    }

    if (!wallet.wallet_address || wallet.wallet_address.startsWith('internal://')) {
      return c.json({
        error: 'no_onchain_address',
        message: 'This wallet does not have an on-chain address. Create a Circle wallet to deposit real USDC.',
      }, 400);
    }

    // Get user profile for pre-filling customer info
    let customerEmail: string | undefined;
    let customerFirstName: string | undefined;
    let customerLastName: string | undefined;

    if (ctx.userId) {
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('email, full_name')
        .eq('id', ctx.userId)
        .single();

      if (profile) {
        customerEmail = profile.email;
        const nameParts = (profile.full_name || '').trim().split(/\s+/);
        customerFirstName = nameParts[0];
        customerLastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : undefined;
      }
    }

    const sessionResult = await createStripeOnrampSession({
      wallet_address: wallet.wallet_address,
      blockchain: wallet.blockchain || 'base',
      tenant_id: ctx.tenantId,
      wallet_id: wallet.id,
      account_id: wallet.owner_account_id,
      customer_email: customerEmail || ctx.userEmail,
      customer_first_name: customerFirstName || ctx.userName?.split(' ')[0],
      customer_last_name: customerLastName || ctx.userName?.split(' ').slice(1).join(' '),
    });

    const network = BLOCKCHAIN_TO_STRIPE[wallet.blockchain || 'base'] || 'base';

    return c.json({
      client_secret: sessionResult.client_secret,
      session_id: sessionResult.session_id,
      wallet_address: wallet.wallet_address,
      blockchain: wallet.blockchain,
      network,
    }, 201);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

/**
 * POST /v1/funding/crossmint-order - Create Crossmint Onramp Order
 *
 * Returns orderId and clientSecret for the embedded checkout component.
 * Crossmint handles fiat payment, USDC purchase, and delivery to wallet.
 */
app.post('/crossmint-order', async (c) => {
  const ctx = c.get('ctx') as any;
  const body = await c.req.json();
  const parsed = crossmintOrderSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  try {
    const supabase = createClient();

    const { data: wallet, error: walletError } = await supabase
      .from('wallets')
      .select('id, tenant_id, owner_account_id, status, wallet_address, blockchain, wallet_type')
      .eq('id', parsed.data.wallet_id)
      .eq('tenant_id', ctx.tenantId)
      .single();

    if (walletError || !wallet) {
      return c.json({ error: 'Wallet not found' }, 404);
    }

    if (!wallet.wallet_address || wallet.wallet_address.startsWith('internal://')) {
      return c.json({ error: 'no_onchain_address', message: 'Wallet needs an on-chain address.' }, 400);
    }

    const orderResult = await createCrossmintOrder({
      wallet_address: wallet.wallet_address,
      blockchain: wallet.blockchain || 'base',
      amount: parsed.data.amount,
      receipt_email: parsed.data.receipt_email,
    });

    return c.json({
      order_id: orderResult.order_id,
      client_secret: orderResult.client_secret,
      wallet_address: wallet.wallet_address,
      blockchain: wallet.blockchain,
    }, 201);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// ============================================
// Response Mappers
// ============================================

function mapSourceResponse(source: any) {
  const metadata = source.provider_metadata || {};
  return {
    id: source.id,
    account_id: source.account_id,
    type: source.type,
    provider: source.provider,
    status: source.status,
    display_name: source.display_name,
    last_four: source.last_four,
    brand: source.brand,
    supported_currencies: source.supported_currencies,
    limits: {
      per_transaction: source.per_transaction_limit_cents,
      daily: source.daily_limit_cents,
      monthly: source.monthly_limit_cents,
    },
    usage: {
      daily_used: source.daily_used_cents,
      monthly_used: source.monthly_used_cents,
      total_funded: source.total_funded_cents,
      funding_count: source.funding_count,
    },
    verified_at: source.verified_at,
    last_used_at: source.last_used_at,
    created_at: source.created_at,
    // Include client_secret/widget_url if present (for frontend setup)
    ...(metadata.client_secret ? { client_secret: metadata.client_secret } : {}),
    ...(metadata.widget_url ? { widget_url: metadata.widget_url } : {}),
    ...(metadata.deposit_address ? { deposit_address: metadata.deposit_address, network: metadata.network } : {}),
    ...(metadata.pix_qr_code ? { pix_qr_code: metadata.pix_qr_code, pix_copy_paste: metadata.pix_copy_paste } : {}),
    ...(metadata.clabe ? { clabe: metadata.clabe, spei_reference: metadata.reference } : {}),
  };
}

function mapTransactionResponse(tx: any) {
  const metadata = tx.provider_metadata || {};
  return {
    id: tx.id,
    source_id: tx.funding_source_id,
    account_id: tx.account_id,
    wallet_id: tx.wallet_id,
    amount_cents: tx.amount_cents,
    currency: tx.currency,
    converted_amount_cents: tx.converted_amount_cents,
    exchange_rate: tx.exchange_rate,
    conversion_currency: tx.conversion_currency,
    status: tx.status,
    failure_reason: tx.failure_reason,
    provider: tx.provider,
    fees: {
      provider: tx.provider_fee_cents,
      platform: tx.platform_fee_cents,
      conversion: tx.conversion_fee_cents,
      total: tx.total_fee_cents,
    },
    initiated_at: tx.initiated_at,
    processing_at: tx.processing_at,
    completed_at: tx.completed_at,
    created_at: tx.created_at,
    // Include action-required fields if present
    ...(metadata.client_secret ? { client_secret: metadata.client_secret } : {}),
    ...(metadata.redirect_url ? { redirect_url: metadata.redirect_url } : {}),
    ...(metadata.widget_url ? { widget_url: metadata.widget_url } : {}),
    ...(metadata.deposit_address ? { deposit_address: metadata.deposit_address } : {}),
    ...(metadata.pix_qr_code ? { pix_qr_code: metadata.pix_qr_code, pix_copy_paste: metadata.pix_copy_paste } : {}),
    ...(metadata.clabe ? { clabe: metadata.clabe, spei_reference: metadata.reference } : {}),
  };
}

export default app;
