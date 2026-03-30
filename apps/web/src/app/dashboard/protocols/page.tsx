'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Zap,
  Shield,
  ShoppingCart,
  Globe,
  CheckCircle,
  AlertCircle,
  Lock,
  ExternalLink,
  ToggleLeft,
  ToggleRight,
  Loader2,
  CreditCard
} from 'lucide-react';
import { useApiConfig } from '@/lib/api-client';
import { toast } from 'sonner';
import { cn } from '@sly/ui';
import Link from 'next/link';

// Types
type ProtocolId = 'x402' | 'ap2' | 'acp' | 'ucp';

interface Protocol {
  id: ProtocolId;
  name: string;
  description: string;
  version: string;
  status: 'stable' | 'beta' | 'experimental' | 'deprecated';
  prerequisites: {
    wallet?: boolean;
    paymentHandler?: boolean;
    kyaLevel?: number;
  };
  capabilities: string[];
  docs: {
    overview: string;
    quickstart: string;
    api: string;
  };
}

interface ProtocolEnablementStatus {
  enabled: boolean;
  enabled_at?: string;
  prerequisites_met: boolean;
  missing_prerequisites: string[];
}

interface OrganizationProtocolStatus {
  protocols: Record<ProtocolId, ProtocolEnablementStatus>;
}

// Protocol metadata for UI
const PROTOCOL_UI: Record<ProtocolId, { icon: typeof Zap; color: string; gradient: string }> = {
  x402: {
    icon: Zap,
    color: 'text-yellow-600 dark:text-yellow-400',
    gradient: 'from-yellow-500/10 to-orange-500/10',
  },
  ap2: {
    icon: Shield,
    color: 'text-blue-600 dark:text-blue-400',
    gradient: 'from-blue-500/10 to-indigo-500/10',
  },
  acp: {
    icon: ShoppingCart,
    color: 'text-purple-600 dark:text-purple-400',
    gradient: 'from-purple-500/10 to-pink-500/10',
  },
  ucp: {
    icon: Globe,
    color: 'text-green-600 dark:text-green-400',
    gradient: 'from-green-500/10 to-emerald-500/10',
  },
};

// API functions
async function fetchProtocols(baseUrl: string): Promise<{ data: Protocol[] }> {
  const response = await fetch(`${baseUrl}/v1/protocols`);
  if (!response.ok) {
    throw new Error('Failed to fetch protocols');
  }
  const json = await response.json();
  // Handle wrapped response format: { success: true, data: {...} }
  return json.data || json;
}

async function fetchProtocolStatus(authToken: string, baseUrl: string): Promise<OrganizationProtocolStatus> {
  const response = await fetch(`${baseUrl}/v1/organization/protocol-status`, {
    headers: {
      'Authorization': `Bearer ${authToken}`,
      'Content-Type': 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error('Failed to fetch protocol status');
  }
  const json = await response.json();
  // Handle wrapped response format: { success: true, data: {...} }
  return json.data || json;
}

async function enableProtocol(authToken: string, protocolId: ProtocolId, baseUrl: string): Promise<{ success: boolean; error?: string; missing_prerequisites?: string[] }> {
  const response = await fetch(`${baseUrl}/v1/organization/protocols/${protocolId}/enable`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${authToken}`,
      'Content-Type': 'application/json',
    },
  });
  const json = await response.json();
  // Handle wrapped response format: { success: true, data: {...} }
  return json.data || json;
}

async function disableProtocol(authToken: string, protocolId: ProtocolId, baseUrl: string): Promise<{ success: boolean; error?: string }> {
  const response = await fetch(`${baseUrl}/v1/organization/protocols/${protocolId}/disable`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${authToken}`,
      'Content-Type': 'application/json',
    },
  });
  const json = await response.json();
  // Handle wrapped response format: { success: true, data: {...} }
  return json.data || json;
}

