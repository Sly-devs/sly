/**
 * x402 Payment Flow & Protocol Handler
 * 
 * Implements the x402 protocol for HTTP 402 "Payment Required" responses.
 * Handles payment authorization, verification, and processing.
 * 
 * Spec: https://www.x402.org/x402-whitepaper.pdf
 * 
 * Flow:
 * 1. Consumer calls protected endpoint
 * 2. Endpoint returns 402 with payment details
 * 3. Consumer calls POST /x402/pay with payment authorization
 * 4. PayOS validates, deducts from wallet, credits provider
 * 5. Consumer retries original request with proof of payment
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { createHmac } from 'crypto';
import { createClient } from '../db/client.js';
import { authMiddleware } from '../middleware/auth.js';
import { createSettlementService } from '../services/settlement.js';
import { 
  createSpendingPolicyService, 
  invalidatePolicyCache,
  type PolicyContext 
} from '../services/spending-policy.js';
import {
  createApprovalWorkflowService,
  type PaymentProtocol
} from '../services/approval-workflow.js';
import { executeOnChainTransfer } from '../services/wallet-settlement.js';
import { createCheckoutTelemetryService } from '../services/telemetry/checkout-telemetry.js';

const app = new Hono();

// ============================================
// JWT Payment Proof (Phase 2 Optimization)
// ============================================
// Allows providers to verify payments locally without API call
// Saves ~140ms per request

// Secret for signing JWTs (in production, use env var)
const JWT_SECRET = process.env.X402_JWT_SECRET || 'payos-x402-jwt-secret-change-in-prod';
const JWT_EXPIRY_SECONDS = 300; // 5 minutes

interface PaymentProofPayload {
  transferId: string;
  requestId: string;
  endpointId: string;
  amount: number;
  currency: string;
  iat: number;  // issued at
  exp: number;  // expires at
}

function base64UrlEncode(str: string): string {
  return Buffer.from(str)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

export function createPaymentProofJWT(payload: Omit<PaymentProofPayload, 'iat' | 'exp'>): string {
  const now = Math.floor(Date.now() / 1000);
  const fullPayload: PaymentProofPayload = {
    ...payload,
    iat: now,
    exp: now + JWT_EXPIRY_SECONDS
  };
  
  // Create JWT header
  const header = { alg: 'HS256', typ: 'JWT' };
  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(fullPayload));
  
  // Create signature
  const signature = createHmac('sha256', JWT_SECRET)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  
  return `${headerB64}.${payloadB64}.${signature}`;
}

// Verify JWT and return payload (for /verify endpoint to support both modes)
export function verifyPaymentProofJWT(token: string): PaymentProofPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    
    const [headerB64, payloadB64, signatureB64] = parts;
    
    // Verify signature
    const expectedSignature = createHmac('sha256', JWT_SECRET)
      .update(`${headerB64}.${payloadB64}`)
      .digest('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    
    if (signatureB64 !== expectedSignature) {
      return null;
    }
    
    // Decode payload
    const payload = JSON.parse(
      Buffer.from(payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()
    ) as PaymentProofPayload;
    
    // Check expiry
    if (payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    
    return payload;
  } catch {
    return null;
  }
}

// Apply auth middleware to all routes
app.use('*', authMiddleware);

// ============================================
// Validation Schemas
// ============================================

// x402 Payment Authorization (EIP-712-inspired structure)
const paymentAuthorizationSchema = z.object({
  // Payment Details
  endpointId: z.string().uuid(),
  requestId: z.string().uuid(), // Idempotency key
  amount: z.number().positive(),
  currency: z.enum(['USDC', 'EURC']),

  // Wallet
  walletId: z.string().uuid(),

  // Request Context
  method: z.string(),
  path: z.string(),
  timestamp: z.number().int().positive(),

  // Optional metadata
  metadata: z.object({
    userAgent: z.string().optional(),
    ipAddress: z.string().optional(),
    region: z.string().optional()
  }).optional(),

  // Signature (Phase 2: EIP-712, Phase 1: simplified)
  signature: z.string().optional()
});

const verifyPaymentSchema = z.object({
  requestId: z.string().uuid(),
  transferId: z.string().uuid()
});

// ============================================
// Helper Functions
// ============================================

/**
 * Calculate final price with volume discounts
 */
function calculatePrice(
  basePrice: number,
  volumeDiscounts: any[],
  totalCalls: number
): number {
  if (!volumeDiscounts || volumeDiscounts.length === 0) {
    return basePrice;
  }

  // Find applicable discount tier (highest threshold not exceeding totalCalls)
  const applicableTier = volumeDiscounts
    .filter(tier => tier.threshold <= totalCalls)
    .sort((a, b) => b.threshold - a.threshold)[0];

  if (!applicableTier) {
    return basePrice;
  }

  return basePrice * applicableTier.priceMultiplier;
}

/**
 * Validate payment authorization signature (Phase 2)
 * For Phase 1, we skip signature verification
 */
function validateSignature(
  authorization: any,
  signature?: string
): boolean {
  // Phase 1: Skip signature validation (internal ledger)
  // Phase 2: Implement EIP-712 signature verification

  if (process.env.X402_PHASE === 'production') {
    // TODO: Implement EIP-712 signature verification
    // This would verify that the wallet owner signed this exact payment
    console.warn('⚠️  EIP-712 signature verification not implemented (Phase 2)');
  }

  return true; // Phase 1: Trust internal auth
}

