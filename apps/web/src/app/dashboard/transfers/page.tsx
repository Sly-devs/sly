'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useApiClient, useApiConfig } from '@/lib/api-client';
import {
  ArrowLeftRight,
  Plus,
  Search,
  Filter,
  ArrowUpRight,
  Download,
  FileText,
  FileSpreadsheet,
  FileJson,
  X,
  ChevronDown,
  ExternalLink,
  CheckCircle,
  Bot,
  User,
  Zap,
} from 'lucide-react';
import Link from 'next/link';
import type { Transfer, TransferStatus, TransferType } from '@sly/api-client';
import { InitiatedByBadgeCompact } from '@/components/transactions/initiated-by-badge';
import { TableSkeleton } from '@/components/ui/skeletons';
import { TransactionsEmptyState, SearchEmptyState } from '@/components/ui/empty-state';
import { ExportModal } from '@/components/transfers/export-modal';
import { NewPaymentModal } from '@/components/modals/new-payment-modal';
import { usePagination } from '@/hooks/usePagination';
import { PaginationControls } from '@/components/ui/pagination-controls';
import { ProtocolBadge } from '@/components/agentic-payments/protocol-badge';
import { useTransferNotifications } from '@/hooks/use-transfer-notifications';
import { useRealtime } from '@/providers/realtime-provider';

