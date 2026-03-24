/**
 * Dashboard Analytics Service
 * Epic 52: Dashboard Redesign - Analytics for agentic payment protocols
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { getCircleFXService } from '../circle/fx.js';

/** Extract the total amount from UCP's JSONB totals array */
function extractUcpTotal(totals: unknown): number {
  if (!Array.isArray(totals)) return 0;
  const entry = totals.find((t: any) => t.type === 'total');
  return Number(entry?.amount || 0) / 100;
}

export type ProtocolId = 'x402' | 'ap2' | 'acp' | 'ucp' | 'mpp';
export type TimeRange = '24h' | '7d' | '30d';

export interface ProtocolDistribution {
  protocol: ProtocolId;
  volume_usd: number;
  transaction_count: number;
  percentage: number;
}

export interface ProtocolActivityPoint {
  timestamp: string;
  x402: number;
  ap2: number;
  acp: number;
  ucp: number;
  mpp: number;
}

export interface ProtocolStats {
  protocol: ProtocolId;
  protocol_name: string;
  enabled: boolean;
  primary_metric: {
    label: string;
    value: number | string;
  };
  secondary_metric: {
    label: string;
    value: number | string;
  };
  trend: {
    value: number;
    direction: 'up' | 'down' | 'flat';
  };
}

export interface RecentActivity {
  id: string;
  protocol: ProtocolId;
  type: string;
  amount: number;
  currency: string;
  description: string;
  agent?: {
    id: string;
    name: string;
  };
  timestamp: string;
}

/**
 * Get protocol distribution by volume or transaction count
 */
export async function getProtocolDistribution(
  supabase: SupabaseClient,
  tenantId: string,
  options: {
    timeRange: TimeRange;
    metric: 'volume' | 'count';
    environment?: 'test' | 'live';
  }
): Promise<ProtocolDistribution[]> {
  const { timeRange, environment } = options;
  const env = environment || 'test';

  // Calculate time boundary
  const now = new Date();
  let startTime: Date;
  switch (timeRange) {
    case '24h':
      startTime = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      break;
    case '7d':
      startTime = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    case '30d':
      startTime = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      break;
  }

  const fxService = getCircleFXService();

  // Query x402 payments (stored as transfers with type = 'x402')
  const { data: x402Data } = await supabase
    .from('transfers')
    .select('amount, currency')
    .eq('tenant_id', tenantId)
    .eq('type', 'x402')
    .eq('environment', env)
    .gte('created_at', startTime.toISOString());

  // Query AP2 mandate executions
  const { data: ap2Data } = await supabase
    .from('ap2_mandate_executions')
    .select('amount, currency')
    .eq('tenant_id', tenantId)
    .eq('environment', env)
    .gte('created_at', startTime.toISOString());

  // Query ACP checkouts (completed)
  const { data: acpData } = await supabase
    .from('acp_checkouts')
    .select('total_amount, currency')
    .eq('tenant_id', tenantId)
    .eq('status', 'completed')
    .eq('environment', env)
    .gte('created_at', startTime.toISOString());

  // Query UCP checkouts (completed) — total is inside JSONB `totals` array
  const { data: ucpData } = await supabase
    .from('ucp_checkout_sessions')
    .select('totals, currency')
    .eq('tenant_id', tenantId)
    .eq('status', 'completed')
    .eq('environment', env)
    .gte('created_at', startTime.toISOString());

  // Query MPP transfers
  const { data: mppData } = await supabase
    .from('transfers')
    .select('amount, currency')
    .eq('tenant_id', tenantId)
    .eq('type', 'mpp')
    .eq('environment', env)
    .gte('created_at', startTime.toISOString());

  // Calculate FX-normalized volumes and counts
  const x402Volume = x402Data?.reduce((sum, p) => {
    const amt = Number(p.amount || 0);
    const ccy = (p.currency || 'USDC').toUpperCase();
    return sum + fxService.toUSD(amt, ccy);
  }, 0) || 0;
  const x402Count = x402Data?.length || 0;

  const ap2Volume = ap2Data?.reduce((sum, e) => {
    const amt = Number(e.amount || 0);
    const ccy = (e.currency || 'USDC').toUpperCase();
    return sum + fxService.toUSD(amt, ccy);
  }, 0) || 0;
  const ap2Count = ap2Data?.length || 0;

  const acpVolume = acpData?.reduce((sum, c) => {
    const amt = Number(c.total_amount || 0);
    const ccy = (c.currency || 'USD').toUpperCase();
    return sum + fxService.toUSD(amt, ccy);
  }, 0) || 0;
  const acpCount = acpData?.length || 0;

  const ucpVolume = ucpData?.reduce((sum, c) => {
    const amt = extractUcpTotal(c.totals);
    const ccy = (c.currency || 'USD').toUpperCase();
    return sum + fxService.toUSD(amt, ccy);
  }, 0) || 0;
  const ucpCount = ucpData?.length || 0;

  const mppVolume = mppData?.reduce((sum, p) => {
    const amt = Number(p.amount || 0);
    const ccy = (p.currency || 'USDC').toUpperCase();
    return sum + fxService.toUSD(amt, ccy);
  }, 0) || 0;
  const mppCount = mppData?.length || 0;

  const totalVolume = x402Volume + ap2Volume + acpVolume + ucpVolume + mppVolume;
  const totalCount = x402Count + ap2Count + acpCount + ucpCount + mppCount;

  // Build distribution array
  const distribution: ProtocolDistribution[] = [
    {
      protocol: 'x402',
      volume_usd: x402Volume,
      transaction_count: x402Count,
      percentage: totalVolume > 0 ? Math.round((x402Volume / totalVolume) * 100) : 0,
    },
    {
      protocol: 'ap2',
      volume_usd: ap2Volume,
      transaction_count: ap2Count,
      percentage: totalVolume > 0 ? Math.round((ap2Volume / totalVolume) * 100) : 0,
    },
    {
      protocol: 'acp',
      volume_usd: acpVolume,
      transaction_count: acpCount,
      percentage: totalVolume > 0 ? Math.round((acpVolume / totalVolume) * 100) : 0,
    },
    {
      protocol: 'ucp',
      volume_usd: ucpVolume,
      transaction_count: ucpCount,
      percentage: totalVolume > 0 ? Math.round((ucpVolume / totalVolume) * 100) : 0,
    },
    {
      protocol: 'mpp',
      volume_usd: mppVolume,
      transaction_count: mppCount,
      percentage: totalVolume > 0 ? Math.round((mppVolume / totalVolume) * 100) : 0,
    },
  ];

  // Sort by volume descending
  distribution.sort((a, b) => b.volume_usd - a.volume_usd);

  return distribution;
}

