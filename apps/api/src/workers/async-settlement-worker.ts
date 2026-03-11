/**
 * Async Settlement Worker (Epic 38, Story 38.1)
 *
 * Polls for transfers with status='authorized' (ledger settled, on-chain pending)
 * and executes on-chain settlement via Circle or viem.
 *
 * This decouples the payment response from on-chain confirmation,
 * reducing x402/A2A response latency from 2-30s to <200ms.
 */

import { createClient } from '../db/client.js';
import { executeOnChainTransfer, isOnChainCapable } from '../services/wallet-settlement.js';

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const MAX_RETRIES = 3;
const BATCH_SIZE = 50;

export class AsyncSettlementWorker {
  private isRunning = false;
  private intervalId: NodeJS.Timeout | null = null;
  private processing = false;

  start(intervalMs: number = DEFAULT_POLL_INTERVAL_MS): void {
    if (this.isRunning) {
      console.warn('[AsyncSettlement] Worker is already running');
      return;
    }

    this.isRunning = true;
    console.log(`[AsyncSettlement] Started (poll interval: ${intervalMs}ms)`);

    // Run immediately on start
    this.processPendingSettlements().catch(console.error);

    this.intervalId = setInterval(() => {
      this.processPendingSettlements().catch(console.error);
    }, intervalMs);
  }

  stop(): void {
    if (!this.isRunning) return;

    this.isRunning = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    console.log('[AsyncSettlement] Worker stopped');
  }

  async processPendingSettlements(): Promise<void> {
    // Prevent concurrent processing
    if (this.processing) return;
    this.processing = true;

    try {
      const supabase = createClient();

      // Fetch transfers that are ledger-authorized but not yet on-chain settled
      const { data: transfers, error } = await supabase
        .from('transfers')
        .select(`
          id,
          tenant_id,
          amount,
          from_account_id,
          to_account_id,
          protocol_metadata,
          type
        `)
        .eq('status', 'authorized')
        .order('created_at', { ascending: true })
        .limit(BATCH_SIZE);

      if (error) {
        console.error('[AsyncSettlement] Error fetching authorized transfers:', error.message);
        return;
      }

      if (!transfers || transfers.length === 0) return;

      console.log(`[AsyncSettlement] Processing ${transfers.length} authorized transfer(s)`);

      for (const transfer of transfers) {
        try {
          await this.settleTransfer(supabase, transfer);
        } catch (err: any) {
          console.error(`[AsyncSettlement] Error settling transfer ${transfer.id}:`, err.message);
          // Continue with other transfers
        }
      }
    } finally {
      this.processing = false;
    }
  }

