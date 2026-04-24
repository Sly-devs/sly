'use client';

import { useParams, useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useApiClient, useApiConfig } from '@/lib/api-client';
import { Card, Button, Badge as UIBadge } from '@sly/ui';
import {
    ArrowLeft,
    Wallet,
    CreditCard,
    ArrowUpRight,
    ArrowDownLeft,
    Clock,
    ExternalLink,
    Copy,
    MoreVertical,
    Shield,
    Activity,
    Calendar,
    DollarSign,
    AlertTriangle,
    RefreshCw,
    Pencil,
    Check,
    X as XIcon
} from 'lucide-react';
import { toast } from 'sonner';
import Link from 'next/link';
import { useState } from 'react';
import { formatCurrency } from '@sly/ui';
import { formatDistanceToNow } from 'date-fns';
import { SpendingPolicyEditor } from '@/components/wallets/spending-policy-editor';
import { DepositModal } from '@/components/wallets/deposit-modal';
import { WithdrawModal } from '@/components/wallets/withdraw-modal';

const useWalletBalance = (
    walletId: string | undefined,
    authToken: string | null,
    apiUrl?: string,
    apiEnvironment?: string,
) => {
    return useQuery({
        queryKey: ['wallet-balance', walletId, apiEnvironment],
        queryFn: async () => {
            if (!authToken) return null;
            const headers: Record<string, string> = {
                Authorization: `Bearer ${authToken}`,
            };
            if (apiEnvironment) headers['X-Environment'] = apiEnvironment;
            const response = await fetch(
                `${apiUrl || ''}/v1/wallets/${walletId}/balance`,
                { headers },
            );
            if (!response.ok) return null;
            return response.json();
        },
        enabled: !!walletId && !!authToken,
        staleTime: 60 * 1000,
        refetchInterval: 60 * 1000,
    });
};

