import type { Context, Next } from 'hono';

interface Bucket {
  windowStart: number;
  count: number;
  limit: number;
}

const BUCKETS = new Map<string, Bucket>();
const WINDOW_MS = 60_000;

function bucketKey(ctx: { scannerKeyId?: string; userId?: string; tenantId: string }): string {
  return ctx.scannerKeyId ?? ctx.userId ?? ctx.tenantId;
}

export async function rateLimitMiddleware(c: Context, next: Next) {
  const ctx = c.get('ctx');
  if (!ctx?.tenantId) return next();

  const limit = ctx.rateLimitPerMin ?? 60;
  const key = bucketKey(ctx);
  const now = Date.now();

  let bucket = BUCKETS.get(key);
  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    bucket = { windowStart: now, count: 0, limit };
    BUCKETS.set(key, bucket);
  }

  bucket.count += 1;

  const remaining = Math.max(0, bucket.limit - bucket.count);
  const resetSeconds = Math.ceil((bucket.windowStart + WINDOW_MS - now) / 1000);

  c.header('X-RateLimit-Limit', String(bucket.limit));
  c.header('X-RateLimit-Remaining', String(remaining));
  c.header('X-RateLimit-Reset', String(resetSeconds));

  if (bucket.count > bucket.limit) {
    // Retry-After is the RFC-standard header; standard HTTP clients back off
    // correctly when they see it. We keep X-RateLimit-* for observability.
    c.header('Retry-After', String(resetSeconds));
    return c.json(
      {
        error: 'rate_limit_exceeded',
        limit: bucket.limit,
        reset_seconds: resetSeconds,
      },
      429,
    );
  }

  return next();
}

// Exported for tests / admin scripts
export function _resetBuckets(): void {
  BUCKETS.clear();
}
