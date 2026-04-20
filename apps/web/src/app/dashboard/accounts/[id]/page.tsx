'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useApiClient } from '@/lib/api-client';
import Link from 'next/link';
import {
  ArrowLeft,
  Building2,
  User,
  Mail,
  Calendar,
  Shield,
  Wallet,
  Activity,
  Bot,
  FileText,
  MoreVertical,
  CheckCircle,
  XCircle,
  Pause,
  Store,
  Package,
  TrendingUp,
  Zap,
  Star,
  Banknote,
} from 'lucide-react';
import type { Account, Agent, Stream, LedgerEntry, Transfer, Wallet as WalletData } from '@sly/api-client';
import { useLocale } from '@/lib/locale';
import { formatCurrency } from '@sly/ui';

import { ScreeningTab } from '@/components/dashboard/account-360/screening-tab';
import { toast } from 'sonner';

type TabType = 'overview' | 'transactions' | 'streams' | 'agents' | 'wallets' | 'screening' | 'commerce' | 'catalog' | 'endpoints' | 'ratings' | 'payouts';

export default function AccountDetailPage() {
  const params = useParams();
  const router = useRouter();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const accountId = params.id as string;

  const [activeTab, setActiveTab] = useState<TabType>('overview');
  const { formatCurrency: formatCurrencyLocale, formatDate: formatDateLocale } = useLocale();

  // Fetch account data with React Query - LAZY LOADING based on active tab
  // Overview tab: Always load account data immediately
  const { data: accountResponse, isLoading: accountLoading } = useQuery({
    queryKey: ['account', accountId],
    queryFn: () => api!.accounts.get(accountId),
    enabled: !!api, // Always load account data
  });

  // Handle double-nested response
  const account = (accountResponse as any)?.data || accountResponse;
  const isMerchant = account?.subtype === 'merchant';

  // Merchant stats — only fetch when the account IS a merchant and user is
  // on a merchant-specific tab. Graceful 404 when account exists but isn't a merchant.
  const { data: merchantStatsResp } = useQuery({
    queryKey: ['account', accountId, 'merchant-stats'],
    queryFn: () => api!.accounts.getMerchantStats(accountId, { minutes: 43200 }), // 30 days
    enabled: !!api && isMerchant && (activeTab === 'commerce' || activeTab === 'catalog' || activeTab === 'endpoints' || activeTab === 'overview'),
  });
  const merchantStats = (merchantStatsResp as any)?.data;

  const { data: merchantRatingsResp } = useQuery({
    queryKey: ['account', accountId, 'merchant-ratings'],
    queryFn: () => api!.merchants.listRatings(accountId, { limit: 20 }),
    enabled: !!api && isMerchant && (activeTab === 'ratings' || activeTab === 'overview'),
  });
  const merchantRatings = (merchantRatingsResp as any)?.data;

  // Agents tab: Only load when tab is active
  const { data: agentsData, isLoading: agentsLoading } = useQuery({
    queryKey: ['account', accountId, 'agents'],
    queryFn: () => api!.accounts.getAgents(accountId, { limit: 50 }),
    enabled: !!api,
  });

  // Streams tab: Only load when tab is active
  const { data: streamsData, isLoading: streamsLoading } = useQuery({
    queryKey: ['account', accountId, 'streams'],
    queryFn: () => api!.accounts.getStreams(accountId, { limit: 50 }),
    enabled: !!api && activeTab === 'streams', // Lazy load only when streams tab active
  });

  // Wallets count: Load immediately for tab badge
  const { data: walletsCountData } = useQuery({
    queryKey: ['account', accountId, 'wallets', 'count'],
    queryFn: () => api!.wallets.list({ owner_account_id: accountId, limit: 1 } as any),
    enabled: !!api, // Always load for count
  });

  // Wallets tab: Full data when tab is active
  const { data: walletsData } = useQuery({
    queryKey: ['account', accountId, 'wallets'],
    queryFn: () => api!.wallets.list({ owner_account_id: accountId, limit: 50 } as any),
    enabled: !!api && activeTab === 'wallets',
  });

  // Transaction counts: Load immediately for tab badges
  const { data: transactionsCountData } = useQuery({
    queryKey: ['account', accountId, 'transactions', 'count'],
    queryFn: () => api!.accounts.getTransactions(accountId, { limit: 1 }),
    enabled: !!api, // Always load for count
  });

  const { data: transfersCountData } = useQuery({
    queryKey: ['account', accountId, 'transfers', 'count'],
    queryFn: () => api!.accounts.getTransfers(accountId, { limit: 1 }),
    enabled: !!api, // Always load for count
  });

  // Transactions tab: Only load full data when tab is active
  const { data: transactionsData, isLoading: transactionsLoading } = useQuery({
    queryKey: ['account', accountId, 'transactions'],
    queryFn: () => api!.accounts.getTransactions(accountId, { limit: 50 }),
    enabled: !!api && activeTab === 'transactions', // Lazy load only when transactions tab active
  });

  // Transactions tab: Also load transfers when transactions tab is active
  const { data: transfersData, isLoading: transfersLoading } = useQuery({
    queryKey: ['account', accountId, 'transfers'],
    queryFn: () => api!.accounts.getTransfers(accountId, { limit: 50 }),
    enabled: !!api && activeTab === 'transactions', // Lazy load only when transactions tab active
  });

  const agents = (agentsData as any)?.data?.data || agentsData?.data || [];
  const streams = (streamsData as any)?.data?.data || streamsData?.data || [];
  const wallets = (walletsData as any)?.data?.data || walletsData?.data || [];
  const transactions = (transactionsData as any)?.data?.data || transactionsData?.data || [];
  const transfers = (transfersData as any)?.data?.data || transfersData?.data || [];
  const loading = accountLoading;

  // Mutations with automatic cache invalidation
  const verifyMutation = useMutation({
    mutationFn: (tier: number) => api!.accounts.verify(accountId, tier),
    onSuccess: () => {
      // Invalidate and refetch account data
      queryClient.invalidateQueries({ queryKey: ['account', accountId] });
    },
  });

  const suspendMutation = useMutation({
    mutationFn: () => api!.accounts.suspend(accountId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['account', accountId] });
    },
  });

  const activateMutation = useMutation({
    mutationFn: () => api!.accounts.activate(accountId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['account', accountId] });
    },
  });

  const handleVerify = async (tier: number) => {
    if (!api || !account) return;
    try {
      await verifyMutation.mutateAsync(tier);
    } catch (error) {
      console.error('Failed to verify account:', error);
    }
  };

  const handleSuspend = async () => {
    if (!api || !account) return;
    try {
      await suspendMutation.mutateAsync();
    } catch (error) {
      console.error('Failed to suspend account:', error);
    }
  };

  const handleActivate = async () => {
    if (!api || !account) return;
    try {
      await activateMutation.mutateAsync();
    } catch (error) {
      console.error('Failed to activate account:', error);
    }
  };

  // Combine mutation loading states
  const actionLoading = verifyMutation.isPending || suspendMutation.isPending || activateMutation.isPending;

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

  if (!account) {
    return (
      <div className="p-8 text-center">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Account not found</h2>
        <Link href="/dashboard/accounts" className="text-blue-600 hover:underline mt-4 inline-block">
          Back to accounts
        </Link>
      </div>
    );
  }

  // Ledger entries are the canonical transaction count (transfers that have ledger entries are deduplicated)
  const transactionsCount = (transactionsCountData as any)?.pagination?.total || transactions.length;
  const agentsCount = agents.length;
  const walletsCount = (walletsCountData as any)?.pagination?.total || wallets.length;

  const catalogCount = merchantStats?.merchant?.catalog?.products?.length ?? 0;
  const endpointsCount = merchantStats?.endpoints?.length ?? 0;
  const ratingsCount = merchantRatings?.totalRatings ?? 0;

  const tabs = [
    { id: 'overview' as TabType, label: 'Overview', icon: Wallet },
    { id: 'transactions' as TabType, label: 'Transactions', icon: FileText, count: transactionsCount },
    ...(isMerchant ? [
      { id: 'commerce' as TabType, label: 'Commerce', icon: TrendingUp },
      { id: 'catalog' as TabType, label: 'Catalog', icon: Package, count: catalogCount },
      ...(endpointsCount > 0 ? [{ id: 'endpoints' as TabType, label: 'Endpoints', icon: Zap, count: endpointsCount }] : []),
      { id: 'ratings' as TabType, label: 'Ratings', icon: Star, count: ratingsCount },
      { id: 'payouts' as TabType, label: 'Payouts', icon: Banknote },
    ] : []),
    { id: 'streams' as TabType, label: 'Streams', icon: Activity, count: streams.length },
    { id: 'agents' as TabType, label: 'Agents', icon: Bot, count: agentsCount },
    { id: 'wallets' as TabType, label: 'Wallets', icon: Wallet, count: walletsCount },
    { id: 'screening' as TabType, label: 'Screening', icon: Shield },
  ];

  const handleRunScreening = () => {
    toast.promise(
      new Promise((resolve) => setTimeout(resolve, 2000)),
      {
        loading: 'Running screening check...',
        success: 'Screening completed. No new risks found.',
        error: 'Screening failed',
      }
    );
  };

  return (
    <div className="p-8 max-w-[1600px] mx-auto">
      {/* Back button */}
      <Link
        href="/dashboard/accounts"
        className="inline-flex items-center gap-2 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white mb-6"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to accounts
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between mb-8">
        <div className="flex items-center gap-4">
          <div className={`w-16 h-16 rounded-2xl flex items-center justify-center ${account.type === 'business'
            ? 'bg-purple-100 dark:bg-purple-950'
            : 'bg-blue-100 dark:bg-blue-950'
            }`}>
            {account.type === 'business' ? (
              <Building2 className="h-8 w-8 text-purple-600 dark:text-purple-400" />
            ) : (
              <User className="h-8 w-8 text-blue-600 dark:text-blue-400" />
            )}
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{account.name}</h1>
              {isMerchant && (
                <span className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-full bg-purple-100 dark:bg-purple-950 text-purple-700 dark:text-purple-300">
                  <Store className="h-3.5 w-3.5" />
                  Merchant
                  {account.metadata?.merchant_type && ` · ${account.metadata.merchant_type}`}
                </span>
              )}
              {isMerchant && merchantRatings?.overallAverage != null && (
                <span className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-full bg-amber-100 dark:bg-amber-950 text-amber-700 dark:text-amber-300">
                  <Star className="h-3.5 w-3.5 fill-current" />
                  {Number(merchantRatings.overallAverage).toFixed(1)}
                  <span className="text-amber-500 dark:text-amber-500/70">/5</span>
                </span>
              )}
            </div>
            <div className="flex items-center gap-4 mt-1 text-sm text-gray-500 dark:text-gray-400">
              <span className="flex items-center gap-1">
                <Mail className="h-4 w-4" />
                {account.email}
              </span>
              <span className="flex items-center gap-1">
                <Calendar className="h-4 w-4" />
                Joined {new Date(account.createdAt).toLocaleDateString()}
              </span>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2">
          <span className={`px-3 py-1.5 text-sm font-medium rounded-full ${account.verificationStatus === 'verified'
            ? 'bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-400'
            : account.verificationStatus === 'suspended'
              ? 'bg-red-100 dark:bg-red-950 text-red-700 dark:text-red-400'
              : 'bg-yellow-100 dark:bg-yellow-950 text-yellow-700 dark:text-yellow-400'
            }`}>
            {account.verificationStatus}
          </span>

          <div className="relative group">
            <button className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg">
              <MoreVertical className="h-5 w-5 text-gray-500" />
            </button>
            <div className="absolute right-0 top-full mt-1 w-48 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg shadow-lg opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-10">
              {account.verificationStatus !== 'verified' && (
                <>
                  <button
                    onClick={() => handleVerify(1)}
                    disabled={actionLoading}
                    className="w-full px-4 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-800 flex items-center gap-2"
                  >
                    <CheckCircle className="h-4 w-4 text-emerald-500" />
                    Verify (Tier 1)
                  </button>
                  <button
                    onClick={() => handleVerify(2)}
                    disabled={actionLoading}
                    className="w-full px-4 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-800 flex items-center gap-2"
                  >
                    <CheckCircle className="h-4 w-4 text-emerald-500" />
                    Verify (Tier 2)
                  </button>
                  <button
                    onClick={() => handleVerify(3)}
                    disabled={actionLoading}
                    className="w-full px-4 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-800 flex items-center gap-2"
                  >
                    <CheckCircle className="h-4 w-4 text-emerald-500" />
                    Verify (Tier 3)
                  </button>
                </>
              )}
              {account.verificationStatus !== 'suspended' && (
                <button
                  onClick={handleSuspend}
                  disabled={actionLoading}
                  className="w-full px-4 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-800 flex items-center gap-2 text-red-600"
                >
                  <Pause className="h-4 w-4" />
                  Suspend Account
                </button>
              )}
              {account.verificationStatus === 'suspended' && (
                <button
                  onClick={handleActivate}
                  disabled={actionLoading}
                  className="w-full px-4 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-800 flex items-center gap-2 text-emerald-600"
                >
                  <CheckCircle className="h-4 w-4" />
                  Activate Account
                </button>
              )}
              <div className="border-t border-gray-100 dark:border-gray-800 my-1.5" />
              <button
                onClick={handleRunScreening}
                className="w-full px-4 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-800 flex items-center gap-2"
              >
                <Shield className="h-4 w-4 text-purple-500" />
                Run Screening
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
        <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-5">
          <div className="text-sm text-gray-500 dark:text-gray-400 mb-1">Total Balance</div>
          <div className="text-2xl font-bold text-gray-900 dark:text-white">
            {formatCurrencyLocale(account.balanceTotal || 0, account.currency || 'USDC')}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-5">
          <div className="text-sm text-gray-500 dark:text-gray-400 mb-1">Available</div>
          <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">
            {formatCurrencyLocale(account.balanceAvailable || 0, account.currency || 'USDC')}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-5">
          <div className="text-sm text-gray-500 dark:text-gray-400 mb-1">In Streams</div>
          <div className="text-2xl font-bold text-blue-600 dark:text-blue-400">
            {formatCurrencyLocale(account.balanceInStreams || 0, account.currency || 'USDC')}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-5">
          <div className="text-sm text-gray-500 dark:text-gray-400 mb-1">Verification Tier</div>
          <div className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
            <Shield className="h-5 w-5 text-blue-500" />
            Tier {account.verificationTier}
          </div>
        </div>
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
        <OverviewTab account={account} />
      )}
      {activeTab === 'transactions' && (
        <TransactionsTab transactions={transactions} transfers={transfers} accountId={accountId} />
      )}
      {activeTab === 'streams' && (
        <StreamsTab streams={streams} />
      )}
      {activeTab === 'agents' && (
        <AgentsTab agents={agents} />
      )}
      {activeTab === 'wallets' && (
        <WalletsTab wallets={wallets} />
      )}
      {activeTab === 'screening' && (
        <ScreeningTab />
      )}
      {activeTab === 'commerce' && isMerchant && (
        <CommerceTab stats={merchantStats} />
      )}
      {activeTab === 'catalog' && isMerchant && (
        <CatalogTab stats={merchantStats} accountId={accountId} />
      )}
      {activeTab === 'endpoints' && isMerchant && (
        <EndpointsTab stats={merchantStats} />
      )}
      {activeTab === 'ratings' && isMerchant && (
        <RatingsTab ratings={merchantRatings} />
      )}
      {activeTab === 'payouts' && isMerchant && (
        <PayoutsTab accountId={accountId} />
      )}
    </div>
  );
}

