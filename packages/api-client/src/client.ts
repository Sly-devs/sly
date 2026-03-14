import { SlyError } from './errors';
import type {
  PaginatedResponse,
  Account,
  AccountBalance,
  CreateAccountInput,
  AccountsListParams,
  Agent,
  AgentLimits,
  CreateAgentInput,
  UpdateAgentInput,
  CreateAgentResponse,
  AgentsListParams,
  AgentTransaction,
  Stream,
  StreamEvent,
  StreamStats,
  CreateStreamInput,
  StreamsListParams,
  Transfer,
  CreateTransferInput,
  CreateInternalTransferInput,
  TransfersListParams,
  Quote,
  CreateQuoteInput,
  Report,
  CreateReportInput,
  ReportsListParams,
  AuditLogEntry,
  AuditLogsParams,
  LedgerEntry,
  PaginationParams,
  // New types for Phase 2
  Refund,
  CreateRefundInput,
  RefundsListParams,
  ScheduledTransfer,
  CreateScheduledTransferInput,
  ScheduledTransfersListParams,
  TransactionExport,
  GenerateExportInput,
  PaymentMethod,
  CreatePaymentMethodInput,
  PaymentMethodsListParams,
  Mandate,
  CreateMandateInput,
  UpdateMandateInput,
  ExecuteMandatePaymentInput,
  MandatesListParams,
  FundingSourceSummary,
  // x402 types
  X402Endpoint,
  CreateX402EndpointInput,
  UpdateX402EndpointInput,
  X402EndpointsListParams,
  Wallet,
  CreateWalletInput,
  UpdateWalletInput,
  WalletsListParams,
  WalletDepositInput,
  WalletWithdrawInput,
  X402Quote,
  X402PaymentInput,
  X402PaymentResponse,
  X402VerifyPaymentInput,
  X402VerifyPaymentResponse,
  // ACP types
  ACPCheckout,
  CheckoutStatus,
  CreateCheckoutInput,
  CheckoutsListParams,
  ACPAnalytics,
  // Treasury types
  DashboardSummary,
  TreasuryAccount,
  TreasuryTransaction,
  TreasuryAlert,
  Recommendation,
  // UCP types
  UCPSettlement,
  UCPCorridorInfo,
  UCPQuote,
  UCPAnalytics,
  UCPSettlementsListParams,
  // Approval types
  Approval,
  PendingApprovalsSummary,
  ApprovalsListParams,
  ApproveRejectInput,
  // A2A types
  A2AAgentCard,
  A2ATask,
  A2ATaskSummary,
  A2ATasksListParams,
  SendA2ATaskInput,
  AgentProcessingConfig,
  TaskStateUpdate,
  A2ADlqTask,
  A2AStreamEvent,
  A2AStreamEventType,
  RespondToTaskInput,
} from './types';

export interface SlyClientConfig {
  baseUrl: string;
  apiKey: string;
  onError?: (error: SlyError) => void;
}

// Backward compatibility alias
export type PayOSClientConfig = SlyClientConfig;

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  params?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  idempotencyKey?: string;
};

/**
 * Sly API Client
 *
 * A fully typed client for the Sly API.
 *
 * @example
 * ```typescript
 * const client = createSlyClient({
 *   baseUrl: 'http://localhost:4000',
 *   apiKey: 'pk_test_...',
 * });
 *
 * const accounts = await client.accounts.list();
 * const stream = await client.streams.create({ ... });
 * ```
 */
export class SlyClient {
  private config: SlyClientConfig;

  constructor(config: SlyClientConfig) {
    this.config = config;
  }

  /** The base URL for the API (e.g. http://localhost:4000) */
  get baseUrl(): string {
    return this.config.baseUrl;
  }

  /** The API key or auth token used for requests */
  get apiKey(): string {
    return this.config.apiKey;
  }

  // ============================================
  // Internal HTTP Methods
  // ============================================

