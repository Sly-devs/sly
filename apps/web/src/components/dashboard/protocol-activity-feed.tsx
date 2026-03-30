'use client';

import { useQuery } from '@tanstack/react-query';
import { Zap, Shield, ShoppingCart, Globe, Bot, User, Clock, Loader2, ArrowRight } from 'lucide-react';
import { useApiConfig, useApiFetch, type ApiFetchFn } from '@/lib/api-client';
import { cn } from '@sly/ui';
import Link from 'next/link';

type ProtocolId = 'x402' | 'ap2' | 'acp' | 'ucp';

interface RecentActivity {
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

const PROTOCOL_UI: Record<ProtocolId, { icon: typeof Zap; color: string; bgColor: string; name: string }> = {
  x402: {
    icon: Zap,
    name: 'x402',
    color: 'text-yellow-600 dark:text-yellow-400',
    bgColor: 'bg-yellow-100 dark:bg-yellow-950',
  },
  ap2: {
    icon: Shield,
    name: 'AP2',
    color: 'text-blue-600 dark:text-blue-400',
    bgColor: 'bg-blue-100 dark:bg-blue-950',
  },
  acp: {
    icon: ShoppingCart,
    name: 'ACP',
    color: 'text-purple-600 dark:text-purple-400',
    bgColor: 'bg-purple-100 dark:bg-purple-950',
  },
  ucp: {
    icon: Globe,
    name: 'UCP',
    color: 'text-green-600 dark:text-green-400',
    bgColor: 'bg-green-100 dark:bg-green-950',
  },
};

async function fetchRecentActivity(apiFetch: ApiFetchFn, apiUrl: string, limit: number = 10): Promise<{ data: RecentActivity[] }> {
  const response = await apiFetch(
    `${apiUrl}/v1/analytics/recent-activity?limit=${limit}`
  );
  if (!response.ok) {
    throw new Error('Failed to fetch recent activity');
  }
  const json = await response.json();
  // Handle wrapped response format: { success: true, data: {...} }
  return json.data || json;
}

function formatCurrency(amount: number, currency: string): string {
  if (currency === 'USDC' || currency === 'USD') {
    return `$${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return `${amount.toLocaleString()} ${currency}`;
}

function formatTimeAgo(timestamp: string): string {
  const now = new Date();
  const date = new Date(timestamp);
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function ActivityItem({ activity }: { activity: RecentActivity }) {
  const ui = PROTOCOL_UI[activity.protocol];
  const Icon = ui.icon;

  return (
    <div className="flex items-start gap-3 p-3 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-900/50 transition-colors">
      {/* Protocol Icon */}
      <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0', ui.bgColor)}>
        <Icon className={cn('w-4 h-4', ui.color)} />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          {activity.agent ? (
            <div className="flex items-center gap-1.5">
              <Bot className="w-3.5 h-3.5 text-purple-500" />
              <span className="text-sm font-medium text-gray-900 dark:text-white truncate">
                {activity.agent.name}
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <User className="w-3.5 h-3.5 text-gray-400" />
              <span className="text-sm font-medium text-gray-900 dark:text-white">
                Manual
              </span>
            </div>
          )}
          <span className="text-xs text-gray-400">•</span>
          <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
            {ui.name}
          </span>
        </div>

        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-600 dark:text-gray-400 truncate">
            {activity.description}
          </p>
          <span className="text-sm font-semibold text-gray-900 dark:text-white ml-2 flex-shrink-0">
            {formatCurrency(activity.amount, activity.currency)}
          </span>
        </div>
      </div>

      {/* Timestamp */}
      <div className="flex items-center gap-1 text-xs text-gray-400 flex-shrink-0">
        <Clock className="w-3 h-3" />
        {formatTimeAgo(activity.timestamp)}
      </div>
    </div>
  );
}

export function ProtocolActivityFeed() {
  const { authToken, isConfigured, apiEnvironment, apiUrl } = useApiConfig();
  const apiFetch = useApiFetch();

  const { data, isLoading } = useQuery({
    queryKey: ['recent-activity', apiEnvironment],
    queryFn: () => fetchRecentActivity(apiFetch, apiUrl, 8),
    enabled: !!authToken && isConfigured,
    staleTime: 30 * 1000,
    refetchInterval: 60 * 1000, // Auto-refresh every minute
  });

  const activities = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : []);

  return (
    <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-800">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-gray-900 dark:text-white">Recent Activity</h3>
          <Link
            href="/dashboard/transfers"
            className="text-sm text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1"
          >
            View All
            <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>
      </div>

      {/* Activity List */}
      <div className="divide-y divide-gray-100 dark:divide-gray-800">
        {isLoading ? (
          <div className="p-8 flex items-center justify-center">
            <Loader2 className="w-6 h-6 text-gray-400 animate-spin" />
          </div>
        ) : activities.length === 0 ? (
          <div className="p-8 text-center">
            <div className="w-12 h-12 bg-gray-100 dark:bg-gray-800 rounded-full flex items-center justify-center mx-auto mb-3">
              <Clock className="w-6 h-6 text-gray-400" />
            </div>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              No recent activity
            </p>
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
              Transactions will appear here as they happen
            </p>
          </div>
        ) : (
          activities.map((activity) => (
            <ActivityItem key={activity.id} activity={activity} />
          ))
        )}
      </div>
    </div>
  );
}
