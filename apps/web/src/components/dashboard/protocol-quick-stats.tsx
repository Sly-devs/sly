'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Zap,
  Shield,
  ShoppingCart,
  Globe,
  TrendingUp,
  TrendingDown,
  Minus,
  AlertTriangle,
  Check,
  Wallet,
  CreditCard,
  Loader2,
} from 'lucide-react';
import { useApiConfig, useApiFetch, type ApiFetchFn } from '@/lib/api-client';
import { cn } from '@sly/ui';
import Link from 'next/link';
import { toast } from 'sonner';

type ProtocolId = 'x402' | 'ap2' | 'acp' | 'ucp';

interface ProtocolStats {
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

interface ProtocolEnablementStatus {
  enabled: boolean;
  enabled_at?: string;
  prerequisites_met: boolean;
  missing_prerequisites: string[];
}

interface ProtocolStatusResponse {
  protocols: Record<ProtocolId, ProtocolEnablementStatus>;
}

const PROTOCOL_UI: Record<
  ProtocolId,
  {
    icon: typeof Zap;
    color: string;
    bgColor: string;
    borderColor: string;
    link: string;
    setupLink: string;
    setupLabel: string;
  }
> = {
  x402: {
    icon: Zap,
    color: 'text-yellow-600 dark:text-yellow-400',
    bgColor: 'bg-yellow-100 dark:bg-yellow-950',
    borderColor: 'border-yellow-300 dark:border-yellow-800',
    link: '/dashboard/agentic-payments/x402/endpoints',
    setupLink: '/dashboard/wallets',
    setupLabel: 'Create Wallet',
  },
  ap2: {
    icon: Shield,
    color: 'text-blue-600 dark:text-blue-400',
    bgColor: 'bg-blue-100 dark:bg-blue-950',
    borderColor: 'border-blue-300 dark:border-blue-800',
    link: '/dashboard/agentic-payments/ap2/mandates',
    setupLink: '/dashboard/wallets',
    setupLabel: 'Create Wallet',
  },
  acp: {
    icon: ShoppingCart,
    color: 'text-purple-600 dark:text-purple-400',
    bgColor: 'bg-purple-100 dark:bg-purple-950',
    borderColor: 'border-purple-300 dark:border-purple-800',
    link: '/dashboard/agentic-payments/acp/checkouts',
    setupLink: '/dashboard/payment-handlers',
    setupLabel: 'Connect Handler',
  },
  ucp: {
    icon: Globe,
    color: 'text-green-600 dark:text-green-400',
    bgColor: 'bg-green-100 dark:bg-green-950',
    borderColor: 'border-green-300 dark:border-green-800',
    link: '/dashboard/agentic-payments/ucp/hosted-checkouts',
    setupLink: '/dashboard/payment-handlers',
    setupLabel: 'Connect Handler',
  },
};

async function fetchProtocolStats(apiFetch: ApiFetchFn, apiUrl: string): Promise<ProtocolStats[]> {
  const response = await apiFetch(`${apiUrl}/v1/analytics/protocol-stats`);
  if (!response.ok) {
    throw new Error('Failed to fetch protocol stats');
  }
  const json = await response.json();
  const data = json.data || json;
  return Array.isArray(data) ? data : [];
}

async function fetchProtocolStatus(apiFetch: ApiFetchFn, apiUrl: string): Promise<ProtocolStatusResponse> {
  const response = await apiFetch(`${apiUrl}/v1/organization/protocol-status`);
  if (!response.ok) {
    throw new Error('Failed to fetch protocol status');
  }
  const json = await response.json();
  // Handle wrapped API response format
  return json.data || json;
}

async function toggleProtocol(
  apiFetch: ApiFetchFn,
  apiUrl: string,
  protocolId: ProtocolId,
  enable: boolean
): Promise<void> {
  const action = enable ? 'enable' : 'disable';
  const response = await apiFetch(`${apiUrl}/v1/organization/protocols/${protocolId}/${action}`, {
    method: 'POST',
  });
  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.details?.message || data.error || `Failed to ${action} protocol`);
  }
}

function formatValue(value: number | string): string {
  if (typeof value === 'string') return value;
  if (value >= 1000000) {
    return `$${(value / 1000000).toFixed(1)}M`;
  }
  if (value >= 1000) {
    return `$${(value / 1000).toFixed(1)}K`;
  }
  if (value === Math.floor(value)) {
    return value.toString();
  }
  return `$${value.toFixed(2)}`;
}

