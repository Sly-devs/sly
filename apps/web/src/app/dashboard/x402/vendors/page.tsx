'use client';

/**
 * Epic 81 — Vendor Reliability Observatory
 *
 * Per-host reliability summary for every x402 vendor the tenant's
 * agents have tried. Drill-down to /dashboard/x402/vendors/[host] for
 * classification breakdown + per-agent ratings.
 */

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { useApiFetch, useApiConfig } from '@/lib/api-client';
import { CheckCircle2, AlertTriangle, XCircle, HelpCircle, ExternalLink } from 'lucide-react';

type Recommendation = 'trusted' | 'caution' | 'avoid' | 'unknown';

interface VendorRow {
  host: string;
  marketplace: string | null;
  totalCalls: number;
  completedCount: number;
  cancelledCount: number;
  pendingCount: number;
  successRate: number;
  avgDurationMs: number | null;
  classificationHistogram: Record<string, number>;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  firstSeenAt: string | null;
  totalUsdcSpent: number;
  totalUsdcWasted: number;
  recommendation: Recommendation;
  reasoning: string;
}

type SortKey = 'volume' | 'success' | 'spent' | 'wasted' | 'recent';

function recBadge(rec: Recommendation) {
  switch (rec) {
    case 'trusted':
      return <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-400"><CheckCircle2 className="h-3 w-3" /> trusted</span>;
    case 'caution':
      return <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full bg-amber-100 dark:bg-amber-950 text-amber-700 dark:text-amber-400"><AlertTriangle className="h-3 w-3" /> caution</span>;
    case 'avoid':
      return <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full bg-red-100 dark:bg-red-950 text-red-700 dark:text-red-400"><XCircle className="h-3 w-3" /> avoid</span>;
    default:
      return <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400"><HelpCircle className="h-3 w-3" /> unknown</span>;
  }
}

