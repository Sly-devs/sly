/**
 * Webhook Delivery Service
 * 
 * Story 27.5: Robust Webhook Delivery System
 * 
 * Features:
 * - HMAC-SHA256 signature verification
 * - Exponential backoff retry (5 attempts over 24h)
 * - Dead letter queue for persistent failures
 * - Event filtering with wildcard support
 * - Circuit breaker for failing endpoints
 * - Event emission from any service
 * 
 * @module services/webhooks
 */

import crypto from 'crypto';
import { createClient } from '../db/client.js';

// ============================================
// Types
// ============================================

export interface WebhookEvent {
  /** Event type (e.g., 'x402.payment.completed', 'transfer.completed') */
  type: string;
  
  /** Unique event ID */
  id: string;
  
  /** ISO timestamp */
  timestamp: string;
  
  /** Event payload */
  data: Record<string, any>;
}

export interface WebhookDeliveryOptions {
  /** Maximum delivery attempts (default: 5) */
  maxAttempts?: number;
  
  /** Idempotency key to prevent duplicates */
  idempotencyKey?: string;
}

// Supported event types for documentation
export const WEBHOOK_EVENT_TYPES = {
  // Transfer events
  'transfer.created': 'A new transfer was created',
  'transfer.completed': 'A transfer was completed successfully',
  'transfer.failed': 'A transfer failed',
  'transfer.refunded': 'A transfer was refunded',
  
  // x402 events
  'x402.payment.completed': 'An x402 payment was processed',
  'x402.endpoint.created': 'A new x402 endpoint was registered',
  'x402.publish.processing': 'An x402 endpoint was submitted to Coinbase Bazaar (CDP returned processing)',
  'x402.publish.published': 'An x402 endpoint was successfully indexed on agentic.market',
  'x402.publish.failed': 'An x402 endpoint failed to index (validation or SLA timeout)',
  'x402.publish.unpublished': 'An x402 endpoint was withdrawn (Sly returns 404; agentic.market listing may persist until pruned)',
  
  // AP2 events
  'ap2.mandate.created': 'A new AP2 mandate was created',
  'ap2.mandate.executed': 'An AP2 mandate was executed',
  'ap2.mandate.revoked': 'An AP2 mandate was revoked',
  
  // ACP events
  'acp.checkout.created': 'A new ACP checkout was created',
  'acp.checkout.completed': 'An ACP checkout was completed',
  'acp.checkout.expired': 'An ACP checkout expired',
  
  // Account events
  'account.created': 'A new account was created',
  'account.updated': 'An account was updated',
  'account.balance.low': 'Account balance fell below threshold',
  
  // Batch events
  'batch.created': 'A new batch was created',
  'batch.processing': 'A batch is being processed',
  'batch.completed': 'A batch was completed',
  'batch.failed': 'A batch failed',
  
  // Reconciliation events
  'reconciliation.completed': 'A reconciliation run completed',
  'reconciliation.discrepancy': 'A discrepancy was detected',
  
  // Settlement events
  'settlement.initiated': 'A settlement was initiated',
  'settlement.completed': 'A settlement completed successfully',
  'settlement.failed': 'A settlement failed',
  
  // Test event
  'webhook.test': 'Test webhook event',
} as const;

export type WebhookEventType = keyof typeof WEBHOOK_EVENT_TYPES;

export interface WebhookEndpoint {
  id: string;
  tenant_id: string;
  url: string;
  name?: string;
  events: string[];
  secret_hash: string;
  status: 'active' | 'disabled' | 'failing';
  consecutive_failures: number;
}

export interface WebhookDelivery {
  id: string;
  tenant_id: string;
  endpoint_id?: string;
  endpoint_url: string;
  event_type: string;
  event_id?: string;
  payload: any;
  signature?: string;
  status: 'pending' | 'processing' | 'delivered' | 'failed' | 'dlq';
  attempts: number;
  max_attempts: number;
  next_retry_at?: string;
  last_response_code?: number;
  last_response_body?: string;
  last_attempt_at?: string;
  dlq_at?: string;
  dlq_reason?: string;
  created_at: string;
  delivered_at?: string;
}

// ============================================
// Constants
// ============================================

/** Retry delays in seconds: 1m, 5m, 15m, 1h, 24h */
const RETRY_DELAYS = [60, 300, 900, 3600, 86400];

/** Webhook timeout in milliseconds */
const WEBHOOK_TIMEOUT_MS = 10000;

/** Maximum response body length to store */
const MAX_RESPONSE_BODY_LENGTH = 1000;

// ============================================
// Webhook Service
// ============================================

export class WebhookService {
  private supabase = createClient();

