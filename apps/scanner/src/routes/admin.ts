import { Hono } from 'hono';
import { createClient } from '../db/client.js';
import { scanDomain } from '../scanner.js';
import { waitUntil } from '../utils/wait-until.js';
import pLimit from 'p-limit';

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

// GET/POST /v1/admin/scheduled-rescan — weekly cron that refreshes the
// shared scan corpus. Picks merchants whose last_scanned_at is > 7 days old,
// caps at 100 per run so we don't blow the 300s function budget, and writes
// under a system tenant (no partner credits charged).
//
// The value prop is "shared corpus stays fresh for everyone" — we deliberately
// don't per-tenant-ify this; every partner benefits equally.
adminRouter.all('/admin/scheduled-rescan', async (c) => {
  if (!authorizeCron(c.req.header('Authorization'))) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  const systemTenant = process.env.SCHEDULED_RESCAN_TENANT_ID;
  if (!systemTenant) {
    console.error('[admin] SCHEDULED_RESCAN_TENANT_ID not set — skipping');
    return c.json({ error: 'scheduled_rescan_tenant_missing' }, 500);
  }

  const maxAgeDays = Number(c.req.query('max_age_days') ?? 7);
  const runBudget = Math.min(Number(c.req.query('limit') ?? 100), 200);
  const concurrency = Math.min(Number(c.req.query('concurrency') ?? 8), 16);

  const supabase = createClient();
  const staleDate = new Date();
  staleDate.setDate(staleDate.getDate() - maxAgeDays);

  const { data: stale, error } = await (supabase.from('merchant_scans') as any)
    .select('domain, merchant_name, merchant_category, country_code, region')
    .eq('scan_status', 'completed')
    .lt('last_scanned_at', staleDate.toISOString())
    .order('last_scanned_at', { ascending: true })
    .limit(runBudget);

  if (error) {
    console.error('[admin] scheduled-rescan: failed to find stale scans:', error.message);
    return c.json({ error: error.message }, 500);
  }

  const candidates = (stale ?? []) as Array<{
    domain: string;
    merchant_name: string | null;
    merchant_category: string | null;
    country_code: string | null;
    region: string | null;
  }>;

  if (candidates.length === 0) {
    console.log('[admin] scheduled-rescan: nothing stale');
    return c.json({ ok: true, rescanned: 0, message: 'corpus is fresh' });
  }

  // Fire-and-forget via waitUntil so the response returns immediately.
  // scanDomain has its own 15s timeout per target; pLimit caps in-flight.
  const limit = pLimit(concurrency);
  waitUntil(
    (async () => {
      let ok = 0;
      let fail = 0;
      await Promise.allSettled(
        candidates.map((s) =>
          limit(async () => {
            try {
              await scanDomain({
                tenantId: systemTenant,
                domain: s.domain,
                merchant_name: s.merchant_name ?? undefined,
                merchant_category: s.merchant_category ?? undefined,
                country_code: s.country_code ?? undefined,
                region: s.region ?? undefined,
                skipIfFresh: false,
              });
              ok++;
            } catch (err) {
              fail++;
              console.error(`[admin] scheduled-rescan ${s.domain} failed:`, (err as Error).message);
            }
          }),
        ),
      );
      console.log(
        `[admin] scheduled-rescan done: ${ok} ok, ${fail} failed, ${candidates.length} total`,
      );
    })(),
  );

  return c.json(
    {
      ok: true,
      scheduled: candidates.length,
      max_age_days: maxAgeDays,
      concurrency,
      tenant_id: systemTenant,
      message: 'rescan dispatched',
    },
    202,
  );
});