// Custom Badge for Wallet Status
function StatusBadge({ status }: { status: string }) {
    const styles: Record<string, string> = {
        active: 'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400',
        frozen: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400',
        depleted: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-950 dark:text-yellow-400',
    };

    return (
        <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium capitalize ${styles[status] || 'bg-gray-100 text-gray-700'}`}>
            {status}
        </span>
    );
}

export default function WalletDetailPage() {
    const { id } = useParams<{ id: string }>();
    const router = useRouter();
    const api = useApiClient();
    const { authToken, apiUrl, apiEnvironment } = useApiConfig();
    const queryClient = useQueryClient();
    const [timeRange, setTimeRange] = useState('30d');
    const [editingName, setEditingName] = useState(false);
    const [nameValue, setNameValue] = useState('');
    const [showDepositModal, setShowDepositModal] = useState(false);
    const [showWithdrawModal, setShowWithdrawModal] = useState(false);

    // Fetch wallet details. Include env in the queryKey so flipping
    // test↔live refetches — the API filters wallets by env.
    const { data: walletResponse, isLoading, error } = useQuery({
        queryKey: ['wallet', id, apiEnvironment],
        queryFn: async () => {
            if (!api) throw new Error('API client not initialized');
            return api.wallets.get(id);
        },
        enabled: !!api && !!id,
    });

    const wallet = (walletResponse as any)?.data || walletResponse;

    // Fetch on-chain balance
    const { data: balanceData, isLoading: balanceLoading, refetch: refetchBalance } = useWalletBalance(id, authToken, apiUrl, apiEnvironment);
    const onChain = balanceData?.data?.onChain;
    const syncStatus = balanceData?.data?.syncStatus || 'stale';
    // Circle custodial drift diagnostic — surfaced when Circle's API
    // number disagrees with the actual chain state by >1¢.
    const mismatch = balanceData?.data?.mismatch;
    const circleReported: number | null | undefined = balanceData?.data?.circleReported;

    // Rename mutation
    const renameMutation = useMutation({
        mutationFn: async (newName: string) => {
            if (!api) throw new Error('API client not initialized');
            return api.wallets.update(id, { name: newName });
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['wallet', id] });
            queryClient.invalidateQueries({ queryKey: ['wallets'] });
            setEditingName(false);
            toast.success('Wallet renamed');
        },
        onError: (err: any) => {
            toast.error(err.message || 'Failed to rename wallet');
        },
    });

    // Sync state
    const [syncing, setSyncing] = useState(false);

    // Check if internal wallet
    const isInternalWallet = !wallet?.walletAddress || wallet?.walletAddress?.startsWith('internal://');

    const handleSync = async () => {
        if (!authToken || isInternalWallet) return;

        setSyncing(true);
        try {
            const response = await fetch(
                `${apiUrl}/v1/wallets/${id}/sync`,
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

            // Refresh both wallet data and balance data
            queryClient.invalidateQueries({ queryKey: ['wallet', id] });
            await refetchBalance();
            toast.success('Wallet balance synced from blockchain');
        } catch (error: any) {
            console.error('Sync failed:', error);
            toast.error(error.message || 'Failed to sync wallet balance');
        } finally {
            setSyncing(false);
        }
    };

    // Fetch transactions for this wallet.
    // Prefer the recentTransactions array the wallet GET handler ships
    // — it already contains the right set per wallet type (EOA: agent-
    // initiated x402 + inbound deposits; Circle: policy-wallet activity).
    // Fall back to the generic transfers list if the shape isn't there.
    const recentFromWallet = (wallet as any)?.recentTransactions;
    const { data: transactionsResponse, isLoading: txLoading } = useQuery({
        queryKey: ['wallet-transactions', id, apiEnvironment],
        queryFn: async () => {
            if (!api) throw new Error('API client not initialized');
            return api.transfers.list({ walletId: id, limit: 20 });
        },
        enabled: !!api && !!id && !Array.isArray(recentFromWallet),
    });

    const transactions = Array.isArray(recentFromWallet)
        ? recentFromWallet
        : ((transactionsResponse as any)?.data || []);

    const handleCopyAddress = () => {
        if (wallet?.walletAddress) {
            navigator.clipboard.writeText(wallet.walletAddress);
            toast.success('Wallet address copied to clipboard');
        }
    };

    if (isLoading) {
        return (
            <div className="p-8 max-w-[1600px] mx-auto space-y-8 animate-pulse">
                <div className="h-8 bg-gray-200 dark:bg-gray-800 rounded w-1/4 mb-8" />
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <div className="h-40 bg-gray-200 dark:bg-gray-800 rounded-xl" />
                    <div className="h-40 bg-gray-200 dark:bg-gray-800 rounded-xl" />
                    <div className="h-40 bg-gray-200 dark:bg-gray-800 rounded-xl" />
                </div>
            </div>
        );
    }

    if (error || !wallet) {
        return (
            <div className="p-8 max-w-[1600px] mx-auto flex flex-col items-center justify-center min-h-[400px]">
                <div className="w-16 h-16 bg-red-100 dark:bg-red-900/20 rounded-full flex items-center justify-center mb-4">
                    <AlertTriangle className="w-8 h-8 text-red-600 dark:text-red-400" />
                </div>
                <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">Wallet not found</h2>
                <Button variant="outline" onClick={() => router.push('/dashboard/wallets')}>
                    <ArrowLeft className="w-4 h-4 mr-2" />
                    Back to Wallets
                </Button>
            </div>
        );
    }

    return (
        <div className="p-8 max-w-[1600px] mx-auto space-y-8">
            {/* Top Navigation */}
            <div className="flex items-center justify-between">
                <Button variant="ghost" className="pl-0 gap-2 text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white" onClick={() => router.push('/dashboard/wallets')}>
                    <ArrowLeft className="w-4 h-4" />
                    Back to Wallets
                </Button>
                <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => toast.info('Freeze feature coming soon')}>
                        <Shield className="w-4 h-4 mr-2" />
                        Freeze
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setShowDepositModal(true)}>
                        <ArrowDownLeft className="w-4 h-4 mr-2" />
                        Deposit
                    </Button>
                    {(() => {
                        // Withdraw routes through Circle rails, which don't apply to
                        // Sly-managed agent EOAs (the key signs on-chain payments
                        // directly). Disable with an explanation so users understand
                        // this is intentional, not a placeholder.
                        const walletType = wallet.walletType || wallet.wallet_type;
                        const isAgentEoa = walletType === 'agent_eoa';
                        return (
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => isAgentEoa
                                    ? toast.info('EOAs spend via x402 signing, not Circle withdraw. Use x402_sign or x402_fetch to move USDC out.')
                                    : setShowWithdrawModal(true)
                                }
                                disabled={isAgentEoa}
                                title={isAgentEoa ? 'EOAs spend via x402 signing — no Circle withdraw rail' : undefined}
                            >
                                <ArrowUpRight className="w-4 h-4 mr-2" />
                                Withdraw
                            </Button>
                        );
                    })()}
                </div>
            </div>

            {/* Header Info */}
            <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
                <div>
                    <div className="flex items-center gap-3 mb-2">
                        <div className="p-3 bg-blue-100 dark:bg-blue-900/20 rounded-xl">
                            <Wallet className="w-8 h-8 text-blue-600 dark:text-blue-400" />
                        </div>
                        <div>
                            {editingName ? (
                                <div className="flex items-center gap-2">
                                    <input
                                        autoFocus
                                        value={nameValue}
                                        onChange={(e) => setNameValue(e.target.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter' && nameValue.trim()) renameMutation.mutate(nameValue.trim());
                                            if (e.key === 'Escape') setEditingName(false);
                                        }}
                                        className="text-3xl font-bold text-gray-900 dark:text-white bg-transparent border-b-2 border-blue-500 outline-none px-0 py-0 w-auto min-w-[200px]"
                                    />
                                    <button
                                        onClick={() => nameValue.trim() && renameMutation.mutate(nameValue.trim())}
                                        disabled={renameMutation.isPending || !nameValue.trim()}
                                        className="p-1.5 text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20 rounded-lg disabled:opacity-50"
                                    >
                                        <Check className="w-5 h-5" />
                                    </button>
                                    <button
                                        onClick={() => setEditingName(false)}
                                        className="p-1.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg"
                                    >
                                        <XIcon className="w-5 h-5" />
                                    </button>
                                </div>
                            ) : (
                                <div className="flex items-center gap-2 group">
                                    <h1 className="text-3xl font-bold text-gray-900 dark:text-white">{wallet.name || 'Untitled Wallet'}</h1>
                                    <button
                                        onClick={() => { setNameValue(wallet.name || ''); setEditingName(true); }}
                                        className="p-1.5 text-gray-400 opacity-0 group-hover:opacity-100 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-opacity"
                                    >
                                        <Pencil className="w-4 h-4" />
                                    </button>
                                </div>
                            )}
                            <div className="flex items-center gap-3 mt-1">
                                <StatusBadge status={wallet.status} />
                                <span className="text-sm text-gray-500 dark:text-gray-400 flex items-center gap-1">
                                    {wallet.network || 'Network Unknown'}
                                </span>
                            </div>
                        </div>
                    </div>
                </div>
                <div className="flex flex-col items-end">
                    <div className="text-sm text-gray-500 dark:text-gray-400 mb-1">Wallet Information</div>
                    <div className="flex items-center gap-2 bg-gray-100 dark:bg-gray-800 px-3 py-1.5 rounded-lg cursor-pointer hover:bg-gray-200 dark:hover:bg-gray-700 transition" onClick={handleCopyAddress}>
                        <span className="text-sm font-mono text-gray-700 dark:text-gray-300">
                            {wallet.walletAddress ? `${wallet.walletAddress.slice(0, 6)}...${wallet.walletAddress.slice(-4)}` : 'No Address'}
                        </span>
                        <Copy className="w-3.5 h-3.5 text-gray-500" />
                    </div>
                </div>
            </div>


            {/* Main Grid */}
            <div className="grid grid-cols-1 xl:grid-cols-3 gap-8">

                {/* Left Column (Details & Transactions) */}
                <div className="xl:col-span-2 space-y-8">

                    {/* Balance Cards */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <Card className="p-6 bg-gradient-to-br from-blue-600 to-indigo-700 text-white border-0 shadow-xl">
                            <div className="flex justify-between items-start mb-8">
                                <div>
                                    <p className="text-blue-100 text-sm font-medium mb-1">Total Balance</p>
                                    <h3 className="text-4xl font-bold">
                                        {(() => {
                                            // For agent_eoa, on-chain IS the ledger — prefer the
                                            // fresh chain number from /balance over the DB column
                                            // (which lags by one request cycle in the worst case).
                                            const walletType = wallet.walletType || wallet.wallet_type;
                                            const onChainUsd = onChain?.usdc != null ? parseFloat(onChain.usdc) : null;
                                            const display = walletType === 'agent_eoa' && onChainUsd != null
                                                ? onChainUsd
                                                : (wallet.balance || 0);
                                            return formatCurrency(display, wallet.currency || 'USDC');
                                        })()}
                                    </h3>
                                </div>
                                <Activity className="w-6 h-6 text-blue-200" />
                            </div>
                            <div className="flex items-center gap-2 text-sm text-blue-100">
                                <div className="w-2 h-2 rounded-full bg-green-400"></div>
                                {(wallet.walletType || wallet.wallet_type) === 'agent_eoa' ? 'Live on-chain' : 'Available for use'}
                            </div>
                        </Card>

                        {/* Spending policy is universal — every wallet
                            type now shows daily/monthly caps + live
                            usage from the transfers ledger. For
                            agent_eoa we ALSO stack the auto-refill card
                            below it (chain-native funding policy). */}
                        <div className="space-y-6">
                            <SpendingPolicyEditor wallet={wallet} />
                            {(wallet.walletType || wallet.wallet_type) === 'agent_eoa' && (
                                <EoaAutoRefillCard wallet={wallet} />
                            )}
                        </div>
                    </div>

                    {/* Circle ↔ chain mismatch banner. For circle_custodial
                        wallets we query both and show a loud warning when
                        Circle's reported balance disagrees with on-chain
                        reality. Helps tenants catch drift / sweeps that
                        would otherwise show as "synced" in the UI. */}
                    {mismatch && (
                        <Card className="p-4 border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30">
                            <div className="flex items-start gap-3">
                                <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                                <div className="flex-1 min-w-0">
                                    <div className="text-sm font-semibold text-amber-900 dark:text-amber-200 mb-1">
                                        Balance mismatch: Circle ledger vs. chain
                                    </div>
                                    <div className="text-sm text-amber-800 dark:text-amber-300">
                                        {mismatch.note}
                                    </div>
                                    <div className="mt-2 grid grid-cols-3 gap-3 text-xs">
                                        <div>
                                            <div className="uppercase tracking-wide text-amber-700/70 dark:text-amber-400/70">Circle says</div>
                                            <div className="font-mono font-semibold text-amber-900 dark:text-amber-100">
                                                {circleReported != null ? formatCurrency(circleReported, wallet.currency || 'USDC') : '—'}
                                            </div>
                                        </div>
                                        <div>
                                            <div className="uppercase tracking-wide text-amber-700/70 dark:text-amber-400/70">On chain</div>
                                            <div className="font-mono font-semibold text-amber-900 dark:text-amber-100">
                                                {onChain?.usdc ? formatCurrency(parseFloat(onChain.usdc), wallet.currency || 'USDC') : '—'}
                                            </div>
                                        </div>
                                        <div>
                                            <div className="uppercase tracking-wide text-amber-700/70 dark:text-amber-400/70">Δ</div>
                                            <div className="font-mono font-semibold text-amber-900 dark:text-amber-100">
                                                {mismatch.delta > 0 ? '+' : ''}{mismatch.delta.toFixed(4)}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </Card>
                    )}

                    {/* Transactions List */}
                    <Card className="overflow-hidden">
                        <div className="p-6 border-b border-gray-200 dark:border-gray-800 flex justify-between items-center">
                            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Recent Activity</h3>
                            <Button variant="ghost" size="sm" className="text-blue-600">View All</Button>
                        </div>

                        {txLoading ? (
                            <div className="p-8 text-center text-gray-500">Loading transactions...</div>
                        ) : transactions.length === 0 ? (
                            <div className="p-12 text-center text-gray-500 dark:text-gray-400">
                                <Clock className="w-12 h-12 mx-auto mb-3 opacity-20" />
                                <p>No transactions found for this wallet.</p>
                            </div>
                        ) : (
                            <div className="overflow-x-auto">
                                <table className="w-full text-sm text-left">
                                    <thead className="bg-gray-50 dark:bg-gray-800/50 text-gray-500 dark:text-gray-400 font-medium">
                                        <tr>
                                            <th className="px-6 py-3">Type</th>
                                            <th className="px-6 py-3">Amount</th>
                                            <th className="px-6 py-3">Status</th>
                                            <th className="px-6 py-3">Date</th>
                                            <th className="px-6 py-3"></th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
                                        {transactions.map((tx: any) => (
                                            <tr key={tx.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                                                <td className="px-6 py-4">
                                                    <div className="flex items-center gap-3">
                                                        <div className={`p-2 rounded-lg ${tx.amount > 0 ? 'bg-green-100 dark:bg-green-900/20 text-green-600' : 'bg-gray-100 dark:bg-gray-800 text-gray-600'}`}>
                                                            {tx.amount > 0 ? <ArrowDownLeft className="w-4 h-4" /> : <ArrowUpRight className="w-4 h-4" />}
                                                        </div>
                                                        <span className="font-medium text-gray-900 dark:text-white capitalize truncate max-w-[150px]">
                                                            {tx.type.replace(/_/g, ' ')}
                                                        </span>
                                                    </div>
                                                </td>
                                                <td className="px-6 py-4">
                                                    <span className={`font-medium ${tx.amount > 0 ? 'text-green-600 dark:text-green-400' : 'text-gray-900 dark:text-white'}`}>
                                                        {tx.amount > 0 ? '+' : ''}{formatCurrency(tx.amount || 0, tx.currency || 'USDC')}
                                                    </span>
                                                </td>
                                                <td className="px-6 py-4">
                                                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium capitalize ${tx.status === 'completed' ? 'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400' :
                                                        tx.status === 'failed' ? 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400' :
                                                            'bg-yellow-100 text-yellow-700 dark:bg-yellow-950 dark:text-yellow-400'
                                                        }`}>
                                                        {tx.status}
                                                    </span>
                                                </td>
                                                <td className="px-6 py-4 text-gray-500 dark:text-gray-400">
                                                    {new Date(tx.createdAt || tx.created_at).toLocaleDateString()}
                                                </td>
                                                <td className="px-6 py-4 text-right">
                                                    <Link href={`/dashboard/transfers/${tx.id}`} className="text-gray-400 hover:text-blue-600 transition-colors">
                                                        <ExternalLink className="w-4 h-4" />
                                                    </Link>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </Card>
                </div>

                {/* Right Column (Info & Stats) */}
                <div className="space-y-6">
                    <Card className="p-6">
                        <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-6">Wallet Details</h3>
                        <div className="space-y-4">
                            <div className="flex justify-between py-2 border-b border-gray-100 dark:border-gray-800">
                                <span className="text-sm text-gray-500">ID</span>
                                <span className="text-sm font-mono text-gray-900 dark:text-white truncate max-w-[150px]" title={wallet.id}>
                                    {wallet.id}
                                </span>
                            </div>
                            <div className="flex justify-between py-2 border-b border-gray-100 dark:border-gray-800">
                                <span className="text-sm text-gray-500">Created</span>
                                <span className="text-sm text-gray-900 dark:text-white">
                                    {new Date(wallet.createdAt || wallet.created_at).toLocaleDateString()}
                                </span>
                            </div>
                            <div className="flex justify-between py-2 border-b border-gray-100 dark:border-gray-800">
                                <span className="text-sm text-gray-500">Purpose</span>
                                <span className="text-sm text-gray-900 dark:text-white capitalize">
                                    {wallet.purpose || 'General'}
                                </span>
                            </div>
                            <div className="flex justify-between py-2 border-b border-gray-100 dark:border-gray-800">
                                <span className="text-sm text-gray-500">Owner Account</span>
                                <Link href={`/dashboard/accounts/${wallet.ownerAccountId}`} className="text-sm text-blue-600 hover:underline truncate max-w-[150px]">
                                    {wallet.ownerAccountId || 'N/A'}
                                </Link>
                            </div>
                        </div>
                    </Card>

                    {/* On-Chain Details Card */}
                    <Card className="p-6">
                        <div className="flex justify-between items-center mb-6">
                            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">On-Chain Details</h3>
                            {!isInternalWallet && (
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={handleSync}
                                    disabled={syncing}
                                    className={syncStatus === 'stale' ? 'border-red-300 text-red-600 hover:bg-red-50' : ''}
                                >
                                    <RefreshCw className={`w-4 h-4 mr-1.5 ${syncing ? 'animate-spin' : ''}`} />
                                    {syncing ? 'Syncing...' : 'Sync'}
                                </Button>
                            )}
                        </div>

                        {isInternalWallet ? (
                            <div className="py-6 text-center">
                                <div className="w-12 h-12 bg-blue-100 dark:bg-blue-900/20 rounded-full flex items-center justify-center mx-auto mb-3">
                                    <Wallet className="w-6 h-6 text-blue-600 dark:text-blue-400" />
                                </div>
                                <p className="text-sm text-gray-600 dark:text-gray-400">
                                    This is an internal Sly wallet.<br />
                                    No blockchain sync required.
                                </p>
                            </div>
                        ) : (
                            <div className="space-y-4">
                                {/* Sync Status Banner */}
                                <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm ${
                                    syncStatus === 'synced'
                                        ? 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400'
                                        : syncStatus === 'pending'
                                            ? 'bg-yellow-50 text-yellow-700 dark:bg-yellow-900/20 dark:text-yellow-400'
                                            : 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400'
                                }`}>
                                    <Clock className="w-4 h-4" />
                                    {onChain?.lastSyncedAt
                                        ? `Last synced ${formatDistanceToNow(new Date(onChain.lastSyncedAt))} ago`
                                        : 'Never synced - click Sync to fetch on-chain balance'
                                    }
                                </div>

                                <div className="flex justify-between py-2 border-b border-gray-100 dark:border-gray-800">
                                    <span className="text-sm text-gray-500">Network</span>
                                    <span className="text-sm font-medium text-gray-900 dark:text-white flex items-center gap-2">
                                        <div className="w-2 h-2 rounded-full bg-blue-500"></div>
                                        {wallet.network || 'Unknown'}
                                    </span>
                                </div>

                                {wallet.blockchain && (
                                    <div className="flex justify-between py-2 border-b border-gray-100 dark:border-gray-800">
                                        <span className="text-sm text-gray-500">Blockchain</span>
                                        <span className="text-sm font-medium text-gray-900 dark:text-white capitalize">
                                            {wallet.blockchain}
                                        </span>
                                    </div>
                                )}

                                {wallet.provider && wallet.provider !== 'payos' && (
                                    <div className="flex justify-between py-2 border-b border-gray-100 dark:border-gray-800">
                                        <span className="text-sm text-gray-500">Provider</span>
                                        <span className="text-sm font-medium text-gray-900 dark:text-white capitalize">
                                            {wallet.provider}
                                        </span>
                                    </div>
                                )}

                                {wallet.tokenContract && (
                                    <div className="flex justify-between py-2 border-b border-gray-100 dark:border-gray-800">
                                        <span className="text-sm text-gray-500">Token Contract</span>
                                        <span className="text-sm font-mono text-gray-900 dark:text-white">
                                            {wallet.tokenContract.slice(0, 6)}...{wallet.tokenContract.slice(-4)}
                                        </span>
                                    </div>
                                )}

                                {wallet.currency && (
                                    <div className="flex justify-between py-2 border-b border-gray-100 dark:border-gray-800">
                                        <span className="text-sm text-gray-500">Currency</span>
                                        <span className="text-sm font-medium text-gray-900 dark:text-white">
                                            {wallet.currency}
                                        </span>
                                    </div>
                                )}

                                {onChain ? (
                                    <>
                                        <div className="flex justify-between py-2 border-b border-gray-100 dark:border-gray-800">
                                            <span className="text-sm text-gray-500">Native Balance</span>
                                            <span className="text-sm font-mono text-gray-900 dark:text-white">
                                                {parseFloat(onChain.native).toFixed(4)} {wallet.blockchain === 'tempo' ? 'TEMPO' : 'ETH'}
                                            </span>
                                        </div>
                                        <div className="flex justify-between py-2 border-b border-gray-100 dark:border-gray-800">
                                            <span className="text-sm text-gray-500">{wallet.currency || 'USDC'} Balance</span>
                                            <span className="text-sm font-mono text-gray-900 dark:text-white">
                                                {parseFloat(onChain.usdc).toLocaleString('en-US', { minimumFractionDigits: 2 })} {wallet.currency || 'USDC'}
                                            </span>
                                        </div>
                                    </>
                                ) : (
                                    <div className="py-4 text-center text-gray-500 text-sm italic">
                                        {balanceLoading ? 'Fetching on-chain data...' : 'Click Sync to fetch on-chain balance'}
                                    </div>
                                )}

                                <div className="flex justify-between py-2 border-b border-gray-100 dark:border-gray-800">
                                    <span className="text-sm text-gray-500">Block Explorer</span>
                                    {wallet.walletAddress && (() => {
                                        const explorerUrl = wallet.blockchain === 'tempo'
                                            ? (wallet.network === 'tempo-testnet'
                                                ? `https://moderato.tempo.xyz/address/${wallet.walletAddress}`
                                                : `https://explorer.tempo.xyz/address/${wallet.walletAddress}`)
                                            : `https://sepolia.basescan.org/address/${wallet.walletAddress}`;
                                        return (
                                            <a
                                                href={explorerUrl}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="text-sm text-blue-600 hover:underline flex items-center gap-1"
                                            >
                                                View <ExternalLink className="w-3 h-3" />
                                            </a>
                                        );
                                    })()}
                                </div>

                                {/* Placeholder for on-chain transactions */}
                                <div className="mt-4 pt-4 border-t border-gray-100 dark:border-gray-800">
                                    <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">Recent On-Chain Activity</h4>
                                    <div className="text-xs text-gray-500 text-center py-2">
                                        Only available via Block Explorer
                                    </div>
                                </div>
                            </div>
                        )}
                    </Card>

                    <Card className="p-6 bg-gray-900 text-white border-0">
                        <h3 className="text-lg font-semibold mb-4 text-blue-100">Quick Stats</h3>
                        <div className="grid grid-cols-2 gap-4 text-center">
                            <div className="p-4 rounded-xl bg-gray-800/50">
                                <div className="text-3xl font-bold mb-1">${(transactions.reduce((acc: number, t: any) => acc + (t.amount > 0 ? t.amount : 0), 0) / 1000).toFixed(1)}k</div>
                                <div className="text-xs text-gray-400">Inflow (30d)</div>
                            </div>
                            <div className="p-4 rounded-xl bg-gray-800/50">
                                <div className="text-3xl font-bold mb-1">{transactions.length}</div>
                                <div className="text-xs text-gray-400">Transactions</div>
                            </div>
                        </div>
                    </Card>
                </div>

            </div>

            {/* Deposit Modal */}
            {showDepositModal && id && (
                <DepositModal
                    walletId={id}
                    walletName={wallet?.name || wallet?.wallet_address}
                    walletAddress={wallet?.walletAddress || wallet?.wallet_address}
                    blockchain={wallet?.blockchain}
                    walletType={wallet?.walletType || wallet?.wallet_type}
                    onClose={() => setShowDepositModal(false)}
                />
            )}

            {showWithdrawModal && id && (
                <WithdrawModal
                    walletId={id}
                    walletName={wallet?.name || wallet?.wallet_address}
                    walletAddress={wallet?.walletAddress || wallet?.wallet_address}
                    blockchain={wallet?.blockchain}
                    balance={parseFloat(wallet?.balance || '0')}
                    onClose={() => setShowWithdrawModal(false)}
                />
            )}
        </div>
    );
}

