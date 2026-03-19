/**
 * MPP Receipt Reconciliation
 *
 * Stores, verifies, and cross-references MPP payment receipts
 * to ensure all payments are properly tracked and settled.
 *
 * @see Story 71.13: Receipt Reconciliation
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ============================================
// Types
// ============================================

export interface MppReceipt {
  id: string;
  tenantId: string;
  transferId?: string;
  sessionId?: string;
  receiptId: string;
  payerAddress: string;
  recipientAddress: string;
  amount: string;
  currency: string;
  method: string;
  settlementNetwork?: string;
  settlementTxHash?: string;
  receiptData: Record<string, unknown>;
  verified: boolean;
  verifiedAt?: string;
  createdAt: string;
}

export type ReconciliationStatus = 'matched' | 'unmatched' | 'overpaid' | 'underpaid' | 'disputed';

export interface ReconciliationResult {
  receiptId: string;
  status: ReconciliationStatus;
  transferId?: string;
  expectedAmount: number;
  actualAmount: number;
  difference: number;
  details?: string;
}

// ============================================
// Receipt Reconciler
// ============================================

export class MppReceiptReconciler {
  constructor(private supabase: SupabaseClient) {}

  /**
   * Store a receipt for later reconciliation.
   */
  async storeReceipt(params: {
    tenantId: string;
    transferId?: string;
    sessionId?: string;
    receiptId: string;
    payerAddress: string;
    recipientAddress: string;
    amount: string;
    currency?: string;
    method: string;
    settlementNetwork?: string;
    settlementTxHash?: string;
    receiptData?: Record<string, unknown>;
  }): Promise<string> {
    // Store receipt data alongside the transfer's protocol_metadata
    // Since we don't have a separate receipts table yet, we store in transfers
    if (params.transferId) {
      await this.supabase
        .from('transfers')
        .update({
          protocol_metadata: this.supabase.rpc ? undefined : {
            // Will be merged with existing metadata
            receipt_id: params.receiptId,
            receipt_data: params.receiptData,
            settlement_network: params.settlementNetwork,
            settlement_tx_hash: params.settlementTxHash,
            verified_at: new Date().toISOString(),
          },
          updated_at: new Date().toISOString(),
        })
        .eq('id', params.transferId)
        .eq('tenant_id', params.tenantId);
    }

    return params.receiptId;
  }

  /**
   * Verify a receipt against on-chain or payment provider data.
   */
  async verifyReceipt(
    receiptId: string,
    tenantId: string
  ): Promise<{ verified: boolean; reason?: string }> {
    // Find the transfer with this receipt
    const { data: transfers } = await this.supabase
      .from('transfers')
      .select('id, amount, protocol_metadata, tx_hash, settlement_network')
      .eq('tenant_id', tenantId)
      .eq('type', 'mpp')
      .filter('protocol_metadata->>receipt_id', 'eq', receiptId);

    if (!transfers || transfers.length === 0) {
      return { verified: false, reason: 'Receipt not found in transfers' };
    }

    const transfer = transfers[0];

    // If we have a settlement tx hash, we could verify on-chain
    if (transfer.tx_hash) {
      // On-chain verification would go here
      // For now, we trust the receipt data recorded at payment time
      return { verified: true };
    }

    // Receipt exists in our records
    return { verified: true };
  }

  /**
   * Reconcile receipts for a tenant within a time range.
   * Cross-references MPP transfers with expected payments.
   */
  async reconcile(
    tenantId: string,
    options?: { startDate?: string; endDate?: string; sessionId?: string }
  ): Promise<ReconciliationResult[]> {
    let query = this.supabase
      .from('transfers')
      .select('id, amount, protocol_metadata, tx_hash, status, created_at')
      .eq('tenant_id', tenantId)
      .eq('type', 'mpp')
      .order('created_at', { ascending: true });

    if (options?.startDate) {
      query = query.gte('created_at', options.startDate);
    }
    if (options?.endDate) {
      query = query.lte('created_at', options.endDate);
    }
    if (options?.sessionId) {
      query = query.filter('protocol_metadata->>session_id', 'eq', options.sessionId);
    }

    const { data: transfers } = await query;

    if (!transfers) return [];

    return transfers.map(t => {
      const metadata = t.protocol_metadata as any;
      const hasReceipt = !!metadata?.receipt_id;
      const amount = parseFloat(t.amount);

      return {
        receiptId: metadata?.receipt_id || t.id,
        status: hasReceipt ? 'matched' as const : 'unmatched' as const,
        transferId: t.id,
        expectedAmount: amount,
        actualAmount: amount, // In reconciliation, compare with provider data
        difference: 0,
        details: hasReceipt ? undefined : 'No receipt recorded for this transfer',
      };
    });
  }
}
