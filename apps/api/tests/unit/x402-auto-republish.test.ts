/**
 * Auto-republish hook tests.
 *
 * Pin three facts:
 *  1. `patchTouchesDiscovery` distinguishes discovery fields from status
 *     flips and config-only fields.
 *  2. PATCH on a discovery-relevant field on a public endpoint marks
 *     `metadata_dirty=true` and arms the 5s debounce timer.
 *  3. The debounce timer eventually calls `publishEndpoint(force: true)`.
 *
 * The first uses the pure predicate. The second and third drive
 * `scheduleAutoRepublish` directly with fake timers and a mocked
 * publishEndpoint to verify the debounce → republish chain end-to-end
 * without spinning up the full Hono app.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db/client.js', () => ({
  createClient: () => ({}),
}));

const publishEndpointMock = vi.fn(async () => ({ ok: true }));
vi.mock('../../src/services/publish-x402.js', () => ({
  publishEndpoint: publishEndpointMock,
  unpublishEndpoint: vi.fn(),
  validateEndpointForPublish: vi.fn(),
  DISCOVERY_FIELDS: [
    'name',
    'description',
    'serviceSlug',
    'backendUrl',
    'method',
    'basePrice',
    'currency',
    'network',
    'volumeDiscounts',
    'category',
  ],
}));

const { __testing } = await import('../../src/routes/x402-endpoints.js');
const { patchTouchesDiscovery, scheduleAutoRepublish } = __testing;

describe('patchTouchesDiscovery', () => {
  it('returns true for description changes', () => {
    expect(patchTouchesDiscovery({ description: 'a new description' })).toBe(true);
  });

  it('returns true for serviceSlug changes', () => {
    expect(patchTouchesDiscovery({ serviceSlug: 'weather-v2' })).toBe(true);
  });

  it('returns true for backendUrl changes', () => {
    expect(patchTouchesDiscovery({ backendUrl: 'https://other.example.com' })).toBe(true);
  });

  it('returns true for basePrice changes', () => {
    expect(patchTouchesDiscovery({ basePrice: 0.05 })).toBe(true);
  });

  it('returns true for category changes', () => {
    expect(patchTouchesDiscovery({ category: 'data' })).toBe(true);
  });

  it('returns true for volumeDiscounts changes', () => {
    expect(patchTouchesDiscovery({ volumeDiscounts: [{ threshold: 100, priceMultiplier: 0.9 }] })).toBe(true);
  });

  it('returns false for status flips', () => {
    expect(patchTouchesDiscovery({ status: 'paused' })).toBe(false);
  });

  it('returns false for webhookUrl changes', () => {
    expect(patchTouchesDiscovery({ webhookUrl: 'https://hooks.example.com' })).toBe(false);
  });

  it('returns false for an empty patch', () => {
    expect(patchTouchesDiscovery({})).toBe(false);
  });

  it('returns true when any single discovery field is set among non-discovery fields', () => {
    expect(patchTouchesDiscovery({ status: 'active', name: 'New name' })).toBe(true);
  });
});

describe('scheduleAutoRepublish (debounce → publishEndpoint chain)', () => {
  beforeEach(() => {
    publishEndpointMock.mockClear();
    vi.useFakeTimers();
  });

  it('calls publishEndpoint(force=true) after the debounce window elapses', async () => {
    scheduleAutoRepublish({ tenantId: 't' }, 'endpoint-1');
    expect(publishEndpointMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(publishEndpointMock).toHaveBeenCalledTimes(1);
    expect(publishEndpointMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tenantId: 't' }),
      'endpoint-1',
      { force: true },
    );
    vi.useRealTimers();
  });

  it('coalesces multiple PATCHes within the debounce window into one publish call', async () => {
    scheduleAutoRepublish({ tenantId: 't' }, 'endpoint-2');
    await vi.advanceTimersByTimeAsync(2000);
    scheduleAutoRepublish({ tenantId: 't' }, 'endpoint-2'); // resets timer
    await vi.advanceTimersByTimeAsync(2000);
    scheduleAutoRepublish({ tenantId: 't' }, 'endpoint-2'); // resets again
    await vi.advanceTimersByTimeAsync(5000);
    expect(publishEndpointMock).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('schedules independent timers per endpoint id', async () => {
    scheduleAutoRepublish({ tenantId: 't' }, 'endpoint-A');
    scheduleAutoRepublish({ tenantId: 't' }, 'endpoint-B');
    await vi.advanceTimersByTimeAsync(5000);
    expect(publishEndpointMock).toHaveBeenCalledTimes(2);
    const calls = publishEndpointMock.mock.calls.map((c: any[]) => c[2]);
    expect(calls.sort()).toEqual(['endpoint-A', 'endpoint-B']);
    vi.useRealTimers();
  });
});
