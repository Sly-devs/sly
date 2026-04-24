import { Hono } from 'hono';
import { createClient } from '../db/client.js';

/**
 * Admin routes — internal only. Gated by a shared CRON_SECRET header so
 * Vercel Cron (and only Vercel Cron) can hit them. No user JWT or partner
 * API key accepted here.
 *
 * Mounted under /v1/admin in app.ts, outside the v1 auth middleware so we
 * can enforce the cron-secret check ourselves.
 */
export const adminRouter = new Hono();

function authorizeCron(bearer: string | undefined): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error('[admin] CRON_SECRET env var not set — blocking admin request');
    return false;
  }
  if (!bearer || !bearer.startsWith('Bearer ')) return false;
  return bearer.slice(7) === secret;
}

// GET/POST /v1/admin/ensure-partitions — idempotent, creates next 3 months
// of scanner_usage_events partitions. Safe to call daily; Vercel Cron hits
// it monthly via .vercel/output/config.json.
adminRouter.all('/admin/ensure-partitions', async (c) => {
  if (!authorizeCron(c.req.header('Authorization'))) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  const supabase = createClient();
  const { data, error } = await (supabase.rpc as any)(
    'ensure_scanner_usage_partitions',
    { p_months_ahead: 3 },
  );

  if (error) {
    console.error('[admin] ensure-partitions failed:', error.message);
    return c.json({ error: error.message }, 500);
  }

  const created = Array.isArray(data) ? data.map((r: any) => r.created_partition) : [];
  console.log(
    `[admin] ensure-partitions ok — ${created.length} new partition(s)${created.length ? ': ' + created.join(', ') : ''}`,
  );
  return c.json({ ok: true, created_partitions: created });
});
