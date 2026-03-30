'use client';

import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import Link from 'next/link';
import {
  CreditCard,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Loader2,
  ExternalLink,
  Eye,
  EyeOff,
  RefreshCw,
  Trash2,
  Shield,
  Calendar,
  TrendingUp,
  Zap,
  Globe,
  ShoppingCart,
  ArrowRight,
  BarChart3,
} from 'lucide-react';
import { useApiConfig } from '@/lib/api-client';

// Visa and Mastercard logos as SVG components
const VisaLogo = () => (
  <svg viewBox="0 0 48 16" className="h-4 w-auto">
    <path
      fill="#1434CB"
      d="M17.88 1.42L14.56 14.5h-3.12L14.76 1.42h3.12zM30.48 9.86l1.64-4.5.94 4.5h-2.58zm3.48 4.64h2.88L34.4 1.42h-2.66c-.6 0-1.1.35-1.32.88l-4.66 12.2h3.26l.65-1.78h3.98l.37 1.78zM25.44 10.12c.02-3.44-4.76-3.64-4.72-5.18.02-.46.46-.96 1.44-1.08.48-.06 1.82-.1 3.34.54l.6-2.78C25.02 1.24 23.64 1 21.98 1c-3.08 0-5.24 1.64-5.26 3.98-.02 1.74 1.54 2.7 2.72 3.28 1.22.58 1.62.96 1.62 1.48-.02.8-.98 1.16-1.88 1.18-1.58.02-2.5-.42-3.22-.76l-.58 2.68c.74.34 2.1.64 3.5.66 3.28 0 5.42-1.62 5.44-4.12l.12-.26zM11.36 1.42L6.1 14.5H2.78L.14 3.9c-.16-.62-.3-.84-.78-1.1-.78-.42-2.08-.82-3.22-1.06l.08-.32h5.28c.68 0 1.28.44 1.44 1.22l1.3 6.92 3.22-8.14h3.26z"
    />
  </svg>
);

const MastercardLogo = () => (
  <svg viewBox="0 0 48 30" className="h-5 w-auto">
    <circle cx="17" cy="15" r="15" fill="#EB001B" />
    <circle cx="31" cy="15" r="15" fill="#F79E1B" />
    <path
      d="M24 5.02c2.8 2.2 4.6 5.6 4.6 9.48s-1.8 7.28-4.6 9.48a12.54 12.54 0 01-4.6-9.48c0-3.88 1.8-7.28 4.6-9.48z"
      fill="#FF5F00"
    />
  </svg>
);

interface NetworkStatus {
  configured: boolean;
  status: 'active' | 'inactive' | 'not_configured';
  accountId: string | null;
  sandbox?: boolean;
  connectedAt?: string;
}

interface NetworksResponse {
  networks: {
    visa: NetworkStatus;
    mastercard: NetworkStatus;
  };
  capabilities: {
    webBotAuth: boolean;
    paymentInstructions: boolean;
    agentRegistration: boolean;
    tokenization: boolean;
  };
}

interface AnalyticsResponse {
  verifications: {
    total: number;
    successful: number;
    successRate: number;
    byNetwork: {
      visa: number;
      mastercard: number;
    };
    byProvider: Record<string, number>;
  };
  transactions: {
    total: number;
    volume: number;
    byStatus: {
      completed: number;
      pending: number;
      failed: number;
    };
    byNetwork: {
      visa: number;
      mastercard: number;
    };
  };
  recentTransactions: Array<{
    id: string;
    network: 'visa' | 'mastercard';
    amount: number;
    currency: string;
    merchantName: string;
    status: string;
    createdAt: string;
  }>;
  period: {
    days: number;
    from: string;
    to: string;
  };
}

// Protocol info for the integration section
const PROTOCOL_INFO = [
  {
    id: 'acp',
    name: 'ACP',
    description: 'Agent Commerce Protocol',
    cardSupport: 'full',
    icon: ShoppingCart,
    color: 'text-purple-600 dark:text-purple-400',
    bg: 'bg-purple-100 dark:bg-purple-950',
  },
  {
    id: 'ucp',
    name: 'UCP',
    description: 'Universal Commerce Protocol',
    cardSupport: 'full',
    icon: Globe,
    color: 'text-green-600 dark:text-green-400',
    bg: 'bg-green-100 dark:bg-green-950',
  },
  {
    id: 'ap2',
    name: 'AP2',
    description: 'Agent Payment Protocol',
    cardSupport: 'fallback',
    icon: Shield,
    color: 'text-blue-600 dark:text-blue-400',
    bg: 'bg-blue-100 dark:bg-blue-950',
  },
  {
    id: 'x402',
    name: 'x402',
    description: 'HTTP 402 Payments',
    cardSupport: 'none',
    icon: Zap,
    color: 'text-yellow-600 dark:text-yellow-400',
    bg: 'bg-yellow-100 dark:bg-yellow-950',
  },
];

