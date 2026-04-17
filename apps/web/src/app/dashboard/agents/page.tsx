'use client';

import { useMemo, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useApiClient, useApiConfig, useApiFetch } from '@/lib/api-client';
import { Bot, Plus, Search, ArrowDownNarrowWide, ArrowUpNarrowWide, Star, Shield } from 'lucide-react';
import Link from 'next/link';
import { AgentsEmptyState } from '@/components/ui/empty-state';
import { CardListSkeleton } from '@/components/ui/skeletons';
import { usePagination } from '@/hooks/usePagination';
import { PaginationControls } from '@/components/ui/pagination-controls';
import { AgentAvatar } from '@/components/agents/agent-avatar';

const TIER_COLORS: Record<string, string> = {
  A: 'bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-400',
  B: 'bg-blue-100 dark:bg-blue-950 text-blue-700 dark:text-blue-400',
  C: 'bg-yellow-100 dark:bg-yellow-950 text-yellow-700 dark:text-yellow-400',
  D: 'bg-orange-100 dark:bg-orange-950 text-orange-700 dark:text-orange-400',
  E: 'bg-red-100 dark:bg-red-950 text-red-700 dark:text-red-400',
  F: 'bg-gray-100 dark:bg-gray-900 text-gray-500 dark:text-gray-500',
};

type SortKey = 'reputation' | 'name' | 'kya_tier' | 'transactions' | 'recent';
type SortDir = 'asc' | 'desc';
type StatusFilter = 'all' | 'active' | 'paused' | 'inactive';