  private async request<T>(
    endpoint: string,
    options: RequestOptions = {}
  ): Promise<T> {
    const { method = 'GET', body, params, headers = {}, idempotencyKey } = options;

    // Build URL with query params
    const url = new URL(`/v1${endpoint}`, this.config.baseUrl);
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      });
    }

    // Build headers
    const requestHeaders: Record<string, string> = {
      'Authorization': `Bearer ${this.config.apiKey}`,
      'Content-Type': 'application/json',
      ...headers,
    };

    if (idempotencyKey) {
      requestHeaders['X-Idempotency-Key'] = idempotencyKey;
    }

    // Make request
    const response = await fetch(url.toString(), {
      method,
      headers: requestHeaders,
      body: body ? JSON.stringify(body) : undefined,
    });

    // Parse response
    const data = await response.json();

    // Handle errors
    if (!response.ok) {
      const error = SlyError.fromResponse(data, response.status, response.headers);
      this.config.onError?.(error);
      throw error;
    }

    return data;
  }

  private get<T>(endpoint: string, params?: Record<string, string | number | boolean | undefined> | object) {
    return this.request<T>(endpoint, { params: params as Record<string, string | number | boolean | undefined> | undefined });
  }

  private post<T>(endpoint: string, body?: unknown, options?: { idempotencyKey?: string }) {
    return this.request<T>(endpoint, { method: 'POST', body, ...options });
  }

  private patch<T>(endpoint: string, body: unknown) {
    return this.request<T>(endpoint, { method: 'PATCH', body });
  }

  private put<T>(endpoint: string, body: unknown) {
    return this.request<T>(endpoint, { method: 'PUT', body });
  }

  private delete<T>(endpoint: string) {
    return this.request<T>(endpoint, { method: 'DELETE' });
  }

  // ============================================
  // Accounts API
  // ============================================

  accounts = {
    /**
     * List all accounts
     */
    list: (params?: AccountsListParams) =>
      this.get<PaginatedResponse<Account>>('/accounts', params),

    /**
     * Get a single account by ID
     */
    get: (id: string) =>
      this.get<{ data: Account }>(`/accounts/${id}`).then(r => r.data),

    /**
     * Create a new account
     */
    create: (input: CreateAccountInput) =>
      this.post<{ data: Account }>('/accounts', input).then(r => r.data),

    /**
     * Update an account
     */
    update: (id: string, input: Partial<CreateAccountInput>) =>
      this.patch<{ data: Account }>(`/accounts/${id}`, input).then(r => r.data),

    /**
     * Delete an account
     */
    delete: (id: string) =>
      this.delete<{ success: boolean }>(`/accounts/${id}`),

    /**
     * Get account balance breakdown
     */
    getBalance: (id: string) =>
      this.get<{ data: AccountBalance }>(`/accounts/${id}/balances`).then(r => r.data),

    /**
     * Get account transactions (ledger entries)
     */
    getTransactions: (id: string, params?: PaginationParams & { referenceType?: string }) =>
      this.get<PaginatedResponse<LedgerEntry>>(`/accounts/${id}/transactions`, params),

    /**
     * Get account transfers (sent & received)
     * More efficient than filtering all transfers client-side
     */
    getTransfers: (id: string, params?: PaginationParams & {
      type?: string;
      status?: string;
      direction?: 'sent' | 'received' | 'all'
    }) =>
      this.get<PaginatedResponse<Transfer>>(`/accounts/${id}/transfers`, params),

    /**
     * Get agents under this account
     */
    getAgents: (id: string, params?: PaginationParams) =>
      this.get<PaginatedResponse<Agent>>(`/accounts/${id}/agents`, params),

    /**
     * Get streams for this account
     */
    getStreams: (id: string, params?: PaginationParams) =>
      this.get<PaginatedResponse<Stream>>(`/accounts/${id}/streams`, params),

    /**
     * Verify account (mock KYC/KYB)
     */
    verify: (id: string, tier: number) =>
      this.post<{ data: Account }>(`/accounts/${id}/verify`, { tier }).then(r => r.data),

    /**
     * Suspend account (cascades to agents)
     */
    suspend: (id: string) =>
      this.post<{ data: { accountId: string; status: string; cascadedAgents: number } }>(`/accounts/${id}/suspend`).then(r => r.data),

    /**
     * Activate account
     */
    activate: (id: string) =>
      this.post<{ data: { accountId: string; status: string } }>(`/accounts/${id}/activate`).then(r => r.data),
  };

  // ============================================
  // Agents API
  // ============================================

  agents = {
    /**
     * List all agents
     */
    list: (params?: AgentsListParams) =>
      this.get<PaginatedResponse<Agent>>('/agents', params),

    /**
     * Get a single agent by ID
     */
    get: (id: string) =>
      this.get<{ data: Agent }>(`/agents/${id}`).then(r => r.data),

    /**
     * Create a new agent (returns token ONCE)
     */
    create: (input: CreateAgentInput) =>
      this.post<CreateAgentResponse>('/agents', input),

    /**
     * Update an agent
     */
    update: (id: string, input: UpdateAgentInput) =>
      this.patch<{ data: Agent }>(`/agents/${id}`, input).then(r => r.data),

    /**
     * Delete an agent
     */
    delete: (id: string) =>
      this.delete<{ success: boolean }>(`/agents/${id}`),

    /**
     * Get agent limits and usage
     */
    getLimits: (id: string) =>
      this.get<{ data: AgentLimits }>(`/agents/${id}/limits`).then(r => r.data),

    /**
     * Get agent's streams
     */
    getStreams: (id: string, params?: PaginationParams) =>
      this.get<PaginatedResponse<Stream>>(`/agents/${id}/streams`, params),

    /**
     * Suspend agent
     */
    suspend: (id: string) =>
      this.post<{ data: Agent }>(`/agents/${id}/suspend`).then(r => r.data),

    /**
     * Activate agent
     */
    activate: (id: string) =>
      this.post<{ data: Agent }>(`/agents/${id}/activate`).then(r => r.data),

    /**
     * Mock KYA verification
     */
    verify: (id: string, tier: number) =>
      this.post<{ data: Agent }>(`/agents/${id}/verify`, { tier }).then(r => r.data),

    /**
     * Rotate agent token (returns new token ONCE)
     */
    rotateToken: (id: string) =>
      this.post<{ success: boolean; credentials: { token: string; prefix: string; warning: string }; previousTokenRevoked: boolean }>(`/agents/${id}/rotate-token`),

    /**
     * Get agent transaction history (unified across all protocols)
     */
    getTransactions: (id: string, params?: PaginationParams & { type?: string; from?: string; to?: string }) =>
      this.get<{ data: AgentTransaction[]; pagination: { limit: number; offset: number; total: number } }>(`/agents/${id}/transactions`, params),

    /**
     * Get agent wallet details (balance, policy, status)
     */
    getWallet: (id: string) =>
      this.get<any>(`/agents/${id}/wallet`),

    /**
     * Freeze agent wallet
     */
    freezeWallet: (id: string) =>
      this.post<any>(`/agents/${id}/wallet/freeze`),

    /**
     * Unfreeze agent wallet
     */
    unfreezeWallet: (id: string) =>
      this.post<any>(`/agents/${id}/wallet/unfreeze`),

    /**
     * Set or update agent wallet contract policy
     */
    setWalletPolicy: (id: string, policy: any) =>
      this.put<any>(`/agents/${id}/wallet/policy`, policy),

    /**
     * Evaluate a policy check against the agent wallet
     */
    evaluatePolicy: (id: string, request: any) =>
      this.post<any>(`/agents/${id}/wallet/policy/evaluate`, request),

    /**
     * Get counterparty exposure data for agent wallet
     */
    getExposures: (id: string) =>
      this.get<any>(`/agents/${id}/wallet/exposures`),

    /**
     * Get policy evaluation history for agent wallet
     */
    getEvaluations: (id: string, params?: { page?: number; limit?: number }) =>
      this.get<any>(`/agents/${id}/wallet/policy/evaluations`, params),
  };

  // ============================================
  // Streams API
  // ============================================

  streams = {
    /**
     * List all streams
     */
    list: (params?: StreamsListParams) =>
      this.get<PaginatedResponse<Stream>>('/streams', params),

    /**
     * Get a single stream (with real-time balance)
     */
    get: (id: string) =>
      this.get<{ data: Stream }>(`/streams/${id}`).then(r => r.data),

    /**
     * Create a new stream
     */
    create: (input: CreateStreamInput, idempotencyKey?: string) =>
      this.post<{ data: Stream }>('/streams', input, { idempotencyKey }).then(r => r.data),

    /**
     * Pause a stream
     */
    pause: (id: string) =>
      this.post<{ data: Stream }>(`/streams/${id}/pause`).then(r => r.data),

    /**
     * Resume a stream
     */
    resume: (id: string) =>
      this.post<{ data: Stream }>(`/streams/${id}/resume`).then(r => r.data),

    /**
     * Cancel a stream
     */
    cancel: (id: string) =>
      this.post<{ data: Stream }>(`/streams/${id}/cancel`).then(r => r.data),

    /**
     * Top up a stream
     */
    topUp: (id: string, amount: number) =>
      this.post<{ data: Stream }>(`/streams/${id}/top-up`, { amount }).then(r => r.data),

    /**
     * Withdraw from a stream
     */
    withdraw: (id: string, amount: number) =>
      this.post<{ data: Stream }>(`/streams/${id}/withdraw`, { amount }).then(r => r.data),

    /**
     * Get stream events
     */
    getEvents: (id: string, params?: PaginationParams) =>
      this.get<PaginatedResponse<StreamEvent>>(`/streams/${id}/events`, params),

    /**
     * Get stream stats
     */
    getStats: () =>
      this.get<{ data: StreamStats }>('/streams/stats').then(r => r.data),
  };

  // ============================================
  // Transfers API
  // ============================================

  transfers = {
    /**
     * List all transfers
     */
    list: (params?: TransfersListParams) =>
      this.get<PaginatedResponse<Transfer>>('/transfers', params),

    /**
     * Get a single transfer
     */
    get: (id: string) =>
      this.get<{ data: Transfer }>(`/transfers/${id}`).then(r => r.data),

    /**
     * Create a cross-border transfer
     */
    create: (input: CreateTransferInput, idempotencyKey?: string) =>
      this.post<{ data: Transfer }>('/transfers', input, { idempotencyKey }).then(r => r.data),

    /**
     * Cancel a pending transfer
     */
    cancel: (id: string) =>
      this.post<{ data: Transfer }>(`/transfers/${id}/cancel`).then(r => r.data),

    /**
     * Create an internal transfer
     */
    createInternal: (input: CreateInternalTransferInput, idempotencyKey?: string) =>
      this.post<{ data: Transfer }>('/internal-transfers', input, { idempotencyKey }).then(r => r.data),
  };

  // ============================================
  // Quotes API
  // ============================================

  quotes = {
    /**
     * Create a quote
     */
    create: (input: CreateQuoteInput) =>
      this.post<{ data: Quote }>('/quotes', input).then(r => r.data),

    /**
     * Get a quote by ID
     */
    get: (id: string) =>
      this.get<{ data: Quote }>(`/quotes/${id}`).then(r => r.data),

    /**
     * Get current FX rates
     */
    getRates: () =>
      this.get<{ data: { rates: Record<string, number>; updatedAt: string } }>('/quotes/rates').then(r => r.data),
  };

  // ============================================
  // Reports API
  // ============================================

  reports = {
    /**
     * List all reports
     */
    list: (params?: ReportsListParams) =>
      this.get<PaginatedResponse<Report>>('/reports', params),

    /**
     * Get a report by ID
     */
    get: (id: string) =>
      this.get<{ data: Report }>(`/reports/${id}`).then(r => r.data),

    /**
     * Generate a report
     */
    create: (input: CreateReportInput) =>
      this.post<{ data: Report }>('/reports', input).then(r => r.data),

    /**
     * Delete a report
     */
    delete: (id: string) =>
      this.delete<{ success: boolean }>(`/reports/${id}`),

    /**
     * Download report content
     */
    download: async (id: string): Promise<{ content: unknown; format: string; filename: string }> => {
      const response = await this.get<{ data: { content: unknown; format: string; filename: string } }>(`/reports/${id}/download`);
      return response.data;
    },

    /**
     * Get audit logs
     */
    getAuditLogs: (params?: AuditLogsParams) =>
      this.get<PaginatedResponse<AuditLogEntry>>('/reports/audit-logs', params),
  };

  // ============================================
  // Card Transactions API
  // ============================================

  cards = {
    /**
     * Get all card transactions across all payment methods
     */
    listTransactions: (params?: PaginationParams) =>
      this.get<PaginatedResponse<any>>('/card-transactions', params),

    /**
     * Get card transactions for a specific payment method
     */
    getMethodTransactions: (paymentMethodId: string, params?: PaginationParams) =>
      this.get<PaginatedResponse<any>>(`/payment-methods/${paymentMethodId}/transactions`, params),
  };

  // ============================================
  // Compliance API
  // ============================================

  compliance = {
    /**
     * List compliance flags with filters
     */
    listFlags: (params?: {
      status?: string;
      risk_level?: string;
      flag_type?: string;
      limit?: number;
      offset?: number;
    }) =>
      this.get<PaginatedResponse<any>>('/compliance/flags', params),

    /**
     * Get count of open compliance flags
     */
    getOpenFlagsCount: async () => {
      const response = await this.get<PaginatedResponse<any>>('/compliance/flags', {
        status: 'open',
        limit: 1,
      });
      return response.pagination?.total || 0;
    },

    /**
     * Get compliance statistics
     */
    getStats: () =>
      this.get<{ data: any }>('/compliance/stats').then(r => r.data),
  };

  // ============================================
  // Refunds API
  // ============================================

  refunds = {
    /**
     * List all refunds
     */
    list: (params?: RefundsListParams) =>
      this.get<PaginatedResponse<Refund>>('/refunds', params),

    /**
     * Get a single refund
     */
    get: (id: string) =>
      this.get<{ data: Refund }>(`/refunds/${id}`).then(r => r.data),

    /**
     * Create a refund
     */
    create: (input: CreateRefundInput, idempotencyKey?: string) =>
      this.post<{ data: Refund }>('/refunds', input, { idempotencyKey }).then(r => r.data),
  };

  // ============================================
  // Scheduled Transfers API
  // ============================================

  scheduledTransfers = {
    /**
     * List all scheduled transfers
     */
    list: (params?: ScheduledTransfersListParams) =>
      this.get<PaginatedResponse<ScheduledTransfer>>('/scheduled-transfers', params),

    /**
     * Get a single scheduled transfer with execution history
     */
    get: (id: string) =>
      this.get<{ data: ScheduledTransfer }>(`/scheduled-transfers/${id}`).then(r => r.data),

    /**
     * Create a scheduled transfer
     */
    create: (input: CreateScheduledTransferInput) =>
      this.post<{ data: ScheduledTransfer }>('/scheduled-transfers', input).then(r => r.data),

    /**
     * Pause a scheduled transfer
     */
    pause: (id: string) =>
      this.post<{ data: ScheduledTransfer }>(`/scheduled-transfers/${id}/pause`).then(r => r.data),

    /**
     * Resume a paused scheduled transfer
     */
    resume: (id: string) =>
      this.post<{ data: ScheduledTransfer }>(`/scheduled-transfers/${id}/resume`).then(r => r.data),

    /**
     * Cancel a scheduled transfer
     */
    cancel: (id: string) =>
      this.post<{ data: ScheduledTransfer }>(`/scheduled-transfers/${id}/cancel`).then(r => r.data),

    /**
     * Execute a scheduled transfer immediately (demo only)
     */
    executeNow: (id: string) =>
      this.post<{ data: ScheduledTransfer; message: string }>(`/scheduled-transfers/${id}/execute-now`),
  };

  // ============================================
  // Exports API
  // ============================================

  exports = {
    /**
     * Generate a transaction export
     */
    generate: (params: GenerateExportInput) =>
      this.get<{ data: TransactionExport }>('/exports/transactions', params as unknown as Record<string, string>).then(r => r.data),

    /**
     * Get export status
     */
    getStatus: (id: string) =>
      this.get<{ data: TransactionExport }>(`/exports/${id}`).then(r => r.data),

    /**
     * Download export file
     */
    download: async (id: string): Promise<Blob> => {
      const url = new URL(`/v1/exports/${id}/download`, this.config.baseUrl);
      const response = await fetch(url.toString(), {
        headers: { 'Authorization': `Bearer ${this.config.apiKey}` },
      });
      if (!response.ok) {
        throw new Error('Failed to download export');
      }
      return response.blob();
    },
  };

  // ============================================
  // Payment Methods API
  // ============================================

  paymentMethods = {
    /**
     * List payment methods for an account
     */
    list: (accountId: string, params?: PaymentMethodsListParams) =>
      this.get<{ data: PaymentMethod[] }>(`/accounts/${accountId}/payment-methods`, params).then(r => r.data),

    /**
     * List ALL payment methods (for tenant)
     */
    listAll: (params?: PaymentMethodsListParams) =>
      this.get<PaginatedResponse<PaymentMethod>>('/payment-methods', params).then(r => r.data),

    /**
     * Get a single payment method
     */
    get: (id: string) =>
      this.get<{ data: PaymentMethod }>(`/payment-methods/${id}`).then(r => r.data),

    /**
     * Create a payment method for an account
     */
    create: (accountId: string, input: CreatePaymentMethodInput) =>
      this.post<{ data: PaymentMethod }>(`/accounts/${accountId}/payment-methods`, input).then(r => r.data),

    /**
     * Update a payment method
     */
    update: (id: string, input: Partial<{ label: string; isDefault: boolean }>) =>
      this.patch<{ data: PaymentMethod }>(`/payment-methods/${id}`, input).then(r => r.data),

    /**
     * Delete a payment method
     */
    delete: (id: string) =>
      this.delete<{ success: boolean }>(`/payment-methods/${id}`),

    /**
     * Get transactions for a card
     */
    getTransactions: (id: string, params?: PaginationParams) =>
      this.get<PaginatedResponse<any>>(`/payment-methods/${id}/transactions`, params),

    /**
     * Get spending summary for a card
     */
    getSpendingSummary: (id: string, days?: number) =>
      this.get<{ data: any }>(`/payment-methods/${id}/spending-summary`, { days }).then(r => r.data),
  };

  // ============================================
  // x402 Endpoints API
  // ============================================

  x402Endpoints = {
    /**
     * List all x402 endpoints
     */
    list: (params?: X402EndpointsListParams) =>
      this.get<PaginatedResponse<X402Endpoint>>('/x402/endpoints', params),

    /**
     * Get a single x402 endpoint
     */
    get: (id: string) =>
      this.get<{ data: X402Endpoint }>(`/x402/endpoints/${id}`).then(r => r.data),

    /**
     * Create a new x402 endpoint
     */
    create: (input: CreateX402EndpointInput) =>
      this.post<{ data: X402Endpoint }>('/x402/endpoints', input).then(r => r.data),

    /**
     * Update an x402 endpoint
     */
    update: (id: string, input: UpdateX402EndpointInput) =>
      this.patch<{ data: X402Endpoint }>(`/x402/endpoints/${id}`, input).then(r => r.data),

    /**
     * Delete an x402 endpoint
     */
    delete: (id: string) =>
      this.delete<{ success: boolean }>(`/x402/endpoints/${id}`),
  };

  // ============================================
  // Wallets API
  // ============================================

  wallets = {
    /**
     * List all wallets
     */
    list: (params?: WalletsListParams) =>
      this.get<PaginatedResponse<Wallet>>('/wallets', params),

    /**
     * Get a single wallet
     */
    get: (id: string) =>
      this.get<{ data: Wallet }>(`/wallets/${id}`).then(r => r.data),

    /**
     * Create a new wallet
     */
    create: (input: CreateWalletInput) =>
      this.post<{ data: Wallet }>('/wallets', input).then(r => r.data),

    /**
     * Update a wallet
     */
    update: (id: string, input: UpdateWalletInput) =>
      this.patch<{ data: Wallet }>(`/wallets/${id}`, input).then(r => r.data),

    /**
     * Delete a wallet
     */
    delete: (id: string) =>
      this.delete<{ success: boolean }>(`/wallets/${id}`),

    /**
     * Deposit funds into a wallet
     */
    deposit: (id: string, input: WalletDepositInput) =>
      this.post<{ data: Wallet }>(`/wallets/${id}/deposit`, input).then(r => r.data),

    /**
     * Withdraw funds from a wallet
     */
    withdraw: (id: string, input: WalletWithdrawInput) =>
      this.post<{ data: Wallet }>(`/wallets/${id}/withdraw`, input).then(r => r.data),
  };

  // ============================================
  // Funding Sources API
  // ============================================

  fundingSources = {
    /**
     * List funding sources (optionally filtered by account)
     */
    list: (params?: { accountId?: string; status?: string; limit?: number }) =>
      this.get<{ data: FundingSourceSummary[] }>('/funding/sources', {
        account_id: params?.accountId,
        status: params?.status,
        limit: params?.limit,
      }).then(r => r.data),

    /**
     * Get a single funding source
     */
    get: (id: string) =>
      this.get<{ data: FundingSourceSummary }>(`/funding/sources/${id}`).then(r => r.data),
  };

  // ============================================
  // x402 Payments API
  // ============================================

  x402Payments = {
    /**
     * Get a quote for an x402 endpoint
     */
    getQuote: (endpointId: string) =>
      this.get<{ data: X402Quote }>(`/x402/quote/${endpointId}`).then(r => r.data),

    /**
     * Process an x402 payment
     */
    pay: (input: X402PaymentInput, idempotencyKey?: string) =>
      this.post<{ data: X402PaymentResponse }>('/x402/pay', input, { idempotencyKey }).then(r => r.data),

    /**
     * Verify an x402 payment
     */
    verify: (input: X402VerifyPaymentInput) =>
      this.post<{ data: X402VerifyPaymentResponse }>('/x402/verify', input).then(r => r.data),
  };

  // ============================================
  // x402 Analytics API
  // ============================================

  x402Analytics = {
    /**
     * Get analytics summary
     */
    getSummary: (params?: { period?: string }) =>
      this.get<{ data: any }>('/x402/analytics/summary', params).then(r => r.data),

    /**
     * Get revenue time-series data
     */
    getRevenue: (params?: {
      period?: string;
      startDate?: string;
      endDate?: string;
      groupBy?: string;
      endpointId?: string;
      currency?: string;
    }) =>
      this.get<{ data: any }>('/x402/analytics/revenue', params).then(r => r.data),

    /**
     * Get top performing endpoints
     */
    getTopEndpoints: (params?: {
      metric?: 'revenue' | 'calls' | 'unique_payers';
      limit?: number;
      period?: string;
    }) =>
      this.get<{ data: any }>('/x402/analytics/top-endpoints', params).then(r => r.data),

    /**
     * Get analytics for a specific endpoint
     */
    getEndpointAnalytics: (endpointId: string, params?: { period?: string }) =>
      this.get<{ data: any }>(`/x402/analytics/endpoint/${endpointId}`, params).then(r => r.data),
  };

  // ============================================
  // AP2 API (Agent Payment Protocol)
  // ============================================

  ap2 = {
    /**
     * List mandates
     */
    list: (params?: MandatesListParams) => {
      const searchParams = new URLSearchParams();
      if (params?.page) searchParams.set('page', String(params.page));
      if (params?.limit) searchParams.set('limit', String(params.limit));
      if (params?.status) searchParams.set('status', params.status);
      if (params?.agentId) searchParams.set('agent_id', params.agentId);
      if (params?.accountId) searchParams.set('account_id', params.accountId);
      if (params?.search) searchParams.set('search', params.search);
      const query = searchParams.toString();
      return this.get<any>(`/ap2/mandates${query ? `?${query}` : ''}`).then(response => ({
        data: Array.isArray(response.data) ? response.data.map(transformMandate) : (response.data?.data || []).map(transformMandate),
        pagination: response.pagination || response.data?.pagination
      }));
    },

    /**
     * Get a mandate by ID
     */
    get: (id: string) =>
      this.get<{ data: any }>(`/ap2/mandates/${id}`).then(r => transformMandate(r.data)),

    /**
     * Create a new mandate
     */
    create: (input: CreateMandateInput) =>
      this.post<{ data: any }>('/ap2/mandates', {
        mandate_id: input.mandateId,
        mandate_type: input.type,
        agent_id: input.agentId,
        account_id: input.accountId,
        authorized_amount: input.authorizedAmount,
        currency: input.currency,
        expires_at: input.expiresAt,
        metadata: input.metadata,
        funding_source_id: input.fundingSourceId,
        settlement_rail: input.settlementRail,
      }).then(r => transformMandate(r.data)),

    /**
     * Update a mandate
     */
    update: (id: string, input: UpdateMandateInput) =>
      this.patch<{ data: any }>(`/ap2/mandates/${id}`, {
        status: input.status,
        authorized_amount: input.authorizedAmount,
        expires_at: input.expiresAt,
        metadata: input.metadata,
        funding_source_id: input.fundingSourceId,
        settlement_rail: input.settlementRail,
      }).then(r => transformMandate(r.data)),

    /**
     * Cancel a mandate
     */
    cancel: (id: string) =>
      this.patch<{ data: any }>(`/ap2/mandates/${id}/cancel`, {}).then(r => transformMandate(r.data)),

    /**
     * Execute a payment against a mandate
     */
    execute: (id: string, input: ExecuteMandatePaymentInput) =>
      this.post<{ data: any }>(`/ap2/mandates/${id}/execute`, {
        amount: input.amount,
        currency: input.currency,
        description: input.description,
        authorization_proof: input.authorizationProof,
        order_ids: input.orderIds,
      }).then(r => r.data),

    /**
     * Get AP2 analytics
     */
    getAnalytics: (params?: { period?: string }) =>
      this.get<{ data: any }>('/ap2/analytics', params).then(r => r.data),
  };

  // ============================================
  // A2A API (Google Agent-to-Agent Protocol)
  // ============================================

  a2a = {
    /**
     * Discover a remote A2A agent
     */
    discover: (url: string) =>
      this.post<{ data: A2AAgentCard }>('/a2a/discover', { url }).then(r => r.data),

    /**
     * Get a per-agent Agent Card
     */
    getAgentCard: (agentId: string) =>
      this.get<{ data: A2AAgentCard }>(`/a2a/agents/${agentId}/card`).then(r => r.data),

    /**
     * Send a task to a local or remote A2A agent
     */
    sendTask: (input: SendA2ATaskInput) =>
      this.post<{ data: A2ATask }>('/a2a/tasks', {
        agent_id: input.agentId,
        remote_url: input.remoteUrl,
        message: input.message,
        context_id: input.contextId,
        metadata: input.metadata,
        callback_url: input.callbackUrl,
        callback_secret: input.callbackSecret,
      }).then(r => r.data),

    /**
     * Get a task by ID
     */
    getTask: (taskId: string) =>
      this.get<{ data: A2ATask }>(`/a2a/tasks/${taskId}`).then(r => r.data),

    /**
     * List A2A tasks
     */
    listTasks: (params?: A2ATasksListParams) => {
      const searchParams = new URLSearchParams();
      if (params?.page) searchParams.set('page', String(params.page));
      if (params?.limit) searchParams.set('limit', String(params.limit));
      if (params?.state) searchParams.set('state', params.state);
      if (params?.agentId) searchParams.set('agent_id', params.agentId);
      if (params?.direction) searchParams.set('direction', params.direction);
      if (params?.contextId) searchParams.set('context_id', params.contextId);
      const query = searchParams.toString();
      return this.get<any>(`/a2a/tasks${query ? `?${query}` : ''}`).then(response => ({
        data: Array.isArray(response.data) ? response.data : (response.data?.data || []),
        pagination: response.pagination || response.data?.pagination,
      }));
    },

    /**
     * Cancel an A2A task
     */
    cancelTask: (taskId: string) =>
      this.post<{ data: A2ATask }>(`/a2a/tasks/${taskId}/cancel`, {}).then(r => r.data),

    /**
     * Get A2A task statistics
     */
    getStats: () =>
      this.get<{ data: any }>('/a2a/stats').then(r => r.data),

    /**
     * List A2A sessions (grouped by context_id)
     */
    listSessions: () =>
      this.get<{ data: any[] }>('/a2a/sessions').then(r => r.data),

    /**
     * Get a session's full conversation (tasks, messages, artifacts)
     */
    getSession: (contextId: string) =>
      this.get<{ data: any }>(`/a2a/sessions/${contextId}`).then(r => r.data),

    /**
     * Get agent processing configuration
     */
    getAgentConfig: (agentId: string) =>
      this.get<AgentProcessingConfig>(`/a2a/agents/${agentId}/config`),

    /**
     * Update agent processing configuration
     */
    updateAgentConfig: (agentId: string, config: AgentProcessingConfig) =>
      this.put<AgentProcessingConfig>(`/a2a/agents/${agentId}/config`, {
        processing_mode: config.processingMode,
        processing_config: config.processingConfig,
      }),

    /**
     * Respond to an escalated (input-required) task.
     * Used by humans or dashboards to provide input that unblocks the agent.
     * (Story 58.6 + 58.11)
     */
    respondToTask: (taskId: string, input: RespondToTaskInput) =>
      this.post<{ data: A2ATask }>(`/a2a/tasks/${taskId}/respond`, {
        parts: input.parts,
        metadata: input.metadata,
      }).then(r => r.data),

    /**
     * Update task state (external webhook callback)
     */
    updateTaskState: (taskId: string, update: TaskStateUpdate) =>
      this.patch<{ data: A2ATask }>(`/a2a/tasks/${taskId}`, update).then(r => r.data),

    /**
     * List dead-letter-queue tasks
     */
    listDlqTasks: (params?: PaginationParams) =>
      this.get<{ data: A2ADlqTask[]; pagination: { page: number; limit: number; total: number; totalPages: number } }>('/a2a/tasks/dlq', params),

    /**
     * Retry a DLQ'd task
     */
    retryDlqTask: (taskId: string) =>
      this.post<{ data: { id: string; state: string; message: string } }>(`/a2a/tasks/${taskId}/retry`, {}),

    /**
     * Stream task events via SSE (message/stream JSON-RPC method).
     * Returns an AsyncGenerator that yields A2AStreamEvent objects.
     */
    streamTask: (input: SendA2ATaskInput): AsyncIterable<A2AStreamEvent> => {
      const self = this;
      async function* generate(): AsyncGenerator<A2AStreamEvent> {
        const agentId = input.agentId;
        if (!agentId) throw new Error('agentId is required for streamTask');

        const url = new URL(`/a2a/${agentId}`, self.baseUrl);
        const configuration: Record<string, unknown> = {};
        if (input.callbackUrl) configuration.callbackUrl = input.callbackUrl;
        if (input.callbackSecret) configuration.callbackSecret = input.callbackSecret;

        const body = {
          jsonrpc: '2.0',
          id: `stream-${Date.now()}`,
          method: 'message/stream',
          params: {
            message: input.message,
            contextId: input.contextId,
            metadata: input.metadata,
            ...(Object.keys(configuration).length > 0 ? { configuration } : {}),
          },
        };

        const response = await fetch(url.toString(), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${self.apiKey}`,
            'Accept': 'text/event-stream',
          },
          body: JSON.stringify(body),
        });

        if (!response.ok || !response.body) {
          const text = await response.text();
          throw new Error(`Stream request failed (${response.status}): ${text}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let currentEvent = '';
        let currentData = '';

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (line.startsWith('event: ')) {
                currentEvent = line.slice(7).trim();
              } else if (line.startsWith('data: ')) {
                currentData = line.slice(6);
              } else if (line === '' && currentEvent && currentData) {
                // End of SSE event block
                try {
                  const parsed = JSON.parse(currentData);
                  const event: A2AStreamEvent = {
                    type: currentEvent as A2AStreamEventType,
                    taskId: parsed.taskId || '',
                    data: parsed,
                    timestamp: parsed.timestamp || new Date().toISOString(),
                  };
                  yield event;

                  // Stop on terminal states
                  if (currentEvent === 'status' && ['completed', 'failed', 'canceled', 'rejected'].includes(parsed.state)) {
                    return;
                  }
                } catch {
                  // Skip malformed events
                }
                currentEvent = '';
                currentData = '';
              }
            }
          }
        } finally {
          reader.releaseLock();
        }
      }

      return generate();
    },
  };

  // ============================================
  // Settlement API
  // ============================================

  settlement = {
    /**
     * Get settlement configuration
     */
    getConfig: () =>
      this.get<{ data: any }>('/settlement/config').then(r => r.data),

    /**
     * Update settlement configuration
     */
    updateConfig: (input: any) =>
      this.patch<{ data: any }>('/settlement/config', input).then(r => r.data),

    /**
     * Preview fee calculation
     */
    previewFee: (input: { amount: number; currency?: string }) =>
      this.post<{ data: any }>('/settlement/preview', input).then(r => r.data),

    /**
     * Get settlement analytics
     */
    getAnalytics: (params?: { startDate?: string; endDate?: string; type?: string }) =>
      this.get<{ data: any }>('/settlement/analytics', params).then(r => r.data),

    /**
     * Get settlement status for a transfer
     */
    getStatus: (transferId: string) =>
      this.get<{ data: any }>(`/settlement/status/${transferId}`).then(r => r.data),
  };

  // ============================================
  // ACP API (Agentic Commerce Protocol)
  // ============================================

  acp = {
    /**
     * List checkouts
     */
    list: (params?: CheckoutsListParams) => {
      const query = new URLSearchParams();
      if (params?.page) query.set('offset', String((params.page - 1) * (params.limit || 20)));
      if (params?.limit) query.set('limit', String(params.limit));
      if (params?.status) query.set('status', params.status);
      if (params?.merchant_id) query.set('merchant_id', params.merchant_id);
      if (params?.agent_id) query.set('agent_id', params.agent_id);
      if (params?.customer_id) query.set('customer_id', params.customer_id);

      return this.get<PaginatedResponse<any>>(`/acp/checkouts${query.toString() ? `?${query.toString()}` : ''}`).then(response => ({
        ...response,
        data: response.data.map(transformCheckout),
      }));
    },

    /**
     * Get checkout by ID
     */
    get: (id: string) =>
      this.get<{ data: any }>(`/acp/checkouts/${id}`).then(r => transformCheckout(r.data)),

    /**
     * Create new checkout
     */
    create: (data: CreateCheckoutInput) =>
      this.post<{ data: any }>('/acp/checkouts', data).then(r => transformCheckout(r.data)),

    /**
     * Complete checkout
     */
    complete: (id: string, data: {
      shared_payment_token: string;
      payment_method?: string;
      idempotency_key?: string;
    }) =>
      this.post<{ data: any }>(`/acp/checkouts/${id}/complete`, data).then(r => r.data),

    /**
     * Cancel checkout
     */
    cancel: (id: string) =>
      this.patch<{ data: any }>(`/acp/checkouts/${id}/cancel`, {}).then(r => transformCheckout(r.data)),

    /**
     * Edit checkout fields (sandbox only)
     */
    edit: (id: string, data: Record<string, any>) =>
      this.patch<{ data: any }>(`/acp/checkouts/${id}`, data).then(r => r.data),

    /**
     * Delete checkout (sandbox only)
     */
    delete: (id: string) =>
      this.delete<{ success: boolean }>(`/acp/checkouts/${id}`),

    /**
     * Get ACP analytics
     */
    getAnalytics: (params?: { period?: '24h' | '7d' | '30d' | '90d' | '1y' }) =>
      this.get<{ data: ACPAnalytics }>('/acp/analytics', params).then(r => r.data),
  };

  // ============================================
  // Treasury API
  // ============================================

  treasury = {
    /**
     * Get treasury dashboard
     */
    getDashboard: () =>
      this.get<{ data: DashboardSummary }>('/treasury/dashboard').then(r => r.data),

    /**
     * Get currency exposure
     */
    getExposure: () =>
      this.get<{ data: any }>('/treasury/exposure').then(r => r.data),

    /**
     * Get float runway
     */
    getRunway: () =>
      this.get<{ data: any }>('/treasury/runway').then(r => r.data),

    /**
     * Get settlement velocity
     */
    getVelocity: () =>
      this.get<{ data: any }>('/treasury/velocity').then(r => r.data),

    /**
     * Get history
     */
    getHistory: (params?: { rail?: string; currency?: string; days?: number }) =>
      this.get<{ data: any }>('/treasury/history', params).then(r => r.data),

    /**
     * Get partners float allocation
     */
    getPartners: () =>
      this.get<{ data: any }>('/treasury/partners').then(r => r.data),

    /**
     * List all treasury accounts
     */
    getAccounts: () =>
      this.get<{ data: TreasuryAccount[] }>('/treasury/accounts').then(r => r.data),

    /**
     * List transactions
     */
    getTransactions: (params?: { accountId?: string; limit?: number; offset?: number }) =>
      this.get<{ data: TreasuryTransaction[] }>('/treasury/transactions', params).then(r => r.data),

    /**
     * Create manual transaction
     */
    createTransaction: (data: any) =>
      this.post<{ data: TreasuryTransaction }>('/treasury/transactions', data).then(r => r.data),

    /**
     * List alerts
     */
    getAlerts: (params?: { status?: string; severity?: string; limit?: number }) =>
      this.get<{ data: TreasuryAlert[] }>('/treasury/alerts', params).then(r => r.data),

    /**
     * Trigger alert check
     */
    checkAlerts: () =>
      this.post<{ success: boolean; alertsCount: number }>('/treasury/alerts/check'),

    /**
     * Acknowledge alert
     */
    acknowledgeAlert: (id: string) =>
      this.post<{ data: TreasuryAlert }>(`/treasury/alerts/${id}/acknowledge`).then(r => r.data),

    /**
     * Resolve alert
     */
    resolveAlert: (id: string) =>
      this.post<{ data: TreasuryAlert }>(`/treasury/alerts/${id}/resolve`).then(r => r.data),

    /**
     * Get recommendations
     */
    getRecommendations: (params?: { status?: string; limit?: number }) =>
      this.get<{ data: Recommendation[] }>('/treasury/recommendations', params).then(r => r.data),

    /**
     * Generate rebalancing recommendations
     */
    generateRecommendations: () =>
      this.post<{ data: Recommendation[] }>('/treasury/recommendations/generate').then(r => r.data),

    /**
     * Approve recommendation
     */
    approveRecommendation: (id: string) =>
      this.post<{ data: Recommendation }>(`/treasury/recommendations/${id}/approve`).then(r => r.data),

    /**
     * Reject recommendation
     */
    rejectRecommendation: (id: string) =>
      this.post<{ data: Recommendation }>(`/treasury/recommendations/${id}/reject`).then(r => r.data),

    /**
     * Sync balances
     */
    sync: () =>
      this.post<{ success: boolean }>('/treasury/sync'),

    /**
     * Take snapshot
     */
    snapshot: () =>
      this.post<{ data: any }>('/treasury/snapshot').then(r => r.data),
  };

  // ============================================
  // Approvals API
  // ============================================

  approvals = {
    /**
     * List approvals with optional filters
     */
    list: (params?: ApprovalsListParams) => {
      const query = new URLSearchParams();
      if (params?.page) query.set('page', String(params.page));
      if (params?.limit) query.set('limit', String(params.limit));
      if (params?.status) query.set('status', params.status);
      if (params?.walletId) query.set('wallet_id', params.walletId);
      if (params?.agentId) query.set('agent_id', params.agentId);
      if (params?.protocol) query.set('protocol', params.protocol);
      return this.get<PaginatedResponse<Approval>>(`/approvals${query.toString() ? `?${query.toString()}` : ''}`);
    },

    /**
     * Get a single approval by ID
     */
    get: (id: string) =>
      this.get<{ data: Approval }>(`/approvals/${id}`).then(r => r.data),

    /**
     * Get pending approvals summary
     */
    getPending: () =>
      this.get<{ data: PendingApprovalsSummary }>('/approvals/pending').then(r => r.data),

    /**
     * Approve a pending approval
     */
    approve: (id: string, input?: ApproveRejectInput) =>
      this.post<{ data: Approval }>(`/approvals/${id}/approve`, input || {}).then(r => r.data),

    /**
     * Reject a pending approval
     */
    reject: (id: string, input?: ApproveRejectInput) =>
      this.post<{ data: Approval }>(`/approvals/${id}/reject`, input || {}).then(r => r.data),
  };

  // ============================================
  // UCP API (Universal Commerce Protocol)
  // ============================================

  ucp = {
    /**
     * List settlements
     */
    list: (params?: UCPSettlementsListParams) => {
      const query = new URLSearchParams();
      if (params?.page) query.set('offset', String((params.page - 1) * (params.limit || 20)));
      if (params?.limit) query.set('limit', String(params.limit));
      if (params?.status) query.set('status', params.status);
      if (params?.corridor) query.set('corridor', params.corridor);

      return this.get<PaginatedResponse<UCPSettlement>>(`/ucp/settlements${query.toString() ? `?${query.toString()}` : ''}`);
    },

    /**
     * Get settlement by ID
     */
    get: (id: string) =>
      this.get<UCPSettlement>(`/ucp/settlements/${id}`),

    /**
     * Get available corridors
     */
    getCorridors: () =>
      this.get<{ corridors: UCPCorridorInfo[] }>('/ucp/corridors').then(r => r.corridors),

    /**
     * Get UCP handler info
     */
    getInfo: () =>
      this.get<{ handler: { id: string; name: string; version: string }; supported_corridors: string[]; supported_currencies: string[] }>('/ucp/info'),

    /**
     * Get quote for a settlement
     */
    getQuote: (params: { corridor: 'pix' | 'spei'; amount: number; currency: 'USD' | 'USDC' }) =>
      this.post<UCPQuote>('/ucp/quote', params),

    /**
     * Get UCP analytics
     */
    getAnalytics: (params?: { period?: '24h' | '7d' | '30d' | '90d' | '1y' }) =>
      this.get<{ data: UCPAnalytics }>('/ucp/analytics', params).then(r => r.data),

    // ============================================
    // PayOS Hosted Checkouts (Phase 2)
    // ============================================
    checkouts: {
      /**
       * List PayOS hosted checkout sessions
       */
      list: (params?: { status?: string; agent_id?: string; limit?: number; offset?: number }) => {
        const query = new URLSearchParams();
        if (params?.limit) query.set('limit', String(params.limit));
        if (params?.offset) query.set('offset', String(params.offset));
        if (params?.status) query.set('status', params.status);
        if (params?.agent_id) query.set('agent_id', params.agent_id);
        return this.get<PaginatedResponse<any>>(`/ucp/checkouts${query.toString() ? `?${query.toString()}` : ''}`);
      },

      /**
       * Get aggregate checkout stats with FX-normalized USD volume
       */
      stats: () =>
        this.get<{ data: { total_checkouts: number; completed_checkouts: number; total_volume_usd: number } }>('/ucp/checkouts/stats').then(r => r.data),

      /**
       * Get a hosted checkout by ID
       */
      get: (id: string) =>
        this.get<{ data: any }>(`/ucp/checkouts/${id}`).then(r => r.data),

      /**
       * Create a hosted checkout session
       */
      create: (data: any) =>
        this.post<{ data: any }>('/ucp/checkouts', data).then(r => r.data),

      /**
       * Update a hosted checkout session
       */
      update: (id: string, data: any) =>
        this.patch<{ data: any }>(`/ucp/checkouts/${id}`, data).then(r => r.data),

      /**
       * Complete a hosted checkout
       */
      complete: (id: string) =>
        this.post<{ data: any }>(`/ucp/checkouts/${id}/complete`).then(r => r.data),

      /**
       * Cancel a hosted checkout
       */
      cancel: (id: string) =>
        this.post<{ data: any }>(`/ucp/checkouts/${id}/cancel`).then(r => r.data),

      /**
       * Edit checkout fields (sandbox only)
       */
      edit: (id: string, data: Record<string, any>) =>
        this.patch<{ data: any }>(`/ucp/checkouts/${id}/edit`, data).then(r => r.data),

      /**
       * Delete a hosted checkout (sandbox only)
       */
      delete: (id: string) =>
        this.delete<{ success: boolean }>(`/ucp/checkouts/${id}`),
    },

    // ============================================
    // Orders (Phase 3)
    // ============================================
    orders: {
      /**
       * List orders
       */
      list: (params?: { status?: string; agent_id?: string; limit?: number; offset?: number }) => {
        const query = new URLSearchParams();
        if (params?.limit) query.set('limit', String(params.limit));
        if (params?.offset) query.set('offset', String(params.offset));
        if (params?.status) query.set('status', params.status);
        if (params?.agent_id) query.set('agent_id', params.agent_id);
        return this.get<PaginatedResponse<any>>(`/ucp/orders${query.toString() ? `?${query.toString()}` : ''}`);
      },

      /**
       * Get an order by ID
       */
      get: (id: string) =>
        this.get<{ data: any }>(`/ucp/orders/${id}`).then(r => r.data),

      /**
       * Update order status
       */
      updateStatus: (id: string, status: string) =>
        this.patch<{ data: any }>(`/ucp/orders/${id}/status`, { status }).then(r => r.data),

      /**
       * Add fulfillment event to an order
       */
      addEvent: (id: string, event: { type: string; description: string; tracking_url?: string; tracking_number?: string }) =>
        this.post<{ data: any }>(`/ucp/orders/${id}/events`, event).then(r => r.data),

      /**
       * Add adjustment to an order (refund, return, credit)
       */
      addAdjustment: (id: string, adjustment: { type: string; amount: number; currency: string; reason: string }) =>
        this.post<{ data: any }>(`/ucp/orders/${id}/adjustments`, adjustment).then(r => r.data),
    },

    // ============================================
    // Identity (Phase 4 - OAuth 2.0)
    // ============================================
    identity: {
      /**
       * List OAuth clients
       */
      listClients: () =>
        this.get<{ data: any[] }>('/ucp/identity/clients'),

      /**
       * Register a new OAuth client
       */
      registerClient: (data: { name: string; client_type: 'confidential' | 'public'; redirect_uris: string[]; allowed_scopes: string[] }) =>
        this.post<any>('/ucp/identity/clients', data),

      /**
       * Deactivate an OAuth client
       */
      deactivateClient: (id: string) =>
        this.patch<{ data: any }>(`/ucp/identity/clients/${id}/deactivate`, {}),

      /**
       * List linked buyer accounts
       */
      listLinkedAccounts: (params: { buyer_id?: string; platform_id?: string }) => {
        const query = new URLSearchParams();
        if (params.buyer_id) query.set('buyer_id', params.buyer_id);
        if (params.platform_id) query.set('platform_id', params.platform_id);
        return this.get<{ data: any[] }>(`/ucp/identity/linked-accounts${query.toString() ? `?${query.toString()}` : ''}`);
      },

      /**
       * Unlink a buyer account
       */
      unlinkAccount: (platformId: string, buyerId: string) =>
        this.delete<{ success: boolean }>(`/ucp/identity/linked-accounts/${platformId}/${buyerId}`),

      /**
       * Get available scopes
       */
      getScopes: () =>
        this.get<{ data: { scope: string; description: string }[] }>('/ucp/identity/scopes'),
    },
  };
}


