/**
 * Auto-republish hook tests.
 *
 * Pin two facts:
 *  1. PATCH on a discovery-relevant field on a public endpoint marks
 *     `metadata_dirty=true` (and would schedule a republish).
 *  2. PATCH on `status` (or webhookUrl) does NOT touch metadata_dirty
 *     and does NOT schedule a republish.
 *
 * We test the pure helper `patchTouchesDiscovery` directly — that's the
 * exact predicate the route uses to decide whether to mark dirty + arm
 * the debounce timer. No need to spin up the full Hono app to verify it.
 */
import { describe, it, expect } from 'vitest';
import { __testing } from '../../src/routes/x402-endpoints.js';

const { patchTouchesDiscovery } = __testing;

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
