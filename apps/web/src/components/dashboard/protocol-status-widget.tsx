'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useApiConfig, useApiFetch, type ApiFetchFn } from '@/lib/api-client';
import {
  Zap,
  Shield,
  ShoppingCart,
  Globe,
  DollarSign,
  Check,
  X,
  AlertCircle,
  ExternalLink,
  Loader2,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@sly/ui';

// Protocol configuration with icons and colors
const PROTOCOL_CONFIG = {
  x402: {
    name: 'x402 Micropayments',
    icon: Zap,
    color: 'text-yellow-600 dark:text-yellow-400',
    bgColor: 'bg-yellow-100 dark:bg-yellow-950',
    borderColor: 'border-yellow-200 dark:border-yellow-800',
    description: 'HTTP 402 for API monetization',
  },
  ap2: {
    name: 'AP2 Agent Payments',
    icon: Shield,
    color: 'text-blue-600 dark:text-blue-400',
    bgColor: 'bg-blue-100 dark:bg-blue-950',
    borderColor: 'border-blue-200 dark:border-blue-800',
    description: 'Mandate-based agent payments',
  },
  acp: {
    name: 'Agent Commerce',
    icon: ShoppingCart,
    color: 'text-purple-600 dark:text-purple-400',
    bgColor: 'bg-purple-100 dark:bg-purple-950',
    borderColor: 'border-purple-200 dark:border-purple-800',
    description: 'Stripe/OpenAI checkout',
  },
  ucp: {
    name: 'Universal Commerce',
    icon: Globe,
    color: 'text-green-600 dark:text-green-400',
    bgColor: 'bg-green-100 dark:bg-green-950',
    borderColor: 'border-green-200 dark:border-green-800',
    description: 'Google+Shopify standard',
  },
  mpp: {
    name: 'Machine Payments',
    icon: DollarSign,
    color: 'text-orange-600 dark:text-orange-400',
    bgColor: 'bg-orange-100 dark:bg-orange-950',
    borderColor: 'border-orange-200 dark:border-orange-800',
    description: 'HTTP 402 machine-to-machine payments',
  },
} as const;

type ProtocolId = keyof typeof PROTOCOL_CONFIG;

interface ProtocolEnablementStatus {
  enabled: boolean;
  enabled_at?: string;
  prerequisites_met: boolean;
  missing_prerequisites: string[];
}

interface ProtocolStatusResponse {
  protocols: Record<ProtocolId, ProtocolEnablementStatus>;
}

async function fetchProtocolStatus(apiFetch: ApiFetchFn, apiUrl: string): Promise<ProtocolStatusResponse> {
  const response = await apiFetch(`${apiUrl}/v1/organization/protocol-status`);
  if (!response.ok) {
    throw new Error('Failed to fetch protocol status');
  }
  return response.json();
}

async function toggleProtocol(
  apiFetch: ApiFetchFn,
  apiUrl: string,
  protocolId: ProtocolId,
  enable: boolean
): Promise<void> {
  const action = enable ? 'enable' : 'disable';
  const response = await apiFetch(
    `${apiUrl}/v1/organization/protocols/${protocolId}/${action}`,
    {
      method: 'POST',
    }
  );
  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.details?.message || data.error || `Failed to ${action} protocol`);
  }
}

function getPrerequisiteLabel(prereq: string): string {
  switch (prereq) {
    case 'wallet':
      return 'USDC wallet required';
    case 'payment_handler':
      return 'Payment handler required';
    default:
      return prereq;
  }
}

