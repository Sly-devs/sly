'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useAccount, useSignMessage } from 'wagmi';

import { useApiClient, useApiConfig } from '@/lib/api-client';
import {
  Wallet as WalletIcon, Plus, Search, Filter, TrendingUp, ArrowUp, ArrowDown,
  MoreVertical, X, Bot, AlertTriangle, Shield, Clock, CheckCircle, RefreshCw, Trash2
} from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';
import type { Wallet, SpendingPolicy } from '@sly/api-client';
import { CardListSkeleton } from '@/components/ui/skeletons';
import { usePagination } from '@/hooks/usePagination';
import { PaginationControls } from '@/components/ui/pagination-controls';
import { formatDistanceToNow } from 'date-fns';
import { SpendingProgressCompact } from '@/components/wallets/spending-progress';
import { cn } from '@/lib/utils';

// Helper to calculate spending progress and check near-limit status.
// Prefer live computed spend (dailyActualSpent / monthlyActualSpent from
// the wallet response) over the stale JSON counters so the status is
// accurate for every wallet type, not just Circle.
function getSpendingStatus(
  policy: SpendingPolicy | undefined,
  live?: { dailyActualSpent?: number; monthlyActualSpent?: number },
) {
  if (!policy) return { dailyPercent: null, monthlyPercent: null, isNearLimit: false, hasPolicies: false };

  const dailySpentLive = live?.dailyActualSpent ?? policy.dailySpent ?? 0;
  const monthlySpentLive = live?.monthlyActualSpent ?? policy.monthlySpent ?? 0;

  const dailyPercent = policy.dailySpendLimit
    ? Math.min((dailySpentLive / policy.dailySpendLimit) * 100, 100)
    : null;

  const monthlyPercent = policy.monthlySpendLimit
    ? Math.min((monthlySpentLive / policy.monthlySpendLimit) * 100, 100)
    : null;

  const isNearLimit = (dailyPercent !== null && dailyPercent >= 80) ||
                      (monthlyPercent !== null && monthlyPercent >= 80);

  const hasPolicies = !!(policy.dailySpendLimit || policy.monthlySpendLimit ||
                         policy.approvalThreshold || policy.requiresApprovalAbove);

  return { dailyPercent, monthlyPercent, isNearLimit, hasPolicies };
}

const useWalletBalance = (walletId: string | undefined, authToken: string | null, apiEnvironment?: string, apiUrl?: string) => {
  return useQuery({
    queryKey: ['wallet-balance', walletId, apiEnvironment],
    queryFn: async () => {
      if (!authToken) return null;
      const response = await fetch(
        `${apiUrl || ''}/v1/wallets/${walletId}/balance`,
        {
          headers: {
            'Authorization': `Bearer ${authToken}`,
          },
        }
      );
      if (!response.ok) return null;
      return response.json();
    },
    enabled: !!walletId && !!authToken,
    staleTime: 60 * 1000, // 1 minute
    refetchInterval: 60 * 1000, // Refresh every minute
  });
};

interface WalletBalanceCardProps {
  wallet: Wallet;
  authToken: string | null;
  apiEnvironment?: string;
  apiUrl?: string;
  onDelete?: (id: string) => void;
  isDeleting?: boolean;
}

