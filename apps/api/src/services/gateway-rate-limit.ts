/**
 * Per-endpoint rate limiter for the x402 gateway.
 *
 * Why separate from `middleware/rate-limit.ts`: the global rate limiter is
 * keyed on (IP, token-prefix) for the control plane. Paid endpoints
 * exposed under `*.x402.getsly.ai` (or `/x402/{tenant}/{service}`) need
 * their own per-(endpoint, ip) bucket so that:
 *
 *   - One IP scraping endpoint A doesn't burn the bucket for endpoint B.
 *   - A misbehaving buyer can be cooled off without affecting unrelated
 *     traffic on the same IP through the control plane.
 *
 * Implementation: simple fixed-window counter in a Map. Acceptable for
 * single-instance API. NOTE: Railway production currently runs with ≥2
 * replicas (each with its own in-memory store), so the effective ceiling
 * is `limit × replica_count` per (endpoint, ip). For tighter guarantees
 * — especially per-tenant abuse policies — switch this to a Redis-backed
 * counter (Upstash, etc.) so all replicas share one bucket.
 *
 * Tunable via env (`GATEWAY_RPM_PER_IP`, default 60). Disable globally
 * with `DISABLE_GATEWAY_RATE_LIMIT=true` (test/dev). The counter is
 * skipped when `NODE_ENV=test` to keep the unit tests deterministic.
 */

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const WINDOW_MS = 60_000;
const store = new Map<string, RateLimitEntry>();

// Sweep stale entries every minute — bounded memory under sustained load.
const sweepInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (entry.resetAt < now) store.delete(key);
  }
}, WINDOW_MS);
// Don't pin the event loop in tests / on shutdown.
sweepInterval.unref?.();

export interface GatewayRateLimitResult {
  ok: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number;
  retryAfter?: number;
}

/**
 * Check + increment the (endpoint_id, ip) bucket. Returns the limit state
 * so the caller can attach standard X-RateLimit-* / Retry-After headers.
 *
 * The endpoint may carry its own override (column to be added in a
 * follow-up migration); for now everyone shares the env-configured limit.
 */
export function checkGatewayRateLimit(input: {
  endpointId: string;
  clientIp: string;
  /** Per-endpoint override; falls back to env / default. */
  limitOverride?: number;
}): GatewayRateLimitResult {
  // Test/dev escape hatch — keeps unit tests + local probing fast.
  if (
    process.env.NODE_ENV === 'test' ||
    process.env.DISABLE_GATEWAY_RATE_LIMIT === 'true'
  ) {
    return { ok: true, limit: 0, remaining: 0, resetSeconds: 0 };
  }

  const envLimit = Number(process.env.GATEWAY_RPM_PER_IP);
  const limit = Number.isFinite(input.limitOverride) && input.limitOverride! > 0
    ? input.limitOverride!
    : Number.isFinite(envLimit) && envLimit > 0
      ? envLimit
      : 60;

  const key = `${input.endpointId}:${input.clientIp || 'unknown'}`;
  const now = Date.now();
  let entry = store.get(key);
  if (!entry || entry.resetAt < now) {
    entry = { count: 0, resetAt: now + WINDOW_MS };
    store.set(key, entry);
  }
  entry.count++;

  const remaining = Math.max(0, limit - entry.count);
  const resetSeconds = Math.ceil(entry.resetAt / 1000);
  if (entry.count > limit) {
    return {
      ok: false,
      limit,
      remaining: 0,
      resetSeconds,
      retryAfter: Math.ceil((entry.resetAt - now) / 1000),
    };
  }
  return { ok: true, limit, remaining, resetSeconds };
}

/** Extract the buyer IP from a Hono context. Honours common proxy headers. */
export function getClientIp(headers: Headers): string {
  const xff = headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]!.trim();
  return headers.get('x-real-ip') || headers.get('cf-connecting-ip') || 'unknown';
}

/** Test-only — clears the in-memory store. */
export function __resetGatewayRateLimitForTests(): void {
  store.clear();
}
