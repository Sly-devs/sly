'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PieChart, Zap, Shield, ShoppingCart, Globe, TrendingUp, Hash, Loader2 } from 'lucide-react';
import { useApiConfig, useApiFetch, type ApiFetchFn } from '@/lib/api-client';
import { cn } from '@sly/ui';

type ProtocolId = 'x402' | 'ap2' | 'acp' | 'ucp';
type TimeRange = '24h' | '7d' | '30d';
type Metric = 'volume' | 'count';

interface ProtocolDistribution {
  protocol: ProtocolId;
  volume_usd: number;
  transaction_count: number;
  percentage: number;
}

const PROTOCOL_UI: Record<ProtocolId, { name: string; icon: typeof Zap; color: string; bgColor: string }> = {
  x402: {
    name: 'x402',
    icon: Zap,
    color: 'text-yellow-600 dark:text-yellow-400',
    bgColor: 'bg-yellow-500',
  },
  ap2: {
    name: 'AP2',
    icon: Shield,
    color: 'text-blue-600 dark:text-blue-400',
    bgColor: 'bg-blue-500',
  },
  acp: {
    name: 'ACP',
    icon: ShoppingCart,
    color: 'text-purple-600 dark:text-purple-400',
    bgColor: 'bg-purple-500',
  },
  ucp: {
    name: 'UCP',
    icon: Globe,
    color: 'text-green-600 dark:text-green-400',
    bgColor: 'bg-green-500',
  },
};

const PROTOCOL_COLORS: Record<ProtocolId, string> = {
  x402: '#eab308',
  ap2: '#3b82f6',
  acp: '#a855f7',
  ucp: '#22c55e',
};

async function fetchProtocolDistribution(
  apiFetch: ApiFetchFn,
  apiUrl: string,
  timeRange: TimeRange,
  metric: Metric
): Promise<{ data: ProtocolDistribution[] }> {
  const response = await apiFetch(
    `${apiUrl}/v1/analytics/protocol-distribution?timeRange=${timeRange}&metric=${metric}`
  );
  if (!response.ok) {
    throw new Error('Failed to fetch protocol distribution');
  }
  const json = await response.json();
  // Handle wrapped response format: { success: true, data: {...} }
  return json.data || json;
}

function formatCurrency(value: number): string {
  if (value >= 1000000) {
    return `$${(value / 1000000).toFixed(1)}M`;
  }
  if (value >= 1000) {
    return `$${(value / 1000).toFixed(1)}K`;
  }
  return `$${value.toFixed(2)}`;
}

