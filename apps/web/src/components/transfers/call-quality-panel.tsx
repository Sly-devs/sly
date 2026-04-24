'use client';

/**
 * Epic 81 (extension) — Per-call result quality panel.
 *
 * Lets a user rate ONE specific x402 transfer: did the vendor actually
 * deliver what was asked? Mirrors the A2A rating UX but one-sided.
 * Submissions feed x402_call_quality and roll up into the vendor
 * leaderboard's correctness column.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApiFetch, useApiConfig } from '@/lib/api-client';
import { toast } from 'sonner';
import { Bot, User, ThumbsUp, ThumbsDown, CheckCircle2 } from 'lucide-react';

type Satisfaction = 'excellent' | 'acceptable' | 'partial' | 'unacceptable';

interface CallQualityRow {
  id: string;
  transfer_id: string;
  host: string;
  delivered_what_asked: boolean;
  satisfaction: Satisfaction;
  score: number;
  flags: string[] | null;
  note: string | null;
  rated_by_type: string;
  rated_by_name: string | null;
  created_at: string;
}

const COMMON_FLAGS = [
  'stale_data',
  'partial_response',
  'hallucinated',
  'rate_limited',
  'schema_mismatch',
  'empty_payload',
  'wrong_entity',
] as const;

const SATISFACTION_OPTIONS: { value: Satisfaction; label: string; defaultScore: number }[] = [
  { value: 'excellent', label: 'Excellent', defaultScore: 95 },
  { value: 'acceptable', label: 'Acceptable', defaultScore: 75 },
  { value: 'partial', label: 'Partial', defaultScore: 45 },
  { value: 'unacceptable', label: 'Unacceptable', defaultScore: 15 },
];

interface CallQualityPanelProps {
  transferId: string;
  intent?: {
    reason?: string | null;
    expected_fields?: string[] | null;
  } | null;
}

export function CallQualityPanel({ transferId, intent }: CallQualityPanelProps) {
  const apiFetch = useApiFetch();
  const { apiUrl } = useApiConfig();
  const queryClient = useQueryClient();

  const [deliveredWhatAsked, setDeliveredWhatAsked] = useState<boolean | null>(null);
  const [satisfaction, setSatisfaction] = useState<Satisfaction | null>(null);
  const [score, setScore] = useState<number>(75);
  const [flags, setFlags] = useState<string[]>([]);
  const [note, setNote] = useState<string>('');

  const { data: ratingsData } = useQuery({
    queryKey: ['transfer-ratings', transferId],
    queryFn: async () => {
      const res = await apiFetch(`${apiUrl}/v1/transfers/${encodeURIComponent(transferId)}/ratings`);
      if (!res.ok) return { data: [] as CallQualityRow[] };
      return res.json() as Promise<{ data: CallQualityRow[] }>;
    },
    enabled: !!apiUrl && !!transferId,
  });

  const ratings = ratingsData?.data || [];

  const mutation = useMutation({
    mutationFn: async () => {
      if (deliveredWhatAsked === null || !satisfaction) {
        throw new Error('Pick delivered-what-asked and a satisfaction tier first');
      }
      const res = await apiFetch(`${apiUrl}/v1/transfers/${encodeURIComponent(transferId)}/rate-result`, {
        method: 'POST',
        body: JSON.stringify({
          deliveredWhatAsked,
          satisfaction,
          score,
          flags: flags.length ? flags : undefined,
          note: note.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success('Rating saved');
      setDeliveredWhatAsked(null);
      setSatisfaction(null);
      setScore(75);
      setFlags([]);
      setNote('');
      queryClient.invalidateQueries({ queryKey: ['transfer-ratings', transferId] });
    },
    onError: (err: any) => toast.error(err.message || 'Failed to submit rating'),
  });

  const pickSatisfaction = (s: Satisfaction) => {
    setSatisfaction(s);
    const defaultScore = SATISFACTION_OPTIONS.find((o) => o.value === s)?.defaultScore ?? 75;
    setScore(defaultScore);
  };

  const toggleFlag = (flag: string) => {
    setFlags((curr) => (curr.includes(flag) ? curr.filter((f) => f !== flag) : [...curr, flag]));
  };

  return (
    <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-6 space-y-5">
      <div>
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">Rate this call</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Did the vendor actually deliver what the agent asked for? HTTP success alone can't catch a vendor that
          returned valid-looking JSON with useless contents — your rating here does.
        </p>
      </div>

      {intent && (intent.reason || (intent.expected_fields && intent.expected_fields.length > 0)) && (
        <div className="p-3 rounded-xl bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-900">
          <div className="text-xs font-medium text-indigo-700 dark:text-indigo-300 uppercase tracking-wide mb-1">
            Intent captured at sign time
          </div>
          {intent.reason && <p className="text-sm text-indigo-900 dark:text-indigo-200 mb-1">{intent.reason}</p>}
          {intent.expected_fields && intent.expected_fields.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {intent.expected_fields.map((f) => (
                <span key={f} className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-white dark:bg-gray-900 border border-indigo-200 dark:border-indigo-800 text-indigo-700 dark:text-indigo-300">
                  {f}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="space-y-2">
        <div className="text-sm font-medium text-gray-700 dark:text-gray-300">Delivered what was asked?</div>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => setDeliveredWhatAsked(true)}
            className={`flex-1 inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg border transition-colors text-sm font-medium ${
              deliveredWhatAsked === true
                ? 'bg-emerald-50 border-emerald-400 text-emerald-700 dark:bg-emerald-950 dark:border-emerald-600 dark:text-emerald-300'
                : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-gray-300'
            }`}
          >
            <ThumbsUp className="h-4 w-4" /> Yes
          </button>
          <button
            type="button"
            onClick={() => setDeliveredWhatAsked(false)}
            className={`flex-1 inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg border transition-colors text-sm font-medium ${
              deliveredWhatAsked === false
                ? 'bg-red-50 border-red-400 text-red-700 dark:bg-red-950 dark:border-red-600 dark:text-red-300'
                : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-gray-300'
            }`}
          >
            <ThumbsDown className="h-4 w-4" /> No
          </button>
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-sm font-medium text-gray-700 dark:text-gray-300">Satisfaction</div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          {SATISFACTION_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => pickSatisfaction(opt.value)}
              className={`px-3 py-2 rounded-lg border text-sm font-medium transition-colors ${
                satisfaction === opt.value
                  ? 'bg-blue-50 border-blue-400 text-blue-700 dark:bg-blue-950 dark:border-blue-600 dark:text-blue-300'
                  : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-gray-300'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium text-gray-700 dark:text-gray-300">Score</label>
          <span className="text-sm font-mono text-gray-500 dark:text-gray-400">{score}/100</span>
        </div>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={score}
          onChange={(e) => setScore(Number(e.target.value))}
          className="w-full"
        />
      </div>

      <div className="space-y-2">
        <div className="text-sm font-medium text-gray-700 dark:text-gray-300">Flags <span className="text-xs font-normal text-gray-400">(optional — pinpoint the failure mode)</span></div>
        <div className="flex flex-wrap gap-2">
          {COMMON_FLAGS.map((flag) => (
            <button
              key={flag}
              type="button"
              onClick={() => toggleFlag(flag)}
              className={`px-2.5 py-1 rounded-full border text-xs font-mono transition-colors ${
                flags.includes(flag)
                  ? 'bg-amber-50 border-amber-400 text-amber-700 dark:bg-amber-950 dark:border-amber-600 dark:text-amber-300'
                  : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-gray-300'
              }`}
            >
              {flag}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
          Note <span className="text-xs font-normal text-gray-400">(optional)</span>
        </label>
        <textarea
          rows={2}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="What was asked vs. what came back?"
          className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <button
        type="button"
        onClick={() => mutation.mutate()}
        disabled={deliveredWhatAsked === null || !satisfaction || mutation.isPending}
        className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {mutation.isPending ? 'Submitting…' : 'Submit rating'}
      </button>

      {ratings.length > 0 && (
        <div className="pt-4 border-t border-gray-200 dark:border-gray-800 space-y-3">
          <div className="text-sm font-medium text-gray-700 dark:text-gray-300">
            Ratings <span className="text-xs font-normal text-gray-400">({ratings.length})</span>
          </div>
          {ratings.map((r) => (
            <div key={r.id} className="flex gap-3 p-3 rounded-lg bg-gray-50 dark:bg-gray-800/50">
              <div className="flex-shrink-0">
                {r.rated_by_type === 'agent' ? (
                  <Bot className="h-5 w-5 text-indigo-500" />
                ) : r.rated_by_type === 'user' ? (
                  <User className="h-5 w-5 text-blue-500" />
                ) : (
                  <CheckCircle2 className="h-5 w-5 text-gray-400" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-gray-900 dark:text-white">
                    {r.rated_by_name || r.rated_by_type}
                  </span>
                  <span className={`text-[11px] font-mono px-1.5 py-0.5 rounded ${
                    r.delivered_what_asked
                      ? 'bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300'
                      : 'bg-red-100 dark:bg-red-950 text-red-700 dark:text-red-300'
                  }`}>
                    {r.delivered_what_asked ? 'delivered' : 'did not deliver'}
                  </span>
                  <span className="text-[11px] font-mono text-gray-500">{r.satisfaction}</span>
                  <span className="text-[11px] font-mono text-gray-500">{r.score}/100</span>
                  <span className="text-[11px] text-gray-400 ml-auto">{new Date(r.created_at).toLocaleString()}</span>
                </div>
                {r.flags && r.flags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1">
                    {r.flags.map((f) => (
                      <span key={f} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-950 text-amber-700 dark:text-amber-300">
                        {f}
                      </span>
                    ))}
                  </div>
                )}
                {r.note && (
                  <p className="text-sm text-gray-700 dark:text-gray-300 mt-1 whitespace-pre-wrap">{r.note}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
