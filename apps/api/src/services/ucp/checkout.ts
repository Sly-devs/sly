/**
 * UCP Checkout Service
 *
 * Manages checkout session lifecycle per UCP specification.
 *
 * Operations:
 * - Create checkout session
 * - Update checkout (line items, buyer, addresses, payment)
 * - Complete checkout (process payment, create order)
 * - Cancel checkout
 *
 * @see Story 43.2: Checkout Capability
 * @see https://ucp.dev/specification/checkout/
 */

import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { LimitService } from '../limits.js';
import { getCircleFXService } from '../circle/fx.js';
import type {
  UCPCheckoutSession,
  UCPLineItem,
  UCPTotal,
  UCPBuyer,
  UCPAddress,
  UCPPaymentConfig,
  UCPPaymentInstrument,
  UCPCheckoutMessage,
  UCPLink,
  UCPOrder,
  CreateCheckoutRequest,
  UpdateCheckoutRequest,
  CheckoutStatus,
} from './types.js';
import {
  computeStatus,
  canComplete,
  canModify,
  canCancel,
  isTerminal,
  validateTransition,
  getMissingRequirements,
} from './checkout-status.js';
import {
  createError,
  createWarning,
  addMessage,
  removeMessagesByCode,
  hasBlockingErrors,
  getMessageSummary,
  type UCPMessage,
} from './messages.js';
import { createOrderFromCheckout } from './orders.js';
import { processPayment as handlerProcessPayment, getHandler } from './payment-handlers/index.js';

// =============================================================================
// In-Memory Store (fallback when Supabase not available)
// =============================================================================

interface StoredCheckout {
  id: string;
  tenant_id: string;
  status: CheckoutStatus;
  currency: string;
  line_items: UCPLineItem[];
  totals: UCPTotal[];
  buyer: UCPBuyer | null;
  shipping_address: UCPAddress | null;
  billing_address: UCPAddress | null;
  payment_config: UCPPaymentConfig;
  payment_instruments: UCPPaymentInstrument[];
  selected_instrument_id: string | null;
  messages: UCPCheckoutMessage[];
  continue_url: string | null;
  cancel_url: string | null;
  links: UCPLink[];
  metadata: Record<string, unknown>;
  agent_id: string | null;
  order_id: string | null;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
}

const checkoutStore = new Map<string, StoredCheckout>();

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Generate checkout ID
 */
function generateCheckoutId(): string {
  const random = createHash('sha256')
    .update(`${Date.now()}-${Math.random()}`)
    .digest('hex')
    .slice(0, 24);
  return `chk_${random}`;
}

/**
 * Calculate totals from line items
 */
export function calculateTotals(
  lineItems: UCPLineItem[],
  options: {
    taxRate?: number;
    shippingAmount?: number;
    discountAmount?: number;
  } = {}
): UCPTotal[] {
  const { taxRate = 0, shippingAmount = 0, discountAmount = 0 } = options;

  // Calculate subtotal
  const subtotal = lineItems.reduce((sum, item) => sum + item.total_price, 0);

  // Calculate tax
  const tax = Math.round(subtotal * taxRate);

  // Build totals array
  const totals: UCPTotal[] = [
    { type: 'subtotal', amount: subtotal, label: 'Subtotal' },
  ];

  if (tax > 0) {
    totals.push({ type: 'tax', amount: tax, label: `Tax (${(taxRate * 100).toFixed(0)}%)` });
  }

  if (shippingAmount > 0) {
    totals.push({ type: 'shipping', amount: shippingAmount, label: 'Shipping' });
  }

  if (discountAmount > 0) {
    totals.push({ type: 'discount', amount: -discountAmount, label: 'Discount' });
  }

  // Calculate total
  const total = subtotal + tax + shippingAmount - discountAmount;
  totals.push({ type: 'total', amount: total, label: 'Total' });

  return totals;
}

/**
 * Convert stored checkout to API response
 */
function toCheckoutSession(stored: StoredCheckout): UCPCheckoutSession {
  return {
    id: stored.id,
    tenant_id: stored.tenant_id,
    status: stored.status,
    currency: stored.currency,
    line_items: stored.line_items,
    totals: stored.totals,
    buyer: stored.buyer,
    shipping_address: stored.shipping_address,
    billing_address: stored.billing_address,
    payment_config: stored.payment_config,
    payment_instruments: stored.payment_instruments,
    selected_instrument_id: stored.selected_instrument_id,
    messages: stored.messages,
    continue_url: stored.continue_url,
    cancel_url: stored.cancel_url,
    links: stored.links,
    metadata: stored.metadata,
    agent_id: stored.agent_id,
    order_id: stored.order_id,
    expires_at: stored.expires_at.toISOString(),
    created_at: stored.created_at.toISOString(),
    updated_at: stored.updated_at.toISOString(),
  };
}

/**
 * Validate line items
 */
function validateLineItems(lineItems: UCPLineItem[]): UCPMessage[] {
  const messages: UCPMessage[] = [];

  for (let i = 0; i < lineItems.length; i++) {
    const item = lineItems[i];

    if (!item.id) {
      messages.push(
        createError('ITEM_UNAVAILABLE', `Line item ${i + 1} is missing ID`, {
          path: `$.line_items[${i}].id`,
        })
      );
    }

    if (!item.name) {
      messages.push(
        createError('ITEM_UNAVAILABLE', `Line item ${i + 1} is missing name`, {
          path: `$.line_items[${i}].name`,
        })
      );
    }

    if (item.quantity <= 0) {
      messages.push(
        createError('QUANTITY_EXCEEDED', `Line item ${i + 1} has invalid quantity`, {
          path: `$.line_items[${i}].quantity`,
        })
      );
    }

    if (item.unit_price < 0) {
      messages.push(
        createError('ITEM_UNAVAILABLE', `Line item ${i + 1} has invalid price`, {
          path: `$.line_items[${i}].unit_price`,
        })
      );
    }
  }

  return messages;
}