  /**
   * Queue a webhook for delivery to all subscribed endpoints
   */
  async queueWebhook(
    tenantId: string,
    event: WebhookEvent,
    options?: WebhookDeliveryOptions
  ): Promise<string[]> {
    const { data: deliveryIds, error } = await (this.supabase as any)
      .rpc('queue_webhook_delivery', {
        p_tenant_id: tenantId,
        p_event_type: event.type,
        p_event_id: event.id,
        p_payload: event as any,
        p_idempotency_key: options?.idempotencyKey || null
      });

    if (error) {
      console.error('[WebhookService] Failed to queue webhook:', error);
      throw error;
    }

    return deliveryIds || [];
  }

  /**
   * Process pending webhook deliveries
   * Called by worker process
   */
  async processPendingDeliveries(limit: number = 100): Promise<void> {
    const { data: deliveries, error } = await this.supabase
      .from('webhook_deliveries')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(limit);

    if (error) {
      console.error('[WebhookService] Failed to fetch pending deliveries:', error);
      return;
    }

    if (!deliveries || deliveries.length === 0) {
      return;
    }

    console.log(`[WebhookService] Processing ${deliveries.length} pending deliveries`);

    // Process deliveries in parallel (with concurrency limit)
    const CONCURRENCY = 10;
    for (let i = 0; i < deliveries.length; i += CONCURRENCY) {
      const batch = deliveries.slice(i, i + CONCURRENCY);
      await Promise.allSettled(
        batch.map(delivery => this.deliverWebhook(delivery as any))
      );
    }
  }

  /**
   * Process failed deliveries that are ready for retry
   */
  async processRetries(limit: number = 100): Promise<void> {
    const { data: deliveries, error } = await this.supabase
      .from('webhook_deliveries')
      .select('*')
      .eq('status', 'failed')
      .lte('next_retry_at', new Date().toISOString())
      .lt('attempts', (this.supabase as any).raw?.('max_attempts') ?? 100)
      .order('next_retry_at', { ascending: true })
      .limit(limit);

    if (error) {
      console.error('[WebhookService] Failed to fetch retry deliveries:', error);
      return;
    }

    if (!deliveries || deliveries.length === 0) {
      return;
    }

    console.log(`[WebhookService] Processing ${deliveries.length} retry deliveries`);

    for (const delivery of deliveries) {
      await this.deliverWebhook(delivery as any);
    }
  }

