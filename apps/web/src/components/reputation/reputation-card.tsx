'use client';

import { useApiClient } from '@/lib/api-client';
import { useQuery } from '@tanstack/react-query';
import { Shield, RefreshCw } from 'lucide-react';

interface ReputationData {
  identifier: string;
  score: number;
  tier: 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
  confidence: 'high' | 'medium' | 'low' | 'none';
  dimensions: {
    name: string;
    score: number;
    weight: number;
    sources: string[];
    dataPoints: number;
  }[];
  dataPoints: number;
  lastRefreshed: string;
  stale: boolean;
}

const TIER_CONFIG: Record<string, { color: string; bg: string; label: string }> = {
  A: { color: 'text-emerald-700 dark:text-emerald-300', bg: 'bg-emerald-100 dark:bg-emerald-900', label: 'Excellent' },
  B: { color: 'text-blue-700 dark:text-blue-300', bg: 'bg-blue-100 dark:bg-blue-900', label: 'Good' },
  C: { color: 'text-amber-700 dark:text-amber-300', bg: 'bg-amber-100 dark:bg-amber-900', label: 'Fair' },
  D: { color: 'text-orange-700 dark:text-orange-300', bg: 'bg-orange-100 dark:bg-orange-900', label: 'Limited' },
  E: { color: 'text-red-700 dark:text-red-300', bg: 'bg-red-100 dark:bg-red-900', label: 'Poor' },
  F: { color: 'text-gray-700 dark:text-gray-300', bg: 'bg-gray-100 dark:bg-gray-800', label: 'Unrated' },
};

const CONFIDENCE_LABELS: Record<string, string> = {
  high: 'High confidence',
  medium: 'Medium confidence',
  low: 'Low confidence',
  none: 'No data',
};

export function ReputationCard({ agentId }: { agentId: string }) {
  const api = useApiClient();

  const { data, isLoading, refetch, isFetching } = useQuery<ReputationData>({
    queryKey: ['reputation', agentId],
    queryFn: async () => {
      if (!api) throw new Error('API not configured');
      const res = await fetch(`${api.baseUrl}/v1/reputation/${agentId}`, {
        headers: { Authorization: `Bearer ${api.apiKey}` },
      });
      if (!res.ok) throw new Error('Failed to fetch reputation');
      return res.json();
    },
    enabled: !!api,
    staleTime: 5 * 60 * 1000,
  });

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
        <div className="animate-pulse space-y-3">
          <div className="h-5 w-32 bg-gray-200 dark:bg-gray-800 rounded" />
          <div className="h-12 w-20 bg-gray-200 dark:bg-gray-800 rounded" />
        </div>
      </div>
    );
  }

  if (!data || data.confidence === 'none') {
    return (
      <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
        <div className="flex items-center gap-2 mb-3">
          <Shield className="h-5 w-5 text-gray-400" />
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Trust Score</h3>
        </div>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          No reputation data available yet. Complete more transactions or A2A tasks to build a trust profile.
        </p>
      </div>
    );
  }

  const tier = TIER_CONFIG[data.tier] || TIER_CONFIG.F;

  return (
    <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Shield className="h-5 w-5 text-gray-400" />
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Trust Score</h3>
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
          title="Refresh reputation"
        >
          <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="flex items-baseline gap-3 mb-3">
        <span className="text-4xl font-bold text-gray-900 dark:text-white">{data.score}</span>
        <span className="text-sm text-gray-400">/1000</span>
        <span className={`px-2 py-0.5 rounded-full text-sm font-medium ${tier.bg} ${tier.color}`}>
          {data.tier} &middot; {tier.label}
        </span>
      </div>

      <div className="flex items-center gap-3 text-sm text-gray-500 dark:text-gray-400 flex-wrap">
        <span>{CONFIDENCE_LABELS[data.confidence]}</span>
        <span>&middot;</span>
        <span>{data.dataPoints} data point{data.dataPoints !== 1 ? 's' : ''}</span>
        {typeof (data as any).ratingCount === 'number' && (data as any).ratingCount > 0 && (
          <>
            <span>&middot;</span>
            <span>{(data as any).ratingCount} rating{(data as any).ratingCount === 1 ? '' : 's'}</span>
          </>
        )}
        {data.stale && (
          <>
            <span>&middot;</span>
            <span className="text-amber-500">Refreshing...</span>
          </>
        )}
      </div>
    </div>
  );
}