function WalletBalanceCard({ wallet, authToken, apiEnvironment, apiUrl, onDelete, isDeleting }: WalletBalanceCardProps) {
  const { data: balanceData, isLoading: balanceLoading } = useWalletBalance(wallet.id, authToken, apiEnvironment, apiUrl);
  const onChain = balanceData?.data?.onChain;
  const syncStatus = balanceData?.data?.syncStatus || 'stale';
  const queryClient = useQueryClient();
  const [showSyncTooltip, setShowSyncTooltip] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Check if internal wallet
  const isInternalWallet = !wallet.walletAddress || wallet.walletAddress.startsWith('internal://');

  // Get sync status description for tooltip
  const getSyncStatusInfo = () => {
    if (isInternalWallet) {
      return {
        label: 'Internal',
        description: 'Internal wallet managed by Sly. No blockchain sync needed.',
        color: 'bg-emerald-500',
      };
    }
    switch (syncStatus) {
      case 'synced':
        return {
          label: 'Synced',
          description: 'Balance synced from blockchain within the last 5 minutes.',
          color: 'bg-emerald-500',
        };
      case 'pending':
        return {
          label: 'Pending',
          description: 'Balance was synced 5-60 minutes ago. Consider refreshing.',
          color: 'bg-yellow-500',
        };
      case 'stale':
      default:
        return {
          label: 'Stale',
          description: onChain?.lastSyncedAt
            ? 'Balance was synced over 60 minutes ago. Click sync to refresh.'
            : 'Balance has never been synced. Click sync to fetch on-chain balance.',
          color: 'bg-red-500',
        };
    }
  };

  const syncInfo = getSyncStatusInfo();

  // Wagmi hooks for BYOW verification
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [verifying, setVerifying] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const handleSync = async () => {
    if (!authToken || isInternalWallet) return;

    setSyncing(true);
    try {
      const response = await fetch(
        `${apiUrl || ''}/v1/wallets/${wallet.id}/sync`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${authToken}`,
          },
        }
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Sync failed (${response.status})`);
      }

      // Refresh both wallet list and balance data
      queryClient.invalidateQueries({ queryKey: ['wallets'] });
      queryClient.invalidateQueries({ queryKey: ['wallet-balance', wallet.id] });
      toast.success('Wallet balance synced');
    } catch (error: any) {
      console.error('Sync failed:', error);
      toast.error(error.message || 'Failed to sync wallet balance');
    } finally {
      setSyncing(false);
    }
  };

  const handleVerify = async () => {
    if (!wallet.walletAddress || !isConnected || !authToken) return;

    setVerifying(true);
    try {
      // Generate challenge message
      const message = `Verify ownership of wallet for Sly at ${new Date().toISOString()}`;

      // Sign with MetaMask
      const signature = await signMessageAsync({ message });

      // Submit to backend
      const response = await fetch(
        `${apiUrl || ''}/v1/wallets/${wallet.id}/verify`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${authToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ signature, message }),
        }
      );

      if (!response.ok) throw new Error('Verification failed');

      // Refresh wallet data
      queryClient.invalidateQueries({ queryKey: ['wallets'] });
    } catch (error) {
      console.error('Verification failed:', error);
      // In a real app we would show a toast here
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div
      className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6 hover:shadow-lg transition-shadow"
    >
      <div className="flex items-start justify-between mb-4">
        <div className="w-12 h-12 bg-gradient-to-br from-blue-600 to-purple-600 rounded-xl flex items-center justify-center">
          <WalletIcon className="h-6 w-6 text-white" />
        </div>
        <div className="flex items-center gap-2">
          {/* Sync indicator with tooltip */}
          <div
            className="relative"
            onMouseEnter={() => setShowSyncTooltip(true)}
            onMouseLeave={() => setShowSyncTooltip(false)}
          >
            <div className="flex items-center gap-1.5 mr-2 px-2 py-1 bg-gray-50 dark:bg-gray-900 rounded-full border border-gray-100 dark:border-gray-800 cursor-help">
              <span className={`w-2 h-2 rounded-full ${syncInfo.color}`} />
              <span className="text-[10px] uppercase font-bold text-gray-500 tracking-wider">
                {syncInfo.label}
              </span>
            </div>

            {/* Tooltip */}
            {showSyncTooltip && (
              <div className="absolute right-0 top-full mt-2 z-50 w-64 p-3 bg-gray-900 dark:bg-gray-800 text-white text-xs rounded-lg shadow-xl">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className={`w-2 h-2 rounded-full ${syncInfo.color}`} />
                  <span className="font-semibold">{syncInfo.label}</span>
                </div>
                <p className="text-gray-300 leading-relaxed">{syncInfo.description}</p>
                {onChain?.lastSyncedAt && (
                  <p className="text-gray-400 mt-2 pt-2 border-t border-gray-700">
                    Last synced: {formatDistanceToNow(new Date(onChain.lastSyncedAt))} ago
                  </p>
                )}
                {!isInternalWallet && !onChain?.lastSyncedAt && (
                  <p className="text-gray-400 mt-2 pt-2 border-t border-gray-700">
                    Never synced
                  </p>
                )}
                <div className="absolute -top-1.5 right-4 w-3 h-3 bg-gray-900 dark:bg-gray-800 rotate-45" />
              </div>
            )}
          </div>

          <span className={`px-2.5 py-1 text-xs font-medium rounded-full ${wallet.status === 'active'
            ? 'bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-400'
            : wallet.status === 'frozen'
              ? 'bg-blue-100 dark:bg-blue-950 text-blue-700 dark:text-blue-400'
              : 'bg-red-100 dark:bg-red-950 text-red-700 dark:text-red-400'
            }`}>
            {wallet.status}
          </span>

          {/* Verification Button for Unverified Wallets */}
          {wallet.verificationStatus !== 'verified' && wallet.walletAddress && (
            <button
              onClick={handleVerify}
              disabled={verifying || !isConnected}
              className={`px-2 py-1 text-xs font-medium rounded-full transition-colors ${isConnected
                ? 'bg-yellow-100 text-yellow-800 hover:bg-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-400'
                : 'bg-gray-100 text-gray-500 dark:bg-gray-800'
                } disabled:opacity-50`}
              title={!isConnected ? "Connect wallet to verify" : "Verify ownership"}
            >
              {verifying ? 'Verifying...' : 'Verify Ownership'}
            </button>
          )}

          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setShowMenu(!showMenu)}
              className="p-1 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
            >
              <MoreVertical className="h-4 w-4 text-gray-400" />
            </button>
            {showMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => { setShowMenu(false); setConfirmDelete(false); }} />
                <div className="absolute right-0 top-full mt-1 z-50 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg py-1 min-w-[160px]">
                  {confirmDelete ? (
                    <div className="px-3 py-2">
                      <p className="text-xs text-red-600 dark:text-red-400 mb-2">Delete this wallet?</p>
                      <div className="flex gap-2">
                        <button
                          onClick={() => { setConfirmDelete(false); setShowMenu(false); }}
                          className="flex-1 px-2 py-1 text-xs bg-gray-100 dark:bg-gray-800 rounded hover:bg-gray-200 dark:hover:bg-gray-700"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => { onDelete?.(wallet.id); setShowMenu(false); setConfirmDelete(false); }}
                          disabled={isDeleting}
                          className="flex-1 px-2 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
                        >
                          {isDeleting ? '...' : 'Delete'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmDelete(true)}
                      className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Delete wallet
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
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

      {/* Ledger Balance */}
      <div className="mb-4 p-4 bg-gray-50 dark:bg-gray-900 rounded-lg">
        <div className="flex justify-between items-start mb-1">
          <div className="text-sm text-gray-600 dark:text-gray-400">Available (Ledger)</div>
        </div>
        <div className="text-2xl font-bold text-gray-900 dark:text-white">
          ${wallet.balance?.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </div>
        <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">{wallet.currency}</div>
      </div>

      {/* Spending Policy Section (for agent wallets) */}
      {(() => {
        const spendingStatus = getSpendingStatus(wallet.spendingPolicy, {
          dailyActualSpent: (wallet as any).dailyActualSpent,
          monthlyActualSpent: (wallet as any).monthlyActualSpent,
        });
        const isAgentWallet = !!(wallet as any).managedByAgentId;
        const policy = wallet.spendingPolicy;

        if (isAgentWallet || spendingStatus.hasPolicies) {
          return (
            <div className="mb-4 pt-3 border-t border-gray-100 dark:border-gray-800 space-y-3">
              {/* Near limit warning */}
              {spendingStatus.isNearLimit && (
                <div className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400 text-xs font-medium">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  Near spending limit
                </div>
              )}

              {/* Daily progress — prefer live computed spend from the
                  transfers ledger (any wallet type) over the stale
                  spending_policy JSON counters (only Circle maintains). */}
              {policy?.dailySpendLimit && (
                <SpendingProgressCompact
                  spent={(wallet as any).dailyActualSpent ?? policy.dailySpent ?? 0}
                  limit={policy.dailySpendLimit}
                  currency={wallet.currency}
                />
              )}

              {/* Monthly progress */}
              {policy?.monthlySpendLimit && (
                <SpendingProgressCompact
                  spent={(wallet as any).monthlyActualSpent ?? policy.monthlySpent ?? 0}
                  limit={policy.monthlySpendLimit}
                  currency={wallet.currency}
                />
              )}

              {/* Approval threshold badge */}
              {(policy?.approvalThreshold || policy?.requiresApprovalAbove) && (
                <div className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
                  <Shield className="w-3 h-3" />
                  Approval required above ${(policy.approvalThreshold || policy.requiresApprovalAbove)?.toLocaleString()}
                </div>
              )}

              {/* No policy warning for agent wallets */}
              {isAgentWallet && !spendingStatus.hasPolicies && (
                <div className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400 text-xs">
                  <AlertTriangle className="w-3 h-3" />
                  No spending policy configured
                </div>
              )}
            </div>
          );
        }
        return null;
      })()}

      {/* On-Chain Balance */}
      {!isInternalWallet && (
        <div className="mb-4 pt-3 border-t border-gray-100 dark:border-gray-800">
          <div className="flex justify-between items-center mb-2">
            <span className="text-xs font-medium text-gray-500 uppercase tracking-widest">On-Chain</span>
            <div className="flex items-center gap-2">
              {wallet.walletAddress && (
                <a
                  href={`https://sepolia.basescan.org/address/${wallet.walletAddress}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 flex items-center gap-1"
                >
                  View <span className="text-[10px]">↗</span>
                </a>
              )}
              <button
                onClick={handleSync}
                disabled={syncing}
                className={cn(
                  "flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md transition-colors",
                  syncStatus === 'stale'
                    ? "bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400"
                    : syncStatus === 'pending'
                      ? "bg-yellow-100 text-yellow-700 hover:bg-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-400"
                      : "bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-400",
                  syncing && "opacity-50 cursor-not-allowed"
                )}
              >
                <RefreshCw className={cn("h-3 w-3", syncing && "animate-spin")} />
                {syncing ? 'Syncing...' : 'Sync'}
              </button>
            </div>
          </div>

          {onChain ? (
            <>
              <div className="space-y-1">
                <div className="flex justify-between items-center">
                  <span className="text-sm text-gray-700 dark:text-gray-300">USDC</span>
                  <span className="font-mono text-sm font-medium text-gray-900 dark:text-white">
                    ${parseFloat(onChain.usdc).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                  </span>
                </div>
                {parseFloat(onChain.native) > 0 && (
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-gray-700 dark:text-gray-300">ETH</span>
                    <span className="font-mono text-sm text-gray-500">
                      {parseFloat(onChain.native).toFixed(4)}
                    </span>
                  </div>
                )}
              </div>

              {/* Last synced time - more prominent */}
              <div className={cn(
                "flex items-center gap-1.5 mt-2 px-2 py-1.5 rounded-md text-xs",
                syncStatus === 'synced'
                  ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400"
                  : syncStatus === 'pending'
                    ? "bg-yellow-50 text-yellow-700 dark:bg-yellow-900/20 dark:text-yellow-400"
                    : "bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400"
              )}>
                <Clock className="h-3 w-3" />
                {onChain.lastSyncedAt ? (
                  <span>Synced {formatDistanceToNow(new Date(onChain.lastSyncedAt))} ago</span>
                ) : (
                  <span>Never synced</span>
                )}
              </div>
            </>
          ) : balanceLoading ? (
            <div className="animate-pulse">
              <div className="h-4 bg-gray-200 dark:bg-gray-800 rounded w-1/3 mb-2"></div>
              <div className="h-6 bg-gray-200 dark:bg-gray-800 rounded w-full"></div>
            </div>
          ) : (
            <div className="text-center py-3">
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                Click sync to fetch on-chain balance
              </p>
            </div>
          )}
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
  );
}

// ─── Tenant Circle master wallet card ──────────────────
// Visual shape mirrors WalletBalanceCard so it reads as "just another wallet"
// in the grid, but it's labeled as tenant-scoped and always rendered first
// regardless of filters — it's the backstop that funds every agent EOA
// top-up (manual fund-eoa + auto-refill). Balance comes from the live Circle
// API via /v1/agents/circle/master-balance; no DB row.

function CircleMasterWalletCard({
  authToken,
  apiUrl,
  apiEnvironment,
}: {
  authToken: string | null;
  apiUrl?: string;
  apiEnvironment: 'test' | 'live';
}) {
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['circle-master-balance', apiEnvironment],
    queryFn: async () => {
      if (!authToken) return null;
      const res = await fetch(`${apiUrl || ''}/v1/agents/circle/master-balance`, {
        headers: { Authorization: `Bearer ${authToken}`, 'X-Environment': apiEnvironment },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
      return res.json() as Promise<{
        usdcAvailable: number;
        balances?: Array<{ amount: string; currency: string }>;
        note?: string;
      }>;
    },
    enabled: !!authToken,
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: 1,
  });

  const usdc = data?.usdcAvailable ?? null;
  const chain = apiEnvironment === 'live' ? 'Base mainnet' : 'Base Sepolia';
  const network = apiEnvironment === 'live' ? 'Live' : 'Sandbox';
  const unreachable = !!error;
  const low = usdc != null && usdc < 5;

  const statusDot = unreachable ? 'bg-red-500' : low ? 'bg-yellow-500' : usdc != null ? 'bg-emerald-500' : 'bg-gray-300';
  const statusLabel = unreachable ? 'Unreachable' : low ? 'Low' : usdc != null ? 'Healthy' : 'Checking';

  return (
    <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6 hover:shadow-lg transition-shadow ring-1 ring-emerald-100 dark:ring-emerald-950/40">
      <div className="flex items-start justify-between mb-4">
        <div className="w-12 h-12 bg-gradient-to-br from-emerald-500 to-teal-600 rounded-xl flex items-center justify-center">
          <WalletIcon className="h-6 w-6 text-white" />
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 px-2 py-1 bg-gray-50 dark:bg-gray-900 rounded-full border border-gray-100 dark:border-gray-800">
            <span className={`w-2 h-2 rounded-full ${statusDot}`} />
            <span className="text-[10px] uppercase font-bold text-gray-500 tracking-wider">{statusLabel}</span>
          </div>
          <span className="px-2.5 py-1 text-xs font-medium rounded-full bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-400">
            Tenant master
          </span>
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="p-1 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
            title="Refresh"
          >
            <RefreshCw className={cn('h-4 w-4 text-gray-400', isFetching && 'animate-spin')} />
          </button>
        </div>
      </div>

      <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">Circle master wallet</h3>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        Tenant-scoped · funds all agent EOA top-ups (manual &amp; auto-refill) · {network} · {chain}
      </p>

      <div className="mb-4 p-4 bg-gray-50 dark:bg-gray-900 rounded-lg">
        <div className="flex justify-between items-start mb-1">
          <div className="text-sm text-gray-600 dark:text-gray-400">USDC available</div>
        </div>
        <div className="text-2xl font-bold text-gray-900 dark:text-white">
          {isLoading && usdc == null
            ? '…'
            : unreachable
              ? '—'
              : usdc == null
                ? '—'
                : `$${usdc.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
        </div>
        <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">USDC</div>
      </div>

      {unreachable && (
        <div className="mb-4 p-3 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 rounded-lg text-xs text-red-800 dark:text-red-300">
          <div className="font-medium mb-0.5">Circle unreachable</div>
          <div className="opacity-80">
            Check that <code className="font-mono">CIRCLE_API_KEY</code> on the API is a Circle Mint / Business Account key
            (not a W3S Programmable Wallets key) — Payouts endpoints require Mint scope.
          </div>
        </div>
      )}

      {!unreachable && data?.balances && data.balances.length > 1 && (
        <div className="mb-4 pt-3 border-t border-gray-100 dark:border-gray-800">
          <div className="text-xs font-medium text-gray-500 uppercase tracking-widest mb-2">Other currencies</div>
          <div className="space-y-1">
            {data.balances
              .filter((b) => b.currency !== 'USD' && b.currency !== 'USDC' && parseFloat(b.amount) > 0)
              .map((b) => (
                <div key={b.currency} className="flex justify-between items-center">
                  <span className="text-sm text-gray-700 dark:text-gray-300">{b.currency}</span>
                  <span className="font-mono text-sm text-gray-900 dark:text-white">
                    {parseFloat(b.amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                  </span>
                </div>
              ))}
          </div>
        </div>
      )}

      <div className="flex gap-2">
        <a
          href="https://console.circle.com/"
          target="_blank"
          rel="noopener noreferrer"
          className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 transition-colors"
        >
          <ArrowDown className="h-4 w-4" />
          Top up in Circle
        </a>
        <div
          className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-gray-100 dark:bg-gray-900 text-gray-400 text-sm font-medium rounded-lg cursor-not-allowed"
          title="Withdrawals from the master happen at Circle — not via Sly"
        >
          <ArrowUp className="h-4 w-4" />
          Withdraw
        </div>
      </div>
    </div>
  );
}

export default function WalletsPage() {
  const api = useApiClient();
  const { isConfigured, isLoading: isAuthLoading, authToken, apiEnvironment, apiUrl } = useApiConfig();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAgentWalletsOnly, setShowAgentWalletsOnly] = useState(false);
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'frozen' | 'depleted'>('all');
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const deleteMutation = useMutation({
    mutationFn: async (walletId: string) => {
      if (!api) throw new Error('API client not initialized');
      setDeletingId(walletId);
      return api.wallets.delete(walletId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['wallets'] });
      toast.success('Wallet deleted');
      setDeletingId(null);
    },
    onError: (err: any) => {
      toast.error(err.message || 'Failed to delete wallet');
      setDeletingId(null);
    },
  });

  // Form state
  const [createMode, setCreateMode] = useState<'select' | 'create' | 'external'>('select');
  const [formData, setFormData] = useState({
    name: '',
    purpose: '',
    currency: 'USDC' as 'USDC' | 'EURC',
    initialBalance: '0',
    accountId: '',
    walletType: 'internal' as 'internal' | 'circle_custodial',
    blockchain: 'base' as 'base' | 'ethereum' | 'polygon',
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
    queryKey: ['wallets', 'count', apiEnvironment],
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
    queryKey: ['wallets', 'page', pagination.page, pagination.pageSize, apiEnvironment],
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

  // Calculate stats with memoization
  const stats = useMemo(() => {
    const agentWallets = wallets.filter((w: any) => w.managedByAgentId);
    const activeWallets = wallets.filter((w: any) => w.status === 'active').length;
    const totalBalance = wallets.reduce((sum: number, w: any) => sum + (w.balance || 0), 0);
    const withPolicies = agentWallets.filter((w: any) => {
      const status = getSpendingStatus(w.spendingPolicy, {
        dailyActualSpent: w.dailyActualSpent,
        monthlyActualSpent: w.monthlyActualSpent,
      });
      return status.hasPolicies;
    }).length;
    const nearLimit = wallets.filter((w: any) => {
      const status = getSpendingStatus(w.spendingPolicy, {
        dailyActualSpent: w.dailyActualSpent,
        monthlyActualSpent: w.monthlyActualSpent,
      });
      return status.isNearLimit;
    }).length;

    return {
      total: wallets.length,
      active: activeWallets,
      totalBalance,
      agentManaged: agentWallets.length,
      withPolicies,
      nearLimit,
    };
  }, [wallets]);

  // Filter wallets
  const filteredWallets = useMemo(() => {
    let filtered = wallets;

    // Agent filter
    if (showAgentWalletsOnly) {
      filtered = filtered.filter((w: any) => w.managedByAgentId);
    }

    // Status filter
    if (statusFilter !== 'all') {
      filtered = filtered.filter((w: any) => w.status === statusFilter);
    }

    // Search filter
    if (search.trim()) {
      const query = search.toLowerCase();
      filtered = filtered.filter((w: any) =>
        (w.name?.toLowerCase() || '').includes(query) ||
        (w.purpose?.toLowerCase() || '').includes(query) ||
        (w.id?.toLowerCase() || '').includes(query)
      );
    }

    return filtered;
  }, [wallets, showAgentWalletsOnly, statusFilter, search]);

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
          currency: formData.currency,
          type: formData.walletType as 'internal' | 'circle_custodial',
          blockchain: formData.blockchain
        });

        // Show success toast for Circle wallets
        if (formData.walletType === 'circle_custodial') {
          toast.success('Circle Wallet created!');
          // In a real scenario we would show a faucet link here
        }

        // If initial balance > 0, deposit (only for internal or if funding supported)
        if (parseFloat(formData.initialBalance) > 0 && formData.walletType === 'internal') {
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

  if (isAuthLoading) {
    return (
      <div className="p-8 max-w-[1600px] mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">Wallets</h1>
            <p className="text-gray-600 dark:text-gray-400">Manage stablecoin wallets for x402 payments</p>
          </div>
        </div>
        <div className="col-span-full">
          <CardListSkeleton count={6} />
        </div>
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
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-600 dark:text-gray-400">Total Balance</span>
            <TrendingUp className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
          </div>
          <div className="text-3xl font-bold text-gray-900 dark:text-white">
            ${stats.totalBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            {stats.total} wallets ({stats.active} active)
          </div>
        </div>

        <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-600 dark:text-gray-400">Agent-Managed</span>
            <Bot className="h-4 w-4 text-violet-600 dark:text-violet-400" />
          </div>
          <div className="text-3xl font-bold text-gray-900 dark:text-white">
            {stats.agentManaged}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            {stats.withPolicies} with policies
          </div>
        </div>

        <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-600 dark:text-gray-400">With Policies</span>
            <Shield className="h-4 w-4 text-blue-600 dark:text-blue-400" />
          </div>
          <div className="text-3xl font-bold text-gray-900 dark:text-white">
            {stats.withPolicies}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            Spending controls active
          </div>
        </div>

        <div className={cn(
          "bg-white dark:bg-gray-950 rounded-2xl border p-6",
          stats.nearLimit > 0
            ? "border-amber-300 dark:border-amber-700"
            : "border-gray-200 dark:border-gray-800"
        )}>
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-600 dark:text-gray-400">Near Limit</span>
            <AlertTriangle className={cn(
              "h-4 w-4",
              stats.nearLimit > 0
                ? "text-amber-500"
                : "text-gray-400"
            )} />
          </div>
          <div className={cn(
            "text-3xl font-bold",
            stats.nearLimit > 0
              ? "text-amber-600 dark:text-amber-400"
              : "text-gray-900 dark:text-white"
          )}>
            {stats.nearLimit}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            &gt;80% of limit used
          </div>
        </div>
      </div>

      {/* Search and Filters */}
      <div className="flex flex-col gap-4 mb-6">
        <div className="flex items-center gap-4">
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

          {/* Status filter pills */}
          <div className="flex items-center gap-1 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-1">
            {(['all', 'active', 'frozen', 'depleted'] as const).map((status) => (
              <button
                key={status}
                onClick={() => setStatusFilter(status)}
                className={cn(
                  "px-3 py-1.5 text-sm rounded-md transition-colors",
                  statusFilter === status
                    ? "bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300 font-medium"
                    : "text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"
                )}
              >
                {status.charAt(0).toUpperCase() + status.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            {/* Agent wallets toggle */}
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={showAgentWalletsOnly}
                onChange={(e) => setShowAgentWalletsOnly(e.target.checked)}
                className="w-4 h-4 rounded border-gray-300 text-violet-600 focus:ring-violet-500"
              />
              <span className="text-sm text-gray-700 dark:text-gray-300 flex items-center gap-1.5">
                <Bot className="w-4 h-4 text-violet-500" />
                Agent wallets only
              </span>
            </label>

            {/* Results count */}
            <span className="text-sm text-gray-500 dark:text-gray-400">
              {filteredWallets.length} wallet{filteredWallets.length !== 1 ? 's' : ''}
              {showAgentWalletsOnly && ' (agent-managed)'}
            </span>
          </div>

          {/* Approvals link - show when filtering agent wallets */}
          {showAgentWalletsOnly && (
            <Link
              href="/dashboard/approvals"
              className="flex items-center gap-2 px-4 py-2 bg-violet-600 text-white text-sm font-medium rounded-lg hover:bg-violet-700 transition-colors"
            >
              <Clock className="h-4 w-4" />
              View Pending Approvals
            </Link>
          )}
        </div>
      </div>

      {/* Wallets Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {/* Tenant Circle master — always shown first, bypasses filters. */}
        <CircleMasterWalletCard
          authToken={authToken}
          apiUrl={apiUrl}
          apiEnvironment={apiEnvironment}
        />

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
            <WalletBalanceCard
              key={wallet.id}
              wallet={wallet}
              authToken={authToken}
              apiEnvironment={apiEnvironment}
              apiUrl={apiUrl}
              onDelete={(id) => deleteMutation.mutate(id)}
              isDeleting={deletingId === wallet.id}
            />
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
                  onClick={() => {
                    setCreateMode('create');
                    setFormData(prev => ({ ...prev, walletType: 'internal' }));
                  }}
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

                <button
                  onClick={() => {
                    setCreateMode('create');
                    setFormData(prev => ({ ...prev, walletType: 'circle_custodial', blockchain: 'base' }));
                  }}
                  className="w-full p-4 border-2 border-gray-200 dark:border-gray-700 rounded-xl hover:border-blue-500 dark:hover:border-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-all text-left group"
                >
                  <div className="flex items-start gap-4">
                    <div className="w-12 h-12 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-xl flex items-center justify-center">
                      <WalletIcon className="h-6 w-6 text-white" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-gray-900 dark:text-white group-hover:text-blue-600 dark:group-hover:text-blue-400">
                        Circle Wallet
                      </h3>
                      <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                        Create a Circle Programmable Wallet with MPC security
                      </p>
                    </div>
                  </div>
                </button>
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

