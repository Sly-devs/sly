/**
 * A2A Payment Handler
 *
 * Orchestrates payment within A2A tasks.
 * Integrates x402 and AP2 payment flows into the A2A task lifecycle.
 *
 * @see Epic 57: Google A2A Protocol Integration
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { A2ATaskService } from './task-service.js';
import type { InputRequiredContext } from './types.js';
import { authorizeWalletTransfer, isOnChainCapable } from '../wallet-settlement.js';

interface PaymentRequirement {
  amount: number;
  currency: string;
  x402Endpoint?: string;
  mandateId?: string;
  description?: string;
}

interface PaymentProof {
  type: 'x402' | 'ap2' | 'wallet';
  transferId?: string;
  mandateId?: string;
  paymentToken?: string;
}

export class A2APaymentHandler {
  constructor(
    private supabase: SupabaseClient,
    private tenantId: string,
    private taskService: A2ATaskService,
  ) {}

  /**
   * Execute real wallet settlement between two agents.
   * Used for A2A task payments when both agents have real wallets.
   * Returns transfer details including tx_hash for on-chain settlements.
   */
  async settleRealWalletPayment(
    taskId: string,
    fromAgentId: string,
    toAgentId: string,
    amount: number,
    currency: string = 'USDC',
  ): Promise<{ success: boolean; transferId?: string; txHash?: string; error?: string }> {
    // Fetch both agents' wallets
    const [fromWalletResult, toWalletResult] = await Promise.all([
      this.supabase
        .from('wallets')
        .select('id, wallet_address, wallet_type, provider_wallet_id, balance, owner_account_id')
        .eq('managed_by_agent_id', fromAgentId)
        .eq('tenant_id', this.tenantId)
        .limit(1)
        .maybeSingle(),
      this.supabase
        .from('wallets')
        .select('id, wallet_address, wallet_type, provider_wallet_id, balance, owner_account_id')
        .eq('managed_by_agent_id', toAgentId)
        .eq('tenant_id', this.tenantId)
        .limit(1)
        .maybeSingle(),
    ]);

    const fromWallet = fromWalletResult.data;
    const toWallet = toWalletResult.data;

    if (!fromWallet || !toWallet) {
      return { success: false, error: 'One or both agents do not have wallets' };
    }

    // Check balance
    if (parseFloat(fromWallet.balance) < amount) {
      return { success: false, error: `Insufficient balance: ${fromWallet.balance} < ${amount}` };
    }

    const onChainCapable = isOnChainCapable(fromWallet, toWallet.wallet_address);

    // Epic 38, Story 38.13: For micro-payments below threshold, use deferred intent
    const DEFERRED_THRESHOLD = parseFloat(process.env.DEFERRED_THRESHOLD_AMOUNT || '1.00');
    if (amount <= DEFERRED_THRESHOLD && amount > 0) {
      try {
        const { createAndAuthorizeIntent } = await import('../payment-intent.js');
        const intentResult = await createAndAuthorizeIntent({
          supabase: this.supabase,
          tenantId: this.tenantId,
          sourceWalletId: fromWallet.id,
          destinationWalletId: toWallet.id,
          sourceAccountId: fromWallet.owner_account_id,
          destinationAccountId: toWallet.owner_account_id,
          amount,
          protocol: 'a2a',
          protocolMetadata: {
            task_id: taskId,
            from_agent_id: fromAgentId,
            to_agent_id: toAgentId,
          },
        });

        if (intentResult.success && intentResult.intent) {
          await this.taskService.linkPayment(taskId, intentResult.intent.id);
          console.log(`[A2A-deferred] Micro-payment ${amount} ${currency} via intent ${intentResult.intent.id} for task ${taskId}`);
          return { success: true, transferId: intentResult.intent.id };
        }
        // If intent fails, fall through to standard flow
        console.warn(`[A2A-deferred] Intent failed (${intentResult.error}), falling back to standard flow`);
      } catch (err: any) {
        console.warn(`[A2A-deferred] Intent creation error, falling back: ${err.message}`);
      }
    }

    // Create transfer record
    const { data: transfer, error: transferError } = await this.supabase
      .from('transfers')
      .insert({
        tenant_id: this.tenantId,
        from_account_id: fromWallet.owner_account_id,
        to_account_id: toWallet.owner_account_id,
        amount,
        currency,
        type: 'internal',
        status: 'pending',
        description: `A2A task payment for task ${taskId}`,
        initiated_by_type: 'agent',
        initiated_by_id: fromAgentId,
        initiated_by_name: `agent:${fromAgentId}`,
        protocol_metadata: {
          protocol: 'a2a',
          task_id: taskId,
          from_agent_id: fromAgentId,
          to_agent_id: toAgentId,
          wallet_id: fromWallet.id,
          provider_wallet_id: toWallet.id,
        },
      })
      .select('id')
      .single();

    if (transferError || !transfer) {
      return { success: false, error: 'Failed to create transfer record' };
    }

    // Fast ledger authorization — on-chain deferred to async worker (Epic 38, Story 38.2)
    const authorization = await authorizeWalletTransfer({
      supabase: this.supabase,
      tenantId: this.tenantId,
      sourceWallet: fromWallet,
      destinationWallet: toWallet,
      amount,
      transferId: transfer.id,
      protocolMetadata: {
        protocol: 'a2a',
        task_id: taskId,
        from_agent_id: fromAgentId,
        to_agent_id: toAgentId,
        wallet_id: fromWallet.id,
        provider_wallet_id: toWallet.id,
      },
    });

    if (!authorization.success) {
      return { success: false, transferId: transfer.id, error: authorization.error || 'Authorization failed' };
    }

    // If not on-chain capable, the transfer is already final (ledger-only)
    // Mark as completed since async worker won't pick it up
    if (!onChainCapable) {
      await this.supabase
        .from('transfers')
        .update({
          status: 'completed',
          completed_at: new Date().toISOString(),
          protocol_metadata: {
            protocol: 'a2a',
            task_id: taskId,
            from_agent_id: fromAgentId,
            to_agent_id: toAgentId,
            wallet_id: fromWallet.id,
            provider_wallet_id: toWallet.id,
            settlement_type: 'ledger',
          },
        })
        .eq('id', transfer.id);
    }

    // Link payment to task
    await this.taskService.linkPayment(taskId, transfer.id);

    return { success: true, transferId: transfer.id };
  }

  /**
   * Set a task to require payment before proceeding.
   * Transitions task to `input-required` with payment metadata.
   */
  async requirePayment(
    taskId: string,
    requirement: PaymentRequirement,
  ) {
    const irc: InputRequiredContext = {
      reason_code: 'needs_payment',
      next_action: 'send_payment_proof',
      required_auth: 'agent_token',
      details: {
        'x402.payment.required': true,
        'x402.payment.amount': requirement.amount,
        'x402.payment.currency': requirement.currency,
        'x402.payment.endpoint': requirement.x402Endpoint,
        'x402.payment.description': requirement.description,
      },
    };

    await this.taskService.setInputRequired(
      taskId,
      `Payment of ${requirement.amount} ${requirement.currency} required`,
      irc,
    );

    // Add agent message explaining payment requirement
    await this.taskService.addMessage(taskId, 'agent', [
      {
        data: {
          type: 'payment_required',
          ...requirement,
        },
        metadata: { mimeType: 'application/json' },
      },
      {
        text: `This task requires a payment of ${requirement.amount} ${requirement.currency}. Please submit payment to proceed.`,
      },
    ]);
  }

  /**
   * Verify and process a payment submission for a task.
   * On success, transitions task to `working`.
   */
  async processPayment(
    taskId: string,
    proof: PaymentProof,
  ): Promise<{ verified: boolean; error?: string }> {
    // Verify the payment based on type
    if (proof.type === 'x402' && proof.paymentToken) {
      return this.verifyX402Payment(taskId, proof.paymentToken);
    }

    if (proof.type === 'ap2' && proof.mandateId) {
      return this.verifyAP2Payment(taskId, proof.mandateId, proof.transferId);
    }

    if (proof.type === 'wallet' && proof.transferId) {
      return this.verifyWalletPayment(taskId, proof.transferId);
    }

    return { verified: false, error: 'Invalid payment proof type' };
  }

  /**
   * Check if both agents are on the same Sly tenant.
   * If so, can use wallet-to-wallet transfer (free, instant).
   */
  async canUseSlyNativePayment(
    sourceAgentId: string,
    targetAgentId: string,
  ): Promise<boolean> {
    const { data: agents } = await this.supabase
      .from('agents')
      .select('id, tenant_id')
      .in('id', [sourceAgentId, targetAgentId]);

    if (!agents || agents.length !== 2) return false;
    return agents[0].tenant_id === agents[1].tenant_id;
  }

  // ==========================================================================
  // Private verification methods
  // ==========================================================================

  private async verifyX402Payment(
    taskId: string,
    paymentToken: string,
  ): Promise<{ verified: boolean; error?: string }> {
    // Verify the x402 payment token
    // In production, this would call the x402 verification service
    const { data: transfer } = await this.supabase
      .from('transfers')
      .select('id, status, amount, currency')
      .eq('id', paymentToken)
      .eq('tenant_id', this.tenantId)
      .single();

    if (!transfer) {
      return { verified: false, error: 'Transfer not found' };
    }

    if (transfer.status !== 'completed' && transfer.status !== 'authorized') {
      return { verified: false, error: `Transfer status: ${transfer.status}` };
    }

    // Link payment to task and transition to working
    await this.taskService.linkPayment(taskId, transfer.id);
    await this.taskService.updateTaskState(taskId, 'working', 'Payment verified, processing task');

    await this.taskService.addMessage(taskId, 'agent', [
      {
        data: {
          type: 'payment_verified',
          transferId: transfer.id,
          amount: transfer.amount,
          currency: transfer.currency,
        },
        metadata: { mimeType: 'application/json' },
      },
    ]);

    return { verified: true };
  }

  private async verifyAP2Payment(
    taskId: string,
    mandateId: string,
    transferId?: string,
  ): Promise<{ verified: boolean; error?: string }> {
    const { data: mandate } = await this.supabase
      .from('ap2_mandates')
      .select('id, status, a2a_session_id')
      .eq('id', mandateId)
      .eq('tenant_id', this.tenantId)
      .single();

    if (!mandate) {
      return { verified: false, error: 'Mandate not found' };
    }

    if (mandate.status !== 'active') {
      return { verified: false, error: `Mandate status: ${mandate.status}` };
    }

    // Link mandate and optional transfer to task
    await this.taskService.linkPayment(taskId, transferId, mandateId);

    // Update mandate with A2A session linkage
    await this.supabase
      .from('ap2_mandates')
      .update({ a2a_session_id: taskId })
      .eq('id', mandateId)
      .eq('tenant_id', this.tenantId);

    await this.taskService.updateTaskState(taskId, 'working', 'Mandate verified, processing task');
    return { verified: true };
  }

  private async verifyWalletPayment(
    taskId: string,
    transferId: string,
  ): Promise<{ verified: boolean; error?: string }> {
    const { data: transfer } = await this.supabase
      .from('transfers')
      .select('id, status, amount, currency')
      .eq('id', transferId)
      .eq('tenant_id', this.tenantId)
      .single();

    if (!transfer || (transfer.status !== 'completed' && transfer.status !== 'authorized')) {
      return { verified: false, error: 'Wallet transfer not found or not settled' };
    }

    await this.taskService.linkPayment(taskId, transferId);
    await this.taskService.updateTaskState(taskId, 'working', 'Payment verified, processing task');
    return { verified: true };
  }
}
