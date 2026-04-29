/**
 * /v1/buy — single B2C entry point (Epic 88).
 *
 * Wraps the ACP create + complete flow so the agent doesn't have to know
 * about protocols, checkout ids, payment instruments, or merchant ids.
 *
 * Input is intentionally minimal:
 *   {
 *     merchant: "El Trapiche",          // name OR invu_merchant_id OR account UUID
 *     items: [{ name, quantity }, ...], // names matched against merchant catalog
 *   }
 *
 * Server resolves: buyer profile (= tenant owner's user_profiles row),
 * the buyer's default vaulted card, the merchant's account row, and item
 * pricing from metadata.catalog. Then runs ACP create → complete with
 * wallet_payment_method_id pre-bound, so policy + approval + Stripe
 * all wire up automatically.
 *
 * Returns one of:
 *   { status: 'approval_required', approve_url, approval_id, total, currency, items, expires_at }
 *   { status: 'completed', total, currency, items, transfer_id, charge: { id, brand, last4 } }
 *   { status: 'denied', reason }
 *
 * Auth: agent token (typical) OR user JWT.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { authMiddleware } from '../middleware/auth.js';
import { createClient } from '../db/client.js';

const app = new Hono();
app.use('*', authMiddleware);

const buySchema = z.object({
  merchant: z.string().min(1),
  items: z
    .array(
      z.object({
        name: z.string().min(1),
        quantity: z.number().int().positive().default(1),
      }),
    )
    .min(1),
  approve_url_base: z.string().url().optional(),
});

function publicAppUrl(c: any): string {
  // Approval page lives in the web app. Allow override for ngrok/prod.
  const fromCaller = c.req.header('x-public-app-url');
  return (
    fromCaller ||
    process.env.PUBLIC_APP_URL ||
    'https://localhost:3000'
  );
}

function publicApiUrl(c: any): string {
  // Where the inline approval form posts. We route through the same
  // app-url (Next.js rewrites /v1/* to the API), so the iframe stays
  // on a single origin. Allow override for ngrok/prod.
  return (
    c.req.header('x-public-api-url') ||
    process.env.PUBLIC_API_URL ||
    publicAppUrl(c)
  );
}

function mintApproveToken(): string {
  return `aprtok_${randomBytes(24).toString('base64url')}`;
}

/**
 * Generate the inline mcp-app HTML that Claude renders in-chat.
 * Self-contained, mobile-shaped, posts the magic token back to the
 * public approve endpoint. The form's response is itself an HTML
 * page (success or error) so the iframe just navigates in place.
 */