// Prerequisite badge component
function PrerequisiteBadge({ missing }: { missing: string[] }) {
  if (missing.length === 0) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-green-50 dark:bg-green-950 text-green-600 dark:text-green-400">
        <CheckCircle className="w-3.5 h-3.5" />
        Ready
      </span>
    );
  }

  const messages: Record<string, string> = {
    wallet: 'Requires wallet',
    payment_handler: 'Requires payment handler',
    kya_level_1: 'Requires KYA tier 1+',
    kya_level_2: 'Requires KYA tier 2+',
    kya_level_3: 'Requires KYA tier 3',
  };

  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-50 dark:bg-amber-950 text-amber-600 dark:text-amber-400">
      <Lock className="w-3.5 h-3.5" />
      {messages[missing[0]] || missing[0]}
    </span>
  );
}

// Protocol card component
function ProtocolCard({
  protocol,
  status,
  onToggle,
  isToggling,
}: {
  protocol: Protocol;
  status?: ProtocolEnablementStatus;
  onToggle: (enable: boolean) => void;
  isToggling: boolean;
}) {
  const ui = PROTOCOL_UI[protocol.id];
  const Icon = ui.icon;
  const isEnabled = status?.enabled || false;
  const prerequisitesMet = status?.prerequisites_met || false;
  const canEnable = prerequisitesMet && !isEnabled;
  const canDisable = isEnabled;

  return (
    <div className={cn(
      'relative bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 overflow-hidden',
      'hover:border-gray-300 dark:hover:border-gray-700 transition-colors'
    )}>
      {/* Gradient background */}
      <div className={cn('absolute inset-0 bg-gradient-to-br opacity-50', ui.gradient)} />

      <div className="relative p-6">
        {/* Header */}
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className={cn(
              'w-12 h-12 rounded-xl flex items-center justify-center',
              'bg-white dark:bg-gray-900 shadow-sm border border-gray-100 dark:border-gray-800'
            )}>
              <Icon className={cn('w-6 h-6', ui.color)} />
            </div>
            <div>
              <h3 className="font-semibold text-gray-900 dark:text-white">{protocol.name}</h3>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-xs text-gray-500 dark:text-gray-400">v{protocol.version}</span>
                <span className={cn(
                  'px-1.5 py-0.5 rounded text-[10px] font-medium uppercase',
                  protocol.status === 'stable' && 'bg-green-100 dark:bg-green-950 text-green-600 dark:text-green-400',
                  protocol.status === 'beta' && 'bg-blue-100 dark:bg-blue-950 text-blue-600 dark:text-blue-400',
                  protocol.status === 'experimental' && 'bg-amber-100 dark:bg-amber-950 text-amber-600 dark:text-amber-400',
                  protocol.status === 'deprecated' && 'bg-red-100 dark:bg-red-950 text-red-600 dark:text-red-400',
                )}>
                  {protocol.status}
                </span>
              </div>
            </div>
          </div>

          {/* Toggle Button */}
          <button
            onClick={() => onToggle(!isEnabled)}
            disabled={isToggling || (!canEnable && !canDisable) || (!prerequisitesMet && !isEnabled)}
            className={cn(
              'p-2 rounded-lg transition-colors',
              isEnabled
                ? 'text-green-600 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-950/50'
                : prerequisitesMet
                  ? 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
                  : 'text-gray-300 dark:text-gray-600 cursor-not-allowed',
              isToggling && 'opacity-50'
            )}
            title={isEnabled ? 'Disable protocol' : prerequisitesMet ? 'Enable protocol' : 'Prerequisites not met'}
          >
            {isToggling ? (
              <Loader2 className="w-6 h-6 animate-spin" />
            ) : isEnabled ? (
              <ToggleRight className="w-6 h-6" />
            ) : (
              <ToggleLeft className="w-6 h-6" />
            )}
          </button>
        </div>

        {/* Description */}
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4 line-clamp-2">
          {protocol.description}
        </p>

        {/* Status and Prerequisites */}
        <div className="flex items-center justify-between mb-4">
          {isEnabled ? (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-green-50 dark:bg-green-950 text-green-600 dark:text-green-400">
              <CheckCircle className="w-3.5 h-3.5" />
              Enabled
            </span>
          ) : (
            <PrerequisiteBadge missing={status?.missing_prerequisites || []} />
          )}

          {status?.enabled_at && (
            <span className="text-xs text-gray-500 dark:text-gray-400">
              Since {new Date(status.enabled_at).toLocaleDateString()}
            </span>
          )}
        </div>

        {/* Capabilities */}
        <div className="flex flex-wrap gap-1.5 mb-4">
          {protocol.capabilities.slice(0, 4).map((cap) => (
            <span
              key={cap}
              className="px-2 py-0.5 bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 rounded text-xs"
            >
              {cap.replace(/-/g, ' ')}
            </span>
          ))}
          {protocol.capabilities.length > 4 && (
            <span className="px-2 py-0.5 text-gray-400 dark:text-gray-500 text-xs">
              +{protocol.capabilities.length - 4} more
            </span>
          )}
        </div>

        {/* Documentation Links */}
        <div className="flex items-center gap-4 pt-4 border-t border-gray-100 dark:border-gray-800">
          <Link
            href={protocol.docs.overview}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1"
          >
            Docs <ExternalLink className="w-3 h-3" />
          </Link>
          <Link
            href={protocol.docs.quickstart}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1"
          >
            Quickstart <ExternalLink className="w-3 h-3" />
          </Link>
          <Link
            href={protocol.docs.api}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1"
          >
            API <ExternalLink className="w-3 h-3" />
          </Link>
        </div>
      </div>
    </div>
  );
}

