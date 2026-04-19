'use client';

import { useQuery } from '@tanstack/react-query';
import { useApiConfig, useApiFetch } from '@/lib/api-client';
import { ShieldCheck, ChevronRight, TrendingUp } from 'lucide-react';

// PRD-aligned tier metadata
const TIER_META: Record<number, {
  name: string;
  description: string;
  color: string;
  requirements: { person: string[]; business: string[] };
}> = {
  0: {
    name: 'Explore',
    description: 'Email only + IP geolocation',
    color: 'gray',
    requirements: {
      person: ['Email verification or OAuth'],
      business: ['Email verification or OAuth'],
    },
  },
  1: {
    name: 'Starter',
    description: 'Lightweight KYC',
    color: 'blue',
    requirements: {
      person: ['Legal name', 'Date of birth', 'Country', 'Sanctions/PEP screening'],
      business: ['Legal name', 'Date of birth', 'Country', 'Company name', 'Sanctions/PEP screening'],
    },
  },
  2: {
    name: 'Verified',
    description: 'Full identity verification',
    color: 'emerald',
    requirements: {
      person: ['Government ID', 'Liveness selfie', 'Proof of address'],
      business: ['Registration docs', 'UBO disclosure (25%+)', 'Business address', 'Signatory ID + liveness'],
    },
  },
  3: {
    name: 'Enterprise',
    description: 'Enhanced due diligence',
    color: 'purple',
    requirements: {
      person: ['Custom — relationship managed'],
      business: ['Audited financials', 'Source of funds', 'Enhanced UBO', 'Ongoing monitoring', 'Compliance contact'],
    },
  },
};

// Seed data limits (from 20260413_tier_limits_tables.sql)
const PERSON_LIMITS: Record<number, { perTx: number; daily: number; monthly: number }> = {
  0: { perTx: 100, daily: 500, monthly: 2000 },
  1: { perTx: 500, daily: 2000, monthly: 10000 },
  2: { perTx: 5000, daily: 20000, monthly: 100000 },
  3: { perTx: 0, daily: 0, monthly: 0 },
};

const BUSINESS_LIMITS: Record<number, { perTx: number; daily: number; monthly: number }> = {
  0: { perTx: 100, daily: 500, monthly: 2000 },
  1: { perTx: 500, daily: 2000, monthly: 10000 },
  2: { perTx: 50000, daily: 200000, monthly: 500000 },
  3: { perTx: 0, daily: 0, monthly: 0 },
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
  if (value >= 1000000) return `$${(value / 1000000).toFixed(0)}M`;
  if (value >= 1000) return `$${(value / 1000).toFixed(0)}K`;
  return `$${value}`;
}

