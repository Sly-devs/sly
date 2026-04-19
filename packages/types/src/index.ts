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
// A2A PROTOCOL (Epic 57/58)
// ============================================

export * from './a2a.js';

// ============================================
// CORE TYPES
// ============================================

export type AccountType = 'person' | 'business' | 'agent';
export type VerificationStatus = 'unverified' | 'pending' | 'verified';
export type VerificationTier = 0 | 1 | 2 | 3;

export type AgentStatus = 'active' | 'paused' | 'suspended';
export type KYATier = 0 | 1 | 2 | 3;
export type KYAStatus = 'unverified' | 'pending' | 'verified' | 'suspended';
export type EscalationPolicy = 'DECLINE' | 'SUSPEND_AND_NOTIFY' | 'REQUEST_APPROVAL';

export interface SkillManifest {
  protocols: string[];
  action_types: string[];
  domain: string;
  description: string;
}
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
  | 'mpp'    // Machine Payments Protocol (Stripe/Tempo Labs)
  // Legacy types
  | 'payout'
  | 'refund'
  | 'wallet_transfer';

/** Protocol-specific transfer types */
export type ProtocolTransferType = 'x402' | 'ap2' | 'acp' | 'mpp';

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

export type VerificationPath = 'standard' | 'partner_reliance' | 'enterprise';

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
    path: VerificationPath;
  };

  compliance?: {
    reliancePartnerId?: string;
    relianceAgreementDate?: string;
    contactName?: string;
    contactEmail?: string;
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

  cai?: {
    modelFamily?: string;
    modelVersion?: string;
    skillManifest?: SkillManifest;
    useCaseDescription?: string;
    escalationPolicy: EscalationPolicy;
    operationalHistoryStart?: string;
    policyViolationCount: number;
    behavioralConsistencyScore?: number;
    enterpriseOverride: boolean;
    overrideAssessedAt?: string;
    killSwitch?: {
      operatorId: string;
      operatorName: string;
      operatorEmail: string;
    };
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

  erc8004AgentId?: string;
  walletAddress?: string;

  // Epic 72: Key-pair auth + liveness
  authKey?: AgentAuthKey;
  liveness?: AgentLiveness;

  avatarUrl?: string | null;

  createdAt: string;
  updatedAt: string;
}

// ============================================
// TRUST PROFILE (Epic 73 — Cross-Org Queryable)
// ============================================

export interface AgentTrustProfile {
  agentId: string;
  kyaTier: KYATier;
  parentVerificationTier: VerificationTier;
  parentEntityType: AccountType;
  operationalDays: number;
  policyViolationCount: number;
  behavioralConsistencyScore: number | null;
  skillManifest: SkillManifest | null;
  modelFamily: string | null;
  killSwitchEnabled: boolean;
  lastVerifiedAt: string | null;
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
    erc8004AgentId?: string;
    walletAddress?: string;
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

  txHash?: string;

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

// ============================================
// REPUTATION (Epic 63)
// ============================================

export type TrustTier = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
export type ConfidenceLevel = 'high' | 'medium' | 'low' | 'none';

export interface ReputationDimension {
  name: 'identity' | 'payment_reliability' | 'capability_trust' | 'community_signal' | 'service_quality';
  score: number;
  weight: number;
  sources: string[];
  dataPoints: number;
}

export interface UnifiedTrustScore {
  score: number;
  tier: TrustTier;
  confidence: ConfidenceLevel;
  dimensions: ReputationDimension[];
  dataPoints: number;
  lastRefreshed: string;
  stale: boolean;
}

// ============================================
// AGENT KEY-PAIR AUTH (Epic 72)
// ============================================

export interface AgentAuthKey {
  keyId: string;
  algorithm: 'ed25519';
  publicKey: string;
  status: 'active' | 'rotated' | 'revoked';
  label?: string;
  createdAt: string;
  rotatedAt?: string;
  revokedAt?: string;
}

export interface AgentChallenge {
  challenge: string;
  expiresIn: number;
  algorithm: 'ed25519';
}

export interface AgentSessionToken {
  sessionToken: string;
  expiresIn: number;
  agentId: string;
}

export interface AgentLiveness {
  connected: boolean;
  connectedAt?: string;
  lastHeartbeatAt?: string;
  disconnectedAt?: string;
  connectionDuration?: number;
}

export type AgentConnectionEventType =
  | 'task_assigned'
  | 'transfer_completed'
  | 'approval_requested'
  | 'stream_alert'
  | 'key_rotated'
  | 'config_changed'
  | 'heartbeat'
  | 'reconnect_required';
