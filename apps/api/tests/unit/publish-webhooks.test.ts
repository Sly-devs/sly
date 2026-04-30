/**
 * Tests for the publish-event → tenant-webhook bridge.
 *
 * Pin two facts:
 *  1. `firePublishWebhook` calls `WebhookService.queueWebhook` with the
 *     correct mapped event type for user-facing transitions only.
 *  2. Internal/in-flight events (publish_requested, validated, etc.)
 *     do NOT fire a webhook.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const queueWebhookMock = vi.fn(async () => ['delivery-id']);
vi.mock('../../src/services/webhooks.js', () => ({
  WebhookService: class {
    queueWebhook = queueWebhookMock;
  },
}));

const { firePublishWebhook, __resetPublishWebhooksForTests } = await import(
  '../../src/services/publish-webhooks.js'
);

describe('firePublishWebhook', () => {
  beforeEach(() => {
    queueWebhookMock.mockClear();
    __resetPublishWebhooksForTests();
  });

  it('fires x402.publish.published for an `indexed` event', async () => {
    await firePublishWebhook('tenant-1', 'ep-1', 'indexed', {
      catalog_service_id: 'api-getsly-ai',
    });
    expect(queueWebhookMock).toHaveBeenCalledTimes(1);
    const [tenantId, event] = queueWebhookMock.mock.calls[0]!;
    expect(tenantId).toBe('tenant-1');
    expect(event.type).toBe('x402.publish.published');
    expect(event.data.endpointId).toBe('ep-1');
    expect(event.data.publishEvent).toBe('indexed');
  });

  it('fires x402.publish.failed for a `failed` event', async () => {
    await firePublishWebhook('tenant-2', 'ep-2', 'failed', {
      reason: 'not_indexed_within_sla',
    });
    expect(queueWebhookMock).toHaveBeenCalledTimes(1);
    expect(queueWebhookMock.mock.calls[0]![1].type).toBe('x402.publish.failed');
  });

  it('fires x402.publish.unpublished for an `unpublished` event', async () => {
    await firePublishWebhook('tenant-3', 'ep-3', 'unpublished', {});
    expect(queueWebhookMock).toHaveBeenCalledTimes(1);
    expect(queueWebhookMock.mock.calls[0]![1].type).toBe(
      'x402.publish.unpublished',
    );
  });

  it('fires x402.publish.processing for first_settle WITH extension_responses=processing', async () => {
    await firePublishWebhook('tenant-4', 'ep-4', 'first_settle', {
      extension_responses: 'processing',
    });
    expect(queueWebhookMock).toHaveBeenCalledTimes(1);
    expect(queueWebhookMock.mock.calls[0]![1].type).toBe(
      'x402.publish.processing',
    );
  });

  it('does NOT fire for first_settle without extension_responses=processing', async () => {
    await firePublishWebhook('tenant-5', 'ep-5', 'first_settle', {
      extension_responses: 'rejected',
    });
    await firePublishWebhook('tenant-5', 'ep-5', 'first_settle', {});
    expect(queueWebhookMock).not.toHaveBeenCalled();
  });

  it('does NOT fire for in-flight bookkeeping events', async () => {
    const internalEvents = [
      'publish_requested',
      'validated',
      'extension_rejected',
      'republish_requested',
      'unpublish_requested',
    ] as const;
    for (const ev of internalEvents) {
      await firePublishWebhook('t', 'e', ev, {});
    }
    expect(queueWebhookMock).not.toHaveBeenCalled();
  });

  it('swallows queue errors so it never breaks the publish flow', async () => {
    queueWebhookMock.mockRejectedValueOnce(new Error('webhooks DB down'));
    // Should not throw.
    await expect(
      firePublishWebhook('t', 'e', 'indexed', { catalog_service_id: 'x' }),
    ).resolves.toBeUndefined();
  });

  it('attaches a unique id and ISO timestamp to every event', async () => {
    await firePublishWebhook('t', 'e', 'indexed', {});
    const event = queueWebhookMock.mock.calls[0]![1];
    expect(event.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(() => new Date(event.timestamp).toISOString()).not.toThrow();
  });
});