/**
 * Determine whether shipping is required based on checkout_type metadata
 */
function requiresShipping(metadata: Record<string, unknown>): boolean {
  const checkoutType = metadata.checkout_type as string | undefined;
  if (checkoutType === 'digital' || checkoutType === 'service') {
    return false;
  }
  return true; // default: physical goods require shipping
}

// =============================================================================
// Checkout Operations
// =============================================================================

/**
 * Create a new checkout session
 */
export async function createCheckout(
  tenantId: string,
  request: CreateCheckoutRequest,
  supabase?: SupabaseClient,
  environment: 'test' | 'live' = 'test',
): Promise<UCPCheckoutSession> {
  const id = generateCheckoutId();
  const now = new Date();
  const expiresInHours = request.expires_in_hours || 6;

  // Initialize line items
  const lineItems = request.line_items || [];

  // Calculate totals
  const totals = calculateTotals(lineItems);

  // Default payment config — infer handlers from instruments if not explicit
  const inferredHandlers = (request.payment_instruments || [])
    .map(pi => pi.handler)
    .filter((h): h is string => !!h);
  const defaultHandlers = inferredHandlers.length > 0
    ? [...new Set(inferredHandlers)]
    : ['payos'];
  const paymentConfig: UCPPaymentConfig = {
    handlers: defaultHandlers,
    ...request.payment_config,
  };

  // Initialize messages
  let messages: UCPCheckoutMessage[] = [];

  // Validate line items
  if (lineItems.length > 0) {
    const itemErrors = validateLineItems(lineItems);
    messages = [...messages, ...itemErrors];
  }

  // Handle payment_instruments provided at creation time
  const paymentInstruments: UCPPaymentInstrument[] = (request.payment_instruments || []).map(pi => ({
    ...pi,
    created_at: pi.created_at || now.toISOString(),
  }));
  const selectedInstrumentId = paymentInstruments.length > 0 ? paymentInstruments[0].id : null;

  // Build metadata (include checkout_type if provided)
  const metadata: Record<string, unknown> = { ...request.metadata };
  if (request.checkout_type) {
    metadata.checkout_type = request.checkout_type;
  }

  // Resolve agent_id: explicit param > metadata fallback
  let agentId = request.agent_id || (metadata.agent_id as string) || null;

  // Support agent lookup by name (non-UUID strings resolve to name search)
  if (agentId && supabase) {
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(agentId);

    if (isUUID) {
      const { data: agent, error: agentError } = await supabase
        .from('agents')
        .select('id')
        .eq('id', agentId)
        .eq('tenant_id', tenantId)
        .single();

      if (agentError || !agent) {
        throw new Error(`Agent not found: ${agentId}`);
      }
    } else {
      // Look up agent by name
      const { data: agent, error: agentError } = await supabase
        .from('agents')
        .select('id')
        .eq('tenant_id', tenantId)
        .ilike('name', agentId)
        .limit(1)
        .single();

      if (agentError || !agent) {
        throw new Error(`Agent not found by name: ${agentId}`);
      }
      agentId = agent.id;
    }
  }

  // Create stored checkout
  const stored: StoredCheckout = {
    id,
    tenant_id: tenantId,
    status: 'incomplete',
    currency: request.currency,
    line_items: lineItems,
    totals,
    buyer: request.buyer || null,
    shipping_address: request.shipping_address || null,
    billing_address: request.billing_address || null,
    payment_config: paymentConfig,
    payment_instruments: paymentInstruments,
    selected_instrument_id: selectedInstrumentId,
    messages,
    continue_url: request.continue_url || null,
    cancel_url: request.cancel_url || null,
    links: request.links || [],
    metadata,
    agent_id: agentId,
    order_id: null,
    expires_at: new Date(now.getTime() + expiresInHours * 60 * 60 * 1000),
    created_at: now,
    updated_at: now,
  };

  // Compute initial status (thread shipping requirement)
  stored.status = computeStatus(stored, { requireShipping: requiresShipping(stored.metadata) });

  // Persist to database if supabase provided
  if (supabase) {
    const { data, error } = await supabase.from('ucp_checkout_sessions').insert({
      id,
      tenant_id: tenantId,
      environment,
      status: stored.status,
      currency: stored.currency,
      line_items: stored.line_items,
      totals: stored.totals,
      buyer: stored.buyer,
      shipping_address: stored.shipping_address,
      billing_address: stored.billing_address,
      payment_config: stored.payment_config,
      payment_instruments: stored.payment_instruments,
      selected_instrument_id: stored.selected_instrument_id,
      messages: stored.messages,
      continue_url: stored.continue_url,
      cancel_url: stored.cancel_url,
      links: stored.links,
      metadata: stored.metadata,
      agent_id: stored.agent_id,
      order_id: null,
      expires_at: stored.expires_at.toISOString(),
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    }).select('*').single();

    if (error) {
      console.error('[UCP Checkout] DB insert error:', error);
      throw new Error(`Failed to create checkout: ${error.message}`);
    }

    if (data) {
      console.log(`[UCP Checkout] Created checkout ${id} for tenant ${tenantId}, status=${stored.status} (persisted)`);
      return dbRowToCheckoutSession(data);
    }
  }

  // Fallback: store in-memory (only when no supabase client provided)
  checkoutStore.set(id, stored);

  console.log(`[UCP Checkout] Created checkout ${id} for tenant ${tenantId}, status=${stored.status}`);

  return toCheckoutSession(stored);
}