export default function VerificationTiersSettingsPage() {
  const { apiUrl } = useApiConfig();
  const apiFetch = useApiFetch();

  // Fetch account counts per tier
  const { data: accountStats } = useQuery({
    queryKey: ['account-tier-stats'],
    queryFn: async () => {
      const res = await apiFetch(`${apiUrl}/v1/accounts?limit=250`);
      if (!res.ok) return { counts: {} as Record<number, number>, total: 0 };
      const json = await res.json();
      const accounts = json.data || [];
      const counts: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
      for (const acct of accounts) {
        const t = acct.verification_tier ?? acct.verificationTier ?? acct.verification?.tier ?? 0;
        counts[t] = (counts[t] || 0) + 1;
      }
      return { counts, total: accounts.length };
    },
    enabled: !!apiUrl,
    staleTime: 30 * 1000,
  });

  return (
    <div className="space-y-6">
      {/* Info Banner */}
      <div className="bg-blue-50 dark:bg-blue-950/50 border border-blue-200 dark:border-blue-800 rounded-xl p-4">
        <div className="flex items-start gap-3">
          <ShieldCheck className="w-5 h-5 text-blue-600 dark:text-blue-400 mt-0.5" />
          <div>
            <h3 className="font-medium text-blue-900 dark:text-blue-200">Account Verification Tiers (KYC/KYB)</h3>
            <p className="text-sm text-blue-700 dark:text-blue-300 mt-1">
              Progressive verification from email-only to full EDD. Compliance feels like a feature, not a gate.
              Business accounts get higher limits at T2+.
            </p>
          </div>
        </div>
      </div>

      {/* Account Distribution */}
      {accountStats && accountStats.total > 0 && (
        <div className="flex items-center gap-4 p-4 bg-gray-50 dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800">
          <TrendingUp className="w-5 h-5 text-gray-500" />
          <div className="flex gap-6 text-sm">
            {[0, 1, 2, 3].map((t) => {
              const meta = TIER_META[t];
              const count = accountStats.counts[t] || 0;
              return (
                <span key={t} className="text-gray-600 dark:text-gray-400">
                  <span className="font-medium text-gray-900 dark:text-white">{count}</span> T{t} {meta.name}
                </span>
              );
            })}
          </div>
        </div>
      )}

      {/* Tiers Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {[0, 1, 2, 3].map((tierNum) => {
          const meta = TIER_META[tierNum];
          const colors = getColorClasses(meta.color);
          const personLimits = PERSON_LIMITS[tierNum];
          const businessLimits = BUSINESS_LIMITS[tierNum];
          const accountCount = accountStats?.counts[tierNum] || 0;

          return (
            <div key={tierNum} className="bg-white dark:bg-gray-950 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
              <div className="p-6">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <div className={`w-10 h-10 rounded-lg ${colors.bg} flex items-center justify-center`}>
                      <span className={`text-lg font-bold ${colors.text}`}>T{tierNum}</span>
                    </div>
                    <div>
                      <h3 className="font-semibold text-gray-900 dark:text-white">{meta.name}</h3>
                      <p className="text-sm text-gray-600 dark:text-gray-400">{meta.description}</p>
                    </div>
                  </div>
                  {accountCount > 0 && (
                    <span className="text-xs font-medium text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded-full">
                      {accountCount} account{accountCount !== 1 ? 's' : ''}
                    </span>
                  )}
                </div>

                {/* Limits — Person */}
                <div className="mb-3">
                  <div className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
                    Person Limits
                  </div>
                  <div className="grid grid-cols-3 gap-3 p-3 bg-gray-50 dark:bg-gray-900 rounded-lg">
                    <div>
                      <div className="text-xs text-gray-500 dark:text-gray-400 mb-0.5">Per Tx</div>
                      <div className="font-semibold text-gray-900 dark:text-white text-sm">{formatLimit(personLimits.perTx)}</div>
                    </div>
                    <div>
                      <div className="text-xs text-gray-500 dark:text-gray-400 mb-0.5">Daily</div>
                      <div className="font-semibold text-gray-900 dark:text-white text-sm">{formatLimit(personLimits.daily)}</div>
                    </div>
                    <div>
                      <div className="text-xs text-gray-500 dark:text-gray-400 mb-0.5">Monthly</div>
                      <div className="font-semibold text-gray-900 dark:text-white text-sm">{formatLimit(personLimits.monthly)}</div>
                    </div>
                  </div>
                </div>

                {/* Limits — Business (only show if different from person) */}
                {(businessLimits.perTx !== personLimits.perTx || businessLimits.daily !== personLimits.daily) && (
                  <div className="mb-3">
                    <div className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
                      Business Limits
                    </div>
                    <div className="grid grid-cols-3 gap-3 p-3 bg-gray-50 dark:bg-gray-900 rounded-lg">
                      <div>
                        <div className="text-xs text-gray-500 dark:text-gray-400 mb-0.5">Per Tx</div>
                        <div className="font-semibold text-gray-900 dark:text-white text-sm">{formatLimit(businessLimits.perTx)}</div>
                      </div>
                      <div>
                        <div className="text-xs text-gray-500 dark:text-gray-400 mb-0.5">Daily</div>
                        <div className="font-semibold text-gray-900 dark:text-white text-sm">{formatLimit(businessLimits.daily)}</div>
                      </div>
                      <div>
                        <div className="text-xs text-gray-500 dark:text-gray-400 mb-0.5">Monthly</div>
                        <div className="font-semibold text-gray-900 dark:text-white text-sm">{formatLimit(businessLimits.monthly)}</div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Requirements */}
                <div>
                  <div className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
                    Requirements
                  </div>
                  <ul className="space-y-1">
                    {meta.requirements.person.map((req, i) => (
                      <li key={i} className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                        <ChevronRight className="w-3 h-3 text-gray-400" />
                        {req}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