  /**
   * Deliver a single webhook
   */
  private async deliverWebhook(delivery: WebhookDelivery): Promise<void> {
    const startTime = Date.now();

    // Mark as processing
    await this.updateDeliveryStatus(delivery.id, 'processing');

    try {
      // Fetch endpoint secret for signing (if endpoint still exists)
      let secret: string | null = null;
      if (delivery.endpoint_id) {
        const { data: endpoint } = await this.supabase
          .from('webhook_endpoints')
          .select('secret_hash')
          .eq('id', delivery.endpoint_id)
          .single();
        
        secret = endpoint?.secret_hash || null;
      }

      // Generate signature
      const signature = secret 
        ? this.signPayload(delivery.payload, secret)
        : undefined;

      // Make HTTP request
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

      const response = await fetch(delivery.endpoint_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'PayOS-Webhooks/1.0',
          'X-PayOS-Event': delivery.event_type,
          'X-PayOS-Delivery': delivery.id,
          ...(signature && { 'X-PayOS-Signature': signature }),
        },
        body: JSON.stringify(delivery.payload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const responseTime = Date.now() - startTime;
      const responseBody = await response.text();

      if (response.ok) {
        // Success (2xx response)
        await this.markDelivered(
          delivery.id,
          response.status,
          responseBody,
          responseTime
        );

        // Reset failure count on endpoint
        if (delivery.endpoint_id) {
          await this.resetEndpointFailures(delivery.endpoint_id);
        }
      } else {
        // HTTP error
        await this.handleFailure(
          delivery,
          response.status,
          responseBody,
          responseTime
        );
      }
    } catch (error: any) {
      // Network error or timeout
      const responseTime = Date.now() - startTime;
      await this.handleFailure(
        delivery,
        null,
        error.message || 'Network error',
        responseTime
      );
    }
  }

  /**
   * Mark delivery as successfully delivered
   */
  private async markDelivered(
    deliveryId: string,
    responseCode: number,
    responseBody: string,
    responseTime: number
  ): Promise<void> {
    await this.supabase
      .from('webhook_deliveries')
      .update({
        status: 'delivered',
        last_response_code: responseCode,
        last_response_body: responseBody.slice(0, MAX_RESPONSE_BODY_LENGTH),
        last_response_time_ms: responseTime,
        last_attempt_at: new Date().toISOString(),
        delivered_at: new Date().toISOString(),
      })
      .eq('id', deliveryId);

    console.log(`[WebhookService] Delivered webhook ${deliveryId} (${responseCode}, ${responseTime}ms)`);
  }

  /**
   * Handle delivery failure with retry logic
   */
  private async handleFailure(
    delivery: WebhookDelivery,
    responseCode: number | null,
    responseBody: string,
    responseTime: number
  ): Promise<void> {
    const newAttempts = delivery.attempts + 1;
    const maxAttempts = delivery.max_attempts || 5;

    if (newAttempts >= maxAttempts) {
      // Move to dead letter queue
      await this.supabase
        .from('webhook_deliveries')
        .update({
          status: 'dlq',
          attempts: newAttempts,
          last_response_code: responseCode,
          last_response_body: responseBody.slice(0, MAX_RESPONSE_BODY_LENGTH),
          last_response_time_ms: responseTime,
          last_attempt_at: new Date().toISOString(),
          dlq_at: new Date().toISOString(),
          dlq_reason: `Max retries exceeded (${maxAttempts}). Last error: ${responseBody}`,
        })
        .eq('id', delivery.id);

      console.error(`[WebhookService] Webhook ${delivery.id} moved to DLQ after ${newAttempts} attempts`);

      // Mark endpoint as failing
      if (delivery.endpoint_id) {
        await this.incrementEndpointFailures(delivery.endpoint_id);
      }
    } else {
      // Schedule retry with exponential backoff
      const delaySeconds = RETRY_DELAYS[Math.min(newAttempts - 1, RETRY_DELAYS.length - 1)];
      const nextRetryAt = new Date(Date.now() + delaySeconds * 1000).toISOString();

      await this.supabase
        .from('webhook_deliveries')
        .update({
          status: 'failed',
          attempts: newAttempts,
          next_retry_at: nextRetryAt,
          last_response_code: responseCode,
          last_response_body: responseBody.slice(0, MAX_RESPONSE_BODY_LENGTH),
          last_response_time_ms: responseTime,
          last_attempt_at: new Date().toISOString(),
        })
        .eq('id', delivery.id);

      console.warn(
        `[WebhookService] Webhook ${delivery.id} failed (attempt ${newAttempts}/${maxAttempts}). ` +
        `Retry in ${delaySeconds}s. Error: ${responseBody.slice(0, 100)}`
      );
    }
  }

  /**
   * Update delivery status
   */
  private async updateDeliveryStatus(
    deliveryId: string,
    status: WebhookDelivery['status']
  ): Promise<void> {
    await this.supabase
      .from('webhook_deliveries')
      .update({ status })
      .eq('id', deliveryId);
  }

  /**
   * Increment endpoint failure count
   */
  private async incrementEndpointFailures(endpointId: string): Promise<void> {
    const { data: endpoint } = await this.supabase
      .from('webhook_endpoints')
      .select('consecutive_failures')
      .eq('id', endpointId)
      .single();

    if (!endpoint) return;

    const newFailures = (endpoint.consecutive_failures || 0) + 1;
    const updates: any = {
      consecutive_failures: newFailures,
      last_failure_at: new Date().toISOString(),
    };

    // Auto-disable after 10 consecutive failures
    if (newFailures >= 10) {
      updates.status = 'failing';
      console.warn(`[WebhookService] Endpoint ${endpointId} marked as failing after ${newFailures} failures`);
    }

    await this.supabase
      .from('webhook_endpoints')
      .update(updates)
      .eq('id', endpointId);
  }

  /**
   * Reset endpoint failure count on successful delivery
   */
  private async resetEndpointFailures(endpointId: string): Promise<void> {
    await this.supabase
      .from('webhook_endpoints')
      .update({
        consecutive_failures: 0,
        last_success_at: new Date().toISOString(),
        status: 'active',
      })
      .eq('id', endpointId);
  }

  /**
   * Sign webhook payload with HMAC-SHA256
   * Format: "t=timestamp,v1=signature"
   */
  private signPayload(payload: any, secret: string): string {
    const timestamp = Math.floor(Date.now() / 1000);
    const payloadString = `${timestamp}.${JSON.stringify(payload)}`;
    const signature = crypto
      .createHmac('sha256', secret)
      .update(payloadString)
      .digest('hex');
    
    return `t=${timestamp},v1=${signature}`;
  }

  /**
   * Verify webhook signature (for receiving webhooks)
   */
  static verifySignature(
    payload: any,
    signature: string,
    secret: string,
    toleranceSeconds: number = 300
  ): boolean {
    try {
      const parts = signature.split(',');
      const timestamp = parseInt(parts.find(p => p.startsWith('t='))?.slice(2) || '0');
      const receivedSig = parts.find(p => p.startsWith('v1='))?.slice(3);

      if (!timestamp || !receivedSig) {
        return false;
      }

      // Check timestamp tolerance (prevent replay attacks)
      const now = Math.floor(Date.now() / 1000);
      if (Math.abs(now - timestamp) > toleranceSeconds) {
        return false;
      }

      // Verify signature
      const payloadString = `${timestamp}.${JSON.stringify(payload)}`;
      const expectedSig = crypto
        .createHmac('sha256', secret)
        .update(payloadString)
        .digest('hex');

      return crypto.timingSafeEqual(
        Buffer.from(receivedSig),
        Buffer.from(expectedSig)
      );
    } catch {
      return false;
    }
  }

  // ============================================
  // Event Emission Helpers (Story 27.5)
  // ============================================

  /**
   * Emit a webhook event for a transfer
   */
  async emitTransferEvent(
    tenantId: string,
    eventType: 'transfer.created' | 'transfer.completed' | 'transfer.failed' | 'transfer.refunded',
    transfer: Record<string, any>
  ): Promise<string[]> {
    return this.queueWebhook(tenantId, {
      type: eventType,
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      data: {
        transfer_id: transfer.id,
        type: transfer.type,
        status: transfer.status,
        amount: transfer.amount,
        currency: transfer.currency,
        from_account_id: transfer.from_account_id,
        to_account_id: transfer.to_account_id,
        protocol: transfer.protocol,
        completed_at: transfer.completed_at,
      },
    });
  }

  /**
   * Emit a webhook event for a batch operation
   */
  async emitBatchEvent(
    tenantId: string,
    eventType: 'batch.created' | 'batch.processing' | 'batch.completed' | 'batch.failed',
    batch: Record<string, any>
  ): Promise<string[]> {
    return this.queueWebhook(tenantId, {
      type: eventType,
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      data: {
        batch_id: batch.id,
        status: batch.status,
        total_count: batch.total_count,
        success_count: batch.success_count,
        failed_count: batch.failed_count,
        total_amount: batch.total_amount,
        currency: batch.currency,
      },
    });
  }

  /**
   * Emit a webhook event for settlement
   */
  async emitSettlementEvent(
    tenantId: string,
    eventType: 'settlement.initiated' | 'settlement.completed' | 'settlement.failed',
    settlement: Record<string, any>
  ): Promise<string[]> {
    return this.queueWebhook(tenantId, {
      type: eventType,
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      data: {
        settlement_id: settlement.id || settlement.externalId,
        transfer_id: settlement.transferId,
        rail: settlement.rail,
        status: settlement.status,
        amount: settlement.amount,
        currency: settlement.currency,
        fees: settlement.fees,
        estimated_completion: settlement.estimatedCompletionTime,
      },
    });
  }

  /**
   * Emit a webhook event for reconciliation
   */
  async emitReconciliationEvent(
    tenantId: string,
    eventType: 'reconciliation.completed' | 'reconciliation.discrepancy',
    data: Record<string, any>
  ): Promise<string[]> {
    return this.queueWebhook(tenantId, {
      type: eventType,
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      data,
    });
  }

  /**
   * Emit a generic webhook event
   */
  async emit(
    tenantId: string,
    eventType: string,
    data: Record<string, any>,
    options?: WebhookDeliveryOptions
  ): Promise<string[]> {
    return this.queueWebhook(tenantId, {
      type: eventType,
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      data,
    }, options);
  }

  /**
   * Get delivery statistics for a tenant
   */
  async getDeliveryStats(
    tenantId: string,
    hoursBack: number = 24
  ): Promise<{
    total: number;
    delivered: number;
    failed: number;
    dlq: number;
    successRate: number;
  }> {
    const startDate = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();

    const { data, error } = await this.supabase
      .from('webhook_deliveries')
      .select('status')
      .eq('tenant_id', tenantId)
      .gte('created_at', startDate);

    if (error) {
      console.error('[WebhookService] Stats error:', error);
      return { total: 0, delivered: 0, failed: 0, dlq: 0, successRate: 100 };
    }

    const total = data?.length || 0;
    const delivered = data?.filter((d) => d.status === 'delivered').length || 0;
    const failed = data?.filter((d) => d.status === 'failed').length || 0;
    const dlq = data?.filter((d) => d.status === 'dlq').length || 0;
    const successRate = total > 0 ? Math.round((delivered / total) * 10000) / 100 : 100;

    return { total, delivered, failed, dlq, successRate };
  }
}

// ============================================
// Singleton Instance
// ============================================

export const webhookService = new WebhookService();