/**
 * Get checkout by ID
 */
export async function getCheckout(
  tenantId: string,
  checkoutId: string,
  supabase?: SupabaseClient,
  environment: 'test' | 'live' = 'test',
): Promise<UCPCheckoutSession | null> {
  // If supabase client provided, query database
  if (supabase) {
    const { data, error } = await supabase
      .from('ucp_checkout_sessions')
      .select('*')
      .eq('id', checkoutId)
      .eq('tenant_id', tenantId)
      .eq('environment', environment)
      .single();

    if (error || !data) {
      return null;
    }

    return dbRowToCheckoutSession(data);
  }

  // Fallback to in-memory store
  const stored = checkoutStore.get(checkoutId);

  if (!stored) {
    return null;
  }

  // Verify tenant
  if (stored.tenant_id !== tenantId) {
    return null;
  }

  // Check expiration
  if (stored.expires_at < new Date() && !isTerminal(stored.status)) {
    stored.status = 'canceled';
    stored.messages = addMessage(stored.messages, createError(
      'CHECKOUT_EXPIRED',
      'This checkout session has expired'
    ));
    checkoutStore.set(checkoutId, stored);
  }

  return toCheckoutSession(stored);
}

/**
 * Update checkout
 */
export async function updateCheckout(
  tenantId: string,
  checkoutId: string,
  request: UpdateCheckoutRequest,
  supabase?: SupabaseClient,
  environment: 'test' | 'live' = 'test',
): Promise<UCPCheckoutSession> {
  // Try Supabase path first
  if (supabase) {
    const existing = await getCheckout(tenantId, checkoutId, supabase, environment);
    if (!existing) {
      throw new Error('Checkout not found');
    }

    if (!canModify(existing.status)) {
      throw new Error(`Cannot modify checkout in ${existing.status} status`);
    }

    if (new Date(existing.expires_at) < new Date()) {
      throw new Error('Checkout has expired');
    }

    // Build the update payload from existing + request
    const updates: Record<string, any> = {};

    let lineItems = existing.line_items;
    let currentMessages = existing.messages || [];

    if (request.line_items !== undefined) {
      lineItems = request.line_items;
      updates.line_items = request.line_items;
      updates.totals = calculateTotals(request.line_items);

      currentMessages = currentMessages.filter(m => m.code !== 'ITEM_UNAVAILABLE' && m.code !== 'QUANTITY_EXCEEDED');
      const itemErrors = validateLineItems(request.line_items);
      currentMessages = [...currentMessages, ...itemErrors];
    }

    if (request.buyer !== undefined) {
      updates.buyer = request.buyer;
      if (request.buyer?.email) {
        currentMessages = currentMessages.filter(m => m.code !== 'MISSING_EMAIL' && m.code !== 'INVALID_EMAIL');
      }
    }

    if (request.shipping_address !== undefined) {
      updates.shipping_address = request.shipping_address;
      if (request.shipping_address) {
        currentMessages = currentMessages.filter(m => m.code !== 'MISSING_SHIPPING_ADDRESS' && m.code !== 'INVALID_SHIPPING_ADDRESS');
      }
    }

    if (request.billing_address !== undefined) {
      updates.billing_address = request.billing_address;
      if (request.billing_address) {
        currentMessages = currentMessages.filter(m => m.code !== 'MISSING_BILLING_ADDRESS');
      }
    }

    if (request.payment_instruments !== undefined) {
      updates.payment_instruments = request.payment_instruments;
      if (request.payment_instruments.length > 0) {
        currentMessages = currentMessages.filter(m => m.code !== 'MISSING_PAYMENT_METHOD');
      }
    }

    if (request.selected_instrument_id !== undefined) {
      updates.selected_instrument_id = request.selected_instrument_id;
    }

    if (request.continue_url !== undefined) {
      updates.continue_url = request.continue_url;
    }

    if (request.cancel_url !== undefined) {
      updates.cancel_url = request.cancel_url;
    }

    if (request.metadata !== undefined) {
      updates.metadata = { ...(existing.metadata || {}), ...request.metadata };
    }

    updates.messages = currentMessages;

    // Recompute status with merged state
    const merged = {
      status: existing.status,
      line_items: updates.line_items || existing.line_items,
      buyer: updates.buyer !== undefined ? updates.buyer : existing.buyer,
      shipping_address: updates.shipping_address !== undefined ? updates.shipping_address : existing.shipping_address,
      billing_address: updates.billing_address !== undefined ? updates.billing_address : existing.billing_address,
      selected_instrument_id: updates.selected_instrument_id !== undefined ? updates.selected_instrument_id : existing.selected_instrument_id,
      payment_instruments: updates.payment_instruments || existing.payment_instruments,
      messages: currentMessages,
    };
    const mergedMetadata = updates.metadata || existing.metadata || {};
    updates.status = computeStatus(merged as any, { requireShipping: requiresShipping(mergedMetadata) });

    const { data, error } = await supabase
      .from('ucp_checkout_sessions')
      .update(updates)
      .eq('id', checkoutId)
      .eq('tenant_id', tenantId)
      .select('*')
      .single();

    if (error || !data) {
      throw new Error('Failed to update checkout');
    }

    console.log(`[UCP Checkout] Updated checkout ${checkoutId}, status=${data.status} (persisted)`);
    return dbRowToCheckoutSession(data);
  }

  // Fallback: in-memory path
  const stored = checkoutStore.get(checkoutId);

  if (!stored) {
    throw new Error('Checkout not found');
  }

  if (stored.tenant_id !== tenantId) {
    throw new Error('Checkout not found');
  }

  if (!canModify(stored.status)) {
    throw new Error(`Cannot modify checkout in ${stored.status} status`);
  }

  // Check expiration
  if (stored.expires_at < new Date()) {
    throw new Error('Checkout has expired');
  }

  // Update fields
  if (request.line_items !== undefined) {
    stored.line_items = request.line_items;
    stored.totals = calculateTotals(request.line_items);

    // Re-validate line items
    stored.messages = removeMessagesByCode(stored.messages, 'ITEM_UNAVAILABLE');
    stored.messages = removeMessagesByCode(stored.messages, 'QUANTITY_EXCEEDED');
    const itemErrors = validateLineItems(request.line_items);
    stored.messages = [...stored.messages, ...itemErrors];
  }

  if (request.buyer !== undefined) {
    stored.buyer = request.buyer;
    // Clear email errors if email is now provided
    if (request.buyer?.email) {
      stored.messages = removeMessagesByCode(stored.messages, 'MISSING_EMAIL');
      stored.messages = removeMessagesByCode(stored.messages, 'INVALID_EMAIL');
    }
  }

  if (request.shipping_address !== undefined) {
    stored.shipping_address = request.shipping_address;
    if (request.shipping_address) {
      stored.messages = removeMessagesByCode(stored.messages, 'MISSING_SHIPPING_ADDRESS');
      stored.messages = removeMessagesByCode(stored.messages, 'INVALID_SHIPPING_ADDRESS');
    }
  }

  if (request.billing_address !== undefined) {
    stored.billing_address = request.billing_address;
    if (request.billing_address) {
      stored.messages = removeMessagesByCode(stored.messages, 'MISSING_BILLING_ADDRESS');
    }
  }

  if (request.payment_instruments !== undefined) {
    stored.payment_instruments = request.payment_instruments;
    if (request.payment_instruments.length > 0) {
      stored.messages = removeMessagesByCode(stored.messages, 'MISSING_PAYMENT_METHOD');
    }
  }

  if (request.selected_instrument_id !== undefined) {
    stored.selected_instrument_id = request.selected_instrument_id;
  }

  if (request.continue_url !== undefined) {
    stored.continue_url = request.continue_url;
  }

  if (request.cancel_url !== undefined) {
    stored.cancel_url = request.cancel_url;
  }

  if (request.metadata !== undefined) {
    stored.metadata = { ...stored.metadata, ...request.metadata };
  }

  // Recompute status
  stored.status = computeStatus(stored, { requireShipping: requiresShipping(stored.metadata) });
  stored.updated_at = new Date();

  checkoutStore.set(checkoutId, stored);

  console.log(`[UCP Checkout] Updated checkout ${checkoutId}, status=${stored.status}`);

  return toCheckoutSession(stored);
}

