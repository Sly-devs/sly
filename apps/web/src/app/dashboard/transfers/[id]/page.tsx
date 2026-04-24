'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useApiClient, useApiConfig } from '@/lib/api-client';
import Link from 'next/link';
import {
  ArrowLeft,
  ArrowRight,
  DollarSign,
  Clock,
  User,
  Zap,
  FileText,
  CheckCircle,
  XCircle,
  AlertTriangle,
  ExternalLink,
  Wallet,
  Globe,
  RotateCcw,
} from 'lucide-react';
import type { Transfer } from '@sly/api-client';
import { RefundModal } from '@/components/transfers/refund-modal';
import { SettlementTimeline } from '@/components/transfers/settlement-timeline';
import { CallQualityPanel } from '@/components/transfers/call-quality-panel';

export default function TransferDetailPage() {
  const params = useParams();
  const router = useRouter();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const { isConfigured } = useApiConfig();
  const transferId = params.id as string;
  const [showRefundModal, setShowRefundModal] = useState(false);
  const [activeTab, setActiveTab] = useState<'overview' | 'settlement'>('overview');

  const { data: transfer, isLoading, error } = useQuery({
    queryKey: ['transfer', transferId],
    queryFn: () => api!.transfers.get(transferId),
    enabled: !!api && isConfigured,
  });

  // Handle potential nested response
  const transferData = transfer as any;
  const safeTransfer = transferData?.data || transferData;

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed':
        return 'bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-400';
      case 'pending':
        return 'bg-yellow-100 dark:bg-yellow-950 text-yellow-700 dark:text-yellow-400';
      case 'failed':
        return 'bg-red-100 dark:bg-red-950 text-red-700 dark:text-red-400';
      default:
        return 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-400';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'completed':
        return <CheckCircle className="h-5 w-5 text-emerald-600" />;
      case 'pending':
        return <Clock className="h-5 w-5 text-yellow-600" />;
      case 'failed':
        return <XCircle className="h-5 w-5 text-red-600" />;
      default:
        return <AlertTriangle className="h-5 w-5 text-gray-600" />;
    }
  };

  const getTypeColor = (type: string) => {
    switch (type) {
      case 'x402':
        return 'bg-purple-100 dark:bg-purple-950 text-purple-700 dark:text-purple-400';
      case 'internal':
        return 'bg-blue-100 dark:bg-blue-950 text-blue-700 dark:text-blue-400';
      case 'payout':
        return 'bg-orange-100 dark:bg-orange-950 text-orange-700 dark:text-orange-400';
      case 'mpp':
        return 'bg-orange-100 dark:bg-orange-950 text-orange-700 dark:text-orange-400';
      default:
        return 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-400';
    }
  };

  if (!isConfigured) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8 text-center">
        <FileText className="h-16 w-16 text-gray-400 mb-4" />
        <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-2">Configure API Key</h2>
        <p className="text-gray-600 dark:text-gray-400 mb-6">Please configure your API key to view transfer details.</p>
        <Link href="/dashboard/api-keys" className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors">
          Configure API Key
        </Link>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="p-8 max-w-[1600px] mx-auto">
        <div className="animate-pulse">
          <div className="h-8 w-48 bg-gray-200 dark:bg-gray-800 rounded mb-4"></div>
          <div className="h-4 w-96 bg-gray-200 dark:bg-gray-800 rounded mb-8"></div>
          <div className="grid grid-cols-3 gap-4 mb-8">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="h-32 bg-gray-200 dark:bg-gray-800 rounded-xl"></div>
            ))}
          </div>
          <div className="h-64 bg-gray-200 dark:bg-gray-800 rounded-xl"></div>
        </div>
      </div>
    );
  }

  if (error || !safeTransfer) {
    return (
      <div className="p-8 max-w-[1600px] mx-auto">
        <Link
          href="/dashboard/transfers"
          className="inline-flex items-center gap-2 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white mb-6"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to transfers
        </Link>
        <div className="text-center py-12">
          <XCircle className="h-16 w-16 text-red-400 mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">Transfer not found</h2>
          <p className="text-gray-500 dark:text-gray-400">
            The transfer with ID {transferId} could not be found.
          </p>
        </div>
      </div>
    );
  }

  const isX402 = safeTransfer.type === 'x402';

  return (
    <div className="p-8 max-w-[1600px] mx-auto">
      {/* Back button */}
      <Link
        href="/dashboard/transfers"
        className="inline-flex items-center gap-2 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white mb-6"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to transfers
      </Link>

      {/* Tabs */}
      <div className="flex items-center gap-1 bg-gray-100/50 dark:bg-gray-800/50 p-1 rounded-xl w-fit mb-8">
        <button
          onClick={() => setActiveTab('overview')}
          className={`px-4 py-2 text-sm font-medium rounded-lg transition-all ${activeTab === 'overview'
            ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm'
            : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
            }`}
        >
          Overview
        </button>
        <button
          onClick={() => setActiveTab('settlement')}
          className={`px-4 py-2 text-sm font-medium rounded-lg transition-all ${activeTab === 'settlement'
            ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm'
            : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
            }`}
        >
          Settlement
        </button>
      </div>

      {/* Overview Tab */}
      {activeTab === 'overview' && (
        <div className="space-y-6">
          {/* Transfer Flow */}
          <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Transfer Flow</h3>
            <div className="flex items-center justify-between">
              {/* From */}
              <div className="flex-1">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-xl bg-blue-100 dark:bg-blue-950 flex items-center justify-center">
                    <User className="h-6 w-6 text-blue-600" />
                  </div>
                  <div>
                    <p className="text-sm text-gray-500 dark:text-gray-400">From</p>
                    <p className="font-medium text-gray-900 dark:text-white">
                      {safeTransfer.from?.accountName || 'Unknown Account'}
                    </p>
                    <Link
                      href={`/dashboard/accounts/${safeTransfer.from?.accountId}`}
                      className="text-xs text-blue-600 hover:underline font-mono"
                    >
                      {safeTransfer.from?.accountId?.slice(0, 8)}...
                    </Link>
                  </div>
                </div>
              </div>

              {/* Arrow */}
              <div className="flex-shrink-0 px-8">
                <div className="flex items-center gap-2">
                  <div className="h-px w-12 bg-gray-300 dark:bg-gray-700"></div>
                  <ArrowRight className="h-6 w-6 text-gray-400" />
                  <div className="h-px w-12 bg-gray-300 dark:bg-gray-700"></div>
                </div>
                <p className="text-center text-sm font-medium text-gray-900 dark:text-white mt-1">
                  ${(safeTransfer.amount || 0).toFixed(4)}
                </p>
              </div>

              {/* To */}
              <div className="flex-1 text-right">
                <div className="flex items-center gap-3 justify-end">
                  <div>
                    <p className="text-sm text-gray-500 dark:text-gray-400">To</p>
                    <p className="font-medium text-gray-900 dark:text-white">
                      {safeTransfer.to?.accountName || 'Unknown Account'}
                    </p>
                    <Link
                      href={`/dashboard/accounts/${safeTransfer.to?.accountId}`}
                      className="text-xs text-blue-600 hover:underline font-mono"
                    >
                      {safeTransfer.to?.accountId?.slice(0, 8)}...
                    </Link>
                  </div>
                  <div className="w-12 h-12 rounded-xl bg-emerald-100 dark:bg-emerald-950 flex items-center justify-center">
                    <User className="h-6 w-6 text-emerald-600" />
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Transfer Details */}
            <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
                <FileText className="h-5 w-5" />
                Transfer Details
              </h3>
              <dl className="space-y-4">
                <div className="flex justify-between">
                  <dt className="text-gray-500 dark:text-gray-400">Transfer ID</dt>
                  <dd className="font-mono text-sm text-gray-900 dark:text-white">{safeTransfer.id}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-500 dark:text-gray-400">Type</dt>
                  <dd className="text-gray-900 dark:text-white capitalize">{safeTransfer.type}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-500 dark:text-gray-400">Status</dt>
                  <dd className="text-gray-900 dark:text-white capitalize">{safeTransfer.status}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-500 dark:text-gray-400">Amount</dt>
                  <dd className="font-mono text-gray-900 dark:text-white">
                    {(safeTransfer.amount || 0).toFixed(8)} {safeTransfer.currency}
                  </dd>
                </div>
                {(() => {
                  const fee = typeof safeTransfer.fees === 'number' ? safeTransfer.fees : safeTransfer.fees?.amount;
                  return fee && fee > 0 ? (
                    <div className="flex justify-between">
                      <dt className="text-gray-500 dark:text-gray-400">Fees</dt>
                      <dd className="font-mono text-gray-900 dark:text-white">
                        {fee.toFixed(2)} {safeTransfer.currency}
                      </dd>
                    </div>
                  ) : null;
                })()}
                <div className="flex justify-between">
                  <dt className="text-gray-500 dark:text-gray-400">Created</dt>
                  <dd className="text-gray-900 dark:text-white">
                    {new Date(safeTransfer.createdAt).toLocaleString()}
                  </dd>
                </div>
                {safeTransfer.completedAt && (
                  <div className="flex justify-between">
                    <dt className="text-gray-500 dark:text-gray-400">Completed</dt>
                    <dd className="text-gray-900 dark:text-white">
                      {new Date(safeTransfer.completedAt).toLocaleString()}
                    </dd>
                  </div>
                )}
                {safeTransfer.failedAt && (
                  <div className="flex justify-between">
                    <dt className="text-gray-500 dark:text-gray-400">Failed</dt>
                    <dd className="text-red-600">
                      {new Date(safeTransfer.failedAt).toLocaleString()}
                    </dd>
                  </div>
                )}
                {safeTransfer.failureReason && (
                  <div className="flex justify-between">
                    <dt className="text-gray-500 dark:text-gray-400">Failure Reason</dt>
                    <dd className="text-red-600">{safeTransfer.failureReason}</dd>
                  </div>
                )}
                {(safeTransfer as any).txHash && (
                  <div className="flex justify-between items-center">
                    <dt className="text-gray-500 dark:text-gray-400">Tx Hash</dt>
                    <dd className="flex items-center gap-2">
                      <span className="font-mono text-xs text-gray-900 dark:text-white">
                        {(safeTransfer as any).txHash.slice(0, 10)}...{(safeTransfer as any).txHash.slice(-8)}
                      </span>
                      <a
                        href={`https://sepolia.basescan.org/tx/${(safeTransfer as any).txHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-indigo-600 dark:text-indigo-400 hover:underline text-xs"
                      >
                        View on BaseScan &rarr;
                      </a>
                    </dd>
                  </div>
                )}
              </dl>
            </div>

            {/* Initiated By */}
            <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
                <User className="h-5 w-5" />
                Initiated By
              </h3>
              <dl className="space-y-4">
                <div className="flex justify-between">
                  <dt className="text-gray-500 dark:text-gray-400">Actor Type</dt>
                  <dd className="text-gray-900 dark:text-white capitalize">{safeTransfer.initiatedBy?.type || 'Unknown'}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-500 dark:text-gray-400">Actor ID</dt>
                  <dd className="font-mono text-sm text-gray-900 dark:text-white">{safeTransfer.initiatedBy?.id || 'N/A'}</dd>
                </div>
                {safeTransfer.initiatedBy?.name && (
                  <div className="flex justify-between">
                    <dt className="text-gray-500 dark:text-gray-400">Actor Name</dt>
                    <dd className="text-gray-900 dark:text-white">{safeTransfer.initiatedBy.name}</dd>
                  </div>
                )}
                {(safeTransfer.initiatedBy as any)?.erc8004AgentId && (
                  <div className="flex justify-between items-center">
                    <dt className="text-gray-500 dark:text-gray-400">On-Chain ID</dt>
                    <dd className="flex items-center gap-2">
                      <span className="font-mono text-sm text-gray-900 dark:text-white">
                        ERC-8004 #{(safeTransfer.initiatedBy as any).erc8004AgentId}
                      </span>
                      <a
                        href={`https://sepolia.basescan.org/nft/0x13b52042ef3e0e84d7ad49fdc1b71848b187a89c/${(safeTransfer.initiatedBy as any).erc8004AgentId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-indigo-600 dark:text-indigo-400 hover:underline text-xs"
                      >
                        Identity &rarr;
                      </a>
                    </dd>
                  </div>
                )}
                {(safeTransfer.initiatedBy as any)?.walletAddress && (
                  <div className="flex justify-between items-center">
                    <dt className="text-gray-500 dark:text-gray-400">Agent Wallet</dt>
                    <dd className="flex items-center gap-2">
                      <span className="font-mono text-xs text-gray-900 dark:text-white">
                        {(safeTransfer.initiatedBy as any).walletAddress.slice(0, 6)}...{(safeTransfer.initiatedBy as any).walletAddress.slice(-4)}
                      </span>
                      <a
                        href={`https://sepolia.basescan.org/address/${(safeTransfer.initiatedBy as any).walletAddress}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-indigo-600 dark:text-indigo-400 hover:underline text-xs"
                      >
                        All transfers &rarr;
                      </a>
                    </dd>
                  </div>
                )}
                {safeTransfer.idempotencyKey && (
                  <div className="flex justify-between">
                    <dt className="text-gray-500 dark:text-gray-400">Idempotency Key</dt>
                    <dd className="font-mono text-sm text-gray-900 dark:text-white">{safeTransfer.idempotencyKey}</dd>
                  </div>
                )}
              </dl>
            </div>
          </div>

          {/* External x402 (agent paid an on-chain address outside Sly) */}
          {isX402 && safeTransfer.x402Metadata && safeTransfer.x402Metadata.direction === 'external' && (() => {
            const m: any = safeTransfer.x402Metadata;
            const chainId = Number(m.chain_id);
            const network = chainId === 8453 ? 'base' : chainId === 84532 ? 'base-sepolia' : `eip155:${chainId}`;
            const scanBase =
              chainId === 8453 ? 'https://basescan.org' :
              chainId === 84532 ? 'https://sepolia.basescan.org' :
              null;
            const addrLink = (addr: string | undefined) => {
              if (!addr) return <span className="text-purple-400">—</span>;
              const short = `${addr.slice(0, 6)}…${addr.slice(-4)}`;
              return scanBase ? (
                <a href={`${scanBase}/address/${addr}`} target="_blank" rel="noopener noreferrer"
                   className="font-mono text-sm text-blue-600 dark:text-blue-400 hover:underline" title={addr}>
                  {short}
                </a>
              ) : (
                <code className="font-mono text-sm text-purple-900 dark:text-white" title={addr}>{short}</code>
              );
            };
            const validBeforeTs = Number(m.valid_before);
            const validBeforeLabel = Number.isFinite(validBeforeTs) && validBeforeTs > 0
              ? new Date(validBeforeTs * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
              : '—';
            const now = Math.floor(Date.now() / 1000);
            const expired = Number.isFinite(validBeforeTs) && validBeforeTs < now;
            const resource = m.resource && typeof m.resource === 'object' ? m.resource : null;
            return (
              <div className="bg-purple-50 dark:bg-gray-900 rounded-2xl border border-purple-200 dark:border-purple-500/30 p-6">
                <h3 className="text-lg font-semibold text-purple-900 dark:text-purple-300 mb-1 flex items-center gap-2">
                  <Zap className="h-5 w-5 text-purple-600 dark:text-purple-400" />
                  External x402 Authorization
                  <span className="ml-2 inline-flex items-center rounded bg-blue-100 dark:bg-blue-950 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-blue-700 dark:text-blue-300">
                    {network}
                  </span>
                  {resource?.marketplace && (
                    <span className="inline-flex items-center rounded bg-emerald-100 dark:bg-emerald-950 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
                      {resource.marketplace}
                    </span>
                  )}
                </h3>
                <p className="text-sm text-purple-700 dark:text-gray-400 mb-4">
                  Signed EIP-3009 <code>transferWithAuthorization</code> for an on-chain address outside the Sly ledger (e.g. an agentic.market service).
                </p>

                {/* Resource — what the agent paid for (vendor + endpoint + description) */}
                {resource && (resource.url || resource.host) && (
                  <div className="mb-5 p-4 bg-white/70 dark:bg-gray-800/70 rounded-xl border border-purple-100 dark:border-purple-900">
                    <h4 className="text-sm font-medium text-purple-700 dark:text-purple-400 mb-2 flex items-center gap-2">
                      <Globe className="h-4 w-4" />
                      Paid for
                    </h4>
                    <dl className="space-y-2 text-sm">
                      {resource.host && (
                        <div className="flex justify-between gap-4">
                          <dt className="text-purple-600 dark:text-gray-400 flex-shrink-0">Vendor</dt>
                          <dd className="font-mono text-purple-900 dark:text-white truncate">{resource.host}</dd>
                        </div>
                      )}
                      {resource.url && (
                        <div className="flex justify-between gap-4 items-start">
                          <dt className="text-purple-600 dark:text-gray-400 flex-shrink-0">Endpoint</dt>
                          <dd className="flex items-center gap-2 min-w-0">
                            <span className="inline-flex items-center rounded bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 text-[10px] font-mono text-gray-700 dark:text-gray-300 flex-shrink-0">
                              {resource.method || 'GET'}
                            </span>
                            <a href={resource.url} target="_blank" rel="noopener noreferrer"
                               className="font-mono text-xs text-blue-600 dark:text-blue-400 hover:underline truncate"
                               title={resource.url}>
                              {resource.path || resource.url}
                            </a>
                          </dd>
                        </div>
                      )}
                      {resource.description && (
                        <div className="pt-1">
                          <dt className="text-purple-600 dark:text-gray-400 mb-1">Description</dt>
                          <dd className="text-xs text-purple-900 dark:text-gray-200">{resource.description}</dd>
                        </div>
                      )}
                      {resource.mime_type && (
                        <div className="flex justify-between">
                          <dt className="text-purple-600 dark:text-gray-400">Response type</dt>
                          <dd className="font-mono text-xs text-purple-900 dark:text-white">{resource.mime_type}</dd>
                        </div>
                      )}
                    </dl>
                  </div>
                )}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="bg-white/50 dark:bg-gray-800/50 rounded-xl p-4">
                    <h4 className="text-sm font-medium text-purple-700 dark:text-purple-400 mb-3 flex items-center gap-2">
                      <Wallet className="h-4 w-4" />
                      On-chain parties
                    </h4>
                    <dl className="space-y-3">
                      <div className="flex justify-between items-center">
                        <dt className="text-purple-600 dark:text-gray-400 text-sm">From (agent EOA)</dt>
                        <dd>{addrLink(m.from_address)}</dd>
                      </div>
                      <div className="flex justify-between items-center">
                        <dt className="text-purple-600 dark:text-gray-400 text-sm">To (recipient)</dt>
                        <dd>{addrLink(m.to_address)}</dd>
                      </div>
                      <div className="flex justify-between items-center">
                        <dt className="text-purple-600 dark:text-gray-400 text-sm">Token (USDC)</dt>
                        <dd>{addrLink(m.token_address)}</dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-purple-600 dark:text-gray-400 text-sm">Chain ID</dt>
                        <dd className="font-mono text-sm text-purple-900 dark:text-white">{chainId || '—'}</dd>
                      </div>
                    </dl>
                  </div>

                  <div className="bg-white/50 dark:bg-gray-800/50 rounded-xl p-4">
                    <h4 className="text-sm font-medium text-purple-700 dark:text-purple-400 mb-3 flex items-center gap-2">
                      <FileText className="h-4 w-4" />
                      Signed payload
                    </h4>
                    <dl className="space-y-3">
                      <div className="flex justify-between">
                        <dt className="text-purple-600 dark:text-gray-400 text-sm">Value (micro-units)</dt>
                        <dd className="font-mono text-sm text-purple-900 dark:text-white">{m.token_value_microunits ?? '—'}</dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-purple-600 dark:text-gray-400 text-sm">Valid before</dt>
                        <dd className="font-mono text-xs text-purple-900 dark:text-white">
                          {validBeforeLabel}
                          {expired && <span className="ml-2 text-amber-600 dark:text-amber-400">(expired)</span>}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-purple-600 dark:text-gray-400 text-sm mb-1">Nonce</dt>
                        <dd className="font-mono text-[11px] break-all text-purple-900 dark:text-white">{m.nonce ?? '—'}</dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-purple-600 dark:text-gray-400 text-sm">Signature</dt>
                        <dd className="font-mono text-xs text-purple-900 dark:text-white" title="First 16 bytes of the 65-byte EIP-712 signature">
                          {m.signature_prefix ?? '—'}…
                        </dd>
                      </div>
                      <div className="flex justify-between items-center">
                        <dt className="text-purple-600 dark:text-gray-400 text-sm">Settlement tx</dt>
                        <dd>
                          {safeTransfer.txHash || (safeTransfer as any).tx_hash
                            ? (() => {
                                const h = safeTransfer.txHash || (safeTransfer as any).tx_hash;
                                return scanBase ? (
                                  <a href={`${scanBase}/tx/${h}`} target="_blank" rel="noopener noreferrer"
                                     className="font-mono text-xs text-blue-600 dark:text-blue-400 hover:underline">
                                    {h.slice(0, 10)}…{h.slice(-6)}
                                  </a>
                                ) : <code className="font-mono text-xs text-purple-900 dark:text-white">{h}</code>;
                              })()
                            : <span className="text-xs text-purple-400">not yet submitted on-chain</span>}
                        </dd>
                      </div>
                    </dl>
                  </div>
                </div>
                <div className="mt-4 p-3 bg-white/50 dark:bg-gray-800/50 rounded-lg text-xs text-purple-700 dark:text-gray-400">
                  Status <strong>pending</strong> means the authorization was signed and recorded — the facilitator has not yet submitted it on-chain, or hasn't reported settlement back.
                  Once the facilitator calls <code>transferWithAuthorization</code> and the tx is mined, the settlement tx hash populates above and status flips to <strong>completed</strong>.
                </div>

                {/* Failure classification — tells the owner WHY a call failed
                    (agentkit required / facilitator rejected / vendor backend
                    broken / etc) instead of just showing a raw HTTP status. */}
                {m.classification && (() => {
                  const c = m.classification;
                  const codeStyles: Record<string, string> = {
                    AGENTKIT_REQUIRED: 'bg-indigo-100 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300 border-indigo-300 dark:border-indigo-800',
                    NON_STANDARD_AUTH_PREPAY: 'bg-amber-100 dark:bg-amber-950 text-amber-700 dark:text-amber-300 border-amber-300 dark:border-amber-800',
                    FACILITATOR_REJECTED_SILENT: 'bg-rose-100 dark:bg-rose-950 text-rose-700 dark:text-rose-300 border-rose-300 dark:border-rose-800',
                    FACILITATOR_REJECTED_INVALID: 'bg-rose-100 dark:bg-rose-950 text-rose-700 dark:text-rose-300 border-rose-300 dark:border-rose-800',
                    VENDOR_BACKEND_ERROR: 'bg-orange-100 dark:bg-orange-950 text-orange-700 dark:text-orange-300 border-orange-300 dark:border-orange-800',
                    VENDOR_EMPTY_RESPONSE: 'bg-orange-100 dark:bg-orange-950 text-orange-700 dark:text-orange-300 border-orange-300 dark:border-orange-800',
                    AUTH_REQUIRED: 'bg-sky-100 dark:bg-sky-950 text-sky-700 dark:text-sky-300 border-sky-300 dark:border-sky-800',
                    FORBIDDEN: 'bg-red-100 dark:bg-red-950 text-red-700 dark:text-red-300 border-red-300 dark:border-red-800',
                    HTTP_CLIENT_ERROR: 'bg-yellow-100 dark:bg-yellow-950 text-yellow-700 dark:text-yellow-300 border-yellow-300 dark:border-yellow-800',
                    HTTP_SERVER_ERROR: 'bg-orange-100 dark:bg-orange-950 text-orange-700 dark:text-orange-300 border-orange-300 dark:border-orange-800',
                    UNKNOWN: 'bg-gray-100 dark:bg-gray-900 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-700',
                  };
                  const style = codeStyles[c.code] || codeStyles.UNKNOWN;
                  return (
                    <div className={`mt-6 p-4 rounded-xl border ${style}`}>
                      <div className="flex items-center gap-2 mb-2">
                        <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                        <span className="text-xs font-mono font-semibold uppercase tracking-wide">{c.code}</span>
                      </div>
                      <p className="text-sm mb-2">{c.explanation}</p>
                      {c.recommendation && (
                        <p className="text-xs opacity-80">
                          <strong>Next step:</strong> {c.recommendation}
                        </p>
                      )}
                    </div>
                  );
                })()}

                {/* Intent — what the agent said it was trying to accomplish at sign time.
                    Surfaced side-by-side with the response so the rater has the yardstick. */}
                {m.intent && (m.intent.reason || (Array.isArray(m.intent.expected_fields) && m.intent.expected_fields.length > 0)) && (
                  <div className="mt-6 p-4 bg-white/70 dark:bg-gray-800/70 rounded-xl border border-indigo-200 dark:border-indigo-900">
                    <h4 className="text-sm font-medium text-indigo-700 dark:text-indigo-300 mb-2">Agent intent</h4>
                    {m.intent.reason && (
                      <p className="text-sm text-gray-800 dark:text-gray-200 mb-2">{m.intent.reason}</p>
                    )}
                    {Array.isArray(m.intent.expected_fields) && m.intent.expected_fields.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        <span className="text-xs text-gray-500 dark:text-gray-400 mr-1">Expected fields:</span>
                        {m.intent.expected_fields.map((f: string) => (
                          <span key={f} className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-indigo-50 dark:bg-indigo-950 border border-indigo-200 dark:border-indigo-800 text-indigo-700 dark:text-indigo-300">
                            {f}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Response capture — lets the owner distinguish "paid and got real data"
                    from "paid but the upstream returned garbage / 500 / error envelope." */}
                {m.response && (() => {
                  const r = m.response;
                  const isSuccess = typeof r.status === 'number' && r.status >= 200 && r.status < 300;
                  return (
                    <div className="mt-6 p-4 bg-white/70 dark:bg-gray-800/70 rounded-xl border border-purple-100 dark:border-purple-900">
                      <h4 className="text-sm font-medium text-purple-700 dark:text-purple-400 mb-3 flex items-center gap-2">
                        <FileText className="h-4 w-4" />
                        Response from vendor
                        <span className={`inline-flex items-center rounded px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                          isSuccess
                            ? 'bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300'
                            : 'bg-red-100 dark:bg-red-950 text-red-700 dark:text-red-300'
                        }`}>
                          HTTP {r.status ?? '?'}{r.statusText ? ` · ${r.statusText}` : ''}
                        </span>
                      </h4>
                      <dl className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm mb-3">
                        <div>
                          <dt className="text-purple-600 dark:text-gray-400 text-xs">Size</dt>
                          <dd className="font-mono text-purple-900 dark:text-white">{r.sizeBytes != null ? `${r.sizeBytes} B` : '—'}</dd>
                        </div>
                        <div>
                          <dt className="text-purple-600 dark:text-gray-400 text-xs">Duration</dt>
                          <dd className="font-mono text-purple-900 dark:text-white">{r.durationMs != null ? `${r.durationMs} ms` : '—'}</dd>
                        </div>
                        <div>
                          <dt className="text-purple-600 dark:text-gray-400 text-xs">Content-Type</dt>
                          <dd className="font-mono text-xs text-purple-900 dark:text-white truncate" title={r.contentType || ''}>{r.contentType || '—'}</dd>
                        </div>
                        <div>
                          <dt className="text-purple-600 dark:text-gray-400 text-xs">Body</dt>
                          <dd className="font-mono text-purple-900 dark:text-white">{r.bodyIsJson ? 'JSON' : (r.sizeBytes === 0 ? 'empty' : 'text')}</dd>
                        </div>
                      </dl>
                      {r.bodyPreview != null && r.bodyPreview.length > 0 && (
                        <div className="mt-2">
                          <div className="text-xs text-purple-600 dark:text-gray-400 mb-1">
                            Body preview {r.sizeBytes > 2048 ? `(first 2048 of ${r.sizeBytes} bytes)` : `(${r.sizeBytes} bytes, full)`}
                          </div>
                          <pre className="font-mono text-[11px] bg-gray-50 dark:bg-gray-950 p-3 rounded border border-gray-200 dark:border-gray-800 text-gray-800 dark:text-gray-200 overflow-x-auto whitespace-pre-wrap break-all max-h-64">{r.bodyPreview}</pre>
                        </div>
                      )}
                      {r.sizeBytes === 0 && (
                        <div className="mt-2 text-xs text-amber-700 dark:text-amber-400">
                          Vendor returned empty body — likely a runtime error on their side even if the HTTP code was 2xx.
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            );
          })()}

          {/* Per-call quality rating panel — applies to any x402 transfer where the
              agent paid an external vendor (direction === 'external'). The rating
              feeds the vendor leaderboard's correctness column. */}
          {isX402 && safeTransfer.x402Metadata?.direction === 'external' && (
            <CallQualityPanel
              transferId={transferId}
              intent={safeTransfer.x402Metadata?.intent || null}
            />
          )}

          {/* Internal x402 Metadata Section (marketplace endpoint payments) */}
          {isX402 && safeTransfer.x402Metadata && safeTransfer.x402Metadata.direction !== 'external' && (
            <div className="bg-purple-50 dark:bg-gray-900 rounded-2xl border border-purple-200 dark:border-purple-500/30 p-6">
              <h3 className="text-lg font-semibold text-purple-900 dark:text-purple-300 mb-4 flex items-center gap-2">
                <Zap className="h-5 w-5 text-purple-600 dark:text-purple-400" />
                x402 Payment Details
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Endpoint Info */}
                <div className="bg-white/50 dark:bg-gray-800/50 rounded-xl p-4">
                  <h4 className="text-sm font-medium text-purple-700 dark:text-purple-400 mb-3 flex items-center gap-2">
                    <Globe className="h-4 w-4" />
                    Endpoint Information
                  </h4>
                  <dl className="space-y-3">
                    {safeTransfer.x402Metadata.endpoint_path && (
                      <div className="flex justify-between">
                        <dt className="text-purple-600 dark:text-gray-400">Path</dt>
                        <dd className="font-mono text-sm text-purple-900 dark:text-white">
                          {safeTransfer.x402Metadata.endpoint_path}
                        </dd>
                      </div>
                    )}
                    {safeTransfer.x402Metadata.endpoint_method && (
                      <div className="flex justify-between">
                        <dt className="text-purple-600 dark:text-gray-400">Method</dt>
                        <dd className="font-mono text-sm text-purple-900 dark:text-white">
                          {safeTransfer.x402Metadata.endpoint_method}
                        </dd>
                      </div>
                    )}
                    {safeTransfer.x402Metadata.endpoint_id && (
                      <div className="flex justify-between">
                        <dt className="text-purple-600 dark:text-gray-400">Endpoint ID</dt>
                        <dd className="font-mono text-xs text-purple-900 dark:text-white">
                          <Link
                            href={`/dashboard/x402/endpoints/${safeTransfer.x402Metadata.endpoint_id}`}
                            className="hover:underline flex items-center gap-1 text-purple-600 dark:text-purple-400"
                          >
                            {safeTransfer.x402Metadata.endpoint_id.slice(0, 8)}...
                            <ExternalLink className="h-3 w-3" />
                          </Link>
                        </dd>
                      </div>
                    )}
                  </dl>
                </div>

                {/* Wallet Info */}
                <div className="bg-white/50 dark:bg-gray-800/50 rounded-xl p-4">
                  <h4 className="text-sm font-medium text-purple-700 dark:text-purple-400 mb-3 flex items-center gap-2">
                    <Wallet className="h-4 w-4" />
                    Wallet & Settlement
                  </h4>
                  <dl className="space-y-3">
                    {safeTransfer.x402Metadata.wallet_id && (
                      <div className="flex justify-between">
                        <dt className="text-purple-600 dark:text-gray-400">Wallet ID</dt>
                        <dd className="font-mono text-xs text-purple-900 dark:text-white">
                          <Link
                            href={`/dashboard/wallets?search=${safeTransfer.x402Metadata.wallet_id}`}
                            className="hover:underline flex items-center gap-1 text-purple-600 dark:text-purple-400"
                          >
                            {safeTransfer.x402Metadata.wallet_id.slice(0, 8)}...
                            <ExternalLink className="h-3 w-3" />
                          </Link>
                        </dd>
                      </div>
                    )}
                    {safeTransfer.x402Metadata.price_calculated !== undefined && (
                      <div className="flex justify-between">
                        <dt className="text-purple-600 dark:text-gray-400">Price</dt>
                        <dd className="font-mono text-sm text-purple-900 dark:text-white">
                          ${safeTransfer.x402Metadata.price_calculated?.toFixed(4)}
                        </dd>
                      </div>
                    )}
                  </dl>
                </div>
              </div>

              {/* Request Info */}
              <div className="mt-6 pt-6 border-t border-purple-200 dark:border-gray-700">
                <h4 className="text-sm font-medium text-purple-700 dark:text-purple-400 mb-3 flex items-center gap-2">
                  <FileText className="h-4 w-4" />
                  Request Details
                </h4>
                <dl className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {safeTransfer.x402Metadata.request_id && (
                    <div className="bg-white/50 dark:bg-gray-800/50 rounded-lg p-3">
                      <dt className="text-purple-600 dark:text-gray-400 text-sm">Request ID</dt>
                      <dd className="font-mono text-xs text-purple-900 dark:text-white mt-1">
                        {safeTransfer.x402Metadata.request_id}
                      </dd>
                    </div>
                  )}
                  {safeTransfer.x402Metadata.timestamp && (
                    <div className="bg-white/50 dark:bg-gray-800/50 rounded-lg p-3">
                      <dt className="text-purple-600 dark:text-gray-400 text-sm">Timestamp</dt>
                      <dd className="font-mono text-xs text-purple-900 dark:text-white mt-1">
                        {safeTransfer.x402Metadata.timestamp}
                      </dd>
                    </div>
                  )}
                  {safeTransfer.x402Metadata.volume_tier !== undefined && (
                    <div className="bg-white/50 dark:bg-gray-800/50 rounded-lg p-3">
                      <dt className="text-purple-600 dark:text-gray-400 text-sm">Volume Tier</dt>
                      <dd className="font-mono text-xs text-purple-900 dark:text-white mt-1">
                        {safeTransfer.x402Metadata.volume_tier} calls
                      </dd>
                    </div>
                  )}
                </dl>
              </div>
            </div>
          )}

          {/* MPP Metadata Section */}
          {safeTransfer.type === 'mpp' && safeTransfer.protocolMetadata && (
            <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
                <DollarSign className="h-5 w-5" />
                MPP Payment Details
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Service Info */}
                <div className="bg-gray-50 dark:bg-gray-800/50 rounded-xl p-4">
                  <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3 flex items-center gap-2">
                    <Globe className="h-4 w-4" />
                    Service Information
                  </h4>
                  <dl className="space-y-3">
                    {safeTransfer.protocolMetadata.service_url && (
                      <div className="flex justify-between">
                        <dt className="text-gray-500 dark:text-gray-400">Service URL</dt>
                        <dd className="font-mono text-sm text-gray-900 dark:text-white truncate max-w-[200px]">
                          {safeTransfer.protocolMetadata.service_url}
                        </dd>
                      </div>
                    )}
                    {safeTransfer.protocolMetadata.payment_method && (
                      <div className="flex justify-between">
                        <dt className="text-gray-500 dark:text-gray-400">Payment Method</dt>
                        <dd className="font-mono text-sm text-gray-900 dark:text-white capitalize">
                          {safeTransfer.protocolMetadata.payment_method}
                        </dd>
                      </div>
                    )}
                    {safeTransfer.protocolMetadata.intent && (
                      <div className="flex justify-between">
                        <dt className="text-gray-500 dark:text-gray-400">Intent</dt>
                        <dd className="text-sm text-gray-900 dark:text-white">
                          {safeTransfer.protocolMetadata.intent}
                        </dd>
                      </div>
                    )}
                  </dl>
                </div>
                {/* Settlement Info */}
                <div className="bg-gray-50 dark:bg-gray-800/50 rounded-xl p-4">
                  <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3 flex items-center gap-2">
                    <Wallet className="h-4 w-4" />
                    Settlement
                  </h4>
                  <dl className="space-y-3">
                    {safeTransfer.protocolMetadata.receipt_id && (
                      <div className="flex justify-between">
                        <dt className="text-gray-500 dark:text-gray-400">Receipt ID</dt>
                        <dd className="font-mono text-xs text-gray-900 dark:text-white">
                          {safeTransfer.protocolMetadata.receipt_id}
                        </dd>
                      </div>
                    )}
                    {safeTransfer.protocolMetadata.settlement_network && (
                      <div className="flex justify-between">
                        <dt className="text-gray-500 dark:text-gray-400">Network</dt>
                        <dd className="font-mono text-sm text-gray-900 dark:text-white">
                          {safeTransfer.protocolMetadata.settlement_network}
                        </dd>
                      </div>
                    )}
                    {safeTransfer.protocolMetadata.settlement_tx_hash && (
                      <div className="flex justify-between">
                        <dt className="text-gray-500 dark:text-gray-400">Tx Hash</dt>
                        <dd className="font-mono text-xs text-gray-900 dark:text-white truncate max-w-[200px]">
                          {safeTransfer.protocolMetadata.settlement_tx_hash}
                        </dd>
                      </div>
                    )}
                    {safeTransfer.protocolMetadata.verified_at && (
                      <div className="flex justify-between">
                        <dt className="text-gray-500 dark:text-gray-400">Verified</dt>
                        <dd className="text-sm text-gray-900 dark:text-white">
                          {new Date(safeTransfer.protocolMetadata.verified_at).toLocaleString()}
                        </dd>
                      </div>
                    )}
                  </dl>
                </div>
              </div>
            </div>
          )}

          {/* Cross-Border Details */}
          {(safeTransfer.destinationAmount || safeTransfer.fxRate) && (
            <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
                <Globe className="h-5 w-5" />
                Cross-Border Details
              </h3>
              <dl className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {safeTransfer.destinationAmount && (
                  <div>
                    <dt className="text-gray-500 dark:text-gray-400 text-sm">Destination Amount</dt>
                    <dd className="font-mono text-gray-900 dark:text-white">
                      {safeTransfer.destinationAmount.toFixed(2)} {safeTransfer.destinationCurrency}
                    </dd>
                  </div>
                )}
                {safeTransfer.fxRate && (
                  <div>
                    <dt className="text-gray-500 dark:text-gray-400 text-sm">Exchange Rate</dt>
                    <dd className="font-mono text-gray-900 dark:text-white">
                      {safeTransfer.fxRate.toFixed(4)}
                    </dd>
                  </div>
                )}
              </dl>
            </div>
          )}

          {/* Stream Link */}
          {safeTransfer.streamId && (
            <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Related Stream</h3>
              <Link
                href={`/dashboard/streams/${safeTransfer.streamId}`}
                className="inline-flex items-center gap-2 text-blue-600 hover:underline"
              >
                View Stream
                <ExternalLink className="h-4 w-4" />
              </Link>
            </div>
          )}
        </div>
      )}

      {/* Settlement Tab */}
      {activeTab === 'settlement' && (
        <div className="space-y-6">
          <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-6 flex items-center gap-2">
              <Clock className="h-5 w-5" />
              Settlement Timeline
            </h3>

            <SettlementTimeline transfer={safeTransfer} />
          </div>

          {isX402 && safeTransfer.x402Metadata && (
            <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Net Settlement Breakdown</h3>
              <dl className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div>
                  <dt className="text-gray-500 dark:text-gray-400 text-sm">Gross Amount</dt>
                  <dd className="mt-1 text-2xl font-bold text-gray-900 dark:text-white">
                    ${safeTransfer.x402Metadata.fee_calculation?.grossAmount?.toFixed(4) || safeTransfer.amount.toFixed(4)}
                  </dd>
                </div>
                <div>
                  <dt className="text-gray-500 dark:text-gray-400 text-sm">Total Fees</dt>
                  <dd className="mt-1 text-2xl font-bold text-red-600 dark:text-red-400">
                    -${safeTransfer.x402Metadata.fee_calculation?.feeAmount?.toFixed(4) || (typeof safeTransfer.fees === 'number' ? safeTransfer.fees : safeTransfer.fees?.amount || 0).toFixed(4)}
                  </dd>
                </div>
                <div>
                  <dt className="text-gray-500 dark:text-gray-400 text-sm">Net Settled</dt>
                  <dd className="mt-1 text-2xl font-bold text-emerald-600 dark:text-emerald-400">
                    ${safeTransfer.x402Metadata.fee_calculation?.netAmount?.toFixed(4) || (safeTransfer.amount - (typeof safeTransfer.fees === 'number' ? safeTransfer.fees : safeTransfer.fees?.amount || 0)).toFixed(4)}
                  </dd>
                </div>
              </dl>
            </div>
          )}
        </div>
      )}

      {/* Refund Modal */}
      {showRefundModal && safeTransfer && (
        <RefundModal
          transfer={safeTransfer as Transfer}
          onClose={() => setShowRefundModal(false)}
          onSuccess={async () => {
            setShowRefundModal(false);
            queryClient.invalidateQueries({ queryKey: ['transfer', transferId] });
            router.push('/dashboard/refunds');
          }}
        />
      )}
    </div>
  );
}


