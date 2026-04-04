/**
 * UCP Webhook Service
 *
 * Handles UCP webhooks for order status updates from merchants.
 * Supports both HMAC-SHA256 (legacy) and detached JWT (RFC 7797) signatures.
 *
 * @see Story 43.11: UCP Webhook Handler
 * @see https://ucp.dev/specification/webhooks/
 */

import { createHash, createHmac, timingSafeEqual } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  signWebhookPayload,
  verifyWebhookPayload,
  type UCPSigningKey,
} from './signing.js';

// =============================================================================
// Types
// =============================================================================

export interface UCPWebhookEvent {
  id: string;
  type: 'order.created' | 'order.updated' | 'order.cancelled' | 'order.fulfilled';
  created_at: string;
  data: UCPOrderEvent;
}

export interface UCPOrderEvent {
  order_id: string;
  merchant_id: string;
  status: 'pending' | 'confirmed' | 'processing' | 'shipped' | 'delivered' | 'cancelled';
  payment?: {
    handler_id: string;
    settlement_id?: string;
    status: 'pending' | 'completed' | 'failed';
  };
  line_items?: Array<{
    product_id: string;
    quantity: number;
    price: number;
  }>;
  totals?: {
    subtotal: number;
    tax: number;
    shipping: number;
    total: number;
    currency: string;
  };
  shipping?: {
    tracking_number?: string;
    carrier?: string;
    estimated_delivery?: string;
  };
  metadata?: Record<string, unknown>;
}

export interface WebhookDeliveryResult {
  success: boolean;
  statusCode?: number;
  error?: string;
  attempts: number;
}

// =============================================================================
// Webhook Storage (In-memory for PoC)
// =============================================================================

interface StoredWebhook {
  id: string;
  eventId: string;
  eventType: string;
  tenantId: string;
  settlementId?: string;
  payload: UCPWebhookEvent;
  processedAt: Date;
  delivered: boolean;
  deliveredAt?: Date;
  deliveryAttempts: number;
}

const webhookStore = new Map<string, StoredWebhook>();

// =============================================================================
// Signature Verification
// =============================================================================

/**
 * Verify UCP webhook signature
 *
 * UCP webhooks are signed using HMAC-SHA256 with the merchant's signing key.
 * The signature is in the `UCP-Signature` header.
 *
 * @param payload - Raw webhook payload
 * @param signature - UCP-Signature header value
 * @param signingKey - Merchant's signing key
 */
export function verifyWebhookSignature(
  payload: string,
  signature: string,
  signingKey: string
): boolean {
  try {
    // Parse signature header: t=timestamp,v1=signature
    const parts = signature.split(',').reduce(
      (acc, part) => {
        const [key, value] = part.split('=');
        acc[key] = value;
        return acc;
      },
      {} as Record<string, string>
    );

    if (!parts.t || !parts.v1) {
      return false;
    }

    // Check timestamp is within 5 minutes
    const timestamp = parseInt(parts.t, 10);
    const age = Math.abs(Date.now() / 1000 - timestamp);
    if (age > 300) {
      // 5 minutes
      return false;
    }

    // Compute expected signature
    const signedPayload = `${parts.t}.${payload}`;
    const expectedSignature = createHmac('sha256', signingKey)
      .update(signedPayload)
      .digest('hex');

    // Constant-time comparison
    const expectedBuffer = Buffer.from(expectedSignature, 'hex');
    const actualBuffer = Buffer.from(parts.v1, 'hex');

    if (expectedBuffer.length !== actualBuffer.length) {
      return false;
    }

    return timingSafeEqual(expectedBuffer, actualBuffer);
  } catch {
    return false;
  }
}

/**
 * Generate webhook signature for outgoing webhooks (Legacy HMAC)
 */
export function generateWebhookSignature(
  payload: string,
  signingKey: string
): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const signedPayload = `${timestamp}.${payload}`;
  const signature = createHmac('sha256', signingKey)
    .update(signedPayload)
    .digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

