/**
 * PayOS API Types
 * These types match the API response structures
 */

// ============================================
// Common Types
// ============================================

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface PaginationParams {
  page?: number;
  limit?: number;
}

// ============================================
// Account Types
// ============================================

export type AccountType = 'person' | 'business' | 'agent';
export type VerificationStatus = 'unverified' | 'pending' | 'verified' | 'suspended';

/**
 * Secondary classification for a business account. Present only when
 * type='business' — 'merchant' means the account has a product catalog and
 * can be transacted with via ACP/UCP/x402. null for people, agents, or
 * unlabeled businesses.
 */
export type AccountSubtype = 'merchant' | 'standard';

export interface Account {
  id: string;
  tenantId: string;
  type: AccountType;
  /** Secondary classification (only set for type='business'). */
  subtype?: AccountSubtype | null;
  name: string;
  email?: string;
  country?: string;
  currency: string; // 'USDC', 'USDT', etc.
  verificationTier: number;
  verificationStatus: VerificationStatus;
  verificationType?: 'kyc' | 'kyb';
  balanceTotal: number;
  balanceAvailable: number;
  balanceInStreams: number;
  balanceBuffer: number;
  /** Arbitrary tenant-owned JSON. Merchants use this for pos_provider, catalog, rating, etc. */
  metadata?: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export interface AccountBalance {
  total: number;
  available: number;
  inStreams: {
    total: number;
    buffer: number;
    streaming: number;
  };
  currency: string;
}

export interface CreateAccountInput {
  type: AccountType;
  name: string;
  email?: string;
}

export interface AccountsListParams extends PaginationParams {
  type?: AccountType;
  status?: VerificationStatus;
  search?: string;
}

// ============================================
// Agent Types
// ============================================

export type AgentStatus = 'active' | 'paused' | 'suspended';
export type KYAStatus = 'unverified' | 'pending' | 'verified' | 'suspended';

export interface Agent {
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  status: AgentStatus;
  kyaTier: number;
  kyaStatus: KYAStatus;
  parentAccount: {
    id: string;
    type: AccountType;
    name: string;
    verificationTier: number;
  };
  permissions: AgentPermissions;
  processingMode?: 'managed' | 'webhook' | 'manual';
  processingConfig?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AgentPermissions {
  transactions: { initiate: boolean; approve: boolean; view: boolean };
  streams: { initiate: boolean; modify: boolean; pause: boolean; terminate: boolean; view: boolean };
  accounts: { view: boolean; create: boolean };
  treasury: { view: boolean; rebalance: boolean };
}

export interface AgentLimits {
  agentId: string;
  kyaTier: number;
  status: AgentStatus;
  limits: {
    perTransaction: number;
    daily: number;
    monthly: number;
  };
  effectiveLimits: {
    perTransaction: number;
    daily: number;
    monthly: number;
    cappedByParent: boolean;
  };
  parentAccount: {
    id: string;
    name: string;
    verificationTier: number;
    verificationStatus: VerificationStatus;
  } | null;
  usage: {
    daily: number;
    monthly: number;
    dailyRemaining: number;
    monthlyRemaining: number;
  };
  streams: {
    active: number;
    maxActive: number;
    totalOutflow: number;
    maxTotalOutflow: number;
  };
}

export interface AgentCredentials {
  token: string;
  prefix: string;
  warning: string;
}

export interface CreateAgentInput {
  parentAccountId: string;
  name: string;
  description?: string;
  permissions?: Partial<AgentPermissions>;
}

export interface UpdateAgentInput {
  name?: string;
  description?: string | null;
  permissions?: Partial<AgentPermissions>;
  dailyLimit?: number;
  monthlyLimit?: number;
  perTransactionLimit?: number;
}

export interface CreateAgentResponse {
  data: Agent;
  credentials: AgentCredentials;
}

export interface AgentsListParams extends PaginationParams {
  status?: AgentStatus;
  kyaTier?: number;
  parentAccountId?: string;
}

// ============================================
// Stream Types
// ============================================

export type StreamStatus = 'active' | 'paused' | 'cancelled';
export type StreamHealth = 'healthy' | 'warning' | 'critical';
export type StreamCategory = 'salary' | 'subscription' | 'service' | 'other';

export interface Stream {
  id: string;
  tenantId: string;
  status: StreamStatus;
  sender: {
    accountId: string;
    accountName: string;
  };
  receiver: {
    accountId: string;
    accountName: string;
  };
  initiatedBy: {
    type: 'user' | 'agent';
    id: string;
    name: string;
    timestamp: string;
  };
  managedBy: {
    type: 'user' | 'agent';
    id: string;
    name: string;
    permissions: {
      canModify: boolean;
      canPause: boolean;
      canTerminate: boolean;
    };
  };
  flowRate: {
    perSecond: number;
    perMonth: number;
    currency: string;
  };
  streamed: {
    total: number;
    withdrawn: number;
    available: number;
  };
  funding: {
    wrapped: number;
    buffer: number;
    runway: {
      seconds: number;
      display: string;
    };
  };
  health: StreamHealth;
  description?: string;
  category?: StreamCategory;
  startedAt: string;
  pausedAt?: string;
  cancelledAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StreamEvent {
  id: string;
  streamId: string;
  eventType: string;
  actor: {
    type: 'user' | 'agent' | 'system';
    id: string;
    name: string;
  };
  data: Record<string, unknown>;
  createdAt: string;
}

export interface CreateStreamInput {
  senderAccountId: string;
  receiverAccountId: string;
  flowRatePerMonth: number;
  fundingAmount?: number;
  description?: string;
  category?: StreamCategory;
}

export interface StreamsListParams extends PaginationParams {
  status?: StreamStatus;
  health?: StreamHealth;
  category?: StreamCategory;
  senderAccountId?: string;
  receiverAccountId?: string;
}

export interface StreamStats {
  activeCount: number;
  pausedCount: number;
  totalFlowPerMonth: number;
  totalFunded: number;
  totalStreamed: number;
}

// ============================================
// Transfer Types
// ============================================

export type TransferType = 'cross_border' | 'internal' | 'stream_start' | 'stream_withdraw' | 'deposit' | 'withdrawal' | 'x402' | 'payout' | 'refund' | 'wallet_transfer' | 'mpp';
export type TransferStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';

export interface Transfer {
  id: string;
  tenantId: string;
  type: TransferType;
  status: TransferStatus;
  from: {
    accountId: string;
    accountName: string;
  } | null;
  to: {
    accountId: string;
    accountName: string;
  } | null;
  initiatedBy: {
    type: 'user' | 'agent' | 'system' | 'api_key';
    id: string;
    name?: string | null;
  };
  amount: number;
  currency: string;
  destinationAmount?: number;
  destinationCurrency?: string;
  fxRate?: number;
  feeAmount: number;
  fees?: {
    amount: number;
    currency: string;
    breakdown?: Array<{ type: string; amount: number }>;
  };
  description?: string;
  createdAt: string;
  completedAt?: string;
  failedAt?: string;
  failureReason?: string;
  idempotencyKey?: string;
  streamId?: string;
  x402Metadata?: {
    endpoint_id?: string;
    endpoint_path?: string;
    endpoint_method?: string;
    wallet_id?: string;
    request_id?: string;
    timestamp?: string;
    price_calculated?: number;
    volume_tier?: number;
    settlement_fee?: number;
    settlement_net_amount?: number;
    metadata?: Record<string, unknown>;
    fee_calculation?: {
      grossAmount?: number;
      feeAmount?: number;
      netAmount?: number;
      feeType?: string;
    };
  };
}

export interface CreateTransferInput {
  fromAccountId: string;
  toAccountId: string;
  amount: number;
  currency?: string;
  description?: string;
}

export interface CreateInternalTransferInput {
  fromAccountId: string;
  toAccountId: string;
  amount: number;
  currency?: string;
  description?: string;
}

export interface TransfersListParams extends PaginationParams {
  status?: TransferStatus;
  type?: TransferType;
  accountId?: string;
  walletId?: string;
  endpointId?: string;
  initiated_by_id?: string;
  initiated_by_type?: 'agent' | 'user' | 'api_key';
  x402_endpoint_id?: string;
  x402_provider_account_id?: string;
  x402_consumer_account_id?: string;
  x402_wallet_id?: string;
}

// ============================================
// Agent Transaction Types
// ============================================

export interface AgentTransaction {
  id: string;
  type: string;
  status: string;
  currency: string;
  amount: number;
  order_id: string | null;
  created_at: string;
  description: string | null;
  from_account_name: string | null;
  to_account_name: string | null;
  protocol: string | null;
  fee_amount: number;
}

// ============================================
// Quote Types
// ============================================

export interface Quote {
  id: string;
  fromCurrency: string;
  toCurrency: string;
  fromAmount: number;
  toAmount: number;
  fxRate: number;
  feeAmount: number;
  feeBreakdown: Array<{ type: string; amount: number }>;
  expiresAt: string;
  createdAt: string;
}

export interface CreateQuoteInput {
  fromCurrency: string;
  toCurrency: string;
  fromAmount: number;
}

// ============================================
// Report Types
// ============================================

export type ReportType = 'statement' | 'transactions' | 'streams' | 'activity_log' | 'report';
export type ReportStatus = 'generating' | 'ready' | 'failed';
export type ReportFormat = 'pdf' | 'csv' | 'json';

export interface Report {
  id: string;
  tenantId: string;
  type: ReportType;
  name: string;
  status: ReportStatus;
  format?: ReportFormat;
  periodStart?: string;
  periodEnd?: string;
  summary?: Record<string, unknown>;
  createdAt: string;
  generatedAt?: string;
}

export interface CreateReportInput {
  type: ReportType;
  accountId?: string;
  startDate?: string;
  endDate?: string;
  format?: ReportFormat;
}

export interface ReportsListParams extends PaginationParams {
  type?: ReportType;
  status?: ReportStatus;
}

// ============================================
// Audit Log Types
// ============================================

export interface AuditLogEntry {
  id: string;
  entityType: string;
  entityId: string;
  action: string;
  actor: {
    type: 'user' | 'agent' | 'system';
    id: string;
    name?: string;
  };
  changes?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface AuditLogsParams extends PaginationParams {
  entityType?: string;
  entityId?: string;
  action?: string;
  actorId?: string;
}

// ============================================
// Ledger Entry Types
// ============================================

export interface LedgerEntry {
  id: string;
  type: 'credit' | 'debit';
  amount: number;
  currency: string; // 'USDC', 'USDT', etc.
  balanceAfter: number;
  referenceType: string | null;
  referenceId: string | null;
  description: string;
  createdAt: string;
}

// ============================================
// Refund Types
// ============================================

export type RefundStatus = 'pending' | 'completed' | 'failed';
export type RefundReason = 'duplicate_payment' | 'service_not_rendered' | 'customer_request' | 'error' | 'other';

export interface Refund {
  id: string;
  tenantId: string;
  originalTransferId: string;
  status: RefundStatus;
  amount: number;
  currency: string;
  reason: RefundReason;
  reasonDetails?: string;
  fromAccountId: string;
  toAccountId: string;
  idempotencyKey?: string;
  createdAt: string;
  completedAt?: string;
  failedAt?: string;
  failureReason?: string;
}

export interface CreateRefundInput {
  originalTransferId: string;
  amount?: number; // Optional for full refund
  reason: RefundReason;
  reasonDetails?: string;
}

export interface RefundsListParams extends PaginationParams {
  status?: RefundStatus;
  originalTransferId?: string;
  accountId?: string;
  fromDate?: string;
  toDate?: string;
}

// ============================================
// Scheduled Transfer Types
// ============================================

export type ScheduleStatus = 'active' | 'paused' | 'completed' | 'cancelled';
export type ScheduleFrequency = 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'custom';

export interface ScheduledTransfer {
  id: string;
  tenantId: string;
  fromAccountId: string;
  toAccountId?: string;
  toPaymentMethodId?: string;
  amount: number;
  currency: string;
  description?: string;
  frequency: ScheduleFrequency;
  intervalValue: number;
  dayOfMonth?: number;
  dayOfWeek?: number;
  timezone: string;
  startDate: string;
  endDate?: string;
  maxOccurrences?: number;
  status: ScheduleStatus;
  occurrencesCompleted: number;
  nextExecution?: string;
  lastExecution?: string;
  createdAt: string;
  updatedAt: string;
  executions?: Transfer[]; // Populated on single GET
}

export interface CreateScheduledTransferInput {
  fromAccountId: string;
  toAccountId?: string;
  toPaymentMethodId?: string;
  amount: number;
  currency?: string;
  description?: string;
  frequency: ScheduleFrequency;
  intervalValue?: number;
  dayOfMonth?: number;
  dayOfWeek?: number;
  timezone?: string;
  startDate: string;
  endDate?: string;
  maxOccurrences?: number;
}

export interface ScheduledTransfersListParams extends PaginationParams {
  status?: ScheduleStatus;
  fromAccountId?: string;
  toAccountId?: string;
}

// ============================================
// Transaction Export Types
// ============================================

export type ExportFormat = 'quickbooks' | 'quickbooks4' | 'xero' | 'netsuite' | 'payos';
export type DateFormatType = 'US' | 'UK';
export type ExportStatus = 'processing' | 'ready' | 'failed';

export interface TransactionExport {
  exportId: string;
  status: ExportStatus;
  format: ExportFormat;
  recordCount: number;
  downloadUrl?: string;
  expiresAt?: string;
}

export interface GenerateExportInput {
  startDate: string;
  endDate: string;
  format: ExportFormat;
  dateFormat?: DateFormatType;
  includeRefunds?: boolean;
  includeStreams?: boolean;
  includeFees?: boolean;
  accountId?: string;
  corridor?: string;
  currency?: string;
}

// ============================================
// Payment Method Types
// ============================================

export type PaymentMethodType = 'bank_account' | 'wallet' | 'card';
export type WalletNetwork = 'base' | 'polygon' | 'ethereum';

export interface PaymentMethod {
  id: string;
  tenantId: string;
  accountId: string;
  type: PaymentMethodType;
  label?: string;
  isDefault: boolean;
  isVerified: boolean;
  // Bank account fields
  bankCountry?: string;
  bankCurrency?: string;
  bankAccountLastFour?: string;
  bankRoutingLastFour?: string;
  bankName?: string;
  bankAccountHolder?: string;
  // Wallet fields
  walletNetwork?: WalletNetwork;
  walletAddress?: string;
  // Card fields
  cardId?: string;
  cardLastFour?: string;
  createdAt: string;
  verifiedAt?: string;
}

export interface CreatePaymentMethodInput {
  type: PaymentMethodType;
  label?: string;
  isDefault?: boolean;
  // Bank account fields
  bankCountry?: string;
  bankCurrency?: string;
  bankAccountLastFour?: string;
  bankRoutingLastFour?: string;
  bankName?: string;
  bankAccountHolder?: string;
  // Wallet fields
  walletNetwork?: WalletNetwork;
  walletAddress?: string;
}

export interface PaymentMethodsListParams extends PaginationParams {
  type?: PaymentMethodType;
  isDefault?: boolean;
  isVerified?: boolean;
}

// ============================================
// x402 Types
// ============================================

export type X402EndpointMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'ANY';
export type X402EndpointStatus = 'active' | 'paused' | 'disabled';
export type X402Currency = 'USDC' | 'EURC';
export type WalletStatus = 'active' | 'frozen' | 'depleted';

export interface X402Endpoint {
  id: string;
  tenantId: string;
  accountId: string;
  name: string;
  path: string;
  method: X402EndpointMethod;
  description?: string;
  basePrice: number;
  currency: X402Currency;
  volumeDiscounts?: Array<{ threshold: number; priceMultiplier: number }>;
  paymentAddress?: string;
  assetAddress?: string;
  network: string;
  totalCalls: number;
  totalRevenue: number;
  status: X402EndpointStatus;
  webhookUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateX402EndpointInput {
  accountId: string;
  name: string;
  path: string;
  method: X402EndpointMethod;
  description?: string;
  basePrice: number;
  currency?: X402Currency;
  volumeDiscounts?: Array<{ threshold: number; priceMultiplier: number }>;
  paymentAddress?: string;
  assetAddress?: string;
  network?: string;
  webhookUrl?: string;
}

export interface UpdateX402EndpointInput {
  name?: string;
  description?: string;
  basePrice?: number;
  volumeDiscounts?: Array<{ threshold: number; priceMultiplier: number }>;
  status?: X402EndpointStatus;
  webhookUrl?: string;
}

export interface X402EndpointsListParams extends PaginationParams {
  accountId?: string;
  status?: X402EndpointStatus;
  method?: X402EndpointMethod;
}

// ============================================
// Spending Policy Types
// ============================================

export interface SpendingPolicy {
  // Spending limits
  dailySpendLimit?: number;
  monthlySpendLimit?: number;

