'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plug, Plus, Trash2, CheckCircle, AlertCircle, Clock, RefreshCw, ExternalLink, CreditCard, ArrowRight, Zap } from 'lucide-react';
import Link from 'next/link';
import { useApiConfig } from '@/lib/api-client';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import { toast } from 'sonner';
import { cn } from '@sly/ui';

// Types
interface ConnectedAccount {
  id: string;
  handler_type: string;
  handler_name: string;
  status: 'pending' | 'active' | 'inactive' | 'error';
  credentials_preview?: Record<string, string>;
  last_verified_at: string | null;
  error_message?: string;
  error_code?: string;
  metadata?: Record<string, unknown>;
  connected_at: string;
  updated_at: string;
}

interface ConnectedAccountsResponse {
  data: ConnectedAccount[];
}

interface DbHandler {
  id: string;
  displayName: string;
  description: string;
  status: string;
  integrationMode: string;
  supportedTypes: string[];
  supportedCurrencies: string[];
  scope: string;
}

interface DbHandlersResponse {
  data: DbHandler[];
}

type HardcodedHandlerType = 'stripe' | 'paypal' | 'circle' | 'payos_native';

const HANDLER_INFO: Record<HardcodedHandlerType, { name: string; description: string; icon: string; color: string; docsUrl: string; docsLabel: string }> = {
  stripe: {
    name: 'Stripe',
    description: 'Accept cards, bank transfers, and more',
    icon: '\u{1F4B3}',
    color: 'bg-purple-100 dark:bg-purple-950 text-purple-600 dark:text-purple-400',
    docsUrl: 'https://dashboard.stripe.com/test/apikeys',
    docsLabel: 'Get Stripe API Keys',
  },
  paypal: {
    name: 'PayPal',
    description: 'Accept PayPal and Venmo payments',
    icon: '\u{1F17F}\uFE0F',
    color: 'bg-blue-100 dark:bg-blue-950 text-blue-600 dark:text-blue-400',
    docsUrl: 'https://developer.paypal.com/dashboard/applications/sandbox',
    docsLabel: 'Get PayPal Sandbox Credentials',
  },
  circle: {
    name: 'Circle',
    description: 'USDC stablecoin payments',
    icon: '\u2B55',
    color: 'bg-green-100 dark:bg-green-950 text-green-600 dark:text-green-400',
    docsUrl: 'https://console.circle.com/api-keys',
    docsLabel: 'Get Circle API Key',
  },
  payos_native: {
    name: 'Sly Native',
    description: 'Pix (Brazil) and SPEI (Mexico)',
    icon: '\u{1F30E}',
    color: 'bg-orange-100 dark:bg-orange-950 text-orange-600 dark:text-orange-400',
    docsUrl: 'https://www.bcb.gov.br/estabilidadefinanceira/pix',
    docsLabel: 'Learn about Pix & SPEI',
  },
};

const HARDCODED_HANDLER_IDS = Object.keys(HANDLER_INFO) as HardcodedHandlerType[];

function isHardcodedHandler(type: string): type is HardcodedHandlerType {
  return (HARDCODED_HANDLER_IDS as string[]).includes(type);
}

function getHandlerDisplay(type: string, dbHandlers: DbHandler[]) {
  if (isHardcodedHandler(type)) {
    const info = HANDLER_INFO[type];
    return { name: info.name, icon: info.icon, color: info.color };
  }
  const dbHandler = dbHandlers.find((h) => h.id === type);
  return {
    name: dbHandler?.displayName || type,
    icon: null,
    color: 'bg-cyan-100 dark:bg-cyan-950 text-cyan-600 dark:text-cyan-400',
  };
}