/**
 * Get protocol activity over time
 */
export async function getProtocolActivity(
  supabase: SupabaseClient,
  tenantId: string,
  options: {
    timeRange: TimeRange;
    metric: 'volume' | 'count';
    environment?: 'test' | 'live';
  }
): Promise<ProtocolActivityPoint[]> {
  const { timeRange, metric, environment } = options;
  const env = environment || 'test';

  // Calculate time boundary and interval
  const now = new Date();
  let startTime: Date;
  let intervalHours: number;
  let points: number;

  switch (timeRange) {
    case '24h':
      startTime = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      intervalHours = 1;
      points = 24;
      break;
    case '7d':
      startTime = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      intervalHours = 6;
      points = 28;
      break;
    case '30d':
      startTime = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      intervalHours = 24;
      points = 30;
      break;
  }

  const fxService = getCircleFXService();

  // Query all protocol data
  const [x402Result, ap2Result, acpResult, ucpResult, mppResult] = await Promise.all([
    supabase
      .from('transfers')
      .select('amount, currency, created_at')
      .eq('tenant_id', tenantId)
      .eq('type', 'x402')
      .eq('environment', env)
      .gte('created_at', startTime.toISOString()),
    supabase
      .from('ap2_mandate_executions')
      .select('amount, currency, created_at')
      .eq('tenant_id', tenantId)
      .eq('environment', env)
      .gte('created_at', startTime.toISOString()),
    supabase
      .from('acp_checkouts')
      .select('total_amount, currency, created_at')
      .eq('tenant_id', tenantId)
      .eq('status', 'completed')
      .eq('environment', env)
      .gte('created_at', startTime.toISOString()),
    supabase
      .from('ucp_checkout_sessions')
      .select('totals, currency, created_at')
      .eq('tenant_id', tenantId)
      .eq('status', 'completed')
      .eq('environment', env)
      .gte('created_at', startTime.toISOString()),
    supabase
      .from('transfers')
      .select('amount, currency, created_at')
      .eq('tenant_id', tenantId)
      .eq('type', 'mpp')
      .eq('environment', env)
      .gte('created_at', startTime.toISOString()),
  ]);

  // Build time buckets
  const activity: ProtocolActivityPoint[] = [];

  for (let i = 0; i < points; i++) {
    const bucketStart = new Date(startTime.getTime() + i * intervalHours * 60 * 60 * 1000);
    const bucketEnd = new Date(bucketStart.getTime() + intervalHours * 60 * 60 * 1000);

    const inBucket = (dateStr: string) => {
      const d = new Date(dateStr);
      return d >= bucketStart && d < bucketEnd;
    };

    const x402InBucket = x402Result.data?.filter((p) => inBucket(p.created_at)) || [];
    const ap2InBucket = ap2Result.data?.filter((e) => inBucket(e.created_at)) || [];
    const acpInBucket = acpResult.data?.filter((c) => inBucket(c.created_at)) || [];
    const ucpInBucket = ucpResult.data?.filter((c) => inBucket(c.created_at)) || [];
    const mppInBucket = mppResult.data?.filter((p) => inBucket(p.created_at)) || [];

    if (metric === 'volume') {
      activity.push({
        timestamp: bucketStart.toISOString(),
        x402: x402InBucket.reduce((sum, p) => sum + fxService.toUSD(Number(p.amount || 0), (p.currency || 'USDC').toUpperCase()), 0),
        ap2: ap2InBucket.reduce((sum, e) => sum + fxService.toUSD(Number(e.amount || 0), (e.currency || 'USDC').toUpperCase()), 0),
        acp: acpInBucket.reduce((sum, c) => sum + fxService.toUSD(Number(c.total_amount || 0), (c.currency || 'USD').toUpperCase()), 0),
        ucp: ucpInBucket.reduce((sum, c) => sum + fxService.toUSD(extractUcpTotal(c.totals), (c.currency || 'USD').toUpperCase()), 0),
        mpp: mppInBucket.reduce((sum, p) => sum + fxService.toUSD(Number(p.amount || 0), (p.currency || 'USDC').toUpperCase()), 0),
      });
    } else {
      activity.push({
        timestamp: bucketStart.toISOString(),
        x402: x402InBucket.length,
        ap2: ap2InBucket.length,
        acp: acpInBucket.length,
        ucp: ucpInBucket.length,
        mpp: mppInBucket.length,
      });
    }
  }

  return activity;
}

