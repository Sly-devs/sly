// ============================================
// PROTOCOL METADATA (Multi-Protocol Support)
// ============================================

export * from './protocol-metadata.js';
export * from './protocol-metadata-schemas.js';

// ============================================
// SCANNER & DEMAND INTELLIGENCE (Epic 56)
// ============================================

export * from './scanner.js';
export * from './demand.js';

// ============================================
// ERROR TAXONOMY & STRUCTURED RESPONSES (Epic 30)
// ============================================

export * from './errors.js';
export * from './api-responses.js';
export * from './api-schemas.js';
export * from './error-helpers.js';

// ============================================
// CORE TYPES
// ============================================

export type AccountType = 'person' | 'business' | 'agent';
export type VerificationStatus = 'unverified' | 'pending' | 'verified';
export type VerificationTier = 0 | 1 | 2 | 3;

export type AgentStatus = 'active' | 'paused' | 'suspended';
export type KYATier = 0 | 1 | 2 | 3;
export type KYAStatus = 'unverified' | 'pending' | 'verified' | 'suspended';
export type AuthType = 'api_key' | 'oauth' | 'x402';

export type TransferType =
  | 'cross_border'
  | 'internal'
  | 'stream_start'
  | 'stream_withdraw'
  | 'stream_cancel'
  | 'wrap'
  | 'unwrap'
  | 'deposit'
  | 'withdrawal'
  // Agentic payment protocols
  | 'x402'   // Coinbase/Cloudflare HTTP 402
  | 'ap2'    // Google Agent Payment Protocol
  | 'acp'    // Stripe/OpenAI Agentic Commerce Protocol
  // Legacy types
  | 'payout'
  | 'refund'
  | 'wallet_transfer';

/** Protocol-specific transfer types */
export type ProtocolTransferType = 'x402' | 'ap2' | 'acp';

export type TransferStatus = 'pending' | 'processing' | 'authorized' | 'completed' | 'failed' | 'cancelled';

export type StreamStatus = 'active' | 'paused' | 'cancelled';
export type StreamHealth = 'healthy' | 'warning' | 'critical';
export type StreamCategory = 'salary' | 'subscription' | 'service' | 'other';

// ============================================
// ACCOUNT
// ============================================

export interface AccountBalance {
  total: number;
  available: number;
  inStreams: {
    total: number;
    buffer: number;
    streaming: number;
  };
  currency: 'USDC';
}

export interface Account {
  id: string;
  tenantId: string;
  type: AccountType;
  name: string;
  email?: string;

  verification: {
    tier: VerificationTier;
    status: VerificationStatus;
    type: 'kyc' | 'kyb';
  };

  balance: AccountBalance;

  agents: {
    count: number;
    active: number;
  };

  createdAt: string;
  updatedAt: string;
}

// ============================================
// AGENT
// ============================================

export interface Limits {
  perTransaction: number;
  daily: number;
  monthly: number;
}

export interface AgentPermissions {
  transactions: { initiate: boolean; approve: boolean; view: boolean };
  streams: { initiate: boolean; modify: boolean; pause: boolean; terminate: boolean; view: boolean };
  accounts: { view: boolean; create: boolean };
  treasury: { view: boolean; rebalance: boolean };
}

export interface Agent {
  id: string;
  tenantId: string;
  name: string;
  description: string;
  status: AgentStatus;

  parentAccount: {
    id: string;
    type: AccountType;
    name: string;
    verificationTier: VerificationTier;
  };

  kya: {
    tier: KYATier;
    status: KYAStatus;
    verifiedAt?: string;
    agentLimits: Limits;
    effectiveLimits: Limits & { cappedByParent: boolean };
  };

  permissions: AgentPermissions;

  streamStats: {
    activeStreams: number;
    totalOutflow: number;
    maxActiveStreams: number;
    maxTotalOutflow: number;
  };

  auth: {
    type: AuthType;
    clientId?: string;
  };

  createdAt: string;
  updatedAt: string;
}

// ============================================
// TRANSFER
// ============================================