// API functions
async function fetchConnectedAccounts(authToken: string, apiUrl: string): Promise<ConnectedAccountsResponse> {
  const response = await fetch(`${apiUrl}/v1/organization/connected-accounts`, {
    headers: {
      'Authorization': `Bearer ${authToken}`,
      'Content-Type': 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error('Failed to fetch connected accounts');
  }
  return response.json();
}

async function fetchDbHandlers(authToken: string, apiUrl: string): Promise<DbHandlersResponse> {
  const response = await fetch(`${apiUrl}/v1/payment-handlers`, {
    headers: {
      'Authorization': `Bearer ${authToken}`,
      'Content-Type': 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error('Failed to fetch payment handlers');
  }
  return response.json();
}

async function createConnectedAccount(authToken: string, apiUrl: string, data: {
  handler_type: string;
  handler_name: string;
  credentials: Record<string, unknown>;
}): Promise<ConnectedAccount> {
  const response = await fetch(`${apiUrl}/v1/organization/connected-accounts`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${authToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to create connected account');
  }
  return response.json();
}

async function deleteConnectedAccount(authToken: string, apiUrl: string, id: string): Promise<void> {
  const response = await fetch(`${apiUrl}/v1/organization/connected-accounts/${id}`, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${authToken}`,
      'Content-Type': 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error('Failed to delete connected account');
  }
}

async function verifyConnectedAccount(authToken: string, apiUrl: string, id: string): Promise<{ verified: boolean; error?: string }> {
  const response = await fetch(`${apiUrl}/v1/organization/connected-accounts/${id}/verify`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${authToken}`,
      'Content-Type': 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error('Failed to verify connected account');
  }
  return response.json();
}

// Status badge component
function StatusBadge({ status }: { status: ConnectedAccount['status'] }) {
  const config = {
    active: { icon: CheckCircle, label: 'Active', className: 'text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-950' },
    pending: { icon: Clock, label: 'Pending', className: 'text-yellow-600 dark:text-yellow-400 bg-yellow-50 dark:bg-yellow-950' },
    inactive: { icon: AlertCircle, label: 'Inactive', className: 'text-gray-600 dark:text-gray-400 bg-gray-100 dark:bg-gray-800' },
    error: { icon: AlertCircle, label: 'Error', className: 'text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950' },
  };
  const { icon: Icon, label, className } = config[status];
  return (
    <span className={cn('inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium', className)}>
      <Icon className="w-3.5 h-3.5" />
      {label}
    </span>
  );
}

// Integration mode badge
function ModeBadge({ mode }: { mode: string }) {
  const config: Record<string, { label: string; className: string }> = {
    demo: { label: 'Demo', className: 'text-amber-700 dark:text-amber-300 bg-amber-100 dark:bg-amber-950' },
    webhook: { label: 'Webhook', className: 'text-blue-700 dark:text-blue-300 bg-blue-100 dark:bg-blue-950' },
    custom: { label: 'Custom', className: 'text-purple-700 dark:text-purple-300 bg-purple-100 dark:bg-purple-950' },
  };
  const { label, className } = config[mode] || { label: mode, className: 'text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-800' };
  return (
    <span className={cn('inline-flex items-center px-2 py-0.5 rounded text-xs font-medium', className)}>
      {label}
    </span>
  );
}

// Connect dialog component
function ConnectDialog({
  isOpen,
  onClose,
  onConnect,
  dbHandlers,
}: {
  isOpen: boolean;
  onClose: () => void;
  onConnect: (type: string, name: string, credentials: Record<string, unknown>) => void;
  dbHandlers: DbHandler[];
}) {
  const [step, setStep] = useState<'select' | 'credentials'>('select');
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [selectedDbHandler, setSelectedDbHandler] = useState<DbHandler | null>(null);
  const [handlerName, setHandlerName] = useState('');
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSelectHardcoded = (type: HardcodedHandlerType) => {
    setSelectedType(type);
    setSelectedDbHandler(null);
    setHandlerName(`My ${HANDLER_INFO[type].name} Account`);
    setStep('credentials');
  };

  const handleSelectDbHandler = (handler: DbHandler) => {
    setSelectedType(handler.id);
    setSelectedDbHandler(handler);
    setHandlerName(`My ${handler.displayName} Account`);
    setStep('credentials');
  };

  const handleSubmit = async () => {
    if (!selectedType) return;
    setIsSubmitting(true);
    try {
      await onConnect(selectedType, handlerName, credentials);
      handleClose();
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    setStep('select');
    setSelectedType(null);
    setSelectedDbHandler(null);
    setHandlerName('');
    setCredentials({});
    onClose();
  };

  if (!isOpen) return null;

  const hardcodedInfo = selectedType && isHardcodedHandler(selectedType) ? HANDLER_INFO[selectedType] : null;
  // Filter out DB handlers whose ID collides with hardcoded ones
  const filteredDbHandlers = dbHandlers.filter((h) => !isHardcodedHandler(h.id));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-xl w-full max-w-lg mx-4 overflow-hidden max-h-[90vh] flex flex-col">
        <div className="p-6 overflow-y-auto flex-1">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-1">Connect Payment Handler</h2>

          {step === 'select' ? (
            <>
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">Select a payment handler to connect:</p>

              {/* Hardcoded integrations */}
              <div className="space-y-3">
                {HARDCODED_HANDLER_IDS.map((type) => {
                  const info = HANDLER_INFO[type];
                  return (
                    <div
                      key={type}
                      className="rounded-xl border border-gray-200 dark:border-gray-700 hover:border-blue-500 dark:hover:border-blue-500 hover:bg-blue-50/50 dark:hover:bg-blue-950/30 transition-colors overflow-hidden"
                    >
                      <button
                        onClick={() => handleSelectHardcoded(type)}
                        className="w-full flex items-center gap-4 p-4 text-left"
                      >
                        <div className={cn('w-12 h-12 rounded-xl flex items-center justify-center text-2xl', info.color)}>
                          {info.icon}
                        </div>
                        <div>
                          <div className="font-medium text-gray-900 dark:text-white">{info.name}</div>
                          <div className="text-sm text-gray-500 dark:text-gray-400">{info.description}</div>
                        </div>
                      </button>
                      <div className="px-4 pb-3">
                        <a
                          href={info.docsUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center gap-1.5 text-sm text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 hover:underline"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                          {info.docsLabel}
                        </a>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* DB-driven platform handlers */}
              {filteredDbHandlers.length > 0 && (
                <>
                  <div className="flex items-center gap-3 my-6">
                    <div className="flex-1 h-px bg-gray-200 dark:bg-gray-700" />
                    <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Platform Handlers</span>
                    <div className="flex-1 h-px bg-gray-200 dark:bg-gray-700" />
                  </div>
                  <div className="space-y-3">
                    {filteredDbHandlers.map((handler) => (
                      <button
                        key={handler.id}
                        onClick={() => handleSelectDbHandler(handler)}
                        className="w-full rounded-xl border border-gray-200 dark:border-gray-700 hover:border-blue-500 dark:hover:border-blue-500 hover:bg-blue-50/50 dark:hover:bg-blue-950/30 transition-colors flex items-center gap-4 p-4 text-left"
                      >
                        <div className="w-12 h-12 rounded-xl flex items-center justify-center bg-cyan-100 dark:bg-cyan-950 text-cyan-600 dark:text-cyan-400">
                          <Zap className="w-6 h-6" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-gray-900 dark:text-white">{handler.displayName}</span>
                            <ModeBadge mode={handler.integrationMode} />
                          </div>
                          <div className="text-sm text-gray-500 dark:text-gray-400">{handler.description}</div>
                          <div className="flex flex-wrap gap-1 mt-1.5">
                            {handler.supportedCurrencies.map((cur) => (
                              <span key={cur} className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400">
                                {cur}
                              </span>
                            ))}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </>
          ) : (
            <>
              <button
                onClick={() => { setStep('select'); setSelectedDbHandler(null); }}
                className="text-sm text-blue-600 dark:text-blue-400 hover:underline mb-4"
              >
                &larr; Choose different handler
              </button>

              {/* Header showing selected handler */}
              {hardcodedInfo ? (
                <div className="mb-6 space-y-3">
                  <div className="flex items-center gap-3 p-3 bg-gray-50 dark:bg-gray-800 rounded-xl">
                    <div className={cn('w-10 h-10 rounded-lg flex items-center justify-center text-xl', hardcodedInfo.color)}>
                      {hardcodedInfo.icon}
                    </div>
                    <div>
                      <div className="font-medium text-gray-900 dark:text-white">{hardcodedInfo.name}</div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">{hardcodedInfo.description}</div>
                    </div>
                  </div>
                  <a
                    href={hardcodedInfo.docsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-between p-3 bg-blue-50 dark:bg-blue-950/30 hover:bg-blue-100 dark:hover:bg-blue-900/40 rounded-lg transition-colors group"
                  >
                    <div className="flex items-center gap-2">
                      <ExternalLink className="w-4 h-4 text-blue-500" />
                      <span className="text-sm font-medium text-blue-600 dark:text-blue-400">
                        {hardcodedInfo.docsLabel}
                      </span>
                    </div>
                    <span className="text-xs text-gray-500 dark:text-gray-400 group-hover:text-gray-700 dark:group-hover:text-gray-300">
                      Opens in new tab
                    </span>
                  </a>
                </div>
              ) : selectedDbHandler ? (
                <div className="mb-6">
                  <div className="flex items-center gap-3 p-3 bg-gray-50 dark:bg-gray-800 rounded-xl">
                    <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-cyan-100 dark:bg-cyan-950 text-cyan-600 dark:text-cyan-400">
                      <Zap className="w-5 h-5" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-gray-900 dark:text-white">{selectedDbHandler.displayName}</span>
                        <ModeBadge mode={selectedDbHandler.integrationMode} />
                      </div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">{selectedDbHandler.description}</div>
                    </div>
                  </div>
                </div>
              ) : null}

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                    Display Name
                  </label>
                  <input
                    type="text"
                    value={handlerName}
                    onChange={(e) => setHandlerName(e.target.value)}
                    placeholder="My Account"
                    className="w-full px-4 py-2.5 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                </div>

                {/* Hardcoded handler credential forms */}
                {selectedType === 'stripe' && (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                        Secret API Key *
                      </label>
                      <input
                        type="password"
                        value={credentials.api_key || ''}
                        onChange={(e) => setCredentials({ ...credentials, api_key: e.target.value })}
                        placeholder="sk_test_... or sk_live_..."
                        className="w-full px-4 py-2.5 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent font-mono"
                      />
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                        Find this in your Stripe Dashboard &rarr; Developers &rarr; API keys
                      </p>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                        Webhook Secret (optional)
                      </label>
                      <input
                        type="password"
                        value={credentials.webhook_secret || ''}
                        onChange={(e) => setCredentials({ ...credentials, webhook_secret: e.target.value })}
                        placeholder="whsec_..."
                        className="w-full px-4 py-2.5 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent font-mono"
                      />
                    </div>
                  </>
                )}

                {selectedType === 'paypal' && (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                        Client ID *
                      </label>
                      <input
                        type="text"
                        value={credentials.client_id || ''}
                        onChange={(e) => setCredentials({ ...credentials, client_id: e.target.value })}
                        placeholder="Your PayPal Client ID"
                        className="w-full px-4 py-2.5 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                        Client Secret *
                      </label>
                      <input
                        type="password"
                        value={credentials.client_secret || ''}
                        onChange={(e) => setCredentials({ ...credentials, client_secret: e.target.value })}
                        placeholder="Your PayPal Client Secret"
                        className="w-full px-4 py-2.5 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent font-mono"
                      />
                    </div>
                  </>
                )}

                {selectedType === 'circle' && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                      API Key *
                    </label>
                    <input
                      type="password"
                      value={credentials.api_key || ''}
                      onChange={(e) => setCredentials({ ...credentials, api_key: e.target.value })}
                      placeholder="Your Circle API Key"
                      className="w-full px-4 py-2.5 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent font-mono"
                    />
                  </div>
                )}

                {selectedType === 'payos_native' && (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                        Pix Key (Brazil)
                      </label>
                      <input
                        type="text"
                        value={credentials.pix_key || ''}
                        onChange={(e) => setCredentials({ ...credentials, pix_key: e.target.value })}
                        placeholder="Your Pix key (email, phone, CPF, or random)"
                        className="w-full px-4 py-2.5 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                        CLABE (Mexico)
                      </label>
                      <input
                        type="text"
                        value={credentials.clabe || ''}
                        onChange={(e) => setCredentials({ ...credentials, clabe: e.target.value })}
                        placeholder="18-digit CLABE number"
                        className="w-full px-4 py-2.5 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent font-mono"
                      />
                    </div>
                  </>
                )}

                {/* DB handler credential forms */}
                {selectedDbHandler && selectedDbHandler.integrationMode === 'demo' && (
                  <div className="p-4 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg">
                    <p className="text-sm text-amber-800 dark:text-amber-200">
                      This handler runs in demo mode &mdash; no credentials needed. Payments will be simulated.
                    </p>
                  </div>
                )}

                {selectedDbHandler && selectedDbHandler.integrationMode !== 'demo' && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                      Configuration (JSON)
                    </label>
                    <textarea
                      value={credentials._config || ''}
                      onChange={(e) => setCredentials({ ...credentials, _config: e.target.value })}
                      placeholder={'{\n  "api_key": "...",\n  "endpoint": "..."\n}'}
                      rows={4}
                      className="w-full px-4 py-2.5 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent font-mono text-sm"
                    />
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                      Provide handler-specific configuration as JSON
                    </p>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 px-6 py-4 bg-gray-50 dark:bg-gray-800/50 border-t border-gray-200 dark:border-gray-700">
          <button
            onClick={handleClose}
            className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition-colors"
          >
            Cancel
          </button>
          {step === 'credentials' && (
            <button
              onClick={handleSubmit}
              disabled={isSubmitting || !handlerName}
              className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isSubmitting ? 'Connecting...' : 'Connect Account'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Main page component
export default function PaymentHandlersPage() {
  const { isConfigured, isLoading: isAuthLoading, authToken, apiUrl } = useApiConfig();
  const queryClient = useQueryClient();
  const [showConnectDialog, setShowConnectDialog] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  // Fetch connected accounts
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['connected-accounts'],
    queryFn: () => fetchConnectedAccounts(authToken!, apiUrl),
    enabled: !!authToken,
  });

  // Fetch available DB handlers
  const { data: dbHandlersData } = useQuery({
    queryKey: ['payment-handlers'],
    queryFn: () => fetchDbHandlers(authToken!, apiUrl),
    enabled: !!authToken,
  });

  const dbHandlers = dbHandlersData?.data || [];

  // Create mutation
  const createMutation = useMutation({
    mutationFn: ({ type, name, credentials }: { type: string; name: string; credentials: Record<string, unknown> }) =>
      createConnectedAccount(authToken!, apiUrl, { handler_type: type, handler_name: name, credentials }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['connected-accounts'] });
      toast.success('Payment handler connected successfully');
    },
    onError: (error: Error) => {
      toast.error('Failed to connect payment handler', { description: error.message });
    },
  });

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteConnectedAccount(authToken!, apiUrl, id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['connected-accounts'] });
      toast.success('Payment handler disconnected');
      setDeleteId(null);
    },
    onError: (error: Error) => {
      toast.error('Failed to disconnect payment handler', { description: error.message });
    },
  });

  // Verify mutation
  const verifyMutation = useMutation({
    mutationFn: (id: string) => verifyConnectedAccount(authToken!, apiUrl, id),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['connected-accounts'] });
      if (result.verified) {
        toast.success('Credentials verified successfully');
      } else {
        toast.error('Verification failed', { description: result.error });
      }
    },
    onError: (error: Error) => {
      toast.error('Failed to verify credentials', { description: error.message });
    },
  });

  const accounts = data?.data || [];
  const stats = {
    connected: accounts.length,
    active: accounts.filter((a) => a.status === 'active').length,
    errors: accounts.filter((a) => a.status === 'error').length,
  };

  if (isAuthLoading) {
    return (
      <div className="p-8 max-w-[1600px] mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">Payment Handlers</h1>
            <p className="text-gray-600 dark:text-gray-400">Connect your payment processor accounts to accept payments through Sly</p>
          </div>
        </div>
        <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-12 text-center animate-pulse">
          <div className="h-16 w-16 bg-gray-200 dark:bg-gray-800 rounded-full mx-auto mb-4"></div>
          <div className="h-6 w-48 bg-gray-200 dark:bg-gray-800 rounded mx-auto mb-2"></div>
          <div className="h-4 w-64 bg-gray-200 dark:bg-gray-800 rounded mx-auto"></div>
        </div>
      </div>
    );
  }

  if (!isConfigured) {
    return (
      <div className="p-8">
        <div className="text-center py-12">
          <Plug className="h-12 w-12 text-gray-400 mx-auto mb-4" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Authentication Required</h2>
          <p className="text-gray-500 dark:text-gray-400 mt-2">
            Please log in to manage payment handlers.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-[1600px] mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">Payment Handlers</h1>
          <p className="text-gray-600 dark:text-gray-400">Connect your payment processor accounts to accept payments through Sly</p>
        </div>
        <button
          onClick={() => setShowConnectDialog(true)}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
        >
          <Plus className="h-4 w-4" />
          Connect Account
        </button>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <div className="bg-white dark:bg-gray-950 rounded-xl border border-gray-200 dark:border-gray-800 p-6">
          <div className="text-sm text-gray-500 dark:text-gray-400 mb-1">Connected</div>
          <div className="text-3xl font-bold text-gray-900 dark:text-white">{stats.connected}</div>
        </div>
        <div className="bg-white dark:bg-gray-950 rounded-xl border border-gray-200 dark:border-gray-800 p-6">
          <div className="text-sm text-gray-500 dark:text-gray-400 mb-1">Active</div>
          <div className="text-3xl font-bold text-green-600 dark:text-green-400">{stats.active}</div>
        </div>
        <div className="bg-white dark:bg-gray-950 rounded-xl border border-gray-200 dark:border-gray-800 p-6">
          <div className="text-sm text-gray-500 dark:text-gray-400 mb-1">Errors</div>
          <div className="text-3xl font-bold text-red-600 dark:text-red-400">{stats.errors}</div>
        </div>
      </div>

      {/* Content */}
      <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800">
        {isLoading ? (
          <div className="p-12 text-center">
            <div className="animate-spin w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full mx-auto mb-4"></div>
            <p className="text-gray-500 dark:text-gray-400">Loading payment handlers...</p>
          </div>
        ) : error ? (
          <div className="p-12 text-center">
            <AlertCircle className="h-12 w-12 text-red-400 mx-auto mb-4" />
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">Failed to load payment handlers</h3>
            <p className="text-gray-500 dark:text-gray-400 mb-4">There was an error loading your connected accounts.</p>
            <button
              onClick={() => refetch()}
              className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
            >
              Try Again
            </button>
          </div>
        ) : accounts.length === 0 ? (
          <div className="p-12 text-center">
            <Plug className="h-16 w-16 text-gray-400 mx-auto mb-4" />
            <h3 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">No payment handlers connected</h3>
            <p className="text-gray-500 dark:text-gray-400 mb-6">Connect a payment processor to start accepting payments through Sly</p>
            <button
              onClick={() => setShowConnectDialog(true)}
              className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
            >
              <Plus className="h-4 w-4" />
              Connect Your First Account
            </button>
          </div>
        ) : (
          <div className="divide-y divide-gray-200 dark:divide-gray-800">
            {accounts.map((account) => {
              const display = getHandlerDisplay(account.handler_type, dbHandlers);
              return (
                <div key={account.id} className="p-6 flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className={cn('w-12 h-12 rounded-xl flex items-center justify-center text-2xl', display.color)}>
                      {display.icon || <Zap className="w-6 h-6" />}
                    </div>
                    <div>
                      <div className="flex items-center gap-3">
                        <span className="font-medium text-gray-900 dark:text-white">{account.handler_name}</span>
                        <StatusBadge status={account.status} />
                      </div>
                      <div className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
                        {display.name} &bull; Connected {new Date(account.connected_at).toLocaleDateString()}
                      </div>
                      {account.error_message && (
                        <div className="text-sm text-red-600 dark:text-red-400 mt-1">
                          {account.error_message}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => verifyMutation.mutate(account.id)}
                      disabled={verifyMutation.isPending}
                      className="p-2 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
                      title="Verify credentials"
                    >
                      <RefreshCw className={cn('h-4 w-4', verifyMutation.isPending && 'animate-spin')} />
                    </button>
                    <button
                      onClick={() => setDeleteId(account.id)}
                      className="p-2 text-gray-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
                      title="Disconnect"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Card Networks Section */}
      <section className="mt-8 bg-gradient-to-r from-indigo-50 to-purple-50 dark:from-indigo-950/30 dark:to-purple-950/30 rounded-2xl border border-indigo-100 dark:border-indigo-900 p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 bg-indigo-100 dark:bg-indigo-950 rounded-xl flex items-center justify-center">
            <CreditCard className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Card Networks (Agentic Commerce)</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              For AI agent verification and card-based settlements
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <div className="flex items-center gap-3 p-4 bg-white dark:bg-gray-950 rounded-xl border border-gray-200 dark:border-gray-800">
            <svg viewBox="0 0 48 16" className="h-4 w-auto">
              <path
                fill="#1434CB"
                d="M17.88 1.42L14.56 14.5h-3.12L14.76 1.42h3.12zM30.48 9.86l1.64-4.5.94 4.5h-2.58zm3.48 4.64h2.88L34.4 1.42h-2.66c-.6 0-1.1.35-1.32.88l-4.66 12.2h3.26l.65-1.78h3.98l.37 1.78zM25.44 10.12c.02-3.44-4.76-3.64-4.72-5.18.02-.46.46-.96 1.44-1.08.48-.06 1.82-.1 3.34.54l.6-2.78C25.02 1.24 23.64 1 21.98 1c-3.08 0-5.24 1.64-5.26 3.98-.02 1.74 1.54 2.7 2.72 3.28 1.22.58 1.62.96 1.62 1.48-.02.8-.98 1.16-1.88 1.18-1.58.02-2.5-.42-3.22-.76l-.58 2.68c.74.34 2.1.64 3.5.66 3.28 0 5.42-1.62 5.44-4.12l.12-.26zM11.36 1.42L6.1 14.5H2.78L.14 3.9c-.16-.62-.3-.84-.78-1.1-.78-.42-2.08-.82-3.22-1.06l.08-.32h5.28c.68 0 1.28.44 1.44 1.22l1.3 6.92 3.22-8.14h3.26z"
              />
            </svg>
            <div className="flex-1">
              <div className="font-medium text-gray-900 dark:text-white">Visa VIC</div>
              <div className="text-sm text-gray-500 dark:text-gray-400">Agent payments via Visa Intelligent Commerce</div>
            </div>
          </div>

          <div className="flex items-center gap-3 p-4 bg-white dark:bg-gray-950 rounded-xl border border-gray-200 dark:border-gray-800">
            <svg viewBox="0 0 48 30" className="h-5 w-auto">
              <circle cx="17" cy="15" r="15" fill="#EB001B" />
              <circle cx="31" cy="15" r="15" fill="#F79E1B" />
              <path
                d="M24 5.02c2.8 2.2 4.6 5.6 4.6 9.48s-1.8 7.28-4.6 9.48a12.54 12.54 0 01-4.6-9.48c0-3.88 1.8-7.28 4.6-9.48z"
                fill="#FF5F00"
              />
            </svg>
            <div className="flex-1">
              <div className="font-medium text-gray-900 dark:text-white">Mastercard Agent Pay</div>
              <div className="text-sm text-gray-500 dark:text-gray-400">Agent payments via Mastercard</div>
            </div>
          </div>
        </div>

        <Link
          href="/dashboard/card-networks"
          className="inline-flex items-center gap-2 text-sm font-medium text-indigo-600 dark:text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-300"
        >
          Manage Card Networks
          <ArrowRight className="h-4 w-4" />
        </Link>
      </section>

      {/* Connect Dialog */}
      <ConnectDialog
        isOpen={showConnectDialog}
        onClose={() => setShowConnectDialog(false)}
        onConnect={(type, name, credentials) => createMutation.mutate({ type, name, credentials })}
        dbHandlers={dbHandlers}
      />

      {/* Delete Confirmation Dialog */}
      {deleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-xl w-full max-w-md mx-4 p-6">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">Disconnect Payment Handler?</h3>
            <p className="text-gray-500 dark:text-gray-400 mb-6">
              This will remove the payment handler and its credentials. Any active payments using this handler may fail.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setDeleteId(null)}
                className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => deleteMutation.mutate(deleteId)}
                disabled={deleteMutation.isPending}
                className="px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 disabled:opacity-50 transition-colors"
              >
                {deleteMutation.isPending ? 'Disconnecting...' : 'Disconnect'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