/**
 * Complete checkout - process payment and create order
 */
export async function completeCheckout(
  tenantId: string,
  checkoutId: string,
  supabase?: SupabaseClient,
  environment: 'test' | 'live' = 'test',
): Promise<UCPCheckoutSession> {
  // Try Supabase path first
  if (supabase) {
    const existing = await getCheckout(tenantId, checkoutId, supabase, environment);
    if (!existing) {
      throw new Error('Checkout not found');
    }

    // Recompute status from actual state (in case stored status is stale/null)
    const actualStatus = existing.status || computeStatus(existing as any, { requireShipping: requiresShipping(existing.metadata || {}) });
    if (!canComplete(actualStatus)) {
      const missing = getMissingRequirements(existing as any, { requireShipping: requiresShipping(existing.metadata || {}) });
      if (missing.length > 0) {
        throw new Error(`Cannot complete checkout: missing ${missing.join(', ')}`);
      }
      throw new Error(`Cannot complete checkout in ${actualStatus} status`);
    }

    if (hasBlockingErrors(existing.messages)) {
      const summary = getMessageSummary(existing.messages);
      throw new Error(`Cannot complete checkout: ${summary.blocking} blocking error(s)`);
    }

    const transition = validateTransition(existing.status, 'complete_in_progress');
    if (!transition.allowed) {
      throw new Error(transition.reason || 'Invalid status transition');
    }

    // Transition to complete_in_progress
    await supabase
      .from('ucp_checkout_sessions')
      .update({ status: 'complete_in_progress' })
      .eq('id', checkoutId)
      .eq('tenant_id', tenantId);

    console.log(`[UCP Checkout] Starting completion for checkout ${checkoutId}`);

    try {
      // Get total amount
      const totalLine = (existing.totals || []).find(t => t.type === 'total');
      const totalAmount = totalLine?.amount || 0;

      // Pre-validate mandate budget BEFORE processing payment
      const mandateId = existing.metadata?.mandate_id as string | undefined;
      let resolvedMandate: any = null;
      if (mandateId && supabase) {
        const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const col = UUID_RE.test(mandateId) ? 'id' : 'mandate_id';
        const { data: mandate } = await supabase
          .from('ap2_mandates')
          .select('*')
          .eq('tenant_id', tenantId)
          .eq(col, mandateId)
          .single();

        if (mandate && mandate.status === 'active') {
          const remaining = Number(mandate.authorized_amount) - Number(mandate.used_amount || 0);
          const amountInDollars = totalAmount / 100;
          if (remaining < amountInDollars) {
            throw new Error(
              `Mandate budget exceeded: $${remaining.toFixed(2)} remaining, $${amountInDollars.toFixed(2)} required. ` +
              `Increase the mandate authorized_amount or create a new mandate.`
            );
          }
          resolvedMandate = mandate;
        }
      }

      // Determine handler and instrument
      // Prefer handler from selected instrument, fall back to payment_config
      const instrumentId = existing.selected_instrument_id || undefined;
      let handlerId = existing.payment_config?.handlers?.[0] || 'payos_latam';
      if (instrumentId && existing.payment_instruments) {
        const selectedInstrument = existing.payment_instruments.find(
          (pi: any) => pi.id === instrumentId
        );
        if (selectedInstrument?.handler) {
          handlerId = selectedInstrument.handler;
        }
      }

      // Call payment handler to process payment
      let paymentStatus: 'completed' | 'pending' | 'failed' = 'completed';
      let settlementId: string | undefined;
      let paymentId: string | undefined;

      const handler = getHandler(handlerId);
      if (handler && instrumentId) {
        console.log(`[UCP Checkout] Processing payment via handler "${handlerId}" for ${totalAmount} ${existing.currency}`);
        const paymentResult = await handlerProcessPayment(handlerId, {
          instrumentId,
          amount: totalAmount,
          currency: existing.currency,
          idempotencyKey: `checkout_${checkoutId}`,
          metadata: { tenantId, checkoutId },
        });

        if (!paymentResult.success) {
          const errMsg = paymentResult.error?.message || 'Payment processing failed';
          console.error(`[UCP Checkout] Payment failed for ${checkoutId}: ${errMsg}`);
          throw new Error(`Payment failed: ${errMsg}`);
        }

        paymentStatus = paymentResult.payment?.status === 'succeeded' ? 'completed' : 'pending';
        settlementId = paymentResult.payment?.settlementId;
        paymentId = paymentResult.payment?.id;
        console.log(`[UCP Checkout] Payment ${paymentId} ${paymentStatus} via ${handlerId}`);
      } else {
        console.log(`[UCP Checkout] No handler or instrument for checkout ${checkoutId}, auto-completing payment`);
      }

      // Record mandate execution (budget was already validated before payment)
      if (resolvedMandate && supabase) {
        const amountInDollars = totalAmount / 100;
        const newExecIndex = (resolvedMandate.execution_count || 0) + 1;
        const { error: execError } = await supabase
          .from('ap2_mandate_executions')
          .insert({
            tenant_id: tenantId,
            environment,
            mandate_id: resolvedMandate.id,
            execution_index: newExecIndex,
            amount: amountInDollars,
            currency: existing.currency || resolvedMandate.currency,
            status: 'completed',
            completed_at: new Date().toISOString(),
            order_ids: [checkoutId],
          });

        if (execError) {
          console.error(`[UCP Checkout] Failed to record mandate execution:`, execError.message);
        } else {
          const remaining = Number(resolvedMandate.authorized_amount) - Number(resolvedMandate.used_amount || 0) - amountInDollars;
          console.log(`[UCP Checkout] Mandate ${mandateId} executed: -$${amountInDollars}, remaining: $${remaining.toFixed(2)}`);
        }
      }

      // Deduct from wallet if one is associated
      const walletId = existing.metadata?.wallet_id as string | undefined;
      if (walletId && supabase) {
        try {
          const { data: wallet } = await supabase
            .from('wallets')
            .select('id, balance, currency, owner_account_id, status')
            .eq('id', walletId)
            .eq('tenant_id', tenantId)
            .single();

          if (wallet && wallet.status === 'active') {
            const currentBalance = parseFloat(wallet.balance);
            const amountInDollars = totalAmount / 100;
            if (currentBalance >= amountInDollars) {
              const newBalance = currentBalance - amountInDollars;
              const newStatus = newBalance === 0 ? 'depleted' : 'active';

              const { error: walletError } = await supabase
                .from('wallets')
                .update({
                  balance: newBalance,
                  status: newStatus,
                  updated_at: new Date().toISOString(),
                })
                .eq('id', walletId)
                .eq('tenant_id', tenantId);

              if (!walletError) {
                console.log(`[UCP Checkout] Wallet ${walletId} deducted: -$${amountInDollars}, new balance: $${newBalance}`);

                // Create transfer record for audit trail
                await supabase
                  .from('transfers')
                  .insert({
                    tenant_id: tenantId,
                    environment,
                    from_account_id: wallet.owner_account_id,
                    to_account_id: wallet.owner_account_id,
                    amount: amountInDollars,
                    currency: wallet.currency || existing.currency,
                    type: 'internal',
                    status: 'completed',
                    description: `UCP checkout ${checkoutId} payment`,
                    protocol_metadata: {
                      protocol: 'ucp',
                      wallet_id: walletId,
                      operation: 'checkout_payment',
                      checkout_id: checkoutId,
                    },
                  });
              } else {
                console.error(`[UCP Checkout] Failed to deduct wallet ${walletId}:`, walletError.message);
              }
            } else {
              console.warn(`[UCP Checkout] Wallet ${walletId} insufficient balance: $${currentBalance} < $${amountInDollars}`);
            }
          }
        } catch (walletErr: any) {
          // Non-fatal: log but don't fail the checkout
          console.error(`[UCP Checkout] Wallet deduction error for ${walletId}:`, walletErr.message);
        }
      }

      // Create order in ucp_orders table
      const order = await createOrderFromCheckout(tenantId, existing, {
        handler_id: handlerId,
        instrument_id: instrumentId,
        status: paymentStatus,
        settlement_id: settlementId,
        amount: totalAmount,
        currency: existing.currency,
      }, supabase);

      // Mark checkout as completed with order_id
      const { data, error } = await supabase
        .from('ucp_checkout_sessions')
        .update({ status: 'completed', order_id: order.id })
        .eq('id', checkoutId)
        .eq('tenant_id', tenantId)
        .select('*')
        .single();

      if (error || !data) {
        // Revert to ready_for_complete on failure
        await supabase
          .from('ucp_checkout_sessions')
          .update({ status: 'ready_for_complete' })
          .eq('id', checkoutId)
          .eq('tenant_id', tenantId);
        throw new Error('Failed to complete checkout');
      }

      console.log(`[UCP Checkout] Checkout ${checkoutId} completed, order ${order.id} created (persisted)`);

      // Increment agent attribution counters if agent_id is set
      const agentId = existing.agent_id || (existing.metadata?.agent_id as string | undefined);
      if (agentId && supabase) {
        // Convert from minor units to major units, then to USD if non-USD currency
        const majorUnits = totalAmount / 100;
        const currency = existing.currency?.toUpperCase() || 'USD';
        let usdAmount = majorUnits;
        if (currency !== 'USD' && currency !== 'USDC') {
          try {
            const fxService = getCircleFXService();
            usdAmount = fxService.toUSD(majorUnits, currency);
            console.log(`[UCP Checkout] FX conversion: ${majorUnits} ${currency} → $${usdAmount} USD`);
          } catch (fxErr: any) {
            console.error(`[UCP Checkout] FX conversion failed for ${currency}, using raw amount:`, fxErr.message);
          }
        }
        try {
          await supabase.rpc('increment_agent_counters', {
            p_agent_id: agentId,
            p_volume: usdAmount,
          });
          console.log(`[UCP Checkout] Incremented agent ${agentId} counters: +$${usdAmount} volume, +1 txn`);

          // Record daily/monthly usage for limit tracking
          const limitService = new LimitService(supabase, environment);
          await limitService.recordUsage(agentId, usdAmount);
          console.log(`[UCP Checkout] Recorded agent ${agentId} daily usage: +$${usdAmount}`);
        } catch (agentErr: any) {
          // Non-fatal: log but don't fail the checkout
          console.error(`[UCP Checkout] Failed to increment agent counters for ${agentId}:`, agentErr.message);
        }
      }

      return dbRowToCheckoutSession(data);
    } catch (err: any) {
      // Revert to ready_for_complete on any failure
      await supabase
        .from('ucp_checkout_sessions')
        .update({ status: 'ready_for_complete' })
        .eq('id', checkoutId)
        .eq('tenant_id', tenantId);
      throw err;
    }
  }

  // Fallback: in-memory path
  const stored = checkoutStore.get(checkoutId);

  if (!stored) {
    throw new Error('Checkout not found');
  }

  if (stored.tenant_id !== tenantId) {
    throw new Error('Checkout not found');
  }

  if (!canComplete(stored.status)) {
    // Check what's missing
    const missing = getMissingRequirements(stored, { requireShipping: requiresShipping(stored.metadata) });
    if (missing.length > 0) {
      throw new Error(`Cannot complete checkout: missing ${missing.join(', ')}`);
    }
    throw new Error(`Cannot complete checkout in ${stored.status} status`);
  }

  // Check for blocking errors
  if (hasBlockingErrors(stored.messages)) {
    const summary = getMessageSummary(stored.messages);
    throw new Error(`Cannot complete checkout: ${summary.blocking} blocking error(s)`);
  }

  // Transition to complete_in_progress
  const transition = validateTransition(stored.status, 'complete_in_progress');
  if (!transition.allowed) {
    throw new Error(transition.reason || 'Invalid status transition');
  }

  stored.status = 'complete_in_progress';
  stored.updated_at = new Date();
  checkoutStore.set(checkoutId, stored);

  console.log(`[UCP Checkout] Starting completion for checkout ${checkoutId}`);

  // Simulate payment processing (in production, this would call the payment handler)
  try {
    // Create order
    const orderId = `ord_${createHash('sha256')
      .update(`${checkoutId}-${Date.now()}`)
      .digest('hex')
      .slice(0, 24)}`;

    // Get total amount
    const totalLine = stored.totals.find(t => t.type === 'total');
    const totalAmount = totalLine?.amount || 0;

    // Mark as completed
    stored.status = 'completed';
    stored.order_id = orderId;
    stored.updated_at = new Date();

    console.log(`[UCP Checkout] Checkout ${checkoutId} completed, order ${orderId} created`);

    checkoutStore.set(checkoutId, stored);

    return toCheckoutSession(stored);
  } catch (error: any) {
    // Payment failed - return to ready_for_complete
    stored.status = 'ready_for_complete';
    stored.messages = addMessage(stored.messages, createError(
      'PAYMENT_DECLINED',
      error.message || 'Payment processing failed'
    ));
    stored.updated_at = new Date();
    checkoutStore.set(checkoutId, stored);

    throw new Error(`Payment failed: ${error.message}`);
  }
}

