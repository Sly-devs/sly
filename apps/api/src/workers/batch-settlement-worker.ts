/**
 * Batch Settlement Worker (Epic 38, Story 38.14)
 *
 * Runs on a configurable schedule (default 60s). For each tenant with
 * authorized payment intents:
 * 1. Computes net positions per wallet pair
 * 2. Creates a settlement batch
 * 3. Executes on-chain transfers for net amounts
 * 4. Marks intents as settled
 *
 * This turns 1000 micro-payments into ~1-5 net on-chain transfers.
 */

import { createClient } from '../db/client.js';
import { createBatch, executeBatch, type BatchResult } from '../services/settlement-batcher.js';

const DEFAULT_INTERVAL_MS = 60_000; // 60 seconds

export class BatchSettlementWorker {
  private isRunning = false;
  private intervalId: NodeJS.Timeout | null = null;
  private processing = false;

  start(intervalMs: number = DEFAULT_INTERVAL_MS): void {
    if (this.isRunning) {
      console.warn('[BatchSettlement] Worker is already running');
      return;
    }

    this.isRunning = true;
    console.log(`[BatchSettlement] Started (interval: ${intervalMs / 1000}s)`);

    // Don't run immediately — wait for intents to accumulate
    this.intervalId = setInterval(() => {
      this.processAllTenants().catch(console.error);
    }, intervalMs);
  }

  stop(): void {
    if (!this.isRunning) return;

    this.isRunning = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    console.log('[BatchSettlement] Worker stopped');
  }

  async processAllTenants(): Promise<BatchResult[]> {
    if (this.processing) return [];
    this.processing = true;

    try {
      const supabase = createClient();
      const results: BatchResult[] = [];

      // Find tenants with authorized intents
      const { data: tenantRows, error } = await supabase
        .from('payment_intents')
        .select('tenant_id')
        .eq('status', 'authorized')
        .limit(100);

      if (error || !tenantRows || tenantRows.length === 0) {
        return [];
      }

      // Deduplicate tenant IDs
      const tenantIds = [...new Set(tenantRows.map((r: any) => r.tenant_id))];

      console.log(`[BatchSettlement] Processing ${tenantIds.length} tenant(s) with authorized intents`);

      for (const tenantId of tenantIds) {
        try {
          const result = await this.processTenant(supabase, tenantId);
          if (result) {
            results.push(result);
          }
        } catch (err: any) {
          console.error(`[BatchSettlement] Error processing tenant ${tenantId}:`, err.message);
        }
      }

      if (results.length > 0) {
        const totalIntents = results.reduce((sum, r) => sum + r.intentCount, 0);
        const totalNetTransfers = results.reduce((sum, r) => sum + r.netTransferCount, 0);
        console.log(`[BatchSettlement] Cycle complete: ${totalIntents} intents → ${totalNetTransfers} net transfers across ${results.length} batch(es)`);
      }

      return results;
    } finally {
      this.processing = false;
    }
  }

  private async processTenant(supabase: any, tenantId: string): Promise<BatchResult | null> {
    // Create batch (groups intents, computes net positions)
    const batchResult = await createBatch(supabase, tenantId);
    if (!batchResult) return null;

    // Execute batch (on-chain transfers for net amounts)
    return executeBatch(supabase, batchResult.batchId, tenantId, batchResult.summary);
  }
}

// Singleton
let workerInstance: BatchSettlementWorker | null = null;

export function getBatchSettlementWorker(): BatchSettlementWorker {
  if (!workerInstance) {
    workerInstance = new BatchSettlementWorker();
  }
  return workerInstance;
}
