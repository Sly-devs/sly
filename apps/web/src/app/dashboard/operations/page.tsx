'use client';

import { useQuery } from '@tanstack/react-query';
import { useApiConfig } from '@/lib/api-client';
import {
  Activity,
  BarChart3,
  DollarSign,
  Zap,
  CheckCircle2,
  XCircle,
  ChevronRight,
  Filter,
} from 'lucide-react';
import { formatCurrency } from '@sly/ui';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState, useEffect } from 'react';
import Link from 'next/link';

interface UsageSummary {
  period: { start: string; end: string };
  totalRequests: number;
  totalOperations: number;
  totalCostUsd: number;
  byCategory: Record<string, number>;
  byProtocol: Record<string, number>;
}

interface RequestAggregations {
  period: { start: string; end: string };
  groupBy: string;
  aggregations: Record<string, { count: number; avgDurationMs: number }>;
}

interface CostBreakdown {
  period: { start: string; end: string };
  totalCostUsd: number;
  byCategory: Record<string, number>;
  byCostKey: Record<string, number>;
}

interface OperationEvent {
  id: string;
  type: string;
  time: string;
  category: string;
  operation: string;
  subject: string;
  actor_type: string;
  actor_id: string;
  protocol: string | null;
  success: boolean;
  amount_usd: string | null;
  currency: string | null;
  duration_ms: number | null;
  correlation_id: string | null;
  data: Record<string, unknown>;
}

const PROTOCOL_COLORS: Record<string, string> = {
  ucp: 'bg-blue-500',
  acp: 'bg-purple-500',
  ap2: 'bg-green-500',
  x402: 'bg-orange-500',
  a2a: 'bg-pink-500',
  cctp: 'bg-cyan-500',
};

const PROTOCOL_TEXT_COLORS: Record<string, string> = {
  ucp: 'text-blue-700 bg-blue-50 dark:text-blue-300 dark:bg-blue-900/30',
  acp: 'text-purple-700 bg-purple-50 dark:text-purple-300 dark:bg-purple-900/30',
  ap2: 'text-green-700 bg-green-50 dark:text-green-300 dark:bg-green-900/30',
  x402: 'text-orange-700 bg-orange-50 dark:text-orange-300 dark:bg-orange-900/30',
  a2a: 'text-pink-700 bg-pink-50 dark:text-pink-300 dark:bg-pink-900/30',
  cctp: 'text-cyan-700 bg-cyan-50 dark:text-cyan-300 dark:bg-cyan-900/30',
};

const CATEGORY_LABELS: Record<string, string> = {
  settlement: 'Settlement',
  wallet: 'Wallet',
  ucp: 'UCP',
  acp: 'ACP',
  ap2: 'AP2',
  x402: 'x402',
  governance: 'Governance',
  compliance: 'Compliance',
  entity: 'Entity',
  a2a: 'A2A',
  discovery: 'Discovery',
};

// Deterministic color for correlation grouping
function correlationColor(id: string | null): string {
  if (!id) return '';
  const colors = [
    'border-l-blue-400', 'border-l-green-400', 'border-l-purple-400',
    'border-l-orange-400', 'border-l-pink-400', 'border-l-cyan-400',
    'border-l-yellow-400', 'border-l-red-400',
  ];
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  return colors[Math.abs(hash) % colors.length];
}

async function fetchUsage(path: string, token: string, baseUrl: string) {
  const res = await fetch(`${baseUrl}/v1/usage${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Usage API error: ${res.status}`);
  const json = await res.json();
  return json;
}

