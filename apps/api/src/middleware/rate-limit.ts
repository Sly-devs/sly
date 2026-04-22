import { Context, Next } from 'hono';

// Simple in-memory rate limiter for PoC
// In production, use Redis-based solution
interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const rateLimitStore = new Map<string, RateLimitEntry>();

// Clean up expired entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore.entries()) {
    if (entry.resetAt < now) {
      rateLimitStore.delete(key);
    }
  }
}, 60000); // Clean every minute

export interface RateLimitConfig {
  windowMs: number;    // Time window in milliseconds
  maxRequests: number; // Max requests per window
  keyGenerator?: (c: Context) => string;
}

// Tunable via env (RATE_LIMIT_MAX_REQUESTS / RATE_LIMIT_WINDOW_MS) so ops can
// loosen the ceiling without a redeploy — dashboards with lots of parallel
// analytics calls routinely need more than 100/min. Defaults stay conservative.
const envMax = Number(process.env.RATE_LIMIT_MAX_REQUESTS);
const envWindow = Number(process.env.RATE_LIMIT_WINDOW_MS);
const defaultConfig: RateLimitConfig = {
  windowMs: Number.isFinite(envWindow) && envWindow > 0 ? envWindow : 60_000,
  maxRequests: Number.isFinite(envMax) && envMax > 0 ? envMax : 300,
};

/**
 * Rate limiting middleware
 */
export function rateLimiter(config: Partial<RateLimitConfig> = {}) {
  const { windowMs, maxRequests, keyGenerator } = { ...defaultConfig, ...config };

  return async (c: Context, next: Next) => {
    // Skip rate limiting in test/development environment or when explicitly disabled
    if (
      process.env.NODE_ENV === 'test' ||
      process.env.NODE_ENV === 'development' ||
      process.env.INTEGRATION === 'true' ||
      process.env.DISABLE_RATE_LIMIT === 'true'
    ) {
      return next();
    }
    // Generate key (default: IP + token prefix)
    const key = keyGenerator
      ? keyGenerator(c)
      : getRateLimitKey(c);

    const now = Date.now();
    let entry = rateLimitStore.get(key);

    if (!entry || entry.resetAt < now) {
      entry = { count: 0, resetAt: now + windowMs };
      rateLimitStore.set(key, entry);
    }

    entry.count++;

    // Set rate limit headers
    c.header('X-RateLimit-Limit', String(maxRequests));
    c.header('X-RateLimit-Remaining', String(Math.max(0, maxRequests - entry.count)));
    c.header('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > maxRequests) {
      c.header('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return c.json(
        {
          error: 'Too many requests',
          retryAfter: Math.ceil((entry.resetAt - now) / 1000),
        },
        429
      );
    }

    return next();
  };
}

function getRateLimitKey(c: Context): string {
  // Use forwarded IP if behind proxy, otherwise use direct IP
  const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    || c.req.header('x-real-ip')
    || 'unknown';

  // Add token prefix for per-token limiting
  const auth = c.req.header('Authorization');
  const tokenPrefix = auth?.startsWith('Bearer ')
    ? auth.slice(7, 20) // First 13 chars of token
    : 'anon';

  return `${ip}:${tokenPrefix}`;
}

/**
 * Stricter rate limit for sensitive operations
 */
export const strictRateLimiter = rateLimiter({
  windowMs: 60000,    // 1 minute
  maxRequests: 30,    // 30 requests per minute
});

/**
 * Very strict limit for auth attempts
 */
export const authRateLimiter = rateLimiter({
  windowMs: 300000,   // 5 minutes
  maxRequests: 20,    // 20 attempts per 5 minutes
  keyGenerator: (c) => {
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
      || c.req.header('x-real-ip')
      || 'unknown';
    return `auth:${ip}`;
  },
});
