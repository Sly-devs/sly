/**
 * Stripe Webhooks Handler
 * 
 * Receives and processes webhooks from Stripe for payment status updates.
 * 
 * @module routes/stripe-webhooks
 */

import { Hono } from 'hono';
import { createClient } from '../db/client.js';
import { getStripeClient, isStripeConfigured } from '../services/stripe/index.js';

const app = new Hono();

/**
 * POST /webhooks/stripe
 * Receive Stripe webhook events
 */
app.post('/', async (c) => {
  if (!isStripeConfigured()) {
    return c.json({ error: 'Stripe not configured' }, 503);
  }

  try {
    const signature = c.req.header('stripe-signature');
    if (!signature) {
      return c.json({ error: 'Missing Stripe signature' }, 400);
    }

    const payload = await c.req.text();
    const stripe = getStripeClient();

    // Verify signature
    if (!stripe.verifyWebhookSignature(payload, signature)) {
      console.error('[Stripe Webhook] Invalid signature');
      return c.json({ error: 'Invalid signature' }, 401);
    }

    const event = JSON.parse(payload);
    const eventType = event.type;
    const data = event.data?.object;

    console.log(`[Stripe Webhook] Received: ${eventType}`);

    const supabase: any = createClient();

    // Store webhook event for idempotency
    const { data: existing } = await supabase
      .from('webhook_events')
      .select('id')
      .eq('event_id', event.id)
      .single();

    if (existing) {
      console.log(`[Stripe Webhook] Duplicate event: ${event.id}`);
      return c.json({ received: true, status: 'duplicate' });
    }

    // Record the webhook event
    await supabase
      .from('webhook_events')
      .insert({
        tenant_id: '00000000-0000-0000-0000-000000000000', // System tenant
        provider: 'stripe',
        event_id: event.id,
        event_type: eventType,
        payload: event,
        status: 'processing',
      });

    // Handle specific events
    switch (eventType) {
      case 'payment_intent.succeeded':
        await handlePaymentIntentSucceeded(data);
        break;

      case 'payment_intent.payment_failed':
        await handlePaymentIntentFailed(data);
        break;

      case 'payment_intent.canceled':
        await handlePaymentIntentCanceled(data);
        break;

      case 'setup_intent.succeeded':
        await handleSetupIntentSucceeded(data);
        break;

      case 'payment_method.attached':
        // Backup handler — we usually catch the attach via setup_intent.succeeded
        await handlePaymentMethodAttached(data);
        break;

      case 'payment_method.detached':
        await handlePaymentMethodDetached(data);
        break;

      default:
        console.log(`[Stripe Webhook] Unhandled event type: ${eventType}`);
    }

    // Mark webhook as processed
    await supabase
      .from('webhook_events')
      .update({
        status: 'processed',
        processed_at: new Date().toISOString(),
      })
      .eq('event_id', event.id);

    return c.json({ received: true, status: 'processed' });
  } catch (error: any) {
    console.error('[Stripe Webhook] Error:', error);

    // Try to mark webhook as failed
    try {
      const payload = await c.req.text();
      const event = JSON.parse(payload);
      const supabase: any = createClient();
      await supabase
        .from('webhook_events')
        .update({
          status: 'failed',
          error_message: error.message,
        })
        .eq('event_id', event.id);
    } catch {}

    return c.json({ error: 'Webhook processing failed' }, 500);
  }
});

/**
 * Handle successful payment
 */
async function handlePaymentIntentSucceeded(paymentIntent: any) {
  console.log(`[Stripe Webhook] Payment succeeded: ${paymentIntent.id}`);
  
  const supabase: any = createClient();
  const metadata = paymentIntent.metadata || {};

  // If this was an ACP payment, update the checkout
  if (metadata.source === 'acp' && metadata.checkout_id) {
    // Find checkout by stripe payment intent ID
    const { data: checkout } = await supabase
      .from('acp_checkouts')
      .select('id, tenant_id')
      .eq('checkout_data->>stripe_payment_intent_id', paymentIntent.id)
      .single();

    if (checkout) {
      await supabase
        .from('acp_checkouts')
        .update({
          checkout_data: {
            stripe_payment_status: 'succeeded',
            stripe_payment_intent_id: paymentIntent.id,
          },
        })
        .eq('id', checkout.id);

      console.log(`[Stripe Webhook] Updated ACP checkout: ${checkout.id}`);
    }
  }
}

/**
 * Handle failed payment
 */
async function handlePaymentIntentFailed(paymentIntent: any) {
  console.log(`[Stripe Webhook] Payment failed: ${paymentIntent.id}`);
  
  const supabase: any = createClient();
  const metadata = paymentIntent.metadata || {};

  if (metadata.source === 'acp') {
    const { data: checkout } = await supabase
      .from('acp_checkouts')
      .select('id')
      .eq('checkout_data->>stripe_payment_intent_id', paymentIntent.id)
      .single();

    if (checkout) {
      await supabase
        .from('acp_checkouts')
        .update({
          status: 'failed',
          checkout_data: {
            stripe_payment_status: 'failed',
            stripe_payment_intent_id: paymentIntent.id,
            stripe_error: paymentIntent.last_payment_error?.message,
          },
        })
        .eq('id', checkout.id);

      console.log(`[Stripe Webhook] Marked ACP checkout as failed: ${checkout.id}`);
    }
  }
}

