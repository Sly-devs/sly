'use client';

/**
 * x402 Endpoint Detail Page
 * 
 * Detailed view of a specific x402 endpoint with analytics, configuration, and transaction history.
 */

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useApiClient } from '@/lib/api-client';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Badge,
  Button,
  StatCard,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger
} from '@sly/ui';
import { TableSkeleton } from '@/components/ui/skeletons';
import {
  DollarSign,
  TrendingUp,
  BarChart3,
  Users,
  Webhook,
  ArrowLeft,
  Copy,
  CheckCircle2,
  ExternalLink,
  Globe,
  Rocket,
  Pencil
} from 'lucide-react';
import { PublishStatusBadge } from '@/components/x402/publish-status-badge';
import { PublicationTimeline } from '@/components/x402/publication-timeline';
import { PublishToMarketDialog } from '@/components/x402/publish-to-market-dialog';
import { EditEndpointDialog } from '@/components/x402/edit-endpoint-dialog';
import type { X402Endpoint, X402PublishEvent, X402PublishStatusResponse } from '@sly/api-client';

export default function X402EndpointDetailPage() {
  const params = useParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const api = useApiClient();
  const endpointId = params.id as string;
  const [copiedCode, setCopiedCode] = useState(false);
  const [copiedGateway, setCopiedGateway] = useState(false);
  const [publishDialogOpen, setPublishDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);

  // Fetch endpoint details
  const { data: endpointData, isLoading: endpointLoading } = useQuery({
    queryKey: ['x402', 'endpoint', endpointId],
    queryFn: () => api!.x402Endpoints.get(endpointId),
    enabled: !!api,
  });

  // Fetch endpoint analytics
  const { data: analyticsData, isLoading: analyticsLoading } = useQuery({
    queryKey: ['x402', 'analytics', 'endpoint', endpointId],
    queryFn: () => api!.x402Analytics.getEndpointAnalytics(endpointId),
    enabled: !!api,
  });

  // Fetch endpoint transactions
  const { data: transactionsData, isLoading: transactionsLoading } = useQuery({
    queryKey: ['x402', 'endpoint', endpointId, 'transactions'],
    queryFn: () => api!.transfers.list({ type: 'x402', endpointId, limit: 20 }),
    enabled: !!api,
  });

  // Fetch publish status + event timeline (Worktree D — agentic.market publish lifecycle).
  const { data: publishStatusData } = useQuery({
    queryKey: ['x402', 'endpoint', endpointId, 'publish-status'],
    queryFn: () => api!.x402Endpoints.getPublishStatus(endpointId),
    enabled: !!api,
    // Refresh every 10s while in a non-terminal state; otherwise stale-only.
    refetchInterval: (query) => {
      const data = query.state.data as X402PublishStatusResponse | undefined;
      const status = data?.publishStatus;
      if (status === 'validating' || status === 'publishing' || status === 'processing') {
        return 10_000;
      }
      return false;
    },
  });

  // Handle double-nested API responses
  const rawEndpoint = (endpointData as any);
  const endpoint: X402Endpoint | undefined = rawEndpoint?.data?.data || rawEndpoint?.data || rawEndpoint;

  // Publish-status response is already typed; the API may double-wrap.
  const rawPublishStatus = (publishStatusData as any);
  const publishStatus: X402PublishStatusResponse | undefined =
    rawPublishStatus?.data?.data || rawPublishStatus?.data || rawPublishStatus;
  const publishEvents: X402PublishEvent[] = publishStatus?.events ?? [];

  // Effective publish lifecycle status — prefer the live poll, fall back to
  // whatever the endpoint row carried at fetch time.
  const effectivePublishStatus =
    publishStatus?.publishStatus ?? endpoint?.publishStatus ?? 'draft';
  const isPublished = effectivePublishStatus === 'published';
  const catalogServiceId = publishStatus?.catalogServiceId ?? endpoint?.catalogServiceId ?? null;
  const gatewayUrl = publishStatus?.gatewayUrl ?? endpoint?.gatewayUrl ?? null;
  const serviceSlug = endpoint?.serviceSlug ?? null;

  const publicListingUrl = catalogServiceId
    ? `https://agentic.market/services/${catalogServiceId}`
    : serviceSlug
      ? `https://api.agentic.market/v1/services/search?q=${encodeURIComponent(serviceSlug)}`
      : null;

  const rawAnalytics = (analyticsData as any);
  // Analytics might be in root, data, or data.data
  const analytics = rawAnalytics?.data?.data || rawAnalytics?.data || rawAnalytics || {};

  const rawTransactions = (transactionsData as any);
  const transactions = Array.isArray(rawTransactions)
    ? rawTransactions
    : (Array.isArray(rawTransactions?.data)
      ? rawTransactions.data
      : (Array.isArray(rawTransactions?.data?.data) ? rawTransactions.data.data : []));

  // Generate SDK code samples
  const providerSdkSample = `import { X402Provider } from '@sly/x402-provider-sdk';

const provider = new X402Provider({
  apiUrl: 'https://api.payos.com',
  auth: 'your-api-key',
  accountId: 'your-account-id'
});

// Register this endpoint
await provider.registerEndpoint('${endpoint?.path || '/api/endpoint'}', '${endpoint?.method || 'GET'}', {
  name: '${endpoint?.name || 'My API'}',
  basePrice: ${endpoint?.basePrice || '0.001'},
  currency: '${endpoint?.currency || 'USDC'}'
});

// Add middleware to your API
app.use('${endpoint?.path || '/api/endpoint'}', provider.middleware());
`;

  const consumerSdkSample = `import { X402Client } from '@sly/x402-client-sdk';

const client = new X402Client({
  apiUrl: 'https://api.payos.com',
  walletId: 'your-wallet-id',
  auth: 'your-api-key',
  debug: true
});

// Make a request (payment handled automatically)
const response = await client.fetch('https://your-api.com${endpoint?.path || '/api/endpoint'}', {
  autoRetry: true,
  onPayment: (payment) => {
    console.log('Payment processed:', payment);
  }
});
`;

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  if (endpointLoading) {
    return (
      <div className="p-8 max-w-[1600px] mx-auto">
        <TableSkeleton rows={8} columns={2} />
      </div>
    );
  }

  if (!endpoint) {
    return (
      <div className="p-8 max-w-[1600px] mx-auto text-center">
        <p className="text-gray-500">Endpoint not found</p>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-[1600px] mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" onClick={() => router.push('/dashboard/x402')}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back
          </Button>
          <div>
            <h1 className="text-3xl font-bold tracking-tight">{endpoint.name}</h1>
            <p className="text-gray-500 dark:text-gray-400 mt-1">
              {endpoint.method} {endpoint.path}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Badge variant={endpoint.status === 'active' ? 'default' : 'secondary'}>
            {endpoint.status}
          </Badge>
          <PublishStatusBadge status={effectivePublishStatus} />
          <Button variant="outline" onClick={() => setEditDialogOpen(true)}>
            <Pencil className="h-4 w-4 mr-2" />
            Edit
          </Button>
          <Button onClick={() => setPublishDialogOpen(true)}>
            <Rocket className="h-4 w-4 mr-2" />
            {isPublished ? 'Manage publication' : 'Publish to Agentic.Market'}
          </Button>
        </div>
      </div>

      {/* Public listing + gateway URL */}
      {(isPublished || gatewayUrl) && (
        <Card>
          <CardContent className="flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between">
            {gatewayUrl && (
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <Globe className="h-4 w-4 text-blue-600 dark:text-blue-400 shrink-0" />
                <span className="text-xs text-gray-500 dark:text-gray-400 shrink-0">Gateway:</span>
                <code className="text-sm font-mono truncate">{gatewayUrl}</code>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    navigator.clipboard.writeText(gatewayUrl);
                    setCopiedGateway(true);
                    setTimeout(() => setCopiedGateway(false), 2000);
                  }}
                >
                  {copiedGateway ? (
                    <CheckCircle2 className="h-4 w-4" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
              </div>
            )}
            {isPublished && publicListingUrl && (
              <Link
                href={publicListingUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline dark:text-blue-400 shrink-0"
              >
                <ExternalLink className="h-4 w-4" />
                View public listing
              </Link>
            )}
          </CardContent>
        </Card>
      )}

      {/* Analytics Stats */}
      {analyticsLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          <TableSkeleton rows={1} columns={1} />
          <TableSkeleton rows={1} columns={1} />
          <TableSkeleton rows={1} columns={1} />
          <TableSkeleton rows={1} columns={1} />
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          <StatCard
            title="Revenue"
            value={`$${(analytics?.metrics?.revenue || analytics?.revenue || analytics?.total_revenue || 0).toFixed(4)}`}
            description={`Net: $${(analytics?.metrics?.netRevenue || analytics?.metrics?.net_revenue || analytics?.net_revenue || analytics?.netRevenue || 0).toFixed(4)}`}
            icon={<DollarSign className="h-5 w-5" />}
            trend={analytics?.metrics?.revenue > 0 ? { value: analytics.metrics.revenue } : undefined}
          />
          <StatCard
            title="API Calls"
            value={(analytics?.metrics?.calls || analytics?.calls || analytics?.total_calls || 0).toLocaleString()}
            description={`${(analytics?.metrics?.successRate || analytics?.metrics?.success_rate || analytics?.success_rate || 0).toFixed(1)}% success`}
            icon={<BarChart3 className="h-5 w-5" />}
          />
          <StatCard
            title="Unique Payers"
            value={(analytics?.metrics?.uniquePayers || analytics?.metrics?.unique_payers || analytics?.unique_payers || 0).toLocaleString()}
            description="Consumers"
            icon={<Users className="h-5 w-5" />}
          />
          <StatCard
            title="Avg Call Value"
            value={`$${(analytics?.metrics?.averageCallValue || analytics?.metrics?.average_call_value || analytics?.average_call_value || 0).toFixed(4)}`}
            description={`${endpoint.currency}`}
            icon={<TrendingUp className="h-5 w-5" />}
          />
        </div>
      )}

      {/* Tabs */}
      <Tabs defaultValue="overview" className="space-y-6">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="transactions">Transactions</TabsTrigger>
          <TabsTrigger value="integration">Integration</TabsTrigger>
        </TabsList>

        {/* Overview Tab */}
        <TabsContent value="overview" className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Endpoint Configuration */}
            <Card>
              <CardHeader>
                <CardTitle>Configuration</CardTitle>
                <CardDescription>Endpoint settings and pricing</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <span className="text-sm text-gray-600 dark:text-gray-400">Base Price</span>
                  <p className="font-medium font-mono">
                    {Number(endpoint.basePrice).toFixed(4)} {endpoint.currency}
                  </p>
                </div>
                <div>
                  <span className="text-sm text-gray-600 dark:text-gray-400">Method</span>
                  <p className="font-medium">{endpoint.method}</p>
                </div>
                <div>
                  <span className="text-sm text-gray-600 dark:text-gray-400">Path</span>
                  <p className="font-medium font-mono">{endpoint.path}</p>
                </div>
                {endpoint.description && (
                  <div>
                    <span className="text-sm text-gray-600 dark:text-gray-400">Description</span>
                    <p className="text-sm">{endpoint.description}</p>
                  </div>
                )}
                {endpoint.webhookUrl && (
                  <div>
                    <span className="text-sm text-gray-600 dark:text-gray-400 flex items-center gap-2">
                      <Webhook className="h-4 w-4" />
                      Webhook URL
                    </span>
                    <p className="text-sm font-mono break-all">{endpoint.webhookUrl}</p>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Revenue Breakdown */}
            <Card>
              <CardHeader>
                <CardTitle>Revenue Breakdown</CardTitle>
                <CardDescription>Last 30 days</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-600 dark:text-gray-400">Gross Revenue</span>
                  <span className="font-medium">${(analytics?.metrics?.revenue || analytics?.revenue || analytics?.total_revenue || 0).toFixed(4)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-600 dark:text-gray-400">Platform Fees</span>
                  <span className="font-medium text-red-600 dark:text-red-400">
                    -${(analytics?.metrics?.fees || analytics?.fees || 0).toFixed(4)}
                  </span>
                </div>
                <div className="h-px bg-gray-200 dark:bg-gray-800" />
                <div className="flex items-center justify-between">
                  <span className="font-medium">Net Revenue</span>
                  <span className="text-lg font-bold text-green-600 dark:text-green-400">
                    ${(analytics?.metrics?.netRevenue || analytics?.netRevenue || analytics?.net_revenue || 0).toFixed(4)}
                  </span>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Publication Timeline */}
          <PublicationTimeline events={publishEvents} />
        </TabsContent>

        {/* Transactions Tab */}
        <TabsContent value="transactions">
          <Card>
            <CardHeader>
              <CardTitle>Recent Transactions</CardTitle>
              <CardDescription>
                Payment history for this endpoint
              </CardDescription>
            </CardHeader>
            <CardContent>
              {transactionsLoading ? (
                <TableSkeleton rows={5} columns={5} />
              ) : transactions.length === 0 ? (
                <div className="text-center py-12 text-gray-500">
                  <BarChart3 className="h-12 w-12 mx-auto mb-4 text-gray-400" />
                  <p>No transactions yet</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b">
                        <th className="text-left p-3 font-medium">Date</th>
                        <th className="text-left p-3 font-medium">Source</th>
                        <th className="text-left p-3 font-medium">Payer</th>
                        <th className="text-right p-3 font-medium">Amount</th>
                        <th className="text-left p-3 font-medium">Tx</th>
                        <th className="text-left p-3 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {transactions.map((tx: any) => {
                        // Source comes from initiatedByName (agentic.market,
                        // a2a, x402-fetch, direct, …). Falls back to the
                        // wallet address when no source was derivable.
                        const source =
                          tx.protocolMetadata?.discovery_source ||
                          tx.protocol_metadata?.discovery_source ||
                          tx.initiatedByName ||
                          tx.initiated_by_name ||
                          'direct';
                        const payer =
                          tx.protocolMetadata?.payer_wallet ||
                          tx.protocol_metadata?.payer_wallet ||
                          tx.initiatedById ||
                          tx.initiated_by_id ||
                          tx.from?.accountId ||
                          '';
                        const txHash = tx.txHash || tx.tx_hash || tx.externalTxHash || tx.external_tx_hash;
                        const network = tx.settlementNetwork || tx.settlement_network || '';
                        const explorerUrl =
                          txHash && network.includes('8453')
                            ? `https://basescan.org/tx/${txHash}`
                            : null;
                        return (
                          <tr
                            key={tx.id}
                            className="border-b hover:bg-gray-50 dark:hover:bg-gray-900"
                          >
                            <td className="p-3 text-sm">
                              {new Date(tx.createdAt).toLocaleString()}
                            </td>
                            <td className="p-3 text-sm">
                              <Badge variant="secondary">{source}</Badge>
                            </td>
                            <td className="p-3 text-sm font-mono">
                              {payer ? `${payer.slice(0, 6)}…${payer.slice(-4)}` : 'N/A'}
                            </td>
                            <td className="p-3 text-right font-medium">
                              {parseFloat(tx.amount).toFixed(4)} {tx.currency}
                            </td>
                            <td className="p-3 text-sm font-mono">
                              {explorerUrl ? (
                                <a
                                  href={explorerUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-blue-600 hover:underline dark:text-blue-400"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  {txHash.slice(0, 6)}…{txHash.slice(-4)}
                                </a>
                              ) : txHash ? (
                                <span>{txHash.slice(0, 6)}…{txHash.slice(-4)}</span>
                              ) : (
                                <span className="text-gray-400">—</span>
                              )}
                            </td>
                            <td className="p-3">
                              <Badge variant={tx.status === 'completed' ? 'default' : 'secondary'}>
                                {tx.status}
                              </Badge>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Integration Tab */}
        <TabsContent value="integration" className="space-y-6">
          {/* Provider SDK */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>Provider SDK Integration</CardTitle>
                <CardDescription>
                  Add x402 payment middleware to your API
                </CardDescription>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => copyToClipboard(providerSdkSample)}
              >
                {copiedCode ? (
                  <CheckCircle2 className="h-4 w-4 mr-2" />
                ) : (
                  <Copy className="h-4 w-4 mr-2" />
                )}
                Copy
              </Button>
            </CardHeader>
            <CardContent>
              <pre className="p-4 bg-gray-100 dark:bg-gray-900 rounded-lg overflow-x-auto">
                <code className="text-sm">{providerSdkSample}</code>
              </pre>
            </CardContent>
          </Card>

          {/* Consumer SDK */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>Consumer SDK Integration</CardTitle>
                <CardDescription>
                  Call this endpoint with automatic payment handling
                </CardDescription>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => copyToClipboard(consumerSdkSample)}
              >
                {copiedCode ? (
                  <CheckCircle2 className="h-4 w-4 mr-2" />
                ) : (
                  <Copy className="h-4 w-4 mr-2" />
                )}
                Copy
              </Button>
            </CardHeader>
            <CardContent>
              <pre className="p-4 bg-gray-100 dark:bg-gray-900 rounded-lg overflow-x-auto">
                <code className="text-sm">{consumerSdkSample}</code>
              </pre>
            </CardContent>
          </Card>

          {/* Installation */}
          <Card>
            <CardHeader>
              <CardTitle>Installation</CardTitle>
              <CardDescription>Install the x402 SDKs</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <p className="text-sm font-medium mb-2">Provider SDK:</p>
                <pre className="p-3 bg-gray-100 dark:bg-gray-900 rounded">
                  <code className="text-sm">npm install @sly/x402-provider-sdk</code>
                </pre>
              </div>
              <div>
                <p className="text-sm font-medium mb-2">Consumer SDK:</p>
                <pre className="p-3 bg-gray-100 dark:bg-gray-900 rounded">
                  <code className="text-sm">npm install @sly/x402-client-sdk</code>
                </pre>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Publish to Agentic.Market — Worktree D dialog */}
      {endpoint && (
        <PublishToMarketDialog
          endpoint={endpoint as X402Endpoint}
          open={publishDialogOpen}
          onOpenChange={setPublishDialogOpen}
          mode={isPublished ? 'edit' : 'publish'}
          onSuccess={() => {
            queryClient.invalidateQueries({ queryKey: ['x402', 'endpoint', endpointId] });
            queryClient.invalidateQueries({ queryKey: ['x402', 'endpoint', endpointId, 'publish-status'] });
          }}
        />
      )}

      {/* Edit endpoint dialog */}
      {endpoint && (
        <EditEndpointDialog
          endpoint={endpoint as X402Endpoint}
          open={editDialogOpen}
          onOpenChange={setEditDialogOpen}
        />
      )}
    </div>
  );
}

