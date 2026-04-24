import type { Context, Next } from 'hono';
import { recordRequest, flushUsage } from '../services/usage.js';

/**
 * Placed after authMiddleware so ctx is populated.
 *
 * Records the request into the in-memory buffer, then triggers a flush
 * synchronously — serverless functions don't keep interval timers alive
 * between invocations, so we flush per request. The flush is ~1 DB round-trip
 * and upserts are idempotent per (tenant, minute_bucket, method, path,
 * status, actor), so concurrent flushes are safe.
 */
export async function usageCounterMiddleware(c: Context, next: Next) {
  const start = performance.now();
  await next();

  const ctx = c.get('ctx');
  if (!ctx?.tenantId) return;

  const durationMs = Math.round(performance.now() - start);
  const creditsConsumed = Number(c.get('creditsCharged' as never) ?? 0);

  recordRequest({
    tenantId: ctx.tenantId,
    scannerKeyId: ctx.scannerKeyId ?? null,
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    statusCode: c.res.status,
    actorType: ctx.actorType ?? 'unknown',
    durationMs,
    creditsConsumed,
  });

  // Fire-and-forget flush. In Fluid Compute the floating promise runs until
  // either the function goes idle or the next invocation reuses the instance;
  // upserts are idempotent so retries are safe.
  flushUsage().catch((err) => {
    console.error('[scanner-usage] flush failed:', err);
  });
}

declare module 'hono' {
  interface ContextVariableMap {
    creditsCharged: number;
  }
}