// =============================================================================
// Detached JWT Signature (RFC 7797) - UCP Standard
// =============================================================================

/**
 * Generate Request-Signature header for outgoing webhooks
 *
 * This is the UCP-compliant method using detached JWT (RFC 7797).
 * The signature can be verified using the public key from /.well-known/ucp
 *
 * @param payload - Raw webhook payload string
 * @returns The Request-Signature header value (detached JWT)
 */
export function generateRequestSignature(payload: string): string {
  return signWebhookPayload(payload);
}

/**
 * Verify Request-Signature header from incoming webhooks
 *
 * Verifies a detached JWT signature against the merchant's public keys.
 *
 * @param signature - The Request-Signature header value
 * @param payload - The raw webhook body
 * @param signingKeys - Array of valid signing keys (from merchant's /.well-known/ucp)
 * @returns true if signature is valid
 */
export function verifyRequestSignature(
  signature: string,
  payload: string,
  signingKeys: UCPSigningKey[]
): boolean {
  return verifyWebhookPayload(signature, payload, signingKeys);
}

// =============================================================================
// Webhook Processing
// =============================================================================

/**
 * Process incoming UCP webhook
 */
export async function processWebhook(
  tenantId: string,
  event: UCPWebhookEvent,
  supabase: SupabaseClient
): Promise<{ processed: boolean; action?: string }> {
  // Check for duplicate event (idempotency)
  const existingWebhook = Array.from(webhookStore.values()).find(
    (w) => w.eventId === event.id && w.tenantId === tenantId
  );
  if (existingWebhook) {
    return { processed: true, action: 'duplicate_ignored' };
  }

  // Store webhook event
  const webhookId = createHash('sha256')
    .update(`${tenantId}:${event.id}`)
    .digest('hex')
    .slice(0, 32);

  const stored: StoredWebhook = {
    id: webhookId,
    eventId: event.id,
    eventType: event.type,
    tenantId,
    settlementId: event.data.payment?.settlement_id,
    payload: event,
    processedAt: new Date(),
    delivered: false,
    deliveryAttempts: 0,
  };
  webhookStore.set(webhookId, stored);

  // Process based on event type
  let action: string;

  switch (event.type) {
    case 'order.created':
      action = await handleOrderCreated(tenantId, event.data, supabase);
      break;
    case 'order.updated':
      action = await handleOrderUpdated(tenantId, event.data, supabase);
      break;
    case 'order.cancelled':
      action = await handleOrderCancelled(tenantId, event.data, supabase);
      break;
    case 'order.fulfilled':
      action = await handleOrderFulfilled(tenantId, event.data, supabase);
      break;
    default:
      action = 'unknown_event_type';
  }

  return { processed: true, action };
}

/**
 * Handle order.created event
 */
async function handleOrderCreated(
  tenantId: string,
  data: UCPOrderEvent,
  supabase: SupabaseClient
): Promise<string> {
  // Log order creation for settlement tracking
  console.log(
    `[UCP Webhook] Order created: ${data.order_id} for tenant ${tenantId}`
  );

  // If there's a PayOS settlement, link it
  if (data.payment?.handler_id === 'sly_latam' && data.payment.settlement_id) {
    console.log(
      `[UCP Webhook] Linked to settlement: ${data.payment.settlement_id}`
    );
  }

  return 'order_created_logged';
}

/**
 * Handle order.updated event
 */
async function handleOrderUpdated(
  tenantId: string,
  data: UCPOrderEvent,
  supabase: SupabaseClient
): Promise<string> {
  console.log(
    `[UCP Webhook] Order updated: ${data.order_id} status=${data.status}`
  );

  // Track shipping info if provided
  if (data.shipping?.tracking_number) {
    console.log(
      `[UCP Webhook] Tracking: ${data.shipping.carrier} ${data.shipping.tracking_number}`
    );
  }

  return `order_updated_${data.status}`;
}

/**
 * Handle order.cancelled event
 */
