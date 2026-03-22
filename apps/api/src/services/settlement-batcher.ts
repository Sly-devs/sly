/**
 * Settlement Batcher (Epic 38, Story 38.11)
 *
 * Creates settlement batches from net positions and executes
 * on-chain transfers for the net amounts.
 *
 * Example: 1000 micro-payments between agents A↔B net to a single $3 transfer.
 *
 * Used by the BatchSettlementWorker (Story 38.14).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { computeNetPositions, type NetPositionSummary } from './net-position.js';
import { executeOnChainTransfer, isOnChainCapable, type SettlementWallet } from './wallet-settlement.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BatchResult {
  batchId: string;
  tenantId: string;
  status: 'completed' | 'partial' | 'failed';
  intentCount: number;
  netTransferCount: number;
  totalGrossAmount: number;
  totalNetAmount: number;
  reductionRatio: number;
  settlements: BatchSettlementResult[];
  error?: string;
}

export interface BatchSettlementResult {
  sourceWalletId: string;
  destinationWalletId: string;
  netAmount: number;
  intentCount: number;
  txHash?: string;
  settlementType: 'on_chain' | 'ledger';
  error?: string;
}

// ---------------------------------------------------------------------------
// Create Batch
// ---------------------------------------------------------------------------

/**
 * Create a settlement batch from all authorized intents for a tenant.
 * Computes net positions and creates a batch record.
 *
 * Does NOT execute settlements — call executeBatch() for that.
 */
