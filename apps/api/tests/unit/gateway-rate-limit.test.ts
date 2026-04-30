/**
 * Tests for the per-endpoint gateway rate limiter.
 *
 * The limiter is a fixed-window counter keyed on (endpoint_id, ip). Real
 * deployments exempt test/dev via NODE_ENV/DISABLE_GATEWAY_RATE_LIMIT,
 * so these tests deliberately override that to exercise the actual logic.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  checkGatewayRateLimit,
  getClientIp,
  __resetGatewayRateLimitForTests,
} from '../../src/services/gateway-rate-limit.js';

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

describe('checkGatewayRateLimit', () => {
  beforeEach(() => {
    __resetGatewayRateLimitForTests();
    // The limiter short-circuits when NODE_ENV=test. Force production
    // behaviour for the duration of these tests.
    process.env.NODE_ENV = 'production';
    delete process.env.DISABLE_GATEWAY_RATE_LIMIT;
    process.env.GATEWAY_RPM_PER_IP = '5';
  });

  afterAll(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    delete process.env.GATEWAY_RPM_PER_IP;
  });

  it('allows requests under the limit', () => {
    for (let i = 1; i <= 5; i++) {
      const r = checkGatewayRateLimit({ endpointId: 'e1', clientIp: '1.1.1.1' });
      expect(r.ok).toBe(true);
      expect(r.limit).toBe(5);
      expect(r.remaining).toBe(5 - i);
    }
  });

  it('blocks requests over the limit and returns Retry-After', () => {
    for (let i = 0; i < 5; i++) {
      checkGatewayRateLimit({ endpointId: 'e1', clientIp: '1.1.1.1' });
    }
    const blocked = checkGatewayRateLimit({ endpointId: 'e1', clientIp: '1.1.1.1' });
    expect(blocked.ok).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfter).toBeGreaterThan(0);
    expect(blocked.retryAfter).toBeLessThanOrEqual(60);
  });

  it('is independent across (endpoint, ip) pairs', () => {
    for (let i = 0; i < 5; i++) {
      checkGatewayRateLimit({ endpointId: 'e1', clientIp: '1.1.1.1' });
    }
    // Different IP, same endpoint — fresh bucket.
    const otherIp = checkGatewayRateLimit({ endpointId: 'e1', clientIp: '2.2.2.2' });
    expect(otherIp.ok).toBe(true);
    expect(otherIp.remaining).toBe(4);

    // Same IP, different endpoint — fresh bucket.
    const otherEndpoint = checkGatewayRateLimit({ endpointId: 'e2', clientIp: '1.1.1.1' });
    expect(otherEndpoint.ok).toBe(true);
    expect(otherEndpoint.remaining).toBe(4);
  });

  it('honours the per-endpoint limitOverride', () => {
    // Only 2 allowed for this endpoint
    expect(
      checkGatewayRateLimit({ endpointId: 'tight', clientIp: 'x', limitOverride: 2 }).ok,
    ).toBe(true);
    expect(
      checkGatewayRateLimit({ endpointId: 'tight', clientIp: 'x', limitOverride: 2 }).ok,
    ).toBe(true);
    expect(
      checkGatewayRateLimit({ endpointId: 'tight', clientIp: 'x', limitOverride: 2 }).ok,
    ).toBe(false);
  });

  it('falls back to the env default when no override given', () => {
    // GATEWAY_RPM_PER_IP=5 from beforeEach
    for (let i = 0; i < 5; i++) {
      expect(
        checkGatewayRateLimit({ endpointId: 'env-test', clientIp: 'y' }).ok,
      ).toBe(true);
    }
    expect(
      checkGatewayRateLimit({ endpointId: 'env-test', clientIp: 'y' }).ok,
    ).toBe(false);
  });

  it('returns ok with no counters when DISABLE_GATEWAY_RATE_LIMIT=true', () => {
    process.env.DISABLE_GATEWAY_RATE_LIMIT = 'true';
    for (let i = 0; i < 100; i++) {
      const r = checkGatewayRateLimit({ endpointId: 'unlim', clientIp: 'z' });
      expect(r.ok).toBe(true);
    }
  });
});

describe('getClientIp', () => {
  it('uses the first hop of x-forwarded-for', () => {
    const h = new Headers({ 'x-forwarded-for': '203.0.113.10, 10.0.0.1' });
    expect(getClientIp(h)).toBe('203.0.113.10');
  });

  it('falls back to x-real-ip', () => {
    const h = new Headers({ 'x-real-ip': '198.51.100.5' });
    expect(getClientIp(h)).toBe('198.51.100.5');
  });

  it('uses cf-connecting-ip when behind Cloudflare', () => {
    const h = new Headers({ 'cf-connecting-ip': '198.51.100.99' });
    expect(getClientIp(h)).toBe('198.51.100.99');
  });

  it('returns unknown when no headers are present', () => {
    expect(getClientIp(new Headers())).toBe('unknown');
  });
});
