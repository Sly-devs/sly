import type { Context, Next } from 'hono';
import { recordRequest } from '../services/usage.js';

/**
 * Placed after authMiddleware so ctx is populated.
 * Reads credits_consumed from c.var.creditsCharged, which credit middleware sets
 * before downstream handlers run.
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
}

declare module 'hono' {
  interface ContextVariableMap {
    creditsCharged: number;
  }
}