function TrendIndicator({ trend }: { trend: ProtocolStats['trend'] }) {
  if (trend.direction === 'up') {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-green-600 dark:text-green-400">
        <TrendingUp className="w-3 h-3" />
        {trend.value}%
      </span>
    );
  }
  if (trend.direction === 'down') {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-red-600 dark:text-red-400">
        <TrendingDown className="w-3 h-3" />
        {trend.value}%
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 dark:text-gray-400">
      <Minus className="w-3 h-3" />
      No change
    </span>
  );
}

function getPrerequisiteInfo(missing: string[]): { icon: typeof Wallet; label: string } {
  if (missing.includes('wallet')) {
    return { icon: Wallet, label: 'Wallet required' };
  }
  if (missing.includes('payment_handler')) {
    return { icon: CreditCard, label: 'Handler required' };
  }
  return { icon: AlertTriangle, label: 'Setup required' };
}

interface ProtocolCardProps {
  stats: ProtocolStats;
  status?: ProtocolEnablementStatus;
  onToggle: (enable: boolean) => void;
  isToggling: boolean;
}

function ProtocolCard({ stats, status, onToggle, isToggling }: ProtocolCardProps) {
  const ui = PROTOCOL_UI[stats.protocol];
  if (!ui) return null;
  const Icon = ui.icon;

  const isEnabled = status?.enabled ?? false;
  const prerequisitesMet = status?.prerequisites_met ?? false;
  const missingPrereqs = status?.missing_prerequisites || [];

  // Show warning state if prerequisites not met
  const showWarning = !prerequisitesMet && missingPrereqs.length > 0;
  const prereqInfo = showWarning ? getPrerequisiteInfo(missingPrereqs) : null;
  const PrereqIcon = prereqInfo?.icon;

  return (
    <div
      className={cn(
        'bg-white dark:bg-gray-950 rounded-2xl p-5 border transition-all relative overflow-hidden',
        isEnabled
          ? `${ui.borderColor} border-2`
          : 'border-gray-200 dark:border-gray-800',
        showWarning && 'border-amber-300 dark:border-amber-700'
      )}
    >
      {/* Enabled indicator strip */}
      {isEnabled && (
        <div className={cn('absolute top-0 left-0 right-0 h-1', ui.bgColor.replace('bg-', 'bg-'))} />
      )}

      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div className={cn('w-10 h-10 rounded-xl flex items-center justify-center', ui.bgColor)}>
          <Icon className={cn('w-5 h-5', ui.color)} />
        </div>

        {/* Status indicator / Toggle */}
        <div className="flex items-center gap-2">
          {showWarning ? (
            <Link
              href={ui.setupLink}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-amber-700 dark:text-amber-400 bg-amber-100 dark:bg-amber-950/50 rounded-lg hover:bg-amber-200 dark:hover:bg-amber-900/50 transition-colors"
            >
              {PrereqIcon && <PrereqIcon className="w-3 h-3" />}
              {ui.setupLabel}
            </Link>
          ) : (
            /* iOS-style toggle switch */
            <button
              onClick={(e) => {
                e.preventDefault();
                onToggle(!isEnabled);
              }}
              disabled={isToggling}
              aria-label={isEnabled ? 'Disable protocol' : 'Enable protocol'}
              className={cn(
                'relative w-11 h-6 rounded-full transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-offset-2',
                isEnabled
                  ? 'bg-emerald-500 focus:ring-emerald-500'
                  : 'bg-gray-300 dark:bg-gray-600 focus:ring-gray-400'
              )}
            >
              {/* Toggle knob */}
              <span
                className={cn(
                  'absolute top-0.5 w-5 h-5 bg-white rounded-full shadow-md transition-transform duration-200 ease-in-out flex items-center justify-center',
                  isEnabled ? 'translate-x-5' : 'translate-x-0.5'
                )}
              >
                {isToggling ? (
                  <Loader2 className="w-3 h-3 text-gray-400 animate-spin" />
                ) : isEnabled ? (
                  <Check className="w-3 h-3 text-emerald-500" />
                ) : null}
              </span>
            </button>
          )}
        </div>
      </div>

      {/* Title + Link */}
      <Link href={ui.link} className="block group">
        <h4 className="text-sm font-semibold text-gray-900 dark:text-white mb-3 truncate group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
          {stats.protocol_name}
        </h4>
      </Link>

      {/* Stats */}
      <div className="space-y-2">
        <div>
          <div className="text-xs text-gray-500 dark:text-gray-400">{stats.primary_metric.label}</div>
          <div className="text-lg font-bold text-gray-900 dark:text-white">
            {formatValue(stats.primary_metric.value)}
          </div>
        </div>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs text-gray-500 dark:text-gray-400">
              {stats.secondary_metric.label}
            </div>
            <div className="text-sm font-medium text-gray-700 dark:text-gray-300">
              {formatValue(stats.secondary_metric.value)}
            </div>
          </div>
          <TrendIndicator trend={stats.trend} />
        </div>
      </div>

    </div>
  );
}