// Main page component
export default function ProtocolsPage() {
  const { isConfigured, isLoading: isAuthLoading, authToken, apiUrl } = useApiConfig();
  const queryClient = useQueryClient();
  const [togglingProtocol, setTogglingProtocol] = useState<ProtocolId | null>(null);

  // Fetch protocols (public)
  const { data: protocolsData, isLoading: isLoadingProtocols } = useQuery({
    queryKey: ['protocols'],
    queryFn: () => fetchProtocols(apiUrl),
  });

  // Fetch protocol status (authenticated)
  const { data: statusData, isLoading: isLoadingStatus } = useQuery({
    queryKey: ['protocol-status'],
    queryFn: () => fetchProtocolStatus(authToken!, apiUrl),
    enabled: !!authToken,
  });

  // Enable mutation
  const enableMutation = useMutation({
    mutationFn: (protocolId: ProtocolId) => enableProtocol(authToken!, protocolId, apiUrl),
    onSuccess: (result, protocolId) => {
      if (result.success) {
        queryClient.invalidateQueries({ queryKey: ['protocol-status'] });
        toast.success(`${protocolId.toUpperCase()} protocol enabled`);
      } else {
        if (result.missing_prerequisites) {
          toast.error('Prerequisites not met', {
            description: result.missing_prerequisites.join(', '),
          });
        } else {
          toast.error('Failed to enable protocol', { description: result.error });
        }
      }
      setTogglingProtocol(null);
    },
    onError: (error: Error) => {
      toast.error('Failed to enable protocol', { description: error.message });
      setTogglingProtocol(null);
    },
  });

  // Disable mutation
  const disableMutation = useMutation({
    mutationFn: (protocolId: ProtocolId) => disableProtocol(authToken!, protocolId, apiUrl),
    onSuccess: (result, protocolId) => {
      if (result.success) {
        queryClient.invalidateQueries({ queryKey: ['protocol-status'] });
        toast.success(`${protocolId.toUpperCase()} protocol disabled`);
      } else {
        toast.error('Failed to disable protocol', { description: result.error });
      }
      setTogglingProtocol(null);
    },
    onError: (error: Error) => {
      toast.error('Failed to disable protocol', { description: error.message });
      setTogglingProtocol(null);
    },
  });

  const handleToggle = (protocolId: ProtocolId, enable: boolean) => {
    setTogglingProtocol(protocolId);
    if (enable) {
      enableMutation.mutate(protocolId);
    } else {
      disableMutation.mutate(protocolId);
    }
  };

  // Handle both wrapped and unwrapped data formats
  const protocols = Array.isArray(protocolsData) ? protocolsData : (protocolsData?.data || []);
  const status: Record<ProtocolId, ProtocolEnablementStatus> = statusData?.protocols || {} as Record<ProtocolId, ProtocolEnablementStatus>;

  // Calculate stats
  const statusValues = Object.values(status) as ProtocolEnablementStatus[];
  const enabledCount = statusValues.filter((s) => s.enabled).length;
  const readyCount = statusValues.filter((s) => s.prerequisites_met && !s.enabled).length;

  if (isAuthLoading || isLoadingProtocols) {
    return (
      <div className="p-8 max-w-[1600px] mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">Protocols</h1>
            <p className="text-gray-600 dark:text-gray-400">Manage which payment protocols are enabled for your organization</p>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6 animate-pulse">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-12 h-12 bg-gray-200 dark:bg-gray-800 rounded-xl" />
                <div>
                  <div className="h-5 w-32 bg-gray-200 dark:bg-gray-800 rounded mb-2" />
                  <div className="h-3 w-20 bg-gray-200 dark:bg-gray-800 rounded" />
                </div>
              </div>
              <div className="h-4 w-full bg-gray-200 dark:bg-gray-800 rounded mb-2" />
              <div className="h-4 w-3/4 bg-gray-200 dark:bg-gray-800 rounded" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (!isConfigured) {
    return (
      <div className="p-8">
        <div className="text-center py-12">
          <Globe className="h-12 w-12 text-gray-400 mx-auto mb-4" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Authentication Required</h2>
          <p className="text-gray-500 dark:text-gray-400 mt-2">
            Please log in to manage protocols.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-[1600px] mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">Protocols</h1>
          <p className="text-gray-600 dark:text-gray-400">Manage which payment protocols are enabled for your organization</p>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <div className="bg-white dark:bg-gray-950 rounded-xl border border-gray-200 dark:border-gray-800 p-6">
          <div className="text-sm text-gray-500 dark:text-gray-400 mb-1">Total Protocols</div>
          <div className="text-3xl font-bold text-gray-900 dark:text-white">{protocols.length}</div>
        </div>
        <div className="bg-white dark:bg-gray-950 rounded-xl border border-gray-200 dark:border-gray-800 p-6">
          <div className="text-sm text-gray-500 dark:text-gray-400 mb-1">Enabled</div>
          <div className="text-3xl font-bold text-green-600 dark:text-green-400">{enabledCount}</div>
        </div>
        <div className="bg-white dark:bg-gray-950 rounded-xl border border-gray-200 dark:border-gray-800 p-6">
          <div className="text-sm text-gray-500 dark:text-gray-400 mb-1">Ready to Enable</div>
          <div className="text-3xl font-bold text-blue-600 dark:text-blue-400">{readyCount}</div>
        </div>
      </div>

      {/* Protocol Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {protocols.map((protocol) => (
          <ProtocolCard
            key={protocol.id}
            protocol={protocol}
            status={status[protocol.id as ProtocolId]}
            onToggle={(enable) => handleToggle(protocol.id as ProtocolId, enable)}
            isToggling={togglingProtocol === protocol.id}
          />
        ))}
      </div>

      {/* Help Section */}
      <div className="mt-8 bg-gray-50 dark:bg-gray-900/50 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
        <h3 className="font-semibold text-gray-900 dark:text-white mb-2">Need help getting started?</h3>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          Each protocol has specific prerequisites that must be met before enabling. Common requirements include:
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-lg bg-yellow-100 dark:bg-yellow-950 flex items-center justify-center flex-shrink-0">
              <Zap className="w-4 h-4 text-yellow-600 dark:text-yellow-400" />
            </div>
            <div>
              <div className="font-medium text-gray-900 dark:text-white">x402 & AP2</div>
              <div className="text-gray-500 dark:text-gray-400">Require a USDC wallet for micropayments</div>
              <Link href="/dashboard/wallets" className="text-blue-600 dark:text-blue-400 hover:underline">
                Create wallet &rarr;
              </Link>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-lg bg-purple-100 dark:bg-purple-950 flex items-center justify-center flex-shrink-0">
              <ShoppingCart className="w-4 h-4 text-purple-600 dark:text-purple-400" />
            </div>
            <div>
              <div className="font-medium text-gray-900 dark:text-white">ACP & UCP</div>
              <div className="text-gray-500 dark:text-gray-400">Require a connected payment handler</div>
              <Link href="/dashboard/payment-handlers" className="text-blue-600 dark:text-blue-400 hover:underline">
                Connect handler &rarr;
              </Link>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-lg bg-indigo-100 dark:bg-indigo-950 flex items-center justify-center flex-shrink-0">
              <CreditCard className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
            </div>
            <div>
              <div className="font-medium text-gray-900 dark:text-white">Card Payments</div>
              <div className="text-gray-500 dark:text-gray-400">Enable Visa/Mastercard for agent commerce</div>
              <Link href="/dashboard/card-networks" className="text-blue-600 dark:text-blue-400 hover:underline">
                Configure cards &rarr;
              </Link>
            </div>
          </div>
        </div>
      </div>

      {/* Payment Methods Info */}
      <div className="mt-4 bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
        <h3 className="font-semibold text-gray-900 dark:text-white mb-4">Payment Methods by Protocol</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-800">
                <th className="text-left py-2 px-3 text-gray-500 dark:text-gray-400 font-medium">Protocol</th>
                <th className="text-center py-2 px-3 text-gray-500 dark:text-gray-400 font-medium">USDC</th>
                <th className="text-center py-2 px-3 text-gray-500 dark:text-gray-400 font-medium">Pix/SPEI</th>
                <th className="text-center py-2 px-3 text-gray-500 dark:text-gray-400 font-medium">Visa</th>
                <th className="text-center py-2 px-3 text-gray-500 dark:text-gray-400 font-medium">Mastercard</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-gray-100 dark:border-gray-800/50">
                <td className="py-2 px-3 font-medium text-gray-900 dark:text-white">x402</td>
                <td className="py-2 px-3 text-center"><CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400 mx-auto" /></td>
                <td className="py-2 px-3 text-center text-gray-400">-</td>
                <td className="py-2 px-3 text-center text-gray-400">-</td>
                <td className="py-2 px-3 text-center text-gray-400">-</td>
              </tr>
              <tr className="border-b border-gray-100 dark:border-gray-800/50">
                <td className="py-2 px-3 font-medium text-gray-900 dark:text-white">AP2</td>
                <td className="py-2 px-3 text-center"><CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400 mx-auto" /></td>
                <td className="py-2 px-3 text-center"><CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400 mx-auto" /></td>
                <td className="py-2 px-3 text-center"><span title="Fallback"><AlertCircle className="h-4 w-4 text-yellow-500 mx-auto" /></span></td>
                <td className="py-2 px-3 text-center"><span title="Fallback"><AlertCircle className="h-4 w-4 text-yellow-500 mx-auto" /></span></td>
              </tr>
              <tr className="border-b border-gray-100 dark:border-gray-800/50">
                <td className="py-2 px-3 font-medium text-gray-900 dark:text-white">ACP</td>
                <td className="py-2 px-3 text-center"><CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400 mx-auto" /></td>
                <td className="py-2 px-3 text-center"><CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400 mx-auto" /></td>
                <td className="py-2 px-3 text-center"><CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400 mx-auto" /></td>
                <td className="py-2 px-3 text-center"><CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400 mx-auto" /></td>
              </tr>
              <tr>
                <td className="py-2 px-3 font-medium text-gray-900 dark:text-white">UCP</td>
                <td className="py-2 px-3 text-center"><CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400 mx-auto" /></td>
                <td className="py-2 px-3 text-center"><CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400 mx-auto" /></td>
                <td className="py-2 px-3 text-center"><CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400 mx-auto" /></td>
                <td className="py-2 px-3 text-center"><CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400 mx-auto" /></td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
          <CheckCircle className="h-3 w-3 text-green-600 dark:text-green-400 inline mr-1" />
          Full support
          <span className="mx-2">|</span>
          <AlertCircle className="h-3 w-3 text-yellow-500 inline mr-1" />
          Fallback option
          <span className="mx-2">|</span>
          <span className="text-gray-400">- Not available</span>
        </p>
      </div>
    </div>
  );
}