/**
 * Get protocol-specific stats for quick stat cards
 */
export async function getProtocolStats(
  supabase: SupabaseClient,
  tenantId: string,
  environment: 'test' | 'live' = 'test'
): Promise<ProtocolStats[]> {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

  // Get protocol enablement status
  const { data: tenant } = await supabase
    .from('tenants')
    .select('settings')
    .eq('id', tenantId)
    .single();

  // enabled_protocols is stored as an object: { x402: { enabled_at: '...' }, ... }
  const enabledProtocols = tenant?.settings?.enabled_protocols || {};
  // Auto-detect: protocol is enabled if explicitly set OR has volume activity
  const isProtocolEnabled = (protocol: string, volume30d: number = 0): boolean => {
    return !!enabledProtocols[protocol] || volume30d > 0;
  };

  const stats: ProtocolStats[] = [];

  const fxService = getCircleFXService();

  // x402 Stats
  const [x402Endpoints, x402Today, x402Yesterday] = await Promise.all([
    supabase
      .from('x402_endpoints')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('status', 'active')
      .eq('environment', environment),
    supabase
      .from('transfers')
      .select('amount, currency')
      .eq('tenant_id', tenantId)
      .eq('type', 'x402')
      .eq('environment', environment)
      .gte('created_at', thirtyDaysAgo.toISOString()),
    supabase
      .from('transfers')
      .select('amount, currency')
      .eq('tenant_id', tenantId)
      .eq('type', 'x402')
      .eq('environment', environment)
      .gte('created_at', sixtyDaysAgo.toISOString())
      .lt('created_at', thirtyDaysAgo.toISOString()),
  ]);

  const x402TodayVolume = x402Today.data?.reduce((sum, p) => sum + fxService.toUSD(Number(p.amount || 0), (p.currency || 'USDC').toUpperCase()), 0) || 0;
  const x402YesterdayVolume = x402Yesterday.data?.reduce((sum, p) => sum + fxService.toUSD(Number(p.amount || 0), (p.currency || 'USDC').toUpperCase()), 0) || 0;
  const x402Trend = x402YesterdayVolume > 0
    ? Math.round(((x402TodayVolume - x402YesterdayVolume) / x402YesterdayVolume) * 100)
    : 0;

  stats.push({
    protocol: 'x402',
    protocol_name: 'x402 Micropayments',
    enabled: isProtocolEnabled('x402', x402TodayVolume),
    primary_metric: {
      label: 'Active Endpoints',
      value: x402Endpoints.data?.length || 0,
    },
    secondary_metric: {
      label: '30d Revenue',
      value: x402TodayVolume,
    },
    trend: {
      value: Math.abs(x402Trend),
      direction: x402Trend > 0 ? 'up' : x402Trend < 0 ? 'down' : 'flat',
    },
  });

  // AP2 Stats
  const [ap2Mandates, ap2Today, ap2Yesterday] = await Promise.all([
    supabase
      .from('ap2_mandates')
      .select('id, authorized_amount, currency')
      .eq('tenant_id', tenantId)
      .eq('status', 'active')
      .eq('environment', environment),
    supabase
      .from('ap2_mandate_executions')
      .select('amount, currency')
      .eq('tenant_id', tenantId)
      .eq('environment', environment)
      .gte('created_at', thirtyDaysAgo.toISOString()),
    supabase
      .from('ap2_mandate_executions')
      .select('amount, currency')
      .eq('tenant_id', tenantId)
      .eq('environment', environment)
      .gte('created_at', sixtyDaysAgo.toISOString())
      .lt('created_at', thirtyDaysAgo.toISOString()),
  ]);

  const authorizedAmount = ap2Mandates.data?.reduce((sum, m) => sum + fxService.toUSD(Number(m.authorized_amount || 0), (m.currency || 'USDC').toUpperCase()), 0) || 0;
  const ap2TodayVolume = ap2Today.data?.reduce((sum, e) => sum + fxService.toUSD(Number(e.amount || 0), (e.currency || 'USDC').toUpperCase()), 0) || 0;
  const ap2YesterdayVolume = ap2Yesterday.data?.reduce((sum, e) => sum + fxService.toUSD(Number(e.amount || 0), (e.currency || 'USDC').toUpperCase()), 0) || 0;
  const ap2Trend = ap2YesterdayVolume > 0
    ? Math.round(((ap2TodayVolume - ap2YesterdayVolume) / ap2YesterdayVolume) * 100)
    : 0;

  stats.push({
    protocol: 'ap2',
    protocol_name: 'AP2 Mandates',
    enabled: isProtocolEnabled('ap2', ap2TodayVolume),
    primary_metric: {
      label: 'Active Mandates',
      value: ap2Mandates.data?.length || 0,
    },
    secondary_metric: {
      label: 'Authorized Amount',
      value: authorizedAmount,
    },
    trend: {
      value: Math.abs(ap2Trend),
      direction: ap2Trend > 0 ? 'up' : ap2Trend < 0 ? 'down' : 'flat',
    },
  });

  // ACP Stats
  const [acpToday, acpYesterday] = await Promise.all([
    supabase
      .from('acp_checkouts')
      .select('total_amount, currency')
      .eq('tenant_id', tenantId)
      .eq('status', 'completed')
      .eq('environment', environment)
      .gte('created_at', thirtyDaysAgo.toISOString()),
    supabase
      .from('acp_checkouts')
      .select('total_amount, currency')
      .eq('tenant_id', tenantId)
      .eq('status', 'completed')
      .eq('environment', environment)
      .gte('created_at', sixtyDaysAgo.toISOString())
      .lt('created_at', thirtyDaysAgo.toISOString()),
  ]);

  const acpTodayVolume = acpToday.data?.reduce((sum, c) => sum + fxService.toUSD(Number(c.total_amount || 0), (c.currency || 'USD').toUpperCase()), 0) || 0;
  const acpYesterdayVolume = acpYesterday.data?.reduce((sum, c) => sum + fxService.toUSD(Number(c.total_amount || 0), (c.currency || 'USD').toUpperCase()), 0) || 0;
  const acpTrend = acpYesterdayVolume > 0
    ? Math.round(((acpTodayVolume - acpYesterdayVolume) / acpYesterdayVolume) * 100)
    : 0;

  stats.push({
    protocol: 'acp',
    protocol_name: 'ACP Commerce',
    enabled: isProtocolEnabled('acp', acpTodayVolume),
    primary_metric: {
      label: 'Checkouts (30d)',
      value: acpToday.data?.length || 0,
    },
    secondary_metric: {
      label: '30d Volume',
      value: acpTodayVolume,
    },
    trend: {
      value: Math.abs(acpTrend),
      direction: acpTrend > 0 ? 'up' : acpTrend < 0 ? 'down' : 'flat',
    },
  });

  // UCP Stats — total is inside JSONB `totals` array
  const [ucpToday, ucpYesterday] = await Promise.all([
    supabase
      .from('ucp_checkout_sessions')
      .select('totals, currency')
      .eq('tenant_id', tenantId)
      .eq('status', 'completed')
      .eq('environment', environment)
      .gte('created_at', thirtyDaysAgo.toISOString()),
    supabase
      .from('ucp_checkout_sessions')
      .select('totals, currency')
      .eq('tenant_id', tenantId)
      .eq('status', 'completed')
      .eq('environment', environment)
      .gte('created_at', sixtyDaysAgo.toISOString())
      .lt('created_at', thirtyDaysAgo.toISOString()),
  ]);

  const ucpTodayVolume = ucpToday.data?.reduce((sum, c) => sum + fxService.toUSD(extractUcpTotal(c.totals), (c.currency || 'USD').toUpperCase()), 0) || 0;
  const ucpYesterdayVolume = ucpYesterday.data?.reduce((sum, c) => sum + fxService.toUSD(extractUcpTotal(c.totals), (c.currency || 'USD').toUpperCase()), 0) || 0;
  const ucpTrend = ucpYesterdayVolume > 0
    ? Math.round(((ucpTodayVolume - ucpYesterdayVolume) / ucpYesterdayVolume) * 100)
    : 0;

  stats.push({
    protocol: 'ucp',
    protocol_name: 'UCP Checkouts',
    enabled: isProtocolEnabled('ucp', ucpTodayVolume),
    primary_metric: {
      label: 'Checkouts (30d)',
      value: ucpToday.data?.length || 0,
    },
    secondary_metric: {
      label: '30d Volume',
      value: ucpTodayVolume,
    },
    trend: {
      value: Math.abs(ucpTrend),
      direction: ucpTrend > 0 ? 'up' : ucpTrend < 0 ? 'down' : 'flat',
    },
  });

  // MPP Stats
  const [mppSessions, mppToday, mppYesterday] = await Promise.all([
    supabase
      .from('mpp_sessions')
      .select('id')
      .eq('tenant_id', tenantId)
      .in('status', ['open', 'active'])
      .eq('environment', environment),
    supabase
      .from('transfers')
      .select('amount, currency')
      .eq('tenant_id', tenantId)
      .eq('type', 'mpp')
      .eq('environment', environment)
      .gte('created_at', thirtyDaysAgo.toISOString()),
    supabase
      .from('transfers')
      .select('amount, currency')
      .eq('tenant_id', tenantId)
      .eq('type', 'mpp')
      .eq('environment', environment)
      .gte('created_at', sixtyDaysAgo.toISOString())
      .lt('created_at', thirtyDaysAgo.toISOString()),
  ]);

  const mppTodayVolume = mppToday.data?.reduce((sum, p) => sum + fxService.toUSD(Number(p.amount || 0), (p.currency || 'USDC').toUpperCase()), 0) || 0;
  const mppYesterdayVolume = mppYesterday.data?.reduce((sum, p) => sum + fxService.toUSD(Number(p.amount || 0), (p.currency || 'USDC').toUpperCase()), 0) || 0;
  const mppTrend = mppYesterdayVolume > 0
    ? Math.round(((mppTodayVolume - mppYesterdayVolume) / mppYesterdayVolume) * 100)
    : 0;

  stats.push({
    protocol: 'mpp',
    protocol_name: 'MPP Payments',
    enabled: isProtocolEnabled('mpp', mppTodayVolume),
    primary_metric: {
      label: 'Active Sessions',
      value: mppSessions.data?.length || 0,
    },
    secondary_metric: {
      label: '30d Volume',
      value: mppTodayVolume,
    },
    trend: {
      value: Math.abs(mppTrend),
      direction: mppTrend > 0 ? 'up' : mppTrend < 0 ? 'down' : 'flat',
    },
  });

  return stats;
}