async function handleOrderCancelled(
  tenantId: string,
  data: UCPOrderEvent,
  supabase: SupabaseClient
): Promise<string> {
  console.log(`[UCP Webhook] Order cancelled: ${data.order_id}`);

  // If settlement was completed, may need to trigger refund flow
  if (data.payment?.settlement_id && data.payment.status === 'completed') {
    console.log(
      `[UCP Webhook] Settlement ${data.payment.settlement_id} may need refund`
    );
    // In production, would create a refund record or notify
  }

  return 'order_cancelled';
}

/**
 * Handle order.fulfilled event
 */
async function handleOrderFulfilled(
  tenantId: string,
  data: UCPOrderEvent,
  supabase: SupabaseClient
): Promise<string> {
  console.log(
    `[UCP Webhook] Order fulfilled: ${data.order_id} delivered=${data.status === 'delivered'}`
  );

  return 'order_fulfilled';
}

// =============================================================================
// Partner Webhook Forwarding
// =============================================================================

/**
 * Forward webhook to partner endpoint
 *
 * Supports two signature modes:
 * - 'jwt' (default): Uses Request-Signature header with detached JWT (UCP standard)
 * - 'hmac': Uses UCP-Signature header with HMAC-SHA256 (legacy)
 */
export async function forwardWebhookToPartner(
  webhookId: string,
  partnerEndpoint: string,
  partnerSigningKey: string,
  signatureMode: 'jwt' | 'hmac' = 'jwt'
): Promise<WebhookDeliveryResult> {
  const stored = webhookStore.get(webhookId);
  if (!stored) {
    return { success: false, error: 'Webhook not found', attempts: 0 };
  }

  stored.deliveryAttempts++;

  try {
    const payload = JSON.stringify(stored.payload);

    // Build headers based on signature mode
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-PayOS-Webhook-ID': webhookId,
    };

    if (signatureMode === 'jwt') {
      // UCP-compliant detached JWT signature
      headers['Request-Signature'] = generateRequestSignature(payload);
    } else {
      // Legacy HMAC signature
      headers['UCP-Signature'] = generateWebhookSignature(
        payload,
        partnerSigningKey
      );
    }

    const response = await fetch(partnerEndpoint, {
      method: 'POST',
      headers,
      body: payload,
    });

    if (response.ok) {
      stored.delivered = true;
      stored.deliveredAt = new Date();
      webhookStore.set(webhookId, stored);

      return {
        success: true,
        statusCode: response.status,
        attempts: stored.deliveryAttempts,
      };
    }

    return {
      success: false,
      statusCode: response.status,
      error: `HTTP ${response.status}`,
      attempts: stored.deliveryAttempts,
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message,
      attempts: stored.deliveryAttempts,
    };
  }
}

// =============================================================================
// Utilities
// =============================================================================

/**
 * Get webhook by ID
 */
export function getWebhook(webhookId: string): StoredWebhook | undefined {
  return webhookStore.get(webhookId);
}

/**
 * List webhooks for a tenant
 */
export function listWebhooks(
  tenantId: string,
  options: {
    eventType?: string;
    settlementId?: string;
    limit?: number;
    offset?: number;
  } = {}
): { data: StoredWebhook[]; total: number } {
  const { eventType, settlementId, limit = 20, offset = 0 } = options;

  let webhooks = Array.from(webhookStore.values()).filter(
    (w) => w.tenantId === tenantId
  );

  if (eventType) {
    webhooks = webhooks.filter((w) => w.eventType === eventType);
  }
  if (settlementId) {
    webhooks = webhooks.filter((w) => w.settlementId === settlementId);
  }

  // Sort by processed date descending
  webhooks.sort((a, b) => b.processedAt.getTime() - a.processedAt.getTime());

  const total = webhooks.length;
  const paged = webhooks.slice(offset, offset + limit);

  return { data: paged, total };
}

/**
 * Clear webhook store (for testing)
 */
export function clearWebhookStore(): void {
  webhookStore.clear();
}