/**
 * Cancel checkout
 */
export async function cancelCheckout(
  tenantId: string,
  checkoutId: string,
  supabase?: SupabaseClient,
  environment: 'test' | 'live' = 'test',
): Promise<UCPCheckoutSession> {
  // Try Supabase path first
  if (supabase) {
    const existing = await getCheckout(tenantId, checkoutId, supabase, environment);
    if (!existing) {
      throw new Error('Checkout not found');
    }

    if (!canCancel(existing.status)) {
      throw new Error(`Cannot cancel checkout in ${existing.status} status`);
    }

    const { data, error } = await supabase
      .from('ucp_checkout_sessions')
      .update({ status: 'canceled' })
      .eq('id', checkoutId)
      .eq('tenant_id', tenantId)
      .select('*')
      .single();

    if (error || !data) {
      throw new Error('Failed to cancel checkout');
    }

    console.log(`[UCP Checkout] Checkout ${checkoutId} canceled (persisted)`);
    return dbRowToCheckoutSession(data);
  }

  // Fallback: in-memory path
  const stored = checkoutStore.get(checkoutId);

  if (!stored) {
    throw new Error('Checkout not found');
  }

  if (stored.tenant_id !== tenantId) {
    throw new Error('Checkout not found');
  }

  if (!canCancel(stored.status)) {
    throw new Error(`Cannot cancel checkout in ${stored.status} status`);
  }

  stored.status = 'canceled';
  stored.updated_at = new Date();
  checkoutStore.set(checkoutId, stored);

  console.log(`[UCP Checkout] Checkout ${checkoutId} canceled`);

  return toCheckoutSession(stored);
}

