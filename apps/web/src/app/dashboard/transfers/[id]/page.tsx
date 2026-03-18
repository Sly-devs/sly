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

          {/* x402 Metadata Section */}
          {isX402 && safeTransfer.x402Metadata && (
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