  // Current usage (tracked by backend)
  dailySpent?: number;
  monthlySpent?: number;

  // Reset timestamps
  dailyResetAt?: string;
  monthlyResetAt?: string;

  // Approval threshold (soft limit - payments above this need approval)
  approvalThreshold?: number;
  requiresApprovalAbove?: number;

  // Allowlists
  approvedEndpoints?: string[];
  approvedVendors?: string[];
  approvedCategories?: string[];

  // Auto-fund configuration
  autoFundEnabled?: boolean;
  autoFundThreshold?: number;
  autoFundAmount?: number;
  autoFundSourceAccountId?: string;
}

export interface Wallet {
  id: string;
  tenantId: string;
  ownerAccountId: string;
  managedByAgentId?: string;
  balance: number;
  currency: X402Currency;
  walletAddress?: string;
  network?: string;
  spendingPolicy?: SpendingPolicy;
  status: WalletStatus;
  name?: string;
  purpose?: string;
  verificationStatus?: 'verified' | 'unverified';
  createdAt: string;
  updatedAt: string;
}

export interface CreateWalletInput {
  ownerAccountId: string;
  managedByAgentId?: string;
  currency?: X402Currency;
  spendingPolicy?: Partial<SpendingPolicy>;
  name?: string;
  purpose?: string;
  type?: 'internal' | 'circle_custodial';
  blockchain?: 'base' | 'polygon' | 'ethereum';
}

export interface UpdateWalletInput {
  spendingPolicy?: Partial<SpendingPolicy>;
  name?: string;
  purpose?: string;
  status?: WalletStatus;
}

export interface WalletsListParams extends PaginationParams {
  ownerAccountId?: string;
  managedByAgentId?: string;
  status?: WalletStatus;
  currency?: X402Currency;
}

export interface WalletDepositInput {
  amount: number;
}

export interface WalletWithdrawInput {
  amount: number;
  /** Receiving account UUID — required by the API. */
  destinationAccountId: string;
  /** Optional memo / reference string stored on the transfer row. */
  reference?: string;
}

export interface X402Quote {
  endpointId: string;
  basePrice: number;
  finalPrice: number;
  currency: X402Currency;
  discount?: number;
  totalCalls?: number;
}

export interface X402PaymentInput {
  endpointId: string;
  walletId: string;
  requestId: string;
  amount?: number;
  metadata?: Record<string, unknown>;
}

export interface X402PaymentResponse {
  success: boolean;
  transferId: string;
  walletBalance: number;
  endpointTotalCalls: number;
  endpointTotalRevenue: number;
}

export interface X402VerifyPaymentInput {
  transferId: string;
}

export interface X402VerifyPaymentResponse {
  verified: boolean;
  transfer: Transfer;
}

// ============================================
// AP2 Types (Agent Payment Protocol)
// ============================================

export type MandateStatus = 'active' | 'completed' | 'cancelled' | 'expired';
export type MandateType = 'intent' | 'cart' | 'payment';

export interface MandateExecution {
  id: string;
  executionIndex: number;
  amount: number;
  currency: string;
  status: string;
  transferId: string;
  createdAt: string;
  completedAt?: string;
}

export interface FundingSourceSummary {
  id: string;
  type: string;
  provider: string;
  displayName: string;
  lastFour?: string;
  brand?: string;
  status: string;
}

// Crypto Onramp Types (Coinbase Onramp)
export interface OnrampSessionInput {
  walletId: string;
}

export interface OnrampSessionResponse {
  session_token: string;
  wallet_address: string;
  blockchain: string;
  network: string;
}

export interface StripeOnrampSessionResponse {
  client_secret: string;
  session_id: string;
  wallet_address: string;
  blockchain: string;
  network: string;
}

export interface WithdrawExternalInput {
  walletId: string;
  destinationAddress: string;
  amount: number;
  currency?: string;
}

export interface WithdrawExternalResponse {
  transfer_id: string;
  tx_hash?: string;
  status: string;
  amount: number;
}

export interface CrossmintOrderInput {
  walletId: string;
  amount?: string;
  receiptEmail?: string;
}

export interface CrossmintOrderResponse {
  order_id: string;
  client_secret: string;
  wallet_address: string;
  blockchain: string;
}

export interface Mandate {
  id: string;
  tenantId: string;
  mandateId: string;
  type: MandateType;
  agent: {
    id: string;
    name: string;
  };
  account: {
    id: string;
    name: string;
  };
  amount: {
    authorized: number;
    used: number;
    remaining: number;
    currency: string;
  };
  executionCount: number;
  status: MandateStatus;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
  mandateData?: Record<string, unknown>;
  fundingSource?: FundingSourceSummary | null;
  fundingSourceId?: string | null;
  settlementRail?: string | null;
  createdAt: string;
  updatedAt: string;
  executions?: MandateExecution[];
}

export interface CreateMandateInput {
  mandateId: string; // The external AP2 ID
  type: MandateType;
  agentId: string;
  accountId: string;
  authorizedAmount: number;
  currency?: string;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
  fundingSourceId?: string;
  settlementRail?: string;
}

export interface UpdateMandateInput {
  status?: MandateStatus;
  authorizedAmount?: number;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
  fundingSourceId?: string | null;
  settlementRail?: string | null;
}

export interface ExecuteMandatePaymentInput {
  amount: number;
  currency: string;
  description?: string;
  authorizationProof?: string;
  orderIds?: string[];
}

export interface MandatesListParams extends PaginationParams {
  status?: MandateStatus;
  agentId?: string;
  accountId?: string;
  search?: string;
}

// ============================================
// ACP Types (Agentic Commerce Protocol)
// ============================================

export type CheckoutStatus = 'pending' | 'completed' | 'cancelled' | 'expired' | 'failed';

export interface ACPCheckout {
  id: string;
  checkout_id: string;
  session_id?: string;
  agent_id: string;
  agent_name?: string;
  customer_id?: string;
  customer_email?: string;
  account_id: string;
  merchant_id: string;
  merchant_name?: string;
  merchant_url?: string;
  subtotal: number;
  tax_amount: number;
  shipping_amount: number;
  discount_amount: number;
  total_amount: number;
  currency: string;
  status: CheckoutStatus;
  shared_payment_token?: string;
  payment_method?: string;
  transfer_id?: string;
  items?: ACPCheckoutItem[];
  shipping_address?: Record<string, any>;
  checkout_data?: Record<string, any>;
  created_at: string;
  updated_at: string;
  completed_at?: string;
  cancelled_at?: string;
  expires_at?: string;
}

export interface ACPCheckoutItem {
  id: string;
  item_id?: string;
  name: string;
  description?: string;
  image_url?: string;
  quantity: number;
  unit_price: number;
  total_price: number;
  currency: string;
  item_data?: Record<string, any>;
  created_at: string;
}

export interface ACPAnalytics {
  period: string;
  summary: {
    totalRevenue: number;
    totalFees: number;
    netRevenue: number;
    transactionCount: number;
    completedCheckouts: number;
    pendingCheckouts: number;
    averageOrderValue: number;
    uniqueMerchants: number;
    uniqueAgents: number;
  };
  checkoutsByStatus: {
    pending: number;
    completed: number;
    cancelled: number;
    expired: number;
    failed: number;
  };
  startDate: string;
  endDate: string;
}

export interface CreateCheckoutInput {
  checkout_id: string;
  agent_id: string;
  agent_name?: string;
  customer_id?: string;
  customer_email?: string;
  account_id: string;
  merchant_id: string;
  merchant_name?: string;
  merchant_url?: string;
  items: Array<{
    item_id?: string;
    name: string;
    description?: string;
    image_url?: string;
    quantity: number;
    unit_price: number;
    total_price: number;
    currency?: string;
  }>;
  tax_amount?: number;
  shipping_amount?: number;
  discount_amount?: number;
  currency?: string;
  expires_at?: string;
}

export interface CheckoutsListParams extends PaginationParams {
  status?: CheckoutStatus;
  merchant_id?: string;
  agent_id?: string;
  customer_id?: string;
}

// ============================================
// Treasury Types
// ============================================

export interface DashboardSummary {
  // Core balance fields (from backend)
  totalFloat: number;
  totalAvailable: number;
  totalPending: number;
  totalReserved: number;
  primaryCurrency: string;

