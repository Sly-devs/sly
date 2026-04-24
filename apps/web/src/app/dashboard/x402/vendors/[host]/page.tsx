'use client';

/**
 * Epic 81 — Per-vendor detail + ratings.
 *
 * Shows classification histogram, volume/time stats, and a
 * ratings panel where users and agents can thumb a host. Agent
 * ratings from Tina via MCP land here alongside user ratings.
 */

import { useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useApiFetch, useApiConfig } from '@/lib/api-client';
import { toast } from 'sonner';
import { ArrowLeft, ThumbsUp, ThumbsDown, CheckCircle2, AlertTriangle, XCircle, HelpCircle, Bot, User } from 'lucide-react';

type Recommendation = 'trusted' | 'caution' | 'avoid' | 'unknown';

interface VendorRow {
  host: string;
  marketplace: string | null;
  settlementNetwork: string | null;
  totalCalls: number;
  completedCount: number;
  cancelledCount: number;
  pendingCount: number;
  successRate: number;
  avgDurationMs: number | null;
  avgResponseSize: number | null;
  classificationHistogram: Record<string, number>;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  firstSeenAt: string | null;
  totalUsdcSpent: number;
  totalUsdcAuthorizedUnredeemed: number;
  totalUsdcPaidUnreturned: number;
  totalUsdcWasted: number; // compat
  ratedCallCount: number;
  deliveredCorrectness: number | null;
  avgResultScore: number | null;
  topQualityFlags: Record<string, number>;
  recommendation: Recommendation;
  reasoning: string;
}

interface Rating {
  id: string;
  agent_id: string | null;
  host: string;
  thumb: 'up' | 'down';
  note: string | null;
  rated_by_type: string;
  rated_by_id: string | null;
  rated_by_name: string | null;
  created_at: string;
  updated_at: string;
}

function recPill(rec: Recommendation) {
  switch (rec) {
    case 'trusted':
      return <span className="inline-flex items-center gap-1 px-3 py-1 text-sm font-medium rounded-full bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-400"><CheckCircle2 className="h-4 w-4" /> Trusted</span>;
    case 'caution':
      return <span className="inline-flex items-center gap-1 px-3 py-1 text-sm font-medium rounded-full bg-amber-100 dark:bg-amber-950 text-amber-700 dark:text-amber-400"><AlertTriangle className="h-4 w-4" /> Caution</span>;
    case 'avoid':
      return <span className="inline-flex items-center gap-1 px-3 py-1 text-sm font-medium rounded-full bg-red-100 dark:bg-red-950 text-red-700 dark:text-red-400"><XCircle className="h-4 w-4" /> Avoid</span>;
    default:
      return <span className="inline-flex items-center gap-1 px-3 py-1 text-sm font-medium rounded-full bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400"><HelpCircle className="h-4 w-4" /> Unknown</span>;
  }
}

