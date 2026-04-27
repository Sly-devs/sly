/**
 * Buyer-side Wallet API (Epic 88, Phase 1)
 *
 * Endpoints:
 *   POST   /v1/wallet/customer        — create-or-get Stripe Customer for the user
 *   POST   /v1/wallet/setup-intent    — create a SetupIntent for Payment Element
 *   GET    /v1/wallet/payment-methods — list saved cards (active, not detached)
 *   PATCH  /v1/wallet/payment-methods/:id — set default
 *   DELETE /v1/wallet/payment-methods/:id — detach
 *
 * All endpoints require a logged-in user JWT — the wallet is owned by the
 * dashboard user (user_profiles row), not the multi-tenant `accounts` rows.
 */

import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.js';
import { createClient } from '../db/client.js';
import { getStripeClient, isStripeConfigured } from '../services/stripe/index.js';

const app = new Hono();
app.use('*', authMiddleware);

function envFromCtx(ctx: any): 'test' | 'live' {
  // Wallet is only ever in 'test' or 'live' (not 'sandbox' / 'testnet').
  // For Phase 1 demo: hard-pin to test mode regardless of header.
  return 'test';
}

function requireUser(ctx: any) {
  if (ctx.actorType !== 'user' || !ctx.userId) {
    return null;
  }
  return ctx.userId as string;
}

// ── Stripe Customer ───────────────────────────────────────────────────────
app.post('/customer', async (c) => {
  if (!isStripeConfigured()) return c.json({ error: 'Stripe not configured' }, 503);
  const ctx = c.get('ctx');
  const userId = requireUser(ctx);
  if (!userId) return c.json({ error: 'User session required' }, 401);

  const supabase: any = createClient();
  const env = envFromCtx(ctx);

  // Idempotent: return existing if already provisioned
  const { data: existing } = await supabase
    .from('wallet_stripe_customers')
    .select('stripe_customer_id')
    .eq('user_id', userId)
    .eq('environment', env)
    .maybeSingle();

  if (existing?.stripe_customer_id) {
    return c.json({ data: { stripe_customer_id: existing.stripe_customer_id, created: false } });
  }

  // Look up the user's profile for name
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('name, tenant_id')
    .eq('id', userId)
    .single();

  const stripe = getStripeClient();
  const customer = await stripe.createCustomer({
    name: profile?.name || undefined,
    metadata: {
      sly_user_id: userId,
      sly_tenant_id: profile?.tenant_id || ctx.tenantId,
    },
  });

  await supabase.from('wallet_stripe_customers').insert({
    user_id: userId,
    tenant_id: profile?.tenant_id || ctx.tenantId,
    stripe_customer_id: customer.id,
    environment: env,
  });

  return c.json({ data: { stripe_customer_id: customer.id, created: true } });
});

// ── SetupIntent ───────────────────────────────────────────────────────────
app.post('/setup-intent', async (c) => {
  if (!isStripeConfigured()) return c.json({ error: 'Stripe not configured' }, 503);
  const ctx = c.get('ctx');
  const userId = requireUser(ctx);
  if (!userId) return c.json({ error: 'User session required' }, 401);

  const supabase: any = createClient();
  const env = envFromCtx(ctx);

  // Resolve (or create) the user's Stripe Customer inline so the
  // /wallet/add-card page can be a single-shot for the consumer.
  let { data: row } = await supabase
    .from('wallet_stripe_customers')
    .select('stripe_customer_id, tenant_id')
    .eq('user_id', userId)
    .eq('environment', env)
    .maybeSingle();

  if (!row?.stripe_customer_id) {
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('name, tenant_id')
      .eq('id', userId)
      .single();
    const stripe = getStripeClient();
    const customer = await stripe.createCustomer({
      name: profile?.name || undefined,
      metadata: {
        sly_user_id: userId,
        sly_tenant_id: profile?.tenant_id || ctx.tenantId,
      },
    });
    await supabase.from('wallet_stripe_customers').insert({
      user_id: userId,
      tenant_id: profile?.tenant_id || ctx.tenantId,
      stripe_customer_id: customer.id,
      environment: env,
    });
    row = { stripe_customer_id: customer.id, tenant_id: profile?.tenant_id || ctx.tenantId };
  }

  const stripe = getStripeClient();
  const intent = await stripe.createSetupIntent({
    customer: row.stripe_customer_id,
    usage: 'off_session',
    // Force card-only — Stripe's Payment Element auto-prompts Link
    // when it recognizes the email, which creates type='link' methods
    // we don't render in the wallet list. Card only is unambiguous.
    paymentMethodTypes: ['card'],
    metadata: {
      sly_user_id: userId,
      sly_tenant_id: row.tenant_id || ctx.tenantId,
    },
  });

  return c.json({
    data: {
      client_secret: intent.client_secret,
      setup_intent_id: intent.id,
      stripe_customer_id: row.stripe_customer_id,
      publishable_key: process.env.STRIPE_PUBLISHABLE_KEY,
    },
  });
});

