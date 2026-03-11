/**
 * Centralized Wallet Settlement Service
 *
 * Provides two layers:
 * 1. executeOnChainTransfer() — pure on-chain execution (Circle or viem), no DB
 * 2. settleWalletTransfer() — full orchestrator: on-chain + ledger + transfer update
 *
 * Eliminates duplication across A2A payment-handler, A2A task-processor,
 * x402-payments, and wallet transfer endpoint.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal wallet shape needed for settlement */
export interface SettlementWallet {
  id: string;
  wallet_address: string;
  wallet_type: string | null;
  provider_wallet_id: string | null;
  balance: string | number;
  owner_account_id: string;
}

export interface OnChainTransferParams {
  sourceWallet: SettlementWallet;
  destinationAddress: string;
  amount: number;
}

export interface OnChainTransferResult {
  success: boolean;
  txHash?: string;
  error?: string;
  path: 'circle' | 'viem' | 'solana' | 'skipped';
}

export interface SettleWalletTransferParams {
  supabase: SupabaseClient;
  tenantId: string;
  sourceWallet: SettlementWallet;
  destinationWallet: SettlementWallet | null;
  amount: number;
  transferId: string;
  protocolMetadata?: Record<string, unknown>;
}

export interface SettleWalletTransferResult {
  success: boolean;
  txHash?: string;
  settlementType: 'on_chain' | 'ledger';
  error?: string;
  sourceNewBalance?: number;
  destinationNewBalance?: number;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/**
 * Check whether a source wallet can do on-chain settlement to a destination.
 * Requires: circle_custodial wallet with provider_wallet_id, valid dest address,
 * and sandbox environment.
 */
export function isOnChainCapable(
  sourceWallet: Pick<SettlementWallet, 'wallet_type' | 'provider_wallet_id'>,
  destinationAddress: string | null | undefined,
): boolean {
  const srcType = sourceWallet.wallet_type || 'internal';
  const isSandbox = process.env.PAYOS_ENVIRONMENT === 'sandbox';
  const hasValidDest = !!destinationAddress && !destinationAddress.startsWith('internal://');

  if (!isSandbox || !hasValidDest) return false;

  if (srcType === 'circle_custodial' && sourceWallet.provider_wallet_id) return true;
  if (srcType === 'external') return true;

  return false;
}

// ---------------------------------------------------------------------------
// Layer 1: Pure on-chain transfer (no DB)
// ---------------------------------------------------------------------------

/**
 * Execute an on-chain transfer via Circle or viem.
 * Never throws — all errors captured in result.
 * Returns `{ path: 'skipped' }` if environment/wallet doesn't support on-chain.
 */
export async function executeOnChainTransfer(
  params: OnChainTransferParams,
): Promise<OnChainTransferResult> {
  const { sourceWallet, destinationAddress, amount } = params;
  const srcType = sourceWallet.wallet_type || 'internal';
  const isSandbox = process.env.PAYOS_ENVIRONMENT === 'sandbox';

  if (!isSandbox) {
    return { success: false, path: 'skipped' };
  }

  if (!destinationAddress || destinationAddress.startsWith('internal://')) {
    return { success: false, path: 'skipped', error: 'Destination has no on-chain address' };
  }

  try {
    // Circle custodial path
    if (srcType === 'circle_custodial' && sourceWallet.provider_wallet_id) {
      const { getCircleClient } = await import('./circle/client.js');
      const circle = getCircleClient();

      // Resolve the correct USDC token ID for this wallet's chain
      // Each blockchain has a different Circle token ID for USDC
      let usdcTokenId = process.env.CIRCLE_USDC_TOKEN_ID;
      try {
        const balances = await circle.getWalletBalances(sourceWallet.provider_wallet_id);
        const usdcToken = balances.find(b => b.token.symbol === 'USDC');
        if (usdcToken) {
          usdcTokenId = usdcToken.token.id;
        }
      } catch {
        // Fall back to env var
      }

      if (!usdcTokenId) {
        return { success: false, path: 'circle', error: 'Could not resolve USDC token ID for wallet' };
      }

      const circleTx = await circle.transferTokens(
        sourceWallet.provider_wallet_id,
        usdcTokenId,
        destinationAddress,
        amount.toString(),
        'MEDIUM',
      );

      // Poll for completion (max 30s, 2s interval)
      // Circle uses CONFIRMED as terminal success state (COMPLETE also accepted for compatibility)
      const isTerminal = (s: string) => s === 'CONFIRMED' || s === 'COMPLETE' || s === 'FAILED' || s === 'CANCELLED' || s === 'DENIED';
      const isSuccess = (s: string) => s === 'CONFIRMED' || s === 'COMPLETE';

      const deadline = Date.now() + 30_000;
      let finalTx = circleTx;
      while (!isTerminal(finalTx.state) && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 2000));
        finalTx = await circle.getTransaction(circleTx.id);
      }

      if (!isSuccess(finalTx.state)) {
        const reason = finalTx.state === 'FAILED' ? 'failed' : isTerminal(finalTx.state) ? finalTx.state.toLowerCase() : 'timed out';
        return { success: false, path: 'circle', error: `Circle transfer ${reason}: ${circleTx.id}` };
      }

      const txHash = (finalTx as any).txHash || circleTx.id;
      return { success: true, txHash, path: 'circle' };
    }