  private async settleTransfer(supabase: any, transfer: any): Promise<void> {
    const metadata = transfer.protocol_metadata || {};
    const retryCount = metadata.async_settlement_retries || 0;

    // Get source and destination wallet info
    const walletIds = [metadata.wallet_id, metadata.provider_wallet_id].filter(Boolean);
    if (walletIds.length < 2) {
      // No wallet IDs in metadata — mark as completed (ledger-only settlement is sufficient)
      await supabase
        .from('transfers')
        .update({
          status: 'completed',
          completed_at: new Date().toISOString(),
          protocol_metadata: {
            ...metadata,
            settlement_type: 'ledger',
            async_settlement_note: 'No on-chain wallets, ledger settlement is final',
          },
        })
        .eq('id', transfer.id);
      return;
    }

    // Fetch wallet details
    const { data: wallets } = await supabase
      .from('wallets')
      .select('id, wallet_address, wallet_type, provider_wallet_id, balance, owner_account_id')
      .in('id', walletIds);

    if (!wallets || wallets.length < 2) {
      // Wallets not found — mark as completed with ledger settlement
      await supabase
        .from('transfers')
        .update({
          status: 'completed',
          completed_at: new Date().toISOString(),
          protocol_metadata: {
            ...metadata,
            settlement_type: 'ledger',
            async_settlement_note: 'Wallets not found for on-chain, ledger is final',
          },
        })
        .eq('id', transfer.id);
      return;
    }

    const sourceWallet = wallets.find((w: any) => w.id === metadata.wallet_id);
    const destWallet = wallets.find((w: any) => w.id === metadata.provider_wallet_id);

    if (!sourceWallet || !destWallet) {
      await supabase
        .from('transfers')
        .update({
          status: 'completed',
          completed_at: new Date().toISOString(),
          protocol_metadata: { ...metadata, settlement_type: 'ledger' },
        })
        .eq('id', transfer.id);
      return;
    }

    // Check if on-chain settlement is possible
    if (!isOnChainCapable(sourceWallet, destWallet.wallet_address)) {
      // No on-chain capability — ledger settlement is the final state
      await supabase
        .from('transfers')
        .update({
          status: 'completed',
          completed_at: new Date().toISOString(),
          protocol_metadata: { ...metadata, settlement_type: 'ledger' },
        })
        .eq('id', transfer.id);
      return;
    }

    // Mark as processing to prevent re-pickup
    await supabase
      .from('transfers')
      .update({
        status: 'processing',
        protocol_metadata: {
          ...metadata,
          async_settlement_started_at: new Date().toISOString(),
          async_settlement_retries: retryCount,
        },
      })
      .eq('id', transfer.id);

    // Attempt on-chain settlement
    const onChainResult = await executeOnChainTransfer({
      sourceWallet,
      destinationAddress: destWallet.wallet_address,
      amount: transfer.amount,
    });

    if (onChainResult.success && onChainResult.txHash) {
      // Sync balances from Circle if applicable
      const isCircleSrc = sourceWallet.wallet_type === 'circle_custodial';
      const isCircleDest = destWallet.wallet_type === 'circle_custodial';

      if (isCircleSrc || isCircleDest) {
        try {
          const { getCircleClient } = await import('../services/circle/client.js');
          const circle = getCircleClient();

          if (isCircleSrc && sourceWallet.provider_wallet_id) {
            const bal = await circle.getUsdcBalance(sourceWallet.provider_wallet_id);
            await supabase
              .from('wallets')
              .update({ balance: bal.formatted, last_synced_at: new Date().toISOString(), updated_at: new Date().toISOString() })
              .eq('id', sourceWallet.id);
          }

          if (isCircleDest && destWallet.provider_wallet_id) {
            const bal = await circle.getUsdcBalance(destWallet.provider_wallet_id);
            await supabase
              .from('wallets')
              .update({ balance: bal.formatted, last_synced_at: new Date().toISOString(), updated_at: new Date().toISOString() })
              .eq('id', destWallet.id);
          }
        } catch (syncErr: any) {
          console.warn(`[AsyncSettlement] Post-settlement balance sync failed: ${syncErr.message}`);
        }
      }

      // Mark transfer as completed with on-chain proof
      await supabase
        .from('transfers')
        .update({
          status: 'completed',
          completed_at: new Date().toISOString(),
          tx_hash: onChainResult.txHash,
          protocol_metadata: {
            ...metadata,
            settlement_type: 'on_chain',
            tx_hash: onChainResult.txHash,
            async_settlement_completed_at: new Date().toISOString(),
            async_settlement_retries: retryCount,
          },
        })
        .eq('id', transfer.id);

      console.log(`[AsyncSettlement] Settled transfer ${transfer.id} on-chain: tx=${onChainResult.txHash}`);
    } else {
      // On-chain settlement failed
      if (retryCount >= MAX_RETRIES - 1) {
        // Max retries reached — mark as completed with ledger-only settlement
        console.warn(`[AsyncSettlement] Max retries reached for ${transfer.id}, marking ledger-final`);
        await supabase
          .from('transfers')
          .update({
            status: 'completed',
            completed_at: new Date().toISOString(),
            protocol_metadata: {
              ...metadata,
              settlement_type: 'ledger',
              async_settlement_failed: true,
              async_settlement_error: onChainResult.error,
              async_settlement_retries: retryCount + 1,
            },
          })
          .eq('id', transfer.id);
      } else {
        // Put back to authorized for retry
        await supabase
          .from('transfers')
          .update({
            status: 'authorized',
            protocol_metadata: {
              ...metadata,
              async_settlement_last_error: onChainResult.error,
              async_settlement_retries: retryCount + 1,
            },
          })
          .eq('id', transfer.id);
        console.warn(`[AsyncSettlement] On-chain failed for ${transfer.id} (retry ${retryCount + 1}/${MAX_RETRIES}): ${onChainResult.error}`);
      }
    }
  }
}

// Singleton
let workerInstance: AsyncSettlementWorker | null = null;

export function getAsyncSettlementWorker(): AsyncSettlementWorker {
  if (!workerInstance) {
    workerInstance = new AsyncSettlementWorker();
  }
  return workerInstance;
}