function formatCount(value: number): string {
  if (value >= 1000000) {
    return `${(value / 1000000).toFixed(1)}M`;
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}K`;
  }
  return value.toString();
}

export function ProtocolStats() {
  const { authToken, isConfigured, apiEnvironment, apiUrl } = useApiConfig();
  const apiFetch = useApiFetch();
  const [timeRange, setTimeRange] = useState<TimeRange>('24h');
  const [metric, setMetric] = useState<Metric>('volume');

  const { data, isLoading, error } = useQuery({
    queryKey: ['protocol-distribution', timeRange, metric, apiEnvironment],
    queryFn: () => fetchProtocolDistribution(apiFetch, apiUrl, timeRange, metric),
    enabled: !!authToken && isConfigured,
    staleTime: 60 * 1000,
  });

  // Handle both wrapped and unwrapped data formats
  const distribution: ProtocolDistribution[] = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : []);
  const totalVolume = distribution.reduce((sum, p) => sum + (p.volume_usd || 0), 0);
  const totalCount = distribution.reduce((sum, p) => sum + (p.transaction_count || 0), 0);
  const activeProtocols = distribution.filter((p) => (p.volume_usd || 0) > 0 || (p.transaction_count || 0) > 0).length;

  // Build conic gradient for donut chart
  const gradientStops: string[] = [];
  let cumulativePercent = 0;
  distribution.forEach((p) => {
    const startPercent = cumulativePercent;
    cumulativePercent += p.percentage;
    gradientStops.push(`${PROTOCOL_COLORS[p.protocol]} ${startPercent}% ${cumulativePercent}%`);
  });

  // Default gradient if no data
  const conicGradient =
    gradientStops.length > 0 && totalVolume > 0
      ? `conic-gradient(${gradientStops.join(', ')})`
      : 'conic-gradient(#e5e7eb 0% 100%)';

  return (
    <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Protocol Distribution</h3>
        <PieChart className="w-5 h-5 text-gray-400" />
      </div>

      {/* Controls */}
      <div className="flex items-center justify-between mb-4">
        {/* Time Range */}
        <div className="flex rounded-lg bg-gray-100 dark:bg-gray-900 p-1">
          {(['24h', '7d', '30d'] as const).map((range) => (
            <button
              key={range}
              onClick={() => setTimeRange(range)}
              className={cn(
                'px-2.5 py-1 text-xs font-medium rounded-md transition-colors',
                timeRange === range
                  ? 'bg-white dark:bg-gray-800 text-gray-900 dark:text-white shadow-sm'
                  : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
              )}
            >
              {range}
            </button>
          ))}
        </div>

        {/* Metric Toggle */}
        <div className="flex rounded-lg bg-gray-100 dark:bg-gray-900 p-1">
          <button
            onClick={() => setMetric('volume')}
            className={cn(
              'p-1.5 rounded-md transition-colors',
              metric === 'volume'
                ? 'bg-white dark:bg-gray-800 text-gray-900 dark:text-white shadow-sm'
                : 'text-gray-500 dark:text-gray-400'
            )}
            title="Volume"
          >
            <TrendingUp className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setMetric('count')}
            className={cn(
              'p-1.5 rounded-md transition-colors',
              metric === 'count'
                ? 'bg-white dark:bg-gray-800 text-gray-900 dark:text-white shadow-sm'
                : 'text-gray-500 dark:text-gray-400'
            )}
            title="Count"
          >
            <Hash className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Donut Chart */}
      <div className="flex items-center justify-center py-4 mb-4 relative">
        {isLoading ? (
          <div className="w-36 h-36 rounded-full flex items-center justify-center bg-gray-100 dark:bg-gray-800">
            <Loader2 className="w-8 h-8 text-gray-400 animate-spin" />
          </div>
        ) : (
          <div
            className="w-36 h-36 rounded-full relative"
            style={{ background: conicGradient }}
          >
            <div className="absolute inset-4 bg-white dark:bg-gray-950 rounded-full flex items-center justify-center flex-col">
              <span className="text-2xl font-bold text-gray-900 dark:text-white">
                {activeProtocols}
              </span>
              <span className="text-xs text-gray-500">
                {activeProtocols === 1 ? 'Protocol' : 'Protocols'}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Total */}
      <div className="text-center mb-4">
        <div className="text-sm text-gray-500 dark:text-gray-400">
          {metric === 'volume' ? 'Total Volume' : 'Total Transactions'}
        </div>
        <div className="text-xl font-bold text-gray-900 dark:text-white">
          {isLoading ? '...' : metric === 'volume' ? formatCurrency(totalVolume) : formatCount(totalCount)}
        </div>
      </div>

      {/* Protocol List */}
      <div className="space-y-3">
        {distribution.map((protocol) => {
          const ui = PROTOCOL_UI[protocol.protocol];
          if (!ui) return null;
          const Icon = ui.icon;
          const value = metric === 'volume' ? protocol.volume_usd : protocol.transaction_count;
          const displayValue = metric === 'volume' ? formatCurrency(value) : formatCount(value);

          return (
            <div key={protocol.protocol} className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div
                  className={cn(
                    'w-8 h-8 rounded-lg flex items-center justify-center',
                    `${ui.bgColor.replace('bg-', 'bg-')}/10`
                  )}
                  style={{ backgroundColor: `${PROTOCOL_COLORS[protocol.protocol]}20` }}
                >
                  <Icon
                    className="w-4 h-4"
                    style={{ color: PROTOCOL_COLORS[protocol.protocol] }}
                  />
                </div>
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  {ui.name}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm text-gray-600 dark:text-gray-400">{displayValue}</span>
                <div className="w-20 h-2 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${protocol.percentage}%`,
                      backgroundColor: PROTOCOL_COLORS[protocol.protocol],
                    }}
                  />
                </div>
                <span className="text-sm text-gray-600 dark:text-gray-400 w-10 text-right">
                  {protocol.percentage}%
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Empty State */}
      {!isLoading && totalVolume === 0 && totalCount === 0 && (
        <div className="text-center py-4 text-gray-500 dark:text-gray-400 text-sm">
          No protocol activity in this period
        </div>
      )}
    </div>
  );
}