    // External wallet path — detect chain from destination address format
    if (srcType === 'external') {
      const { isSolanaAddress } = await import('../config/solana.js');

      if (isSolanaAddress(destinationAddress)) {
        // Solana external wallet path (Story 38.3)
        const { transferSolanaUsdc } = await import('../config/solana.js');
        const result = await transferSolanaUsdc(destinationAddress, amount);
        return { success: true, txHash: result.txHash, path: 'solana' };
      }

      // EVM external wallet path (Base)
      const { transferUsdc } = await import('../config/blockchain.js');
      const result = await transferUsdc(destinationAddress, amount);
      return { success: true, txHash: result.txHash, path: 'viem' };
    }

    // Wallet type doesn't support on-chain
    return { success: false, path: 'skipped' };
  } catch (err: any) {
    const path = srcType === 'circle_custodial' ? 'circle' : srcType === 'external' ? 'viem' : 'skipped';
    return { success: false, path: path as OnChainTransferResult['path'], error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Layer 1.5: Ledger-only authorization (async settlement — Epic 38)
// ---------------------------------------------------------------------------

export interface AuthorizeWalletTransferParams {
  supabase: SupabaseClient;
  tenantId: string;
  sourceWallet: SettlementWallet;
  destinationWallet: SettlementWallet | null;
  amount: number;
  transferId: string;
  protocolMetadata?: Record<string, unknown>;
}

export interface AuthorizeWalletTransferResult {
  success: boolean;
  error?: string;
  sourceNewBalance?: number;
  destinationNewBalance?: number;
}

/**
 * Ledger-only authorization: debit source + credit destination in DB.
 * Does NOT trigger on-chain settlement — that's deferred to the async worker.
 * Marks transfer as 'authorized' (ledger settled, on-chain pending).
 *
 * Returns in <50ms. Used by x402 and A2A for fast payment responses.
 */
export async function authorizeWalletTransfer(
  params: AuthorizeWalletTransferParams,
): Promise<AuthorizeWalletTransferResult> {
  const { supabase, tenantId, sourceWallet, destinationWallet, amount, transferId, protocolMetadata } = params;

  // Atomic debit with .gte() guard to prevent double-spend
  const srcBal = typeof sourceWallet.balance === 'string'
    ? parseFloat(sourceWallet.balance)
    : sourceWallet.balance;
  const newBal = srcBal - amount;

  const { data: debited, error: debitErr } = await supabase
    .from('wallets')
    .update({ balance: newBal, updated_at: new Date().toISOString() })
    .eq('id', sourceWallet.id)
    .eq('tenant_id', tenantId)
    .gte('balance', amount)
    .select('balance')
    .single();

  if (debitErr || !debited) {
    // Mark transfer as failed
    await supabase
      .from('transfers')
      .update({
        status: 'failed',
        protocol_metadata: { ...(protocolMetadata || {}), settlement_type: 'ledger', error: 'Insufficient balance or concurrent debit' },
      })
      .eq('id', transferId)
      .eq('tenant_id', tenantId);
    return { success: false, error: 'Insufficient balance or concurrent debit' };
  }

  const sourceNewBalance = parseFloat(debited.balance);
  let destinationNewBalance: number | undefined;

  if (destinationWallet) {
    const destBalance = typeof destinationWallet.balance === 'string'
      ? parseFloat(destinationWallet.balance)
      : destinationWallet.balance;
    destinationNewBalance = destBalance + amount;

    const { error: creditErr } = await supabase
      .from('wallets')
      .update({ balance: destinationNewBalance, updated_at: new Date().toISOString() })
      .eq('id', destinationWallet.id)
      .eq('tenant_id', tenantId);

    if (creditErr) {
      // Rollback the debit
      console.error(`[Settlement] Credit failed, rolling back debit on ${sourceWallet.id}`);
      await supabase
        .from('wallets')
        .update({ balance: (sourceNewBalance ?? 0) + amount, updated_at: new Date().toISOString() })
        .eq('id', sourceWallet.id)
        .eq('tenant_id', tenantId);
      await supabase
        .from('transfers')
        .update({
          status: 'failed',
          protocol_metadata: { ...(protocolMetadata || {}), settlement_type: 'ledger', error: 'Ledger credit failed (debit rolled back)' },
        })
        .eq('id', transferId)
        .eq('tenant_id', tenantId);
      return { success: false, error: 'Ledger credit failed (debit rolled back)' };
    }
  }

  // Mark transfer as 'authorized' — ledger settled, on-chain pending
  await supabase
    .from('transfers')
    .update({
      status: 'authorized',
      protocol_metadata: {
        ...(protocolMetadata || {}),
        settlement_type: 'ledger',
        authorized_at: new Date().toISOString(),
      },
    })
    .eq('id', transferId)
    .eq('tenant_id', tenantId);

  return { success: true, sourceNewBalance, destinationNewBalance };
}

// ---------------------------------------------------------------------------
// Layer 2: Full settlement orchestrator
// ---------------------------------------------------------------------------

/**
 * Full wallet settlement: on-chain transfer (if capable) + ledger debit/credit
 * + transfer record update.
 *
 * Used by A2A payment-handler and wallet transfer endpoint.
 * NOT used by x402 (needs RPC for fee splitting) or A2A mandate (creates
 * transfer after settlement, uses .gte() guard).
 */
export async function settleWalletTransfer(
  params: SettleWalletTransferParams,
): Promise<SettleWalletTransferResult> {
  const { supabase, tenantId, sourceWallet, destinationWallet, amount, transferId, protocolMetadata } = params;
  const destAddress = destinationWallet?.wallet_address || '';

  let txHash: string | undefined;
  let settlementType: 'on_chain' | 'ledger' = 'ledger';
  const srcType = sourceWallet.wallet_type || 'internal';
  const isCircleSrc = srcType === 'circle_custodial';
  const isCircleDest = destinationWallet?.wallet_type === 'circle_custodial';

  // Helper to mark transfer as failed
  const failTransfer = async (error: string, settlement: 'on_chain' | 'ledger') => {
    await supabase
      .from('transfers')
      .update({
        status: 'failed',
        protocol_metadata: { ...(protocolMetadata || {}), settlement_type: settlement, error },
      })
      .eq('id', transferId)
      .eq('tenant_id', tenantId);
    return { success: false as const, settlementType: settlement, error };
  };

  // 1. Attempt on-chain settlement
  if (isOnChainCapable(sourceWallet, destAddress)) {
    const onChainResult = await executeOnChainTransfer({
      sourceWallet,
      destinationAddress: destAddress,
      amount,
    });

    if (onChainResult.success && onChainResult.txHash) {
      txHash = onChainResult.txHash;
      settlementType = 'on_chain';
    } else if (onChainResult.path !== 'skipped' && onChainResult.error) {
      // Circle custodial wallets must settle on-chain — no ledger fallback
      if (isCircleSrc) {
        console.error(`[Settlement] On-chain failed for Circle wallet (no fallback): ${onChainResult.error}`);
        return failTransfer(onChainResult.error, 'on_chain');
      }
      console.warn(`[Settlement] On-chain failed (falling back to ledger): ${onChainResult.error}`);
    }
  }

  // 2. Ledger settlement — update DB balances
  let sourceNewBalance: number | undefined;
  let destinationNewBalance: number | undefined;

  if (settlementType === 'on_chain' && (isCircleSrc || isCircleDest)) {
    // Circle is source of truth — sync balances from Circle API after on-chain settlement
    try {
      const { getCircleClient } = await import('./circle/client.js');
      const circle = getCircleClient();

      if (isCircleSrc && sourceWallet.provider_wallet_id) {
        const bal = await circle.getUsdcBalance(sourceWallet.provider_wallet_id);
        sourceNewBalance = bal.formatted;
        await supabase
          .from('wallets')
          .update({ balance: sourceNewBalance, last_synced_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq('id', sourceWallet.id)
          .eq('tenant_id', tenantId);
      }

      if (isCircleDest && destinationWallet?.provider_wallet_id) {
        const bal = await circle.getUsdcBalance(destinationWallet.provider_wallet_id);
        destinationNewBalance = bal.formatted;
        await supabase
          .from('wallets')
          .update({ balance: destinationNewBalance, last_synced_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq('id', destinationWallet.id)
          .eq('tenant_id', tenantId);
      }
    } catch (syncErr: any) {
      // Sync failed — fall back to optimistic math so DB isn't stale
      console.warn(`[Settlement] Post-settlement Circle balance sync failed, using optimistic math: ${syncErr.message}`);
      const srcBal = typeof sourceWallet.balance === 'string' ? parseFloat(sourceWallet.balance) : sourceWallet.balance;
      sourceNewBalance = srcBal - amount;
      await supabase
        .from('wallets')
        .update({ balance: sourceNewBalance, updated_at: new Date().toISOString() })
        .eq('id', sourceWallet.id)
        .eq('tenant_id', tenantId);

      if (destinationWallet) {
        const dstBal = typeof destinationWallet.balance === 'string' ? parseFloat(destinationWallet.balance) : destinationWallet.balance;
        destinationNewBalance = dstBal + amount;
        await supabase
          .from('wallets')
          .update({ balance: destinationNewBalance, updated_at: new Date().toISOString() })
          .eq('id', destinationWallet.id)
          .eq('tenant_id', tenantId);
      }
    }
  } else {
    // Non-Circle or ledger-only: atomic debit with .gte() guard to prevent double-spend
    const srcBal = typeof sourceWallet.balance === 'string'
      ? parseFloat(sourceWallet.balance)
      : sourceWallet.balance;
    const newBal = srcBal - amount;

    const { data: debited, error: debitErr } = await supabase
      .from('wallets')
      .update({ balance: newBal, updated_at: new Date().toISOString() })
      .eq('id', sourceWallet.id)
      .eq('tenant_id', tenantId)
      .gte('balance', amount)
      .select('balance')
      .single();

    if (debitErr || !debited) {
      return failTransfer('Insufficient balance or concurrent debit', settlementType);
    }
    sourceNewBalance = parseFloat(debited.balance);

    if (destinationWallet) {
      const destBalance = typeof destinationWallet.balance === 'string'
        ? parseFloat(destinationWallet.balance)
        : destinationWallet.balance;
      destinationNewBalance = destBalance + amount;

      const { error: creditErr } = await supabase
        .from('wallets')
        .update({ balance: destinationNewBalance, updated_at: new Date().toISOString() })
        .eq('id', destinationWallet.id)
        .eq('tenant_id', tenantId);

      if (creditErr) {
        // Rollback the debit
        console.error(`[Settlement] Credit failed, rolling back debit on ${sourceWallet.id}`);
        await supabase
          .from('wallets')
          .update({ balance: (sourceNewBalance ?? 0) + amount, updated_at: new Date().toISOString() })
          .eq('id', sourceWallet.id)
          .eq('tenant_id', tenantId);
        return failTransfer('Ledger credit failed (debit rolled back)', settlementType);
      }
    }
  }

  // 3. Update transfer record
  const updatedMetadata = {
    ...(protocolMetadata || {}),
    settlement_type: settlementType,
    ...(txHash ? { tx_hash: txHash } : {}),
  };

  await supabase
    .from('transfers')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
      tx_hash: txHash || null,
      protocol_metadata: updatedMetadata,
    })
    .eq('id', transferId)
    .eq('tenant_id', tenantId);

  return {
    success: true,
    txHash,
    settlementType,
    sourceNewBalance,
    destinationNewBalance,
  };
}