export interface Transfer {
  id: string;
  tenantId: string;
  type: TransferType;
  status: TransferStatus;

  from: { accountId: string; accountName: string };
  to: { accountId: string; accountName: string };

  initiatedBy: {
    type: 'user' | 'agent';
    id: string;
    name: string;
  };

  amount: number;
  currency: 'USDC';

  // Cross-border specific
  destinationAmount?: number;
  destinationCurrency?: string;
  fxRate?: number;

  // Stream specific
  streamId?: string;

  fees: number;
  description?: string;

  idempotencyKey?: string;

  // Protocol-specific metadata (x402, AP2, ACP)
  // See protocol-metadata.ts for type definitions
  protocolMetadata?: import('./protocol-metadata.js').ProtocolMetadata;

  /** @deprecated Use protocolMetadata instead */
  x402Metadata?: {
    endpoint_id?: string;
    endpoint_path?: string;
    endpoint_method?: string;
    wallet_id?: string;
    request_id?: string;
    timestamp?: string;
    metadata?: any;
    price_calculated?: number;
    volume_tier?: number;
    settlement_fee?: number;
    settlement_net_amount?: number;
    fee_calculation?: {
      grossAmount: number;
      feeAmount: number;
      netAmount: number;
      feeType: string;
      breakdown: any;
    };
  };

  createdAt: string;
  completedAt?: string;
  failedAt?: string;
  failureReason?: string;
}

// ============================================
// STREAM
// ============================================

export interface Stream {
  id: string;
  tenantId: string;
  status: StreamStatus;

  sender: { accountId: string; accountName: string };
  receiver: { accountId: string; accountName: string };

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
    currency: 'USDC';
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

  description: string;
  category: StreamCategory;

  startedAt: string;
  pausedAt?: string;
  cancelledAt?: string;

  onChain?: {
    network: string;
    flowId: string;
    txHash: string;
  };

  createdAt: string;
  updatedAt: string;
}

// ============================================
// QUOTE
// ============================================

export interface Quote {
  id: string;
  fromCurrency: string;
  toCurrency: string;
  fromAmount: number;
  toAmount: number;
  fxRate: number;
  fees: {
    total: number;
    breakdown: Array<{ type: string; amount: number }>;
  };
  expiresAt: string;
  estimatedSettlement: string;
}

// ============================================
// REPORT
// ============================================

export interface Report {
  id: string;
  tenantId: string;
  accountId?: string;
  type: 'statement' | 'transactions' | 'streams' | 'activity_log';
  name: string;
  periodStart: string;
  periodEnd: string;
  format: 'pdf' | 'csv' | 'json';
  status: 'generating' | 'ready' | 'failed';
  downloadUrl?: string;
  createdAt: string;
}

// ============================================
// API TYPES
// ============================================

export interface ApiResponse<T> {
  data: T;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface ApiError {
  error: string;
  message?: string;
  details?: unknown;
}

// ============================================
// REQUEST TYPES
// ============================================

export interface CreateAccountRequest {
  type: AccountType;
  name: string;
  email?: string;
}

export interface CreateAgentRequest {
  parentAccountId: string;
  name: string;
  description?: string;
  permissions?: Partial<AgentPermissions>;
}

export interface CreateTransferRequest {
  fromAccountId: string;
  toAccountId: string;
  amount: number;
  destinationCurrency?: string;
  description?: string;
}

export interface CreateInternalTransferRequest {
  fromAccountId: string;
  toAccountId: string;
  amount: number;
  description?: string;
}

export interface CreateStreamRequest {
  senderAccountId: string;
  receiverAccountId: string;
  flowRatePerMonth: number;
  initialFunding?: number;
  description?: string;
  category?: StreamCategory;
}

export interface GetQuoteRequest {
  fromCurrency: string;
  toCurrency: string;
  amount: number;
}

export interface GenerateReportRequest {
  type: 'statement' | 'transactions' | 'streams';
  accountId?: string;
  periodStart: string;
  periodEnd: string;
  format: 'pdf' | 'csv' | 'json';
}


