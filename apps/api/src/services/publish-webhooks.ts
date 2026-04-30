/**
 * Tenant-facing webhooks for x402 publish state transitions.
 *
 * Maps the internal `X402PublishEventType` to the small subset of
 * webhook event types tenants actually want to be notified about:
 *
 *   - first_settle (with details.extension_responses === 'processing')
 *       → x402.publish.processing  (queued at CDP, awaiting indexing)
 *   - indexed   → x402.publish.published   (visible on agentic.market)
 *   - failed    → x402.publish.failed      (validation rejected or SLA timeout)
 *   - unpublished → x402.publish.unpublished (Sly stopped serving)
 *
 * All other audit events (publish_requested, validated,
 * republish_requested, unpublish_requested, extension_rejected) stay
 * quiet — they're in-flight bookkeeping the tenant doesn't need to act
 * on.
 *
 * Delivery is best-effort and never blocks the publish flow itself: any
 * webhook error is logged and swallowed.
 */
import type { X402PublishEventType } from '@sly/api-client';
import { randomUUID } from 'crypto';

// `webhooks.ts` builds a top-level WebhookService singleton on import,
// which constructs a Supabase client. We lazy-import to keep our own
// module side-effect-free at load time (test fixtures don't always have
// SUPABASE_URL set before module evaluation).
type WebhookEventType = string;
type LazyWebhookService = { queueWebhook: (...args: any[]) => Promise<unknown> };

let webhookServiceSingleton: LazyWebhookService | null = null;
async function getWebhookService(): Promise<LazyWebhookService> {
  if (!webhookServiceSingleton) {
    const mod: any = await import('./webhooks.js');
    webhookServiceSingleton = new mod.WebhookService();
  }
  return webhookServiceSingleton!;
}

/**
 * Translate an internal publish event into a webhook event type, or
 * `null` if this event isn't user-facing.
 */
function mapToWebhookEventType(
  event: X402PublishEventType,
  details: Record<string, unknown>
): WebhookEventType | null {
  if (event === 'indexed') return 'x402.publish.published';
  if (event === 'failed') return 'x402.publish.failed';
  if (event === 'unpublished') return 'x402.publish.unpublished';
  if (event === 'first_settle') {
    // The publish service emits `first_settle` after every CDP settle,
    // including auto-republish triggers. We only care about the
    // `processing` outcome — that's "your endpoint just submitted to
    // Coinbase for indexing." Errored settles already fire `failed`.
    if (details?.extension_responses === 'processing') {
      return 'x402.publish.processing';
    }
  }
  return null;
}

/**
 * Best-effort: queue a tenant webhook for a publish state transition.
 * Errors are logged and swallowed so audit + DB writes still complete.
 */
export async function firePublishWebhook(
  tenantId: string,
  endpointId: string,
  event: X402PublishEventType,
  details: Record<string, unknown>
): Promise<void> {
  const type = mapToWebhookEventType(event, details);
  if (!type) return;

  try {
    const svc = await getWebhookService();
    await svc.queueWebhook(tenantId, {
      type,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      data: {
        endpointId,
        publishEvent: event,
        details,
      },
    });
  } catch (err: any) {
    console.error(
      `[publish-webhooks] queue failed for ${type} on endpoint ${endpointId}:`,
      err?.message || err
    );
  }
}

/** Test-only — reset the singleton. */
export function __resetPublishWebhooksForTests(): void {
  webhookServiceSingleton = null;
}