export default function CardNetworksSettingsPage() {
  const { authToken, isConfigured, isLoading: authLoading, apiUrl } = useApiConfig();

  const [showVisaKey, setShowVisaKey] = useState(false);
  const [showMcKey, setShowMcKey] = useState(false);
  const [visaConfig, setVisaConfig] = useState({
    apiKey: '',
    sharedSecret: '',
    sandbox: true,
  });
  const [mcConfig, setMcConfig] = useState({
    consumerKey: '',
    privateKeyPem: '',
    sandbox: true,
  });
  const [testingVisa, setTestingVisa] = useState(false);
  const [testingMc, setTestingMc] = useState(false);
  const [visaTestResult, setVisaTestResult] = useState<{ success: boolean; error?: string } | null>(null);
  const [mcTestResult, setMcTestResult] = useState<{ success: boolean; error?: string } | null>(null);
  const [networksData, setNetworksData] = useState<NetworksResponse | null>(null);
  const [analyticsData, setAnalyticsData] = useState<AnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingAnalytics, setLoadingAnalytics] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connectingVisa, setConnectingVisa] = useState(false);
  const [connectingMc, setConnectingMc] = useState(false);
  const [disconnectingVisa, setDisconnectingVisa] = useState(false);
  const [disconnectingMc, setDisconnectingMc] = useState(false);

  // Helper for making authenticated requests
  const makeRequest = useCallback(
    async <T,>(
      endpoint: string,
      options: RequestInit = {}
    ): Promise<{ data?: T; error?: string }> => {
      if (!authToken) {
        return { error: 'Not authenticated' };
      }

      try {
        const response = await fetch(`${apiUrl}/v1${endpoint}`, {
          ...options,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authToken}`,
            ...options.headers,
          },
        });

        const result = await response.json();

        if (!response.ok) {
          return { error: result.error || 'Request failed' };
        }

        return { data: result };
      } catch (err) {
        console.error('Request error:', err);
        return { error: 'Network error' };
      }
    },
    [authToken, apiUrl]
  );

  // Fetch network configurations
  const refetch = useCallback(async () => {
    if (!isConfigured || authLoading) return;
    setLoading(true);
    setError(null);

    const result = await makeRequest<NetworksResponse>('/cards/networks');
    if (result.error) {
      setError(result.error);
    } else if (result.data) {
      setNetworksData(result.data);
    }
    setLoading(false);
  }, [isConfigured, authLoading, makeRequest]);

  // Fetch analytics data
  const fetchAnalytics = useCallback(async () => {
    if (!isConfigured || authLoading) return;
    setLoadingAnalytics(true);

    const result = await makeRequest<AnalyticsResponse>('/cards/analytics?days=30');
    if (result.data) {
      setAnalyticsData(result.data);
    }
    setLoadingAnalytics(false);
  }, [isConfigured, authLoading, makeRequest]);

  useEffect(() => {
    refetch();
    fetchAnalytics();
  }, [refetch, fetchAnalytics]);

  const handleConnectVisa = async () => {
    if (!visaConfig.apiKey) {
      toast.error('Please enter your Visa API Key');
      return;
    }

    setConnectingVisa(true);
    try {
      const result = await makeRequest<{ id: string }>('/cards/networks/visa/configure', {
        method: 'POST',
        body: JSON.stringify({
          api_key: visaConfig.apiKey,
          shared_secret: visaConfig.sharedSecret,
          sandbox: visaConfig.sandbox,
        }),
      });
      if (result.data) {
        toast.success('Visa VIC connected successfully');
        refetch();
        setVisaConfig({ apiKey: '', sharedSecret: '', sandbox: true });
      } else if (result.error) {
        toast.error(result.error);
      }
    } catch (err) {
      console.error('Failed to connect Visa:', err);
      toast.error('Failed to connect to Visa');
    } finally {
      setConnectingVisa(false);
    }
  };

  const handleConnectMastercard = async () => {
    if (!mcConfig.consumerKey) {
      toast.error('Please enter your Mastercard Consumer Key');
      return;
    }

    setConnectingMc(true);
    try {
      const result = await makeRequest<{ id: string }>('/cards/networks/mastercard/configure', {
        method: 'POST',
        body: JSON.stringify({
          consumer_key: mcConfig.consumerKey,
          private_key_pem: mcConfig.privateKeyPem,
          sandbox: mcConfig.sandbox,
        }),
      });
      if (result.data) {
        toast.success('Mastercard Agent Pay connected successfully');
        refetch();
        setMcConfig({ consumerKey: '', privateKeyPem: '', sandbox: true });
      } else if (result.error) {
        toast.error(result.error);
      }
    } catch (err) {
      console.error('Failed to connect Mastercard:', err);
      toast.error('Failed to connect to Mastercard');
    } finally {
      setConnectingMc(false);
    }
  };

  const handleDisconnectVisa = async () => {
    if (!confirm('Are you sure you want to disconnect Visa VIC?')) return;

    setDisconnectingVisa(true);
    try {
      const result = await makeRequest<{ success: boolean }>('/cards/networks/visa/disconnect', {
        method: 'DELETE',
      });
      if (result.data || !result.error) {
        toast.success('Visa VIC disconnected');
        refetch();
      } else {
        toast.error(result.error || 'Failed to disconnect');
      }
    } catch (err) {
      console.error('Failed to disconnect Visa:', err);
      toast.error('Failed to disconnect Visa');
    } finally {
      setDisconnectingVisa(false);
    }
  };

  const handleDisconnectMastercard = async () => {
    if (!confirm('Are you sure you want to disconnect Mastercard Agent Pay?')) return;

    setDisconnectingMc(true);
    try {
      const result = await makeRequest<{ success: boolean }>('/cards/networks/mastercard/disconnect', {
        method: 'DELETE',
      });
      if (result.data || !result.error) {
        toast.success('Mastercard Agent Pay disconnected');
        refetch();
      } else {
        toast.error(result.error || 'Failed to disconnect');
      }
    } catch (err) {
      console.error('Failed to disconnect Mastercard:', err);
      toast.error('Failed to disconnect Mastercard');
    } finally {
      setDisconnectingMc(false);
    }
  };

  const handleTestVisa = async () => {
    setTestingVisa(true);
    setVisaTestResult(null);
    try {
      const result = await makeRequest<{ success: boolean; error?: string }>('/cards/networks/visa/test', {
        method: 'POST',
      });
      if (result.data) {
        setVisaTestResult(result.data);
      } else {
        setVisaTestResult({ success: false, error: result.error || 'Connection test failed' });
      }
    } catch (err) {
      setVisaTestResult({ success: false, error: 'Connection test failed' });
    } finally {
      setTestingVisa(false);
    }
  };

  const handleTestMastercard = async () => {
    setTestingMc(true);
    setMcTestResult(null);
    try {
      const result = await makeRequest<{ success: boolean; error?: string }>('/cards/networks/mastercard/test', {
        method: 'POST',
      });
      if (result.data) {
        setMcTestResult(result.data);
      } else {
        setMcTestResult({ success: false, error: result.error || 'Connection test failed' });
      }
    } catch (err) {
      setMcTestResult({ success: false, error: 'Connection test failed' });
    } finally {
      setTestingMc(false);
    }
  };

  const networks = networksData?.networks;
  const capabilities = networksData?.capabilities;

  return (
    <div className="p-8 max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-indigo-100 dark:bg-indigo-950 rounded-xl flex items-center justify-center">
            <CreditCard className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
          </div>
          <div>
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white">Card Networks</h1>
            <p className="text-gray-600 dark:text-gray-400">
              Configure Visa VIC and Mastercard Agent Pay for AI agent payments
            </p>
          </div>
        </div>
      </div>

      {/* Loading state */}
      {loading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 text-blue-600 animate-spin" />
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="flex items-center gap-2 p-4 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 rounded-xl mb-6">
          <AlertCircle className="h-5 w-5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {!loading && (
        <div className="space-y-6">
          {/* Capabilities Overview */}
          <section className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Capabilities</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[
                { key: 'webBotAuth', label: 'Web Bot Auth', description: 'RFC 9421 signature verification' },
                { key: 'paymentInstructions', label: 'Payment Instructions', description: 'Visa VIC' },
                { key: 'agentRegistration', label: 'Agent Registration', description: 'Mastercard Agent Pay' },
                { key: 'tokenization', label: 'Tokenization', description: 'VTS / MDES tokens' },
              ].map((cap) => (
                <div
                  key={cap.key}
                  className={`p-4 rounded-xl border ${
                    capabilities?.[cap.key as keyof typeof capabilities]
                      ? 'border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950/30'
                      : 'border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900'
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    {capabilities?.[cap.key as keyof typeof capabilities] ? (
                      <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
                    ) : (
                      <XCircle className="h-4 w-4 text-gray-400" />
                    )}
                    <span className="text-sm font-medium text-gray-900 dark:text-white">{cap.label}</span>
                  </div>
                  <p className="text-xs text-gray-500 dark:text-gray-400">{cap.description}</p>
                </div>
              ))}
            </div>
          </section>

          {/* Analytics Section */}
          {(networks?.visa.configured || networks?.mastercard.configured) && (
            <section className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
              <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-emerald-100 dark:bg-emerald-950 rounded-xl flex items-center justify-center">
                    <BarChart3 className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                  </div>
                  <div>
                    <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Analytics</h2>
                    <p className="text-sm text-gray-500 dark:text-gray-400">Last 30 days</p>
                  </div>
                </div>
                <button
                  onClick={fetchAnalytics}
                  disabled={loadingAnalytics}
                  className="flex items-center gap-1 px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
                >
                  <RefreshCw className={`h-4 w-4 ${loadingAnalytics ? 'animate-spin' : ''}`} />
                  Refresh
                </button>
              </div>

              {loadingAnalytics ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-6 w-6 text-blue-600 animate-spin" />
                </div>
              ) : analyticsData ? (
                <div className="space-y-6">
                  {/* Verification Stats */}
                  <div>
                    <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">Verifications</h3>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                      <div className="p-4 bg-gray-50 dark:bg-gray-900 rounded-xl">
                        <div className="text-2xl font-bold text-gray-900 dark:text-white">
                          {analyticsData.verifications.total}
                        </div>
                        <div className="text-xs text-gray-500 dark:text-gray-400">Total</div>
                      </div>
                      <div className="p-4 bg-gray-50 dark:bg-gray-900 rounded-xl">
                        <div className="text-2xl font-bold text-green-600 dark:text-green-400">
                          {analyticsData.verifications.successRate}%
                        </div>
                        <div className="text-xs text-gray-500 dark:text-gray-400">Success Rate</div>
                      </div>
                      <div className="p-4 bg-gray-50 dark:bg-gray-900 rounded-xl">
                        <div className="flex items-center gap-2">
                          <VisaLogo />
                          <span className="text-lg font-semibold text-gray-900 dark:text-white">
                            {analyticsData.verifications.byNetwork.visa}
                          </span>
                        </div>
                        <div className="text-xs text-gray-500 dark:text-gray-400">Visa</div>
                      </div>
                      <div className="p-4 bg-gray-50 dark:bg-gray-900 rounded-xl">
                        <div className="flex items-center gap-2">
                          <MastercardLogo />
                          <span className="text-lg font-semibold text-gray-900 dark:text-white">
                            {analyticsData.verifications.byNetwork.mastercard}
                          </span>
                        </div>
                        <div className="text-xs text-gray-500 dark:text-gray-400">Mastercard</div>
                      </div>
                    </div>
                  </div>

                  {/* Transaction Stats */}
                  <div>
                    <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">Transactions</h3>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                      <div className="p-4 bg-gray-50 dark:bg-gray-900 rounded-xl">
                        <div className="text-2xl font-bold text-gray-900 dark:text-white">
                          {analyticsData.transactions.total}
                        </div>
                        <div className="text-xs text-gray-500 dark:text-gray-400">Total</div>
                      </div>
                      <div className="p-4 bg-gray-50 dark:bg-gray-900 rounded-xl">
                        <div className="text-2xl font-bold text-gray-900 dark:text-white">
                          ${analyticsData.transactions.volume.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </div>
                        <div className="text-xs text-gray-500 dark:text-gray-400">Volume</div>
                      </div>
                      <div className="p-4 bg-green-50 dark:bg-green-950/30 rounded-xl">
                        <div className="text-2xl font-bold text-green-600 dark:text-green-400">
                          {analyticsData.transactions.byStatus.completed}
                        </div>
                        <div className="text-xs text-gray-500 dark:text-gray-400">Completed</div>
                      </div>
                      <div className="p-4 bg-yellow-50 dark:bg-yellow-950/30 rounded-xl">
                        <div className="text-2xl font-bold text-yellow-600 dark:text-yellow-400">
                          {analyticsData.transactions.byStatus.pending}
                        </div>
                        <div className="text-xs text-gray-500 dark:text-gray-400">Pending</div>
                      </div>
                    </div>
                  </div>

                  {/* Recent Transactions */}
                  {analyticsData.recentTransactions.length > 0 && (
                    <div>
                      <div className="flex items-center justify-between mb-3">
                        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">Recent Transactions</h3>
                        <Link
                          href="/dashboard/transactions?rail=card"
                          className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                        >
                          View All
                        </Link>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-gray-200 dark:border-gray-800">
                              <th className="text-left py-2 px-3 text-gray-500 dark:text-gray-400 font-medium">Network</th>
                              <th className="text-left py-2 px-3 text-gray-500 dark:text-gray-400 font-medium">Amount</th>
                              <th className="text-left py-2 px-3 text-gray-500 dark:text-gray-400 font-medium">Merchant</th>
                              <th className="text-left py-2 px-3 text-gray-500 dark:text-gray-400 font-medium">Status</th>
                              <th className="text-left py-2 px-3 text-gray-500 dark:text-gray-400 font-medium">Time</th>
                            </tr>
                          </thead>
                          <tbody>
                            {analyticsData.recentTransactions.map((tx) => (
                              <tr key={tx.id} className="border-b border-gray-100 dark:border-gray-800/50">
                                <td className="py-2 px-3">
                                  {tx.network === 'visa' ? <VisaLogo /> : <MastercardLogo />}
                                </td>
                                <td className="py-2 px-3 font-medium text-gray-900 dark:text-white">
                                  ${tx.amount.toFixed(2)} {tx.currency}
                                </td>
                                <td className="py-2 px-3 text-gray-600 dark:text-gray-400">
                                  {tx.merchantName}
                                </td>
                                <td className="py-2 px-3">
                                  <span
                                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                                      tx.status === 'completed'
                                        ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                                        : tx.status === 'pending'
                                        ? 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400'
                                        : 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400'
                                    }`}
                                  >
                                    {tx.status === 'completed' && <CheckCircle2 className="h-3 w-3" />}
                                    {tx.status === 'pending' && <Loader2 className="h-3 w-3" />}
                                    {tx.status}
                                  </span>
                                </td>
                                <td className="py-2 px-3 text-gray-500 dark:text-gray-400">
                                  {new Date(tx.createdAt).toLocaleString()}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-center py-8 text-gray-500 dark:text-gray-400">
                  No analytics data available
                </div>
              )}
            </section>
          )}

          {/* Protocol Integration Section */}
          <section className="bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-blue-950/30 dark:to-indigo-950/30 rounded-2xl border border-blue-100 dark:border-blue-900 p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-blue-100 dark:bg-blue-950 rounded-xl flex items-center justify-center">
                <Zap className="h-5 w-5 text-blue-600 dark:text-blue-400" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Protocol Integration</h2>
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  Card networks enable settlement for these protocols
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
              {PROTOCOL_INFO.map((protocol) => {
                const Icon = protocol.icon;
                return (
                  <div
                    key={protocol.id}
                    className="p-4 bg-white dark:bg-gray-950 rounded-xl border border-gray-200 dark:border-gray-800"
                  >
                    <div className="flex items-center gap-2 mb-2">
                      <div className={`w-8 h-8 ${protocol.bg} rounded-lg flex items-center justify-center`}>
                        <Icon className={`h-4 w-4 ${protocol.color}`} />
                      </div>
                      <span className="font-medium text-gray-900 dark:text-white">{protocol.name}</span>
                    </div>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">{protocol.description}</p>
                    <div className="flex items-center gap-1">
                      {protocol.cardSupport === 'full' ? (
                        <>
                          <CheckCircle2 className="h-3 w-3 text-green-600 dark:text-green-400" />
                          <span className="text-xs text-green-600 dark:text-green-400">Card payment</span>
                        </>
                      ) : protocol.cardSupport === 'fallback' ? (
                        <>
                          <AlertCircle className="h-3 w-3 text-yellow-600 dark:text-yellow-400" />
                          <span className="text-xs text-yellow-600 dark:text-yellow-400">Fallback</span>
                        </>
                      ) : (
                        <>
                          <XCircle className="h-3 w-3 text-gray-400" />
                          <span className="text-xs text-gray-400">USDC only</span>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
              When agents make purchases via ACP or settlements via UCP, card networks provide traditional
              card rails with consumer protection and chargeback support.
            </p>

            <Link
              href="/dashboard/protocols"
              className="inline-flex items-center gap-2 text-sm font-medium text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300"
            >
              Configure Protocols
              <ArrowRight className="h-4 w-4" />
            </Link>
          </section>

          {/* Visa VIC Section */}
          <section className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 bg-blue-50 dark:bg-blue-950 rounded-xl flex items-center justify-center">
                  <VisaLogo />
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Visa Intelligent Commerce</h2>
                  <p className="text-sm text-gray-500 dark:text-gray-400">Agent payments via Visa VIC</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {networks?.visa.configured ? (
                  <>
                    <span
                      className={`px-3 py-1 text-xs font-medium rounded-full ${
                        networks.visa.status === 'active'
                          ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                          : 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400'
                      }`}
                    >
                      {networks.visa.status === 'active' ? 'Connected' : 'Inactive'}
                    </span>
                    <button
                      onClick={handleTestVisa}
                      disabled={testingVisa}
                      className="flex items-center gap-1 px-3 py-1 text-xs font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400"
                    >
                      {testingVisa ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <RefreshCw className="h-3 w-3" />
                      )}
                      Test
                    </button>
                  </>
                ) : (
                  <span className="px-3 py-1 text-xs font-medium bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 rounded-full">
                    Not Connected
                  </span>
                )}
              </div>
            </div>

            {/* Test result */}
            {visaTestResult && (
              <div
                className={`flex items-center gap-2 p-3 rounded-lg mb-4 ${
                  visaTestResult.success
                    ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400'
                    : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400'
                }`}
              >
                {visaTestResult.success ? (
                  <CheckCircle2 className="h-4 w-4" />
                ) : (
                  <XCircle className="h-4 w-4" />
                )}
                <span className="text-sm">
                  {visaTestResult.success ? 'Connection successful' : visaTestResult.error || 'Connection failed'}
                </span>
              </div>
            )}

            {/* Connected state details */}
            {networks?.visa.configured && (
              <div className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="p-4 bg-gray-50 dark:bg-gray-900 rounded-xl">
                    <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400 mb-1">
                      <Shield className="h-4 w-4" />
                      <span className="text-xs font-medium uppercase">Environment</span>
                    </div>
                    <div className="text-sm font-semibold text-gray-900 dark:text-white">
                      {networks.visa.sandbox !== false ? 'Sandbox' : 'Production'}
                    </div>
                  </div>
                  <div className="p-4 bg-gray-50 dark:bg-gray-900 rounded-xl">
                    <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400 mb-1">
                      <CheckCircle2 className="h-4 w-4" />
                      <span className="text-xs font-medium uppercase">Status</span>
                    </div>
                    <div className="text-sm font-semibold text-green-600 dark:text-green-400">
                      {networks.visa.status === 'active' ? 'Active' : 'Inactive'}
                    </div>
                  </div>
                  <div className="p-4 bg-gray-50 dark:bg-gray-900 rounded-xl">
                    <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400 mb-1">
                      <Calendar className="h-4 w-4" />
                      <span className="text-xs font-medium uppercase">Connected</span>
                    </div>
                    <div className="text-sm font-semibold text-gray-900 dark:text-white">
                      {networks.visa.connectedAt
                        ? new Date(networks.visa.connectedAt).toLocaleDateString()
                        : 'Recently'}
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-between pt-4 border-t border-gray-200 dark:border-gray-800">
                  <a
                    href="https://developer.visa.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-sm text-blue-600 hover:text-blue-700 dark:text-blue-400"
                  >
                    Visa Developer Portal
                    <ExternalLink className="h-3 w-3" />
                  </a>
                  <button
                    onClick={handleDisconnectVisa}
                    disabled={disconnectingVisa}
                    className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/30 rounded-lg transition-colors"
                  >
                    {disconnectingVisa ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                    Disconnect
                  </button>
                </div>
              </div>
            )}

            {/* Configuration form (show if not connected) */}
            {!networks?.visa.configured && (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    API Key <span className="text-red-500">*</span>
                  </label>
                  <div className="relative">
                    <input
                      type={showVisaKey ? 'text' : 'password'}
                      value={visaConfig.apiKey}
                      onChange={(e) => setVisaConfig({ ...visaConfig, apiKey: e.target.value })}
                      placeholder="Enter your Visa Developer API Key"
                      className="w-full px-4 py-2 pr-10 bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                    <button
                      type="button"
                      onClick={() => setShowVisaKey(!showVisaKey)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                    >
                      {showVisaKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Shared Secret (optional)
                  </label>
                  <input
                    type="password"
                    value={visaConfig.sharedSecret}
                    onChange={(e) => setVisaConfig({ ...visaConfig, sharedSecret: e.target.value })}
                    placeholder="For webhook verification"
                    className="w-full px-4 py-2 bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                </div>

                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={visaConfig.sandbox}
                      onChange={(e) => setVisaConfig({ ...visaConfig, sandbox: e.target.checked })}
                      className="w-4 h-4 rounded border-gray-300 dark:border-gray-700 text-blue-600 focus:ring-blue-500"
                    />
                    <span className="text-sm text-gray-700 dark:text-gray-300">Sandbox Mode</span>
                  </label>

                  <button
                    onClick={handleConnectVisa}
                    disabled={connectingVisa}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white text-sm font-medium rounded-lg transition-colors flex items-center gap-2"
                  >
                    {connectingVisa && <Loader2 className="h-4 w-4 animate-spin" />}
                    Connect Visa
                  </button>
                </div>

                <div className="pt-2 border-t border-gray-200 dark:border-gray-800">
                  <a
                    href="https://developer.visa.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-sm text-blue-600 hover:text-blue-700 dark:text-blue-400"
                  >
                    Get Visa Developer credentials
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              </div>
            )}
          </section>

          {/* Mastercard Agent Pay Section */}
          <section className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 bg-orange-50 dark:bg-orange-950 rounded-xl flex items-center justify-center">
                  <MastercardLogo />
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Mastercard Agent Pay</h2>
                  <p className="text-sm text-gray-500 dark:text-gray-400">Agent payments via Mastercard</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {networks?.mastercard.configured ? (
                  <>
                    <span
                      className={`px-3 py-1 text-xs font-medium rounded-full ${
                        networks.mastercard.status === 'active'
                          ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                          : 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400'
                      }`}
                    >
                      {networks.mastercard.status === 'active' ? 'Connected' : 'Inactive'}
                    </span>
                    <button
                      onClick={handleTestMastercard}
                      disabled={testingMc}
                      className="flex items-center gap-1 px-3 py-1 text-xs font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400"
                    >
                      {testingMc ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <RefreshCw className="h-3 w-3" />
                      )}
                      Test
                    </button>
                  </>
                ) : (
                  <span className="px-3 py-1 text-xs font-medium bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 rounded-full">
                    Not Connected
                  </span>
                )}
              </div>
            </div>

            {/* Test result */}
            {mcTestResult && (
              <div
                className={`flex items-center gap-2 p-3 rounded-lg mb-4 ${
                  mcTestResult.success
                    ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400'
                    : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400'
                }`}
              >
                {mcTestResult.success ? (
                  <CheckCircle2 className="h-4 w-4" />
                ) : (
                  <XCircle className="h-4 w-4" />
                )}
                <span className="text-sm">
                  {mcTestResult.success ? 'Connection successful' : mcTestResult.error || 'Connection failed'}
                </span>
              </div>
            )}

            {/* Connected state details */}
            {networks?.mastercard.configured && (
              <div className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="p-4 bg-gray-50 dark:bg-gray-900 rounded-xl">
                    <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400 mb-1">
                      <Shield className="h-4 w-4" />
                      <span className="text-xs font-medium uppercase">Environment</span>
                    </div>
                    <div className="text-sm font-semibold text-gray-900 dark:text-white">
                      {networks.mastercard.sandbox !== false ? 'Sandbox' : 'Production'}
                    </div>
                  </div>
                  <div className="p-4 bg-gray-50 dark:bg-gray-900 rounded-xl">
                    <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400 mb-1">
                      <CheckCircle2 className="h-4 w-4" />
                      <span className="text-xs font-medium uppercase">Status</span>
                    </div>
                    <div className="text-sm font-semibold text-green-600 dark:text-green-400">
                      {networks.mastercard.status === 'active' ? 'Active' : 'Inactive'}
                    </div>
                  </div>
                  <div className="p-4 bg-gray-50 dark:bg-gray-900 rounded-xl">
                    <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400 mb-1">
                      <Calendar className="h-4 w-4" />
                      <span className="text-xs font-medium uppercase">Connected</span>
                    </div>
                    <div className="text-sm font-semibold text-gray-900 dark:text-white">
                      {networks.mastercard.connectedAt
                        ? new Date(networks.mastercard.connectedAt).toLocaleDateString()
                        : 'Recently'}
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-between pt-4 border-t border-gray-200 dark:border-gray-800">
                  <a
                    href="https://developer.mastercard.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-sm text-orange-600 hover:text-orange-700 dark:text-orange-400"
                  >
                    Mastercard Developer Portal
                    <ExternalLink className="h-3 w-3" />
                  </a>
                  <button
                    onClick={handleDisconnectMastercard}
                    disabled={disconnectingMc}
                    className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/30 rounded-lg transition-colors"
                  >
                    {disconnectingMc ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                    Disconnect
                  </button>
                </div>
              </div>
            )}

            {/* Configuration form (show if not connected) */}
            {!networks?.mastercard.configured && (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Consumer Key <span className="text-red-500">*</span>
                  </label>
                  <div className="relative">
                    <input
                      type={showMcKey ? 'text' : 'password'}
                      value={mcConfig.consumerKey}
                      onChange={(e) => setMcConfig({ ...mcConfig, consumerKey: e.target.value })}
                      placeholder="Enter your Mastercard Consumer Key"
                      className="w-full px-4 py-2 pr-10 bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                    <button
                      type="button"
                      onClick={() => setShowMcKey(!showMcKey)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                    >
                      {showMcKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Private Key (PEM format)
                  </label>
                  <textarea
                    value={mcConfig.privateKeyPem}
                    onChange={(e) => setMcConfig({ ...mcConfig, privateKeyPem: e.target.value })}
                    placeholder="-----BEGIN PRIVATE KEY-----&#10;...&#10;-----END PRIVATE KEY-----"
                    rows={4}
                    className="w-full px-4 py-2 bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent font-mono text-xs"
                  />
                  <p className="mt-1 text-xs text-gray-500">
                    Or upload your P12 keystore file (coming soon)
                  </p>
                </div>

                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={mcConfig.sandbox}
                      onChange={(e) => setMcConfig({ ...mcConfig, sandbox: e.target.checked })}
                      className="w-4 h-4 rounded border-gray-300 dark:border-gray-700 text-blue-600 focus:ring-blue-500"
                    />
                    <span className="text-sm text-gray-700 dark:text-gray-300">Sandbox Mode</span>
                  </label>

                  <button
                    onClick={handleConnectMastercard}
                    disabled={connectingMc}
                    className="px-4 py-2 bg-orange-600 hover:bg-orange-700 disabled:bg-orange-400 text-white text-sm font-medium rounded-lg transition-colors flex items-center gap-2"
                  >
                    {connectingMc && <Loader2 className="h-4 w-4 animate-spin" />}
                    Connect Mastercard
                  </button>
                </div>

                <div className="pt-2 border-t border-gray-200 dark:border-gray-800">
                  <a
                    href="https://developer.mastercard.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-sm text-orange-600 hover:text-orange-700 dark:text-orange-400"
                  >
                    Get Mastercard Developer credentials
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              </div>
            )}
          </section>

          {/* Documentation */}
          <section className="bg-gradient-to-r from-indigo-50 to-purple-50 dark:from-indigo-950/30 dark:to-purple-950/30 rounded-2xl border border-indigo-100 dark:border-indigo-900 p-6">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">
              About Card Network Integration
            </h3>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
              Sly integrates with Visa Intelligent Commerce (VIC) and Mastercard Agent Pay to enable
              AI agents to make secure payments on behalf of users. Both networks use Web Bot Auth
              (HTTP Message Signatures - RFC 9421) for cryptographic verification of agent requests.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
              <div>
                <h4 className="font-medium text-gray-900 dark:text-white mb-1">Visa VIC Features:</h4>
                <ul className="text-gray-600 dark:text-gray-400 space-y-1">
                  <li>- Payment instructions for agents</li>
                  <li>- VTS token management</li>
                  <li>- Commerce signal processing</li>
                </ul>
              </div>
              <div>
                <h4 className="font-medium text-gray-900 dark:text-white mb-1">Mastercard Agent Pay:</h4>
                <ul className="text-gray-600 dark:text-gray-400 space-y-1">
                  <li>- Agent registration</li>
                  <li>- MDES token management</li>
                  <li>- DTVC generation</li>
                </ul>
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
