import type { Context, Next } from 'hono';
import { debit, getBalance, refund } from '../billing/ledger.js';
import { getCreditCost } from '../billing/credit-costs.js';
import { normalizePath } from '../services/usage.js';

/**
 * Enforce credit balance before request runs. Batch endpoints use
 * a dedicated helper (charged at enqueue time with target count).
 *
 * Sets c.var.creditsCharged so the usage-counter records it.
 *
 * Auto-refunds the debit if the handler returns 4xx/5xx so partners don't
 * burn credits on validation typos or our own server errors. The route
 * still gets the work it needs done; we just reverse the bookkeeping.
 */
export async function creditsMiddleware(c: Context, next: Next) {
  const ctx = c.get('ctx');
  if (!ctx?.tenantId) return next();

  const method = c.req.method;
  const pathTemplate = normalizePath(new URL(c.req.url).pathname);
  const cost = getCreditCost(method, pathTemplate);

  // Batch and MCP endpoints charge themselves (variable cost).
  const isDynamic =
    pathTemplate === '/v1/scanner/scan/batch' && method === 'POST';

  if (cost <= 0 || isDynamic) {
    c.set('creditsCharged', 0);
    return next();
  }

  const balance = await getBalance(ctx.tenantId);
  if (balance < cost) {
    return c.json(
      {
        error: 'insufficient_credits',
        balance,
        required: cost,
        docs: 'https://docs.getsly.ai/scanner/credits-and-billing',
      },
      402,
    );
  }

  const requestId = c.get('requestId') ?? c.req.header('x-request-id') ?? 'unknown';
  const newBalance = await debit(
    ctx.tenantId,
    cost,
    `request:${requestId}`,
    { endpoint: `${method} ${pathTemplate}`, key_id: ctx.scannerKeyId ?? null },
  );

  if (newBalance === null) {
    return c.json({ error: 'insufficient_credits', balance, required: cost }, 402);
  }

  c.set('creditsCharged', cost);
  console.log(
    `[scanner-billing] debit tenant=${ctx.tenantId} cost=${cost} balance_after=${newBalance} endpoint="${method} ${pathTemplate}"`,
  );

  await next();

  const status = c.res.status;
  if (status >= 400) {
    const refundedBalance = await refund(
      ctx.tenantId,
      cost,
      `refund:${requestId}`,
      {
        endpoint: `${method} ${pathTemplate}`,
        key_id: ctx.scannerKeyId ?? null,
        reason: status >= 500 ? 'server_error' : 'client_error',
        status_code: status,
      },
    ).catch((err) => {
      console.error('[scanner-billing] refund failed:', err);
      return null;
    });
    c.set('creditsCharged', 0);
    if (refundedBalance !== null) {
      c.header('X-Credits-Remaining', String(refundedBalance));
      console.log(
        `[scanner-billing] refund tenant=${ctx.tenantId} amount=${cost} balance_after=${refundedBalance} status=${status} endpoint="${method} ${pathTemplate}"`,
      );
    }
  } else {
    c.header('X-Credits-Remaining', String(newBalance));
  }
}

/**
 * Helper for handlers that charge variable amounts (batch, MCP).
 * Call inside the handler before doing work.
 */
export async function chargeCredits(
  c: Context,
  cost: number,
  source: string,
  metadata: Record<string, unknown> = {},
): Promise<{ ok: true; balance: number } | { ok: false; balance: number; required: number }> {
  const ctx = c.get('ctx');
  if (!ctx?.tenantId) {
    return { ok: false, balance: 0, required: cost };
  }

  if (cost <= 0) {
    c.set('creditsCharged', 0);
    return { ok: true, balance: await getBalance(ctx.tenantId) };
  }

  const balance = await getBalance(ctx.tenantId);
  if (balance < cost) {
    return { ok: false, balance, required: cost };
  }

  const newBalance = await debit(ctx.tenantId, cost, source, metadata);
  if (newBalance === null) {
    return { ok: false, balance, required: cost };
  }

  c.set('creditsCharged', (c.get('creditsCharged') ?? 0) + cost);
  console.log(
    `[scanner-billing] debit tenant=${ctx.tenantId} cost=${cost} balance_after=${newBalance} source=${source}`,
  );
  return { ok: true, balance: newBalance };
}