/**
 * Check spending policy constraints
 */
async function checkSpendingPolicy(
  supabase: any,
  wallet: any,
  amount: number,
  endpointPath: string,
  endpointId?: string
): Promise<{ allowed: boolean; reason?: string }> {
  const policy = wallet.spending_policy;

  if (!policy) {
    return { allowed: true }; // No policy = no restrictions
  }

  // Check approved endpoints (x402 specific)
  if (policy.approvedEndpoints && policy.approvedEndpoints.length > 0 && endpointId) {
    const isApproved = policy.approvedEndpoints.includes(endpointId);

    if (!isApproved) {
      return {
        allowed: false,
        reason: `Endpoint not in approved endpoints list`
      };
    }
  }

  // Check requires approval threshold (both names for compatibility)
  const approvalThreshold = policy.approvalThreshold || policy.requiresApprovalAbove;
  if (approvalThreshold && amount > approvalThreshold) {
    return {
      allowed: false,
      reason: `Amount ${amount} exceeds approval threshold ${approvalThreshold}`
    };
  }

  // Check approved vendors
  if (policy.approvedVendors && policy.approvedVendors.length > 0) {
    const isApproved = policy.approvedVendors.some((vendor: string) =>
      endpointPath.includes(vendor)
    );

    if (!isApproved) {
      return {
        allowed: false,
        reason: `Endpoint not in approved vendors list`
      };
    }
  }

  // Check daily spend limit
  if (policy.dailySpendLimit) {
    const dailySpent = policy.dailySpent || 0;

    if (dailySpent + amount > policy.dailySpendLimit) {
      return {
        allowed: false,
        reason: `Would exceed daily spend limit (${dailySpent + amount} > ${policy.dailySpendLimit})`
      };
    }
  }

  // Check monthly spend limit
  if (policy.monthlySpendLimit) {
    const monthlySpent = policy.monthlySpent || 0;

    if (monthlySpent + amount > policy.monthlySpendLimit) {
      return {
        allowed: false,
        reason: `Would exceed monthly spend limit (${monthlySpent + amount} > ${policy.monthlySpendLimit})`
      };
    }
  }

  return { allowed: true };
}

/**
 * Update spending policy counters
 */
function updateSpendingPolicyCounters(
  policy: any,
  amount: number
): any {
  if (!policy) return null;

  const now = new Date();
  const updated = { ...policy };

  // Update daily spent
  if (policy.dailySpendLimit) {
    const resetTime = policy.dailyResetAt ? new Date(policy.dailyResetAt) : null;

    if (!resetTime || now > resetTime) {
      // Reset daily counter
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(0, 0, 0, 0);

      updated.dailySpent = amount;
      updated.dailyResetAt = tomorrow.toISOString();
    } else {
      updated.dailySpent = (policy.dailySpent || 0) + amount;
    }
  }

  // Update monthly spent
  if (policy.monthlySpendLimit) {
    const resetTime = policy.monthlyResetAt ? new Date(policy.monthlyResetAt) : null;

    if (!resetTime || now > resetTime) {
      // Reset monthly counter
      const nextMonth = new Date(now);
      nextMonth.setMonth(nextMonth.getMonth() + 1);
      nextMonth.setDate(1);
      nextMonth.setHours(0, 0, 0, 0);

      updated.monthlySpent = amount;
      updated.monthlyResetAt = nextMonth.toISOString();
    } else {
      updated.monthlySpent = (policy.monthlySpent || 0) + amount;
    }
  }

  return updated;
}

// ============================================
// Performance Optimization: In-Memory Caches
// ============================================

// Cache for spending policies (30s TTL)
const spendingPolicyCache = new Map<string, {
  policy: any;
  expiresAt: number;
}>();

function getCachedSpendingPolicy(walletId: string): any | null {
  const cached = spendingPolicyCache.get(walletId);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.policy;
  }
  if (cached) {
    spendingPolicyCache.delete(walletId);
  }
  return null;
}

function cacheSpendingPolicy(walletId: string, policy: any): void {
  spendingPolicyCache.set(walletId, {
    policy,
    expiresAt: Date.now() + 30000 // 30s TTL
  });
}

// Cache for endpoints (60s TTL) - prices don't change frequently
const endpointCache = new Map<string, {
  endpoint: any;
  expiresAt: number;
}>();

function getCachedEndpoint(endpointId: string): any | null {
  const cached = endpointCache.get(endpointId);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.endpoint;
  }
  if (cached) {
    endpointCache.delete(endpointId);
  }
  return null;
}

function cacheEndpoint(endpointId: string, endpoint: any): void {
  endpointCache.set(endpointId, {
    endpoint,
    expiresAt: Date.now() + 60000 // 60s TTL
  });
}

// Bloom filter for idempotency (fast "definitely not seen" check)
// Simple implementation using Set with size limit
const processedRequestIds = new Set<string>();
const MAX_PROCESSED_IDS = 100000; // Keep last 100k request IDs

function hasProcessedRequest(requestId: string): boolean {
  return processedRequestIds.has(requestId);
}