export async function createBatch(
  supabase: SupabaseClient,
  tenantId: string,
  environment: 'test' | 'live' = 'test',
): Promise<{ batchId: string; summary: NetPositionSummary } | null> {
  const summary = await computeNetPositions(supabase, tenantId);

  if (summary.totalIntents === 0) {
    return null;
  }

  // Create batch record
  const { data: batch, error } = await supabase
    .from('settlement_batches')
    .insert({
      tenant_id: tenantId,
      environment,
      status: 'pending',
      intent_count: summary.totalIntents,
      net_transfer_count: summary.positions.filter(p => Math.abs(p.netAmount) >= 0.001).length,
      total_gross_amount: summary.totalGrossAmount,
      total_net_amount: summary.totalNetAmount,
    })
    .select('id')
    .single();

  if (error || !batch) {
    console.error(`[Batcher] Failed to create batch for tenant ${tenantId}:`, error?.message);
    return null;
  }

  // Mark all authorized intents as batched
  const allIntentIds = summary.positions.flatMap(p => p.intentIds);
  if (allIntentIds.length > 0) {
    await supabase
      .from('payment_intents')
      .update({
        status: 'batched',
        batch_id: batch.id,
        batched_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('tenant_id', tenantId)
      .eq('environment', environment)
      .eq('status', 'authorized')
      .in('id', allIntentIds);
  }

  console.log(`[Batcher] Created batch ${batch.id} for tenant ${tenantId}: ${summary.totalIntents} intents → ${summary.positions.filter(p => Math.abs(p.netAmount) >= 0.001).length} net transfers (${(summary.reductionRatio * 100).toFixed(0)}% reduction)`);

  return { batchId: batch.id, summary };
}

// ---------------------------------------------------------------------------
// Execute Batch
// ---------------------------------------------------------------------------

/**
 * Execute a settlement batch: for each net position with non-zero amount,
 * execute an on-chain transfer (or ledger-only if not on-chain capable).
 */
export async function executeBatch(
  supabase: SupabaseClient,
  batchId: string,
  tenantId: string,
  summary: NetPositionSummary,
  environment: 'test' | 'live' = 'test',
): Promise<BatchResult> {
  // Mark batch as processing
  await supabase
    .from('settlement_batches')
    .update({ status: 'processing', started_at: new Date().toISOString() })
    .eq('id', batchId);

  const settlements: BatchSettlementResult[] = [];
  let successCount = 0;
  let failCount = 0;

  for (const position of summary.positions) {
    const absAmount = Math.abs(position.netAmount);

    // Skip zero-net positions (already settled by netting)
    if (absAmount < 0.001) {
      // Mark intents as settled (net zero — no on-chain needed)
      await markIntentsSettled(supabase, tenantId, position.intentIds, batchId);
      continue;
    }

    // Determine direction: positive = A→B, negative = B→A
    const sourceId = position.netAmount > 0 ? position.walletA : position.walletB;
    const destId = position.netAmount > 0 ? position.walletB : position.walletA;

    try {
      const result = await settleNetPosition(supabase, tenantId, sourceId, destId, absAmount, batchId, environment);
      settlements.push({
        sourceWalletId: sourceId,
        destinationWalletId: destId,
        netAmount: absAmount,
        intentCount: position.intentCount,
        txHash: result.txHash,
        settlementType: result.settlementType,
      });

      // Mark intents as settled
      await markIntentsSettled(supabase, tenantId, position.intentIds, batchId, result.transferId);
      successCount++;
    } catch (err: any) {
      settlements.push({
        sourceWalletId: sourceId,
        destinationWalletId: destId,
        netAmount: absAmount,
        intentCount: position.intentCount,
        settlementType: 'ledger',
        error: err.message,
      });
      failCount++;
    }
  }

  // Determine overall batch status
  const batchStatus = failCount === 0 ? 'completed' : successCount > 0 ? 'completed' : 'failed';

  // Update batch record
  await supabase
    .from('settlement_batches')
    .update({
      status: batchStatus,
      completed_at: new Date().toISOString(),
      error: failCount > 0 ? `${failCount} settlement(s) failed` : null,
    })
    .eq('id', batchId);

  const result: BatchResult = {
    batchId,
    tenantId,
    status: failCount === 0 ? 'completed' : successCount > 0 ? 'partial' : 'failed',
    intentCount: summary.totalIntents,
    netTransferCount: settlements.length,
    totalGrossAmount: summary.totalGrossAmount,
    totalNetAmount: summary.totalNetAmount,
    reductionRatio: summary.reductionRatio,
    settlements,
  };

  console.log(`[Batcher] Batch ${batchId} ${result.status}: ${settlements.length} net transfers executed (${successCount} ok, ${failCount} failed)`);

  return result;
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

async function settleNetPosition(
  supabase: SupabaseClient,
  tenantId: string,
  sourceWalletId: string,
  destWalletId: string,
  amount: number,
  batchId: string,
  environment: 'test' | 'live' = 'test',
): Promise<{ txHash?: string; settlementType: 'on_chain' | 'ledger'; transferId?: string }> {
  // Fetch wallet details
  const { data: wallets } = await supabase
    .from('wallets')
    .select('id, wallet_address, wallet_type, provider_wallet_id, balance, owner_account_id')
    .in('id', [sourceWalletId, destWalletId])
    .eq('tenant_id', tenantId)
    .eq('environment', environment);

  if (!wallets || wallets.length < 2) {
    throw new Error(`Wallets not found for net position ${sourceWalletId} → ${destWalletId}`);
  }

  const srcWallet = wallets.find((w: any) => w.id === sourceWalletId) as SettlementWallet;
  const dstWallet = wallets.find((w: any) => w.id === destWalletId) as SettlementWallet;

  if (!srcWallet || !dstWallet) {
    throw new Error('Source or destination wallet not found');
  }

  // Create a net transfer record
  const { data: transfer, error: txErr } = await supabase
    .from('transfers')
    .insert({
      tenant_id: tenantId,
      environment,
      from_account_id: srcWallet.owner_account_id,
      to_account_id: dstWallet.owner_account_id,
      amount,
      currency: 'USDC',
      type: 'internal',
      status: 'processing',
      initiated_by_type: 'system',
      initiated_by_id: 'batch-settlement-worker',
      description: `Batch net settlement (${batchId})`,
      protocol_metadata: {
        settlement_type: 'batch_net',
        batch_id: batchId,
        source_wallet_id: sourceWalletId,
        destination_wallet_id: destWalletId,
      },
    })
    .select('id')
    .single();

  if (txErr || !transfer) {
    throw new Error(`Failed to create net transfer: ${txErr?.message}`);
  }

  // Attempt on-chain settlement
  let txHash: string | undefined;
  let settlementType: 'on_chain' | 'ledger' = 'ledger';

  if (isOnChainCapable(srcWallet, dstWallet.wallet_address)) {
    const onChainResult = await executeOnChainTransfer({
      sourceWallet: srcWallet,
      destinationAddress: dstWallet.wallet_address,
      amount,
      tenantId,
    });

    if (onChainResult.success && onChainResult.txHash) {
      txHash = onChainResult.txHash;
      settlementType = 'on_chain';
    }
    // If on-chain fails, ledger settlement from the intents is still valid
  }

  // Update transfer record
  await supabase
    .from('transfers')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
      tx_hash: txHash || null,
      protocol_metadata: {
        settlement_type: settlementType === 'on_chain' ? 'batch_net_on_chain' : 'batch_net_ledger',
        batch_id: batchId,
        tx_hash: txHash,
        source_wallet_id: sourceWalletId,
        destination_wallet_id: destWalletId,
      },
    })
    .eq('id', transfer.id);

  return { txHash, settlementType, transferId: transfer.id };
}

async function markIntentsSettled(
  supabase: SupabaseClient,
  tenantId: string,
  intentIds: string[],
  batchId: string,
  transferId?: string,
): Promise<void> {
  if (intentIds.length === 0) return;

  await supabase
    .from('payment_intents')
    .update({
      status: 'settled',
      settled_transfer_id: transferId || null,
      settled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('tenant_id', tenantId)
    .eq('batch_id', batchId)
    .in('id', intentIds);
}