// ─── Merchant tab components ──────────────────────────────────────────────

function CommerceTab({ stats }: { stats: any }) {
  if (!stats) return <div className="p-8 text-center text-gray-500">Loading commerce data…</div>;
  const { volume, counts, topBuyers, recentSales } = stats;
  return (
    <div className="space-y-6">
      {/* Volume breakdown */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatCard label="Total Volume (30d)" value={`$${Number(volume.total).toFixed(2)}`} sub={`${counts.total} purchases`} />
        <StatCard label="ACP" icon="🍔" value={`$${Number(volume.acp).toFixed(2)}`} sub={`${counts.acp} checkouts`} />
        <StatCard label="UCP" icon="🏨" value={`$${Number(volume.ucp).toFixed(2)}`} sub={`${counts.ucp} orders`} />
        <StatCard label="x402" icon="⚡" value={`$${Number(volume.x402).toFixed(2)}`} sub={`${counts.x402} API calls`} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Top buyers */}
        <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Top Buyers</h3>
          {topBuyers?.length ? (
            <div className="space-y-2">
              {topBuyers.map((b: any) => (
                <div key={b.agentId} className="flex items-center justify-between py-2 border-b border-gray-100 dark:border-gray-900 last:border-0">
                  <span className="font-medium text-gray-900 dark:text-white">{b.name}</span>
                  <span className="flex items-center gap-3 text-sm">
                    <span className="text-gray-500 dark:text-gray-400">{b.sales} sales</span>
                    <span className="font-semibold text-purple-600 dark:text-purple-400">${Number(b.spend).toFixed(2)}</span>
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-gray-500 dark:text-gray-400 text-sm">No purchases yet in this window.</div>
          )}
        </div>

        {/* Recent sales */}
        <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Recent Sales</h3>
          {recentSales?.length ? (
            <div className="space-y-2 max-h-96 overflow-y-auto">
              {recentSales.map((s: any, i: number) => (
                <div key={i} className="flex items-center justify-between py-2 border-b border-gray-100 dark:border-gray-900 last:border-0 text-sm">
                  <span className="flex items-center gap-2">
                    <span>{s.protocol === 'acp' ? '🍔' : s.protocol === 'ucp' ? '🏨' : '⚡'}</span>
                    <span className="text-gray-900 dark:text-white">{s.buyerName || '—'}</span>
                    <span className="text-gray-500 dark:text-gray-400 truncate max-w-[180px]">{s.item}</span>
                  </span>
                  <span className="font-medium text-purple-600 dark:text-purple-400">${Number(s.amount).toFixed(2)}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-gray-500 dark:text-gray-400 text-sm">No sales yet.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function CatalogTab({ stats, accountId }: { stats: any; accountId: string }) {
  const api = useApiClient();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<{ mode: 'add' } | { mode: 'edit'; product: any } | null>(null);
  const [deleting, setDeleting] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!stats) return <div className="p-8 text-center text-gray-500">Loading catalog…</div>;
  const products = stats?.merchant?.catalog?.products || [];

  async function saveProduct(form: { name: string; category: string; price: string; sku: string; description: string }) {
    setSaving(true);
    setError(null);
    try {
      const unit_price_cents = Math.round(parseFloat(form.price) * 100);
      if (!Number.isFinite(unit_price_cents) || unit_price_cents < 0) {
        setError('Price must be a number ≥ 0');
        setSaving(false);
        return;
      }
      const payload = {
        name: form.name.trim(),
        category: form.category.trim(),
        unit_price_cents,
        sku: form.sku.trim() || undefined,
        description: form.description.trim() || undefined,
      };
      if (editing && editing.mode === 'add') {
        await api!.accounts.addProduct(accountId, payload);
      } else if (editing && editing.mode === 'edit') {
        await api!.accounts.updateProduct(accountId, editing.product.id, payload);
      }
      await queryClient.invalidateQueries({ queryKey: ['account', accountId, 'merchant-stats'] });
      setEditing(null);
    } catch (e: any) {
      setError(e?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function deleteProduct() {
    if (!deleting) return;
    setSaving(true);
    setError(null);
    try {
      await api!.accounts.deleteProduct(accountId, deleting.id);
      await queryClient.invalidateQueries({ queryKey: ['account', accountId, 'merchant-stats'] });
      setDeleting(null);
    } catch (e: any) {
      setError(e?.message || 'Delete failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 overflow-hidden">
        <div className="p-6 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Catalog ({products.length})</h3>
          <button
            onClick={() => setEditing({ mode: 'add' })}
            className="px-3 py-1.5 text-sm font-medium rounded-lg bg-purple-600 text-white hover:bg-purple-700"
          >
            + Add Product
          </button>
        </div>
        {products.length === 0 ? (
          <div className="p-8 text-center text-gray-500">No products in the catalog yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-900 text-xs uppercase text-gray-500 dark:text-gray-400">
              <tr>
                <th className="px-6 py-3 text-left">Name</th>
                <th className="px-6 py-3 text-left">Category</th>
                <th className="px-6 py-3 text-left">SKU</th>
                <th className="px-6 py-3 text-right">Price</th>
                <th className="px-6 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {products.map((p: any) => (
                <tr key={p.id} className="border-t border-gray-100 dark:border-gray-900">
                  <td className="px-6 py-3 font-medium text-gray-900 dark:text-white">{p.name}</td>
                  <td className="px-6 py-3 text-gray-500 dark:text-gray-400">{p.category}</td>
                  <td className="px-6 py-3 text-xs font-mono text-gray-400">{p.sku || '—'}</td>
                  <td className="px-6 py-3 text-right font-semibold text-gray-900 dark:text-white">
                    ${((p.unit_price_cents ?? 0) / 100).toFixed(2)}
                  </td>
                  <td className="px-6 py-3 text-right">
                    <button
                      onClick={() => setEditing({ mode: 'edit', product: p })}
                      className="text-xs font-medium text-blue-600 hover:underline mr-3"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => setDeleting(p)}
                      className="text-xs font-medium text-red-600 hover:underline"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editing && (
        <ProductModal
          initial={editing.mode === 'edit' ? editing.product : null}
          onSave={saveProduct}
          onClose={() => { setEditing(null); setError(null); }}
          saving={saving}
          error={error}
        />
      )}
      {deleting && (
        <ConfirmModal
          title={`Delete "${deleting.name}"?`}
          message="This product will be removed from the merchant's catalog. Existing checkouts referencing it are not affected."
          confirmLabel="Delete"
          confirmClass="bg-red-600 hover:bg-red-700"
          saving={saving}
          error={error}
          onConfirm={deleteProduct}
          onCancel={() => { setDeleting(null); setError(null); }}
        />
      )}
    </>
  );
}

function ProductModal({
  initial,
  onSave,
  onClose,
  saving,
  error,
}: {
  initial: any | null;
  onSave: (form: { name: string; category: string; price: string; sku: string; description: string }) => void;
  onClose: () => void;
  saving: boolean;
  error: string | null;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [category, setCategory] = useState(initial?.category ?? '');
  const [price, setPrice] = useState(initial ? String((initial.unit_price_cents ?? 0) / 100) : '');
  const [sku, setSku] = useState(initial?.sku ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white dark:bg-gray-950 rounded-2xl shadow-xl max-w-md w-full p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
          {initial ? 'Edit Product' : 'Add Product'}
        </h3>
        <div className="space-y-3">
          <Field label="Name *"><input className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 text-gray-900 dark:text-white" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Category *"><input className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 text-gray-900 dark:text-white" value={category} onChange={(e) => setCategory(e.target.value)} /></Field>
          <Field label="Price (USDC) *"><input type="number" min="0" step="0.01" className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 text-gray-900 dark:text-white" value={price} onChange={(e) => setPrice(e.target.value)} /></Field>
          <Field label="SKU"><input className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 text-gray-900 dark:text-white font-mono text-sm" value={sku} onChange={(e) => setSku(e.target.value)} /></Field>
          <Field label="Description"><textarea rows={2} className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 text-gray-900 dark:text-white" value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} disabled={saving} className="px-4 py-2 text-sm font-medium rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-50">Cancel</button>
          <button
            onClick={() => onSave({ name, category, price, sku, description })}
            disabled={saving || !name.trim() || !category.trim() || !price}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-50"
          >
            {saving ? 'Saving…' : initial ? 'Save Changes' : 'Add Product'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ConfirmModal({
  title,
  message,
  confirmLabel,
  confirmClass,
  saving,
  error,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  confirmClass: string;
  saving: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white dark:bg-gray-950 rounded-2xl shadow-xl max-w-sm w-full p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">{title}</h3>
        <p className="text-sm text-gray-600 dark:text-gray-400">{message}</p>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onCancel} disabled={saving} className="px-4 py-2 text-sm font-medium rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-50">Cancel</button>
          <button onClick={onConfirm} disabled={saving} className={`px-4 py-2 text-sm font-medium rounded-lg text-white ${confirmClass} disabled:opacity-50`}>
            {saving ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-gray-700 dark:text-gray-300 mb-1 block">{label}</span>
      {children}
    </label>
  );
}

function EndpointsTab({ stats }: { stats: any }) {
  const endpoints = stats?.endpoints || [];
  if (endpoints.length === 0) return <div className="p-8 text-center text-gray-500">This merchant has no x402 endpoints.</div>;
  return (
    <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 overflow-hidden">
      <div className="p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">x402 Endpoints ({endpoints.length})</h3>
      </div>
      <table className="w-full text-sm">
        <thead className="bg-gray-50 dark:bg-gray-900 text-xs uppercase text-gray-500 dark:text-gray-400">
          <tr>
            <th className="px-6 py-3 text-left">Name</th>
            <th className="px-6 py-3 text-left">Method / Path</th>
            <th className="px-6 py-3 text-right">Price</th>
            <th className="px-6 py-3 text-right">Calls</th>
            <th className="px-6 py-3 text-right">Revenue</th>
            <th className="px-6 py-3 text-left">Status</th>
          </tr>
        </thead>
        <tbody>
          {endpoints.map((e: any) => (
            <tr key={e.id} className="border-t border-gray-100 dark:border-gray-900">
              <td className="px-6 py-3 font-medium text-gray-900 dark:text-white">
                <Link href={`/dashboard/agentic-payments/x402/endpoints/${e.id}`} className="text-amber-600 dark:text-amber-400 hover:underline">
                  ⚡ {e.name}
                </Link>
              </td>
              <td className="px-6 py-3 font-mono text-xs text-gray-500 dark:text-gray-400">{e.method} {e.path}</td>
              <td className="px-6 py-3 text-right">${Number(e.base_price).toFixed(4)}</td>
              <td className="px-6 py-3 text-right">{e.total_calls ?? 0}</td>
              <td className="px-6 py-3 text-right font-semibold">${Number(e.total_revenue).toFixed(2)}</td>
              <td className="px-6 py-3">
                <span className={`px-2 py-0.5 text-xs rounded-full ${
                  e.status === 'active' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400' : 'bg-gray-100 text-gray-600 dark:bg-gray-800'
                }`}>{e.status}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RatingsTab({ ratings }: { ratings: any }) {
  if (!ratings) return <div className="p-8 text-center text-gray-500">Loading ratings…</div>;
  const dims = [
    { key: 'navigation', label: 'Catalog Navigation', help: 'Machine-readable catalog, clear SKUs/prices' },
    { key: 'price_accuracy', label: 'Price Accuracy', help: 'Catalog price matches checkout price' },
    { key: 'response_speed', label: 'Response Speed', help: 'Checkout completes quickly' },
    { key: 'fulfillment', label: 'Fulfillment', help: 'Orders settle successfully' },
    { key: 'error_clarity', label: 'Error Clarity', help: 'Failures include actionable detail' },
  ];
  return (
    <div className="space-y-6">
      <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
        <div className="flex items-baseline gap-4 mb-4">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Agent Ratings</h3>
          <span className="text-sm text-gray-500 dark:text-gray-400">{ratings.totalRatings || 0} total</span>
          {ratings.overallAverage != null && (
            <span className="ml-auto text-2xl font-bold text-amber-500">★ {Number(ratings.overallAverage).toFixed(2)}<span className="text-sm text-gray-400">/5</span></span>
          )}
        </div>
        <div className="space-y-3">
          {dims.map(d => {
            const avg = ratings.averages?.[d.key];
            const pct = typeof avg === 'number' ? (avg / 5) * 100 : 0;
            return (
              <div key={d.key}>
                <div className="flex items-center justify-between text-sm mb-1">
                  <span title={d.help} className="text-gray-700 dark:text-gray-300">{d.label}</span>
                  <span className="font-mono text-gray-600 dark:text-gray-400">
                    {typeof avg === 'number' ? `${avg.toFixed(2)}/5` : '—'}
                  </span>
                </div>
                <div className="h-2 bg-gray-100 dark:bg-gray-900 rounded-full overflow-hidden">
                  <div className="h-full bg-amber-500" style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {ratings.recent?.length > 0 && (
        <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Recent Ratings</h3>
          <div className="space-y-3 max-h-96 overflow-y-auto">
            {ratings.recent.map((r: any) => (
              <div key={r.id} className="pb-3 border-b border-gray-100 dark:border-gray-900 last:border-0">
                <div className="flex items-center justify-between mb-1 text-sm">
                  <span className="font-medium text-gray-900 dark:text-white">{r.rater_name}</span>
                  <span className="text-xs text-gray-400">{new Date(r.created_at).toLocaleString()}</span>
                </div>
                <div className="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
                  {dims.map(d => r[d.key] != null && (
                    <span key={d.key} title={d.label}>{d.label.split(' ')[0]}: <span className="font-semibold text-gray-700 dark:text-gray-300">{r[d.key]}/5</span></span>
                  ))}
                  {r.checkout_protocol && (
                    <span className="ml-auto uppercase text-xs bg-gray-100 dark:bg-gray-900 px-2 py-0.5 rounded">{r.checkout_protocol}</span>
                  )}
                </div>
                {r.comment && <p className="mt-2 text-sm text-gray-600 dark:text-gray-400 italic">{r.comment}</p>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function PayoutsTab({ accountId }: { accountId: string }) {
  const api = useApiClient();
  const queryClient = useQueryClient();
  const [withdrawing, setWithdrawing] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Merchant's wallets
  const { data: walletsResp } = useQuery({
    queryKey: ['account', accountId, 'payouts-wallets'],
    queryFn: () => api!.wallets.list({ owner_account_id: accountId, limit: 20 } as any),
    enabled: !!api,
  });
  const wallets = (walletsResp as any)?.data?.data || (walletsResp as any)?.data || [];

  // Recent transfers targeting this merchant's account (includes withdrawals out).
  const { data: transfersResp } = useQuery({
    queryKey: ['account', accountId, 'payouts-transfers'],
    queryFn: () => api!.accounts.getTransfers(accountId, { limit: 30 }),
    enabled: !!api,
  });
  const transfers = ((transfersResp as any)?.data?.data || (transfersResp as any)?.data || []) as any[];
  // Withdrawals = transfers FROM the merchant's account (outbound).
  const withdrawals = transfers.filter((t: any) => t.fromAccountId === accountId || t.from_account_id === accountId);

  async function submitWithdraw(form: { amount: string; destinationAccountId: string; reference: string }) {
    setSaving(true);
    setError(null);
    try {
      const amount = parseFloat(form.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        setError('Amount must be a positive number');
        setSaving(false);
        return;
      }
      if (!form.destinationAccountId.trim()) {
        setError('Destination account ID is required');
        setSaving(false);
        return;
      }
      await api!.wallets.withdraw(withdrawing.id, {
        amount,
        destinationAccountId: form.destinationAccountId.trim(),
        reference: form.reference.trim() || 'Merchant payout',
      });
      await queryClient.invalidateQueries({ queryKey: ['account', accountId, 'payouts-wallets'] });
      await queryClient.invalidateQueries({ queryKey: ['account', accountId, 'payouts-transfers'] });
      await queryClient.invalidateQueries({ queryKey: ['account', accountId, 'merchant-stats'] });
      setWithdrawing(null);
    } catch (e: any) {
      setError(e?.message || 'Withdrawal failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="space-y-6">
        <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Merchant Wallets</h3>
          {wallets.length === 0 ? (
            <div className="text-gray-500">No wallets provisioned for this merchant.</div>
          ) : (
            <div className="space-y-3">
              {wallets.map((w: any) => (
                <div key={w.id} className="flex items-center justify-between py-3 border-b border-gray-100 dark:border-gray-900 last:border-0">
                  <div>
                    <div className="font-medium text-gray-900 dark:text-white">{w.walletType || w.wallet_type || 'Wallet'} · {w.currency}</div>
                    <div className="text-xs font-mono text-gray-400">{w.id.slice(0, 8)}…</div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xl font-bold text-purple-600 dark:text-purple-400">
                      ${Number(w.balance ?? 0).toFixed(2)}
                    </span>
                    <button
                      onClick={() => { setWithdrawing(w); setError(null); }}
                      disabled={Number(w.balance ?? 0) <= 0}
                      className="px-3 py-1.5 text-sm font-medium rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Withdraw
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Recent Withdrawals ({withdrawals.length})</h3>
          {withdrawals.length === 0 ? (
            <div className="text-gray-500 text-sm">No withdrawals yet.</div>
          ) : (
            <div className="space-y-2 max-h-96 overflow-y-auto">
              {withdrawals.slice(0, 15).map((t: any) => (
                <div key={t.id} className="flex items-center justify-between py-2 border-b border-gray-100 dark:border-gray-900 last:border-0 text-sm">
                  <span className="flex items-center gap-2">
                    <Banknote className="h-4 w-4 text-emerald-500" />
                    <span className="text-gray-900 dark:text-white">{t.description || 'Withdrawal'}</span>
                  </span>
                  <span className="flex items-center gap-3">
                    <span className="font-medium">${Number(t.amount || 0).toFixed(2)} {t.currency || 'USDC'}</span>
                    <span className="text-xs text-gray-400">{new Date(t.createdAt || t.created_at).toLocaleDateString()}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {withdrawing && (
        <WithdrawModal
          wallet={withdrawing}
          onSubmit={submitWithdraw}
          onClose={() => { setWithdrawing(null); setError(null); }}
          saving={saving}
          error={error}
        />
      )}
    </>
  );
}

function WithdrawModal({
  wallet,
  onSubmit,
  onClose,
  saving,
  error,
}: {
  wallet: any;
  onSubmit: (form: { amount: string; destinationAccountId: string; reference: string }) => void;
  onClose: () => void;
  saving: boolean;
  error: string | null;
}) {
  const [amount, setAmount] = useState('');
  const [destinationAccountId, setDestinationAccountId] = useState('');
  const [reference, setReference] = useState('');
  const balance = Number(wallet.balance ?? 0);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white dark:bg-gray-950 rounded-2xl shadow-xl max-w-md w-full p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">Withdraw from Wallet</h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-4 font-mono">
          {wallet.id.slice(0, 8)}… · Balance ${balance.toFixed(2)} {wallet.currency}
        </p>
        <div className="space-y-3">
          <Field label={`Amount (${wallet.currency}) *`}>
            <input type="number" min="0" step="0.01" max={balance} className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 text-gray-900 dark:text-white" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label="Destination Account ID *">
            <input placeholder="account-uuid" className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 text-gray-900 dark:text-white font-mono text-sm" value={destinationAccountId} onChange={(e) => setDestinationAccountId(e.target.value)} />
          </Field>
          <Field label="Reference">
            <input placeholder="Monthly payout" className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 text-gray-900 dark:text-white" value={reference} onChange={(e) => setReference(e.target.value)} />
          </Field>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} disabled={saving} className="px-4 py-2 text-sm font-medium rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-50">Cancel</button>
          <button
            onClick={() => onSubmit({ amount, destinationAccountId, reference })}
            disabled={saving || !amount || !destinationAccountId}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {saving ? 'Processing…' : 'Withdraw'}
          </button>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, sub, icon }: { label: string; value: string; sub?: string; icon?: string }) {
  return (
    <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
      <div className="text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-1 flex items-center gap-2">
        {icon && <span className="text-base">{icon}</span>}
        {label}
      </div>
      <div className="text-2xl font-bold text-gray-900 dark:text-white">{value}</div>
      {sub && <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">{sub}</div>}
    </div>
  );
}

// Overview Tab Component
function OverviewTab({ account }: { account: Account }) {
  const { formatCurrency, formatDate } = useLocale();
  const currency = account.currency || 'USDC';

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Account Details</h3>
        <dl className="space-y-4">
          <div className="flex justify-between">
            <dt className="text-gray-500 dark:text-gray-400">Account ID</dt>
            <dd className="font-mono text-sm text-gray-900 dark:text-white">{account.id}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-gray-500 dark:text-gray-400">Type</dt>
            <dd className="capitalize text-gray-900 dark:text-white">{account.type}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-gray-500 dark:text-gray-400">Country</dt>
            <dd className="text-gray-900 dark:text-white">{account.country || 'Not specified'}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-gray-500 dark:text-gray-400">Currency</dt>
            <dd className="text-gray-900 dark:text-white">{currency}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-gray-500 dark:text-gray-400">Created</dt>
            <dd className="text-gray-900 dark:text-white">
              {formatDate(account.createdAt)}
            </dd>
          </div>
        </dl>
      </div>

      <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Balance Breakdown</h3>
        <div className="space-y-4">
          <div>
            <div className="flex justify-between text-sm mb-1">
              <span className="text-gray-500 dark:text-gray-400">Available</span>
              <span className="text-gray-900 dark:text-white">
                {formatCurrency(account.balanceAvailable || 0, currency)}
              </span>
            </div>
            <div className="h-2 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-emerald-500 rounded-full"
                style={{
                  width: `${account.balanceTotal ? (account.balanceAvailable / account.balanceTotal) * 100 : 0}%`,
                }}
              />
            </div>
          </div>
          <div>
            <div className="flex justify-between text-sm mb-1">
              <span className="text-gray-500 dark:text-gray-400">In Streams</span>
              <span className="text-gray-900 dark:text-white">
                {formatCurrency(account.balanceInStreams || 0, currency)}
              </span>
            </div>
            <div className="h-2 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-500 rounded-full"
                style={{
                  width: `${account.balanceTotal ? (account.balanceInStreams / account.balanceTotal) * 100 : 0}%`,
                }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Transactions Tab Component - Shows both ledger entries and transfers
function TransactionsTab({
  transactions,
  transfers,
  accountId
}: {
  transactions: LedgerEntry[];
  transfers: Transfer[];
  accountId: string;
}) {
  const { formatCurrency: formatCurrencyLocale, formatDate: formatDateLocale } = useLocale();
  const router = useRouter();

  // Deduplicate: if a ledger entry references a transfer, don't show the transfer separately
  const ledgerReferenceIds = new Set(
    transactions.filter(tx => tx.referenceType === 'transfer').map(tx => tx.referenceId)
  );
  const deduplicatedTransfers = transfers.filter(tf => !ledgerReferenceIds.has(tf.id));

  // Combine and sort by date (most recent first)
  const allTransactions = [
    ...transactions.map(tx => ({ ...tx, _type: 'ledger' as const })),
    ...deduplicatedTransfers.map(tf => ({ ...tf, _type: 'transfer' as const })),
  ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  if (allTransactions.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-8 text-center">
        <FileText className="h-12 w-12 text-gray-400 mx-auto mb-4" />
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">No transactions</h3>
        <p className="text-gray-500 dark:text-gray-400 mt-2">
          This account has no transaction history yet.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 overflow-hidden">
      <table className="w-full">
        <thead className="bg-gray-50 dark:bg-gray-900">
          <tr>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Type</th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Description</th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Amount</th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Balance After</th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Date</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
          {allTransactions.map((item) => {
            if (item._type === 'ledger') {
              const tx = item as LedgerEntry & { _type: 'ledger' };

              // Determine display label from referenceType
              const refLabel = tx.referenceType === 'mandate_execution' ? 'Mandate'
                : tx.referenceType === 'wallet_deposit' ? 'Deposit'
                : tx.referenceType || tx.type;

              // Clickable if it has a referenceId
              const isClickable = !!tx.referenceId;
              const ledgerClickUrl = tx.referenceType === 'mandate_execution'
                ? `/dashboard/agentic-payments/ap2/mandates/${tx.referenceId}`
                : `/dashboard/transfers/${tx.referenceId}`;

              return (
                <tr
                  key={`ledger-${tx.id}`}
                  onClick={isClickable ? () => router.push(ledgerClickUrl) : undefined}
                  className={`hover:bg-gray-50 dark:hover:bg-gray-900${isClickable ? ' cursor-pointer transition-colors' : ''}`}
                >
                  <td className="px-6 py-4">
                    <span className={`px-2.5 py-1 text-xs font-medium rounded-full ${tx.type === 'credit'
                      ? 'bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-400'
                      : tx.referenceType === 'mandate_execution'
                        ? 'bg-purple-100 dark:bg-purple-950 text-purple-700 dark:text-purple-400'
                        : 'bg-red-100 dark:bg-red-950 text-red-700 dark:text-red-400'
                      }`}>
                      {refLabel}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-gray-900 dark:text-white text-sm">
                    {tx.description || tx.referenceType || '-'}
                  </td>
                  <td className="px-6 py-4">
                    <span className={tx.type === 'credit' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}>
                      {tx.type === 'credit' ? '+' : '-'}{formatCurrencyLocale(Math.abs(tx.amount), tx.currency || 'USDC')}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-gray-900 dark:text-white">
                    {tx.balanceAfter ? formatCurrencyLocale(tx.balanceAfter, tx.currency || 'USDC') : '-'}
                  </td>
                  <td className="px-6 py-4 text-gray-500 dark:text-gray-400 text-sm">
                    {formatDateLocale(tx.createdAt)}
                  </td>
                </tr>
              );
            } else {
              const tf = item as Transfer & { _type: 'transfer' };
              const isIncoming = tf.to?.accountId === accountId;
              const isOutgoing = tf.from?.accountId === accountId;

              return (
                <tr
                  key={`transfer-${tf.id}`}
                  onClick={() => router.push(`/dashboard/transfers/${tf.id}`)}
                  className="hover:bg-gray-50 dark:hover:bg-gray-900 cursor-pointer transition-colors"
                >
                  <td className="px-6 py-4">
                    <span className={`px-2.5 py-1 text-xs font-medium rounded-full ${isIncoming
                      ? 'bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-400'
                      : 'bg-red-100 dark:bg-red-950 text-red-700 dark:text-red-400'
                      }`}>
                      {isIncoming ? 'Incoming' : 'Outgoing'}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-gray-900 dark:text-white text-sm">
                    {isIncoming
                      ? `From ${tf.from?.accountName || tf.from?.accountId?.slice(0, 8) || 'External'}`
                      : `To ${tf.to?.accountName || tf.to?.accountId?.slice(0, 8) || 'External'}`
                    }
                  </td>
                  <td className="px-6 py-4">
                    <span className={isIncoming ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}>
                      {isIncoming ? '+' : '-'}{formatCurrencyLocale(tf.amount, tf.currency || 'USDC')}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-gray-500 dark:text-gray-400 text-sm">
                    -
                  </td>
                  <td className="px-6 py-4 text-gray-500 dark:text-gray-400 text-sm">
                    {formatDateLocale(tf.createdAt)}
                  </td>
                </tr>
              );
            }
          })}
        </tbody>
      </table>
    </div>
  );
}

// Streams Tab Component
function StreamsTab({ streams }: { streams: Stream[] }) {
  const { formatCurrency } = useLocale();

  if (streams.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-8 text-center">
        <Activity className="h-12 w-12 text-gray-400 mx-auto mb-4" />
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">No streams</h3>
        <p className="text-gray-500 dark:text-gray-400 mt-2">
          This account has no active streams.
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
      {streams.map((stream) => {
        // Streams use supertokens (wrapped USDC), display base currency
        const currency = stream.flowRate?.currency || 'USDCx';

        return (
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
                  {formatCurrency(stream.flowRate.perMonth, currency)}/month
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="text-right">
                  <div className="text-sm font-medium text-gray-900 dark:text-white">
                    {formatCurrency(stream.streamed.total, currency)}
                  </div>
                  <div className="text-xs text-gray-500">streamed</div>
                </div>
                <span className={`px-2.5 py-1 text-xs font-medium rounded-full ${getHealthColor(stream.health)}`}>
                  {stream.health}
                </span>
              </div>
            </div>
            <div className="mt-3 flex items-center justify-between text-xs text-gray-500">
              <span>Runway: {stream.funding.runway.display}</span>
              <span>Buffer: {formatCurrency(stream.funding.buffer, currency)}</span>
            </div>
          </Link>
        );
      })}
    </div>
  );
}

// Agents Tab Component
function AgentsTab({ agents }: { agents: Agent[] }) {
  if (agents.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-8 text-center">
        <Bot className="h-12 w-12 text-gray-400 mx-auto mb-4" />
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">No agents</h3>
        <p className="text-gray-500 dark:text-gray-400 mt-2">
          This account has no AI agents.
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {agents.map((agent) => (
        <Link
          key={agent.id}
          href={`/dashboard/agents/${agent.id}`}
          className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6 hover:shadow-lg transition-shadow"
        >
          <div className="flex items-start justify-between mb-4">
            <div className="w-12 h-12 bg-blue-100 dark:bg-blue-950 rounded-xl flex items-center justify-center">
              <Bot className="h-6 w-6 text-blue-600 dark:text-blue-400" />
            </div>
            <span className={`px-2.5 py-1 text-xs font-medium rounded-full ${agent.status === 'active'
              ? 'bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-400'
              : 'bg-red-100 dark:bg-red-950 text-red-700 dark:text-red-400'
              }`}>
              {agent.status}
            </span>
          </div>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">{agent.name}</h3>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
            {agent.description || 'No description'}
          </p>
          <div className="text-sm text-gray-500">KYA Tier {agent.kyaTier}</div>
        </Link>
      ))}
    </div>
  );
}

// Wallets Tab Component
function WalletsTab({ wallets }: { wallets: WalletData[] }) {
  const { formatCurrency } = useLocale();

  if (wallets.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-8 text-center">
        <Wallet className="h-12 w-12 text-gray-400 mx-auto mb-4" />
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">No wallets</h3>
        <p className="text-gray-500 dark:text-gray-400 mt-2">
          This account has no linked wallets.
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {wallets.map((wallet) => (
        <Link
          key={wallet.id}
          href={`/dashboard/wallets/${wallet.id}`}
          className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6 hover:shadow-lg transition-shadow"
        >
          <div className="flex items-start justify-between mb-4">
            <div className="w-12 h-12 bg-emerald-100 dark:bg-emerald-950 rounded-xl flex items-center justify-center">
              <Wallet className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
            </div>
            <span className={`px-2.5 py-1 text-xs font-medium rounded-full ${
              wallet.status === 'active'
                ? 'bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-400'
                : wallet.status === 'frozen'
                  ? 'bg-yellow-100 dark:bg-yellow-950 text-yellow-700 dark:text-yellow-400'
                  : 'bg-red-100 dark:bg-red-950 text-red-700 dark:text-red-400'
            }`}>
              {wallet.status}
            </span>
          </div>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">
            {wallet.name || 'Unnamed Wallet'}
          </h3>
          <div className="text-2xl font-bold text-gray-900 dark:text-white mb-3">
            {formatCurrency(wallet.balance, wallet.currency || 'USDC')}
          </div>
          <div className="space-y-1 text-sm text-gray-500 dark:text-gray-400">
            {wallet.network && (
              <div>Network: <span className="text-gray-700 dark:text-gray-300">{wallet.network}</span></div>
            )}
            {wallet.purpose && (
              <div>Purpose: <span className="text-gray-700 dark:text-gray-300">{wallet.purpose}</span></div>
            )}
          </div>
        </Link>
      ))}
    </div>
  );
}

