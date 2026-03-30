'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, TrendingUp, Hash, Loader2 } from 'lucide-react';
import { useApiConfig, useApiFetch, type ApiFetchFn } from '@/lib/api-client';
import { cn } from '@sly/ui';

type ProtocolId = 'x402' | 'ap2' | 'acp' | 'ucp';
type TimeRange = '24h' | '7d' | '30d';
type Metric = 'volume' | 'count';

interface ProtocolActivityPoint {
  timestamp: string;
  x402: number;
  ap2: number;
  acp: number;
  ucp: number;
}

const PROTOCOL_COLORS: Record<ProtocolId, string> = {
  x402: '#eab308',
  ap2: '#3b82f6',
  acp: '#a855f7',
  ucp: '#22c55e',
};

const PROTOCOL_NAMES: Record<ProtocolId, string> = {
  x402: 'x402',
  ap2: 'AP2',
  acp: 'ACP',
  ucp: 'UCP',
};

async function fetchProtocolActivity(
  apiFetch: ApiFetchFn,
  apiUrl: string,
  timeRange: TimeRange,
  metric: Metric
): Promise<{ data: ProtocolActivityPoint[] }> {
  const response = await apiFetch(
    `${apiUrl}/v1/analytics/protocol-activity?timeRange=${timeRange}&metric=${metric}`
  );
  if (!response.ok) {
    throw new Error('Failed to fetch protocol activity');
  }
  const json = await response.json();
  // Handle wrapped response format: { success: true, data: {...} }
  return json.data || json;
}

export function ProtocolActivityChart() {
  const { authToken, isConfigured, apiEnvironment, apiUrl } = useApiConfig();
  const apiFetch = useApiFetch();
  const [timeRange, setTimeRange] = useState<TimeRange>('7d');
  const [metric, setMetric] = useState<Metric>('volume');
  const [selectedProtocols, setSelectedProtocols] = useState<ProtocolId[]>(['x402', 'ap2', 'acp', 'ucp']);

  const { data, isLoading } = useQuery({
    queryKey: ['protocol-activity', timeRange, metric, apiEnvironment],
    queryFn: () => fetchProtocolActivity(apiFetch, apiUrl, timeRange, metric),
    enabled: !!authToken && isConfigured,
    staleTime: 60 * 1000,
  });

  const activity = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : []);

  // Calculate max value for scaling
  const maxValue = activity.length > 0
    ? Math.max(
        ...activity.flatMap((point) =>
          selectedProtocols.map((p) => point[p] || 0)
        ),
        1
      )
    : 1;

  // Toggle protocol visibility
  const toggleProtocol = (protocol: ProtocolId) => {
    if (selectedProtocols.includes(protocol)) {
      if (selectedProtocols.length > 1) {
        setSelectedProtocols(selectedProtocols.filter((p) => p !== protocol));
      }
    } else {
      setSelectedProtocols([...selectedProtocols, protocol]);
    }
  };

  // Format timestamp for display
  const formatTimestamp = (timestamp: string) => {
    const date = new Date(timestamp);
    if (timeRange === '24h') {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  };

  return (
    <div className="bg-white dark:bg-gray-950 rounded-2xl p-6 border border-gray-200 dark:border-gray-800">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">Protocol Activity</h3>
          <div className="flex items-center gap-4">
            {(['x402', 'ap2', 'acp', 'ucp'] as const).map((protocol) => (
              <button
                key={protocol}
                onClick={() => toggleProtocol(protocol)}
                className={cn(
                  'flex items-center gap-2 transition-opacity',
                  selectedProtocols.includes(protocol) ? 'opacity-100' : 'opacity-40'
                )}
              >
                <div
                  className="w-3 h-3 rounded-sm"
                  style={{ backgroundColor: PROTOCOL_COLORS[protocol] }}
                />
                <span className="text-sm text-gray-600 dark:text-gray-400">
                  {PROTOCOL_NAMES[protocol]}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
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
              <TrendingUp className="w-4 h-4" />
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
              <Hash className="w-4 h-4" />
            </button>
          </div>

          {/* Time Range */}
          <div className="flex rounded-lg bg-gray-100 dark:bg-gray-900 p-1">
            {(['24h', '7d', '30d'] as const).map((range) => (
              <button
                key={range}
                onClick={() => setTimeRange(range)}
                className={cn(
                  'px-3 py-1.5 text-sm font-medium rounded-md transition-colors',
                  timeRange === range
                    ? 'bg-white dark:bg-gray-800 text-gray-900 dark:text-white shadow-sm'
                    : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
                )}
              >
                {range}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Chart Area */}
      <div className="h-64 relative">
        {isLoading ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader2 className="w-8 h-8 text-gray-400 animate-spin" />
          </div>
        ) : activity.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center text-gray-500 dark:text-gray-400">
            No activity data available
          </div>
        ) : (
          <>
            {/* Y-axis labels */}
            <div className="absolute left-0 top-0 bottom-8 w-16 flex flex-col justify-between text-xs text-gray-500 dark:text-gray-400">
              <span>{metric === 'volume' ? `$${(maxValue / 1000).toFixed(0)}K` : maxValue}</span>
              <span>{metric === 'volume' ? `$${(maxValue * 0.75 / 1000).toFixed(0)}K` : Math.round(maxValue * 0.75)}</span>
              <span>{metric === 'volume' ? `$${(maxValue * 0.5 / 1000).toFixed(0)}K` : Math.round(maxValue * 0.5)}</span>
              <span>{metric === 'volume' ? `$${(maxValue * 0.25 / 1000).toFixed(0)}K` : Math.round(maxValue * 0.25)}</span>
              <span>0</span>
            </div>

            {/* Chart */}
            <div className="ml-16 h-full border-l border-b border-gray-200 dark:border-gray-800 relative">
              {/* Grid lines */}
              {[0, 1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="absolute left-0 right-0 border-t border-dashed border-gray-200 dark:border-gray-800"
                  style={{ top: `${i * 25}%` }}
                />
              ))}

              {/* SVG Chart */}
              <svg className="w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
                {selectedProtocols.map((protocol) => {
                  const points = activity
                    .map((point, i) => {
                      const x = (i / Math.max(activity.length - 1, 1)) * 100;
                      const y = 100 - (point[protocol] / maxValue) * 100;
                      return `${x},${y}`;
                    })
                    .join(' ');

                  return (
                    <polyline
                      key={protocol}
                      points={points}
                      fill="none"
                      stroke={PROTOCOL_COLORS[protocol]}
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  );
                })}
              </svg>
            </div>

            {/* X-axis labels */}
            <div className="ml-16 flex justify-between text-xs text-gray-500 dark:text-gray-400 pt-2">
              {activity.filter((_, i) => i % Math.ceil(activity.length / 5) === 0).map((point, i) => (
                <span key={i}>{formatTimestamp(point.timestamp)}</span>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
