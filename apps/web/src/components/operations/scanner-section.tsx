'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import {
  Bar,
  BarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { AlertCircle, Coins, ExternalLink, Mail, Radar, TrendingUp } from 'lucide-react';
import { useScannerApi } from '@/lib/scanner-api';

/**
 * Scanner usage + ledger, rendered as a stacked section below the main API
 * operations on /dashboard/operations. Hits sly-scanner.vercel.app directly
 * using the logged-in user's Supabase JWT.
 */
export function ScannerSection() {
  const scanner = useScannerApi();

  const balanceQuery = useQuery({
    queryKey: ['scanner', 'balance'],
    queryFn: async () => {
      const res = await scanner.get('/v1/scanner/credits/balance');
      if (!res.ok) throw new Error('balance-fetch-failed');
      return (await res.json()) as {
        balance: number;
        grantedTotal: number;
        consumedTotal: number;
      };
    },
    staleTime: 30_000,
  });

  // Last 30 days of day-buckets. Bucket the cutoff at day-precision so the
  // queryKey stays stable across renders within the same day — previously it
  // used Date.now() at full ms precision, which gave a fresh key every render
  // and kept the chart stuck in the loading state.
  const fromDay = useMemo(
    () => new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    [],
  );
  const fromIso = `${fromDay}T00:00:00Z`;
  const usageByDayQuery = useQuery({
    queryKey: ['scanner', 'usage', 'day', fromDay],
    queryFn: async () => {
      const res = await scanner.get(
        `/v1/scanner/usage?group_by=day&from=${encodeURIComponent(fromIso)}`,
      );
      if (!res.ok) throw new Error('usage-day-failed');
      const json = (await res.json()) as {
        data: Array<{
          day: string;
          requests: number;
          credits: number;
          errors: number;
          total_duration_ms: number;
        }>;
      };
      return json.data ?? [];
    },
    staleTime: 60_000,
  });

  const usageByEndpointQuery = useQuery({
    queryKey: ['scanner', 'usage', 'endpoint'],
    queryFn: async () => {
      const res = await scanner.get('/v1/scanner/usage?group_by=endpoint');
      if (!res.ok) throw new Error('usage-endpoint-failed');
      const json = (await res.json()) as {
        data: Array<{
          endpoint: string;
          requests: number;
          credits: number;
          errors: number;
          total_duration_ms: number;
        }>;
      };
      return json.data ?? [];
    },
    staleTime: 60_000,
  });

  // Ground-truth scan counts come from the credit LEDGER, not the
  // usage-events buffer. The ledger is written synchronously inside the
  // credits middleware so it never drops a billed event; usage_events
  // can lose rows under concurrent flush race conditions across Vercel
  // function instances. We use this for the "Scans (30d)" KPI and the
  // chart's billable bar.
  const activityQuery = useQuery({
    queryKey: ['scanner', 'activity', 'day', fromDay],
    queryFn: async () => {
      const res = await scanner.get(
        `/v1/scanner/credits/activity?from=${encodeURIComponent(fromIso)}`,
      );
      if (!res.ok) throw new Error('activity-failed');
      const json = (await res.json()) as {
        data: Array<{ day: string; scans: number; credits: number }>;
      };
      return json.data ?? [];
    },
    staleTime: 30_000,
  });

  const ledgerQuery = useQuery({
    queryKey: ['scanner', 'ledger', 'expand-scan'],
    queryFn: async () => {
      const res = await scanner.get('/v1/scanner/credits/ledger?limit=20&expand=scan');
      if (!res.ok) throw new Error('ledger-failed');
      const json = (await res.json()) as {
        data: Array<{
          id: string;
          delta: number;
          reason: string;
          source: string | null;
          balance_after: number;
          metadata: Record<string, unknown>;
          created_at: string;
          scan?: {
            id: string;
            domain: string;
            readiness_score: number | null;
            scan_status: string;
          };
        }>;
      };
      return json.data ?? [];
    },
    staleTime: 30_000,
  });

  const balance = balanceQuery.data?.balance ?? 0;
  const needsTopup = balanceQuery.isSuccess && balance < 500;

  // "Scans (30d)" comes from the ledger (ground truth) — counts billed
  // consume rows, not the usage-events derived value which can undercount.
  const monthScans =
    activityQuery.data
      ?.filter((d) => d.day >= fromDay)
      .reduce((sum, d) => sum + d.scans, 0) ?? 0;

  // Chart joins ledger truth (scans) with usage-events (reads + errors) per
  // day. Sparse view — only days with any activity. The merge is on `day`
  // string; days that exist in only one source are still included.
  const chartData = (() => {
    const byDay: Record<string, { day: string; scans: number; reads: number; errors: number }> = {};
    for (const d of activityQuery.data ?? []) {
      byDay[d.day] = { day: d.day, scans: d.scans, reads: 0, errors: 0 };
    }
    for (const d of usageByDayQuery.data ?? []) {
      const row = byDay[d.day] ?? { day: d.day, scans: 0, reads: 0, errors: 0 };
      // d.requests is the total of all request types in usage_events; subtract
      // credits to get reads. We deliberately don't trust usage_events for
      // scan counts, so we don't update row.scans here.
      row.reads = Math.max(0, d.requests - d.credits);
      row.errors = d.errors;
      byDay[d.day] = row;
    }
    return Object.values(byDay)
      .filter((d) => d.scans > 0 || d.reads > 0 || d.errors > 0)
      .sort((a, b) => a.day.localeCompare(b.day));
  })();

  return (
    <div id="scanner" className="space-y-6 pt-8 mt-8 border-t border-gray-200 dark:border-gray-700">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white flex items-center gap-2">
            <Radar className="h-5 w-5" />
            Scanner
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Agentic-commerce scanner — credit-based, tracked separately from the main API.{' '}
            <Link href="/dashboard/api-keys#scanner" className="underline hover:text-gray-900 dark:hover:text-white">
              Manage scanner keys →
            </Link>
          </p>
        </div>
      </div>

      {/* Balance row */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <Kpi
          label="Balance"
          value={balanceQuery.isLoading ? '—' : balance.toLocaleString()}
          icon={<Coins className="h-4 w-4 text-amber-500" />}
          accent={needsTopup ? 'warn' : 'ok'}
        />
        <Kpi
          label="Granted (lifetime)"
          value={(balanceQuery.data?.grantedTotal ?? 0).toLocaleString()}
          icon={<TrendingUp className="h-4 w-4 text-emerald-500" />}
        />
        <Kpi
          label="Consumed (lifetime)"
          value={(balanceQuery.data?.consumedTotal ?? 0).toLocaleString()}
          icon={<AlertCircle className="h-4 w-4 text-rose-500" />}
        />
        <Kpi
          label="Scans (30d)"
          value={activityQuery.isLoading ? '—' : monthScans.toLocaleString()}
          icon={<Radar className="h-4 w-4 text-indigo-500" />}
        />
      </div>

      {/* Pricing reference */}
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-base font-semibold text-gray-900 dark:text-white">How credits are charged</h3>
          <a
            href="https://docs.getsly.ai/scanner/credits-and-billing"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline inline-flex items-center gap-1"
          >
            View pricing docs <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
        <ul className="text-sm space-y-1.5 text-gray-700 dark:text-gray-300">
          <li>
            <code className="text-xs bg-gray-100 dark:bg-gray-900 px-1.5 py-0.5 rounded">POST /v1/scanner/scan</code> — <strong>1 credit</strong> per domain
          </li>
          <li>
            <code className="text-xs bg-gray-100 dark:bg-gray-900 px-1.5 py-0.5 rounded">POST /v1/scanner/scan/batch</code> — <strong>0.5 credit</strong> per domain in the batch
          </li>
          <li>
            <code className="text-xs bg-gray-100 dark:bg-gray-900 px-1.5 py-0.5 rounded">POST /v1/scanner/tests</code> — <strong>5 credits</strong> per agent test run
          </li>
          <li>
            All <code className="text-xs bg-gray-100 dark:bg-gray-900 px-1.5 py-0.5 rounded">GET</code> reads (balance, usage, ledger, scan results, keys) — <strong>free</strong>
          </li>
        </ul>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-3">
          Validation errors and server errors are auto-refunded. Successful responses include
          <code className="mx-1 text-xs bg-gray-100 dark:bg-gray-900 px-1 py-0.5 rounded">X-Credits-Remaining</code>
          in the headers.
        </p>
      </div>

      {needsTopup && (
        <div className="bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 rounded-lg p-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
            <div className="flex-1 space-y-2">
              <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
                Scanner balance is low — {balance} credits remaining
              </p>
              <p className="text-xs text-amber-800 dark:text-amber-300">
                Contact us to top up. Credit packs start at 5,000 for $200.
              </p>
              <a
                href="mailto:partners@getsly.ai?subject=Scanner%20credits%20top-up"
                className="inline-flex items-center gap-1.5 text-sm font-medium text-amber-900 dark:text-amber-100 hover:underline"
              >
                <Mail className="h-3.5 w-3.5" />
                partners@getsly.ai
              </a>
            </div>
          </div>
        </div>
      )}

      {/* Usage chart */}
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Activity per day (last 30d)</h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              Billable scans (indigo), free reads — balance/usage/ledger polling (gray), errors (red).
            </p>
          </div>
        </div>
        {usageByDayQuery.isLoading || activityQuery.isLoading ? (
          <div className="h-56 flex items-center justify-center text-sm text-gray-500">Loading…</div>
        ) : chartData.length === 0 ? (
          <div className="h-56 flex items-center justify-center text-sm text-gray-500">
            No scanner activity yet. Create a scanner key in{' '}
            <Link href="/dashboard/api-keys#scanner" className="underline ml-1">API Keys</Link>
            {' '}and make your first call.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={chartData}>
              <XAxis dataKey="day" tick={{ fontSize: 11 }} tickFormatter={(v) => v.slice(5)} />
              <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
              <Tooltip
                cursor={{ fill: 'rgba(99,102,241,0.1)' }}
                contentStyle={{ fontSize: 12 }}
                formatter={(v: number, name: string) => [v.toLocaleString(), name]}
              />
              <Bar dataKey="scans" name="Scans (billable)" stackId="activity" fill="#6366f1" radius={[0, 0, 0, 0]} />
              <Bar dataKey="reads" name="Reads (free)" stackId="activity" fill="#cbd5e1" radius={[3, 3, 0, 0]} />
              <Bar dataKey="errors" name="Errors" fill="#ef4444" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Top endpoints */}
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Top scanner endpoints</h3>
        {!usageByEndpointQuery.data || usageByEndpointQuery.data.length === 0 ? (
          <p className="text-sm text-gray-500">No scanner activity yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700">
                  <th className="text-left py-2 font-medium text-gray-500">Endpoint</th>
                  <th className="text-right py-2 font-medium text-gray-500">Requests</th>
                  <th className="text-right py-2 font-medium text-gray-500">Credits</th>
                  <th className="text-right py-2 font-medium text-gray-500">Errors</th>
                  <th className="text-right py-2 font-medium text-gray-500">Avg latency</th>
                </tr>
              </thead>
              <tbody>
                {usageByEndpointQuery.data
                  .sort((a, b) => b.requests - a.requests)
                  .slice(0, 15)
                  .map((e) => (
                    <tr key={e.endpoint} className="border-b border-gray-100 dark:border-gray-700/50">
                      <td className="py-2 text-gray-700 dark:text-gray-300 font-mono text-xs">{e.endpoint}</td>
                      <td className="py-2 text-right text-gray-900 dark:text-white">{e.requests.toLocaleString()}</td>
                      <td className="py-2 text-right text-gray-900 dark:text-white">{e.credits.toLocaleString()}</td>
                      <td className="py-2 text-right text-gray-500">{e.errors.toLocaleString()}</td>
                      <td className="py-2 text-right text-gray-500">
                        {e.requests > 0 ? Math.round(e.total_duration_ms / e.requests) : 0}ms
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Recent ledger */}
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Recent ledger activity</h3>
        {!ledgerQuery.data || ledgerQuery.data.length === 0 ? (
          <p className="text-sm text-gray-500">No ledger entries yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700">
                  <th className="text-left py-2 font-medium text-gray-500">When</th>
                  <th className="text-left py-2 font-medium text-gray-500">Reason</th>
                  <th className="text-right py-2 font-medium text-gray-500">Δ</th>
                  <th className="text-right py-2 font-medium text-gray-500">Balance after</th>
                  <th className="text-left py-2 font-medium text-gray-500">Scan / Source</th>
                </tr>
              </thead>
              <tbody>
                {ledgerQuery.data.map((row) => (
                  <tr key={row.id} className="border-b border-gray-100 dark:border-gray-700/50">
                    <td className="py-2 text-gray-500 text-xs whitespace-nowrap">
                      {new Date(row.created_at).toLocaleString()}
                    </td>
                    <td className="py-2">
                      <span
                        className={
                          'inline-block text-[10px] px-1.5 py-0.5 rounded font-medium ' +
                          (row.reason === 'consume'
                            ? 'bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300'
                            : row.reason === 'grant'
                              ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                              : row.reason === 'refund'
                                ? 'bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300'
                                : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300')
                        }
                      >
                        {row.reason}
                      </span>
                    </td>
                    <td
                      className={
                        'py-2 text-right font-mono ' +
                        (row.delta < 0 ? 'text-rose-600' : 'text-emerald-600')
                      }
                    >
                      {row.delta > 0 ? '+' : ''}
                      {row.delta}
                    </td>
                    <td className="py-2 text-right text-gray-900 dark:text-white">{row.balance_after}</td>
                    <td className="py-2 text-gray-500 font-mono text-xs">
                      {row.scan ? (
                        <button
                          type="button"
                          onClick={() => navigator.clipboard?.writeText(row.scan!.id)}
                          className="inline-flex items-center gap-1 text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer"
                          title={`Click to copy scan id: ${row.scan.id}\nFetch the full payload with: GET /v1/scanner/scan/${row.scan.id}`}
                        >
                          <span className="font-mono">{row.scan.domain}</span>
                          {row.scan.readiness_score != null && (
                            <span className="text-[10px] text-gray-400">· score {row.scan.readiness_score}</span>
                          )}
                        </button>
                      ) : (
                        <span className="truncate max-w-xs inline-block">{row.source ?? '—'}</span>
                      )}
                    </td>
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

function Kpi({
  label,
  value,
  icon,
  accent,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  accent?: 'ok' | 'warn';
}) {
  return (
    <div
      className={
        'rounded-lg border p-4 ' +
        (accent === 'warn'
          ? 'border-amber-300 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800'
          : 'border-gray-200 bg-white dark:bg-gray-800 dark:border-gray-700')
      }
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm text-gray-500">{label}</span>
        {icon}
      </div>
      <div className="text-2xl font-bold text-gray-900 dark:text-white">{value}</div>
    </div>
  );
}
