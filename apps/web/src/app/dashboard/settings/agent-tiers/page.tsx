'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useApiConfig, useApiFetch } from '@/lib/api-client';
import { Bot, ChevronRight, TrendingUp, Pencil, Check, X } from 'lucide-react';
import { useState } from 'react';

interface KyaTierLimit {
  tier: number;
  per_transaction: number;
  daily: number;
  monthly: number;
  max_active_streams: number;
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

  const { data: tiersData } = useQuery<{ kya: KyaTierLimit[] }>({
    queryKey: ['kya-tier-limits'],
    queryFn: async () => {
      const res = await apiFetch(`${apiUrl}/v1/tier-limits`);
      if (!res.ok) return { kya: [] };
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

  const tierData = tiersData?.kya || [];

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
        {tierData.map((tier) => (
          <TierCard
            key={tier.tier}
            tier={tier}
            agentCount={agentStats?.counts[tier.tier] || 0}
            onSave={(patch) => updateTier.mutateAsync({ tier: tier.tier, ...patch })}
            saving={updateTier.isPending && updateTier.variables?.tier === tier.tier}
          />
        ))}
      </div>

      <div className="p-4 bg-amber-50 dark:bg-amber-950/50 border border-amber-200 dark:border-amber-800 rounded-xl">
        <p className="text-sm text-amber-700 dark:text-amber-300">
          <strong>Effective Limits Rule:</strong> Agent limits are always MIN(KYA tier, parent account tier).
          A T2 agent under a T0 account will have T0 limits. Saving a tier updates every agent at that tier.
        </p>
      </div>
    </div>
  );
}

function TierCard({
  tier,
  agentCount,
  onSave,
  saving,
}: {
  tier: KyaTierLimit;
  agentCount: number;
  onSave: (patch: { per_transaction: number; daily: number; monthly: number }) => Promise<unknown>;
  saving: boolean;
}) {
  const meta = TIER_META[tier.tier] || TIER_META[0];
  const colors = getColorClasses(meta.color);

  const [editing, setEditing] = useState(false);
  const [perTx, setPerTx] = useState<string>(String(tier.per_transaction));
  const [daily, setDaily] = useState<string>(String(tier.daily));
  const [monthly, setMonthly] = useState<string>(String(tier.monthly));
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setPerTx(String(tier.per_transaction));
    setDaily(String(tier.daily));
    setMonthly(String(tier.monthly));
    setError(null);
  };

  const cancel = () => {
    reset();
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

    try {
      await onSave({ per_transaction: p, daily: d, monthly: m });
      setEditing(false);
    } catch (e: any) {
      setError(e.message ?? 'Save failed');
    }
  };

  // T3 is "custom" — 0 means unlimited/custom, not editable here
  const canEdit = tier.tier !== 3;

  return (
    <div className="bg-white dark:bg-gray-950 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
      <div className="p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className={`w-10 h-10 rounded-lg ${colors.bg} flex items-center justify-center`}>
              <span className={`text-lg font-bold ${colors.text}`}>T{tier.tier}</span>
            </div>
            <div>
              <h3 className="font-semibold text-gray-900 dark:text-white">{meta.name}</h3>
              <p className="text-sm text-gray-600 dark:text-gray-400">{meta.description}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {agentCount > 0 && (
              <span className="text-xs font-medium text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded-full">
                {agentCount} agent{agentCount !== 1 ? 's' : ''}
              </span>
            )}
            {canEdit && !editing && (
              <button
                onClick={() => setEditing(true)}
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
              <LimitInput label="Per Tx ($)" value={perTx} onChange={setPerTx} />
              <LimitInput label="Daily ($)" value={daily} onChange={setDaily} />
              <LimitInput label="Monthly ($)" value={monthly} onChange={setMonthly} />
            </div>
            {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
            <div className="flex items-center gap-2">
              <button
                onClick={save}
                disabled={saving}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 rounded-md"
              >
                <Check className="w-3.5 h-3.5" />
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button
                onClick={cancel}
                disabled={saving}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-md"
              >
                <X className="w-3.5 h-3.5" />
                Cancel
              </button>
              <span className="text-xs text-gray-500 dark:text-gray-400 ml-auto">
                Applies to all {agentCount || 'existing'} T{tier.tier} agent{agentCount === 1 ? '' : 's'}
              </span>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-4 gap-3 mb-4 p-4 bg-gray-50 dark:bg-gray-900 rounded-lg">
            <div>
              <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">Per Tx</div>
              <div className="font-semibold text-gray-900 dark:text-white text-sm">{formatLimit(tier.per_transaction)}</div>
            </div>
            <div>
              <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">Daily</div>
              <div className="font-semibold text-gray-900 dark:text-white text-sm">{formatLimit(tier.daily)}</div>
            </div>
            <div>
              <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">Monthly</div>
              <div className="font-semibold text-gray-900 dark:text-white text-sm">{formatLimit(tier.monthly)}</div>
            </div>
            <div>
              <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">Streams</div>
              <div className="font-semibold text-gray-900 dark:text-white text-sm">
                {tier.max_active_streams === 0 && tier.tier === 3 ? '\u221E' : tier.max_active_streams}
              </div>
            </div>
          </div>
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

function LimitInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">{label}</label>
      <input
        type="number"
        min="0"
        step="1"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-2 py-1.5 text-sm font-medium text-gray-900 dark:text-white bg-white dark:bg-gray-950 border border-gray-300 dark:border-gray-700 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
      />
    </div>
  );
}
