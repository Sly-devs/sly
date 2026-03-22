/**
 * MPP Transfer Recorder
 *
 * Records MPP payments and session vouchers as transfers in the database.
 * Creates protocol_metadata with the MppMetadata schema.
 *
 * @see Story 71.6: Transfer Recording
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import type { MppPaymentMethod } from './types.js';

// ============================================
// Types
// ============================================

export interface RecordPaymentParams {
  tenantId: string;
  agentId: string;
  walletId: string;
  serviceUrl: string;
  amount: number;
  currency?: string;
  /** Human-readable payment description */
  description?: string;
  /** @deprecated Use `description` instead */
  intent?: string;
  /** Protocol-level intent from mppx (e.g. 'charge', 'session') */
  protocolIntent?: 'charge' | 'session';
  paymentMethod: MppPaymentMethod;
  receiptId?: string;
  receiptData?: Record<string, unknown>;
  settlementNetwork?: string;
  settlementTxHash?: string;
  fromAccountId?: string;
  toAccountId?: string;
  environment?: 'test' | 'live';
}

export interface RecordSessionVoucherParams {
  tenantId: string;
  agentId: string;
  walletId: string;
  sessionId: string;
  serviceUrl: string;
  voucherIndex: number;
  amount: number;
  currency?: string;
  paymentMethod: MppPaymentMethod;
  receiptId?: string;
  receiptData?: Record<string, unknown>;
  environment?: 'test' | 'live';
}

// ============================================
// Transfer Recorder
// ============================================

export class MppTransferRecorder {
  constructor(private supabase: SupabaseClient) {}

  /**
   * Record a one-shot MPP payment as a transfer.
   * Returns the transfer ID.
   */
  async recordPayment(params: RecordPaymentParams): Promise<string> {
    const transferId = randomUUID();
    const now = new Date().toISOString();
    const env = params.environment || 'test';

    // Look up agent name for display fields
    let agentName = 'Unknown Agent';
    const { data: agentRow } = await this.supabase
      .from('agents')
      .select('name')
      .eq('id', params.agentId)
      .eq('tenant_id', params.tenantId)
      .eq('environment', env)
      .single();
    if (agentRow?.name) agentName = agentRow.name;

    // Support both `description` (new) and `intent` (legacy) for the human-readable label
    const descriptionText = params.description || params.intent;

    const protocolMetadata = {
      protocol: 'mpp' as const,
      service_url: params.serviceUrl,
      payment_method: params.paymentMethod,
      protocol_intent: params.protocolIntent,
      intent: descriptionText,
      receipt_id: params.receiptId,
      receipt_data: params.receiptData,
      settlement_network: params.settlementNetwork,
      settlement_tx_hash: params.settlementTxHash,
      verified_at: now,
    };

    const { error } = await this.supabase
      .from('transfers')
      .insert({
        id: transferId,
        tenant_id: params.tenantId,
        environment: env,
        type: 'mpp',
        status: 'completed',
        amount: params.amount,
        currency: params.currency || 'USDC',
        from_account_id: params.fromAccountId || null,
        to_account_id: params.toAccountId || null,
        from_account_name: agentName,
        to_account_name: new URL(params.serviceUrl).hostname,
        description: descriptionText
          ? `MPP payment: ${descriptionText}`
          : `MPP payment to ${new URL(params.serviceUrl).hostname}`,
        initiated_by_type: 'agent',
        initiated_by_id: params.agentId,
        initiated_by_name: agentName,
        protocol_metadata: protocolMetadata,
        settlement_network: params.settlementNetwork,
        tx_hash: params.settlementTxHash,
        completed_at: now,
        created_at: now,
      });

    if (error) {
      console.error('[MPP] Failed to record transfer:', error);
      throw new Error(`Failed to record MPP transfer: ${error.message}`);
    }

    return transferId;
  }

  /**
   * Record a session voucher as a transfer.
   * Returns the transfer ID.
   */
  async recordSessionVoucher(params: RecordSessionVoucherParams): Promise<string> {
    const transferId = randomUUID();
    const now = new Date().toISOString();
    const env = params.environment || 'test';

    // Look up agent name for display fields
    let agentName = 'Unknown Agent';
    const { data: agentRow } = await this.supabase
      .from('agents')
      .select('name')
      .eq('id', params.agentId)
      .eq('tenant_id', params.tenantId)
      .eq('environment', env)
      .single();
    if (agentRow?.name) agentName = agentRow.name;

    const protocolMetadata = {
      protocol: 'mpp' as const,
      service_url: params.serviceUrl,
      payment_method: params.paymentMethod,
      session_id: params.sessionId,
      voucher_index: params.voucherIndex,
      receipt_id: params.receiptId,
      receipt_data: params.receiptData,
      verified_at: now,
    };

    const { error } = await this.supabase
      .from('transfers')
      .insert({
        id: transferId,
        tenant_id: params.tenantId,
        environment: env,
        type: 'mpp',
        status: 'completed',
        amount: params.amount,
        currency: params.currency || 'USDC',
        from_account_name: agentName,
        to_account_name: new URL(params.serviceUrl).hostname,
        description: `MPP session voucher #${params.voucherIndex} for ${new URL(params.serviceUrl).hostname}`,
        initiated_by_type: 'agent',
        initiated_by_id: params.agentId,
        initiated_by_name: agentName,
        protocol_metadata: protocolMetadata,
        completed_at: now,
        created_at: now,
      });

    if (error) {
      console.error('[MPP] Failed to record session voucher:', error);
      throw new Error(`Failed to record MPP session voucher: ${error.message}`);
    }

    return transferId;
  }

  /**
   * Get MPP transfers by service URL.
   */
  async getByService(
    tenantId: string,
    serviceUrl: string,
    options?: { limit?: number; offset?: number }
  ): Promise<any[]> {
    const { data, error } = await this.supabase
      .from('transfers')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('type', 'mpp')
      .filter('protocol_metadata->>service_url', 'eq', serviceUrl)
      .order('created_at', { ascending: false })
      .range(options?.offset || 0, (options?.offset || 0) + (options?.limit || 50) - 1);

    if (error) {
      console.error('[MPP] Failed to query transfers by service:', error);
      return [];
    }

    return data || [];
  }

  /**
   * Get MPP transfers by session ID.
   */
  async getBySession(
    tenantId: string,
    sessionId: string
  ): Promise<any[]> {
    const { data, error } = await this.supabase
      .from('transfers')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('type', 'mpp')
      .filter('protocol_metadata->>session_id', 'eq', sessionId)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('[MPP] Failed to query transfers by session:', error);
      return [];
    }

    return data || [];
  }
}