// =============================================================================
// List & Query Operations
// =============================================================================

/**
 * List checkouts for a tenant
 */
export async function listCheckouts(
  tenantId: string,
  options: {
    status?: CheckoutStatus;
    agent_id?: string;
    limit?: number;
    offset?: number;
  } = {},
  supabase?: SupabaseClient,
  environment: 'test' | 'live' = 'test',
): Promise<{ data: UCPCheckoutSession[]; total: number }> {
  const { status, agent_id, limit = 20, offset = 0 } = options;

  // If supabase client provided, query database
  if (supabase) {
    let query = supabase
      .from('ucp_checkout_sessions')
      .select('*', { count: 'exact' })
      .eq('tenant_id', tenantId)
      .eq('environment', environment)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) {
      query = query.eq('status', status);
    }

    if (agent_id) {
      query = query.eq('agent_id', agent_id);
    }

    const { data, error, count } = await query;

    if (error) {
      console.error('[UCP Checkout] List error:', error);
      throw new Error('Failed to list checkouts');
    }

    return {
      data: (data || []).map(dbRowToCheckoutSession),
      total: count || 0,
    };
  }

  // Fallback to in-memory store
  let checkouts = Array.from(checkoutStore.values())
    .filter(c => c.tenant_id === tenantId);

  if (status) {
    checkouts = checkouts.filter(c => c.status === status);
  }

  // Sort by created date descending
  checkouts.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());

  const total = checkouts.length;
  const paged = checkouts.slice(offset, offset + limit);

  return {
    data: paged.map(toCheckoutSession),
    total,
  };
}