export default function TransfersPage() {
  const router = useRouter();
  const api = useApiClient();
  const { isConfigured, isLoading: isAuthLoading } = useApiConfig();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [protocolFilter, setProtocolFilter] = useState<string>('all');
  const [initiatedByFilter, setInitiatedByFilter] = useState<string>('all');
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);

  const [showNewTransferModal, setShowNewTransferModal] = useState(false);

  const { isConnected } = useRealtime();

  // Fetch total count for pagination
  const { data: countData } = useQuery({
    queryKey: ['transfers', 'count'],
    queryFn: async () => {
      if (!api) throw new Error('API client not initialized');
      return api.transfers.list({ limit: 1 });
    },
    enabled: !!api && isConfigured,
    staleTime: 60 * 1000, // 1 minute
  });

  // Initialize pagination
  const pagination = usePagination({
    totalItems: (countData as any)?.data?.pagination?.total || (countData as any)?.pagination?.total || 0,
    initialPageSize: 50,
  });

  // Fetch transfers for current page with filters
  const { data: transfersData, isLoading: loading } = useQuery({
    queryKey: [
      'transfers',
      'page',
      pagination.page,
      pagination.pageSize,
      statusFilter,
      typeFilter,
      initiatedByFilter,
    ],
    queryFn: async () => {
      if (!api) throw new Error('API client not initialized');
      return api.transfers.list({
        page: pagination.page,
        limit: pagination.pageSize,
        status: statusFilter !== 'all' ? (statusFilter as TransferStatus) : undefined,
        type: typeFilter !== 'all' ? (typeFilter as TransferType) : undefined,
        initiated_by_type: initiatedByFilter !== 'all' ? (initiatedByFilter as 'agent' | 'user' | 'api_key') : undefined,
      });
    },
    enabled: !!api && isConfigured,
    staleTime: 5000, // Reduced stale time for live feel
    refetchInterval: 5000, // Poll every 5 seconds
  });

  // Enable notifications for status changes
  const rawData = (transfersData as any)?.data;
  const transfers = Array.isArray(rawData)
    ? rawData
    : (Array.isArray((rawData as any)?.data)
      ? (rawData as any).data
      : []);

  useTransferNotifications(transfers);

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed': return 'bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-400';
      case 'pending': return 'bg-yellow-100 dark:bg-yellow-950 text-yellow-700 dark:text-yellow-400';
      case 'processing': return 'bg-blue-100 dark:bg-blue-950 text-blue-700 dark:text-blue-400';
      case 'failed': return 'bg-red-100 dark:bg-red-950 text-red-700 dark:text-red-400';
      default: return 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-400';
    }
  };

  // Client-side filtering for search and initiatedBy (not yet supported by API)
  const filteredTransfers = transfers.filter((transfer: any) => {
    const matchesSearch =
      !search ||
      transfer.from?.accountName?.toLowerCase().includes(search.toLowerCase()) ||
      transfer.to?.accountName?.toLowerCase().includes(search.toLowerCase()) ||
      transfer.id.toLowerCase().includes(search.toLowerCase());

    const matchesInitiatedBy = initiatedByFilter === 'all' || transfer.initiatedBy?.type === initiatedByFilter;

    // Mock protocol check (assuming type maps to protocol or metadata)
    const matchesProtocol = protocolFilter === 'all'
      || (transfer.type === 'x402' && protocolFilter === 'x402')
      || ((transfer as any).protocolMetadata?.protocol === protocolFilter);

    return matchesSearch && matchesInitiatedBy && matchesProtocol;
  });

  const exportData = (format: 'csv' | 'json' | 'pdf') => {
    const data = filteredTransfers.map((t: any) => ({
      id: t.id,
      type: t.type,
      from: t.from?.accountName || 'External',
      to: t.to?.accountName || 'External',
      amount: t.amount,
      currency: t.currency,
      status: t.status,
      createdAt: t.createdAt,
    }));

    if (format === 'csv') {
      const headers = ['ID', 'Type', 'From', 'To', 'Amount', 'Currency', 'Status', 'Date'];
      const rows = data.map((d: any) => [d.id, d.type, d.from, d.to, d.amount, d.currency, d.status, d.createdAt]);
      const csv = [headers, ...rows].map((r: any) => r.join(',')).join('\n');
      downloadFile(csv, 'transactions.csv', 'text/csv');
    } else if (format === 'json') {
      const json = JSON.stringify(data, null, 2);
      downloadFile(json, 'transactions.json', 'application/json');
    } else {
      // For PDF, we'd typically use a library like jsPDF
      alert('PDF export coming soon!');
    }
    setShowExportMenu(false);
  };

  const downloadFile = (content: string, filename: string, type: string) => {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (isAuthLoading) {
    return (
      <div className="p-8 max-w-[1600px] mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">Transactions</h1>
            <p className="text-gray-600 dark:text-gray-400">View and manage all transfers</p>
          </div>
        </div>
        <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 overflow-hidden">
          <TableSkeleton rows={8} columns={6} />
        </div>
      </div>
    );
  }

  if (!isConfigured) {
    return (
      <div className="p-8">
        <div className="text-center py-12">
          <ArrowLeftRight className="h-12 w-12 text-gray-400 mx-auto mb-4" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Configure API Key</h2>
          <p className="text-gray-500 dark:text-gray-400 mt-2">
            Please configure your API key to view transactions.
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
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">Transactions</h1>
          <p className="text-gray-600 dark:text-gray-400">View and manage all transfers</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Live Indicator */}
          <div className="flex items-center gap-2 px-3 py-1.5 bg-white dark:bg-gray-950 rounded-full border border-gray-200 dark:border-gray-800 shadow-sm mr-2">
            <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-emerald-500 animate-pulse' : 'bg-gray-300'}`} />
            <span className="text-xs font-medium text-gray-600 dark:text-gray-300">
              {isConnected ? 'Live Updates' : 'Connecting...'}
            </span>
          </div>
          {/* Export Dropdown */}
          <div className="relative">
            <button
              onClick={() => setShowExportMenu(!showExportMenu)}
              className="flex items-center gap-2 px-4 py-2 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 text-gray-700 dark:text-gray-300 text-sm font-medium rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
            >
              <Download className="h-4 w-4" />
              Export
              <ChevronDown className="h-4 w-4" />
            </button>
            {showExportMenu && (
              <div className="absolute right-0 top-full mt-1 w-56 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg shadow-lg z-10">
                <div className="px-3 py-2 border-b border-gray-100 dark:border-gray-800">
                  <span className="text-xs font-medium text-gray-500 uppercase">Quick Export</span>
                </div>
                <button
                  onClick={() => { exportData('csv'); setShowExportMenu(false); }}
                  className="w-full px-4 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-800 flex items-center gap-2"
                >
                  <FileSpreadsheet className="h-4 w-4 text-emerald-500" />
                  Export as CSV
                </button>
                <button
                  onClick={() => { exportData('json'); setShowExportMenu(false); }}
                  className="w-full px-4 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-800 flex items-center gap-2"
                >
                  <FileJson className="h-4 w-4 text-blue-500" />
                  Export as JSON
                </button>
                <div className="border-t border-gray-100 dark:border-gray-800 mt-1 pt-1">
                  <button
                    onClick={() => { setShowExportModal(true); setShowExportMenu(false); }}
                    className="w-full px-4 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-800 flex items-center gap-2 text-blue-600"
                  >
                    <FileText className="h-4 w-4" />
                    Advanced Export (Accounting)
                  </button>
                </div>
              </div>
            )}
          </div>
          <button
            onClick={() => setShowNewTransferModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
          >
            <Plus className="h-4 w-4" />
            New Transfer
          </button>
        </div>
      </div>

      {/* Search and Filters */}
      <div className="flex items-center gap-4 mb-6">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search transactions..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 text-sm bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-4 py-2 text-sm bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="all">All Statuses</option>
          <option value="completed">Completed</option>
          <option value="pending">Pending</option>
          <option value="processing">Processing</option>
          <option value="failed">Failed</option>
        </select>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="px-4 py-2 text-sm bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="all">All Types</option>
          <option value="x402">⚡ x402 Payments</option>
          <option value="internal">Internal</option>
          <option value="cross_border">Cross-border</option>
          <option value="payout">Payout</option>
        </select>
        {/* NEW: Initiated By Filter */}
        <select
          value={initiatedByFilter}
          onChange={(e) => setInitiatedByFilter(e.target.value)}
          className="px-4 py-2 text-sm bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="all">All Initiators</option>
          <option value="agent">🤖 Agent</option>
          <option value="user">👤 Manual</option>
        </select>
        {/* Protocol Filter */}
        <select
          value={protocolFilter}
          onChange={(e) => setProtocolFilter(e.target.value)}
          className="px-4 py-2 text-sm bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="all">All Protocols</option>
          <option value="x402">⚡ x402</option>
          <option value="ap2">🤖 AP2</option>
          <option value="acp">🛒 ACP</option>
        </select>
      </div>

      {/* Results count */}
      <div className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        Showing {filteredTransfers.length} of {transfers.length} transactions
      </div>

      {/* Top Pagination Controls */}
      {!loading && filteredTransfers.length > 0 && (
        <PaginationControls
          pagination={pagination}
          className="mb-4"
        />
      )}

      {/* Transfers Table */}
      <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 overflow-hidden">
        {loading ? (
          <TableSkeleton rows={8} columns={6} />
        ) : filteredTransfers.length === 0 ? (
          (search || statusFilter !== 'all' || typeFilter !== 'all') ? (
            <SearchEmptyState query={search || 'filtered results'} />
          ) : (
            <TransactionsEmptyState />
          )
        ) : (
          <table className="w-full">
            <thead className="bg-gray-50 dark:bg-gray-900">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Type</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">From / To</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Amount</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Initiated By</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Status</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
              {filteredTransfers.map((transfer: any) => (
                <tr
                  key={transfer.id}
                  onClick={() => router.push(`/dashboard/transfers/${transfer.id}`)}
                  className="hover:bg-gray-50 dark:hover:bg-gray-900 cursor-pointer"
                >
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-2">
                      {transfer.type === 'x402' ? (
                        <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-purple-100 dark:bg-purple-950 text-purple-700 dark:text-purple-400 text-xs font-medium">
                          <Zap className="h-3 w-3" />
                          x402
                        </span>
                      ) : transfer.type === 'internal' ? (
                        <>
                          <ArrowLeftRight className="h-4 w-4 text-blue-500" />
                          <span className="text-sm text-gray-900 dark:text-white">Internal</span>
                        </>
                      ) : (
                        <>
                          <ArrowUpRight className="h-4 w-4 text-emerald-500" />
                          <span className="text-sm text-gray-900 dark:text-white capitalize">{transfer.type.replace('_', ' ')}</span>
                        </>
                      )}
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="text-sm">
                      <div className="text-gray-900 dark:text-white">{transfer.from?.accountName || 'External'}</div>
                      <div className="text-gray-500 dark:text-gray-400">→ {transfer.to?.accountName || 'External'}</div>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="text-sm font-medium text-gray-900 dark:text-white">
                      ${transfer.amount.toLocaleString()} {transfer.currency}
                    </div>
                    {transfer.feeAmount > 0 && (
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        Fee: ${transfer.feeAmount.toLocaleString()}
                      </div>
                    )}
                  </td>
                  {/* NEW: Initiated By Column */}
                  <td className="px-6 py-4">
                    {transfer.initiatedBy ? (
                      <InitiatedByBadgeCompact initiatedBy={transfer.initiatedBy} />
                    ) : (
                      <span className="inline-flex items-center gap-1 text-gray-500 dark:text-gray-400 text-xs">
                        <User className="w-3 h-3" />
                        Manual
                      </span>
                    )}
                  </td>
                  <td className="px-6 py-4">
                    <span className={`px-2.5 py-1 text-xs font-medium rounded-full ${getStatusColor(transfer.status)}`}>
                      {transfer.status}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-500 dark:text-gray-400">
                    {new Date(transfer.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination Controls */}
      {!loading && filteredTransfers.length > 0 && (
        <PaginationControls
          pagination={pagination}
          className="mt-6"
        />
      )}

      {/* Export Modal */}
      {showExportModal && (
        <ExportModal onClose={() => setShowExportModal(false)} />
      )}

      {/* New Transfer Modal */}
      <NewPaymentModal
        isOpen={showNewTransferModal}
        onClose={() => setShowNewTransferModal(false)}
        onSuccess={async () => {
          setShowNewTransferModal(false);
          // Invalidate transfers queries to refresh data
          queryClient.invalidateQueries({ queryKey: ['transfers'] });
        }}
        defaultType="transfer"
      />
    </div>
  );
}