export default function OperationsPage() {
  const { isConfigured, isLoading: configLoading, authToken, apiKey, apiUrl } = useApiConfig();
  const token = authToken || apiKey || '';
  const router = useRouter();
  const searchParams = useSearchParams();

  // Filter state from URL params
  const [categoryFilter, setCategoryFilter] = useState(searchParams.get('category') || '');
  const [protocolFilter, setProtocolFilter] = useState(searchParams.get('protocol') || '');
  const [successFilter, setSuccessFilter] = useState(searchParams.get('success') || '');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  // Sync filters with URL
  useEffect(() => {
    setCategoryFilter(searchParams.get('category') || '');
    setProtocolFilter(searchParams.get('protocol') || '');
    setSuccessFilter(searchParams.get('success') || '');
  }, [searchParams]);

  const updateFilters = (updates: Record<string, string>) => {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    router.push(`/dashboard/operations?${params.toString()}`);
    setPage(1);
  };

  const { data: summary, isLoading: summaryLoading } = useQuery<UsageSummary>({
    queryKey: ['operations', 'summary'],
    queryFn: async () => (await fetchUsage('/summary', token, apiUrl)).data,
    enabled: isConfigured && !!token,
    staleTime: 60 * 1000,
  });

  const { data: requests, isLoading: requestsLoading } = useQuery<RequestAggregations>({
    queryKey: ['operations', 'requests'],
    queryFn: async () => (await fetchUsage('/requests?group_by=path_template', token, apiUrl)).data,
    enabled: isConfigured && !!token,
    staleTime: 60 * 1000,
  });

  const { data: costs, isLoading: costsLoading } = useQuery<CostBreakdown>({
    queryKey: ['operations', 'costs'],
    queryFn: async () => (await fetchUsage('/costs', token, apiUrl)).data,
    enabled: isConfigured && !!token,
    staleTime: 60 * 1000,
  });

  // Build operations query string
  const opsQueryParts = [`limit=${pageSize}&page=${page}`];
  if (categoryFilter) opsQueryParts.push(`category=${categoryFilter}`);
  if (protocolFilter) opsQueryParts.push(`protocol=${protocolFilter}`);
  if (successFilter) opsQueryParts.push(`success=${successFilter}`);

  const { data: opsResponse, isLoading: opsLoading } = useQuery<{
    data: OperationEvent[];
    pagination: { page: number; limit: number; total: number; totalPages: number };
  }>({
    queryKey: ['operations', 'events', categoryFilter, protocolFilter, successFilter, page, pageSize],
    queryFn: () => fetchUsage(`/operations?${opsQueryParts.join('&')}`, token, apiUrl),
    enabled: isConfigured && !!token,
    staleTime: 30 * 1000,
  });

  if (configLoading) {
    return <div className="p-6 text-gray-500">Loading...</div>;
  }

  if (!isConfigured) {
    return (
      <div className="p-6">
        <p className="text-gray-500">Configure your API connection in Settings to view operations data.</p>
      </div>
    );
  }

  const isLoading = summaryLoading || requestsLoading || costsLoading;
  const events = opsResponse?.data || [];
  const pagination = opsResponse?.pagination;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Operations</h1>
          <p className="text-sm text-gray-500 mt-1">
            Platform usage, costs, and protocol activity — last 30 days
          </p>
        </div>
      </div>

      {/* KPI Row */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <KpiCard
          label="API Requests"
          value={summary?.totalRequests?.toLocaleString() ?? '—'}
          icon={<Zap className="h-5 w-5 text-blue-500" />}
          loading={isLoading}
        />
        <KpiCard
          label="Operations"
          value={summary?.totalOperations?.toLocaleString() ?? '—'}
          icon={<Activity className="h-5 w-5 text-green-500" />}
          loading={isLoading}
        />
        <KpiCard
          label="Protocols Active"
          value={String(Object.keys(summary?.byProtocol ?? {}).length)}
          icon={<BarChart3 className="h-5 w-5 text-purple-500" />}
          loading={isLoading}
        />
        <KpiCard
          label="External Costs"
          value={summary ? formatCurrency(summary.totalCostUsd) : '—'}
          icon={<DollarSign className="h-5 w-5 text-orange-500" />}
          loading={isLoading}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Protocol Breakdown — clickable rows */}
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Protocol Volume</h2>
          {!summary?.byProtocol || Object.keys(summary.byProtocol).length === 0 ? (
            <p className="text-sm text-gray-500">No protocol activity yet.</p>
          ) : (
            <div className="space-y-3">
              {Object.entries(summary.byProtocol)
                .sort(([, a], [, b]) => b - a)
                .map(([protocol, count]) => {
                  const total = summary.totalOperations || 1;
                  const pct = Math.round((count / total) * 100);
                  return (
                    <button
                      key={protocol}
                      onClick={() => updateFilters({ protocol, category: '' })}
                      className="flex items-center gap-3 w-full hover:bg-gray-50 dark:hover:bg-gray-700/50 rounded-lg px-2 py-1 -mx-2 transition-colors cursor-pointer"
                    >
                      <span className="text-sm font-medium text-gray-700 dark:text-gray-300 w-16 uppercase text-left">
                        {protocol}
                      </span>
                      <div className="flex-1 bg-gray-100 dark:bg-gray-700 rounded-full h-2">
                        <div
                          className={`h-2 rounded-full ${PROTOCOL_COLORS[protocol] || 'bg-gray-400'}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="text-sm text-gray-500 w-20 text-right">
                        {count.toLocaleString()} ({pct}%)
                      </span>
                      <ChevronRight className="h-3 w-3 text-gray-400" />
                    </button>
                  );
                })}
            </div>
          )}
        </div>

        {/* Category Breakdown — clickable rows */}
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Operations by Category</h2>
          {!summary?.byCategory || Object.keys(summary.byCategory).length === 0 ? (
            <p className="text-sm text-gray-500">No operations recorded yet.</p>
          ) : (
            <div className="space-y-2">
              {Object.entries(summary.byCategory)
                .sort(([, a], [, b]) => b - a)
                .map(([cat, count]) => (
                  <button
                    key={cat}
                    onClick={() => updateFilters({ category: cat, protocol: '' })}
                    className="flex items-center justify-between py-1 w-full hover:bg-gray-50 dark:hover:bg-gray-700/50 rounded-lg px-2 -mx-2 transition-colors cursor-pointer"
                  >
                    <span className="text-sm text-gray-700 dark:text-gray-300">
                      {CATEGORY_LABELS[cat] || cat}
                    </span>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-mono text-gray-900 dark:text-white">
                        {count.toLocaleString()}
                      </span>
                      <ChevronRight className="h-3 w-3 text-gray-400" />
                    </div>
                  </button>
                ))}
            </div>
          )}
        </div>
      </div>

      {/* Event Log Stream */}
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
        <div className="p-4 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Event Log</h2>
            <div className="flex items-center gap-2">
              <Filter className="h-4 w-4 text-gray-400" />
              {/* Category filter */}
              <select
                value={categoryFilter}
                onChange={(e) => updateFilters({ category: e.target.value })}
                className="text-xs border border-gray-300 dark:border-gray-600 rounded px-2 py-1 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300"
              >
                <option value="">All Categories</option>
                {Object.entries(CATEGORY_LABELS).map(([key, label]) => (
                  <option key={key} value={key}>{label}</option>
                ))}
              </select>
              {/* Protocol filter */}
              <select
                value={protocolFilter}
                onChange={(e) => updateFilters({ protocol: e.target.value })}
                className="text-xs border border-gray-300 dark:border-gray-600 rounded px-2 py-1 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300"
              >
                <option value="">All Protocols</option>
                {Object.keys(PROTOCOL_COLORS).map((p) => (
                  <option key={p} value={p}>{p.toUpperCase()}</option>
                ))}
              </select>
              {/* Success filter */}
              <select
                value={successFilter}
                onChange={(e) => updateFilters({ success: e.target.value })}
                className="text-xs border border-gray-300 dark:border-gray-600 rounded px-2 py-1 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300"
              >
                <option value="">All Status</option>
                <option value="true">Success</option>
                <option value="false">Failed</option>
              </select>
              {(categoryFilter || protocolFilter || successFilter) && (
                <button
                  onClick={() => updateFilters({ category: '', protocol: '', success: '' })}
                  className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                >
                  Clear
                </button>
              )}
              {/* Page size */}
              <select
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value));
                  setPage(1);
                }}
                className="text-xs border border-gray-300 dark:border-gray-600 rounded px-2 py-1 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300"
                aria-label="Rows per page"
                title="Rows per page"
              >
                {[10, 25, 50, 100].map((n) => (
                  <option key={n} value={n}>{n} / page</option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {opsLoading ? (
          <div className="p-8 text-center text-gray-500">Loading events...</div>
        ) : events.length === 0 ? (
          <div className="p-8 text-center text-gray-500">No operation events found.</div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
                    <th className="text-left py-2 px-4 font-medium text-gray-500 w-[140px]">Time</th>
                    <th className="text-left py-2 px-2 font-medium text-gray-500 w-[80px]">Protocol</th>
                    <th className="text-left py-2 px-2 font-medium text-gray-500">Operation</th>
                    <th className="text-left py-2 px-2 font-medium text-gray-500">Subject</th>
                    <th className="text-left py-2 px-2 font-medium text-gray-500 w-[80px]">Actor</th>
                    <th className="text-right py-2 px-2 font-medium text-gray-500 w-[90px]">Amount</th>
                    <th className="text-center py-2 px-2 font-medium text-gray-500 w-[50px]">Status</th>
                    <th className="w-[30px]"></th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((ev) => (
                    <tr
                      key={ev.id}
                      onClick={() => router.push(`/dashboard/operations/${ev.id}`)}
                      className={`border-b border-gray-100 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-700/30 cursor-pointer border-l-2 ${correlationColor(ev.correlation_id)}`}
                    >
                      <td className="py-2 px-4 text-gray-500 text-xs font-mono whitespace-nowrap">
                        {new Date(ev.time).toLocaleString('en-US', {
                          month: 'short', day: 'numeric',
                          hour: '2-digit', minute: '2-digit', second: '2-digit',
                        })}
                      </td>
                      <td className="py-2 px-2">
                        {ev.protocol && (
                          <span className={`inline-block text-xs font-medium px-1.5 py-0.5 rounded uppercase ${PROTOCOL_TEXT_COLORS[ev.protocol] || 'text-gray-600 bg-gray-100'}`}>
                            {ev.protocol}
                          </span>
                        )}
                      </td>
                      <td className="py-2 px-2 text-gray-700 dark:text-gray-300 font-mono text-xs">
                        {ev.operation}
                      </td>
                      <td className="py-2 px-2 text-gray-500 text-xs max-w-[200px] truncate" title={ev.subject}>
                        {ev.subject}
                      </td>
                      <td className="py-2 px-2 text-gray-500 text-xs">
                        {ev.actor_type}
                      </td>
                      <td className="py-2 px-2 text-right text-gray-900 dark:text-white text-xs font-mono">
                        {ev.amount_usd ? formatCurrency(parseFloat(ev.amount_usd)) : '—'}
                      </td>
                      <td className="py-2 px-2 text-center">
                        {ev.success ? (
                          <CheckCircle2 className="h-4 w-4 text-green-500 inline" />
                        ) : (
                          <XCircle className="h-4 w-4 text-red-500 inline" />
                        )}
                      </td>
                      <td className="py-2 px-2">
                        <ChevronRight className="h-3 w-3 text-gray-400" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* Pagination */}
            {pagination && pagination.totalPages > 1 && (
              <div className="flex items-center justify-between p-4 border-t border-gray-200 dark:border-gray-700">
                <span className="text-xs text-gray-500">
                  Page {pagination.page} of {pagination.totalPages} ({pagination.total} total)
                </span>
                <div className="flex gap-2">
                  <button
                    onClick={() => setPage(Math.max(1, page - 1))}
                    disabled={page <= 1}
                    className="text-xs px-3 py-1 border rounded disabled:opacity-50 dark:border-gray-600"
                  >
                    Previous
                  </button>
                  <button
                    onClick={() => setPage(Math.min(pagination.totalPages, page + 1))}
                    disabled={page >= pagination.totalPages}
                    className="text-xs px-3 py-1 border rounded disabled:opacity-50 dark:border-gray-600"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Cost Table */}
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Cost Breakdown</h2>
        {!costs || costs.totalCostUsd === 0 ? (
          <p className="text-sm text-gray-500">No external costs recorded yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700">
                  <th className="text-left py-2 font-medium text-gray-500">Cost Key</th>
                  <th className="text-right py-2 font-medium text-gray-500">Amount (USD)</th>
                  <th className="text-right py-2 font-medium text-gray-500">% of Total</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(costs.byCostKey)
                  .sort(([, a], [, b]) => b - a)
                  .map(([key, amount]) => (
                    <tr key={key} className="border-b border-gray-100 dark:border-gray-700/50">
                      <td className="py-2 text-gray-700 dark:text-gray-300 font-mono text-xs">{key}</td>
                      <td className="py-2 text-right text-gray-900 dark:text-white">
                        {formatCurrency(amount)}
                      </td>
                      <td className="py-2 text-right text-gray-500">
                        {Math.round((amount / costs.totalCostUsd) * 100)}%
                      </td>
                    </tr>
                  ))}
              </tbody>
              <tfoot>
                <tr className="font-semibold">
                  <td className="py-2 text-gray-900 dark:text-white">Total</td>
                  <td className="py-2 text-right text-gray-900 dark:text-white">
                    {formatCurrency(costs.totalCostUsd)}
                  </td>
                  <td className="py-2 text-right text-gray-500">100%</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {/* Top Endpoints */}
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Top API Endpoints</h2>
        {!requests?.aggregations || Object.keys(requests.aggregations).length === 0 ? (
          <p className="text-sm text-gray-500">No request data yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700">
                  <th className="text-left py-2 font-medium text-gray-500">Endpoint</th>
                  <th className="text-right py-2 font-medium text-gray-500">Requests</th>
                  <th className="text-right py-2 font-medium text-gray-500">Avg Latency</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(requests.aggregations)
                  .sort(([, a], [, b]) => b.count - a.count)
                  .slice(0, 15)
                  .map(([path, { count, avgDurationMs }]) => (
                    <tr key={path} className="border-b border-gray-100 dark:border-gray-700/50">
                      <td className="py-2 text-gray-700 dark:text-gray-300 font-mono text-xs">{path}</td>
                      <td className="py-2 text-right text-gray-900 dark:text-white">
                        {count.toLocaleString()}
                      </td>
                      <td className="py-2 text-right text-gray-500">{avgDurationMs}ms</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

    </div>
  );
}

function KpiCard({
  label,
  value,
  icon,
  loading,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  loading?: boolean;
}) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm text-gray-500">{label}</span>
        {icon}
      </div>
      <div className="text-2xl font-bold text-gray-900 dark:text-white">
        {loading ? (
          <div className="h-8 w-24 bg-gray-200 dark:bg-gray-700 rounded animate-pulse" />
        ) : (
          value
        )}
      </div>
    </div>
  );
}