/**
 * Get recent activity across all protocols
 */
export async function getRecentActivity(
  supabase: SupabaseClient,
  tenantId: string,
  limit: number = 10,
  environment: 'test' | 'live' = 'test'
): Promise<RecentActivity[]> {
  const activities: RecentActivity[] = [];

  // Query recent x402 payments (stored as transfers with type = 'x402')
  const { data: x402 } = await supabase
    .from('transfers')
    .select('id, amount, currency, description, created_at')
    .eq('tenant_id', tenantId)
    .eq('type', 'x402')
    .eq('environment', environment)
    .order('created_at', { ascending: false })
    .limit(limit);

  x402?.forEach((p: any) => {
    activities.push({
      id: p.id,
      protocol: 'x402',
      type: 'payment',
      amount: Number(p.amount),
      currency: p.currency || 'USDC',
      description: p.description || 'x402 API payment',
      timestamp: p.created_at,
    });
  });

  // Query recent AP2 executions
  const { data: ap2 } = await supabase
    .from('ap2_mandate_executions')
    .select('id, amount, currency, created_at')
    .eq('tenant_id', tenantId)
    .eq('environment', environment)
    .order('created_at', { ascending: false })
    .limit(limit);

  ap2?.forEach((e: any) => {
    activities.push({
      id: e.id,
      protocol: 'ap2',
      type: 'mandate_execution',
      amount: Number(e.amount),
      currency: e.currency || 'USDC',
      description: 'Mandate execution',
      timestamp: e.created_at,
    });
  });

  // Query recent ACP checkouts
  const { data: acp } = await supabase
    .from('acp_checkouts')
    .select('id, total_amount, currency, created_at')
    .eq('tenant_id', tenantId)
    .eq('status', 'completed')
    .eq('environment', environment)
    .order('created_at', { ascending: false })
    .limit(limit);

  acp?.forEach((c: any) => {
    activities.push({
      id: c.id,
      protocol: 'acp',
      type: 'checkout',
      amount: Number(c.total_amount),
      currency: c.currency || 'USD',
      description: 'Agent checkout',
      timestamp: c.created_at,
    });
  });

  // Query recent UCP checkouts — total is inside JSONB `totals` array
  const { data: ucp } = await supabase
    .from('ucp_checkout_sessions')
    .select('id, totals, currency, created_at')
    .eq('tenant_id', tenantId)
    .eq('status', 'completed')
    .eq('environment', environment)
    .order('created_at', { ascending: false })
    .limit(limit);

  ucp?.forEach((c: any) => {
    activities.push({
      id: c.id,
      protocol: 'ucp',
      type: 'checkout',
      amount: extractUcpTotal(c.totals),
      currency: c.currency || 'USDC',
      description: 'UCP checkout',
      timestamp: c.created_at,
    });
  });

  // Query recent MPP payments
  const { data: mpp } = await supabase
    .from('transfers')
    .select('id, amount, currency, description, created_at')
    .eq('tenant_id', tenantId)
    .eq('type', 'mpp')
    .eq('environment', environment)
    .order('created_at', { ascending: false })
    .limit(limit);

  mpp?.forEach((p: any) => {
    activities.push({
      id: p.id,
      protocol: 'mpp',
      type: 'payment',
      amount: Number(p.amount),
      currency: p.currency || 'USDC',
      description: p.description || 'MPP payment',
      timestamp: p.created_at,
    });
  });

  // Sort by timestamp and limit
  activities.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  return activities.slice(0, limit);
}