/**
 * Convert database row to UCPCheckoutSession
 */
function dbRowToCheckoutSession(row: any): UCPCheckoutSession {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    status: row.status,
    currency: row.currency,
    line_items: row.line_items || [],
    totals: row.totals || [],
    buyer: row.buyer,
    shipping_address: row.shipping_address,
    billing_address: row.billing_address,
    payment_config: row.payment_config || { handlers: [] },
    payment_instruments: row.payment_instruments || [],
    selected_instrument_id: row.selected_instrument_id,
    messages: row.messages || [],
    continue_url: row.continue_url,
    cancel_url: row.cancel_url,
    links: row.links || [],
    metadata: row.metadata || {},
    agent_id: row.agent_id || null,
    order_id: row.order_id,
    expires_at: row.expires_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// =============================================================================
// Payment Instrument Operations
// =============================================================================

/**
 * Add payment instrument to checkout
 */
export async function addPaymentInstrument(
  tenantId: string,
  checkoutId: string,
  instrument: Omit<UCPPaymentInstrument, 'created_at'>,
  supabase?: SupabaseClient,
  environment: 'test' | 'live' = 'test',
): Promise<UCPCheckoutSession> {
  // Try Supabase path first
  if (supabase) {
    const existing = await getCheckout(tenantId, checkoutId, supabase, environment);
    if (!existing) {
      throw new Error('Checkout not found');
    }

    if (!canModify(existing.status)) {
      throw new Error(`Cannot modify checkout in ${existing.status} status`);
    }

    const fullInstrument: UCPPaymentInstrument = {
      ...instrument,
      created_at: new Date().toISOString(),
    };

    const updatedInstruments = [...(existing.payment_instruments || []), fullInstrument];
    const selectedId = updatedInstruments.length === 1 ? instrument.id : existing.selected_instrument_id;
    const updatedMessages = (existing.messages || []).filter(m => m.code !== 'MISSING_PAYMENT_METHOD');

    // Recompute status
    const merged = {
      status: existing.status,
      line_items: existing.line_items,
      buyer: existing.buyer,
      shipping_address: existing.shipping_address,
      billing_address: existing.billing_address,
      selected_instrument_id: selectedId,
      payment_instruments: updatedInstruments,
      messages: updatedMessages,
    };
    const newStatus = computeStatus(merged as any, { requireShipping: requiresShipping(existing.metadata || {}) });

    const { data, error } = await supabase
      .from('ucp_checkout_sessions')
      .update({
        payment_instruments: updatedInstruments,
        selected_instrument_id: selectedId,
        messages: updatedMessages,
        status: newStatus,
      })
      .eq('id', checkoutId)
      .eq('tenant_id', tenantId)
      .select('*')
      .single();

    if (error || !data) {
      throw new Error('Failed to add payment instrument');
    }

    console.log(`[UCP Checkout] Added payment instrument ${instrument.id} to checkout ${checkoutId} (persisted)`);
    return dbRowToCheckoutSession(data);
  }

  // Fallback: in-memory path
  const stored = checkoutStore.get(checkoutId);

  if (!stored) {
    throw new Error('Checkout not found');
  }

  if (stored.tenant_id !== tenantId) {
    throw new Error('Checkout not found');
  }

  if (!canModify(stored.status)) {
    throw new Error(`Cannot modify checkout in ${stored.status} status`);
  }

  const fullInstrument: UCPPaymentInstrument = {
    ...instrument,
    created_at: new Date().toISOString(),
  };

  stored.payment_instruments.push(fullInstrument);

  // Auto-select if first instrument
  if (stored.payment_instruments.length === 1) {
    stored.selected_instrument_id = instrument.id;
  }

  // Clear payment method errors
  stored.messages = removeMessagesByCode(stored.messages, 'MISSING_PAYMENT_METHOD');

  // Recompute status
  stored.status = computeStatus(stored, { requireShipping: requiresShipping(stored.metadata) });
  stored.updated_at = new Date();

  checkoutStore.set(checkoutId, stored);

  console.log(`[UCP Checkout] Added payment instrument ${instrument.id} to checkout ${checkoutId}`);

  return toCheckoutSession(stored);
}

/**
 * Select payment instrument
 */
export async function selectPaymentInstrument(
  tenantId: string,
  checkoutId: string,
  instrumentId: string,
  supabase?: SupabaseClient,
  environment: 'test' | 'live' = 'test',
): Promise<UCPCheckoutSession> {
  // Try Supabase path first
  if (supabase) {
    const existing = await getCheckout(tenantId, checkoutId, supabase, environment);
    if (!existing) {
      throw new Error('Checkout not found');
    }

    if (!canModify(existing.status)) {
      throw new Error(`Cannot modify checkout in ${existing.status} status`);
    }

    const instrument = (existing.payment_instruments || []).find(i => i.id === instrumentId);
    if (!instrument) {
      throw new Error('Payment instrument not found');
    }

    // Recompute status
    const merged = {
      status: existing.status,
      line_items: existing.line_items,
      buyer: existing.buyer,
      shipping_address: existing.shipping_address,
      billing_address: existing.billing_address,
      selected_instrument_id: instrumentId,
      payment_instruments: existing.payment_instruments,
      messages: existing.messages,
    };
    const newStatus = computeStatus(merged as any, { requireShipping: requiresShipping(existing.metadata || {}) });

    const { data, error } = await supabase
      .from('ucp_checkout_sessions')
      .update({
        selected_instrument_id: instrumentId,
        status: newStatus,
      })
      .eq('id', checkoutId)
      .eq('tenant_id', tenantId)
      .select('*')
      .single();

    if (error || !data) {
      throw new Error('Failed to select payment instrument');
    }

    return dbRowToCheckoutSession(data);
  }

  // Fallback: in-memory path
  const stored = checkoutStore.get(checkoutId);

  if (!stored) {
    throw new Error('Checkout not found');
  }

  if (stored.tenant_id !== tenantId) {
    throw new Error('Checkout not found');
  }

  if (!canModify(stored.status)) {
    throw new Error(`Cannot modify checkout in ${stored.status} status`);
  }

  const instrument = stored.payment_instruments.find(i => i.id === instrumentId);
  if (!instrument) {
    throw new Error('Payment instrument not found');
  }

  stored.selected_instrument_id = instrumentId;
  stored.status = computeStatus(stored, { requireShipping: requiresShipping(stored.metadata) });
  stored.updated_at = new Date();

  checkoutStore.set(checkoutId, stored);

  return toCheckoutSession(stored);
}

// =============================================================================
// Utilities
// =============================================================================

/**
 * Delete a checkout (sandbox/development only)
 * Removes from both in-memory store and database.
 */
export async function deleteCheckout(
  tenantId: string,
  checkoutId: string,
  supabase?: SupabaseClient
): Promise<boolean> {
  // Remove from in-memory store
  const stored = checkoutStore.get(checkoutId);
  if (stored && stored.tenant_id === tenantId) {
    checkoutStore.delete(checkoutId);
  }

  // Remove from database if supabase provided
  if (supabase) {
    // 1. Break circular FK: session.order_id → ucp_orders
    await supabase.from('ucp_checkout_sessions').update({ order_id: null }).eq('id', checkoutId).eq('tenant_id', tenantId);

    // 2. Delete associated orders (ucp_orders.checkout_id → session)
    await supabase.from('ucp_orders').delete().eq('checkout_id', checkoutId).eq('tenant_id', tenantId);

    // 3. Delete the session
    const { error } = await supabase
      .from('ucp_checkout_sessions')
      .delete()
      .eq('id', checkoutId)
      .eq('tenant_id', tenantId);

    if (error) {
      console.error('[UCP Checkout] Delete error:', error);
      return false;
    }
  }

  console.log(`[UCP Checkout] Deleted checkout ${checkoutId}`);
  return true;
}

/**
 * Clear checkout store (for testing)
 */
export function clearCheckoutStore(): void {
  checkoutStore.clear();
}

/**
 * Get checkout count (for testing)
 */
export function getCheckoutCount(): number {
  return checkoutStore.size;
}