function renderInlineApprovalHtml(opts: {
  approveAction: string;
  merchantName: string;
  total: number;
  currency: string;
  items: Array<{ name: string; quantity: number; total: number }>;
  cardOnFile: string;
  agentName: string;
  reason: string;
  expiresAt: string;
}): string {
  const itemsRows = opts.items
    .map((l) => `
      <div class="row" style="justify-content:space-between;font-size:14px;margin:4px 0">
        <span>${l.quantity}× <strong>${escapeHtml(l.name)}</strong></span>
        <span style="font-variant-numeric:tabular-nums">${opts.currency} ${l.total.toFixed(2)}</span>
      </div>`)
    .join('');

  const expiresLabel = (() => {
    const ms = new Date(opts.expiresAt).getTime() - Date.now();
    if (ms <= 0) return 'expired';
    const m = Math.max(1, Math.floor(ms / 60000));
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)} hr`;
  })();

  return `<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
  :root{color-scheme:light dark}
  *{box-sizing:border-box}
  html,body{margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,"SF Pro",system-ui,sans-serif;
    background:#0f172a;color:#e2e8f0;font-size:14px;line-height:1.45}
  @media (prefers-color-scheme: light){html,body{background:#f8fafc;color:#0f172a}}
  .wrap{padding:14px;max-width:520px}
  .card{background:#1e293b;border:1px solid #334155;border-radius:14px;padding:14px;margin-bottom:8px}
  @media (prefers-color-scheme: light){.card{background:#fff;border-color:#e2e8f0}}
  .row{display:flex;align-items:center;gap:10px}
  .h{font-weight:600}
  .muted{opacity:.7;font-size:12px}
  .total{font-size:24px;font-weight:600;font-variant-numeric:tabular-nums}
  .gradient-badge{
    width:42px;height:42px;border-radius:12px;flex-shrink:0;
    background:linear-gradient(135deg,#fde68a,#fb923c);
    color:#7c2d12;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:18px}
  button{font-family:inherit;font-size:15px;width:100%;padding:14px;border-radius:12px;border:0;cursor:pointer;font-weight:600}
  .btn-primary{background:#0f172a;color:#fff;margin-bottom:6px}
  @media (prefers-color-scheme: light){.btn-primary{background:#0f172a;color:#fff}}
  .btn-secondary{background:transparent;border:1px solid #334155;color:#e2e8f0}
  @media (prefers-color-scheme: light){.btn-secondary{border-color:#cbd5e1;color:#475569}}
  .reason{background:rgba(245,158,11,0.12);border-radius:10px;padding:10px;margin-top:10px;font-size:12px;color:#fbbf24}
  @media (prefers-color-scheme: light){.reason{color:#92400e;background:#fef3c7}}
  .pay-row{display:flex;justify-content:space-between;align-items:center;margin-top:10px;padding-top:10px;border-top:1px solid #334155}
  @media (prefers-color-scheme: light){.pay-row{border-top-color:#e2e8f0}}
  .meta{display:flex;justify-content:space-between;margin-bottom:8px}
  .badge{display:inline-flex;align-items:center;gap:4px;background:#334155;border-radius:9999px;padding:3px 10px;font-size:11px;opacity:.85}
  @media (prefers-color-scheme: light){.badge{background:#e2e8f0;color:#475569}}
</style></head>
<body><div class="wrap">
  <div class="meta">
    <span class="badge">Sly · approval needed</span>
    <span class="muted">expires in ${expiresLabel}</span>
  </div>

  <div class="card">
    <div class="row">
      <div class="gradient-badge">${escapeHtml(opts.merchantName.charAt(0))}</div>
      <div>
        <div class="h">${escapeHtml(opts.merchantName)}</div>
        <div class="muted">requested by ${escapeHtml(opts.agentName)}</div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="muted" style="text-transform:uppercase;letter-spacing:.5px;font-size:10px">Order</div>
    <div style="margin-top:6px">${itemsRows}</div>
    <div class="pay-row">
      <span class="muted">Total</span>
      <span class="total">${opts.currency} ${opts.total.toFixed(2)}</span>
    </div>
    <div class="pay-row">
      <span class="muted">Pay with</span>
      <span class="h">${escapeHtml(opts.cardOnFile)}</span>
    </div>
    <div class="reason">${escapeHtml(opts.reason)} — single-use approval, only this order will be authorized.</div>
  </div>

  <form method="post" action="${escapeHtml(opts.approveAction)}" id="approveForm">
    <button class="btn-primary" type="submit" id="approveBtn">Approve · ${opts.currency} ${opts.total.toFixed(2)}</button>
  </form>
  <button class="btn-secondary" type="button" onclick="parent.postMessage({type:'sly:deny'},'*')">Deny</button>

  <script>
    const form = document.getElementById('approveForm');
    form.addEventListener('submit', () => {
      const btn = document.getElementById('approveBtn');
      btn.disabled = true;
      btn.textContent = 'Approving…';
    });
  </script>
</div></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] as string));
}

/**
 * GET /v1/buy/status/:approval_id?wait=<sec>
 *
 * Long-polls the approval state. Returns immediately if the approval is
 * already in a terminal state (executed/rejected/expired); otherwise
 * blocks for up to `wait` seconds (max 60) checking once per second.
 *
 * Used by the sly_buy_status MCP tool right after sly_buy surfaces an
 * approve_url, so Claude can wait for the user's tap without the user
 * having to say "approved".
 */
app.get('/status/:approval_id', async (c) => {
  const ctx = c.get('ctx');
  const approvalId = c.req.param('approval_id');
  const waitParam = parseInt(c.req.query('wait') || '0', 10);
  const waitMs = Math.max(0, Math.min(60, isNaN(waitParam) ? 0 : waitParam)) * 1000;

  const supabase: any = createClient();
  const start = Date.now();

  while (true) {
    const { data: approval } = await supabase
      .from('agent_payment_approvals')
      .select('id, status, executed_transfer_id, decided_at, executed_at, payment_context, recipient, amount, currency')
      .eq('id', approvalId)
      .eq('tenant_id', ctx.tenantId)
      .maybeSingle();

    if (!approval) {
      return c.json({ error: 'Approval not found', code: 'NOT_FOUND' }, 404);
    }

    if (approval.status === 'executed' || approval.status === 'rejected' || approval.status === 'expired') {
      // Terminal state — return final shape.
      if (approval.status === 'executed') {
        // Look up the transfer for the receipt.
        const { data: transfer } = await supabase
          .from('transfers')
          .select('id, amount, currency, protocol_metadata, created_at')
          .eq('id', approval.executed_transfer_id)
          .maybeSingle();
        const pm = transfer?.protocol_metadata || {};
        return c.json({
          status: 'completed',
          merchant: approval.recipient?.merchant_name || pm.merchant_name,
          total: parseFloat(transfer?.amount as any) || approval.amount,
          currency: transfer?.currency || approval.currency,
          items: approval.payment_context?.items || [],
          transfer_id: transfer?.id ?? null,
          charge: {
            id: pm.stripe_payment_intent_id ?? null,
            brand: pm.card_brand ?? null,
            last4: pm.card_last4 ?? null,
          },
          completed_at: approval.executed_at,
          receipt_message:
            `Order placed at ${approval.recipient?.merchant_name || 'merchant'}. ` +
            `Charged ${approval.currency} ${parseFloat(approval.amount).toFixed(2)} to ${pm.card_brand} •••• ${pm.card_last4}.`,
        });
      }
      if (approval.status === 'rejected') {
        return c.json({ status: 'denied', reason: 'User denied the approval.' });
      }
      return c.json({ status: 'expired', reason: 'Approval link expired before the user tapped.' });
    }

    // Pending or approved-but-not-executed-yet — keep waiting if budget left.
    if (Date.now() - start >= waitMs) {
      // Out of budget. Return current intermediate state so Claude can
      // either prompt the user or call back.
      return c.json({
        status: approval.status === 'approved' ? 'approved_pending_charge' : 'approval_required',
        approval_id: approval.id,
        amount: parseFloat(approval.amount),
        currency: approval.currency,
        merchant: approval.recipient?.merchant_name,
        message: approval.status === 'approved'
          ? 'User approved; charge is being captured. Call again to see the receipt.'
          : 'Still waiting on the user to tap the approve link.',
      }, 202);
    }
    await new Promise(r => setTimeout(r, 1000));
  }
});

app.post('/', async (c) => {
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  const parsed = buySchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Validation failed', details: parsed.error.format() }, 400);

  const ctx = c.get('ctx');
  const supabase: any = createClient();

  // ── Resolve agent (caller) ──────────────────────────────────────────
  // Agent token auth: ctx.actorType === 'agent', ctx.actorId is agent UUID.
  // User JWT path is supported as a fallback so the dashboard can also
  // call this endpoint, but the typical caller is the agent.
  let agentRow: { id: string; name: string; parent_account_id: string | null } | null = null;
  if (ctx.actorType === 'agent' && ctx.actorId) {
    const { data } = await supabase
      .from('agents')
      .select('id, name, parent_account_id')
      .eq('id', ctx.actorId)
      .eq('tenant_id', ctx.tenantId)
      .maybeSingle();
    agentRow = data || null;
  } else {
    return c.json({
      error: 'sly_buy must be called by an agent token (agent_*). User-token callers should use the dashboard.',
      code: 'AGENT_REQUIRED',
    }, 400);
  }
  if (!agentRow) {
    return c.json({ error: 'Agent not found', code: 'AGENT_NOT_FOUND' }, 404);
  }

  // ── Resolve buyer (tenant owner's user_profile) ─────────────────────
  // For Phase 1 demo we map: agent → tenant_id → tenant owner = the
  // dashboard user who has the vaulted card. Production would link the
  // agent directly to a specific user_profile.
  const { data: ownerProfile } = await supabase
    .from('user_profiles')
    .select('id, name, tenant_id')
    .eq('tenant_id', ctx.tenantId)
    .eq('role', 'owner')
    .maybeSingle();
  if (!ownerProfile?.id) {
    return c.json({
      error: 'No owner user_profile found in this tenant. Add a card via /dashboard/wallet first.',
      code: 'BUYER_NOT_FOUND',
    }, 400);
  }

  // ── Resolve buyer's default vaulted card (optional — guest checkout
  //    on the approval page handles the no-card path). ────────────────
  const { data: card } = await supabase
    .from('wallet_payment_methods')
    .select('id, brand, last4, stripe_payment_method_id')
    .eq('user_id', ownerProfile.id)
    .is('detached_at', null)
    .order('is_default', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // ── Resolve merchant ────────────────────────────────────────────────
  // Accept three forms: account UUID, invu_merchant_id, or human name.
  // Pick the first match, prefer subtype='merchant' rows.
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parsed.data.merchant);

  let merchantRow: any = null;
  if (isUuid) {
    const { data } = await supabase
      .from('accounts')
      .select('id, name, currency, metadata')
      .eq('id', parsed.data.merchant)
      .eq('tenant_id', ctx.tenantId)
      .eq('subtype', 'merchant')
      .maybeSingle();
    merchantRow = data;
  }
  if (!merchantRow) {
    // try invu_merchant_id
    const { data } = await supabase
      .from('accounts')
      .select('id, name, currency, metadata')
      .eq('tenant_id', ctx.tenantId)
      .eq('subtype', 'merchant')
      .eq('metadata->>invu_merchant_id', parsed.data.merchant)
      .maybeSingle();
    merchantRow = data;
  }
  if (!merchantRow) {
    // try human name (case-insensitive contains)
    const { data } = await supabase
      .from('accounts')
      .select('id, name, currency, metadata')
      .eq('tenant_id', ctx.tenantId)
      .eq('subtype', 'merchant')
      .ilike('name', `%${parsed.data.merchant}%`)
      .limit(1)
      .maybeSingle();
    merchantRow = data;
  }
  if (!merchantRow) {
    return c.json({
      error: `Merchant "${parsed.data.merchant}" not found.`,
      code: 'MERCHANT_NOT_FOUND',
    }, 404);
  }

  // ── Resolve items from merchant catalog ─────────────────────────────
  const rawCatalog = merchantRow.metadata?.catalog;
  const products: any[] = Array.isArray(rawCatalog)
    ? rawCatalog
    : Array.isArray(rawCatalog?.products) ? rawCatalog.products : [];

  if (products.length === 0) {
    return c.json({
      error: `Merchant ${merchantRow.name} has no catalog seeded.`,
      code: 'EMPTY_CATALOG',
    }, 400);
  }

  type CartLine = {
    item_id: string;
    name: string;
    quantity: number;
    unit_price: number;
    total_price: number;
    currency: string;
  };

  const cart: CartLine[] = [];
  const unmatched: string[] = [];
  for (const requested of parsed.data.items) {
    // Match on case-insensitive substring of product name
    const product = products.find((p: any) => {
      if (!p?.name || typeof p.name !== 'string') return false;
      return p.name.toLowerCase().includes(requested.name.toLowerCase()) ||
             requested.name.toLowerCase().includes(p.name.toLowerCase());
    });
    if (!product) {
      unmatched.push(requested.name);
      continue;
    }
    const unit = (product.unit_price_cents ?? 0) / 100;
    cart.push({
      item_id: product.id,
      name: product.name,
      quantity: requested.quantity,
      unit_price: unit,
      total_price: unit * requested.quantity,
      currency: product.currency || 'USD',
    });
  }
  if (unmatched.length > 0 || cart.length === 0) {
    return c.json({
      error: `Could not match items in ${merchantRow.name}'s catalog: ${unmatched.join(', ')}`,
      code: 'ITEMS_NOT_FOUND',
      catalog_preview: products.slice(0, 8).map((p: any) => ({
        id: p.id, name: p.name, price_usd: (p.unit_price_cents ?? 0) / 100,
      })),
    }, 400);
  }

  const subtotal = cart.reduce((s, l) => s + l.total_price, 0);
  const total = subtotal;
  const currency = cart[0].currency;

  // ── Step 1: create the ACP checkout (server-side) ───────────────────
  const checkoutId = `buy_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const merchantInvuId = merchantRow.metadata?.invu_merchant_id || merchantRow.id;

  const { createSpendingPolicyService } = await import('../services/spending-policy.js');
  const { createApprovalWorkflowService } = await import('../services/approval-workflow.js');

  const { data: checkout, error: checkoutErr } = await (supabase as any)
    .from('acp_checkouts')
    .insert({
      tenant_id: ctx.tenantId,
      environment: 'test',
      checkout_id: checkoutId,
      agent_id: agentRow.id,
      agent_name: agentRow.name,
      customer_id: ownerProfile.id,
      customer_email: null,
      account_id: agentRow.parent_account_id || merchantRow.id,
      merchant_id: merchantInvuId,
      merchant_account_id: merchantRow.id,
      merchant_name: merchantRow.name,
      subtotal,
      total_amount: total,
      currency,
      checkout_data: { source: 'sly_buy' },
      metadata: { source: 'sly_buy', buyer_user_id: ownerProfile.id },
    })
    .select()
    .single();

  if (checkoutErr || !checkout) {
    console.error('[/v1/buy] checkout insert failed', checkoutErr);
    return c.json({ error: 'Failed to create checkout', details: checkoutErr?.message }, 500);
  }

  await (supabase as any).from('acp_checkout_items').insert(
    cart.map(l => ({
      tenant_id: ctx.tenantId,
      checkout_id: checkout.id,
      item_id: l.item_id,
      name: l.name,
      quantity: l.quantity,
      unit_price: l.unit_price,
      total_price: l.total_price,
      currency: l.currency,
    })),
  );

  // ── Step 2: run policy. If approval required, create approval and
  //    return the magic link for the agent to surface to the user. ────
  // Find the agent's wallet for policy lookup.
  const { data: agentWallet } = await (supabase as any)
    .from('wallets')
    .select('id, spending_policy')
    .eq('managed_by_agent_id', agentRow.id)
    .eq('tenant_id', ctx.tenantId)
    .eq('status', 'active')
    .maybeSingle();

  if (agentWallet?.id) {
    const policy = createSpendingPolicyService(supabase);
    const decision = await policy.checkPolicy(
      agentWallet.id,
      total,
      { protocol: 'acp', merchantId: merchantInvuId, vendor: merchantRow.name } as any,
      (c as any).get('requestId') as string | undefined,
    );

    if (!decision.allowed) {
      if (decision.requiresApproval) {
        const approveToken = mintApproveToken();
        const approvals = createApprovalWorkflowService(supabase);
        const approval = await approvals.createApproval({
          tenantId: ctx.tenantId,
          walletId: agentWallet.id,
          agentId: agentRow.id,
          protocol: 'acp',
          amount: total,
          currency,
          recipient: {
            checkout_id: checkout.checkout_id,
            merchant_id: merchantInvuId,
            merchant_name: merchantRow.name,
          },
          paymentContext: {
            checkout_id: checkout.checkout_id,
            checkout_uuid: checkout.id,
            merchant_id: merchantInvuId,
            merchant_name: merchantRow.name,
            agent_id: agentRow.id,
            items: cart.map(l => ({ name: l.name, quantity: l.quantity, price: l.unit_price })),
            wallet_payment_method_id: card?.id ?? null,
            buyer_user_id: ownerProfile.id,
            approve_token: approveToken,
            reason: decision.reason ?? 'Per-transaction approval threshold exceeded',
          },
          requestedByType: ctx.actorType,
          requestedById: ctx.actorId || 'unknown',
          requestedByName: agentRow.name,
        });

        const cardOnFile = card?.brand && card?.last4
          ? `${card.brand} •••• ${card.last4}`
          : 'card you enter at checkout';
        const reason = decision.reason ?? 'Per-transaction approval threshold exceeded';

        // The approve_url drives the guest-checkout page (works whether
        // or not the buyer has a saved card on file — the page renders
        // Stripe Payment Element directly).
        const approveUrl = `${publicAppUrl(c)}/buy-approve/${approveToken}`;
        // Inline HTML approval card for clients that render mcp-app HTML
        // (ChatGPT Apps SDK, possibly Claude Desktop). The form action
        // depends on whether a card is bound: saved-card path posts to
        // the magic-token approve endpoint; guest path links to the full
        // guest checkout page (so the iframe navigates there on click).
        const approveAction = card
          ? `${publicApiUrl(c)}/v1/buy-approve/${approveToken}`
          : approveUrl;
        const inlineHtml = renderInlineApprovalHtml({
          approveAction,
          merchantName: merchantRow.name,
          total,
          currency,
          items: cart.map(l => ({ name: l.name, quantity: l.quantity, total: l.total_price })),
          cardOnFile,
          agentName: agentRow.name,
          reason,
          expiresAt: approval.expiresAt,
        });

        return c.json({
          status: 'approval_required',
          approval_id: approval.id,
          approve_url: approveUrl,
          approve_action: approveAction,
          inline_ui: inlineHtml,
          merchant: merchantRow.name,
          total,
          currency,
          items: cart.map(l => ({ name: l.name, quantity: l.quantity, total: l.total_price })),
          card_on_file: cardOnFile,
          guest_checkout: !card,
          reason,
          expires_at: approval.expiresAt,
          message:
            `Approval required for ${currency} ${total.toFixed(2)} at ${merchantRow.name}. ` +
            `User taps approve_url to authorize the charge${card ? ` against ${cardOnFile}` : ` — they'll enter a card on the approval page`}.`,
        }, 202);
      }

      return c.json({
        status: 'denied',
        reason: decision.reason ?? 'Hard spending limit exceeded',
        code: 'POLICY_VIOLATION',
        violation_type: decision.violationType,
      }, 403);
    }
  }

  // ── Step 3: under threshold — complete inline. Charge the saved card.
  // Reuse the same internal logic by hitting the ACP completion route.
  // We simulate it inline rather than HTTP-roundtripping. The completion
  // path here is identical to what the approval page does post-approve:
  // mint a Stripe PaymentIntent off_session against the saved PM.
  const { getStripeClient, isStripeConfigured } = await import('../services/stripe/index.js');
  if (!isStripeConfigured()) {
    return c.json({ error: 'Stripe not configured' }, 503);
  }
  const stripe = getStripeClient();
  let pi: any;
  try {
    pi = await stripe.createPaymentIntent({
      amount: Math.round(total * 100),
      currency: (currency === 'USDC' || !currency) ? 'usd' : currency.toLowerCase(),
      customerId: undefined, // resolved server-side via wallet_stripe_customers join below
      paymentMethodId: card.stripe_payment_method_id,
      confirm: true,
      offSession: true,
      description: `Sly checkout: ${merchantRow.name}`,
      metadata: {
        checkout_id: checkout.checkout_id,
        payos_checkout_uuid: checkout.id,
        merchant_id: merchantInvuId,
        agent_id: agentRow.id,
        wallet_payment_method_id: card.id,
        sly_user_id: ownerProfile.id,
        source: 'sly_buy',
      },
      idempotencyKey: `buy-${checkout.id}`,
    });
  } catch (err: any) {
    console.error('[/v1/buy] PaymentIntent failed:', err.message);
    await (supabase as any)
      .from('acp_checkouts')
      .update({ status: 'failed', checkout_data: { stripe_error: err.message } })
      .eq('id', checkout.id);
    return c.json({ error: 'Card charge failed', details: err.message }, 402);
  }

  // Pull the customer id (we set the PaymentMethod's customer when we
  // attached it; Stripe will reject a confirm if missing — re-create with
  // customer in metadata via lookup if we get here without one).
  // Looking up customer for the receipt only (charge already cleared).
  const { data: cust } = await supabase
    .from('wallet_stripe_customers')
    .select('stripe_customer_id')
    .eq('user_id', ownerProfile.id)
    .maybeSingle();

  // Update checkout + create transfer (mirror what acp.ts does on
  // successful card-path completion).
  const { data: transfer } = await (supabase as any)
    .from('transfers')
    .insert({
      tenant_id: ctx.tenantId,
      environment: 'test',
      from_account_id: agentRow.parent_account_id || merchantRow.id,
      to_account_id: merchantRow.id,
      amount: total,
      currency,
      type: 'acp',
      status: 'completed',
      description: `Sly checkout: ${merchantRow.name} (card ${card.brand} ${card.last4})`,
      protocol_metadata: {
        protocol: 'acp',
        source: 'sly_buy',
        checkout_id: checkout.checkout_id,
        merchant_id: merchantInvuId,
        merchant_account_id: merchantRow.id,
        merchant_name: merchantRow.name,
        agent_id: agentRow.id,
        cart_items: cart.map(l => ({ name: l.name, quantity: l.quantity, price: l.unit_price })),
        wallet_payment_method_id: card.id,
        stripe_payment_intent_id: pi.id,
        stripe_customer_id: cust?.stripe_customer_id,
        stripe_payment_method: card.stripe_payment_method_id,
        card_brand: card.brand,
        card_last4: card.last4,
      },
      initiated_by_type: ctx.actorType,
      initiated_by_id: ctx.actorId || 'unknown',
      initiated_by_name: agentRow.name,
    })
    .select()
    .single();

  await (supabase as any)
    .from('acp_checkouts')
    .update({
      status: 'completed',
      transfer_id: transfer?.id || null,
      payment_method: 'card',
      completed_at: new Date().toISOString(),
      checkout_data: {
        source: 'sly_buy',
        stripe_payment_intent_id: pi.id,
        stripe_payment_status: pi.status,
        card_brand: card.brand,
        card_last4: card.last4,
      },
    })
    .eq('id', checkout.id);

  return c.json({
    status: 'completed',
    merchant: merchantRow.name,
    total,
    currency,
    items: cart.map(l => ({ name: l.name, quantity: l.quantity, total: l.total_price })),
    transfer_id: transfer?.id ?? null,
    charge: {
      id: pi.id,
      brand: card.brand,
      last4: card.last4,
    },
    receipt_message:
      `Order placed at ${merchantRow.name}. Charged ${currency} ${total.toFixed(2)} to ${card.brand} •••• ${card.last4}.`,
  });
});

export default app;