// ─── Auto-refill summary for agent_eoa wallets ────────────
// Replaces the SpendingPolicy editor for EOAs. EOAs don't have the
// `spendingPolicy` JSON that Circle/internal wallets carry — their
// budget governance is KYA limits + per-agent auto-refill policy.
// This card reads the policy from /v1/agents/:id/auto-refill and deep-
// links to the agent page where tenants can edit it inline.

function EoaAutoRefillCard({ wallet }: { wallet: any }) {
    const { authToken, apiUrl, apiEnvironment } = useApiConfig();
    const agentId = wallet.managedByAgentId || wallet.managed_by_agent_id;

    const { data: policy, isLoading } = useQuery({
        queryKey: ['wallet-auto-refill', agentId, apiEnvironment],
        queryFn: async () => {
            if (!authToken || !agentId) return null;
            const headers: Record<string, string> = {
                Authorization: `Bearer ${authToken}`,
            };
            if (apiEnvironment) headers['X-Environment'] = apiEnvironment;
            const res = await fetch(`${apiUrl}/v1/agents/${agentId}/auto-refill`, { headers });
            if (!res.ok) return null;
            const body = await res.json();
            return body.data || body;
        },
        enabled: !!authToken && !!agentId,
        staleTime: 30_000,
    });

    const enabled = !!policy?.enabled;
    const lastStatus: string | null = policy?.lastStatus || null;
    const statusClass =
        lastStatus === 'ok'
            ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400'
            : lastStatus === 'master_underfunded' || lastStatus === 'capped'
                ? 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400'
                : lastStatus
                    ? 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400'
                    : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300';

    return (
        <Card className="p-6">
            <div className="flex items-center justify-between mb-4">
                <div>
                    <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Auto-refill</h3>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                        Chain-native spending governance for this EOA.
                    </p>
                </div>
                <UIBadge variant={enabled ? 'default' : 'outline'}>
                    {enabled ? 'ON' : 'OFF'}
                </UIBadge>
            </div>

            {isLoading ? (
                <div className="h-24 bg-gray-100 dark:bg-gray-900 rounded animate-pulse" />
            ) : enabled ? (
                <div className="space-y-3">
                    <div className="grid grid-cols-3 gap-3 text-sm">
                        <div>
                            <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Threshold</div>
                            <div className="font-medium text-gray-900 dark:text-white">
                                {formatCurrency(policy?.threshold ?? 0, 'USDC')}
                            </div>
                        </div>
                        <div>
                            <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Target</div>
                            <div className="font-medium text-gray-900 dark:text-white">
                                {formatCurrency(policy?.target ?? 0, 'USDC')}
                            </div>
                        </div>
                        <div>
                            <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
                                Daily cap
                            </div>
                            <div className="font-medium text-gray-900 dark:text-white">
                                {formatCurrency(policy?.dailyCap ?? 0, 'USDC')}
                            </div>
                            <div className="text-[10px] text-gray-400 mt-0.5">
                                {formatCurrency(policy?.dailySpent ?? 0, 'USDC')} used today
                            </div>
                        </div>
                    </div>
                    {lastStatus && (
                        <div className={`text-xs px-3 py-1.5 rounded-md ${statusClass}`}>
                            Last run: {lastStatus}
                            {policy?.lastError && <div className="opacity-80 mt-0.5">{policy.lastError}</div>}
                        </div>
                    )}
                </div>
            ) : (
                <div className="text-sm text-gray-500 dark:text-gray-400 space-y-3">
                    <p>
                        Auto-refill is disabled. Enable it to have Sly keep this EOA topped up
                        from the tenant Circle master whenever it runs low.
                    </p>
                </div>
            )}

            {agentId && (
                <div className="mt-4 pt-3 border-t border-gray-200 dark:border-gray-800">
                    <Link
                        href={`/dashboard/agents/${agentId}?tab=wallet`}
                        className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
                    >
                        Configure on agent page →
                    </Link>
                </div>
            )}
        </Card>
    );
}