/**
 * Create a Sly client instance
 */
export function createSlyClient(config: SlyClientConfig): SlyClient {
  return new SlyClient(config);
}

// Backward compatibility aliases
export { SlyClient as PayOSClient };
export { createSlyClient as createPayOSClient };

// Helper to transform backend mandate response to frontend Mandate type
function transformMandate(data: any): Mandate {
  return {
    id: data.id,
    tenantId: data.tenant_id,
    mandateId: data.mandate_id,
    type: data.mandate_type,
    agent: {
      id: data.agent_id,
      name: data.agent?.name || data.agent_name || 'Unknown Agent',
    },
    account: {
      id: data.account_id,
      name: data.account?.name || 'Unknown Account',
    },
    amount: {
      authorized: Number(data.authorized_amount) || 0,
      used: Number(data.used_amount) || 0,
      remaining: Number(data.remaining_amount) || 0,
      currency: data.currency,
    },
    executionCount: data.execution_count || 0,
    status: data.status,
    expiresAt: data.expires_at,
    metadata: data.metadata,
    mandateData: data.mandate_data,
    fundingSource: data.funding_source || null,
    fundingSourceId: data.funding_source_id || null,
    settlementRail: data.settlement_rail || null,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
    executions: data.executions?.map((e: any) => ({
      id: e.id,
      executionIndex: e.execution_index,
      amount: Number(e.amount),
      currency: e.currency,
      status: e.status,
      transferId: e.transfer_id,
      createdAt: e.created_at,
      completedAt: e.completed_at,
    })) || [],
  };
}

// Helper to transform backend checkout response to frontend ACPCheckout type
function transformCheckout(checkout: any): ACPCheckout {
  return {
    ...checkout,
    subtotal: parseFloat(checkout.subtotal || '0'),
    tax_amount: parseFloat(checkout.tax_amount || '0'),
    shipping_amount: parseFloat(checkout.shipping_amount || '0'),
    discount_amount: parseFloat(checkout.discount_amount || '0'),
    total_amount: parseFloat(checkout.total_amount || '0'),
    items: checkout.items?.map((item: any) => ({
      ...item,
      unit_price: parseFloat(item.unit_price || '0'),
      total_price: parseFloat(item.total_price || '0'),
    })),
  };
}

