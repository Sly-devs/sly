/**
 * Governed MPP Client
 *
 * Wraps the raw MppClient with Sly governance:
 * 1. Resolve agent wallet
 * 2. Check spending policy
 * 3. If denied -> structured error, never call mppx
 * 4. If requiresApproval -> create approval request
 * 5. If approved -> delegate to mppx, record spending
 *
 * @see Story 71.2: Governance Middleware
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { MppClient, getMppClient, createMppClient } from './client.js';
import { MppTransferRecorder } from './transfer-recorder.js';
import { SpendingPolicyService, type PolicyContext } from '../spending-policy.js';
import { ApprovalWorkflowService, type CreateApprovalRequest } from '../approval-workflow.js';
import { trackOp } from '../ops/track-op.js';
import { OpType } from '../ops/operation-types.js';
import type { MppPaymentResult, MppPaymentMethod } from './types.js';

// ============================================
// Types
// ============================================

export interface GovernedChargeOptions {
  /** Target service URL */
  serviceUrl: string;
  /** Payment amount in USD */
  amount: number;
  /** Currency (default: 'USDC') */
  currency?: string;
  /** Human-readable payment description */
  description?: string;
  /** @deprecated Use `description` instead */
  intent?: string;
  /** Agent ID making the payment */
  agentId: string;
  /** Tenant ID */
  tenantId: string;
  /** Wallet ID (optional — resolved from agent if not provided) */
  walletId?: string;
  /** Correlation ID for tracing */
  correlationId?: string;
  /** Actor type */
  actorType?: 'api_key' | 'user' | 'agent';
  /** Actor ID */
  actorId?: string;
}

export interface GovernedChargeResult {
  /** Whether the payment was executed */
  executed: boolean;
  /** Payment result (if executed) */
  payment?: MppPaymentResult;
  /** Transfer ID recorded in DB */
  transferId?: string;
  /** If payment requires approval */
  requiresApproval?: boolean;
  /** Approval ID (if requires approval) */
  approvalId?: string;
  /** Denial reason (if denied by policy) */
  deniedReason?: string;
  /** Which policy was violated */
  violationType?: string;
}

// ============================================
// Governed Client
// ============================================

export class GovernedMppClient {
  private mppClient: MppClient;
  private policyService: SpendingPolicyService;
  private approvalService: ApprovalWorkflowService;
  private recorder: MppTransferRecorder;

  constructor(
    private supabase: SupabaseClient,
    mppClient?: MppClient,
  ) {
    this.mppClient = mppClient || getMppClient();
    this.policyService = new SpendingPolicyService(supabase);
    this.approvalService = new ApprovalWorkflowService(supabase);
    this.recorder = new MppTransferRecorder(supabase);
  }