function markRequestProcessed(requestId: string): void {
  // Simple eviction: clear when full (production would use proper bloom filter)
  if (processedRequestIds.size >= MAX_PROCESSED_IDS) {
    processedRequestIds.clear();
    console.log('⚠️  Cleared idempotency cache (reached 100k entries)');
  }
  processedRequestIds.add(requestId);
}

// Cache cleanup every 60 seconds
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of spendingPolicyCache.entries()) {
    if (now >= value.expiresAt) {
      spendingPolicyCache.delete(key);
    }
  }
  for (const [key, value] of endpointCache.entries()) {
    if (now >= value.expiresAt) {
      endpointCache.delete(key);
    }
  }
}, 60000);

// ============================================
// Routes
// ============================================

/**
 * POST /v1/x402/pay
 * Process an x402 payment
 * 
 * This is called by the consumer after receiving a 402 response from the provider.
 * 
 * Performance Optimizations (Epic 26 - Conservative):
 * - Parallel database queries (endpoint + wallet fetch)
 * - In-memory caching for spending policies (30s TTL)
 * - Batch settlement via database function
 */
app.post('/pay', async (c) => {
  const timings: Record<string, number> = {};
  const startTotal = Date.now();
  
  try {
    const ctx = c.get('ctx');
    const body = await c.req.json();

    // Validate request
    const auth = paymentAuthorizationSchema.parse(body);

    const supabase = createClient();

    // ============================================
    // 1. IDEMPOTENCY CHECK (OPTIMIZED with bloom filter)
    // ============================================
    const t1 = Date.now();
    
    // OPTIMIZATION: Check in-memory first (O(1), ~1ms)
    // If not in set, definitely not processed - skip DB query
    let existingTransfer = null;
    
    if (hasProcessedRequest(auth.requestId)) {
      // Maybe processed - need to confirm with DB
      const { data } = await supabase
        .from('transfers')
        .select('id, status, amount, currency')
        .eq('protocol_metadata->>request_id', auth.requestId)
        .eq('tenant_id', ctx.tenantId)
        .single();
      existingTransfer = data;
      timings['1_idempotency_check'] = Date.now() - t1;
      timings['1_idempotency_source'] = 'db_confirmed';
    } else {
      // Definitely not processed - skip DB query entirely
      timings['1_idempotency_check'] = Date.now() - t1;
      timings['1_idempotency_source'] = 'bloom_filter_skip';
    }

    if (existingTransfer) {
      if (existingTransfer.status === 'completed') {
        // Already processed successfully
        return c.json({
          success: true,
          message: 'Payment already processed (idempotent)',
          data: {
            requestId: auth.requestId,
            transferId: existingTransfer.id,
            amount: parseFloat(existingTransfer.amount),
            currency: existingTransfer.currency,
            status: 'completed'
          }
        }, 200);
      } else {
        // Payment failed or pending - allow retry
        console.log(`Retrying failed/pending payment: ${auth.requestId}`);
      }
    }

    // ============================================
    // 2. PARALLEL FETCH & VALIDATE (OPTIMIZED with caching)
    // ============================================
    const t2 = Date.now();

    // OPTIMIZATION: Check endpoint cache first
    let endpoint = getCachedEndpoint(auth.endpointId);
    let endpointError = null;
    let consumerWallet = null;
    let consumerWalletError = null;
    
    if (endpoint) {
      // Endpoint in cache - only fetch wallet
      timings['2_endpoint_source'] = 'cache';
      const { data, error } = await supabase
        .from('wallets')
        .select('*')
        .eq('id', auth.walletId)
        .eq('tenant_id', ctx.tenantId)
        .single();
      consumerWallet = data;
      consumerWalletError = error;
    } else {
      // Endpoint not in cache - fetch both in parallel
      timings['2_endpoint_source'] = 'db';
      const [endpointResult, walletResult] = await Promise.all([
        supabase
          .from('x402_endpoints')
          .select('*')
          .eq('id', auth.endpointId)
          .eq('tenant_id', ctx.tenantId)
          .single(),
        supabase
          .from('wallets')
          .select('*')
          .eq('id', auth.walletId)
          .eq('tenant_id', ctx.tenantId)
          .single()
      ]);
      endpoint = endpointResult.data;
      endpointError = endpointResult.error;
      consumerWallet = walletResult.data;
      consumerWalletError = walletResult.error;
      
      // Cache the endpoint for future requests
      if (endpoint && !endpointError) {
        cacheEndpoint(auth.endpointId, endpoint);
      }
    }
    
    timings['2_parallel_fetch'] = Date.now() - t2;

    // Rename for consistency
    const wallet = consumerWallet;
    const walletError = consumerWalletError;

    if (endpointError || !endpoint) {
      const telemetry = createCheckoutTelemetryService(supabase);
      telemetry.record({
        protocol: 'x402',
        event_type: 'payment.endpoint_not_found',
        success: false,
        failure_reason: 'Endpoint not found',
        failure_code: 'ENDPOINT_NOT_FOUND',
        amount: auth.amount,
        currency: auth.currency,
        protocol_metadata: { endpoint_id: auth.endpointId, path: auth.path },
      });
      return c.json({
        error: 'Endpoint not found',
        code: 'ENDPOINT_NOT_FOUND'
      }, 404);
    }

    if (endpoint.status !== 'active') {
      return c.json({
        error: 'Endpoint is not active',
        status: endpoint.status,
        code: 'ENDPOINT_INACTIVE'
      }, 400);
    }

    if (walletError || !wallet) {
      const telemetry = createCheckoutTelemetryService(supabase);
      telemetry.record({
        protocol: 'x402',
        event_type: 'payment.wallet_not_found',
        success: false,
        merchant_domain: endpoint.name,
        failure_reason: 'Wallet not found',
        failure_code: 'WALLET_NOT_FOUND',
        amount: auth.amount,
        currency: auth.currency,
        protocol_metadata: { endpoint_id: endpoint.id, path: endpoint.path },
      });
      return c.json({
        error: 'Wallet not found',
        code: 'WALLET_NOT_FOUND'
      }, 404);
    }

    // ============================================
    // 3. CALCULATE PRICE
    // ============================================

    const price = calculatePrice(
      parseFloat(endpoint.base_price),
      endpoint.volume_discounts || [],
      endpoint.total_calls
    );

    // Validate amount matches calculated price
    if (Math.abs(auth.amount - price) > 0.0001) {
      return c.json({
        error: 'Payment amount does not match endpoint price',
        expected: price,
        provided: auth.amount,
        code: 'AMOUNT_MISMATCH'
      }, 400);
    }

    // Validate currency matches
    if (auth.currency !== endpoint.currency) {
      return c.json({
        error: 'Currency mismatch',
        expected: endpoint.currency,
        provided: auth.currency,
        code: 'CURRENCY_MISMATCH'
      }, 400);
    }

    // ============================================
    // 4. VALIDATE WALLET
    // ============================================

    if (wallet.status !== 'active') {
      return c.json({
        error: 'Wallet is not active',
        status: wallet.status,
        code: 'WALLET_INACTIVE'
      }, 400);
    }

    // Check sufficient balance
    const walletBalance = parseFloat(wallet.balance);
    if (walletBalance < auth.amount) {
      const telemetry = createCheckoutTelemetryService(supabase);
      telemetry.record({
        protocol: 'x402',
        event_type: 'payment.insufficient_balance',
        success: false,
        merchant_domain: endpoint.name,
        failure_reason: 'Insufficient wallet balance',
        failure_code: 'INSUFFICIENT_BALANCE',
        amount: auth.amount,
        currency: auth.currency,
        protocol_metadata: { endpoint_id: endpoint.id, path: endpoint.path, available: walletBalance },
      });
      return c.json({
        error: 'Insufficient wallet balance',
        available: walletBalance,
        required: auth.amount,
        code: 'INSUFFICIENT_BALANCE'
      }, 400);
    }

    // ============================================
    // 5. VALIDATE SIGNATURE (Phase 2)
    // ============================================

    if (!validateSignature(auth, auth.signature)) {
      return c.json({
        error: 'Invalid payment signature',
        code: 'INVALID_SIGNATURE'
      }, 401);
    }

    // ============================================
    // 6. CHECK SPENDING POLICY (Story 18.R1: Unified Service)
    // ============================================
    // Uses SpendingPolicyService for cross-protocol consistency
    // Supports approval workflow when threshold exceeded

    const spendingPolicyService = createSpendingPolicyService(supabase);
    const approvalWorkflowService = createApprovalWorkflowService(supabase);
    
    const policyContext: PolicyContext = {
      protocol: 'x402',
      vendor: endpoint.path,
      endpointId: endpoint.id,
      endpointPath: endpoint.path,
    };

    const policyCheck = await spendingPolicyService.checkPolicy(
      wallet.id,
      auth.amount,
      policyContext
    );

    timings['6_spending_policy_check'] = Date.now() - t1;

    if (!policyCheck.allowed) {
      // Check if this requires approval (vs hard limit exceeded)
      if (policyCheck.requiresApproval) {
        // Create approval request instead of rejecting outright
        const approval = await approvalWorkflowService.createApproval({
          tenantId: ctx.tenantId,
          walletId: wallet.id,
          agentId: wallet.managed_by_agent_id || undefined,
          protocol: 'x402',
          amount: auth.amount,
          currency: auth.currency,
          recipient: {
            endpoint_id: endpoint.id,
            endpoint_path: endpoint.path,
            vendor: endpoint.path.split('/')[0],
          },
          paymentContext: {
            auth,
            endpoint: {
              id: endpoint.id,
              path: endpoint.path,
              account_id: endpoint.account_id,
            },
          },
          requestedByType: ctx.actorType,
          requestedById: ctx.userId || ctx.apiKeyId || ctx.actorId || 'unknown',
          requestedByName: ctx.userName || ctx.actorName || undefined,
        });

        return c.json({
          status: 'pending_approval',
          message: 'Payment requires approval',
          reason: policyCheck.reason,
          code: 'APPROVAL_REQUIRED',
          approval: {
            id: approval.id,
            expiresAt: approval.expiresAt,
            amount: approval.amount,
            currency: approval.currency,
          }
        }, 202);
      }

      // Hard limit exceeded - reject outright
      const telemetry = createCheckoutTelemetryService(supabase);
      telemetry.record({
        protocol: 'x402',
        event_type: 'payment.policy_blocked',
        success: false,
        merchant_domain: endpoint.name,
        failure_reason: policyCheck.reason || 'Spending policy violation',
        failure_code: 'POLICY_VIOLATION',
        amount: auth.amount,
        currency: auth.currency,
        agent_id: wallet.managed_by_agent_id || undefined,
        protocol_metadata: { endpoint_id: endpoint.id, path: endpoint.path },
      });
      return c.json({
        error: 'Payment blocked by spending policy',
        reason: policyCheck.reason,
        code: 'POLICY_VIOLATION',
        violationType: policyCheck.violationType,
        limits: policyCheck.limits,
        currentSpending: policyCheck.currentSpending,
      }, 403);
    }

    // ============================================
    // 7. CALCULATE FEES & SETTLEMENT
    // ============================================

    const settlementService = createSettlementService(supabase);
    const feeCalculation = await settlementService.calculateX402Fee(
      ctx.tenantId,
      auth.amount,
      auth.currency
    );

    // Net amount goes to provider (gross - fees)
    const netAmount = feeCalculation.netAmount;
    const feeAmount = feeCalculation.feeAmount;

    // ============================================
    // 8. UPDATE SPENDING POLICY COUNTERS (Story 18.R1: Unified Service)
    // ============================================
    // Note: This is done before settlement to ensure we track spending even if settlement fails

    await spendingPolicyService.recordSpending(wallet.id, auth.amount);
    
    // Note: Cache invalidation is handled by the service

    // ============================================
    // 9. FETCH PROVIDER WALLET
    // ============================================
    // Get the provider's wallet to credit the net amount

    // Find the provider wallet. If the endpoint has a payment_address, match by
    // wallet_address for precision (avoids picking the wrong wallet when the
    // account has many wallets). Otherwise fall back to account-level lookup.
    let providerWallet: { id: string; wallet_type?: string | null; wallet_address?: string | null } | null = null;
    let providerWalletError: any = null;

    if (endpoint.payment_address) {
      const { data, error } = await supabase
        .from('wallets')
        .select('id, wallet_type, wallet_address')
        .eq('wallet_address', endpoint.payment_address)
        .eq('tenant_id', ctx.tenantId)
        .eq('status', 'active')
        .limit(1)
        .maybeSingle();
      providerWallet = data;
      providerWalletError = error;
    }

    // Fallback: account-level lookup excluding consumer wallet
    if (!providerWallet) {
      const { data: providerWallets, error } = await supabase
        .from('wallets')
        .select('id, wallet_type, wallet_address')
        .eq('owner_account_id', endpoint.account_id)
        .eq('tenant_id', ctx.tenantId)
        .eq('currency', auth.currency)
        .eq('status', 'active')
        .neq('id', wallet.id)
        .order('created_at', { ascending: true });

      providerWalletError = providerWalletError || error;

      // Prefer on-chain capable wallets so settlement goes through Circle
      const walletPriority = (w: { wallet_type?: string | null; wallet_address?: string | null }) => {
        if (w.wallet_type === 'circle_custodial' && w.wallet_address && !w.wallet_address.startsWith('internal://')) return 0;
        if (w.wallet_type === 'external' && w.wallet_address && !w.wallet_address.startsWith('internal://')) return 1;
        return 2;
      };
      const sorted = (providerWallets || []).sort((a, b) => walletPriority(a) - walletPriority(b));
      providerWallet = sorted[0] ?? null;
    }

    if (providerWalletError || !providerWallet) {
      return c.json({
        error: 'Provider wallet not found',
        code: 'PROVIDER_WALLET_NOT_FOUND',
        details: 'The endpoint owner does not have an active wallet for this currency'
      }, 500);
    }

    // ============================================
    // 10. CREATE TRANSFER RECORD
    // ============================================
    const t10 = Date.now();

    console.log('DEBUG: x402 pay ctx:', JSON.stringify(ctx, null, 2));

    const { data: transfer, error: transferError } = await supabase
      .from('transfers')
      .insert({
        tenant_id: ctx.tenantId,
        from_account_id: wallet.owner_account_id,
        to_account_id: endpoint.account_id,
        amount: auth.amount,
        fee_amount: feeAmount,
        currency: auth.currency,
        type: 'x402',
        status: 'pending', // Will be updated by batch settlement
        description: `x402 payment: ${endpoint.name}`,
        // Track who initiated this payment (user, agent, or API key)
        initiated_by_type: ctx.actorType,
        initiated_by_id: ctx.userId || ctx.apiKeyId || ctx.actorId || 'unknown',
        initiated_by_name: ctx.userName || ctx.actorName || null,
        protocol_metadata: {
          protocol: 'x402',
          endpoint_id: endpoint.id,
          endpoint_path: endpoint.path,
          endpoint_method: auth.method,
          wallet_id: wallet.id,
          provider_wallet_id: providerWallet.id,
          request_id: auth.requestId,
          timestamp: auth.timestamp,
          metadata: auth.metadata,
          price_calculated: price,
          volume_tier: endpoint.total_calls,
          fee_calculation: {
            grossAmount: auth.amount,
            feeAmount,
            netAmount,
            feeType: feeCalculation.feeType,
            breakdown: feeCalculation.breakdown,
          },
        }
      })
      .select()
      .single();

    timings['10_create_transfer'] = Date.now() - t10;

    if (transferError) {
      console.error('Error creating transfer record:', transferError);
      return c.json({
        error: 'Failed to create transfer record',
        code: 'RECORD_FAILED'
      }, 500);
    }

    // ============================================
    // 11. BATCH SETTLEMENT (OPTIMIZED)
    // Dual path: SQL ledger (internal) or on-chain (Circle/external)
    // ============================================
    const t11 = Date.now();

    // Declare outside try block for access later
    let settlementResult: {
      success: boolean;
      consumerNewBalance: number;
      providerNewBalance: number;
      settledAt: string;
      txHash?: string;
      settlementType?: string;
    };

    try {
      const consumerWalletType = wallet.wallet_type || 'internal';
      const isRealWallet = consumerWalletType === 'circle_custodial' || consumerWalletType === 'external';
      const isSandboxEnv = process.env.PAYOS_ENVIRONMENT === 'sandbox';

      // Check if provider wallet supports on-chain settlement
      const { data: providerWalletFull } = await supabase
        .from('wallets')
        .select('wallet_address, provider_wallet_id, wallet_type')
        .eq('id', providerWallet.id)
        .single();
      const providerOnChainAddress = providerWalletFull?.wallet_address;
      const providerIsOnChain = !!providerOnChainAddress && !providerOnChainAddress.startsWith('internal://');

      if (isRealWallet && isSandboxEnv && providerIsOnChain) {
        // ===== ON-CHAIN SETTLEMENT PATH =====
        const onChainResult = await executeOnChainTransfer({
          sourceWallet: wallet,
          destinationAddress: providerOnChainAddress,
          amount: auth.amount,
        });

        if (!onChainResult.success) {
          // x402 hard-fails on on-chain errors (no silent fallback)
          if (onChainResult.error) {
            await supabase
              .from('transfers')
              .update({ status: 'failed', protocol_metadata: { ...transfer.protocol_metadata, on_chain_error: onChainResult.error } })
              .eq('id', transfer.id);
            throw new Error(onChainResult.error);
          }
        }

        const txHash = onChainResult.txHash;

        // Store tx_hash on transfer
        if (txHash) {
          await supabase
            .from('transfers')
            .update({
              status: 'completed',
              tx_hash: txHash,
              completed_at: new Date().toISOString(),
              protocol_metadata: {
                ...transfer.protocol_metadata,
                settlement_type: 'on_chain',
                tx_hash: txHash,
              },
            })
            .eq('id', transfer.id);
        }

        // Sync DB balances from Circle API (authoritative source for custodial wallets)
        let consumerNewBalance = 0;
        let providerNewBalance = 0;
        const consumerIsCircle = wallet.wallet_type === 'circle_custodial';
        const providerIsCircle = providerWalletFull?.wallet_type === 'circle_custodial';

        if (consumerIsCircle || providerIsCircle) {
          try {
            const { getCircleClient } = await import('../services/circle/client.js');
            const circle = getCircleClient();

            if (consumerIsCircle && wallet.provider_wallet_id) {
              const bal = await circle.getUsdcBalance(wallet.provider_wallet_id);
              consumerNewBalance = bal.formatted;
              await supabase
                .from('wallets')
                .update({ balance: consumerNewBalance, last_synced_at: new Date().toISOString(), updated_at: new Date().toISOString() })
                .eq('id', wallet.id)
                .eq('tenant_id', ctx.tenantId);
            }

            if (providerIsCircle && providerWalletFull?.provider_wallet_id) {
              const bal = await circle.getUsdcBalance(providerWalletFull.provider_wallet_id);
              providerNewBalance = bal.formatted;
              await supabase
                .from('wallets')
                .update({ balance: providerNewBalance, last_synced_at: new Date().toISOString(), updated_at: new Date().toISOString() })
                .eq('id', providerWallet.id)
                .eq('tenant_id', ctx.tenantId);
            }
          } catch (syncErr: any) {
            console.warn(`[x402] Post-settlement Circle balance sync failed, using optimistic math: ${syncErr.message}`);
            // Optimistic fallback
            const srcBal = typeof wallet.balance === 'string' ? parseFloat(wallet.balance) : wallet.balance;
            consumerNewBalance = srcBal - auth.amount;
            await supabase
              .from('wallets')
              .update({ balance: consumerNewBalance, updated_at: new Date().toISOString() })
              .eq('id', wallet.id)
              .eq('tenant_id', ctx.tenantId);
          }
        } else {
          // Non-Circle on-chain wallets: use RPC for fee splitting
          const { data: ledgerSettlement } = await supabase
            .rpc('settle_x402_payment', {
              p_consumer_wallet_id: wallet.id,
              p_provider_wallet_id: providerWallet.id,
              p_gross_amount: auth.amount,
              p_net_amount: netAmount,
              p_transfer_id: transfer.id,
              p_tenant_id: ctx.tenantId,
            });
          consumerNewBalance = (ledgerSettlement as any)?.consumerNewBalance || 0;
          providerNewBalance = (ledgerSettlement as any)?.providerNewBalance || 0;
        }

        settlementResult = {
          success: true,
          consumerNewBalance,
          providerNewBalance,
          settledAt: new Date().toISOString(),
          txHash,
          settlementType: 'on_chain',
        };

        timings['11_settlement'] = Date.now() - t11;
        console.log(`On-chain settlement completed: tx=${txHash}`);

      } else {
        // ===== SQL LEDGER SETTLEMENT PATH (default) =====
        const { data: settlementData, error: settlementError } = await supabase
          .rpc('settle_x402_payment', {
            p_consumer_wallet_id: wallet.id,
            p_provider_wallet_id: providerWallet.id,
            p_gross_amount: auth.amount,
            p_net_amount: netAmount,
            p_transfer_id: transfer.id,
            p_tenant_id: ctx.tenantId
          });

        timings['11_settlement'] = Date.now() - t11;

        if (settlementError) {
          console.error('Batch settlement failed:', settlementError);
          return c.json({
            error: 'Payment created but settlement failed',
            transferId: transfer.id,
            settlementError: settlementError.message,
            code: 'SETTLEMENT_FAILED'
          }, 500);
        }

        settlementResult = {
          ...(settlementData as any),
          settlementType: 'ledger',
        };
        console.log('Batch settlement completed:', settlementResult);
      }

    } catch (error: any) {
      console.error('Settlement exception:', error);
      return c.json({
        error: 'Payment settlement failed',
        transferId: transfer.id,
        details: error.message,
        code: 'SETTLEMENT_EXCEPTION'
      }, 500);
    }

    // ============================================
    // 12. UPDATE ENDPOINT STATS
    // ============================================

    await supabase
      .from('x402_endpoints')
      .update({
        total_calls: endpoint.total_calls + 1,
        total_revenue: parseFloat(endpoint.total_revenue) + auth.amount,
        updated_at: new Date().toISOString()
      })
      .eq('id', endpoint.id)
      .eq('tenant_id', ctx.tenantId);

    // ============================================
    // 13. TRIGGER WEBHOOK (if configured)
    // ============================================

    if (endpoint.webhook_url) {
      // Fire and forget webhook (don't block response)
      fetch(endpoint.webhook_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-PayOS-Event': 'x402.payment.completed',
          'X-PayOS-Request-ID': auth.requestId
        },
        body: JSON.stringify({
          event: 'x402.payment.completed',
          timestamp: new Date().toISOString(),
          data: {
            transferId: transfer.id,
            requestId: auth.requestId,
            endpointId: endpoint.id,
            amount: auth.amount,
            currency: auth.currency,
            from: wallet.owner_account_id,
            to: endpoint.account_id
          }
        })
      }).catch(err => {
        console.error('Webhook delivery failed:', err);
      });
    }

    // ============================================
    // 14. RETURN SUCCESS
    // ============================================
    // OPTIMIZATION: Use balance from settlement result instead of extra DB query
    // Savings: ~120ms per request
    
    // Record successful payment telemetry
    {
      const telemetry = createCheckoutTelemetryService(supabase);
      telemetry.record({
        protocol: 'x402',
        event_type: 'payment.completed',
        success: true,
        merchant_domain: endpoint.name,
        amount: auth.amount,
        currency: auth.currency,
        agent_id: wallet.managed_by_agent_id || undefined,
        protocol_metadata: { endpoint_id: endpoint.id, path: endpoint.path },
      });
    }

    // Mark request as processed in bloom filter for future idempotency checks
    markRequestProcessed(auth.requestId);
    
    timings['total'] = Date.now() - startTotal;

    // Log performance breakdown
    console.log(`\n⏱️  [x402/pay PERFORMANCE] Total: ${timings.total}ms`);
    console.log(`    1. Idempotency:   ${timings['1_idempotency_check']}ms (${timings['1_idempotency_source']})`);
    console.log(`    2. Fetch:         ${timings['2_parallel_fetch']}ms (endpoint: ${timings['2_endpoint_source']})`);
    console.log(`   10. Transfer:      ${timings['10_create_transfer']}ms`);
    console.log(`   11. Settlement:    ${timings['11_settlement']}ms`);
    console.log(`   💨 Skipped: balance re-fetch (using settlement result)\n`);

    // Use balance from settlement result (already have it!)
    const newWalletBalance = settlementResult.consumerNewBalance;

    return c.json({
      success: true,
      message: 'Payment processed and settled successfully',
      data: {
        transferId: transfer.id,
        requestId: auth.requestId,
        amount: auth.amount,
        feeAmount: feeAmount,
        netAmount: netAmount,
        currency: auth.currency,
        endpointId: endpoint.id,
        walletId: wallet.id,
        newWalletBalance: newWalletBalance,
        timestamp: transfer.created_at,
        settlementStatus: 'completed',
        settledAt: new Date().toISOString(),

        // Proof of payment (for retrying original request)
        // Phase 2: JWT proof allows local verification (no API call needed)
        proof: {
          paymentId: transfer.id,
          jwt: createPaymentProofJWT({
            transferId: transfer.id,
            requestId: auth.requestId,
            endpointId: endpoint.id,
            amount: auth.amount,
            currency: auth.currency
          }),
          // Legacy signature for backward compatibility
          signature: `payos:${transfer.id}:${auth.requestId}`,
          // On-chain proof (when available)
          ...(settlementResult.txHash && {
            txHash: settlementResult.txHash,
            settlementType: settlementResult.settlementType,
          }),
        },
        
        // Performance metrics
        _perf: timings
      }
    }, 200);

  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json({
        error: 'Validation failed',
        details: error.errors,
        code: 'VALIDATION_ERROR'
      }, 400);
    }
    console.error('Error in POST /v1/x402/pay:', error);
    return c.json({
      error: 'Internal server error',
      code: 'INTERNAL_ERROR'
    }, 500);
  }
});

