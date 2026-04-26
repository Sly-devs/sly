'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useApiClient, useApiConfig, useApiFetch } from '@/lib/api-client';
import Link from 'next/link';
import { LobsterClaw } from '@/components/icons/lobster-claw';
import {
  ArrowLeft,
  Bot,
  Building2,
  Shield,
  Activity,
  Key,
  History,
  MoreVertical,
  CheckCircle,
  CheckCircle2,
  XCircle,
  Pause,
  Play,
  RefreshCw,
  Copy,
  AlertTriangle,
  FileText,
  ShoppingCart,
  Trash2,
  Network,
  CreditCard,
  Wallet,
  Star,
  ThumbsUp,
  ThumbsDown,
  ExternalLink,
} from 'lucide-react';
import { useQuery as useTanstackQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { Agent, Stream, AgentLimits } from '@sly/api-client';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { AvatarUpload } from '@/components/agents/avatar-upload';
import {
  Badge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@sly/ui';
import { AgentActivityFeed } from '@/components/agents/agent-activity-feed';
import { AgentQuickActions } from '@/components/agents/agent-quick-actions';
import { ConfigureAgentDialog } from '@/components/agents/configure-agent-dialog';
import { KyaTierBadge } from '@/components/agents/kya-tier-badge';
import { WalletTab } from '@/components/agents/wallet-tab';
import type { AgentAction } from '@/lib/mock-data/agent-activity';
import { formatCurrency } from '@/lib/utils';
import { format } from 'date-fns';

type TabType = 'overview' | 'streams' | 'mandates' | 'checkouts' | 'a2a' | 'wallet' | 'ratings' | 'permissions' | 'kya' | 'scopes' | 'activity';

function getAgentIcon(agentName: string) {
  if (agentName.includes('Inference API Consumer')) {
    return {
      Icon: LobsterClaw,
      bgColor: 'bg-orange-100 dark:bg-orange-950',
      textColor: 'text-orange-600 dark:text-orange-400',
    };
  }
  return {
    Icon: Bot,
    bgColor: 'bg-blue-100 dark:bg-blue-950',
    textColor: 'text-blue-600 dark:text-blue-400',
  };
}

export default function AgentDetailPage() {
  const params = useParams();
  const router = useRouter();
  const api = useApiClient();
  const { apiUrl } = useApiConfig();
  const agentId = params.id as string;

  const [agent, setAgent] = useState<Agent | null>(null);
  const [streams, setStreams] = useState<Stream[]>([]);
  const [limits, setLimits] = useState<AgentLimits | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabType>('overview');
  const [actionLoading, setActionLoading] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [configureOpen, setConfigureOpen] = useState(false);

  useEffect(() => {
    async function fetchData() {
      if (!api) return;

      try {
        const [agentData, streamsData, limitsData] = await Promise.all([
          api.agents.get(agentId),
          api.agents.getStreams(agentId, { limit: 50 }),
          api.agents.getLimits(agentId),
        ]);

        // Handle potential double-nesting for agent data
        const rawAgent = agentData as any;
        const processedAgent = rawAgent.data?.data || rawAgent.data || rawAgent;
        setAgent(processedAgent);

        // Handle both array and object responses for streams
        const rawStreams = streamsData?.data;
        const streamsArray = Array.isArray(rawStreams) ? rawStreams : (Array.isArray((rawStreams as any)?.data) ? (rawStreams as any).data : []);
        setStreams(streamsArray);

        // Handle limits nesting if needed
        const rawLimits = limitsData as any;
        setLimits(rawLimits.data?.data || rawLimits.data || rawLimits);
      } catch (error) {
        console.error('Failed to fetch agent:', error);
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, [api, agentId]);

  const handleVerify = async (tier: number) => {
    if (!api || !agent) return;
    setActionLoading(true);
    try {
      const updated = await api.agents.verify(agentId, tier);
      setAgent(updated);
    } catch (error) {
      console.error('Failed to verify agent:', error);
    } finally {
      setActionLoading(false);
    }
  };

  const handleSuspend = async () => {
    if (!api || !agent) return;
    setActionLoading(true);
    try {
      const updated = await api.agents.suspend(agentId);
      setAgent(updated);
    } catch (error) {
      console.error('Failed to suspend agent:', error);
    } finally {
      setActionLoading(false);
    }
  };

  const handleActivate = async () => {
    if (!api || !agent) return;
    setActionLoading(true);
    try {
      const updated = await api.agents.activate(agentId);
      setAgent(updated);
    } catch (error) {
      console.error('Failed to activate agent:', error);
    } finally {
      setActionLoading(false);
    }
  };

  const handleRotateToken = async () => {
    if (!api || !agent) return;
    if (!confirm('Are you sure you want to rotate the token? The current token will be revoked.')) return;

    setActionLoading(true);
    try {
      const result = await api.agents.rotateToken(agentId);
      setNewToken(result.credentials.token);
    } catch (error) {
      console.error('Failed to rotate token:', error);
    } finally {
      setActionLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!api || !agent) return;
    if (!confirm('Are you sure you want to delete this agent? This cannot be undone.')) return;

    setActionLoading(true);
    try {
      await api.agents.delete(agentId);
      router.push('/dashboard/agents');
    } catch (error) {
      alert(`Failed to delete agent: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setActionLoading(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  if (loading) {
    return (
      <div className="p-8">
        <div className="animate-pulse">
          <div className="h-8 w-48 bg-gray-200 dark:bg-gray-800 rounded mb-4"></div>
          <div className="h-4 w-96 bg-gray-200 dark:bg-gray-800 rounded mb-8"></div>
          <div className="grid grid-cols-4 gap-4 mb-8">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-24 bg-gray-200 dark:bg-gray-800 rounded-xl"></div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="p-8 text-center">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Agent not found</h2>
        <Link href="/dashboard/agents" className="text-blue-600 hover:underline mt-4 inline-block">
          Back to agents
        </Link>
      </div>
    );
  }

  const tabs = [
    { id: 'overview' as TabType, label: 'Overview', icon: Bot },
    { id: 'streams' as TabType, label: 'Streams', icon: Activity, count: Array.isArray(streams) ? streams.length : 0 },
    { id: 'mandates' as TabType, label: 'Mandates', icon: FileText },
    { id: 'checkouts' as TabType, label: 'Checkouts', icon: ShoppingCart },
    { id: 'a2a' as TabType, label: 'A2A', icon: Network },
    { id: 'wallet' as TabType, label: 'Wallet', icon: Wallet },
    { id: 'ratings' as TabType, label: 'Ratings', icon: Star },
    { id: 'permissions' as TabType, label: 'Permissions', icon: Key },
    { id: 'kya' as TabType, label: 'KYA', icon: Shield },
    { id: 'scopes' as TabType, label: 'Scopes', icon: Shield },
    { id: 'activity' as TabType, label: 'Activity', icon: History },
  ];

  return (
    <div className="p-8 max-w-[1600px] mx-auto">
      {/* New Token Alert */}
      {newToken && (
        <div className="mb-6 bg-yellow-50 dark:bg-yellow-950 border border-yellow-200 dark:border-yellow-800 rounded-xl p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-yellow-600 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <h4 className="text-sm font-semibold text-yellow-800 dark:text-yellow-200">
                New Token Generated
              </h4>
              <p className="text-sm text-yellow-700 dark:text-yellow-300 mt-1">
                Save this token now. It will not be shown again!
              </p>
              <div className="mt-2 flex items-center gap-2">
                <code className="flex-1 px-3 py-2 bg-yellow-100 dark:bg-yellow-900 rounded font-mono text-sm break-all">
                  {newToken}
                </code>
                <button
                  onClick={() => copyToClipboard(newToken)}
                  className="p-2 hover:bg-yellow-200 dark:hover:bg-yellow-800 rounded"
                >
                  <Copy className="h-4 w-4 text-yellow-700" />
                </button>
              </div>
            </div>
            <button
              onClick={() => setNewToken(null)}
              className="text-yellow-600 hover:text-yellow-800"
            >
              ×
            </button>
          </div>
        </div>
      )}

      {/* Back button */}
      <Link
        href="/dashboard/agents"
        className="inline-flex items-center gap-2 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white mb-6"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to agents
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between mb-8">
        <div className="flex items-center gap-4">
          <AgentAvatar agent={agent as any} size="lg" />
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{agent.name}</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              {agent.description || 'No description'}
            </p>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-3">
          {/* Quick Actions */}
          <AgentQuickActions
            agent={{ id: agent.id, name: agent.name, status: agent.status }}
            onConfigure={() => setConfigureOpen(true)}
          />
          <ConfigureAgentDialog
            agent={agent}
            limits={limits}
            open={configureOpen}
            onOpenChange={setConfigureOpen}
            onSuccess={async () => {
              if (!api) return;
              const [agentData, limitsData] = await Promise.all([
                api.agents.get(agentId),
                api.agents.getLimits(agentId),
              ]);
              const raw = agentData as any;
              setAgent(raw.data?.data || raw.data || raw);
              const rawL = limitsData as any;
              setLimits(rawL.data?.data || rawL.data || rawL);
            }}
          />

          <AgentReadinessPill agentId={agent.id} agentStatus={agent.status} kyaTier={agent.kyaTier} />

          <span className={`px-3 py-1.5 text-sm font-medium rounded-full ${agent.status === 'active'
            ? 'bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-400'
            : agent.status === 'paused'
              ? 'bg-yellow-100 dark:bg-yellow-950 text-yellow-700 dark:text-yellow-400'
              : 'bg-red-100 dark:bg-red-950 text-red-700 dark:text-red-400'
            }`}>
            {agent.status}
          </span>

          <div className="relative group">
            <button className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg">
              <MoreVertical className="h-5 w-5 text-gray-500" />
            </button>
            <div className="absolute right-0 top-full mt-1 w-48 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg shadow-lg opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-10">
              {agent.status !== 'active' && (
                <button
                  onClick={handleActivate}
                  disabled={actionLoading}
                  className="w-full px-4 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-800 flex items-center gap-2"
                >
                  <Play className="h-4 w-4 text-emerald-500" />
                  Activate Agent
                </button>
              )}
              {agent.status === 'active' && (
                <button
                  onClick={handleSuspend}
                  disabled={actionLoading}
                  className="w-full px-4 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-800 flex items-center gap-2 text-red-600"
                >
                  <Pause className="h-4 w-4" />
                  Suspend Agent
                </button>
              )}
              <hr className="my-1 border-gray-200 dark:border-gray-800" />
              <button
                onClick={() => handleVerify(1)}
                disabled={actionLoading}
                className="w-full px-4 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-800 flex items-center gap-2"
              >
                <CheckCircle className="h-4 w-4 text-blue-500" />
                Set KYA Tier 1
              </button>
              <button
                onClick={() => handleVerify(2)}
                disabled={actionLoading}
                className="w-full px-4 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-800 flex items-center gap-2"
              >
                <CheckCircle className="h-4 w-4 text-blue-500" />
                Set KYA Tier 2
              </button>
              <button
                onClick={() => handleVerify(3)}
                disabled={actionLoading}
                className="w-full px-4 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-800 flex items-center gap-2"
              >
                <CheckCircle className="h-4 w-4 text-blue-500" />
                Set KYA Tier 3
              </button>
              <hr className="my-1 border-gray-200 dark:border-gray-800" />
              <button
                onClick={handleRotateToken}
                disabled={actionLoading}
                className="w-full px-4 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-800 flex items-center gap-2 text-orange-600"
              >
                <RefreshCw className="h-4 w-4" />
                Rotate Token
              </button>
              <hr className="my-1 border-gray-200 dark:border-gray-800" />
              <button
                onClick={handleDelete}
                disabled={actionLoading}
                className="w-full px-4 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-800 flex items-center gap-2 text-red-600"
              >
                <Trash2 className="h-4 w-4" />
                Delete Agent
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
        <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-5">
          <div className="text-sm text-gray-500 dark:text-gray-400 mb-1">Daily Limit</div>
          {(() => {
            const dailyLimit = limits?.effectiveLimits?.daily || 0;
            const dailyUsed = limits?.usage?.daily || 0;
            const remaining = Math.max(0, dailyLimit - dailyUsed);
            const pct = dailyLimit ? (dailyUsed / dailyLimit) * 100 : 0;
            const color = pct >= 90 ? 'text-red-600 dark:text-red-400' : pct >= 70 ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400';
            const barColor = pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-500' : 'bg-emerald-500';
            return (
              <>
                <div className={`text-2xl font-bold ${color}`}>
                  ${remaining.toLocaleString()}<span className="text-base text-gray-400">/${dailyLimit.toLocaleString()}</span>
                </div>
                <div className="h-1.5 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden mt-2">
                  <div className={`h-full rounded-full ${barColor}`} style={{ width: `${Math.min(pct, 100)}%` }} />
                </div>
                <div className="text-xs text-gray-400 mt-1">remaining</div>
              </>
            );
          })()}
        </div>
        <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-5">
          <div className="text-sm text-gray-500 dark:text-gray-400 mb-1">Total Transactions</div>
          <div className="text-2xl font-bold text-blue-600 dark:text-blue-400">
            {((agent as any).totalTransactions ?? (agent as any).total_transactions)?.toLocaleString() || '0'}
          </div>
          <div className="text-xs text-gray-400 mt-1">{formatCurrency((agent as any).totalVolume ?? (agent as any).total_volume ?? 0)} volume</div>
        </div>
        <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-5">
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm text-gray-500 dark:text-gray-400">KYA Tier</div>
            <KyaTierBadge tier={agent.kyaTier} />
          </div>
          {limits ? (() => {
            const daily = (limits as any)?.effectiveLimits?.daily ?? (limits as any)?.limits?.daily ?? 0;
            const used = (limits as any)?.usage?.daily ?? 0;
            const pct = daily > 0 ? Math.min(100, (used / daily) * 100) : 0;
            const near = pct >= 80;
            const barColor = near ? 'bg-amber-500' : 'bg-emerald-500';
            return (
              <div>
                <div className="flex items-baseline justify-between mb-1">
                  <div className="text-xs text-gray-500 dark:text-gray-400">Daily budget</div>
                  <div className="text-xs font-medium text-gray-900 dark:text-white">
                    {formatCurrency(used)} / {formatCurrency(daily)}
                  </div>
                </div>
                <div className="h-1.5 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
                  <div
                    className={`h-full ${barColor} transition-all`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                {near && (
                  <div className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                    Approaching daily cap
                  </div>
                )}
              </div>
            );
          })() : (
            <div className="text-xs text-gray-400">Loading limits…</div>
          )}
        </div>
        <Link
          href={`/dashboard/accounts/${agent.parentAccount?.id || (agent as any).parent_account_id || '#'}`}
          className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-5 hover:shadow-lg transition-shadow"
        >
          <div className="text-sm text-gray-500 dark:text-gray-400 mb-1">Parent Account</div>
          <div className="text-lg font-bold text-gray-900 dark:text-white flex items-center gap-2">
            <Building2 className="h-5 w-5 text-purple-500" />
            {agent.parentAccount?.name || 'View Account'}
          </div>
        </Link>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200 dark:border-gray-800 mb-6">
        <div className="flex gap-1">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${activeTab === tab.id
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
            >
              <tab.icon className="h-4 w-4" />
              {tab.label}
              {tab.count !== undefined && (
                <span className="px-2 py-0.5 text-xs rounded-full bg-gray-100 dark:bg-gray-800">
                  {tab.count}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Tab Content */}
      {activeTab === 'overview' && (
        <OverviewTab agent={agent} limits={limits} />
      )}
      {activeTab === 'streams' && (
        <StreamsTab streams={streams} />
      )}
      {activeTab === 'mandates' && (
        <MandatesTab agentId={agentId} />
      )}
      {activeTab === 'checkouts' && (
        <CheckoutsTab agentId={agentId} />
      )}
      {activeTab === 'a2a' && (
        <A2ATab agentId={agentId} />
      )}
      {activeTab === 'wallet' && (
        <WalletTab agentId={agentId} />
      )}
      {activeTab === 'ratings' && (
        <RatingsTab agentId={agentId} />
      )}
      {activeTab === 'permissions' && (
        <PermissionsTab agent={agent} />
      )}
      {activeTab === 'kya' && (
        <KYATab agent={agent} limits={limits} />
      )}
      {activeTab === 'scopes' && (
        <ScopesTab agentId={agentId} />
      )}
      {activeTab === 'activity' && (
        <ActivityTab agentId={agentId} />
      )}
    </div>
  );
}

// Permission categories and their possible permissions
const permissionMatrix: Record<string, string[]> = {
  transactions: ['view', 'initiate', 'approve'],
  streams: ['view', 'create', 'modify', 'pause', 'terminate'],
  accounts: ['view', 'create', 'modify'],
  treasury: ['view', 'manage', 'rebalance'],
};

// Inline rating summary for overview card
function AgentRatingBadge({ agentId }: { agentId: string }) {
  const api = useApiClient();
  const { data: summary } = useTanstackQuery({
    queryKey: ['agent-feedback-summary', agentId],
    queryFn: async () => {
      if (!api) return null;
      const res = await fetch(`${api.baseUrl}/v1/agents/${agentId}/feedback/summary`, {
        headers: { Authorization: `Bearer ${api.apiKey}` },
      });
      if (!res.ok) return null;
      const json = await res.json();
      return json.data;
    },
    enabled: !!api,
  });

  if (!summary || summary.total_reviews === 0) {
    return <span className="text-sm text-gray-400">No reviews</span>;
  }

  const scoreColor = summary.avg_score >= 70
    ? 'text-emerald-600 dark:text-emerald-400'
    : summary.avg_score >= 40
      ? 'text-amber-600 dark:text-amber-400'
      : 'text-red-600 dark:text-red-400';

  return (
    <div className="flex items-center gap-2">
      <Star className="h-3.5 w-3.5 text-amber-400 fill-amber-400" />
      <span className={`text-sm font-semibold ${scoreColor}`}>
        {summary.avg_score !== null ? summary.avg_score : '--'}
      </span>
      <span className="text-xs text-gray-400">/ 100</span>
      <span className="text-xs text-gray-400">({summary.total_reviews})</span>
    </div>
  );
}

const TIER_COLORS: Record<string, string> = {
  A: 'text-emerald-600 dark:text-emerald-400',
  B: 'text-blue-600 dark:text-blue-400',
  C: 'text-yellow-600 dark:text-yellow-400',
  D: 'text-orange-600 dark:text-orange-400',
  E: 'text-red-600 dark:text-red-400',
  F: 'text-gray-500 dark:text-gray-500',
};

function ReputationCard({ agentId }: { agentId: string }) {
  const { apiUrl } = useApiConfig();
  const apiFetch = useApiFetch();

  const { data: reputation, isLoading } = useTanstackQuery({
    queryKey: ['agent-reputation', agentId],
    queryFn: async () => {
      const res = await apiFetch(`${apiUrl}/v1/reputation/${agentId}`);
      if (!res.ok) return null;
      const json = await res.json();
      return json.data ?? json;
    },
  });

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
        <div className="animate-pulse space-y-3">
          <div className="h-5 w-32 bg-gray-200 dark:bg-gray-800 rounded" />
          <div className="h-12 w-24 bg-gray-200 dark:bg-gray-800 rounded" />
          <div className="h-3 w-full bg-gray-200 dark:bg-gray-800 rounded-full" />
        </div>
      </div>
    );
  }

  if (!reputation) {
    return (
      <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
        <div className="flex items-center gap-3 mb-2">
          <Shield className="h-5 w-5 text-gray-400" />
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Reputation</h3>
        </div>
        <p className="text-sm text-gray-400">No reputation data available yet.</p>
      </div>
    );
  }

  const score: number = reputation.score ?? reputation.trust_score ?? reputation.trustScore ?? 0;
  const tier: string = reputation.tier ?? 'F';
  const confidence: string = reputation.confidence ?? reputation.confidence_level ?? 'low';
  const scorePct = Math.min((score / 1000) * 100, 100);
  const dimensions: Array<{ name: string; score: number; weight: number; sources?: string[]; dataPoints?: number }> =
    reputation.dimensions ?? [];

  // Human-readable labels + descriptions for each dimension
  const DIM_META: Record<string, { label: string; icon: string; desc: string }> = {
    identity: {
      label: 'Identity',
      icon: '🛡️',
      desc: 'On-chain NFT + KYA tier + account age + rating volume',
    },
    service_quality: {
      label: 'Service Quality',
      icon: '⭐',
      desc: 'Buyer ratings, accept rate, completion history',
    },
    trade_volume: {
      label: 'Trade Volume',
      icon: '📈',
      desc: 'Settled transaction history',
    },
    dispute_rate: {
      label: 'Dispute Rate',
      icon: '⚖️',
      desc: 'Frequency of filed disputes',
    },
    age: {
      label: 'Account Age',
      icon: '📅',
      desc: 'How long the agent has been active',
    },
  };

  const SOURCE_LABELS: Record<string, string> = {
    erc8004: 'ERC-8004 NFT',
    a2a_feedback: 'A2A trade ratings',
    ap2_mandates: 'AP2 payment mandates',
    kya: 'KYA verification',
    disputes: 'Dispute history',
  };

  const scoreColor =
    score >= 800 ? 'text-emerald-600 dark:text-emerald-400' :
    score >= 600 ? 'text-blue-600 dark:text-blue-400' :
    score >= 400 ? 'text-yellow-600 dark:text-yellow-400' :
    score >= 200 ? 'text-orange-600 dark:text-orange-400' :
    'text-red-600 dark:text-red-400';

  const barColor =
    score >= 800 ? 'bg-emerald-500' :
    score >= 600 ? 'bg-blue-500' :
    score >= 400 ? 'bg-yellow-500' :
    score >= 200 ? 'bg-orange-500' :
    'bg-red-500';

  return (
    <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
      <div className="flex items-center gap-3 mb-4">
        <Shield className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Reputation</h3>
      </div>
      <div className="flex items-end gap-4 mb-4">
        <div className={`text-5xl font-bold tabular-nums ${scoreColor}`}>{score}</div>
        <div className="mb-1">
          <span className="text-sm text-gray-400">/ 1000</span>
        </div>
        <div className="ml-auto">
          <span className={`text-3xl font-bold ${TIER_COLORS[tier] ?? TIER_COLORS['F']}`}>
            {tier}
          </span>
          <span className="ml-1 text-xs text-gray-400 uppercase tracking-wide">tier</span>
        </div>
      </div>
      <div className="h-2.5 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden mb-3">
        <div
          className={`h-full rounded-full transition-all ${barColor}`}
          style={{ width: `${scorePct}%` }}
        />
      </div>
      <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400 mb-4">
        <span className="flex items-center gap-3">
          <span>Confidence: <span className="capitalize font-medium">{confidence}</span></span>
          {typeof reputation.ratingCount === 'number' && reputation.ratingCount > 0 && (
            <span>
              <span className="font-medium">{reputation.ratingCount}</span>{' '}
              rating{reputation.ratingCount === 1 ? '' : 's'}
            </span>
          )}
        </span>
        <span>0 — 1000</span>
      </div>

      {/* Collusion ring detector — flagged when the rating graph looks closed */}
      {reputation.collusion && (
        <div className={`mb-4 rounded-lg p-3 text-xs border ${
          reputation.collusion.flagged
            ? 'bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-900 text-red-800 dark:text-red-200'
            : 'bg-gray-50 dark:bg-gray-900 border-gray-200 dark:border-gray-800 text-gray-600 dark:text-gray-400'
        }`}>
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2 font-semibold">
              {reputation.collusion.flagged ? '⚠️ Rating ring detected' : 'Rater diversity'}
            </div>
            {reputation.collusion.flagged && (
              <span className="text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded bg-red-100 dark:bg-red-900/60">
                capped at C
              </span>
            )}
          </div>
          <div className="grid grid-cols-4 gap-2">
            <div>
              <div className="text-[10px] opacity-70 uppercase">Unique raters</div>
              <div className="tabular-nums font-medium">
                {reputation.collusion.uniqueRaters} / {reputation.collusion.totalRatings}
              </div>
            </div>
            <div>
              <div className="text-[10px] opacity-70 uppercase">Top rater share</div>
              <div className="tabular-nums font-medium">
                {Math.round(reputation.collusion.topRaterShare * 100)}%
              </div>
            </div>
            <div>
              <div className="text-[10px] opacity-70 uppercase">Reciprocal</div>
              <div className="tabular-nums font-medium">
                {Math.round(reputation.collusion.reciprocalRatio * 100)}%
              </div>
            </div>
            <div title="Fraction of raters' own raters that are inside this agent's rating circle — high value = closed subgraph">
              <div className="text-[10px] opacity-70 uppercase">Ring coef</div>
              <div className="tabular-nums font-medium">
                {Math.round((reputation.collusion.ringCoefficient ?? 0) * 100)}%
              </div>
            </div>
          </div>
          {reputation.collusion.flagged && reputation.collusion.reason && (
            <div className="mt-2 opacity-90">{reputation.collusion.reason}</div>
          )}
        </div>
      )}

      {/* Dimension breakdown — shows why the score is what it is */}
      {dimensions.length > 0 && (
        <div className="pt-4 border-t border-gray-100 dark:border-gray-800">
          <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-3">
            How it's calculated
          </div>
          <div className="space-y-3">
            {dimensions.map((dim) => {
              const meta = DIM_META[dim.name] ?? { label: dim.name, icon: '•', desc: '' };
              const weightPct = Math.round(dim.weight * 100);
              const contribution = Math.round(dim.score * dim.weight);
              const dimPct = Math.min((dim.score / 1000) * 100, 100);
              const dimColor =
                dim.score >= 800 ? 'bg-emerald-500' :
                dim.score >= 600 ? 'bg-blue-500' :
                dim.score >= 400 ? 'bg-yellow-500' :
                dim.score >= 200 ? 'bg-orange-500' : 'bg-red-500';
              return (
                <div key={dim.name} className="text-xs">
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-2">
                      <span className="text-sm">{meta.icon}</span>
                      <span className="font-medium text-gray-900 dark:text-white">{meta.label}</span>
                      <span className="text-gray-400">×</span>
                      <span className="text-gray-500 dark:text-gray-400 font-medium">{weightPct}%</span>
                    </div>
                    <div className="flex items-baseline gap-1.5">
                      <span className="tabular-nums font-semibold text-gray-900 dark:text-white">{dim.score}</span>
                      <span className="text-gray-400">→</span>
                      <span className="tabular-nums font-semibold text-indigo-600 dark:text-indigo-400">+{contribution}</span>
                    </div>
                  </div>
                  <div className="h-1.5 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden mb-1">
                    <div className={`h-full rounded-full ${dimColor}`} style={{ width: `${dimPct}%` }} />
                  </div>
                  <div className="flex items-center justify-between text-[11px] text-gray-500 dark:text-gray-400">
                    <span>{meta.desc}</span>
                    {dim.sources && dim.sources.length > 0 && (
                      <span className="text-gray-400">
                        {dim.sources.map((s) => SOURCE_LABELS[s] ?? s).join(', ')}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-800 flex items-center justify-between text-xs">
            <span className="text-gray-500 dark:text-gray-400">
              Total: {dimensions.map((d, i) => (
                <span key={d.name}>
                  {i > 0 && ' + '}
                  <span className="tabular-nums">{Math.round(d.score * d.weight)}</span>
                </span>
              ))}
            </span>
            <span className={`tabular-nums font-bold ${scoreColor}`}>= {score}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function RatingHistoryCard({ agentId }: { agentId: string }) {
  const { apiUrl } = useApiConfig();
  const apiFetch = useApiFetch();

  const { data: ratingsData, isLoading } = useTanstackQuery({
    queryKey: ['agent-ratings-history', agentId],
    queryFn: async () => {
      const res = await apiFetch(`${apiUrl}/v1/agents/${agentId}/ratings?limit=50`);
      if (!res.ok) return null;
      const json = await res.json();
      return json.data ?? json;
    },
  });

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
        <div className="animate-pulse space-y-3">
          <div className="h-5 w-40 bg-gray-200 dark:bg-gray-800 rounded" />
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-10 bg-gray-200 dark:bg-gray-800 rounded" />
          ))}
        </div>
      </div>
    );
  }

  const ratings: any[] = Array.isArray(ratingsData) ? ratingsData : (ratingsData?.ratings ?? ratingsData?.items ?? []);
  const aggregate = ratingsData?.aggregate ?? ratingsData?.summary ?? null;

  const totalRatings = aggregate?.total ?? ratings.length;
  const avgScore = aggregate?.avg_score ?? aggregate?.avgScore ?? (
    ratings.length > 0
      ? Math.round(ratings.reduce((s: number, r: any) => s + (r.score ?? r.rating ?? 0), 0) / ratings.length)
      : null
  );
  const acceptCount = ratings.filter((r: any) => (r.action ?? r.outcome) === 'accept').length;
  const rawAcceptRate = (aggregate?.accept_rate ?? aggregate?.acceptRate);
  // API returns acceptRate as a percentage (e.g. 68), not a decimal (0.68).
  // If > 1, it's already a percentage. If <= 1, it's a decimal ratio.
  const acceptRate = totalRatings > 0
    ? (rawAcceptRate != null
        ? (rawAcceptRate > 1 ? rawAcceptRate / 100 : rawAcceptRate)
        : (acceptCount / totalRatings))
    : null;

  if (ratings.length === 0 && !aggregate) {
    return (
      <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
        <div className="flex items-center gap-3 mb-2">
          <Star className="h-5 w-5 text-gray-400" />
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Rating History</h3>
        </div>
        <p className="text-sm text-gray-400">No ratings recorded yet.</p>
      </div>
    );
  }

  const satisfactionBadge: Record<string, string> = {
    excellent: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200',
    acceptable: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
    partial: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200',
    unacceptable: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  };

  return (
    <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
      <div className="flex items-center gap-3 mb-4">
        <Star className="h-5 w-5 text-amber-500" />
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Rating History</h3>
      </div>

      {/* Aggregate stats */}
      <div className="grid grid-cols-3 gap-4 mb-5">
        <div className="bg-gray-50 dark:bg-gray-900 rounded-xl p-3 text-center">
          <div className="text-2xl font-bold text-gray-900 dark:text-white">{totalRatings}</div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Total Ratings</div>
        </div>
        <div className="bg-gray-50 dark:bg-gray-900 rounded-xl p-3 text-center">
          <div className="text-2xl font-bold text-gray-900 dark:text-white">
            {avgScore !== null ? avgScore : '—'}
            {avgScore !== null && <span className="text-sm font-normal text-gray-400">/100</span>}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Avg Score</div>
        </div>
        <div className="bg-gray-50 dark:bg-gray-900 rounded-xl p-3 text-center">
          <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">
            {acceptRate !== null ? `${(acceptRate * 100).toFixed(0)}%` : '—'}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Accept Rate</div>
        </div>
      </div>

      {/* Recent ratings table */}
      {ratings.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-800">
                <th className="text-left pb-2 text-xs font-medium text-gray-500 dark:text-gray-400">Date</th>
                <th className="text-left pb-2 text-xs font-medium text-gray-500 dark:text-gray-400">Rated by</th>
                <th className="text-left pb-2 text-xs font-medium text-gray-500 dark:text-gray-400">Score</th>
                <th className="text-left pb-2 text-xs font-medium text-gray-500 dark:text-gray-400">Satisfaction</th>
                <th className="text-left pb-2 text-xs font-medium text-gray-500 dark:text-gray-400">Action</th>
                <th className="text-left pb-2 text-xs font-medium text-gray-500 dark:text-gray-400">Comment</th>
                <th className="text-left pb-2 text-xs font-medium text-gray-500 dark:text-gray-400">On-chain</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {ratings.slice(0, 50).map((r: any, idx: number) => {
                const dateStr = r.created_at ?? r.createdAt ?? r.rated_at ?? r.ratedAt ?? '';
                const score = r.score ?? r.rating ?? null;
                const satisfaction = r.satisfaction ?? r.satisfaction_level ?? '';
                const action = r.action ?? r.outcome ?? '';
                const comment = r.comment ?? r.feedback ?? '';
                const rater = r.rater ?? null;
                return (
                  <tr key={r.id ?? idx} className="hover:bg-gray-50 dark:hover:bg-gray-900">
                    <td className="py-2 pr-4 text-gray-500 dark:text-gray-400 whitespace-nowrap">
                      {dateStr ? format(new Date(dateStr), 'MMM d, yyyy') : '—'}
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap">
                      {rater ? (
                        <a
                          href={`/dashboard/agents/${rater.id}`}
                          onClick={(e) => e.stopPropagation()}
                          className="text-indigo-600 dark:text-indigo-400 hover:underline"
                          title={rater.id}
                        >
                          {rater.name}
                        </a>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="py-2 pr-4 font-medium text-gray-900 dark:text-white">
                      {score !== null ? score : '—'}
                    </td>
                    <td className="py-2 pr-4">
                      {satisfaction ? (
                        <span className={`px-2 py-0.5 text-xs rounded-full capitalize ${satisfactionBadge[satisfaction] ?? 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'}`}>
                          {satisfaction}
                        </span>
                      ) : '—'}
                    </td>
                    <td className="py-2 pr-4">
                      {action === 'accept' ? (
                        <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                          <ThumbsUp className="h-3.5 w-3.5" /> Accept
                        </span>
                      ) : action === 'reject' ? (
                        <span className="flex items-center gap-1 text-red-500 dark:text-red-400">
                          <ThumbsDown className="h-3.5 w-3.5" /> Reject
                        </span>
                      ) : action ? (
                        <span className="capitalize text-gray-500">{action}</span>
                      ) : '—'}
                    </td>
                    <td className="py-2 pr-4 text-gray-500 dark:text-gray-400 max-w-[200px] truncate" title={comment}>
                      {comment || '—'}
                    </td>
                    <td className="py-2 whitespace-nowrap">
                      {r.attestation ? (
                        <div className="flex items-center gap-2">
                          {r.attestation.eascanUrl && (
                            <a
                              href={r.attestation.eascanUrl}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="inline-flex items-center gap-1 text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
                              title={`EAS attestation ${r.attestation.uid}`}
                            >
                              <ExternalLink className="h-3 w-3" /> EAS
                            </a>
                          )}
                          {r.attestation.txHash && (
                            <a
                              href={`https://sepolia.basescan.org/tx/${r.attestation.txHash}`}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="inline-flex items-center gap-1 text-xs text-gray-600 dark:text-gray-400 hover:underline"
                              title={`Tx ${r.attestation.txHash}`}
                            >
                              tx
                            </a>
                          )}
                          {r.attestation.artifactHash && (
                            <span
                              className="inline-flex items-center gap-1 text-xs text-gray-500 dark:text-gray-500 font-mono"
                              title={`Artifact SHA-256: ${r.attestation.artifactHash}`}
                            >
                              PoW {String(r.attestation.artifactHash).slice(0, 8)}
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="text-gray-400 text-xs">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Overview Tab
function OverviewTab({ agent, limits }: { agent: Agent; limits: AgentLimits | null }) {
  return (
    <div className="space-y-6">
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Agent Details</h3>
        <div className="mb-5 pb-5 border-b border-gray-100 dark:border-gray-800">
          <dt className="text-gray-500 dark:text-gray-400 text-sm mb-3">Avatar</dt>
          <AvatarUpload
            agentId={agent.id}
            agentName={agent.name}
            currentUrl={(agent as any).avatarUrl ?? (agent as any).avatar_url ?? null}
            size="lg"
          />
        </div>
        <dl className="space-y-4">
          <div className="flex justify-between">
            <dt className="text-gray-500 dark:text-gray-400">Agent ID</dt>
            <dd className="font-mono text-sm text-gray-900 dark:text-white">{agent.id}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-gray-500 dark:text-gray-400">Status</dt>
            <dd className="capitalize text-gray-900 dark:text-white">{agent.status}</dd>
          </div>
          <div className="flex justify-between items-center">
            <dt className="text-gray-500 dark:text-gray-400">KYA Tier</dt>
            <dd><KyaTierBadge tier={agent.kyaTier} /></dd>
          </div>
          <div className="flex justify-between items-center">
            <dt className="text-gray-500 dark:text-gray-400">Rating</dt>
            <dd><AgentRatingBadge agentId={agent.id} /></dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-gray-500 dark:text-gray-400">Created</dt>
            <dd className="text-gray-900 dark:text-white">
              {new Date(agent.createdAt).toLocaleString()}
            </dd>
          </div>
        </dl>
      </div>

      <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Recent Activity</h3>
        <RecentTransfers agentId={agent.id} />
      </div>
    </div>
    {((agent as any).erc8004AgentId || (agent as any).walletAddress) && (
      <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
        <div className="flex items-center gap-3 mb-4">
          <Shield className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">On-Chain Identity</h3>
        </div>
        <dl className="space-y-4">
          {(agent as any).erc8004AgentId && (
            <div className="flex justify-between items-center">
              <dt className="text-gray-500 dark:text-gray-400">ERC-8004 Token</dt>
              <dd className="flex items-center gap-2">
                <span className="font-mono text-sm text-gray-900 dark:text-white">#{(agent as any).erc8004AgentId}</span>
                <a
                  href={`https://sepolia.basescan.org/nft/0x13b52042ef3e0e84d7ad49fdc1b71848b187a89c/${(agent as any).erc8004AgentId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-indigo-600 dark:text-indigo-400 hover:underline text-xs"
                >
                  View NFT &rarr;
                </a>
              </dd>
            </div>
          )}
          {(agent as any).walletAddress && (
            <div className="flex justify-between items-center">
              <dt className="text-gray-500 dark:text-gray-400">Wallet</dt>
              <dd className="flex items-center gap-2">
                <span className="font-mono text-xs text-gray-900 dark:text-white">
                  {(agent as any).walletAddress.slice(0, 6)}...{(agent as any).walletAddress.slice(-4)}
                </span>
                <a
                  href={`https://sepolia.basescan.org/address/${(agent as any).walletAddress}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-indigo-600 dark:text-indigo-400 hover:underline text-xs"
                >
                  Transfers &rarr;
                </a>
              </dd>
            </div>
          )}
          <div className="flex justify-between">
            <dt className="text-gray-500 dark:text-gray-400">Network</dt>
            <dd className="text-gray-900 dark:text-white">Base Sepolia</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-gray-500 dark:text-gray-400">Registry</dt>
            <dd className="font-mono text-xs text-gray-500 dark:text-gray-400">
              0x7177...d09A
            </dd>
          </div>
        </dl>
      </div>
    )}
    <WalletSpendingPolicies agent={agent} />
    <LinkedPaymentInstruments agent={agent} />
    </div>
  );
}

// Linked Payment Instruments — shows funding sources bound to this agent's mandates
function LinkedPaymentInstruments({ agent }: { agent: Agent }) {
  const api = useApiClient();
  const parentAccountId = agent.parentAccount?.id || (agent as any).parent_account_id;

  // Fetch agent's mandates
  const { data: mandatesData, isLoading: mandatesLoading } = useTanstackQuery({
    queryKey: ['agent-mandates-instruments', agent.id],
    queryFn: async () => {
      if (!api) return [];
      const result = await api.ap2.list({ agentId: agent.id, limit: 100 });
      const raw = result as any;
      const data = raw?.data || raw;
      return Array.isArray(data) ? data : (data?.data || []);
    },
    enabled: !!api,
  });

  // Fetch parent account's funding sources
  const { data: sourcesData, isLoading: sourcesLoading } = useTanstackQuery({
    queryKey: ['funding-sources', parentAccountId],
    queryFn: async () => {
      if (!api || !parentAccountId) return [];
      return api.fundingSources.list({ accountId: parentAccountId });
    },
    enabled: !!api && !!parentAccountId,
  });

  const isLoading = mandatesLoading || sourcesLoading;
  const mandates = mandatesData || [];
  const allSources = sourcesData || [];

  // Filter mandates that have a funding source bound
  const boundMandates = mandates.filter((m: any) => m.fundingSourceId || m.funding_source_id);

  // Group by funding source ID
  const sourceToMandates = new Map<string, any[]>();
  for (const m of boundMandates) {
    const fsId = m.fundingSourceId || m.funding_source_id;
    if (!fsId) continue;
    if (!sourceToMandates.has(fsId)) sourceToMandates.set(fsId, []);
    sourceToMandates.get(fsId)!.push(m);
  }

  if (isLoading) return null;
  if (sourceToMandates.size === 0 && allSources.length === 0) return null;

  return (
    <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
      <div className="flex items-center gap-3 mb-4">
        <CreditCard className="h-5 w-5 text-amber-600 dark:text-amber-400" />
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Payment Instruments</h3>
      </div>
      {sourceToMandates.size > 0 ? (
        <div className="space-y-3">
          {Array.from(sourceToMandates.entries()).map(([fsId, mList]) => {
            const source = allSources.find((s: any) => s.id === fsId) as any;
            const displayName = source?.displayName || source?.display_name || `Source ••••${source?.lastFour || source?.last_four || ''}`;
            return (
              <div key={fsId} className="border border-gray-200 dark:border-gray-800 rounded-xl p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="h-8 w-8 rounded-full bg-amber-100 dark:bg-amber-900 flex items-center justify-center">
                      <CreditCard className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                    </div>
                    <div>
                      <div className="font-medium text-gray-900 dark:text-white text-sm">{displayName}</div>
                      {source && (
                        <div className="text-xs text-muted-foreground capitalize">{source.provider || source.type}</div>
                      )}
                    </div>
                  </div>
                  <Badge variant="outline" className="text-xs">
                    {mList.length} mandate{mList.length !== 1 ? 's' : ''}
                  </Badge>
                </div>
              </div>
            );
          })}
          {allSources.length > sourceToMandates.size && (
            <p className="text-xs text-muted-foreground mt-2">
              {allSources.length - sourceToMandates.size} additional instrument{allSources.length - sourceToMandates.size !== 1 ? 's' : ''} available on parent account
            </p>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {allSources.length} instrument{allSources.length !== 1 ? 's' : ''} available on parent account. None bound to mandates yet.
        </p>
      )}
    </div>
  );
}

// Recent activity for Overview tab — merges transfers + ACP checkouts + UCP checkouts
function RecentTransfers({ agentId }: { agentId: string }) {
  const api = useApiClient();

  // Fetch unified agent transactions (all protocols in one call)
  const { data: txData, isLoading } = useTanstackQuery({
    queryKey: ['agent-transactions', agentId, 'recent'],
    queryFn: async () => {
      if (!api) return [];
      const result = await api.agents.getTransactions(agentId, { limit: 10 });
      const raw = result as any;
      return Array.isArray(raw?.data) ? raw.data : [];
    },
    enabled: !!api,
  });

  const merged: Array<{ id: string; type: string; description: string; amount: number; currency: string; status: string; date: string }> = (txData || []).map((tx: any) => ({
    id: tx.id,
    type: tx.type as string,
    description: tx.description || `${tx.type} transfer`,
    amount: tx.amount ?? 0,
    currency: tx.currency ?? 'USDC',
    status: tx.status,
    date: tx.created_at,
  }));

  if (isLoading) {
    return <div className="h-20 bg-gray-200 dark:bg-gray-800 rounded animate-pulse" />;
  }

  if (merged.length === 0) {
    return <p className="text-gray-500 text-sm">No recent activity</p>;
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed': return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300';
      case 'confirmed': return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300';
      case 'pending': case 'processing': return 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300';
      case 'failed': return 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300';
      default: return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';
    }
  };

  return (
    <div className="max-h-[320px] overflow-y-auto overflow-x-hidden space-y-3 pr-1">
      {merged.map((tx) => {
        const href = tx.type === 'acp_checkout'
          ? `/dashboard/agentic-payments/acp/checkouts/${tx.id}`
          : tx.type === 'ucp_checkout'
            ? `/dashboard/agentic-payments/ucp/checkouts/${tx.id}`
            : `/dashboard/transfers/${tx.id}`;
        return (
          <Link key={`${tx.type}-${tx.id}`} href={href} className="block py-2 border-b border-gray-100 dark:border-gray-800 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-800/50 rounded-md px-2 -mx-2 transition-colors cursor-pointer">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 flex-1 min-w-0">
                {(tx.type === 'ucp_checkout' || tx.type === 'acp_checkout') && (
                  <ShoppingCart className="h-3.5 w-3.5 text-violet-500 flex-shrink-0" />
                )}
                <div className="min-w-0">
                  <div className="text-sm text-gray-900 dark:text-white truncate">
                    {tx.description}
                  </div>
                  <div className="text-xs text-gray-400 mt-0.5">
                    {tx.date ? format(new Date(tx.date), 'MMM d, h:mm a') : ''}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 ml-3 flex-shrink-0">
                {/* Show the attempted amount for failed/cancelled rows
                    as muted-and-strikethrough so users understand no
                    money moved there. Completed rows render bold. */}
                {tx.amount > 0 && (
                  <span className={
                    tx.status === 'completed' || tx.status === 'confirmed'
                      ? 'text-sm font-medium text-gray-900 dark:text-white'
                      : 'text-xs text-gray-400 line-through'
                  }>
                    {formatCurrency(tx.amount, tx.currency)}
                  </span>
                )}
                <span className={`px-1.5 py-0.5 text-[10px] font-medium rounded ${getStatusColor(tx.status)}`}>
                  {tx.status}
                </span>
              </div>
            </div>
          </Link>
        );
      })}
    </div>
  );
}

// Wallet Spending Policies card
function WalletSpendingPolicies({ agent }: { agent: Agent }) {
  const api = useApiClient();
  const parentAccountId = agent.parentAccount?.id || (agent as any).parent_account_id;

  // Try agent-linked wallets first, fall back to parent account wallets
  const { data: agentWalletsData, isLoading: agentLoading } = useTanstackQuery({
    queryKey: ['wallets', 'agent', agent.id],
    queryFn: async () => {
      if (!api) return [];
      const result = await api.wallets.list({ managed_by_agent_id: agent.id } as any);
      const raw = result as any;
      return Array.isArray(raw?.data) ? raw.data : (Array.isArray(raw?.data?.data) ? raw.data.data : (Array.isArray(raw) ? raw : []));
    },
    enabled: !!api,
  });

  const { data: parentWalletsData, isLoading: parentLoading } = useTanstackQuery({
    queryKey: ['wallets', 'parent', parentAccountId],
    queryFn: async () => {
      if (!api || !parentAccountId) return [];
      const result = await api.wallets.list({ owner_account_id: parentAccountId, limit: 20 } as any);
      const raw = result as any;
      return Array.isArray(raw?.data) ? raw.data : (Array.isArray(raw?.data?.data) ? raw.data.data : (Array.isArray(raw) ? raw : []));
    },
    enabled: !!api && !!parentAccountId && (agentWalletsData || []).length === 0 && !agentLoading,
  });

  const isLoading = agentLoading || parentLoading;
  const agentWallets = agentWalletsData || [];
  const usingParentFallback = agentWallets.length === 0;
  const wallets = agentWallets.length > 0 ? agentWallets : (parentWalletsData || []);

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Wallet Spending Policies</h3>
        <div className="h-20 bg-gray-200 dark:bg-gray-800 rounded animate-pulse" />
      </div>
    );
  }

  if (wallets.length === 0) return null;

  return (
    <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
      <div className="flex items-center gap-3 mb-4">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Wallet Spending Policies</h3>
        {usingParentFallback && wallets.length > 0 && (
          <span className="text-xs text-gray-400 bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded">Showing parent account wallets</span>
        )}
      </div>
      <div className="space-y-4">
        {wallets.map((wallet: any) => {
          const policy = wallet.spending_policy || wallet.spendingPolicy;
          const addr = wallet.wallet_address || wallet.walletAddress || wallet.address;
          const network = wallet.network;
          const provider = wallet.provider;
          const walletName = wallet.name || (provider === 'tempo' ? 'Tempo Wallet' : provider === 'circle' ? 'Circle Wallet' : 'Wallet');
          return (
            <div key={wallet.id} className="border border-gray-200 dark:border-gray-800 rounded-xl p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Link href={`/dashboard/wallets/${wallet.id}`} className="font-medium text-gray-900 dark:text-white hover:text-blue-600 dark:hover:text-blue-400 underline-offset-2 hover:underline">
                    {walletName}
                  </Link>
                  {network && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 font-medium">
                      {network}
                    </span>
                  )}
                  {wallet.purpose && (
                    <span className="text-xs text-muted-foreground">{wallet.purpose}</span>
                  )}
                </div>
                <div className="text-right">
                  <span className="text-sm font-medium">{formatCurrency(wallet.balance, wallet.currency)}</span>
                  {addr && addr.startsWith('0x') && (
                    <div className="text-[10px] font-mono text-gray-400 mt-0.5">{addr.slice(0, 6)}...{addr.slice(-4)}</div>
                  )}
                </div>
              </div>
              {policy ? (
                <div className="flex flex-wrap gap-2 mt-2">
                  {policy.daily_limit && (
                    <Badge variant="outline" className="text-xs">Daily: ${policy.daily_limit.toLocaleString()}</Badge>
                  )}
                  {policy.monthly_limit && (
                    <Badge variant="outline" className="text-xs">Monthly: ${policy.monthly_limit.toLocaleString()}</Badge>
                  )}
                  {policy.per_transaction_limit && (
                    <Badge variant="outline" className="text-xs">Per-Tx: ${policy.per_transaction_limit.toLocaleString()}</Badge>
                  )}
                  {policy.requires_approval_above && (
                    <Badge variant="outline" className="text-xs bg-amber-50 dark:bg-amber-950 border-amber-200 dark:border-amber-800">Approval &gt; ${policy.requires_approval_above.toLocaleString()}</Badge>
                  )}
                  {policy.per_trip_limit && (
                    <Badge variant="outline" className="text-xs">Per-Trip: ${policy.per_trip_limit.toLocaleString()}</Badge>
                  )}
                  {policy.hotel_per_night_max && (
                    <Badge variant="outline" className="text-xs">Hotel/Night: ${policy.hotel_per_night_max.toLocaleString()}</Badge>
                  )}
                  {policy.locked && (
                    <Badge variant="outline" className="text-xs bg-red-50 dark:bg-red-950 border-red-200 dark:border-red-800 text-red-700 dark:text-red-300">Locked</Badge>
                  )}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground mt-1">No spending policy configured</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Ratings Tab — Feedback summary + recent reviews
function RatingsTab({ agentId }: { agentId: string }) {
  const api = useApiClient();

  const { data: summary, isLoading: summaryLoading } = useTanstackQuery({
    queryKey: ['agent-feedback-summary', agentId],
    queryFn: async () => {
      if (!api) return null;
      const res = await fetch(`${api.baseUrl}/v1/agents/${agentId}/feedback/summary`, {
        headers: { Authorization: `Bearer ${api.apiKey}` },
      });
      if (!res.ok) return null;
      const json = await res.json();
      return json.data;
    },
    enabled: !!api,
  });

  const { data: recentFeedback, isLoading: feedbackLoading } = useTanstackQuery({
    queryKey: ['agent-feedback-list', agentId],
    queryFn: async () => {
      if (!api) return [];
      const res = await fetch(`${api.baseUrl}/v1/agents/${agentId}/feedback?limit=20`, {
        headers: { Authorization: `Bearer ${api.apiKey}` },
      });
      if (!res.ok) return [];
      const json = await res.json();
      return json.data || [];
    },
    enabled: !!api,
  });

  const isLoading = summaryLoading || feedbackLoading;

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-8 text-center">
        <div className="text-gray-500">Loading ratings...</div>
      </div>
    );
  }

  if (!summary || summary.total_reviews === 0) {
    return (
      <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-8 text-center">
        <Star className="h-12 w-12 text-gray-400 mx-auto mb-4" />
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">No ratings yet</h3>
        <p className="text-gray-500 dark:text-gray-400 mt-2">
          This agent hasn&apos;t received any feedback from callers.
        </p>
      </div>
    );
  }

  const satisfactionColors: Record<string, string> = {
    excellent: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200',
    acceptable: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
    partial: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200',
    unacceptable: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  };

  const dist = summary.satisfaction_distribution || {};
  const total = summary.total_reviews;

  return (
    <div className="space-y-6">

      {/* Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-5">
          <p className="text-sm text-gray-500 dark:text-gray-400">Avg Score</p>
          <p className="text-3xl font-bold mt-1">
            {summary.avg_score !== null ? summary.avg_score : '--'}
            <span className="text-sm font-normal text-gray-400">/100</span>
          </p>
        </div>
        <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-5">
          <p className="text-sm text-gray-500 dark:text-gray-400">Total Reviews</p>
          <p className="text-3xl font-bold mt-1">{total}</p>
        </div>
        <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-5">
          <p className="text-sm text-gray-500 dark:text-gray-400">Acceptance Rate</p>
          <p className="text-3xl font-bold mt-1 text-emerald-600">
            {((1 - summary.rejection_rate) * 100).toFixed(0)}%
          </p>
        </div>
        <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-5">
          <p className="text-sm text-gray-500 dark:text-gray-400">Rejection Rate</p>
          <p className="text-3xl font-bold mt-1 text-red-600">
            {(summary.rejection_rate * 100).toFixed(0)}%
          </p>
        </div>
      </div>

      {/* Satisfaction Distribution */}
      <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Satisfaction Distribution</h3>
        <div className="space-y-3">
          {(['excellent', 'acceptable', 'partial', 'unacceptable'] as const).map((level) => {
            const count = dist[level] || 0;
            const pct = total > 0 ? (count / total) * 100 : 0;
            return (
              <div key={level} className="flex items-center gap-3">
                <span className="text-sm capitalize w-28 text-gray-600 dark:text-gray-400">{level}</span>
                <div className="flex-1 h-6 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full ${satisfactionColors[level].split(' ')[0]}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="text-sm font-medium w-16 text-right text-gray-700 dark:text-gray-300">
                  {count} ({pct.toFixed(0)}%)
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Recent Feedback */}
      {recentFeedback && recentFeedback.length > 0 && (
        <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Recent Reviews</h3>
          <div className="space-y-3">
            {recentFeedback.map((fb: any) => (
              <div
                key={fb.id}
                className="flex items-start gap-3 p-3 rounded-lg border border-gray-100 dark:border-gray-800"
              >
                {fb.action === 'accept' ? (
                  <ThumbsUp className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" />
                ) : (
                  <ThumbsDown className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    {fb.satisfaction && (
                      <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${satisfactionColors[fb.satisfaction] || 'bg-gray-100 text-gray-700'}`}>
                        {fb.satisfaction}
                      </span>
                    )}
                    {fb.score !== null && fb.score !== undefined && (
                      <span className="text-xs text-gray-500 font-mono">{fb.score}/100</span>
                    )}
                    {fb.skill_id && (
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-500">
                        {fb.skill_id}
                      </span>
                    )}
                  </div>
                  {fb.comment && (
                    <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">{fb.comment}</p>
                  )}
                </div>
                <span className="text-[10px] text-gray-400 whitespace-nowrap shrink-0">
                  {format(new Date(fb.created_at), 'MMM d, HH:mm')}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Permissions Tab
function PermissionsTab({ agent }: { agent: Agent }) {
  return (
    <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
      <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Permission Matrix</h3>
      {agent.permissions && typeof agent.permissions === 'object' ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-800">
                <th className="text-left py-2 pr-4 text-gray-500 dark:text-gray-400 font-medium">Permission</th>
                {Object.keys(permissionMatrix).map((cat) => (
                  <th key={cat} className="text-center py-2 px-2 text-gray-500 dark:text-gray-400 font-medium capitalize">
                    {cat}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(() => {
                const allPerms = new Set<string>();
                Object.values(permissionMatrix).forEach((perms) =>
                  perms.forEach((p) => allPerms.add(p))
                );
                return Array.from(allPerms).map((perm) => (
                  <tr key={perm} className="border-b border-gray-100 dark:border-gray-900">
                    <td className="py-2 pr-4 text-gray-700 dark:text-gray-300 capitalize">{perm}</td>
                    {Object.keys(permissionMatrix).map((cat) => {
                      const catPerms = (agent.permissions as any)?.[cat] as Record<string, boolean> | undefined;
                      const hasPermInCategory = permissionMatrix[cat].includes(perm);
                      const isEnabled = catPerms?.[perm] === true;
                      return (
                        <td key={cat} className="text-center py-2 px-2">
                          {hasPermInCategory ? (
                            isEnabled ? (
                              <CheckCircle2 className="h-4 w-4 text-emerald-500 mx-auto" />
                            ) : (
                              <XCircle className="h-4 w-4 text-gray-300 dark:text-gray-700 mx-auto" />
                            )
                          ) : (
                            <span className="text-gray-200 dark:text-gray-800">--</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ));
              })()}
            </tbody>
          </table>
        </div>
      ) : (
        <span className="text-gray-500">No permissions configured</span>
      )}
    </div>
  );
}

// Streams Tab
function StreamsTab({ streams }: { streams: Stream[] }) {
  if (streams.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-8 text-center">
        <Activity className="h-12 w-12 text-gray-400 mx-auto mb-4" />
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">No streams</h3>
        <p className="text-gray-500 dark:text-gray-400 mt-2">
          This agent is not managing any streams.
        </p>
      </div>
    );
  }

  const getHealthColor = (health: string) => {
    switch (health) {
      case 'healthy': return 'bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-400';
      case 'warning': return 'bg-yellow-100 dark:bg-yellow-950 text-yellow-700 dark:text-yellow-400';
      case 'critical': return 'bg-red-100 dark:bg-red-950 text-red-700 dark:text-red-400';
      default: return 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-400';
    }
  };

  return (
    <div className="space-y-4">
      {streams.map((stream) => (
        <Link
          key={stream.id}
          href={`/dashboard/streams/${stream.id}`}
          className="block bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6 hover:shadow-lg transition-shadow"
        >
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-gray-900 dark:text-white">
                {stream.sender.accountName} → {stream.receiver.accountName}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                ${stream.flowRate.perMonth.toLocaleString()}/month
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="text-right">
                <div className="text-sm font-medium text-gray-900 dark:text-white">
                  ${stream.streamed.total.toLocaleString()}
                </div>
                <div className="text-xs text-gray-500">streamed</div>
              </div>
              <span className={`px-2.5 py-1 text-xs font-medium rounded-full ${getHealthColor(stream.health)}`}>
                {stream.health}
              </span>
            </div>
          </div>
        </Link>
      ))}
    </div>
  );
}

// Mandates Tab
function MandatesTab({ agentId }: { agentId: string }) {
  const api = useApiClient();
  const [mandates, setMandates] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchMandates() {
      if (!api) return;
      try {
        const result = await api.ap2.list({ agentId, limit: 50 });
        const raw = result as any;
        const data = raw?.data || raw;
        setMandates(Array.isArray(data) ? data : (data?.data || []));
      } catch (error) {
        console.error('Failed to fetch mandates:', error);
      } finally {
        setLoading(false);
      }
    }
    fetchMandates();
  }, [api, agentId]);

  if (loading) {
    return (
      <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-8 text-center">
        <div className="text-gray-500">Loading mandates...</div>
      </div>
    );
  }

  if (mandates.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-8 text-center">
        <FileText className="h-12 w-12 text-gray-400 mx-auto mb-4" />
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">No mandates</h3>
        <p className="text-gray-500 dark:text-gray-400 mt-2">
          This agent has no linked AP2 mandates.
        </p>
      </div>
    );
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'active': return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-100';
      case 'completed': return 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-100';
      case 'cancelled': return 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-100';
      default: return 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-100';
    }
  };

  const getPriorityDisplay = (metadata: any) => {
    const p = metadata?.priority;
    if (p == null) return null;
    const map: Record<number, { label: string; color: string }> = {
      1: { label: 'P1 High', color: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-100' },
      2: { label: 'P2 Medium', color: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-100' },
      3: { label: 'P3 Low', color: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-100' },
    };
    return map[p] || { label: `P${p}`, color: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-100' };
  };

  return (
    <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Mandate ID</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Priority</TableHead>
            <TableHead>Authorized</TableHead>
            <TableHead>Used</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Created</TableHead>
            <TableHead className="text-right">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {mandates.map((m: any) => {
            const priority = getPriorityDisplay(m.metadata);
            return (
            <TableRow key={m.id}>
              <TableCell className="font-mono text-xs">
                {m.mandateId || m.mandate_id || m.id?.slice(0, 12)}
              </TableCell>
              <TableCell>
                <Badge variant="outline" className="capitalize">
                  {m.type || m.mandate_type || 'payment'}
                </Badge>
              </TableCell>
              <TableCell>
                {priority ? (
                  <Badge variant="outline" className={`border-transparent ${priority.color}`}>
                    {priority.label}
                  </Badge>
                ) : (
                  <span className="text-gray-400">—</span>
                )}
              </TableCell>
              <TableCell>
                {formatCurrency(m.amount?.authorized ?? m.authorized_amount ?? 0, m.amount?.currency ?? m.currency ?? 'USD')}
              </TableCell>
              <TableCell>
                {formatCurrency(m.amount?.used ?? m.used_amount ?? 0, m.amount?.currency ?? m.currency ?? 'USD')}
              </TableCell>
              <TableCell>
                <Badge variant="outline" className={`border-transparent ${getStatusColor(m.status)}`}>
                  {m.status}
                </Badge>
              </TableCell>
              <TableCell className="text-sm">
                {m.createdAt || m.created_at ? format(new Date(m.createdAt || m.created_at), 'MMM d, yyyy') : '—'}
              </TableCell>
              <TableCell className="text-right">
                <Link
                  href={`/dashboard/agentic-payments/ap2/mandates/${m.id}`}
                  className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
                >
                  View
                </Link>
              </TableCell>
            </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

// Checkouts Tab — shows both ACP and UCP checkouts
function CheckoutsTab({ agentId }: { agentId: string }) {
  const api = useApiClient();
  const [checkouts, setCheckouts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);

  useEffect(() => {
    async function fetchCheckouts() {
      if (!api) return;
      try {
        // Fetch ACP checkouts (filtered by agent)
        const acpResult = await api.acp.list({ agent_id: agentId, limit: 50 });
        const acpRaw = acpResult as any;
        const acpData = Array.isArray(acpRaw?.data) ? acpRaw.data : (Array.isArray(acpRaw?.data?.data) ? acpRaw.data.data : []);
        const acpTagged = acpData.map((c: any) => ({ ...c, _protocol: 'acp' as const }));

        // Fetch UCP checkout sessions (server-side agent_id filter)
        let ucpTagged: any[] = [];
        try {
          const ucpResult = await api.ucp.checkouts.list({ agent_id: agentId, limit: 100 });
          const ucpRaw = ucpResult as any;
          const ucpFiltered = Array.isArray(ucpRaw?.data) ? ucpRaw.data : (Array.isArray(ucpRaw?.data?.data) ? ucpRaw.data.data : []);
          ucpTagged = ucpFiltered.map((s: any) => ({
            id: s.id,
            checkout_id: s.id?.slice(0, 12),
            merchant_name: s.metadata?.merchant_name || s.line_items?.[0]?.name || s.metadata?.scenario || 'UCP Checkout',
            total_amount: (s.totals?.find((t: any) => t.type === 'total')?.amount ?? 0) / 100,
            currency: s.currency || 'USD',
            status: s.status,
            created_at: s.created_at || s.createdAt,
            _protocol: 'ucp' as const,
          }));
        } catch {
          // UCP fetch failed — show ACP only
        }

        // Merge and sort by date descending
        const merged = [...acpTagged, ...ucpTagged].sort((a, b) => {
          const da = new Date(a.created_at || 0).getTime();
          const db = new Date(b.created_at || 0).getTime();
          return db - da;
        });

        setCheckouts(merged);
      } catch (error) {
        console.error('Failed to fetch checkouts:', error);
      } finally {
        setLoading(false);
      }
    }
    fetchCheckouts();
  }, [api, agentId]);

  const handleDelete = async (checkout: any) => {
    if (!api) return;
    if (!confirm(`Delete checkout "${checkout.checkout_id || checkout.id?.slice(0, 12)}"? This cannot be undone.`)) return;

    const key = `${checkout._protocol}-${checkout.id}`;
    setDeleting(key);
    try {
      if (checkout._protocol === 'ucp') {
        await api.ucp.checkouts.delete(checkout.id);
      } else {
        await api.acp.delete(checkout.id);
      }
      setCheckouts((prev) => prev.filter((c) => `${c._protocol}-${c.id}` !== key));
    } catch (error) {
      console.error('Failed to delete checkout:', error);
    } finally {
      setDeleting(null);
    }
  };

  if (loading) {
    return (
      <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-8 text-center">
        <div className="text-gray-500">Loading checkouts...</div>
      </div>
    );
  }

  if (checkouts.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-8 text-center">
        <ShoppingCart className="h-12 w-12 text-gray-400 mx-auto mb-4" />
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">No checkouts</h3>
        <p className="text-gray-500 dark:text-gray-400 mt-2">
          This agent has no linked checkouts.
        </p>
      </div>
    );
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed': return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-100';
      case 'pending': case 'requires_escalation': return 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-100';
      case 'cancelled': return 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-100';
      default: return 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-100';
    }
  };

  const getProtocolColor = (protocol: string) => {
    return protocol === 'ucp'
      ? 'bg-violet-100 text-violet-800 dark:bg-violet-900 dark:text-violet-100'
      : 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-100';
  };

  const getDetailHref = (c: any) => {
    return c._protocol === 'ucp'
      ? `/dashboard/agentic-payments/ucp/checkouts/${c.id}`
      : `/dashboard/agentic-payments/acp/checkouts/${c.id}`;
  };

  return (
    <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Checkout ID</TableHead>
            <TableHead>Protocol</TableHead>
            <TableHead>Merchant</TableHead>
            <TableHead>Total</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Created</TableHead>
            <TableHead className="text-right">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {checkouts.map((c: any) => (
            <TableRow key={`${c._protocol}-${c.id}`}>
              <TableCell className="font-mono text-xs">
                <Link href={getDetailHref(c)} className="text-blue-600 dark:text-blue-400 hover:underline">
                  {c.checkout_id || c.id?.slice(0, 12)}
                </Link>
              </TableCell>
              <TableCell>
                <Badge variant="outline" className={`border-transparent text-xs uppercase ${getProtocolColor(c._protocol)}`}>
                  {c._protocol}
                </Badge>
              </TableCell>
              <TableCell>{c.merchant_name || '—'}</TableCell>
              <TableCell>
                {formatCurrency(c.total_amount ?? 0, c.currency ?? 'USD')}
              </TableCell>
              <TableCell>
                <Badge variant="outline" className={`border-transparent ${getStatusColor(c.status)}`}>
                  {c.status}
                </Badge>
              </TableCell>
              <TableCell className="text-sm">
                {c.created_at ? format(new Date(c.created_at), 'MMM d, yyyy') : '—'}
              </TableCell>
              <TableCell className="text-right">
                <div className="flex items-center justify-end gap-2">
                  <Link
                    href={getDetailHref(c)}
                    className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    View
                  </Link>
                  <button
                    onClick={() => handleDelete(c)}
                    disabled={deleting === `${c._protocol}-${c.id}`}
                    className="p-1 rounded hover:bg-red-50 dark:hover:bg-red-950 text-gray-400 hover:text-red-600 dark:hover:text-red-400 disabled:opacity-50"
                    title="Delete checkout"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// KYA helpers — threshold-based usage bar colors
function getUsageBarColor(used: number, limit: number): string {
  if (!limit) return 'bg-blue-500';
  const pct = (used / limit) * 100;
  if (pct >= 90) return 'bg-red-500';
  if (pct >= 70) return 'bg-amber-500';
  return 'bg-blue-500';
}

function getUsageAlert(used: number, limit: number): { text: string; className: string } | null {
  if (!limit) return null;
  const pct = (used / limit) * 100;
  if (pct >= 90) return { text: `${pct.toFixed(0)}% — Approaching limit`, className: 'text-red-600 dark:text-red-400' };
  if (pct >= 80) return { text: `${pct.toFixed(0)}% — Elevated usage`, className: 'text-amber-600 dark:text-amber-400' };
  return null;
}

// KYA Tab
function KYATab({ agent, limits }: { agent: Agent; limits: AgentLimits | null }) {
  const tiers = [
    { tier: 1, name: 'Basic', daily: 1000, monthly: 10000, perTx: 500 },
    { tier: 2, name: 'Standard', daily: 10000, monthly: 100000, perTx: 5000 },
    { tier: 3, name: 'Premium', daily: 100000, monthly: 1000000, perTx: 50000 },
  ];

  return (
    <div className="space-y-6">
      <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
          Current KYA Status
        </h3>
        <div className="flex items-center gap-4">
          <div className="w-16 h-16 bg-blue-100 dark:bg-blue-950 rounded-xl flex items-center justify-center">
            <Shield className="h-8 w-8 text-blue-600 dark:text-blue-400" />
          </div>
          <div>
            <KyaTierBadge tier={agent.kyaTier} className="text-sm" />
            <div className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              {tiers.find(t => t.tier === agent.kyaTier)?.name || 'Unknown'} Verification Level
            </div>
          </div>
        </div>
      </div>

      <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
          Effective Limits
        </h3>
        <div className="grid grid-cols-3 gap-4">
          <div className="bg-gray-50 dark:bg-gray-900 rounded-xl p-4">
            <div className="text-sm text-gray-500 dark:text-gray-400 mb-1">Daily Limit</div>
            <div className="text-xl font-bold text-gray-900 dark:text-white">
              ${limits?.effectiveLimits?.daily?.toLocaleString() || '0'}
            </div>
          </div>
          <div className="bg-gray-50 dark:bg-gray-900 rounded-xl p-4">
            <div className="text-sm text-gray-500 dark:text-gray-400 mb-1">Monthly Limit</div>
            <div className="text-xl font-bold text-gray-900 dark:text-white">
              ${limits?.effectiveLimits?.monthly?.toLocaleString() || '0'}
            </div>
          </div>
          <div className="bg-gray-50 dark:bg-gray-900 rounded-xl p-4">
            <div className="text-sm text-gray-500 dark:text-gray-400 mb-1">Per Transaction</div>
            <div className="text-xl font-bold text-gray-900 dark:text-white">
              ${limits?.effectiveLimits?.perTransaction?.toLocaleString() || '0'}
            </div>
          </div>
        </div>
      </div>

      <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
          Usage Statistics
        </h3>
        <div className="space-y-4">
          <div>
            <div className="flex justify-between text-sm mb-1">
              <span className="text-gray-500 dark:text-gray-400">Daily Usage</span>
              <span className="text-gray-900 dark:text-white">
                ${limits?.usage?.daily?.toLocaleString() || '0'} / ${limits?.effectiveLimits?.daily?.toLocaleString() || '0'}
              </span>
            </div>
            <div className="h-2 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full ${getUsageBarColor(limits?.usage?.daily || 0, limits?.effectiveLimits?.daily || 0)}`}
                style={{
                  width: `${limits?.effectiveLimits?.daily ? (limits.usage.daily / limits.effectiveLimits.daily) * 100 : 0}%`,
                }}
              />
            </div>
            {(() => {
              const alert = getUsageAlert(limits?.usage?.daily || 0, limits?.effectiveLimits?.daily || 0);
              return alert ? (
                <div className={`flex items-center gap-1 mt-1 text-xs ${alert.className}`}>
                  <AlertTriangle className="h-3 w-3" />
                  {alert.text}
                </div>
              ) : null;
            })()}
          </div>
          <div>
            <div className="flex justify-between text-sm mb-1">
              <span className="text-gray-500 dark:text-gray-400">Monthly Usage</span>
              <span className="text-gray-900 dark:text-white">
                ${limits?.usage?.monthly?.toLocaleString() || '0'} / ${limits?.effectiveLimits?.monthly?.toLocaleString() || '0'}
              </span>
            </div>
            <div className="h-2 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full ${getUsageBarColor(limits?.usage?.monthly || 0, limits?.effectiveLimits?.monthly || 0)}`}
                style={{
                  width: `${limits?.effectiveLimits?.monthly ? (limits.usage.monthly / limits.effectiveLimits.monthly) * 100 : 0}%`,
                }}
              />
            </div>
            {(() => {
              const alert = getUsageAlert(limits?.usage?.monthly || 0, limits?.effectiveLimits?.monthly || 0);
              return alert ? (
                <div className={`flex items-center gap-1 mt-1 text-xs ${alert.className}`}>
                  <AlertTriangle className="h-3 w-3" />
                  {alert.text}
                </div>
              ) : null;
            })()}
          </div>
        </div>
      </div>
    </div>
  );
}

// Activity Tab - Real data from transfers, checkouts, and mandate executions
// A2A Tab — shows agent card, inbound/outbound tasks
function A2ATab({ agentId }: { agentId: string }) {
  const api = useApiClient();
  const { apiUrl } = useApiConfig();
  const [showCard, setShowCard] = useState(false);

  // Fetch agent card
  const { data: cardData, isLoading: cardLoading } = useTanstackQuery({
    queryKey: ['a2a-card', agentId],
    queryFn: async () => {
      if (!api) return null;
      const result = await api.a2a.getAgentCard(agentId);
      const raw = result as any;
      return raw?.data || raw || null;
    },
    enabled: !!api,
  });

  // Fetch A2A tasks
  const { data: tasksData, isLoading: tasksLoading } = useTanstackQuery({
    queryKey: ['a2a-tasks', agentId],
    queryFn: async () => {
      if (!api) return { data: [], pagination: null };
      const result = await api.a2a.listTasks({ agentId, limit: 50 });
      return result;
    },
    enabled: !!api,
  });

  const tasks = (tasksData as any)?.data || [];
  const cardUrl = `${apiUrl}/a2a/agents/${agentId}/card`;
  const rpcUrl = `${apiUrl}/a2a/${agentId}`;

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  const getStateColor = (state: string) => {
    switch (state) {
      case 'completed': return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300';
      case 'working': case 'submitted': return 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300';
      case 'input-required': return 'bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300';
      case 'failed': case 'rejected': return 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300';
      case 'canceled': return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';
      default: return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';
    }
  };

  return (
    <div className="space-y-6">
      {/* A2A Endpoint Info */}
      <div className="bg-gradient-to-r from-indigo-50 to-violet-50 dark:from-indigo-950/30 dark:to-violet-950/30 rounded-2xl p-6 border border-indigo-200 dark:border-indigo-900">
        <div className="flex items-center gap-3 mb-4">
          <Network className="h-6 w-6 text-indigo-600 dark:text-indigo-400" />
          <div>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">A2A Protocol</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              Google Agent-to-Agent protocol endpoints for this agent.
            </p>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Agent Card URL</label>
            <div className="flex items-center gap-2 mt-1">
              <code className="flex-1 px-3 py-2 bg-white dark:bg-gray-950 rounded-lg text-sm font-mono border border-gray-200 dark:border-gray-800 truncate">
                {cardUrl}
              </code>
              <button onClick={() => copyToClipboard(cardUrl)} className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg">
                <Copy className="h-4 w-4 text-gray-500" />
              </button>
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400">JSON-RPC Endpoint</label>
            <div className="flex items-center gap-2 mt-1">
              <code className="flex-1 px-3 py-2 bg-white dark:bg-gray-950 rounded-lg text-sm font-mono border border-gray-200 dark:border-gray-800 truncate">
                {rpcUrl}
              </code>
              <button onClick={() => copyToClipboard(rpcUrl)} className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg">
                <Copy className="h-4 w-4 text-gray-500" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Agent Card JSON */}
      <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Agent Card</h3>
          <div className="flex items-center gap-2">
            {cardData && (
              <button
                onClick={() => copyToClipboard(JSON.stringify(cardData, null, 2))}
                className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 flex items-center gap-1"
              >
                <Copy className="h-3 w-3" /> Copy JSON
              </button>
            )}
            <button
              onClick={() => setShowCard(!showCard)}
              className="text-xs text-blue-600 hover:text-blue-800"
            >
              {showCard ? 'Hide' : 'Show'}
            </button>
          </div>
        </div>
        {cardLoading && <div className="h-20 bg-gray-200 dark:bg-gray-800 rounded animate-pulse" />}
        {showCard && cardData && (
          <pre className="text-xs font-mono text-gray-800 dark:text-gray-200 bg-gray-50 dark:bg-gray-900 p-4 rounded-xl overflow-x-auto max-h-96 overflow-y-auto">
            {JSON.stringify(cardData, null, 2)}
          </pre>
        )}
        {!showCard && cardData && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-sm">
            <div>
              <dt className="text-gray-500 dark:text-gray-400">Skills</dt>
              <dd className="font-medium text-gray-900 dark:text-white">{(cardData as any).skills?.length || 0}</dd>
            </div>
            <div>
              <dt className="text-gray-500 dark:text-gray-400">Multi-Turn</dt>
              <dd className="font-medium text-gray-900 dark:text-white">{(cardData as any).capabilities?.multiTurn ? 'Yes' : 'No'}</dd>
            </div>
            <div>
              <dt className="text-gray-500 dark:text-gray-400">Extensions</dt>
              <dd className="font-medium text-gray-900 dark:text-white">{(cardData as any).extensions?.length || 0}</dd>
            </div>
            <div>
              <dt className="text-gray-500 dark:text-gray-400">Version</dt>
              <dd className="font-medium text-gray-900 dark:text-white">{(cardData as any).version || '—'}</dd>
            </div>
            <div>
              <dt className="text-gray-500 dark:text-gray-400">Rating</dt>
              <dd><AgentRatingBadge agentId={agentId} /></dd>
            </div>
          </div>
        )}
      </div>

      {/* A2A Tasks */}
      <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">A2A Tasks</h3>
        {tasksLoading && <div className="h-20 bg-gray-200 dark:bg-gray-800 rounded animate-pulse" />}
        {!tasksLoading && tasks.length === 0 && (
          <p className="text-sm text-gray-500 dark:text-gray-400">No A2A tasks yet. Tasks will appear here when other agents communicate with this agent.</p>
        )}
        {!tasksLoading && tasks.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Task ID</TableHead>
                <TableHead>Direction</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.map((task: any) => (
                <TableRow key={task.id}>
                  <TableCell className="font-mono text-xs">{task.id.slice(0, 8)}...</TableCell>
                  <TableCell>
                    <span className="text-xs text-gray-500">
                      {task.direction === 'inbound' ? 'Inbound' : 'Outbound'}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${getStateColor(task.state)}`}>
                      {task.state}
                    </span>
                  </TableCell>
                  <TableCell className="text-xs text-gray-500">{task.clientAgentId || task.remoteAgentUrl || '—'}</TableCell>
                  <TableCell className="text-xs text-gray-500">
                    {task.createdAt ? format(new Date(task.createdAt), 'MMM d, h:mm a') : '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}

// Epic 82 Story 82.7 — per-agent scopes tab. Shows just this agent's
// active grants + recent scope-lifecycle audit events. Read-only here;
// for issuing/approving requests use /dashboard/security/scopes (or
// the deep-link button at the top of this tab pre-filters to this id).

interface ScopeGrantMini {
  id: string;
  scope: 'tenant_read' | 'tenant_write' | 'treasury';
  lifecycle: 'one_shot' | 'standing';
  status: 'active' | 'consumed' | 'revoked' | 'expired';
  purpose: string;
  granted_at: string;
  expires_at: string;
  last_used_at: string | null;
  use_count: number;
  environment?: 'test' | 'live' | null;
}

interface ScopeAuditMini {
  id: string;
  action:
    | 'scope_requested'
    | 'scope_granted'
    | 'scope_denied'
    | 'scope_used'
    | 'scope_expired'
    | 'scope_revoked'
    | 'scope_heartbeat';
  scope: string | null;
  actor_type: string;
  request_summary: Record<string, unknown> | null;
  created_at: string;
}

const SCOPE_TAB_COLORS: Record<string, string> = {
  tenant_read: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200',
  tenant_write: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200',
  treasury: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200',
};

const SCOPE_TAB_ACTION_COLORS: Record<string, string> = {
  scope_requested: 'text-slate-600 dark:text-slate-300',
  scope_granted: 'text-green-600 dark:text-green-400',
  scope_denied: 'text-red-600 dark:text-red-400',
  scope_used: 'text-blue-600 dark:text-blue-400',
  scope_expired: 'text-slate-500 dark:text-slate-400',
  scope_revoked: 'text-orange-600 dark:text-orange-400',
  scope_heartbeat: 'text-slate-400',
};

function fmtRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

function fmtRemaining(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'expired';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s left`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m left`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h left`;
  return `${Math.round(ms / 86_400_000)}d left`;
}

function ScopesTab({ agentId }: { agentId: string }) {
  const apiFetch = useApiFetch();
  const { apiUrl } = useApiConfig();
  const queryClient = useQueryClient();

  async function unwrap<T>(res: Response): Promise<T> {
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    return (json?.data ?? json) as T;
  }

  const grantsQuery = useTanstackQuery({
    queryKey: ['agent-scopes', 'grants', agentId],
    queryFn: async () => {
      const res = await apiFetch(`${apiUrl}/v1/organization/scopes?agent_id=${agentId}`);
      return unwrap<{ grants: ScopeGrantMini[] }>(res);
    },
    refetchInterval: 30_000,
  });

  const auditQuery = useTanstackQuery({
    queryKey: ['agent-scopes', 'audit', agentId],
    queryFn: async () => {
      const res = await apiFetch(
        `${apiUrl}/v1/organization/scopes/audit?agent_id=${agentId}&limit=100`,
      );
      return unwrap<{ events: ScopeAuditMini[] }>(res);
    },
    refetchInterval: 30_000,
  });

  const revokeMutation = useMutation({
    mutationFn: async (grantId: string) => {
      const res = await apiFetch(`${apiUrl}/v1/organization/scopes/${grantId}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success('Grant revoked');
      queryClient.invalidateQueries({ queryKey: ['agent-scopes'] });
    },
    onError: (err: any) => toast.error(err.message ?? 'Revoke failed'),
  });

  const grants = grantsQuery.data?.grants ?? [];
  const events = auditQuery.data?.events ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Capability grants this agent currently holds, plus a complete history of every
          request, decision, use, and revocation. Issuing new grants happens on the global
          scopes dashboard.
        </p>
        <Link
          href={`/dashboard/security/scopes`}
          className="shrink-0 inline-flex items-center gap-1 rounded-md border border-gray-300 dark:border-gray-700 px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800"
        >
          Issue / approve →
        </Link>
      </div>

      {/* Active grants */}
      <div className="rounded-lg border border-gray-200 dark:border-gray-800">
        <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-800 p-4">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            Active grants ({grants.length})
          </h3>
        </div>
        {grants.length === 0 ? (
          <div className="p-6 text-center text-sm text-gray-500 dark:text-gray-400">
            No active grants. This agent is operating at default <code className="rounded bg-gray-100 dark:bg-gray-800 px-1 py-0.5">agent</code> scope.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-900 text-left text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
              <tr>
                <th className="p-3">Scope</th>
                <th className="p-3">Lifecycle</th>
                <th className="p-3">Purpose</th>
                <th className="p-3">Used</th>
                <th className="p-3">Expires</th>
                <th className="p-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
              {grants.map((g) => (
                <tr key={g.id} className="hover:bg-gray-50 dark:hover:bg-gray-900">
                  <td className="p-3">
                    <span className={`inline-flex rounded px-1.5 py-0.5 text-xs font-medium ${SCOPE_TAB_COLORS[g.scope]}`}>
                      {g.scope}
                    </span>
                  </td>
                  <td className="p-3 text-xs text-gray-600 dark:text-gray-300">{g.lifecycle}</td>
                  <td className="p-3 text-gray-700 dark:text-gray-200">{g.purpose}</td>
                  <td className="p-3 text-xs text-gray-500">
                    {g.use_count}× {g.last_used_at ? `· last ${fmtRelative(g.last_used_at)}` : ''}
                  </td>
                  <td className="p-3 text-xs text-gray-500">{fmtRemaining(g.expires_at)}</td>
                  <td className="p-3 text-right">
                    <button
                      onClick={() => {
                        if (window.confirm(`Revoke ${g.scope} grant?`)) {
                          revokeMutation.mutate(g.id);
                        }
                      }}
                      disabled={revokeMutation.isPending}
                      className="inline-flex items-center gap-1 rounded-md border border-gray-300 dark:border-gray-700 px-2 py-1 text-xs text-gray-700 dark:text-gray-300 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950"
                    >
                      <Trash2 className="h-3 w-3" />
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Audit feed */}
      <div className="rounded-lg border border-gray-200 dark:border-gray-800">
        <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-800 p-4">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            Recent activity ({events.length})
          </h3>
        </div>
        {events.length === 0 ? (
          <div className="p-6 text-center text-sm text-gray-500 dark:text-gray-400">
            No scope events yet.
          </div>
        ) : (
          <ul className="max-h-[480px] divide-y divide-gray-200 dark:divide-gray-800 overflow-y-auto">
            {events.map((e) => {
              const summary = e.request_summary as any;
              return (
                <li key={e.id} className="flex flex-wrap items-center gap-3 p-3 text-xs">
                  <span className="w-16 shrink-0 text-gray-400">{fmtRelative(e.created_at)}</span>
                  <span className={`w-24 shrink-0 font-medium ${SCOPE_TAB_ACTION_COLORS[e.action] ?? ''}`}>
                    {e.action.replace('scope_', '')}
                  </span>
                  {e.scope && (
                    <span className={`inline-flex rounded px-1.5 py-0.5 text-[10px] font-medium ${SCOPE_TAB_COLORS[e.scope]}`}>
                      {e.scope}
                    </span>
                  )}
                  <span className="text-[10px] text-gray-400">via {e.actor_type}</span>
                  {summary?.purpose ? (
                    <span className="truncate text-gray-700 dark:text-gray-300">
                      {String(summary.purpose)}
                    </span>
                  ) : null}
                  {summary?.reason ? (
                    <span className="truncate text-red-600 dark:text-red-400">
                      reason: {String(summary.reason)}
                    </span>
                  ) : null}
                  {summary?.route ? (
                    <span className="font-mono text-[10px] text-gray-500">{String(summary.route)}</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function ActivityTab({ agentId }: { agentId: string }) {
  const api = useApiClient();

  // Fetch unified agent transactions (all protocols in one call)
  const { data: txData, isLoading } = useTanstackQuery({
    queryKey: ['agent-transactions', agentId, 'activity'],
    queryFn: async () => {
      if (!api) return [];
      const result = await api.agents.getTransactions(agentId, { limit: 50 });
      const raw = result as any;
      return Array.isArray(raw?.data) ? raw.data : [];
    },
    enabled: !!api,
  });

  // Map unified transactions to AgentAction format
  const mapType = (tx: any): AgentAction['type'] => {
    if (tx.type === 'a2a_task') return 'a2a_task';
    return 'transfer';
  };
  const activities: AgentAction[] = (txData || []).map((tx: any) => ({
    id: tx.id,
    timestamp: tx.created_at,
    type: mapType(tx),
    status: tx.status === 'completed' || tx.status === 'success' ? 'success' as const : tx.status === 'failed' || tx.status === 'canceled' ? 'failed' as const : 'pending' as const,
    description: tx.description || `${tx.type} ${tx.type === 'a2a_task' ? 'task' : 'transfer'}`,
    details: {
      amount: tx.amount ?? 0,
      currency: tx.currency || 'USDC',
      recipient: tx.to_account_name || undefined,
      reference: tx.id?.slice(0, 12),
      // External x402: agent paid an on-chain address outside the Sly ledger.
      externalAddress: tx.external?.to_address || undefined,
      settlementNetwork: tx.external?.settlement_network || undefined,
      txHash: tx.external?.tx_hash || undefined,
    },
  }));

  return (
    <div className="space-y-6">
      {/* Activity Header */}
      <div className="bg-gradient-to-r from-purple-50 to-blue-50 dark:from-purple-950/30 dark:to-blue-950/30 rounded-2xl p-6 border border-purple-200 dark:border-purple-900">
        <div className="flex items-center gap-3">
          <Bot className="h-6 w-6 text-purple-600 dark:text-purple-400" />
          <div>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Agent Activity Log</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              All actions performed by this agent — transfers, checkouts, A2A tasks, and mandate executions.
            </p>
          </div>
        </div>
      </div>

      {isLoading ? (
        <div className="h-40 bg-gray-200 dark:bg-gray-800 rounded-2xl animate-pulse" />
      ) : (
        <AgentActivityFeed activities={activities} showFilters={true} />
      )}
    </div>
  );
}

// ─── Agent Readiness Pill ──────────────────────────────
// Compact "can this agent actually shop?" glance next to the status pill.
// Rolls up four checks (provisioned EOA · on-chain funds · auto-refill ·
// KYA tier) into a single Ready / Partial / Setup / Blocked state, with a
// hover popover that spells each check out. Keeps tenants from having to
// flip between the Wallet tab, KYA tab, and agent detail to confirm an
// agent can run.

function AgentReadinessPill({
  agentId,
  agentStatus,
  kyaTier,
}: {
  agentId: string;
  agentStatus: string | undefined;
  kyaTier: number | undefined;
}) {
  const api = useApiClient();
  const apiFetch = useApiFetch();
  const { apiUrl, apiEnvironment } = useApiConfig();

  // Agent wallets — want to know if an EOA exists and its balance.
  const { data: walletData } = useTanstackQuery({
    queryKey: ['readiness-wallet', agentId, apiEnvironment],
    queryFn: async () => {
      if (!api) return null;
      try {
        const raw: any = await api.agents.getWallet(agentId);
        return raw?.data ?? raw ?? null;
      } catch {
        return null;
      }
    },
    enabled: !!api,
    staleTime: 30_000,
  });

  // Auto-refill policy — unlocks the "has-fallback-funding" check even
  // when the EOA balance is currently low.
  const { data: autoRefill } = useTanstackQuery({
    queryKey: ['readiness-auto-refill', agentId, apiEnvironment],
    queryFn: async () => {
      try {
        const res = await apiFetch(`${apiUrl}/v1/agents/${agentId}/auto-refill`);
        if (!res.ok) return null;
        const body = await res.json();
        return body.data || body;
      } catch {
        return null;
      }
    },
    enabled: !!apiUrl,
    staleTime: 60_000,
  });

  const eoa = (walletData?.all_wallets || []).find((w: any) => w.wallet_type === 'agent_eoa');
  const provisioned = !!eoa;
  const eoaBalance = eoa ? Number(eoa.balance || 0) : 0;
  const hasAutoRefill = !!autoRefill?.enabled;
  const funded = eoaBalance > 0 || hasAutoRefill;
  const isActive = agentStatus === 'active';
  const tier = typeof kyaTier === 'number' ? kyaTier : null;

  const [state, label, cls] = ((): [string, string, string] => {
    if (!isActive) return ['blocked', 'Blocked', 'bg-red-100 dark:bg-red-950 text-red-700 dark:text-red-400'];
    if (provisioned && funded) return ['ready', 'Ready to shop', 'bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-400'];
    if (provisioned) return ['partial', 'Needs funding', 'bg-amber-100 dark:bg-amber-950 text-amber-700 dark:text-amber-400'];
    return ['setup', 'Setup needed', 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300'];
  })();

  const [showPopover, setShowPopover] = useState(false);

  return (
    <div className="relative" onMouseEnter={() => setShowPopover(true)} onMouseLeave={() => setShowPopover(false)}>
      <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-full cursor-help ${cls}`}>
        <span className={`w-1.5 h-1.5 rounded-full ${
          state === 'ready' ? 'bg-emerald-500'
          : state === 'partial' ? 'bg-amber-500'
          : state === 'blocked' ? 'bg-red-500'
          : 'bg-gray-400'
        }`} />
        {label}
      </span>
      {showPopover && (
        <div className="absolute right-0 top-full mt-2 z-50 w-72 p-3 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl shadow-xl">
          <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">Readiness</div>
          <ul className="space-y-1.5 text-sm">
            <ReadinessLine ok={isActive} label={isActive ? 'Agent is active' : `Agent is ${agentStatus}`} />
            <ReadinessLine ok={provisioned} label={provisioned ? 'x402 signing key provisioned' : 'No x402 signing key'} />
            <ReadinessLine
              ok={funded}
              label={
                eoaBalance > 0
                  ? `Funded (${eoaBalance.toFixed(3)} USDC on-chain)`
                  : hasAutoRefill
                    ? 'Auto-refill enabled (falls back to Circle master)'
                    : 'No funds; auto-refill off'
              }
            />
            <ReadinessLine
              ok={tier != null}
              label={tier != null ? `KYA Tier ${tier}` : 'KYA tier unknown'}
            />
          </ul>
        </div>
      )}
    </div>
  );
}

function ReadinessLine({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li className="flex items-start gap-2">
      {ok
        ? <CheckCircle2 className="h-4 w-4 text-emerald-500 flex-shrink-0 mt-0.5" />
        : <XCircle className="h-4 w-4 text-gray-400 flex-shrink-0 mt-0.5" />
      }
      <span className={ok ? 'text-gray-900 dark:text-gray-100' : 'text-gray-500 dark:text-gray-400'}>
        {label}
      </span>
    </li>
  );
}

