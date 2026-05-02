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

// GET /v1/scanner/credits/activity?from=&to=
// Day-bucketed scan + credit aggregates from the credit LEDGER (not the
// usage events buffer). Use this anywhere you need a ground-truth count of
// what the partner actually paid for — the ledger is written synchronously
// inside the credits middleware, so it never drops a billed event.
//
// The chart and "Scans (30d)" KPI on the dashboard read from here for
// scan counts; usage_events stays the source for read-traffic + per-endpoint
// breakdown where best-effort aggregation is acceptable.
creditsRouter.get('/credits/activity', async (c) => {
  const { tenantId } = c.get('ctx');
  const from = c.req.query('from');
  const to = c.req.query('to');

  const supabase = createClient();
  // Pull both consume and refund rows so we can net them per day. A 4xx
  // validation error consumes then refunds in the same request — both rows
  // land within milliseconds of each other and almost always on the same
  // calendar day. Reporting "Scans" as net (consume − refund) matches what
  // the partner actually paid for.
  let q = (supabase.from('scanner_credit_ledger') as any)
    .select('delta, created_at, reason')
    .eq('tenant_id', tenantId)
    .in('reason', ['consume', 'refund']);
  if (from) q = q.gte('created_at', from);
  if (to) q = q.lte('created_at', to);

  const { data, error } = await q;
  if (error) return c.json({ error: error.message }, 500);

  const byDay: Record<string, { day: string; scans: number; credits: number }> = {};
  for (const row of (data as Array<{ delta: number; created_at: string; reason: string }>) ?? []) {
    const day = row.created_at.slice(0, 10);
    if (!byDay[day]) byDay[day] = { day, scans: 0, credits: 0 };
    if (row.reason === 'consume') {
      byDay[day].scans += 1;
      byDay[day].credits += -row.delta;
    } else {
      // refund — reverses a same-day consume
      byDay[day].scans -= 1;
      byDay[day].credits -= row.delta;
    }
  }
  const days = Object.values(byDay)
    .map((d) => ({ ...d, scans: Math.max(0, d.scans), credits: Math.max(0, d.credits) }))
    .sort((a, b) => a.day.localeCompare(b.day));
  return c.json({ data: days });
});

// GET /v1/scanner/credits/ledger?from=&to=&limit=&offset=&expand=scan
//
// expand=scan joins each consume row to the merchant_scans row that paid for
// it (via the new merchant_scans.request_id column) so partners can audit
// "what did I get for this charge?". Each consume row gets a `scan` field:
// { id, domain, readiness_score, scan_status } if the join finds a match.
creditsRouter.get('/credits/ledger', async (c) => {
  const { tenantId } = c.get('ctx');
  const from = c.req.query('from') || undefined;
  const to = c.req.query('to') || undefined;
  const limit = Math.min(parseInt(c.req.query('limit') || '100'), 500);
  const page = Math.max(1, parseInt(c.req.query('page') || '1'));
  // Accept either `?page=N` (preferred, matches the operations event-log API)
  // or legacy `?offset=N` for backwards-compat with anyone curling it.
  const offset = c.req.query('offset')
    ? parseInt(c.req.query('offset')!)
    : (page - 1) * limit;
  const expand = (c.req.query('expand') || '').split(',').map((s) => s.trim());

  const { entries, total } = await listLedger(tenantId, { from, to, limit, offset });
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const pagination = { page, limit, total, totalPages };

  const respond = (data: any[]) => c.json({ data, pagination });

  if (!expand.includes('scan')) return respond(entries);

  // Pull request_ids out of source = "request:<uuid>" on consume rows.
  const requestIds = entries
    .filter((e) => e.reason === 'consume' && e.source?.startsWith('request:'))
    .map((e) => e.source!.slice('request:'.length));

  if (requestIds.length === 0) return respond(entries);

  const supabase = createClient();
  const { data: scans } = await (supabase.from('merchant_scans') as any)
    .select('id, request_id, domain, readiness_score, scan_status')
    .eq('tenant_id', tenantId)
    .in('request_id', requestIds);

  const byRequestId = new Map<string, any>();
  for (const s of (scans as any[]) ?? []) {
    if (s.request_id) byRequestId.set(s.request_id, s);
  }

  const expanded = entries.map((e) => {
    if (e.reason !== 'consume' || !e.source?.startsWith('request:')) return e;
    const rid = e.source.slice('request:'.length);
    const scan = byRequestId.get(rid);
    return scan ? { ...e, scan } : e;
  });

  return respond(expanded);
});

// GET /v1/scanner/usage?from=&to=&group_by=endpoint|day
//
// Server-side aggregation via the scanner_usage_aggregate Postgres function —
// the previous code path fetched all rows into Node and was silently
// truncated at supabase-js's default 1000-row cap, so tenants with lots of
// activity saw their newest events dropped from the dashboard.
//
// The credits column on the endpoint view comes from the scanner_credit_ledger
// (via scanner_credits_by_endpoint) instead of usage_events, because pre-fix
// data loss in usage_events made billed credits look smaller than they were.
// usage_events still backs requests/errors/latency where best-effort
// aggregation is acceptable.
creditsRouter.get('/usage', async (c) => {
  const { tenantId } = c.get('ctx');
  const from = c.req.query('from') || null;
  const to = c.req.query('to') || null;
  const groupBy = c.req.query('group_by') === 'day' ? 'day' : 'endpoint';

  const supabase = createClient();
  const { data, error } = await (supabase.rpc as any)('scanner_usage_aggregate', {
    p_tenant_id: tenantId,
    p_from: from,
    p_to: to,
    p_group_by: groupBy,
  });
  if (error) return c.json({ error: error.message }, 500);

  const rows = (data as any[]) ?? [];

  if (groupBy === 'day') {
    const byDayData = rows.map((r) => ({
      day: r.bucket as string,
      requests: Number(r.requests),
      credits: Number(r.credits),
      errors: Number(r.errors),
      total_duration_ms: Number(r.total_duration_ms),
    }));
    return c.json({ group_by: 'day', data: byDayData });
  }

  // For the endpoint view, overlay billable credits from the ledger.
  const { data: ledgerCredits, error: lcErr } = await (supabase.rpc as any)(
    'scanner_credits_by_endpoint',
    { p_tenant_id: tenantId, p_from: from, p_to: to },
  );
  if (lcErr) return c.json({ error: lcErr.message }, 500);

  const truthByEndpoint = new Map<string, { scans: number; credits: number }>();
  for (const r of (ledgerCredits as any[]) ?? []) {
    truthByEndpoint.set(r.endpoint, { scans: Number(r.scans), credits: Number(r.credits) });
  }

  const byEndpointData = rows.map((r) => {
    const endpoint = `${r.method} ${r.path_template}`;
    const truth = truthByEndpoint.get(endpoint);
    return {
      endpoint,
      requests: Number(r.requests),
      // Ground-truth credits from the ledger when available (billable
      // endpoints); fall back to usage_events for free-read endpoints
      // where there is no ledger row.
      credits: truth ? truth.credits : Number(r.credits),
      errors: Number(r.errors),
      total_duration_ms: Number(r.total_duration_ms),
    };
  });

  return c.json({ group_by: 'endpoint', data: byEndpointData });
});