  /**
   * Execute a governed one-shot MPP payment.
   * Checks spending policy before calling mppx.
   */
  async charge(options: GovernedChargeOptions): Promise<GovernedChargeResult> {
    const {
      serviceUrl, amount, currency = 'USDC',
      agentId, tenantId, correlationId, actorType = 'agent', actorId,
    } = options;
    // Support both `description` (new) and `intent` (legacy)
    const description = options.description || options.intent;

    // 1. Resolve agent wallet
    let walletId = options.walletId;
    if (!walletId) {
      const wallet = await this.policyService.getAgentWallet(agentId, tenantId);
      if (!wallet) {
        trackOp({
          tenantId,
          operation: OpType.MPP_POLICY_VIOLATED,
          subject: `agent/${agentId}`,
          correlationId,
          success: false,
          data: { reason: 'No wallet found for agent', serviceUrl },
        });
        return {
          executed: false,
          deniedReason: 'No wallet found for agent. Provision a wallet first.',
        };
      }
      walletId = wallet.id;
    }

    // 2. Check spending policy
    const policyContext: PolicyContext = {
      protocol: 'mpp',
      vendor: new URL(serviceUrl).hostname,
      mppServiceUrl: serviceUrl,
      metadata: { description },
    };

    trackOp({
      tenantId,
      operation: OpType.MPP_POLICY_CHECKED,
      subject: `wallet/${walletId}`,
      correlationId,
      success: true,
      amountUsd: amount,
      data: { serviceUrl, protocol: 'mpp' },
    });

    const policyResult = await this.policyService.checkPolicy(
      walletId, amount, policyContext, correlationId
    );

    // 3. If denied (hard limit)
    if (!policyResult.allowed && !policyResult.requiresApproval) {
      trackOp({
        tenantId,
        operation: OpType.MPP_POLICY_VIOLATED,
        subject: `wallet/${walletId}`,
        correlationId,
        success: false,
        amountUsd: amount,
        data: {
          serviceUrl,
          reason: policyResult.reason,
          violationType: policyResult.violationType,
        },
      });
      return {
        executed: false,
        deniedReason: policyResult.reason,
        violationType: policyResult.violationType,
      };
    }

    // 4. If requires approval
    if (policyResult.requiresApproval) {
      const approvalRequest: CreateApprovalRequest = {
        tenantId,
        walletId,
        agentId,
        protocol: 'mpp',
        amount,
        currency,
        recipient: {
          mppServiceUrl: serviceUrl,
          vendor: new URL(serviceUrl).hostname,
        },
        paymentContext: {
          serviceUrl,
          description,
          protocol: 'mpp',
        },
        requestedByType: actorType,
        requestedById: actorId || agentId,
        correlationId,
      };

      const approval = await this.approvalService.createApproval(approvalRequest);

      return {
        executed: false,
        requiresApproval: true,
        approvalId: approval.id,
        deniedReason: policyResult.reason,
      };
    }

    // 5. Resolve per-agent wallet key (if available)
    let chargeClient = this.mppClient;
    try {
      const { data: walletKeyRow } = await this.supabase
        .from('wallets')
        .select('provider_metadata')
        .eq('id', walletId)
        .single();
      const encryptedKey = walletKeyRow?.provider_metadata?.encrypted_private_key;
      if (encryptedKey) {
        chargeClient = createMppClient({ privateKey: encryptedKey });
        console.log('[MPP] Using per-agent wallet key for charge');
      }
    } catch {
      // Fall back to global client
    }

    // 6. Execute payment via mppx
    trackOp({
      tenantId,
      operation: OpType.MPP_CREDENTIAL_SIGNED,
      subject: `wallet/${walletId}`,
      correlationId,
      success: true,
      amountUsd: amount,
      data: { serviceUrl },
    });

    let paymentResult: MppPaymentResult;
    try {
      paymentResult = await chargeClient.charge(serviceUrl, {
        amount: String(amount),
        description,
      });
    } catch (err: any) {
      trackOp({
        tenantId,
        operation: OpType.MPP_PAYMENT_FAILED,
        subject: `wallet/${walletId}`,
        correlationId,
        success: false,
        amountUsd: amount,
        data: { serviceUrl, error: err.message },
      });
      return {
        executed: false,
        deniedReason: err.message || 'MPP client error',
        violationType: 'mpp_client_error',
      };
    }

    if (!paymentResult.success) {
      trackOp({
        tenantId,
        operation: OpType.MPP_PAYMENT_FAILED,
        subject: `wallet/${walletId}`,
        correlationId,
        success: false,
        amountUsd: amount,
        data: {
          serviceUrl,
          error: paymentResult.error,
          errorCode: paymentResult.errorCode,
        },
      });
      return {
        executed: false,
        payment: paymentResult,
        deniedReason: paymentResult.error,
      };
    }

    // 7. Record spending and transfer
    await this.policyService.recordSpending(walletId, amount);

    // Resolve parent account for from_account_id
    let fromAccountId: string | null = null;
    if (walletId) {
      const { data: walletRow } = await this.supabase
        .from('wallets')
        .select('owner_account_id')
        .eq('id', walletId)
        .single();
      if (walletRow?.owner_account_id) fromAccountId = walletRow.owner_account_id;
    }

    const transferId = await this.recorder.recordPayment({
      tenantId,
      agentId,
      walletId,
      serviceUrl,
      amount,
      currency,
      description,
      protocolIntent: paymentResult.protocolIntent,
      paymentMethod: paymentResult.paymentMethod || 'tempo',
      receiptId: paymentResult.receiptId,
      receiptData: paymentResult.receiptData,
      settlementNetwork: paymentResult.settlementNetwork,
      settlementTxHash: paymentResult.settlementTxHash,
      fromAccountId: fromAccountId || undefined,
    });

    trackOp({
      tenantId,
      operation: OpType.MPP_PAYMENT_COMPLETED,
      subject: `transfer/${transferId}`,
      correlationId,
      success: true,
      amountUsd: amount,
      currency,
      data: {
        serviceUrl,
        paymentMethod: paymentResult.paymentMethod,
        receiptId: paymentResult.receiptId,
        transferId,
      },
    });

    return {
      executed: true,
      payment: paymentResult,
      transferId,
    };
  }
}