  // Alert fields
  openAlerts: number;
  criticalAlerts: number;
  pendingRecommendations: number;

  // Health metrics
  healthScore: number; // 0-100
  lastUpdated: string;

  // Flow metrics (24h)
  inflows24h: number;
  outflows24h: number;
  netFlow24h: number;

  // Legacy aliases for backwards compatibility
  totalBalance?: number;  // alias for totalFloat
  alertsCount?: number;   // alias for openAlerts
  accountsCount?: number;
}

export interface TreasuryAccount {
  id: string;
  tenantId: string;
  rail: string;
  currency: string;
  externalAccountId?: string;
  accountName?: string;
  balanceTotal: number;
  balanceAvailable: number;
  balancePending: number;
  balanceReserved: number;
  minBalanceThreshold: number;
  targetBalance: number;
  maxBalance: number;
  status: 'active' | 'inactive' | 'suspended';
  lastSyncedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface TreasuryTransaction {
  id: string;
  accountId: string;
  type: 'inbound' | 'outbound' | 'rebalance_in' | 'rebalance_out' | 'fee' | 'adjustment';
  amount: number;
  currency: string;
  balanceBefore: number;
  balanceAfter: number;
  referenceType?: string;
  referenceId?: string;
  externalTxId?: string;
  description?: string;
  createdAt: string;
}

export interface TreasuryAlert {
  id: string;
  alertType: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  message: string;
  status: 'open' | 'acknowledged' | 'resolved';
  accountId?: string;
  acknowledgedBy?: string;
  acknowledgedAt?: string;
  resolvedBy?: string;
  resolvedAt?: string;
  createdAt: string;
}

export interface Recommendation {
  id: string;
  sourceAccountId: string;
  targetAccountId: string;
  amount: number;
  currency: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected' | 'executed';
  createdAt: string;
}

// ============================================
// UCP Types (Universal Commerce Protocol)
// ============================================

export type UCPCorridorType = 'pix' | 'spei';
export type UCPSettlementStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'pending_approval';

export interface UCPCorridorInfo {
  id: string;
  name: string;
  source_currency: string;
  destination_currency: string;
  destination_country: string;
  rail: string;
  estimated_settlement: string;
}

export interface UCPSettlement {
  id: string;
  tenant_id?: string;
  token?: string;
  corridor: UCPCorridorType;
  status: UCPSettlementStatus;
  amount: {
    source: number;
    source_currency: string;
    destination: number;
    destination_currency: string;
    fx_rate: number;
    fees: number;
  };
  recipient: UCPRecipient;
  transfer_id?: string;
  mandate_id?: string;
  failure_reason?: string;
  approval_id?: string;
  deferred_to_rules?: boolean;
  settlement_rule_id?: string;
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface UCPRecipient {
  type: 'pix' | 'spei';
  name: string;
  // Pix fields
  pix_key?: string;
  pix_key_type?: 'cpf' | 'cnpj' | 'email' | 'phone' | 'evp';
  tax_id?: string;
  // SPEI fields
  clabe?: string;
  rfc?: string;
}

export interface UCPQuote {
  fromAmount: number;
  fromCurrency: string;
  toAmount: number;
  toCurrency: string;
  fxRate: number;
  fees: {
    platform: number;
    fx: number;
    total: number;
  };
  expiresAt?: string;
}

export interface UCPAnalytics {
  period: string;
  summary: {
    totalVolume: number;
    totalSettlements: number;
    completedSettlements: number;
    failedSettlements: number;
    pendingSettlements: number;
    averageSettlementTime: number;
    totalFees: number;
  };
  byStatus: {
    pending: number;
    processing: number;
    completed: number;
    failed: number;
    pending_approval: number;
  };
  byCorridor: {
    pix: {
      count: number;
      volume: number;
    };
    spei: {
      count: number;
      volume: number;
    };
  };
  startDate: string;
  endDate: string;
}

export interface UCPSettlementsListParams extends PaginationParams {
  status?: UCPSettlementStatus;
  corridor?: UCPCorridorType;
  search?: string;
}

// ============================================
// Approval Types
// ============================================

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'executed';
export type PaymentProtocol = 'x402' | 'ap2' | 'acp' | 'ucp';

export interface ApprovalRecipient {
  endpoint_id?: string;
  endpoint_path?: string;
  vendor?: string;
  mandate_id?: string;
  merchant?: string;
  checkout_id?: string;
  merchant_id?: string;
  merchant_name?: string;
  corridor?: string;
  settlement_id?: string;
  name?: string;
}

export interface Approval {
  id: string;
  walletId: string;
  agentId?: string;
  protocol: PaymentProtocol;
  amount: number;
  currency: string;
  recipient: ApprovalRecipient | null;
  status: ApprovalStatus;
  expiresAt: string;
  decidedBy?: string;
  decidedAt?: string;
  decisionReason?: string;
  executedTransferId?: string;
  executedAt?: string;
  executionError?: string;
  requestedBy: {
    type?: string;
    id?: string;
    name?: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface PendingApprovalsSummary {
  count: number;
  totalAmount: number;
  byProtocol: Record<PaymentProtocol, { count: number; totalAmount: number }>;
  oldestPending: string | null;
  newestPending: string | null;
}

export interface ApprovalsListParams extends PaginationParams {
  status?: ApprovalStatus;
  walletId?: string;
  agentId?: string;
  protocol?: PaymentProtocol;
}

export interface ApproveRejectInput {
  reason?: string;
}

// ============================================
// A2A Types (Google Agent-to-Agent Protocol)
// ============================================

export type A2ATaskState = 'submitted' | 'working' | 'input-required' | 'completed' | 'failed' | 'canceled' | 'rejected';

export interface A2AAgentCard {
  id: string;
  name: string;
  description?: string;
  version: string;
  provider?: {
    organization: string;
    url?: string;
    contactEmail?: string;
  };
  capabilities: {
    streaming: boolean;
    multiTurn: boolean;
    stateTransitionHistory: boolean;
  };
  skills: A2ASkill[];
  interfaces: Array<{
    type: string;
    url: string;
    contentTypes?: string[];
  }>;
  securitySchemes: Record<string, unknown>;
  security: Array<Record<string, string[]>>;
  extensions?: Array<{
    uri: string;
    data?: Record<string, unknown>;
  }>;
}

export interface A2ASkill {
  id: string;
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  tags?: string[];
}

export interface A2ATaskStatus {
  state: A2ATaskState;
  message?: string;
  timestamp: string;
}

export interface A2AMessage {
  id: string;
  role: 'user' | 'agent';
  parts: Array<{
    kind: 'text' | 'data' | 'file';
    text?: string;
    data?: Record<string, unknown>;
    uri?: string;
    mimeType?: string;
  }>;
  metadata?: Record<string, unknown>;
}

export interface A2AArtifact {
  id: string;
  label?: string;
  mimeType: string;
  parts: Array<{
    kind: 'text' | 'data' | 'file';
    text?: string;
    data?: Record<string, unknown>;
    uri?: string;
    mimeType?: string;
  }>;
  metadata?: Record<string, unknown>;
}

export interface A2ATask {
  id: string;
  contextId?: string;
  status: A2ATaskStatus;
  messages: A2AMessage[];
  artifacts: A2AArtifact[];
  metadata?: Record<string, unknown>;
  direction?: 'inbound' | 'outbound';
  transferId?: string;
  mandateId?: string;
  agentId?: string;
  remoteAgentUrl?: string;
  clientAgentId?: string;
}

export interface A2ATaskSummary {
  id: string;
  agentId: string;
  agentName?: string;
  contextId?: string;
  state: A2ATaskState;
  statusMessage?: string;
  direction: 'inbound' | 'outbound';
  remoteAgentUrl?: string;
  clientAgentId?: string;
  transferId?: string;
  transferAmount?: number;
  transferCurrency?: string;
  transferStatus?: string;
  mandateId?: string;
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SendA2ATaskInput {
  agentId?: string;
  remoteUrl?: string;
  message: {
    parts: Array<{
      kind: 'text' | 'data' | 'file';
      text?: string;
      data?: Record<string, unknown>;
    }>;
  };
  contextId?: string;
  metadata?: Record<string, unknown>;
  callbackUrl?: string;
  callbackSecret?: string;
}

export interface A2ATasksListParams extends PaginationParams {
  state?: A2ATaskState;
  agentId?: string;
  direction?: 'inbound' | 'outbound';
  contextId?: string;
}

export interface A2AStats {
  total: number;
  active: number;
  completed: number;
  inbound: number;
  outbound: number;
  totalCost: number;
  transferCount: number;
}

export interface A2ASession {
  contextId: string;
  taskCount: number;
  agentNames: string[];
  directions: string[];
  latestState: A2ATaskState;
  totalCost: number;
  transferCount: number;
  firstTaskAt: string;
  lastTaskAt: string;
  messageCount: number;
}

// ============================================
// Agent Processing Config Types (Story 58.1)
// ============================================

export interface AgentProcessingConfig {
  processingMode: 'managed' | 'webhook' | 'manual';
  processingConfig: Record<string, unknown>;
}

export interface TaskStateUpdate {
  state: A2ATaskState;
  statusMessage?: string;
  message?: {
    role: 'agent';
    parts: Array<{ text?: string; data?: Record<string, unknown> }>;
    metadata?: Record<string, unknown>;
  };
  artifacts?: Array<{
    name?: string;
    mediaType?: string;
    parts: Array<{ text?: string; data?: Record<string, unknown> }>;
    metadata?: Record<string, unknown>;
  }>;
}

export interface RespondToTaskInput {
  parts: Array<{ text?: string; data?: Record<string, unknown> }>;
  metadata?: Record<string, unknown>;
}

export interface A2ADlqTask {
  id: string;
  agentId: string;
  agentName?: string;
  webhookAttempts: number;
  lastResponseCode?: number;
  dlqAt: string;
  dlqReason: string;
  createdAt: string;
}

// ============================================
// A2A Stream Event Types (Story 58.13)
// ============================================

export type A2AStreamEventType = 'status' | 'message' | 'artifact' | 'error' | 'heartbeat';

export interface A2AStreamEvent {
  type: A2AStreamEventType;
  taskId: string;
  data: Record<string, unknown>;
  timestamp: string;
}

// ============================================
// MPP Types (Machine Payments Protocol)
// ============================================

export interface MppPayInput {
  serviceUrl: string;
  amount: number;
  currency?: string;
  intent?: string;
  agentId: string;
  walletId?: string;
}

export interface MppOpenSessionInput {
  serviceUrl: string;
  depositAmount: number;
  maxBudget?: number;
  agentId: string;
  walletId: string;
  currency?: string;
}

export interface MppSessionsListParams {
  agentId?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export interface MppTransfersListParams {
  serviceUrl?: string;
  sessionId?: string;
  limit?: number;
  offset?: number;
}

export interface MppProvisionWalletInput {
  agentId: string;
  ownerAccountId: string;
  testnet?: boolean;
  initialBalance?: number;
}