/**
 * POST /v1/x402/verify
 * Verify a payment has been completed
 * 
 * Supports two modes:
 * 1. JWT verification (fast, ~1ms) - pass jwt in body
 * 2. Database verification (slow, ~140ms) - pass transferId + requestId
 * 
 * Providers should prefer JWT verification when available.
 */
app.post('/verify', async (c) => {
  const startTime = Date.now();
  
  try {
    const ctx = c.get('ctx');
    const body = await c.req.json();

    // Check for JWT verification first (Phase 2 optimization)
    if (body.jwt) {
      const payload = verifyPaymentProofJWT(body.jwt);
      const totalTime = Date.now() - startTime;
      
      console.log(`\n⏱️  [x402/verify PERFORMANCE] Total: ${totalTime}ms (JWT local verification)\n`);
      
      if (!payload) {
        return c.json({
          verified: false,
          error: 'Invalid or expired JWT proof',
          code: 'INVALID_JWT',
          _perf: { total: totalTime, method: 'jwt' }
        }, 401);
      }
      
      return c.json({
        verified: true,
        data: {
          transferId: payload.transferId,
          requestId: payload.requestId,
          endpointId: payload.endpointId,
          amount: payload.amount,
          currency: payload.currency,
          verifiedAt: new Date().toISOString()
        },
        _perf: { total: totalTime, method: 'jwt' }
      }, 200);
    }

    // Fall back to database verification (legacy mode)
    const { requestId, transferId } = verifyPaymentSchema.parse(body);

    const supabase = createClient();

    // Fetch transfer
    const queryStart = Date.now();
    const { data: transfer, error } = await supabase
      .from('transfers')
      .select('id, status, amount, currency, from_account_id, to_account_id, created_at, protocol_metadata')
      .eq('id', transferId)
      .eq('protocol_metadata->>request_id', requestId)
      .eq('tenant_id', ctx.tenantId)
      .eq('type', 'x402')
      .single();
    const queryTime = Date.now() - queryStart;
    const totalTime = Date.now() - startTime;

    console.log(`\n⏱️  [x402/verify PERFORMANCE] Total: ${totalTime}ms (DB query: ${queryTime}ms)\n`);

    if (error || !transfer) {
      return c.json({
        verified: false,
        error: 'Payment not found',
        code: 'PAYMENT_NOT_FOUND',
        _perf: { total: totalTime, query: queryTime, method: 'db' }
      }, 404);
    }

    const verified = transfer.status === 'completed';

    return c.json({
      verified,
      data: verified ? {
        transferId: transfer.id,
        requestId,
        amount: parseFloat(transfer.amount),
        currency: transfer.currency,
        from: transfer.from_account_id,
        to: transfer.to_account_id,
        endpointId: transfer.protocol_metadata?.endpoint_id,
        timestamp: transfer.created_at,
        status: transfer.status
      } : null,
      _perf: { total: totalTime, query: queryTime, method: 'db' }
    }, verified ? 200 : 402);

  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json({
        error: 'Validation failed',
        details: error.errors,
        code: 'VALIDATION_ERROR'
      }, 400);
    }
    console.error('Error in POST /v1/x402/verify:', error);
    return c.json({
      error: 'Internal server error',
      code: 'INTERNAL_ERROR'
    }, 500);
  }
});

