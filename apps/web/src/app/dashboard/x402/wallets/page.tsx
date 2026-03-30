'use client';

import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useApiClient, useApiConfig } from '@/lib/api-client';
import { Wallet as WalletIcon, Plus, Search, Filter, TrendingUp, ArrowUp, ArrowDown, MoreVertical, X } from 'lucide-react';
import Link from 'next/link';
import type { Wallet } from '@sly/api-client';
import { CardListSkeleton } from '@/components/ui/skeletons';
import { usePagination } from '@/hooks/usePagination';
import { PaginationControls } from '@/components/ui/pagination-controls';

export default function WalletsPage() {
  const api = useApiClient();
  const { isConfigured, isLoading: isAuthLoading, authToken, apiUrl } = useApiConfig();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [createMode, setCreateMode] = useState<'select' | 'create' | 'external'>('select');
  const [formData, setFormData] = useState({
    name: '',
    purpose: '',
    currency: 'USDC' as 'USDC' | 'EURC',
    initialBalance: '0',
    accountId: '',
    walletType: 'internal' as 'internal' | 'circle_custodial',
    blockchain: 'base' as 'base' | 'eth' | 'polygon',
    // For external wallets
    walletAddress: ''
  });

  // Fetch account ID for form
  useEffect(() => {
    async function fetchAccountId() {
      if (!api) return;
      try {
        const accountsResponse = await api.accounts.list({ limit: 1 });
        if (accountsResponse.data && accountsResponse.data.length > 0) {
          setFormData(prev => ({ ...prev, accountId: accountsResponse.data[0].id }));
        }
      } catch (error) {
        console.error('Failed to fetch account:', error);
      }
    }
    fetchAccountId();
  }, [api]);

  // Fetch total count
  const { data: countData } = useQuery({
    queryKey: ['wallets', 'count'],
    queryFn: async () => {
      if (!api) throw new Error('API client not initialized');
      return api.wallets.list({ limit: 1 });
    },
    enabled: !!api && isConfigured,
    staleTime: 60 * 1000,
  });

  // Initialize pagination
  const pagination = usePagination({
    totalItems: (countData as any)?.data?.pagination?.total || (countData as any)?.pagination?.total || 0,
    initialPageSize: 50,
  });

  // Fetch wallets for current page
  const { data: walletsData, isLoading: loading } = useQuery({
    queryKey: ['wallets', 'page', pagination.page, pagination.pageSize],
    queryFn: async () => {
      if (!api) throw new Error('API client not initialized');
      return api.wallets.list({
        page: pagination.page,
        limit: pagination.pageSize,
      });
    },
    enabled: !!api && isConfigured,
    staleTime: 30 * 1000,
  });

  const rawData = (walletsData as any)?.data;
  const wallets = Array.isArray(rawData)
    ? rawData
    : (Array.isArray((rawData as any)?.data)
      ? (rawData as any).data
      : []);

  const handleCreateWallet = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!api) return;

    setCreating(true);
    setError(null);

    try {
      let newWallet;

      if (createMode === 'external') {
        // Add existing external wallet
        const response = await fetch(`${apiUrl}/v1/wallets/external`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authToken}`
          },
          body: JSON.stringify({
            ownerAccountId: formData.accountId,
            name: formData.name,
            purpose: formData.purpose,
            currency: formData.currency,
            walletAddress: formData.walletAddress,
            blockchain: formData.blockchain
          })
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || 'Failed to add external wallet');
        }

        const result = await response.json();
        newWallet = result.data;
      } else {
        // Create new wallet (internal or Circle)
        newWallet = await api.wallets.create({
          ownerAccountId: formData.accountId,
          name: formData.name,
          purpose: formData.purpose,
          currency: formData.currency
        });

        // If initial balance > 0, deposit
        if (parseFloat(formData.initialBalance) > 0) {
          await api.wallets.deposit(newWallet.id, {
            amount: parseFloat(formData.initialBalance)
          });
          newWallet.balance = parseFloat(formData.initialBalance);
        }
      }

      // Invalidate queries to refresh data
      queryClient.invalidateQueries({ queryKey: ['wallets'] });

      // Reset form and close modal
      setFormData(prev => ({
        name: '',
        purpose: '',
        currency: 'USDC',
        initialBalance: '0',
        accountId: prev.accountId,
        walletType: 'internal',
        blockchain: 'base',
        walletAddress: ''
      }));
      setCreateMode('select');
      setShowCreateModal(false);
    } catch (err: any) {
      setError(err.message || 'Failed to create wallet');
    } finally {
      setCreating(false);
    }
  };

  const resetModal = () => {
    setShowCreateModal(false);
    setCreateMode('select');
    setError(null);
  };

  const filteredWallets = wallets.filter((wallet: any) =>
    (wallet.name?.toLowerCase() || '').includes(search.toLowerCase()) ||
    (wallet.purpose?.toLowerCase() || '').includes(search.toLowerCase())
  );

  // Calculate totals
  const totalBalance = wallets.reduce((sum: number, w: any) => sum + w.balance, 0);
  const activeWallets = wallets.filter((w: any) => w.status === 'active').length;

  if (isAuthLoading) {
    return (
      <div className="p-8 max-w-[1600px] mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">Wallets</h1>
            <p className="text-gray-600 dark:text-gray-400">Manage stablecoin wallets for x402 payments</p>
          </div>
        </div>
        <CardListSkeleton count={6} />
      </div>
    );
  }

  if (!isConfigured) {
    return (
      <div className="p-8">
        <div className="text-center py-12">
          <WalletIcon className="h-12 w-12 text-gray-400 mx-auto mb-4" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Configure API Key</h2>
          <p className="text-gray-500 dark:text-gray-400 mt-2">
            Please configure your API key to manage wallets.
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
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">Wallets</h1>
          <p className="text-gray-600 dark:text-gray-400">Manage stablecoin wallets for x402 payments</p>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
        >
          <Plus className="h-4 w-4" />
          Create Wallet
        </button>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-600 dark:text-gray-400">Total Wallets</span>
            <WalletIcon className="h-4 w-4 text-blue-600 dark:text-blue-400" />
          </div>
          <div className="text-3xl font-bold text-gray-900 dark:text-white">{wallets.length}</div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">{activeWallets} active</div>
        </div>

        <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-600 dark:text-gray-400">Total Balance</span>
            <TrendingUp className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
          </div>
          <div className="text-3xl font-bold text-gray-900 dark:text-white">
            ${totalBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">Across all wallets</div>
        </div>

        <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-600 dark:text-gray-400">Agent-Managed</span>
            <WalletIcon className="h-4 w-4 text-purple-600 dark:text-purple-400" />
          </div>
          <div className="text-3xl font-bold text-gray-900 dark:text-white">
            {wallets.filter((w: any) => w.managedByAgentId).length}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">With spending policies</div>
        </div>
      </div>

      {/* Search and Filters */}
      <div className="flex items-center gap-4 mb-6">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search wallets..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 text-sm bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <button className="flex items-center gap-2 px-4 py-2 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 text-gray-700 dark:text-gray-300 text-sm font-medium rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
          <Filter className="h-4 w-4" />
          Filter
        </button>
      </div>

      {/* Wallets Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {loading ? (
          <div className="col-span-full">
            <CardListSkeleton count={6} />
          </div>
        ) : filteredWallets.length === 0 ? (
          <div className="col-span-full">
            {search ? (
              <div className="p-12 text-center bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800">
                <div className="text-5xl mb-4">🔍</div>
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white">No results found</h3>
                <p className="text-gray-500 dark:text-gray-400 mt-2">Try a different search term</p>
              </div>
            ) : (
              <div className="col-span-full p-12 text-center bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800">
                <div className="text-5xl mb-4">💳</div>
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white">No wallets yet</h3>
                <p className="text-gray-500 dark:text-gray-400 mt-2 mb-4">
                  Create your first wallet to start making x402 payments
                </p>
                <button
                  onClick={() => setShowCreateModal(true)}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700"
                >
                  <Plus className="h-4 w-4" />
                  Create Wallet
                </button>
              </div>
            )}
          </div>
        ) : (
          filteredWallets.map((wallet: any) => (
            <div
              key={wallet.id}
              className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6 hover:shadow-lg transition-shadow"
            >
              <div className="flex items-start justify-between mb-4">
                <div className="w-12 h-12 bg-gradient-to-br from-blue-600 to-purple-600 rounded-xl flex items-center justify-center">
                  <WalletIcon className="h-6 w-6 text-white" />
                </div>
                <div className="flex items-center gap-2">
                  <span className={`px-2.5 py-1 text-xs font-medium rounded-full ${wallet.status === 'active'
                    ? 'bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-400'
                    : wallet.status === 'frozen'
                      ? 'bg-blue-100 dark:bg-blue-950 text-blue-700 dark:text-blue-400'
                      : 'bg-red-100 dark:bg-red-950 text-red-700 dark:text-red-400'
                    }`}>
                    {wallet.status}
                  </span>
                  <button className="p-1 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors">
                    <MoreVertical className="h-4 w-4 text-gray-400" />
                  </button>
                </div>
              </div>

              <Link href={`/dashboard/wallets/${wallet.id}`} className="block">
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-1 hover:text-blue-600 dark:hover:text-blue-400 transition-colors">
                  {wallet.name || 'Unnamed Wallet'}
                </h3>
              </Link>
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
                {wallet.purpose || 'No description'}
              </p>

              <div className="mb-4 p-4 bg-gray-50 dark:bg-gray-900 rounded-lg">
                <div className="text-sm text-gray-600 dark:text-gray-400 mb-1">Balance</div>
                <div className="text-2xl font-bold text-gray-900 dark:text-white">
                  ${wallet.balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">{wallet.currency}</div>
              </div>

              {wallet.spendingPolicy && (
                <div className="mb-4 text-xs text-gray-600 dark:text-gray-400">
                  <div className="flex items-center gap-2">
                    <span>Policy:</span>
                    {wallet.spendingPolicy.dailyLimit && (
                      <span className="px-2 py-0.5 bg-blue-100 dark:bg-blue-950 text-blue-700 dark:text-blue-400 rounded">
                        ${wallet.spendingPolicy.dailyLimit}/day
                      </span>
                    )}
                  </div>
                </div>
              )}

              <div className="flex gap-2">
                <button className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 transition-colors">
                  <ArrowDown className="h-4 w-4" />
                  Deposit
                </button>
                <button className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors">
                  <ArrowUp className="h-4 w-4" />
                  Withdraw
                </button>
              </div>
            </div>
          ))
        )}

        {/* Pagination Controls */}
        {!loading && filteredWallets.length > 0 && (
          <PaginationControls
            pagination={pagination}
            className="mt-6"
          />
        )}
      </div>

      {/* Create Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => !creating && resetModal()}>
          <div className="bg-white dark:bg-gray-900 rounded-2xl p-6 max-w-lg w-full" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
                {createMode === 'select' ? 'Add Wallet' : createMode === 'create' ? 'Create New Wallet' : 'Link External Wallet'}
              </h2>
              <button
                onClick={() => !creating && resetModal()}
                className="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                disabled={creating}
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Step 1: Select Mode */}
            {createMode === 'select' && (
              <div className="space-y-4">
                <p className="text-gray-600 dark:text-gray-400 text-sm mb-6">
                  How would you like to add a wallet?
                </p>

                <button
                  onClick={() => setCreateMode('create')}
                  className="w-full p-4 border-2 border-gray-200 dark:border-gray-700 rounded-xl hover:border-blue-500 dark:hover:border-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-all text-left group"
                >
                  <div className="flex items-start gap-4">
                    <div className="w-12 h-12 bg-gradient-to-br from-blue-500 to-purple-600 rounded-xl flex items-center justify-center">
                      <Plus className="h-6 w-6 text-white" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-gray-900 dark:text-white group-hover:text-blue-600 dark:group-hover:text-blue-400">
                        Create New Wallet
                      </h3>
                      <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                        Create a new custodial wallet managed by Sly
                      </p>
                    </div>
                  </div>
                </button>

                <button
                  onClick={() => setCreateMode('external')}
                  className="w-full p-4 border-2 border-gray-200 dark:border-gray-700 rounded-xl hover:border-emerald-500 dark:hover:border-emerald-500 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition-all text-left group"
                >
                  <div className="flex items-start gap-4">
                    <div className="w-12 h-12 bg-gradient-to-br from-emerald-500 to-teal-600 rounded-xl flex items-center justify-center">
                      <ArrowDown className="h-6 w-6 text-white" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-gray-900 dark:text-white group-hover:text-emerald-600 dark:group-hover:text-emerald-400">
                        Link Existing Wallet
                      </h3>
                      <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                        Connect a wallet you already own (MetaMask, etc.)
                      </p>
                    </div>
                  </div>
                </button>

                <div className="p-4 bg-gray-50 dark:bg-gray-800 rounded-xl mt-4 opacity-60">
                  <div className="flex items-start gap-4">
                    <div className="w-12 h-12 bg-gradient-to-br from-gray-400 to-gray-500 rounded-xl flex items-center justify-center">
                      <WalletIcon className="h-6 w-6 text-white" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-gray-600 dark:text-gray-400">
                        Circle Wallet (Coming Soon)
                      </h3>
                      <p className="text-sm text-gray-500 dark:text-gray-500 mt-1">
                        Create a Circle Programmable Wallet with MPC security
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Step 2: Create New Wallet Form */}
            {createMode === 'create' && (
              <form onSubmit={handleCreateWallet} className="space-y-4">
                {error && (
                  <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-red-600 dark:text-red-400 text-sm">
                    {error}
                  </div>
                )}

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    Wallet Name *
                  </label>
                  <input
                    type="text"
                    required
                    value={formData.name}
                    onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                    placeholder="e.g., Trading Bot Wallet"
                    className="w-full px-4 py-2 text-sm bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    Purpose
                  </label>
                  <input
                    type="text"
                    value={formData.purpose}
                    onChange={(e) => setFormData(prev => ({ ...prev, purpose: e.target.value }))}
                    placeholder="e.g., x402 autonomous payments"
                    className="w-full px-4 py-2 text-sm bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      Currency *
                    </label>
                    <select
                      required
                      value={formData.currency}
                      onChange={(e) => setFormData(prev => ({ ...prev, currency: e.target.value as any }))}
                      className="w-full px-4 py-2 text-sm bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="USDC">USDC</option>
                      <option value="EURC">EURC</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      Initial Balance
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={formData.initialBalance}
                      onChange={(e) => setFormData(prev => ({ ...prev, initialBalance: e.target.value }))}
                      className="w-full px-4 py-2 text-sm bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>

                <div className="flex gap-3 pt-4">
                  <button
                    type="button"
                    onClick={() => setCreateMode('select')}
                    disabled={creating}
                    className="flex-1 px-4 py-2 bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-white text-sm font-medium rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
                  >
                    Back
                  </button>
                  <button
                    type="submit"
                    disabled={creating || !formData.accountId}
                    className="flex-1 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {creating ? 'Creating...' : 'Create Wallet'}
                  </button>
                </div>
              </form>
            )}

            {/* Step 2: Link External Wallet Form */}
            {createMode === 'external' && (
              <form onSubmit={handleCreateWallet} className="space-y-4">
                {error && (
                  <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-red-600 dark:text-red-400 text-sm">
                    {error}
                  </div>
                )}

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    Wallet Address *
                  </label>
                  <input
                    type="text"
                    required
                    value={formData.walletAddress}
                    onChange={(e) => setFormData(prev => ({ ...prev, walletAddress: e.target.value }))}
                    placeholder="0x... or Solana address"
                    className="w-full px-4 py-2 text-sm font-mono bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      Blockchain *
                    </label>
                    <select
                      required
                      value={formData.blockchain}
                      onChange={(e) => setFormData(prev => ({ ...prev, blockchain: e.target.value as any }))}
                      className="w-full px-4 py-2 text-sm bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    >
                      <option value="base">Base</option>
                      <option value="eth">Ethereum</option>
                      <option value="polygon">Polygon</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      Currency *
                    </label>
                    <select
                      required
                      value={formData.currency}
                      onChange={(e) => setFormData(prev => ({ ...prev, currency: e.target.value as any }))}
                      className="w-full px-4 py-2 text-sm bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    >
                      <option value="USDC">USDC</option>
                      <option value="EURC">EURC</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    Wallet Name
                  </label>
                  <input
                    type="text"
                    value={formData.name}
                    onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                    placeholder="e.g., My MetaMask Wallet"
                    className="w-full px-4 py-2 text-sm bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>

                <div className="p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
                  <p className="text-amber-700 dark:text-amber-400 text-sm">
                    <strong>Note:</strong> After linking, you&apos;ll need to verify ownership by signing a message with your wallet.
                  </p>
                </div>

                <div className="flex gap-3 pt-4">
                  <button
                    type="button"
                    onClick={() => setCreateMode('select')}
                    disabled={creating}
                    className="flex-1 px-4 py-2 bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-white text-sm font-medium rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
                  >
                    Back
                  </button>
                  <button
                    type="submit"
                    disabled={creating || !formData.accountId || !formData.walletAddress}
                    className="flex-1 px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {creating ? 'Linking...' : 'Link Wallet'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