export function ProtocolStatusWidget() {
  const { authToken, isConfigured, apiEnvironment, apiUrl } = useApiConfig();
  const apiFetch = useApiFetch();
  const queryClient = useQueryClient();
  const [togglingProtocol, setTogglingProtocol] = useState<ProtocolId | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['protocol-status', apiEnvironment],
    queryFn: () => fetchProtocolStatus(apiFetch, apiUrl),
    enabled: !!authToken && isConfigured,
    staleTime: 30 * 1000,
  });

  const toggleMutation = useMutation({
    mutationFn: ({ protocolId, enable }: { protocolId: ProtocolId; enable: boolean }) =>
      toggleProtocol(apiFetch, apiUrl, protocolId, enable),
    onMutate: ({ protocolId }) => {
      setTogglingProtocol(protocolId);
    },
    onSuccess: (_, { protocolId, enable }) => {
      queryClient.invalidateQueries({ queryKey: ['protocol-status'] });
      toast.success(`${PROTOCOL_CONFIG[protocolId].name} ${enable ? 'enabled' : 'disabled'}`);
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

  const handleToggle = (protocolId: ProtocolId, currentEnabled: boolean, prerequisitesMet: boolean) => {
    if (!currentEnabled && !prerequisitesMet) {
      toast.error('Prerequisites not met', {
        description: `Cannot enable ${PROTOCOL_CONFIG[protocolId].name} - missing requirements`,
      });
      return;
    }
    toggleMutation.mutate({ protocolId, enable: !currentEnabled });
  };

  if (!isConfigured) {
    return null;
  }

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Protocol Status</h3>
        <div className="space-y-3">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-14 bg-gray-100 dark:bg-gray-800 rounded-xl animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Protocol Status</h3>
        <div className="text-center py-4 text-gray-500 dark:text-gray-400">
          <AlertCircle className="h-8 w-8 mx-auto mb-2 text-gray-400" />
          <p className="text-sm">Failed to load protocol status</p>
        </div>
      </div>
    );
  }

  const protocols = data?.protocols;
  const enabledCount = protocols
    ? Object.values(protocols).filter((p) => p.enabled).length
    : 0;

  return (
    <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Protocol Status</h3>
        <span className="text-sm text-gray-500 dark:text-gray-400">
          {enabledCount}/{Object.keys(PROTOCOL_CONFIG).length} enabled
        </span>
      </div>

      <div className="space-y-3">
        {(Object.keys(PROTOCOL_CONFIG) as ProtocolId[]).map((protocolId) => {
          const config = PROTOCOL_CONFIG[protocolId];
          const status = protocols?.[protocolId];
          const Icon = config.icon;
          const isToggling = togglingProtocol === protocolId;
          const enabled = status?.enabled ?? false;
          const prerequisitesMet = status?.prerequisites_met ?? false;

          return (
            <div
              key={protocolId}
              className={cn(
                'flex items-center gap-3 p-3 rounded-xl border transition-all',
                enabled
                  ? `${config.bgColor} ${config.borderColor}`
                  : 'bg-gray-50 dark:bg-gray-900 border-gray-100 dark:border-gray-800'
              )}
            >
              {/* Icon */}
              <div
                className={cn(
                  'w-10 h-10 rounded-lg flex items-center justify-center',
                  enabled ? 'bg-white/50 dark:bg-black/20' : 'bg-gray-200 dark:bg-gray-700'
                )}
              >
                <Icon
                  className={cn('h-5 w-5', enabled ? config.color : 'text-gray-400 dark:text-gray-500')}
                />
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      'font-medium text-sm',
                      enabled ? 'text-gray-900 dark:text-white' : 'text-gray-600 dark:text-gray-400'
                    )}
                  >
                    {config.name}
                  </span>
                  {!prerequisitesMet && !enabled && (
                    <span className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1">
                      <AlertCircle className="h-3 w-3" />
                      Missing
                    </span>
                  )}
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-500 truncate">
                  {!prerequisitesMet && status?.missing_prerequisites?.length
                    ? getPrerequisiteLabel(status.missing_prerequisites[0])
                    : config.description}
                </p>
              </div>

              {/* Toggle */}
              <button
                onClick={() => handleToggle(protocolId, enabled, prerequisitesMet)}
                disabled={isToggling || (!enabled && !prerequisitesMet)}
                className={cn(
                  'w-8 h-8 rounded-lg flex items-center justify-center transition-all',
                  enabled
                    ? 'bg-emerald-500 text-white hover:bg-emerald-600'
                    : prerequisitesMet
                    ? 'bg-gray-200 dark:bg-gray-700 text-gray-500 hover:bg-gray-300 dark:hover:bg-gray-600'
                    : 'bg-gray-100 dark:bg-gray-800 text-gray-300 dark:text-gray-600 cursor-not-allowed'
                )}
              >
                {isToggling ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : enabled ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <X className="h-4 w-4" />
                )}
              </button>
            </div>
          );
        })}
      </div>

      {/* Docs link */}
      <a
        href="https://docs.payos.com/protocols"
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center justify-center gap-1.5 mt-4 text-sm text-blue-600 dark:text-blue-400 hover:underline"
      >
        <span>Protocol Documentation</span>
        <ExternalLink className="h-3.5 w-3.5" />
      </a>
    </div>
  );
}