function formatRepBadge(score: number | null, tier: string | null, ratingCount = 0) {
  if (score == null) return null;
  const t = tier || 'F';
  const title = `Trust score ${score}/1000${ratingCount > 0 ? ` · ${ratingCount} rating${ratingCount === 1 ? '' : 's'}` : ''}`;
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full ${TIER_COLORS[t] ?? TIER_COLORS.F}`}
      title={title}
    >
      <Shield className="h-3 w-3" />
      {t} · {score}
      {ratingCount > 0 && (
        <>
          <span className="opacity-60">·</span>
          <Star className="h-3 w-3 fill-current opacity-70" />
          {ratingCount}
        </>
      )}
    </span>
  );
}

export default function AgentsPage() {
  const api = useApiClient();
  const { apiUrl, isConfigured, isLoading: isAuthLoading, apiEnvironment } = useApiConfig();
  const apiFetch = useApiFetch();

  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('reputation');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [tierFilter, setTierFilter] = useState<number | 'all'>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [onlyWithRatings, setOnlyWithRatings] = useState(false);

  const { data: countData } = useQuery({
    queryKey: ['agents', 'count', apiEnvironment],
    queryFn: async () => {
      if (!api) throw new Error('API client not initialized');
      return api.agents.list({ limit: 1 });
    },
    enabled: !!api && isConfigured,
    staleTime: 60 * 1000,
  });

  const pagination = usePagination({
    totalItems: (countData as any)?.data?.pagination?.total || (countData as any)?.pagination?.total || 0,
    initialPageSize: 50,
  });

  const { data: agentsData, isLoading: loading } = useQuery({
    queryKey: ['agents', 'page', pagination.page, pagination.pageSize, apiEnvironment],
    queryFn: async () => {
      if (!api) throw new Error('API client not initialized');
      return api.agents.list({ page: pagination.page, limit: pagination.pageSize });
    },
    enabled: !!api && isConfigured,
    staleTime: 30 * 1000,
  });

  const rawData = (agentsData as any)?.data;
  const agents: any[] = Array.isArray(rawData)
    ? rawData
    : Array.isArray((rawData as any)?.data)
      ? (rawData as any).data
      : [];

  // Parallel reputation fetch for every agent on this page
  const reputationQueries = useQueries({
    queries: agents.map((a) => ({
      queryKey: ['reputation', a.id],
      queryFn: async () => {
        const r = await apiFetch(`${apiUrl}/v1/reputation/${a.id}`);
        if (!r.ok) return null;
        const j = await r.json();
        return (j?.data || j) as { score: number | null; tier: string | null; dataPoints?: number; ratingCount?: number };
      },
      enabled: !!apiUrl && !!a.id,
      staleTime: 5 * 60 * 1000,
    })),
  });

  const repByAgent = useMemo(() => {
    const m: Record<string, { score: number | null; tier: string | null; dataPoints: number; ratingCount: number }> = {};
    agents.forEach((a, i) => {
      const d = reputationQueries[i]?.data as any;
      m[a.id] = {
        score: d?.score ?? null,
        tier: d?.tier ?? null,
        dataPoints: d?.dataPoints ?? 0,
        ratingCount: d?.ratingCount ?? 0,
      };
    });
    return m;
  }, [agents, reputationQueries]);

  const displayedAgents = useMemo(() => {
    const s = search.trim().toLowerCase();
    const filtered = agents.filter((a: any) => {
      if (s && !(a.name || '').toLowerCase().includes(s) && !(a.description || '').toLowerCase().includes(s)) return false;
      if (tierFilter !== 'all' && a.kyaTier !== tierFilter && a.kya_tier !== tierFilter) return false;
      if (statusFilter !== 'all' && a.status !== statusFilter) return false;
      if (onlyWithRatings && (repByAgent[a.id]?.ratingCount ?? 0) === 0) return false;
      return true;
    });

    const dir = sortDir === 'asc' ? 1 : -1;
    filtered.sort((a: any, b: any) => {
      let av: any, bv: any;
      switch (sortKey) {
        case 'name':
          av = (a.name || '').toLowerCase();
          bv = (b.name || '').toLowerCase();
          return av < bv ? -1 * dir : av > bv ? 1 * dir : 0;
        case 'kya_tier':
          av = a.kyaTier ?? a.kya_tier ?? 0;
          bv = b.kyaTier ?? b.kya_tier ?? 0;
          return (av - bv) * dir;
        case 'transactions':
          av = a.total_transactions ?? a.totalTransactions ?? 0;
          bv = b.total_transactions ?? b.totalTransactions ?? 0;
          return (av - bv) * dir;
        case 'recent':
          av = new Date(a.updated_at ?? a.updatedAt ?? a.created_at ?? 0).getTime();
          bv = new Date(b.updated_at ?? b.updatedAt ?? b.created_at ?? 0).getTime();
          return (av - bv) * dir;
        case 'reputation':
        default:
          av = repByAgent[a.id]?.score ?? -1;
          bv = repByAgent[b.id]?.score ?? -1;
          return (av - bv) * dir;
      }
    });
    return filtered;
  }, [agents, search, tierFilter, statusFilter, onlyWithRatings, sortKey, sortDir, repByAgent]);

  if (isAuthLoading) {
    return (
      <div className="p-8 max-w-[1600px] mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">Agents</h1>
            <p className="text-gray-600 dark:text-gray-400">Manage AI agents and their permissions</p>
          </div>
        </div>
        <div className="col-span-full">
          <CardListSkeleton count={6} />
        </div>
      </div>
    );
  }

  if (!isConfigured) {
    return (
      <div className="p-8">
        <div className="text-center py-12">
          <Bot className="h-12 w-12 text-gray-400 mx-auto mb-4" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Configure API Key</h2>
          <p className="text-gray-500 dark:text-gray-400 mt-2">
            Please configure your API key to view agents.
          </p>
          <Link
            href="/dashboard/api-keys"
            className="inline-flex mt-4 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700"
          >
            Configure API Key
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-[1600px] mx-auto">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">Agents</h1>
          <p className="text-gray-600 dark:text-gray-400">Manage AI agents and their permissions</p>
        </div>
        <button className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors">
          <Plus className="h-4 w-4" />
          Create Agent
        </button>
      </div>

      <div className="flex flex-col gap-3 mb-6">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex-1 min-w-[220px] relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              type="text"
              placeholder="Search agents..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-10 pr-4 py-2 text-sm bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <select
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as SortKey)}
            className="px-3 py-2 text-sm bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            title="Sort by"
          >
            <option value="reputation">Sort: Reputation</option>
            <option value="name">Sort: Name</option>
            <option value="kya_tier">Sort: KYA Tier</option>
            <option value="transactions">Sort: Transactions</option>
            <option value="recent">Sort: Last activity</option>
          </select>

          <button
            onClick={() => setSortDir(sortDir === 'asc' ? 'desc' : 'asc')}
            className="flex items-center gap-1.5 px-3 py-2 text-sm bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800"
            title={sortDir === 'asc' ? 'Ascending' : 'Descending'}
          >
            {sortDir === 'asc' ? <ArrowUpNarrowWide className="h-4 w-4" /> : <ArrowDownNarrowWide className="h-4 w-4" />}
            {sortDir === 'asc' ? 'Asc' : 'Desc'}
          </button>

          <select
            value={tierFilter === 'all' ? 'all' : String(tierFilter)}
            onChange={(e) => setTierFilter(e.target.value === 'all' ? 'all' : Number(e.target.value))}
            className="px-3 py-2 text-sm bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg"
          >
            <option value="all">All tiers</option>
            <option value="0">T0</option>
            <option value="1">T1</option>
            <option value="2">T2</option>
            <option value="3">T3</option>
          </select>

          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            className="px-3 py-2 text-sm bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg"
          >
            <option value="all">Any status</option>
            <option value="active">Active</option>
            <option value="paused">Paused</option>
            <option value="inactive">Inactive</option>
          </select>

          <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={onlyWithRatings}
              onChange={(e) => setOnlyWithRatings(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 dark:border-gray-700 text-blue-600 focus:ring-blue-500"
            />
            Only rated
          </label>
        </div>

        <div className="text-xs text-gray-500 dark:text-gray-400">
          Showing {displayedAgents.length} of {agents.length} on this page
        </div>
      </div>

      {!loading && displayedAgents.length > 0 && (
        <PaginationControls pagination={pagination} className="mb-4" />
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {loading ? (
          <div className="col-span-full">
            <CardListSkeleton count={6} />
          </div>
        ) : displayedAgents.length === 0 ? (
          <div className="col-span-full">
            {agents.length > 0 ? (
              <div className="p-8 text-center">
                <div className="text-5xl mb-4">🔍</div>
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white">No agents match your filters</h3>
                <p className="text-gray-500 dark:text-gray-400 mt-2">Try loosening the filters or clearing the search.</p>
              </div>
            ) : (
              <AgentsEmptyState />
            )}
          </div>
        ) : (
          displayedAgents.map((agent: any) => {
            const rep = repByAgent[agent.id];
            return (
              <div
                key={agent.id}
                onClick={() => (window.location.href = `/dashboard/agents/${agent.id}`)}
                className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6 hover:shadow-lg transition-shadow cursor-pointer"
              >
                <div className="flex items-start justify-between mb-4">
                  <AgentAvatar agent={agent} size="md" />
                  <span
                    className={`px-2.5 py-1 text-xs font-medium rounded-full ${
                      agent.status === 'active'
                        ? 'bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-400'
                        : agent.status === 'paused'
                          ? 'bg-yellow-100 dark:bg-yellow-950 text-yellow-700 dark:text-yellow-400'
                          : 'bg-red-100 dark:bg-red-950 text-red-700 dark:text-red-400'
                    }`}
                  >
                    {agent.status}
                  </span>
                </div>
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">{agent.name}</h3>
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">{agent.description || 'No description'}</p>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-500 dark:text-gray-400">KYA Tier {agent.kyaTier ?? agent.kya_tier ?? 0}</span>
                  {formatRepBadge(rep?.score ?? null, rep?.tier ?? null, rep?.ratingCount ?? 0)}
                </div>
              </div>
            );
          })
        )}
      </div>

      {!loading && displayedAgents.length > 0 && (
        <PaginationControls pagination={pagination} className="mt-6" />
      )}
    </div>
  );
}
