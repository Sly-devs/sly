'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useApiConfig, useApiFetch } from '@/lib/api-client';
import { Bot, ChevronRight, TrendingUp, Pencil, Check, X, RotateCcw, Shield } from 'lucide-react';
import { useState } from 'react';

interface KyaTierLimit {
  tier: number;
  tenant_id: string | null;
  per_transaction: number;
  daily: number;
  monthly: number;
  max_active_streams: number;
}

interface TierLimitsResponse {
  kya: { platform: KyaTierLimit[]; tenant: KyaTierLimit[] };
  verification: { platform: unknown[]; tenant: unknown[] };
}

// PRD tier metadata (CAI framework names)
const TIER_META: Record<number, { name: string; description: string; color: string; caiLayers: string }> = {
  0: { name: 'Registered', description: 'Agent name + API key', color: 'gray', caiLayers: 'Layer 1 (partial), 4 (minimal)' },
  1: { name: 'Declared', description: 'Skill manifest + spending policy + escalation policy', color: 'blue', caiLayers: 'Layer 1 (DSD), 3 (APT), 4' },
  2: { name: 'Verified', description: '30-day history + zero violations + behavioral consistency', color: 'emerald', caiLayers: 'All 5 layers' },
  3: { name: 'Trusted', description: 'Security review + kill-switch + BRQ active', color: 'purple', caiLayers: 'All 5 (fully verified)' },
};

const getColorClasses = (color: string) => {
  switch (color) {
    case 'gray': return { bg: 'bg-gray-100 dark:bg-gray-800', text: 'text-gray-600 dark:text-gray-400' };
    case 'blue': return { bg: 'bg-blue-100 dark:bg-blue-950', text: 'text-blue-600 dark:text-blue-400' };
    case 'emerald': return { bg: 'bg-emerald-100 dark:bg-emerald-950', text: 'text-emerald-600 dark:text-emerald-400' };
    case 'purple': return { bg: 'bg-purple-100 dark:bg-purple-950', text: 'text-purple-600 dark:text-purple-400' };
    default: return { bg: 'bg-gray-100 dark:bg-gray-800', text: 'text-gray-600 dark:text-gray-400' };
  }
};

function formatLimit(value: number): string {
  if (value === 0) return 'Custom';
  if (value >= 1000) return `$${(value / 1000).toFixed(value % 1000 === 0 ? 0 : 1)}K`;
  return `$${value}`;
}