function money(n: number): string {
  if (!n) return '$0';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

function fmtAbs(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-US', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  } catch { return iso; }
}

export default function VendorDetailPage() {
  const { host: rawHost } = useParams<{ host: string }>();
  const host = decodeURIComponent(rawHost || '').toLowerCase();
  const apiFetch = useApiFetch();
  const { apiUrl, apiEnvironment, authToken } = useApiConfig();
  const queryClient = useQueryClient();
  const [noteDraft, setNoteDraft] = useState('');
  const [pendingThumb, setPendingThumb] = useState<'up' | 'down' | null>(null);

  const { data: vendorData, isLoading } = useQuery({
    queryKey: ['x402-vendor-detail', host, apiEnvironment],
    queryFn: async () => {
      const res = await apiFetch(`${apiUrl}/v1/analytics/x402-vendors/${encodeURIComponent(host)}?window=30d`);
      if (!res.ok) return { data: null };
      return res.json() as Promise<{ data: VendorRow }>;
    },
    enabled: !!authToken && !!apiUrl && !!host,
  });

  const { data: ratingsData } = useQuery({
    queryKey: ['x402-vendor-ratings', host, apiEnvironment],
    queryFn: async () => {
      const res = await apiFetch(`${apiUrl}/v1/analytics/x402-vendors/${encodeURIComponent(host)}/ratings`);
      if (!res.ok) return { data: [] as Rating[] };
      return res.json() as Promise<{ data: Rating[] }>;
    },
    enabled: !!authToken && !!apiUrl && !!host,
  });

  const ratings = ratingsData?.data || [];
  const thumbsUp = ratings.filter((r) => r.thumb === 'up').length;
  const thumbsDown = ratings.filter((r) => r.thumb === 'down').length;

  const rateMutation = useMutation({
    mutationFn: async ({ thumb, note }: { thumb: 'up' | 'down'; note?: string }) => {
      const res = await apiFetch(`${apiUrl}/v1/analytics/x402-vendors/${encodeURIComponent(host)}/rate`, {
        method: 'POST',
        body: JSON.stringify({ thumb, note: note || null }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success('Rating saved');
      setNoteDraft('');
      setPendingThumb(null);
      queryClient.invalidateQueries({ queryKey: ['x402-vendor-ratings', host] });
    },
    onError: (err: any) => toast.error(err.message || 'Failed to rate vendor'),
  });

  const v = vendorData?.data || null;

  return (
    <div className="p-8 max-w-[1400px] mx-auto">
      <Link href="/dashboard/x402/vendors" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 mb-4">
        <ArrowLeft className="h-4 w-4" /> All vendors
      </Link>

      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4 mb-6">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-1 break-all">{host}</h1>
          <div className="flex items-center gap-3 text-sm text-gray-500 dark:text-gray-400">
            {v?.marketplace && <span>marketplace: {v.marketplace}</span>}
            {v?.settlementNetwork && <span>network: {v.settlementNetwork}</span>}
            <a href={`https://${host}`} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">open ↗</a>
          </div>
        </div>
        {v && recPill(v.recommendation)}
      </div>

      {isLoading || !v ? (
        <div className="h-40 bg-gray-100 dark:bg-gray-900 rounded-2xl animate-pulse" />
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
            <Stat label="Calls" value={String(v.totalCalls)} sub={`${v.completedCount}✓ ${v.cancelledCount}✗${v.pendingCount > 0 ? ` ${v.pendingCount}○` : ''}`} />
            <Stat label="Success rate" value={`${(v.successRate * 100).toFixed(0)}%`} tone={v.successRate >= 0.9 ? 'emerald' : v.successRate >= 0.4 ? 'amber' : 'red'} />
            <Stat
              label="USDC spent"
              value={money(v.totalUsdcSpent)}
              sub={
                v.totalUsdcPaidUnreturned > 0
                  ? `${money(v.totalUsdcPaidUnreturned)} lost (paid, no return)`
                  : v.totalUsdcAuthorizedUnredeemed > 0
                    ? `${money(v.totalUsdcAuthorizedUnredeemed)} signed but never redeemed`
                    : undefined
              }
            />
            <Stat label="Avg response" value={v.avgDurationMs ? `${Math.round(v.avgDurationMs)}ms` : '—'} sub={v.avgResponseSize ? `${Math.round(v.avgResponseSize)} bytes` : undefined} />
          </div>

          {/* Quality row — fed by x402_call_quality (per-transfer ratings).
              Appears only when someone's rated something; an "unrated"
              vendor renders the empty state so the UI doesn't pretend. */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
            <Stat
              label="Delivered what asked"
              value={v.deliveredCorrectness != null ? `${(v.deliveredCorrectness * 100).toFixed(0)}%` : '—'}
              sub={v.ratedCallCount > 0 ? `${v.ratedCallCount} rated call${v.ratedCallCount === 1 ? '' : 's'}` : 'no ratings yet'}
              tone={
                v.deliveredCorrectness == null
                  ? undefined
                  : v.deliveredCorrectness >= 0.9
                    ? 'emerald'
                    : v.deliveredCorrectness >= 0.6
                      ? 'amber'
                      : 'red'
              }
            />
            <Stat
              label="Avg quality score"
              value={v.avgResultScore != null ? `${v.avgResultScore.toFixed(0)}/100` : '—'}
              sub={v.ratedCallCount > 0 ? `${v.ratedCallCount} rated call${v.ratedCallCount === 1 ? '' : 's'}` : 'no ratings yet'}
              tone={
                v.avgResultScore == null
                  ? undefined
                  : v.avgResultScore >= 80
                    ? 'emerald'
                    : v.avgResultScore >= 50
                      ? 'amber'
                      : 'red'
              }
            />
            <Stat
              label="Rated call coverage"
              value={`${v.ratedCallCount}/${v.totalCalls}`}
              sub={v.totalCalls > 0 && v.ratedCallCount > 0 ? `${((v.ratedCallCount / v.totalCalls) * 100).toFixed(0)}% rated` : 'rate more calls for signal'}
            />
          </div>

          {/* Deceptive reliability banner — the reason this quality layer
              exists. When HTTP success looks great but callers say the data
              is wrong, warn explicitly. Threshold: HTTP ≥90%, correctness <70%,
              at least 3 ratings (mirrors MIN_RATED_FOR_QUALITY_GATE in reputation.ts). */}
          {v.deliveredCorrectness != null && v.ratedCallCount >= 3 && v.successRate >= 0.9 && v.deliveredCorrectness < 0.7 && (
            <div className="bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-800 rounded-2xl p-4 mb-6 flex gap-3">
              <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-amber-900 dark:text-amber-200 mb-1">
                  Deceptive reliability
                </div>
                <p className="text-sm text-amber-800 dark:text-amber-300">
                  HTTP says this vendor is healthy ({(v.successRate * 100).toFixed(0)}% success), but {((1 - v.deliveredCorrectness) * 100).toFixed(0)}% of rated calls didn't deliver what was asked.
                  The responses look valid on the wire but contain the wrong data. Treat as <strong>caution</strong> regardless of the HTTP number.
                </p>
              </div>
            </div>
          )}

          {/* Reasoning */}
          <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6 mb-6">
            <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">Why this recommendation</div>
            <p className="text-sm text-gray-900 dark:text-white">{v.reasoning}</p>
            <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
              <span>First seen: {fmtAbs(v.firstSeenAt)}</span>
              <span>Last success: {fmtAbs(v.lastSuccessAt)}</span>
              <span>Last failure: {fmtAbs(v.lastFailureAt)}</span>
            </div>
          </div>

          {/* Classification histogram */}
          {Object.keys(v.classificationHistogram).length > 0 && (
            <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6 mb-6">
              <div className="text-sm font-semibold text-gray-900 dark:text-white mb-3">Failure breakdown</div>
              <div className="space-y-2">
                {Object.entries(v.classificationHistogram)
                  .sort(([, a], [, b]) => b - a)
                  .map(([code, count]) => {
                    const max = Math.max(...Object.values(v.classificationHistogram));
                    const pct = (count / max) * 100;
                    return (
                      <div key={code}>
                        <div className="flex items-center justify-between text-xs mb-1">
                          <code className="text-gray-700 dark:text-gray-300">{code}</code>
                          <span className="text-gray-500">{count}</span>
                        </div>
                        <div className="h-1.5 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
                          <div className="h-full bg-red-400 rounded-full" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    );
                  })}
              </div>
            </div>
          )}

          {/* Top quality flags — most-common failure-mode tags raters added
              (stale_data, hallucinated, schema_mismatch, etc). Complements
              the classification histogram, which is wire-level; these are
              semantic. */}
          {Object.keys(v.topQualityFlags || {}).length > 0 && (
            <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6 mb-6">
              <div className="text-sm font-semibold text-gray-900 dark:text-white mb-3">Top quality flags</div>
              <div className="space-y-2">
                {Object.entries(v.topQualityFlags)
                  .sort(([, a], [, b]) => b - a)
                  .map(([flag, count]) => {
                    const max = Math.max(...Object.values(v.topQualityFlags));
                    const pct = (count / max) * 100;
                    return (
                      <div key={flag}>
                        <div className="flex items-center justify-between text-xs mb-1">
                          <code className="text-gray-700 dark:text-gray-300">{flag}</code>
                          <span className="text-gray-500">{count}</span>
                        </div>
                        <div className="h-1.5 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
                          <div className="h-full bg-amber-400 rounded-full" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    );
                  })}
              </div>
            </div>
          )}
        </>
      )}

      {/* Rate it */}
      <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6 mb-6">
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="text-sm font-semibold text-gray-900 dark:text-white">Rate this vendor</div>
            <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              Your qualitative signal beyond raw success rate. Agents can rate via the <code>x402_rate_vendor</code> MCP tool.
            </div>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
              <ThumbsUp className="h-3.5 w-3.5" /> {thumbsUp}
            </span>
            <span className="flex items-center gap-1 text-red-600 dark:text-red-400">
              <ThumbsDown className="h-3.5 w-3.5" /> {thumbsDown}
            </span>
          </div>
        </div>

        <div className="flex gap-2 mb-3">
          <button
            onClick={() => setPendingThumb(pendingThumb === 'up' ? null : 'up')}
            className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border transition-colors ${pendingThumb === 'up' ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-300 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400' : 'bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-800 text-gray-700 dark:text-gray-300 hover:border-emerald-300'}`}
          >
            <ThumbsUp className="h-4 w-4" /> Thumbs up
          </button>
          <button
            onClick={() => setPendingThumb(pendingThumb === 'down' ? null : 'down')}
            className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border transition-colors ${pendingThumb === 'down' ? 'bg-red-50 dark:bg-red-950/40 border-red-300 dark:border-red-800 text-red-700 dark:text-red-400' : 'bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-800 text-gray-700 dark:text-gray-300 hover:border-red-300'}`}
          >
            <ThumbsDown className="h-4 w-4" /> Thumbs down
          </button>
        </div>

        {pendingThumb && (
          <>
            <textarea
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              placeholder="Optional note — what went well / wrong?"
              maxLength={1000}
              rows={2}
              className="w-full px-3 py-2 text-sm bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <div className="mt-2 flex items-center justify-between">
              <div className="text-xs text-gray-400">{noteDraft.length}/1000</div>
              <button
                onClick={() => rateMutation.mutate({ thumb: pendingThumb, note: noteDraft })}
                disabled={rateMutation.isPending}
                className="px-4 py-1.5 text-sm font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
              >
                {rateMutation.isPending ? 'Saving…' : 'Save rating'}
              </button>
            </div>
          </>
        )}
      </div>

      {/* Existing ratings */}
      <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-800">
          <div className="text-sm font-semibold text-gray-900 dark:text-white">Ratings ({ratings.length})</div>
        </div>
        {ratings.length === 0 ? (
          <div className="p-6 text-sm text-gray-500">No ratings yet. Leave the first one above, or ask an agent to rate via <code>x402_rate_vendor</code>.</div>
        ) : (
          <ul className="divide-y divide-gray-100 dark:divide-gray-900">
            {ratings.map((r) => (
              <li key={r.id} className="px-6 py-4 flex items-start gap-3">
                <div className={`flex-shrink-0 h-8 w-8 rounded-full flex items-center justify-center ${r.thumb === 'up' ? 'bg-emerald-100 dark:bg-emerald-950 text-emerald-600 dark:text-emerald-400' : 'bg-red-100 dark:bg-red-950 text-red-600 dark:text-red-400'}`}>
                  {r.thumb === 'up' ? <ThumbsUp className="h-4 w-4" /> : <ThumbsDown className="h-4 w-4" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    {r.rated_by_type === 'agent'
                      ? <Bot className="h-3.5 w-3.5 text-violet-500" />
                      : <User className="h-3.5 w-3.5 text-gray-400" />
                    }
                    <span className="text-sm font-medium text-gray-900 dark:text-white">{r.rated_by_name || r.rated_by_type}</span>
                    <span className="text-xs text-gray-400">· {fmtAbs(r.updated_at)}</span>
                  </div>
                  {r.note ? (
                    <p className="text-sm text-gray-700 dark:text-gray-300">{r.note}</p>
                  ) : (
                    <p className="text-xs text-gray-400 italic">no note</p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'emerald' | 'amber' | 'red' }) {
  const toneClasses = {
    emerald: 'text-emerald-600 dark:text-emerald-400',
    amber: 'text-amber-600 dark:text-amber-400',
    red: 'text-red-600 dark:text-red-400',
  } as const;
  return (
    <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-4">
      <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">{label}</div>
      <div className={`text-xl font-bold ${tone ? toneClasses[tone] : 'text-gray-900 dark:text-white'}`}>{value}</div>
      {sub && <div className="text-xs text-gray-500 mt-0.5">{sub}</div>}
    </div>
  );
}