// ── List payment methods ──────────────────────────────────────────────────
app.get('/payment-methods', async (c) => {
  const ctx = c.get('ctx');
  const userId = requireUser(ctx);
  if (!userId) return c.json({ error: 'User session required' }, 401);

  const supabase: any = createClient();
  const env = envFromCtx(ctx);

  const { data: rows, error } = await supabase
    .from('wallet_payment_methods')
    .select('id, stripe_customer_id, stripe_payment_method_id, brand, last4, exp_month, exp_year, is_default, created_at')
    .eq('user_id', userId)
    .eq('environment', env)
    .is('detached_at', null)
    .order('is_default', { ascending: false })
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[Wallet] list error:', error);
    return c.json({ error: 'Failed to load payment methods' }, 500);
  }

  // ── Webhook-less reconciliation ──────────────────────────────────────
  // If we have a Stripe Customer for this user but our DB shows no
  // active payment methods, ask Stripe directly. Vault any cards we
  // find. This makes the demo work even without `stripe listen` running.
  let methods = rows || [];
  if (methods.length === 0 && isStripeConfigured()) {
    const { data: customer } = await supabase
      .from('wallet_stripe_customers')
      .select('stripe_customer_id, tenant_id')
      .eq('user_id', userId)
      .eq('environment', env)
      .maybeSingle();

    if (customer?.stripe_customer_id) {
      try {
        const stripe = getStripeClient();
        const stripeMethods = await stripe.listCustomerPaymentMethods(customer.stripe_customer_id);
        if (stripeMethods.length > 0) {
          // Insert any we don't already have (filter on stripe_payment_method_id
          // because the table has a UNIQUE on it). Use upsert with
          // ignoreDuplicates to make this safe to re-run.
          const inserts = stripeMethods.map((pm: any, idx: number) => ({
            tenant_id: customer.tenant_id,
            user_id: userId,
            stripe_customer_id: customer.stripe_customer_id,
            stripe_payment_method_id: pm.id,
            brand: pm.card?.brand ?? null,
            last4: pm.card?.last4 ?? null,
            exp_month: pm.card?.exp_month ?? null,
            exp_year: pm.card?.exp_year ?? null,
            // First card becomes default
            is_default: idx === 0,
            environment: env,
          }));
          await supabase
            .from('wallet_payment_methods')
            .upsert(inserts, { onConflict: 'stripe_payment_method_id', ignoreDuplicates: true });

          // Re-read after backfill
          const { data: refreshed } = await supabase
            .from('wallet_payment_methods')
            .select('id, stripe_customer_id, stripe_payment_method_id, brand, last4, exp_month, exp_year, is_default, created_at')
            .eq('user_id', userId)
            .eq('environment', env)
            .is('detached_at', null)
            .order('is_default', { ascending: false })
            .order('created_at', { ascending: false });
          methods = refreshed || [];
        }
      } catch (reconErr: any) {
        console.warn('[Wallet] Stripe reconciliation failed (non-fatal):', reconErr.message);
      }
    }
  }

  return c.json({ data: methods });
});