function money(n: number): string {
  if (!n) return '$0';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

function relTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso).getTime();
  const mins = Math.max(0, Math.round((Date.now() - d) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export default function X402VendorsPage() {
  const apiFetch = useApiFetch();
  const { apiUrl, apiEnvironment, authToken } = useApiConfig();
  const [windowParam, setWindowParam] = useState<'24h' | '7d' | '30d'>('30d');
  const [sortBy, setSortBy] = useState<SortKey>('volume');
  const [filter, setFilter] = useState<'all' | Recommendation>('all');

  const { data, isLoading } = useQuery({
    queryKey: ['x402-vendors', windowParam, apiEnvironment],
    queryFn: async () => {
      const res = await apiFetch(`${apiUrl}/v1/analytics/x402-vendors?window=${windowParam}`);
      if (!res.ok) return { data: [] as VendorRow[] };
      return res.json() as Promise<{ data: VendorRow[] }>;
    },
    enabled: !!authToken && !!apiUrl,
    refetchInterval: 60_000,
  });

  const rows = data?.data || [];

  const stats = useMemo(() => {
    const trusted = rows.filter((r) => r.recommendation === 'trusted').length;
    const caution = rows.filter((r) => r.recommendation === 'caution').length;
    const avoid = rows.filter((r) => r.recommendation === 'avoid').length;
    const unknown = rows.filter((r) => r.recommendation === 'unknown').length;
    const spent = rows.reduce((a, r) => a + r.totalUsdcSpent, 0);
    const wasted = rows.reduce((a, r) => a + r.totalUsdcWasted, 0);
    return { trusted, caution, avoid, unknown, spent, wasted, total: rows.length };
  }, [rows]);

  const filteredSorted = useMemo(() => {
    let out = rows;
    if (filter !== 'all') out = out.filter((r) => r.recommendation === filter);
    const sorted = [...out].sort((a, b) => {
      if (sortBy === 'volume') return b.totalCalls - a.totalCalls;
      if (sortBy === 'success') return b.successRate - a.successRate;
      if (sortBy === 'spent') return b.totalUsdcSpent - a.totalUsdcSpent;
      if (sortBy === 'wasted') return b.totalUsdcWasted - a.totalUsdcWasted;
      if (sortBy === 'recent') {
        const aT = Math.max(
          a.lastSuccessAt ? new Date(a.lastSuccessAt).getTime() : 0,
          a.lastFailureAt ? new Date(a.lastFailureAt).getTime() : 0,
        );
        const bT = Math.max(
          b.lastSuccessAt ? new Date(b.lastSuccessAt).getTime() : 0,
          b.lastFailureAt ? new Date(b.lastFailureAt).getTime() : 0,
        );
        return bT - aT;
      }
      return 0;
    });
    return sorted;
  }, [rows, filter, sortBy]);

  return (
    <div className="p-8 max-w-[1600px] mx-auto">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-1">x402 Vendor Reliability</h1>
        <p className="text-gray-600 dark:text-gray-400">
          Rolling reputation for every vendor your agents have paid.
          Derived from response outcomes + failure classifications collected on each call.
        </p>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
        <KpiCard label="Vendors tried" value={String(stats.total)} />
        <KpiCard label="Trusted" value={String(stats.trusted)} tone="emerald" />
        <KpiCard label="Caution" value={String(stats.caution)} tone="amber" />
        <KpiCard label="Avoid" value={String(stats.avoid)} tone="red" />
        <KpiCard label="USDC wasted" value={money(stats.wasted)} tone="red" subtitle={`${money(stats.spent)} paid successfully`} />
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="flex items-center gap-1 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-1">
          {(['24h', '7d', '30d'] as const).map((w) => (
            <button
              key={w}
              onClick={() => setWindowParam(w)}
              className={`px-3 py-1 text-xs rounded-md ${windowParam === w ? 'bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300 font-medium' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'}`}
            >
              {w}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-1">
          {(['all', 'trusted', 'caution', 'avoid', 'unknown'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1 text-xs rounded-md capitalize ${filter === f ? 'bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300 font-medium' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'}`}
            >
              {f}
            </button>
          ))}
        </div>

        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as SortKey)}
          className="px-3 py-1.5 text-xs bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="volume">Sort: Call volume</option>
          <option value="success">Sort: Success rate</option>
          <option value="spent">Sort: USDC spent</option>
          <option value="wasted">Sort: USDC wasted</option>
          <option value="recent">Sort: Most recent</option>
        </select>
      </div>

      {/* Table */}
      <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-gray-900 text-xs uppercase tracking-wider text-gray-500">
            <tr>
              <th className="px-6 py-3 text-left">Vendor</th>
              <th className="px-6 py-3 text-left">Recommendation</th>
              <th className="px-6 py-3 text-right">Calls</th>
              <th className="px-6 py-3 text-right">Success</th>
              <th className="px-6 py-3 text-right">Avg time</th>
              <th className="px-6 py-3 text-right">USDC spent</th>
              <th className="px-6 py-3 text-right">USDC wasted</th>
              <th className="px-6 py-3 text-right">Last activity</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-900">
            {isLoading ? (
              <tr><td colSpan={8} className="px-6 py-10 text-center text-gray-500">Loading…</td></tr>
            ) : filteredSorted.length === 0 ? (
              <tr><td colSpan={8} className="px-6 py-10 text-center text-gray-500">No vendors match the filter.</td></tr>
            ) : filteredSorted.map((r) => {
              const lastIso = [r.lastSuccessAt, r.lastFailureAt].filter(Boolean).sort().reverse()[0] || null;
              return (
                <tr key={r.host} className="hover:bg-gray-50 dark:hover:bg-gray-900/50">
                  <td className="px-6 py-3">
                    <Link href={`/dashboard/x402/vendors/${encodeURIComponent(r.host)}`} className="font-medium text-gray-900 dark:text-white hover:text-blue-600 dark:hover:text-blue-400">
                      {r.host}
                    </Link>
                    {r.marketplace && <div className="text-xs text-gray-500">{r.marketplace}</div>}
                  </td>
                  <td className="px-6 py-3">
                    {recBadge(r.recommendation)}
                    <div className="text-xs text-gray-500 mt-0.5 max-w-[280px] truncate" title={r.reasoning}>{r.reasoning}</div>
                  </td>
                  <td className="px-6 py-3 text-right tabular-nums text-gray-900 dark:text-white">
                    {r.totalCalls}
                    <div className="text-xs text-gray-400">{r.completedCount}✓ {r.cancelledCount}✗{r.pendingCount > 0 ? ` ${r.pendingCount}○` : ''}</div>
                  </td>
                  <td className="px-6 py-3 text-right tabular-nums">
                    <span className={r.successRate >= 0.9 ? 'text-emerald-600 dark:text-emerald-400' : r.successRate >= 0.4 ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400'}>
                      {(r.successRate * 100).toFixed(0)}%
                    </span>
                  </td>
                  <td className="px-6 py-3 text-right tabular-nums text-gray-600 dark:text-gray-400">{r.avgDurationMs ? `${Math.round(r.avgDurationMs)}ms` : '—'}</td>
                  <td className="px-6 py-3 text-right tabular-nums text-gray-900 dark:text-white">{money(r.totalUsdcSpent)}</td>
                  <td className="px-6 py-3 text-right tabular-nums">
                    <span className={r.totalUsdcWasted > 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-400'}>
                      {money(r.totalUsdcWasted)}
                    </span>
                  </td>
                  <td className="px-6 py-3 text-right text-xs text-gray-500">{relTime(lastIso)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function KpiCard({ label, value, subtitle, tone }: { label: string; value: string; subtitle?: string; tone?: 'emerald' | 'amber' | 'red' }) {
  const toneClasses = {
    emerald: 'text-emerald-600 dark:text-emerald-400',
    amber: 'text-amber-600 dark:text-amber-400',
    red: 'text-red-600 dark:text-red-400',
  } as const;
  return (
    <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-5">
      <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1">{label}</div>
      <div className={`text-2xl font-bold ${tone ? toneClasses[tone] : 'text-gray-900 dark:text-white'}`}>{value}</div>
      {subtitle && <div className="text-xs text-gray-500 mt-1">{subtitle}</div>}
    </div>
  );
}