/**
 * Handle canceled payment
 */
async function handlePaymentIntentCanceled(paymentIntent: any) {
  console.log(`[Stripe Webhook] Payment canceled: ${paymentIntent.id}`);
  
  // Similar handling as failed
  const supabase: any = createClient();
  const metadata = paymentIntent.metadata || {};

  if (metadata.source === 'acp') {
    const { data: checkout } = await supabase
      .from('acp_checkouts')
      .select('id')
      .eq('checkout_data->>stripe_payment_intent_id', paymentIntent.id)
      .single();

    if (checkout) {
      await supabase
        .from('acp_checkouts')
        .update({
          status: 'cancelled',
          cancelled_at: new Date().toISOString(),
          checkout_data: {
            stripe_payment_status: 'canceled',
            stripe_payment_intent_id: paymentIntent.id,
          },
        })
        .eq('id', checkout.id);
    }
  }
}

/**
 * Handle SetupIntent success (Epic 88, Phase 1) — vault the PaymentMethod
 * locally so the dashboard can list it and the checkout flow can charge it.
 */
async function handleSetupIntentSucceeded(setupIntent: any) {
  console.log(`[Stripe Webhook] SetupIntent succeeded: ${setupIntent.id}`);

  const supabase: any = createClient();
  const userId = setupIntent.metadata?.sly_user_id;
  const tenantIdFromMeta = setupIntent.metadata?.sly_tenant_id;
  const customerId = setupIntent.customer;
  const paymentMethodId = setupIntent.payment_method;

  if (!userId || !customerId || !paymentMethodId) {
    console.warn('[Stripe Webhook] setup_intent.succeeded missing user/customer/payment_method', {
      userId, customerId, paymentMethodId,
    });
    return;
  }

  // Look up the customer mapping (authoritative for tenant_id)
  const { data: mapping } = await supabase
    .from('wallet_stripe_customers')
    .select('tenant_id')
    .eq('user_id', userId)
    .eq('stripe_customer_id', customerId)
    .maybeSingle();

  const tenantId = mapping?.tenant_id || tenantIdFromMeta;
  if (!tenantId) {
    console.warn('[Stripe Webhook] No tenant resolution for setup intent', setupIntent.id);
    return;
  }

  // Fetch full PaymentMethod for card details
  let pm: any = null;
  try {
    const stripe = getStripeClient();
    pm = await stripe.getPaymentMethod(paymentMethodId);
  } catch (err: any) {
    console.warn('[Stripe Webhook] Failed to fetch payment method:', err.message);
  }

  // Idempotent: if already inserted, refresh card metadata; else insert.
  const { data: existing } = await supabase
    .from('wallet_payment_methods')
    .select('id')
    .eq('stripe_payment_method_id', paymentMethodId)
    .maybeSingle();

  // Should this be the user's default? Only if they have no other active
  // payment method.
  const { count: activeCount } = await supabase
    .from('wallet_payment_methods')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .is('detached_at', null);
  const isDefault = !activeCount || activeCount === 0;

  if (existing) {
    await supabase
      .from('wallet_payment_methods')
      .update({
        brand: pm?.card?.brand ?? null,
        last4: pm?.card?.last4 ?? null,
        exp_month: pm?.card?.exp_month ?? null,
        exp_year: pm?.card?.exp_year ?? null,
        detached_at: null,
      })
      .eq('id', existing.id);
  } else {
    await supabase.from('wallet_payment_methods').insert({
      tenant_id: tenantId,
      user_id: userId,
      stripe_customer_id: customerId,
      stripe_payment_method_id: paymentMethodId,
      brand: pm?.card?.brand ?? null,
      last4: pm?.card?.last4 ?? null,
      exp_month: pm?.card?.exp_month ?? null,
      exp_year: pm?.card?.exp_year ?? null,
      is_default: isDefault,
      environment: 'test',
    });
  }

  console.log(`[Stripe Webhook] Vaulted PaymentMethod ${paymentMethodId} for user ${userId} (default=${isDefault})`);
}

/**
 * Backup handler — if the SetupIntent webhook didn't catch the attach
 * (e.g. user added card via Stripe Customer Portal directly), still vault
 * it. Keyed by metadata.sly_user_id; otherwise no-op.
 */
async function handlePaymentMethodAttached(pm: any) {
  if (!pm.metadata?.sly_user_id) return;
  await handleSetupIntentSucceeded({
    id: 'pm_attach_backup',
    customer: pm.customer,
    payment_method: pm.id,
    metadata: pm.metadata,
  });
}

/**
 * Handle PaymentMethod detached — mirror the state in our table so the
 * dashboard list stays consistent if the user detaches via the Stripe
 * Customer Portal.
 */
async function handlePaymentMethodDetached(pm: any) {
  console.log(`[Stripe Webhook] PaymentMethod detached: ${pm.id}`);
  const supabase: any = createClient();
  await supabase
    .from('wallet_payment_methods')
    .update({ detached_at: new Date().toISOString(), is_default: false })
    .eq('stripe_payment_method_id', pm.id)
    .is('detached_at', null);
}

export default app;