export function ProtocolQuickStats() {
  const { authToken, isConfigured, apiEnvironment, apiUrl } = useApiConfig();
  const apiFetch = useApiFetch();
  const queryClient = useQueryClient();
  const [togglingProtocol, setTogglingProtocol] = useState<ProtocolId | null>(null);

  // Fetch protocol stats
  const { data: statsData, isLoading: statsLoading } = useQuery({
    queryKey: ['protocol-stats', apiEnvironment],
    queryFn: () => fetchProtocolStats(apiFetch, apiUrl),
    enabled: !!authToken && isConfigured,
    staleTime: 60 * 1000,
  });

  // Fetch protocol status
  const { data: statusData, isLoading: statusLoading } = useQuery({
    queryKey: ['protocol-status', apiEnvironment],
    queryFn: () => fetchProtocolStatus(apiFetch, apiUrl),
    enabled: !!authToken && isConfigured,
    staleTime: 30 * 1000,
  });

  // Toggle mutation
  const toggleMutation = useMutation({
    mutationFn: ({ protocolId, enable }: { protocolId: ProtocolId; enable: boolean }) =>
      toggleProtocol(apiFetch, apiUrl, protocolId, enable),
    onMutate: ({ protocolId }) => {
      setTogglingProtocol(protocolId);
    },
    onSuccess: (_, { protocolId, enable }) => {
      queryClient.invalidateQueries({ queryKey: ['protocol-status'] });
      queryClient.invalidateQueries({ queryKey: ['protocol-stats'] });
      const protocolName = PROTOCOL_UI[protocolId].icon === Zap ? 'x402' : protocolId.toUpperCase();
      toast.success(`${protocolName} ${enable ? 'enabled' : 'disabled'}`);
    },
    onError: (error: Error) => {
      toast.error('Failed to update protocol', {
        description: error.message,
      });
    },
    onSettled: () => {
      setTogglingProtocol(null);
    },
  });

  const stats = statsData || [];
  const protocols = statusData?.protocols;
  const isLoading = statsLoading || statusLoading;

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="bg-white dark:bg-gray-950 rounded-2xl p-5 border border-gray-200 dark:border-gray-800 animate-pulse"
          >
            <div className="flex items-start justify-between mb-3">
              <div className="w-10 h-10 bg-gray-200 dark:bg-gray-800 rounded-xl" />
              <div className="w-7 h-7 bg-gray-200 dark:bg-gray-800 rounded-lg" />
            </div>
            <div className="h-4 w-24 bg-gray-200 dark:bg-gray-800 rounded mb-3" />
            <div className="space-y-2">
              <div>
                <div className="h-3 w-16 bg-gray-200 dark:bg-gray-800 rounded mb-1" />
                <div className="h-6 w-12 bg-gray-200 dark:bg-gray-800 rounded" />
              </div>
              <div>
                <div className="h-3 w-20 bg-gray-200 dark:bg-gray-800 rounded mb-1" />
                <div className="h-4 w-16 bg-gray-200 dark:bg-gray-800 rounded" />
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {stats.map((stat) => (
        <ProtocolCard
          key={stat.protocol}
          stats={stat}
          status={protocols?.[stat.protocol]}
          onToggle={(enable) => toggleMutation.mutate({ protocolId: stat.protocol, enable })}
          isToggling={togglingProtocol === stat.protocol}
        />
      ))}
    </div>
  );
}
