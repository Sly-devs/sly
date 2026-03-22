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

export default app;