export default function AgentTiersSettingsPage() {
  const { apiUrl } = useApiConfig();
  const apiFetch = useApiFetch();
  const queryClient = useQueryClient();

  const { data: tiersData } = useQuery<TierLimitsResponse>({
    queryKey: ['kya-tier-limits'],
    queryFn: async () => {
      const res = await apiFetch(`${apiUrl}/v1/tier-limits`);
      if (!res.ok) return { kya: { platform: [], tenant: [] }, verification: { platform: [], tenant: [] } };
      return res.json();
    },
    staleTime: 60 * 1000,
  });

  const { data: agentStats } = useQuery({
    queryKey: ['agent-tier-stats'],
    queryFn: async () => {
      const res = await apiFetch(`${apiUrl}/v1/agents?limit=250`);
      if (!res.ok) return { counts: {} as Record<number, number>, total: 0 };
      const json = await res.json();
      const agents = json.data || [];
      const counts: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
      for (const agent of agents) {
        const t = agent.kya_tier ?? agent.kyaTier ?? agent.kya?.tier ?? 0;
        counts[t] = (counts[t] || 0) + 1;
      }
      return { counts, total: agents.length };
    },
    enabled: !!apiUrl,
    staleTime: 30 * 1000,
  });

  const updateTier = useMutation({
    mutationFn: async (payload: { tier: number; per_transaction: number; daily: number; monthly: number }) => {
      const res = await apiFetch(`${apiUrl}/v1/tier-limits/kya/${payload.tier}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          per_transaction: payload.per_transaction,
          daily: payload.daily,
          monthly: payload.monthly,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Update failed' }));
        throw new Error(err.error || 'Update failed');
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['kya-tier-limits'] });
    },
  });

  const resetTier = useMutation({
    mutationFn: async (tier: number) => {
      const res = await apiFetch(`${apiUrl}/v1/tier-limits/kya/${tier}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Reset failed' }));
        throw new Error(err.error || 'Reset failed');
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['kya-tier-limits'] });
    },
  });

  const platform = tiersData?.kya.platform ?? [];
  const tenantOverrides = tiersData?.kya.tenant ?? [];
  const byTier = (tier: number) => ({
    ceiling: platform.find(r => r.tier === tier),
    override: tenantOverrides.find(r => r.tier === tier),
  });

  return (
    <div className="space-y-6">
      <div className="bg-purple-50 dark:bg-purple-950/50 border border-purple-200 dark:border-purple-800 rounded-xl p-4">
        <div className="flex items-start gap-3">
          <Bot className="w-5 h-5 text-purple-600 dark:text-purple-400 mt-0.5" />
          <div>
            <h3 className="font-medium text-purple-900 dark:text-purple-200">Know Your Agent (KYA)</h3>
            <p className="text-sm text-purple-700 dark:text-purple-300 mt-1">
              KYA tiers define what AI agents can do. Agents start at T0 (Registered) and progress
              through declaration, behavioral observation, and full CAI verification.
              Effective limits = MIN(agent KYA tier, parent account tier).
            </p>
          </div>
        </div>
      </div>

      <div className="bg-indigo-50 dark:bg-indigo-950/50 border border-indigo-200 dark:border-indigo-800 rounded-xl p-4">
        <div className="flex items-start gap-3">
          <Shield className="w-5 h-5 text-indigo-600 dark:text-indigo-400 mt-0.5" />
          <div className="text-sm text-indigo-800 dark:text-indigo-200">
            <strong>Platform ceiling applies to your tenant.</strong> You can tighten each tier below the ceiling
            — never above. Need headroom above a ceiling? <span className="underline">Request an increase</span> and
            we&rsquo;ll review per-industry.
          </div>
        </div>
      </div>

      {agentStats && agentStats.total > 0 && (
        <div className="flex items-center gap-4 p-4 bg-gray-50 dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800">
          <TrendingUp className="w-5 h-5 text-gray-500" />
          <div className="flex gap-6 text-sm">
            {[0, 1, 2, 3].map((t) => {
              const meta = TIER_META[t];
              const count = agentStats.counts[t] || 0;
              return (
                <span key={t} className="text-gray-600 dark:text-gray-400">
                  <span className="font-medium text-gray-900 dark:text-white">{count}</span> T{t} {meta.name}
                </span>
              );
            })}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {[0, 1, 2, 3].map((t) => {
          const { ceiling, override } = byTier(t);
          if (!ceiling) return null;
          return (
            <TierCard
              key={t}
              ceiling={ceiling}
              override={override}
              agentCount={agentStats?.counts[t] || 0}
              onSave={(patch) => updateTier.mutateAsync({ tier: t, ...patch })}
              onReset={() => resetTier.mutateAsync(t)}
              saving={updateTier.isPending && updateTier.variables?.tier === t}
              resetting={resetTier.isPending && resetTier.variables === t}
            />
          );
        })}
      </div>

      <div className="p-4 bg-amber-50 dark:bg-amber-950/50 border border-amber-200 dark:border-amber-800 rounded-xl">
        <p className="text-sm text-amber-700 dark:text-amber-300">
          <strong>Effective Limits Rule:</strong> Agent limits are always MIN(KYA tier, parent account tier).
          A T2 agent under a T0 account will have T0 limits. Saving a tier updates every agent at that tier in your tenant.
        </p>
      </div>
    </div>
  );
}

function TierCard({
  ceiling,
  override,
  agentCount,
  onSave,
  onReset,
  saving,
  resetting,
}: {
  ceiling: KyaTierLimit;
  override: KyaTierLimit | undefined;
  agentCount: number;
  onSave: (patch: { per_transaction: number; daily: number; monthly: number }) => Promise<unknown>;
  onReset: () => Promise<unknown>;
  saving: boolean;
  resetting: boolean;
}) {
  const meta = TIER_META[ceiling.tier] || TIER_META[0];
  const colors = getColorClasses(meta.color);

  // "Effective" row is the override if present, else the ceiling.
  const effective = override ?? ceiling;

  const [editing, setEditing] = useState(false);
  const [perTx, setPerTx] = useState<string>(String(effective.per_transaction));
  const [daily, setDaily] = useState<string>(String(effective.daily));
  const [monthly, setMonthly] = useState<string>(String(effective.monthly));
  const [error, setError] = useState<string | null>(null);

  const startEdit = () => {
    setPerTx(String(effective.per_transaction));
    setDaily(String(effective.daily));
    setMonthly(String(effective.monthly));
    setError(null);
    setEditing(true);
  };

  const cancel = () => {
    setError(null);
    setEditing(false);
  };

  const save = async () => {
    setError(null);
    const p = Number.parseFloat(perTx);
    const d = Number.parseFloat(daily);
    const m = Number.parseFloat(monthly);
    if (Number.isNaN(p) || Number.isNaN(d) || Number.isNaN(m) || p < 0 || d < 0 || m < 0) {
      setError('All values must be numbers ≥ 0');
      return;
    }
    if (d < p) { setError('Daily cap must be ≥ per-transaction'); return; }
    if (m < d) { setError('Monthly cap must be ≥ daily'); return; }
    if (p > Number(ceiling.per_transaction)) { setError(`Per-Tx exceeds platform ceiling ($${ceiling.per_transaction})`); return; }
    if (d > Number(ceiling.daily)) { setError(`Daily exceeds platform ceiling ($${ceiling.daily})`); return; }
    if (m > Number(ceiling.monthly)) { setError(`Monthly exceeds platform ceiling ($${ceiling.monthly})`); return; }

    try {
      await onSave({ per_transaction: p, daily: d, monthly: m });
      setEditing(false);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Save failed');
    }
  };

  const reset = async () => {
    setError(null);
    try {
      await onReset();
      setEditing(false);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Reset failed');
    }
  };

  // T3 is "custom" — no editable ceiling
  const canEdit = ceiling.tier !== 3;
  const hasOverride = !!override;

  return (
    <div className="bg-white dark:bg-gray-950 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
      <div className="p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className={`w-10 h-10 rounded-lg ${colors.bg} flex items-center justify-center`}>
              <span className={`text-lg font-bold ${colors.text}`}>T{ceiling.tier}</span>
            </div>
            <div>
              <h3 className="font-semibold text-gray-900 dark:text-white">{meta.name}</h3>
              <p className="text-sm text-gray-600 dark:text-gray-400">{meta.description}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {hasOverride && (
              <span className="text-[10px] font-semibold uppercase tracking-wider text-indigo-700 dark:text-indigo-300 bg-indigo-100 dark:bg-indigo-950 px-2 py-0.5 rounded-full">
                Custom
              </span>
            )}
            {agentCount > 0 && (
              <span className="text-xs font-medium text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded-full">
                {agentCount} agent{agentCount !== 1 ? 's' : ''}
              </span>
            )}
            {canEdit && !editing && (
              <button
                onClick={startEdit}
                className="p-1.5 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800"
                title="Edit limits"
              >
                <Pencil className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {editing ? (
          <div className="space-y-3 mb-4">
            <div className="grid grid-cols-3 gap-3 p-4 bg-gray-50 dark:bg-gray-900 rounded-lg">
              <LimitInput label="Per Tx ($)" value={perTx} onChange={setPerTx} max={ceiling.per_transaction} />
              <LimitInput label="Daily ($)" value={daily} onChange={setDaily} max={ceiling.daily} />
              <LimitInput label="Monthly ($)" value={monthly} onChange={setMonthly} max={ceiling.monthly} />
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Platform ceiling: <span className="font-medium text-gray-700 dark:text-gray-300">{formatLimit(ceiling.per_transaction)}</span> / {formatLimit(ceiling.daily)} / {formatLimit(ceiling.monthly)}
            </p>
            {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={save}
                disabled={saving || resetting}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 rounded-md"
              >
                <Check className="w-3.5 h-3.5" />
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button
                onClick={cancel}
                disabled={saving || resetting}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-md"
              >
                <X className="w-3.5 h-3.5" />
                Cancel
              </button>
              {hasOverride && (
                <button
                  onClick={reset}
                  disabled={saving || resetting}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-md"
                  title="Reset to platform ceiling"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  {resetting ? 'Resetting…' : 'Reset to default'}
                </button>
              )}
              <span className="text-xs text-gray-500 dark:text-gray-400 ml-auto">
                Applies to {agentCount || 'your'} T{ceiling.tier} agent{agentCount === 1 ? '' : 's'}
              </span>
            </div>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-4 gap-3 mb-2 p-4 bg-gray-50 dark:bg-gray-900 rounded-lg">
              <LimitCell label="Per Tx" value={effective.per_transaction} />
              <LimitCell label="Daily" value={effective.daily} />
              <LimitCell label="Monthly" value={effective.monthly} />
              <div>
                <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">Streams</div>
                <div className="font-semibold text-gray-900 dark:text-white text-sm">
                  {effective.max_active_streams === 0 && effective.tier === 3 ? '\u221E' : effective.max_active_streams}
                </div>
              </div>
            </div>
            {hasOverride && (
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-4 pl-1">
                Platform ceiling: {formatLimit(ceiling.per_transaction)} / {formatLimit(ceiling.daily)} / {formatLimit(ceiling.monthly)}
              </p>
            )}
          </>
        )}

        <div>
          <div className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
            CAI Framework Coverage
          </div>
          <p className="text-sm text-gray-700 dark:text-gray-300 flex items-center gap-2">
            <ChevronRight className="w-3 h-3 text-gray-400" />
            {meta.caiLayers}
          </p>
        </div>
      </div>
    </div>
  );
}

function LimitCell({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">{label}</div>
      <div className="font-semibold text-gray-900 dark:text-white text-sm">{formatLimit(value)}</div>
    </div>
  );
}

function LimitInput({ label, value, onChange, max }: { label: string; value: string; onChange: (v: string) => void; max?: number }) {
  return (
    <div>
      <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
        {label}
        {max !== undefined && <span className="ml-1 text-[10px] text-gray-400">≤ {max}</span>}
      </label>
      <input
        type="number"
        min="0"
        max={max}
        step="1"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-2 py-1.5 text-sm font-medium text-gray-900 dark:text-white bg-white dark:bg-gray-950 border border-gray-300 dark:border-gray-700 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
      />
    </div>
  );
}