// ── Finalize after confirmSetup (synchronous, no webhook required) ───────
// The /wallet/add-card page calls this immediately after Stripe.js
// `confirmSetup` succeeds. We re-fetch the SetupIntent to verify it
// actually succeeded server-side (never trust client), then vault the
// PaymentMethod row. Idempotent — safe to call twice.
app.post('/payment-methods/finalize', async (c) => {
  if (!isStripeConfigured()) return c.json({ error: 'Stripe not configured' }, 503);
  const ctx = c.get('ctx');
  const userId = requireUser(ctx);
  if (!userId) return c.json({ error: 'User session required' }, 401);

  const body = await c.req.json().catch(() => ({}));
  const setupIntentId = (body as any).setup_intent_id as string | undefined;
  if (!setupIntentId) return c.json({ error: 'setup_intent_id required' }, 400);

  const supabase: any = createClient();
  const env = envFromCtx(ctx);
  const stripe = getStripeClient();

  // Verify SetupIntent succeeded and is owned by this user.
  const si = await stripe.getSetupIntent(setupIntentId);
  if (si.status !== 'succeeded') {
    return c.json({ error: `SetupIntent not succeeded (status: ${si.status})` }, 400);
  }
  if (!si.payment_method || !si.customer) {
    return c.json({ error: 'SetupIntent missing payment_method or customer' }, 400);
  }

  // Confirm the customer in this SetupIntent matches the user's customer
  // record (defense against a confused-deputy attack).
  const { data: customerRow } = await supabase
    .from('wallet_stripe_customers')
    .select('stripe_customer_id, tenant_id')
    .eq('user_id', userId)
    .eq('environment', env)
    .maybeSingle();
  if (!customerRow || customerRow.stripe_customer_id !== si.customer) {
    return c.json({ error: 'SetupIntent does not belong to this user' }, 403);
  }

  const pm = await stripe.getPaymentMethod(si.payment_method);
  if ((pm as any).type !== 'card' || !pm.card) {
    return c.json({
      error: `Only card-type payment methods are supported (got: ${(pm as any).type}). ` +
             `Use the Card tab in the Payment Element, not Link.`,
      code: 'UNSUPPORTED_TYPE',
    }, 400);
  }

  // Idempotent insert: if we already vaulted this PaymentMethod, return
  // the existing row.
  const { data: existing } = await supabase
    .from('wallet_payment_methods')
    .select('id, brand, last4, is_default')
    .eq('stripe_payment_method_id', pm.id)
    .maybeSingle();

  if (existing) {
    return c.json({ data: existing });
  }

  // First card becomes default.
  const { count: activeCount } = await supabase
    .from('wallet_payment_methods')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('environment', env)
    .is('detached_at', null);
  const isDefault = !activeCount || activeCount === 0;

  const { data: inserted, error } = await supabase
    .from('wallet_payment_methods')
    .insert({
      tenant_id: customerRow.tenant_id,
      user_id: userId,
      stripe_customer_id: si.customer,
      stripe_payment_method_id: pm.id,
      brand: pm.card.brand,
      last4: pm.card.last4,
      exp_month: pm.card.exp_month,
      exp_year: pm.card.exp_year,
      is_default: isDefault,
      environment: env,
    })
    .select('id, brand, last4, is_default')
    .single();

  if (error) {
    console.error('[Wallet] finalize insert error:', error);
    return c.json({ error: 'Failed to vault payment method', details: error.message }, 500);
  }

  return c.json({ data: inserted });
});

// ── Set default ───────────────────────────────────────────────────────────
app.patch('/payment-methods/:id', async (c) => {
  const ctx = c.get('ctx');
  const userId = requireUser(ctx);
  if (!userId) return c.json({ error: 'User session required' }, 401);
  const id = c.req.param('id');

  const supabase: any = createClient();
  const env = envFromCtx(ctx);

  // Verify ownership
  const { data: pm } = await supabase
    .from('wallet_payment_methods')
    .select('id')
    .eq('id', id)
    .eq('user_id', userId)
    .eq('environment', env)
    .is('detached_at', null)
    .maybeSingle();
  if (!pm) return c.json({ error: 'Payment method not found' }, 404);

  // Two-step: clear all existing defaults, then set this one. Wrapped in
  // a transaction-equivalent sequence (postgres unique partial index
  // guarantees only one default at a time).
  await supabase
    .from('wallet_payment_methods')
    .update({ is_default: false })
    .eq('user_id', userId)
    .eq('environment', env)
    .is('detached_at', null);

  const { error } = await supabase
    .from('wallet_payment_methods')
    .update({ is_default: true })
    .eq('id', id);

  if (error) return c.json({ error: 'Failed to set default' }, 500);
  return c.json({ data: { id, is_default: true } });
});

// ── Detach ────────────────────────────────────────────────────────────────
app.delete('/payment-methods/:id', async (c) => {
  if (!isStripeConfigured()) return c.json({ error: 'Stripe not configured' }, 503);
  const ctx = c.get('ctx');
  const userId = requireUser(ctx);
  if (!userId) return c.json({ error: 'User session required' }, 401);
  const id = c.req.param('id');

  const supabase: any = createClient();
  const env = envFromCtx(ctx);

  const { data: pm } = await supabase
    .from('wallet_payment_methods')
    .select('id, stripe_payment_method_id')
    .eq('id', id)
    .eq('user_id', userId)
    .eq('environment', env)
    .is('detached_at', null)
    .maybeSingle();
  if (!pm) return c.json({ error: 'Payment method not found' }, 404);

  // Detach on Stripe (best-effort — if this 4xx's, still mark detached locally
  // so the UI is consistent).
  try {
    const stripe = getStripeClient();
    await stripe.detachPaymentMethod(pm.stripe_payment_method_id);
  } catch (err: any) {
    console.warn('[Wallet] Stripe detach failed (continuing):', err.message);
  }

  await supabase
    .from('wallet_payment_methods')
    .update({ detached_at: new Date().toISOString(), is_default: false })
    .eq('id', pm.id);

  return c.json({ data: { id: pm.id, detached: true } });
});

export default app;
