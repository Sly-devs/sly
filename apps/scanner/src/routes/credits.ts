import { Hono } from 'hono';
import { getBalanceSummary, listLedger } from '../billing/ledger.js';
import { createClient } from '../db/client.js';

export const creditsRouter = new Hono();

// GET /v1/scanner/credits/balance
creditsRouter.get('/credits/balance', async (c) => {
  const { tenantId } = c.get('ctx');
  const summary = await getBalanceSummary(tenantId);
  return c.json(summary);
});

// GET /v1/scanner/credits/ledger?from=&to=&limit=&offset=
creditsRouter.get('/credits/ledger', async (c) => {
  const { tenantId } = c.get('ctx');
  const from = c.req.query('from') || undefined;
  const to = c.req.query('to') || undefined;
  const limit = Math.min(parseInt(c.req.query('limit') || '100'), 500);
  const offset = parseInt(c.req.query('offset') || '0');

  const entries = await listLedger(tenantId, { from, to, limit, offset });
  return c.json({ data: entries, limit, offset });
});

// GET /v1/scanner/usage?from=&to=&group_by=endpoint|day
// Aggregates scanner_usage_events for the calling tenant.
creditsRouter.get('/usage', async (c) => {
  const { tenantId } = c.get('ctx');
  const from = c.req.query('from');
  const to = c.req.query('to');
  const groupBy = c.req.query('group_by') === 'day' ? 'day' : 'endpoint';

  const supabase = createClient();
  let q = (supabase.from('scanner_usage_events') as any)
    .select('method, path_template, minute_bucket, status_code, count, total_duration_ms, credits_consumed')
    .eq('tenant_id', tenantId);
  if (from) q = q.gte('minute_bucket', from);
  if (to) q = q.lte('minute_bucket', to);

  const { data, error } = await q;
  if (error) return c.json({ error: error.message }, 500);

  const rows = (data as any[]) ?? [];

  if (groupBy === 'day') {
    const byDay: Record<string, {
      requests: number;
      credits: number;
      errors: number;
      total_duration_ms: number;
    }> = {};
    for (const r of rows) {
      const day = r.minute_bucket.slice(0, 10);
      if (!byDay[day]) byDay[day] = { requests: 0, credits: 0, errors: 0, total_duration_ms: 0 };
      byDay[day].requests += r.count;
      byDay[day].credits += r.credits_consumed;
      byDay[day].total_duration_ms += r.total_duration_ms;
      if (r.status_code >= 400) byDay[day].errors += r.count;
    }
    const byDayData = Object.entries(byDay)
      .map(([day, v]) => ({ day, ...v }))
      .sort((a, b) => a.day.localeCompare(b.day));
    return c.json({ group_by: 'day', data: byDayData });
  }

  // group_by = endpoint
  const byEndpoint: Record<string, {
    endpoint: string;
    requests: number;
    credits: number;
    errors: number;
    total_duration_ms: number;
  }> = {};
  for (const r of rows) {
    const key = `${r.method} ${r.path_template}`;
    if (!byEndpoint[key]) {
      byEndpoint[key] = { endpoint: key, requests: 0, credits: 0, errors: 0, total_duration_ms: 0 };
    }
    byEndpoint[key].requests += r.count;
    byEndpoint[key].credits += r.credits_consumed;
    byEndpoint[key].total_duration_ms += r.total_duration_ms;
    if (r.status_code >= 400) byEndpoint[key].errors += r.count;
  }
  const byEndpointData = Object.values(byEndpoint).sort((a, b) => b.requests - a.requests);
  return c.json({ group_by: 'endpoint', data: byEndpointData });
});
