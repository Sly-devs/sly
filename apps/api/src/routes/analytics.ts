/**
 * Analytics API
 * Epic 52: Dashboard Redesign - Protocol analytics endpoints
 */

import { Hono } from 'hono';
import { createClient } from '../db/client.js';
import { getEnv } from '../utils/helpers.js';
import {
  getProtocolDistribution,
  getProtocolActivity,
  getProtocolStats,
  getRecentActivity,
  TimeRange,
} from '../services/analytics/dashboard.js';
import { createCheckoutTelemetryService } from '../services/telemetry/checkout-telemetry.js';
import { listVendorReputation, getVendorReputation } from '../services/x402/reputation.js';

const app = new Hono();

/**
 * GET /v1/analytics/protocol-distribution
 * Get protocol volume/count distribution
 */
app.get('/protocol-distribution', async (c) => {
  const ctx = c.get('ctx');
  if (!ctx?.tenantId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const timeRange = (c.req.query('timeRange') || '24h') as TimeRange;
  const metric = (c.req.query('metric') || 'volume') as 'volume' | 'count';

  if (!['24h', '7d', '30d'].includes(timeRange)) {
    return c.json({ error: 'Invalid timeRange. Use 24h, 7d, or 30d' }, 400);
  }

  if (!['volume', 'count'].includes(metric)) {
    return c.json({ error: 'Invalid metric. Use volume or count' }, 400);
  }

  try {
    const supabase = createClient();
    const distribution = await getProtocolDistribution(supabase, ctx.tenantId, {
      timeRange,
      metric,
      environment: getEnv(ctx),
    });

    return c.json({ data: distribution });
  } catch (error) {
    console.error('Failed to get protocol distribution:', error);
    return c.json({ error: 'Failed to get protocol distribution' }, 500);
  }
});

/**
 * GET /v1/analytics/protocol-activity
 * Get protocol activity over time
 */
app.get('/protocol-activity', async (c) => {
  const ctx = c.get('ctx');
  if (!ctx?.tenantId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const timeRange = (c.req.query('timeRange') || '24h') as TimeRange;
  const metric = (c.req.query('metric') || 'volume') as 'volume' | 'count';

  if (!['24h', '7d', '30d'].includes(timeRange)) {
    return c.json({ error: 'Invalid timeRange. Use 24h, 7d, or 30d' }, 400);
  }

  if (!['volume', 'count'].includes(metric)) {
    return c.json({ error: 'Invalid metric. Use volume or count' }, 400);
  }

  try {
    const supabase = createClient();
    const activity = await getProtocolActivity(supabase, ctx.tenantId, {
      timeRange,
      metric,
      environment: getEnv(ctx),
    });

    return c.json({ data: activity });
  } catch (error) {
    console.error('Failed to get protocol activity:', error);
    return c.json({ error: 'Failed to get protocol activity' }, 500);
  }
});

/**
 * GET /v1/analytics/protocol-stats
 * Get per-protocol key metrics
 */
app.get('/protocol-stats', async (c) => {
  const ctx = c.get('ctx');
  if (!ctx?.tenantId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  try {
    const supabase = createClient();
    const stats = await getProtocolStats(supabase, ctx.tenantId, getEnv(ctx));

    return c.json({ data: stats });
  } catch (error) {
    console.error('Failed to get protocol stats:', error);
    return c.json({ error: 'Failed to get protocol stats' }, 500);
  }
});

/**
 * GET /v1/analytics/recent-activity
 * Get recent transactions across all protocols
 */
app.get('/recent-activity', async (c) => {
  const ctx = c.get('ctx');
  if (!ctx?.tenantId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const limitParam = c.req.query('limit');
  const limit = limitParam ? parseInt(limitParam, 10) : 10;

  if (isNaN(limit) || limit < 1 || limit > 50) {
    return c.json({ error: 'Invalid limit. Use 1-50' }, 400);
  }

  try {
    const supabase = createClient();
    const activities = await getRecentActivity(supabase, ctx.tenantId, limit, getEnv(ctx));

    return c.json({ data: activities });
  } catch (error) {
    console.error('Failed to get recent activity:', error);
    return c.json({ error: 'Failed to get recent activity' }, 500);
  }
});

/**
 * GET /v1/analytics/checkout-demand
 * Top merchants by checkout attempt volume (Story 56.22)
 */
app.get('/checkout-demand', async (c) => {
  const ctx = c.get('ctx');
  if (!ctx?.tenantId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const limitParam = c.req.query('limit');
  const limit = limitParam ? parseInt(limitParam, 10) : 20;
  const since = c.req.query('since') || undefined;
  const failures_only = c.req.query('failures_only') === 'true';

  if (isNaN(limit) || limit < 1 || limit > 100) {
    return c.json({ error: 'Invalid limit. Use 1-100' }, 400);
  }

  try {
    const supabase = createClient();
    const telemetryService = createCheckoutTelemetryService(supabase);
    const data = await telemetryService.getTopMerchants({ limit, since, failures_only });

    return c.json({ data });
  } catch (error) {
    console.error('Failed to get checkout demand:', error);
    return c.json({ error: 'Failed to get checkout demand' }, 500);
  }
});

// ─── Epic 81: x402 Vendor Reliability ──────────────────────────────────
//
// GET /v1/analytics/x402-vendors?window=7d|30d&env=live|test
//   List all hosts the tenant has tried, with success rates, volume,
//   classification histograms, and a recommendation code.
//
// GET /v1/analytics/x402-vendors/:host?window=7d|30d&env=live|test
//   Single-vendor detail for the given host (normalized lowercased).
//   Returns a synthesized "unknown" row if the tenant has no history.

function parseWindowDays(raw: string | undefined): number {
  // Supported shorthand: "24h", "7d", "30d". Default 30 days.
  if (!raw) return 30;
  const m = raw.match(/^(\d+)(h|d)$/);
  if (!m) return 30;
  const n = parseInt(m[1], 10);
  if (m[2] === 'h') return Math.max(1, Math.ceil(n / 24));
  return Math.min(365, Math.max(1, n));
}

app.get('/x402-vendors', async (c) => {
  const ctx = c.get('ctx');
  if (!ctx?.tenantId) return c.json({ error: 'Unauthorized' }, 401);
  const windowRaw = c.req.query('window');
  const envParam = c.req.query('env');
  const env = envParam === 'live' || envParam === 'test'
    ? envParam
    : (getEnv(ctx) as 'live' | 'test');
  try {
    const supabase = createClient();
    const rows = await listVendorReputation(supabase, ctx.tenantId, {
      sinceDays: parseWindowDays(windowRaw),
      environment: env,
    });
    return c.json({ data: rows });
  } catch (e: any) {
    console.error('x402-vendors list failed:', e);
    return c.json({ error: e.message || 'Failed to list vendor reputation' }, 500);
  }
});

// Ratings — tenants + agents can thumb up/down a vendor with an
// optional note. One rating per (agent, host); rows upsert.
app.post('/x402-vendors/:host/rate', async (c) => {
  const ctx = c.get('ctx');
  if (!ctx?.tenantId) return c.json({ error: 'Unauthorized' }, 401);
  const host = (c.req.param('host') || '').toLowerCase().trim();
  if (!host) return c.json({ error: 'Missing host' }, 400);

  let body: any = {};
  try { body = await c.req.json(); } catch {}
  const thumb = body?.thumb;
  const note = typeof body?.note === 'string' ? body.note.slice(0, 1000) : null;
  if (thumb !== 'up' && thumb !== 'down') {
    return c.json({ error: "thumb must be 'up' or 'down'" }, 400);
  }
  const agentIdScope = ctx.actorType === 'agent' ? ctx.actorId : (body?.agentId ?? null);

  const supabase = createClient();
  // Upsert by the appropriate unique index: agent-scoped or tenant-scoped.
  const existingQuery = agentIdScope
    ? supabase.from('x402_vendor_ratings').select('id')
        .eq('tenant_id', ctx.tenantId).eq('host', host).eq('agent_id', agentIdScope).maybeSingle()
    : supabase.from('x402_vendor_ratings').select('id')
        .eq('tenant_id', ctx.tenantId).eq('host', host).is('agent_id', null).maybeSingle();
  const { data: existing } = await existingQuery as any;

  const rowData: any = {
    tenant_id: ctx.tenantId,
    agent_id: agentIdScope,
    host,
    thumb,
    note,
    rated_by_type: ctx.actorType,
    rated_by_id: ctx.actorId ?? ctx.userId ?? ctx.apiKeyId ?? null,
    rated_by_name: ctx.actorName ?? ctx.userName ?? null,
  };

  let result;
  if (existing?.id) {
    const { data, error } = await (supabase.from('x402_vendor_ratings') as any)
      .update({ thumb, note, rated_by_type: rowData.rated_by_type, rated_by_id: rowData.rated_by_id, rated_by_name: rowData.rated_by_name })
      .eq('id', existing.id)
      .select('*').single();
    if (error) return c.json({ error: error.message }, 500);
    result = data;
  } else {
    const { data, error } = await (supabase.from('x402_vendor_ratings') as any)
      .insert(rowData)
      .select('*').single();
    if (error) return c.json({ error: error.message }, 500);
    result = data;
  }
  return c.json({ data: result });
});

app.get('/x402-vendors/:host/ratings', async (c) => {
  const ctx = c.get('ctx');
  if (!ctx?.tenantId) return c.json({ error: 'Unauthorized' }, 401);
  const host = (c.req.param('host') || '').toLowerCase().trim();
  if (!host) return c.json({ error: 'Missing host' }, 400);
  const supabase = createClient();
  const { data, error } = await supabase
    .from('x402_vendor_ratings')
    .select('*')
    .eq('tenant_id', ctx.tenantId)
    .eq('host', host)
    .order('updated_at', { ascending: false });
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ data: data || [] });
});

app.get('/x402-vendors/:host', async (c) => {
  const ctx = c.get('ctx');
  if (!ctx?.tenantId) return c.json({ error: 'Unauthorized' }, 401);
  const host = c.req.param('host');
  if (!host) return c.json({ error: 'Missing host parameter' }, 400);
  const windowRaw = c.req.query('window');
  const envParam = c.req.query('env');
  const env = envParam === 'live' || envParam === 'test'
    ? envParam
    : (getEnv(ctx) as 'live' | 'test');
  try {
    const supabase = createClient();
    const row = await getVendorReputation(supabase, ctx.tenantId, host, {
      sinceDays: parseWindowDays(windowRaw),
      environment: env,
    });
    return c.json({ data: row });
  } catch (e: any) {
    console.error('x402-vendors detail failed:', e);
    return c.json({ error: e.message || 'Failed to read vendor reputation' }, 500);
  }
});

export default app;
