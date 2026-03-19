/**
 * MPP (Machine Payments Protocol) Service Types
 *
 * Local types for the MPP integration layer.
 * Protocol spec: https://www.machinepayments.com/
 *
 * @see Epic 71: MPP Integration
 */

// ============================================
// Client Configuration
// ============================================

export interface MppClientConfig {
  /** MPP secret key (for server paywall) */
  secretKey?: string;
  /** Private key for signing payment credentials (hex, 0x-prefixed) */
  privateKey?: string;
  /** Tempo recipient address for receiving payments */
  tempoRecipient?: string;
  /** Default currency for Tempo payments */
  tempoCurrency?: string;
  /** Use testnet (default: true in non-production) */
  tempoTestnet?: boolean;
  /** Stripe secret key for card payments (optional) */
  stripeSecretKey?: string;
  /** Request timeout in ms */
  timeout?: number;
}

// ============================================
// Payment Results
// ============================================

export type MppPaymentMethod = 'tempo' | 'stripe' | 'lightning' | 'card' | 'custom';

/** Protocol-level intents (from mppx spec: Method.intent) */
export type MppIntent = 'charge' | 'session';

/** Structured method identifier matching mppx Method.name + Method.intent */
export type MppMethodId = `${MppPaymentMethod}/${MppIntent}`;

export interface MppPaymentResult {
  success: boolean;
  /** Receipt ID from MPP */
  receiptId?: string;
  /** Raw receipt data */
  receiptData?: Record<string, unknown>;
  /** Settlement network used */
  settlementNetwork?: string;
  /** Settlement transaction hash */
  settlementTxHash?: string;
  /** Amount paid (in protocol units) */
  amountPaid?: string;
  /** Currency */
  currency?: string;
  /** Payment method used */
  paymentMethod?: MppPaymentMethod;
  /** Protocol-level intent from mppx challenge/receipt (e.g. 'charge', 'session') */
  protocolIntent?: MppIntent;
  /** Error message (if failed) */
  error?: string;
  /** Error code */
  errorCode?: string;
}

// ============================================
// Session Types
// ============================================

export type MppSessionStatus = 'open' | 'active' | 'closing' | 'closed' | 'exhausted' | 'error';

export interface MppSession {
  id: string;
  tenantId: string;
  agentId: string;
  walletId: string;
  serviceUrl: string;
  depositAmount: number;
  spentAmount: number;
  voucherCount: number;
  status: MppSessionStatus;
  maxBudget?: number;
  mppSessionId?: string;
  openedAt: string;
  closedAt?: string;
  lastVoucherAt?: string;
  metadata?: Record<string, unknown>;
}

export interface MppSessionRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  wallet_id: string;
  service_url: string;
  deposit_amount: number;
  spent_amount: number;
  voucher_count: number;
  status: MppSessionStatus;
  max_budget?: number;
  mpp_session_id?: string;
  opened_at: string;
  closed_at?: string;
  last_voucher_at?: string;
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// ============================================
// Server / Paywall Types
// ============================================

export interface MppRoutePrice {
  /** Price in USD */
  amount: string;
  /** Description shown to payer */
  description?: string;
  /** Accepted payment methods */
  methods?: MppPaymentMethod[];
}

export interface MppServerConfig {
  /** Mapping of route patterns to pricing */
  routes: Record<string, MppRoutePrice>;
  /** Default price for unmatched routes */
  defaultPrice?: MppRoutePrice;
  /** Tempo wallet address for receiving */
  recipientAddress: string;
  /** Network for settlement */
  network?: string;
}

// ============================================
// Service Discovery
// ============================================

export interface MppServiceInfo {
  domain: string;
  name?: string;
  description?: string;
  pricing?: {
    routes: Record<string, MppRoutePrice>;
  };
  paymentMethods: MppPaymentMethod[];
  lastChecked?: string;
}

// ============================================
// Payer Verification
// ============================================

export type PayerTrustTier = 0 | 1 | 2 | 3;

export interface PayerVerification {
  verified: boolean;
  payerAddress: string;
  agentId?: string;
  agentName?: string;
  trustTier: PayerTrustTier;
  kyaTier?: number;
  tenantId?: string;
}