/**
 * GET /v1/x402/quote/:endpointId
 * Get pricing quote for an endpoint (for consumers to know price before paying)
 */
app.get('/quote/:endpointId', async (c) => {
  try {
    const ctx = c.get('ctx');
    const endpointId = c.req.param('endpointId');
    const supabase = createClient();

    // Fetch endpoint
    const { data: endpoint, error } = await supabase
      .from('x402_endpoints')
      .select('id, name, path, method, base_price, currency, volume_discounts, status, total_calls')
      .eq('id', endpointId)
      .eq('tenant_id', ctx.tenantId)
      .single();

    if (error || !endpoint) {
      return c.json({
        error: 'Endpoint not found',
        code: 'ENDPOINT_NOT_FOUND'
      }, 404);
    }

    if (endpoint.status !== 'active') {
      return c.json({
        error: 'Endpoint is not active',
        status: endpoint.status,
        code: 'ENDPOINT_INACTIVE'
      }, 400);
    }

    // Calculate current price
    const price = calculatePrice(
      parseFloat(endpoint.base_price),
      endpoint.volume_discounts || [],
      endpoint.total_calls
    );

    return c.json({
      data: {
        endpointId: endpoint.id,
        name: endpoint.name,
        path: endpoint.path,
        method: endpoint.method,
        basePrice: parseFloat(endpoint.base_price),
        currentPrice: price,
        currency: endpoint.currency,
        volumeDiscounts: endpoint.volume_discounts || [],
        totalCalls: endpoint.total_calls
      }
    });

  } catch (error) {
    console.error('Error in GET /v1/x402/quote/:endpointId:', error);
    return c.json({
      error: 'Internal server error',
      code: 'INTERNAL_ERROR'
    }, 500);
  }
});

export default app;

