/**
 * Batch Transfer Processor (Epic 27, Story 27.2)
 * 
 * Enables partners to submit multiple transfers in a single request,
 * optimizing for payroll and procurement use cases.
 * 
 * Features:
 * - Support up to 1000 transfers per batch
 * - Atomic validation before processing
 * - Per-transfer error tracking with partial success
 * - CSV upload support
 * - Webhook notifications for batch completion
 */

import { createClient } from '../db/client.js';
import { SupabaseClient } from '@supabase/supabase-js';
import { createSettlementRouter, Protocol, SettlementRequest } from './settlement-router.js';
import { createBalanceService } from './balances.js';
import { parse as csvParse } from 'csv-parse/sync';

// ============================================
// Types & Interfaces
// ============================================

export type BatchStatus = 
  | 'pending'
  | 'validating'
  | 'processing'
  | 'completed'
  | 'completed_with_errors'
  | 'failed'
  | 'cancelled';

export type BatchItemStatus = 
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'skipped';

export interface BatchTransferItem {
  fromAccountId: string;
  toAccountId: string;
  amount: number;
  currency?: string;
  destinationCurrency?: string;
  description?: string;
  reference?: string;
  metadata?: Record<string, any>;
}

export interface CreateBatchRequest {
  tenantId: string;
  name?: string;
  description?: string;
  type?: 'payout' | 'payroll' | 'procurement' | 'refund';
  items: BatchTransferItem[];
  webhookUrl?: string;
  idempotencyKey?: string;
  createdBy: {
    type: 'user' | 'api_key' | 'agent';
    id?: string;
    name?: string;
  };
  environment?: 'test' | 'live';
}

export interface BatchResponse {
  id: string;
  status: BatchStatus;
  name?: string;
  type: string;
  totalItems: number;
  pendingItems: number;
  processingItems: number;
  completedItems: number;
  failedItems: number;
  totalAmount: number;
  totalFees: number;
  currency: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  webhookUrl?: string;
}

export interface BatchItemResponse {
  id: string;
  sequenceNumber: number;
  fromAccountId: string;
  toAccountId: string;
  amount: number;
  currency: string;
  status: BatchItemStatus;
  transferId?: string;
  validationErrors?: string[];
  feeAmount?: number;
  netAmount?: number;
  settlementRail?: string;
  processedAt?: string;
  failedAt?: string;
  failureReason?: string;
}

export interface ValidationResult {
  isValid: boolean;
  errors: Array<{
    sequenceNumber: number;
    field: string;
    message: string;
  }>;
  validItems: number;
  invalidItems: number;
}

// ============================================
// Constants
// ============================================

const MAX_BATCH_SIZE = 1000;
const MIN_BATCH_SIZE = 1;
const PROCESSING_BATCH_SIZE = 50; // Process in chunks of 50

// ============================================
// Batch Processor Service
// ============================================

export class BatchProcessor {
  private supabase: SupabaseClient;
  private settlementRouter: ReturnType<typeof createSettlementRouter>;

  constructor(supabase?: SupabaseClient) {
    this.supabase = supabase || createClient();
    this.settlementRouter = createSettlementRouter(this.supabase);
  }

  /**
   * Create a new batch transfer
   */
  async createBatch(request: CreateBatchRequest): Promise<BatchResponse> {
    // Validate batch size
    if (request.items.length < MIN_BATCH_SIZE) {
      throw new Error(`Batch must contain at least ${MIN_BATCH_SIZE} item`);
    }
    if (request.items.length > MAX_BATCH_SIZE) {
      throw new Error(`Batch cannot exceed ${MAX_BATCH_SIZE} items`);
    }

    // Check idempotency
    if (request.idempotencyKey) {
      const existing = await this.getBatchByIdempotencyKey(
        request.tenantId,
        request.idempotencyKey
      );
      if (existing) {
        return existing;
      }
    }

    // Calculate totals
    const totalAmount = request.items.reduce((sum, item) => sum + item.amount, 0);
    const currency = request.items[0]?.currency || 'USDC';

    // Create batch record
    const { data: batch, error: batchError } = await this.supabase
      .from('transfer_batches')
      .insert({
        tenant_id: request.tenantId,
        environment: request.environment || 'test',
        name: request.name,
        description: request.description,
        type: request.type || 'payout',
        status: 'pending',
        total_items: request.items.length,
        pending_items: request.items.length,
        total_amount: totalAmount,
        currency,
        webhook_url: request.webhookUrl,
        idempotency_key: request.idempotencyKey,
        created_by_type: request.createdBy.type,
        created_by_id: request.createdBy.id,
        created_by_name: request.createdBy.name,
      })
      .select()
      .single();

    if (batchError || !batch) {
      throw new Error(`Failed to create batch: ${batchError?.message}`);
    }

    // Create batch items
    const items = request.items.map((item, index) => ({
      batch_id: batch.id,
      tenant_id: request.tenantId,
      environment: request.environment || 'test',
      sequence_number: index + 1,
      from_account_id: item.fromAccountId,
      to_account_id: item.toAccountId,
      amount: item.amount,
      currency: item.currency || currency,
      destination_currency: item.destinationCurrency,
      description: item.description,
      reference: item.reference,
      metadata: item.metadata || {},
      status: 'pending',
    }));

    const { error: itemsError } = await this.supabase
      .from('transfer_batch_items')
      .insert(items);

    if (itemsError) {
      // Rollback batch creation
      await this.supabase.from('transfer_batches').delete().eq('id', batch.id);
      throw new Error(`Failed to create batch items: ${itemsError.message}`);
    }

    return this.mapBatchResponse(batch);
  }

  /**
   * Validate all items in a batch before processing
   */
  async validateBatch(batchId: string, tenantId: string): Promise<ValidationResult> {
    // Update batch status
    await this.updateBatchStatus(batchId, 'validating');

    // Get all batch items
    const { data: items, error } = await this.supabase
      .from('transfer_batch_items')
      .select('*')
      .eq('batch_id', batchId)
      .order('sequence_number');

    if (error || !items) {
      throw new Error(`Failed to fetch batch items: ${error?.message}`);
    }

    const errors: ValidationResult['errors'] = [];
    let validItems = 0;
    let invalidItems = 0;

    // Get all unique account IDs
    const accountIds = new Set<string>();
    items.forEach(item => {
      accountIds.add(item.from_account_id);
      accountIds.add(item.to_account_id);
    });

    // Fetch all accounts in one query
    const { data: accounts, error: accountsError } = await this.supabase
      .from('accounts')
      .select('id, balance_available, verification_status, name')
      .eq('tenant_id', tenantId)
      .in('id', Array.from(accountIds));

    if (accountsError) {
      console.error('Error fetching accounts for validation:', accountsError);
    }

    const accountMap = new Map(accounts?.map(a => [a.id, a]) || []);

    // Validate each item
    for (const item of items) {
      const itemErrors: string[] = [];

      // Validate from account
      const fromAccount = accountMap.get(item.from_account_id);
      if (!fromAccount) {
        itemErrors.push(`Source account ${item.from_account_id} not found`);
      } else if (fromAccount.verification_status === 'rejected') {
        itemErrors.push(`Source account verification was rejected`);
      }

      // Validate to account
      const toAccount = accountMap.get(item.to_account_id);
      if (!toAccount) {
        itemErrors.push(`Destination account ${item.to_account_id} not found`);
      } else if (toAccount.verification_status === 'rejected') {
        itemErrors.push(`Destination account verification was rejected`);
      }

      // Validate amount
      if (item.amount <= 0) {
        itemErrors.push('Amount must be positive');
      }

      // Validate same account
      if (item.from_account_id === item.to_account_id) {
        itemErrors.push('Source and destination accounts cannot be the same');
      }

      // Update item validation status
      const isValid = itemErrors.length === 0;
      await this.supabase
        .from('transfer_batch_items')
        .update({
          validation_errors: itemErrors,
          is_valid: isValid,
          status: isValid ? 'pending' : 'skipped',
        })
        .eq('id', item.id);

      if (isValid) {
        validItems++;
      } else {
        invalidItems++;
        errors.push(...itemErrors.map(msg => ({
          sequenceNumber: item.sequence_number,
          field: 'general',
          message: msg,
        })));
      }
    }

    // Update batch status based on validation
    if (invalidItems === items.length) {
      await this.updateBatchStatus(batchId, 'failed', 'All items failed validation');
    } else {
      await this.updateBatchStatus(batchId, 'pending');
    }

    return {
      isValid: invalidItems === 0,
      errors,
      validItems,
      invalidItems,
    };
  }

  /**
   * Process all valid items in a batch
   */
  async processBatch(batchId: string, tenantId: string): Promise<BatchResponse> {
    // Update status to processing
    await this.updateBatchStatus(batchId, 'processing');
    await this.supabase
      .from('transfer_batches')
      .update({ started_at: new Date().toISOString() })
      .eq('id', batchId);

    // Get valid pending items
    const { data: items, error } = await this.supabase
      .from('transfer_batch_items')
      .select('*')
      .eq('batch_id', batchId)
      .eq('status', 'pending')
      .eq('is_valid', true)
      .order('sequence_number');

    if (error || !items) {
      await this.updateBatchStatus(batchId, 'failed', `Failed to fetch items: ${error?.message}`);
      throw new Error(`Failed to fetch batch items: ${error?.message}`);
    }

    // Process in chunks
    for (let i = 0; i < items.length; i += PROCESSING_BATCH_SIZE) {
      const chunk = items.slice(i, i + PROCESSING_BATCH_SIZE);
      await this.processChunk(chunk, tenantId);
    }

    // Get final batch state
    const batch = await this.getBatch(batchId, tenantId);
    
    // Send webhook notification
    if (batch?.webhookUrl) {
      await this.sendWebhookNotification(batch);
    }

    return batch!;
  }

  /**
   * Process a chunk of batch items
   */
  private async processChunk(items: any[], tenantId: string): Promise<void> {
    const balanceService = createBalanceService(this.supabase);

    for (const item of items) {
      try {
        // Mark as processing
        await this.supabase
          .from('transfer_batch_items')
          .update({ status: 'processing' })
          .eq('id', item.id);

        // Check balance (aggregate check would be more efficient but simpler per-item)
        const { data: fromAccount } = await this.supabase
          .from('accounts')
          .select('balance_available')
          .eq('id', item.from_account_id)
          .single();

        const availableBalance = parseFloat(fromAccount?.balance_available || '0');
        if (availableBalance < item.amount) {
          throw new Error(`Insufficient balance: ${availableBalance} < ${item.amount}`);
        }

        // Get account names for transfer record
        const { data: fromAccountData } = await this.supabase
          .from('accounts')
          .select('name')
          .eq('id', item.from_account_id)
          .single();
        const { data: toAccountData } = await this.supabase
          .from('accounts')
          .select('name')
          .eq('id', item.to_account_id)
          .single();

        // Create transfer
        const { data: transfer, error: transferError } = await this.supabase
          .from('transfers')
          .insert({
            tenant_id: tenantId,
            type: 'internal',
            status: 'pending',
            from_account_id: item.from_account_id,
            from_account_name: fromAccountData?.name || 'Unknown',
            to_account_id: item.to_account_id,
            to_account_name: toAccountData?.name || 'Unknown',
            amount: item.amount,
            currency: item.currency,
            destination_currency: item.destination_currency || item.currency,
            description: item.description,
            initiated_by_type: 'api_key',
            initiated_by_id: item.batch_id, // Use batch ID as initiator
            initiated_by_name: 'Batch Transfer',
            protocol_metadata: {
              batch_id: item.batch_id,
              sequence_number: item.sequence_number,
              reference: item.reference,
            },
          })
          .select()
          .single();

        if (transferError || !transfer) {
          throw new Error(`Failed to create transfer: ${transferError?.message}`);
        }

        // Execute balance transfer
        await balanceService.transfer(
          item.from_account_id,
          item.to_account_id,
          item.amount,
          'batch_transfer',
          transfer.id,
          item.description || `Batch transfer #${item.sequence_number}`
        );

        // Update transfer status
        await this.supabase
          .from('transfers')
          .update({
            status: 'completed',
            completed_at: new Date().toISOString(),
          })
          .eq('id', transfer.id);

        // Update batch item
        await this.supabase
          .from('transfer_batch_items')
          .update({
            status: 'completed',
            transfer_id: transfer.id,
            fee_amount: 0, // Internal transfers have no fee in this implementation
            net_amount: item.amount,
            settlement_rail: 'internal',
            processed_at: new Date().toISOString(),
          })
          .eq('id', item.id);

      } catch (error: any) {
        // Mark item as failed
        await this.supabase
          .from('transfer_batch_items')
          .update({
            status: 'failed',
            failed_at: new Date().toISOString(),
            failure_reason: error.message,
          })
          .eq('id', item.id);

        console.error(`Batch item ${item.id} failed:`, error.message);
      }
    }
  }

  /**
   * Get batch details
   */
  async getBatch(batchId: string, tenantId: string): Promise<BatchResponse | null> {
    const { data, error } = await this.supabase
      .from('transfer_batches')
      .select('*')
      .eq('id', batchId)
      .eq('tenant_id', tenantId)
      .single();

    if (error || !data) {
      return null;
    }

    return this.mapBatchResponse(data);
  }

  /**
   * Get batch by idempotency key
   */
  async getBatchByIdempotencyKey(tenantId: string, key: string): Promise<BatchResponse | null> {
    const { data, error } = await this.supabase
      .from('transfer_batches')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('idempotency_key', key)
      .single();

    if (error || !data) {
      return null;
    }

    return this.mapBatchResponse(data);
  }

  /**
   * List batches for a tenant
   */
  async listBatches(
    tenantId: string,
    options: {
      status?: BatchStatus;
      type?: string;
      page?: number;
      limit?: number;
    } = {}
  ): Promise<{ data: BatchResponse[]; total: number }> {
    const page = options.page || 1;
    const limit = Math.min(options.limit || 20, 100);
    const offset = (page - 1) * limit;

    let query = this.supabase
      .from('transfer_batches')
      .select('*', { count: 'exact' })
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (options.status) {
      query = query.eq('status', options.status);
    }
    if (options.type) {
      query = query.eq('type', options.type);
    }

    const { data, count, error } = await query;

    if (error) {
      throw new Error(`Failed to list batches: ${error.message}`);
    }

    return {
      data: (data || []).map(this.mapBatchResponse),
      total: count || 0,
    };
  }

  /**
   * Get items in a batch
   */
  async getBatchItems(
    batchId: string,
    tenantId: string,
    options: {
      status?: BatchItemStatus;
      page?: number;
      limit?: number;
    } = {}
  ): Promise<{ data: BatchItemResponse[]; total: number }> {
    const page = options.page || 1;
    const limit = Math.min(options.limit || 50, 100);
    const offset = (page - 1) * limit;

    // First verify batch belongs to tenant
    const { data: batch } = await this.supabase
      .from('transfer_batches')
      .select('id')
      .eq('id', batchId)
      .eq('tenant_id', tenantId)
      .single();

    if (!batch) {
      throw new Error('Batch not found');
    }

    let query = this.supabase
      .from('transfer_batch_items')
      .select('*', { count: 'exact' })
      .eq('batch_id', batchId)
      .order('sequence_number')
      .range(offset, offset + limit - 1);

    if (options.status) {
      query = query.eq('status', options.status);
    }

    const { data, count, error } = await query;

    if (error) {
      throw new Error(`Failed to list batch items: ${error.message}`);
    }

    return {
      data: (data || []).map(this.mapItemResponse),
      total: count || 0,
    };
  }

  /**
   * Retry failed items in a batch
   */
  async retryFailedItems(batchId: string, tenantId: string): Promise<BatchResponse> {
    // Reset failed items to pending
    await this.supabase
      .from('transfer_batch_items')
      .update({
        status: 'pending',
        failure_reason: null,
        failed_at: null,
      })
      .eq('batch_id', batchId)
      .eq('status', 'failed');

    // Re-process
    return this.processBatch(batchId, tenantId);
  }

  /**
   * Cancel a batch (only if not yet processing)
   */
  async cancelBatch(batchId: string, tenantId: string): Promise<BatchResponse> {
    const batch = await this.getBatch(batchId, tenantId);

    if (!batch) {
      throw new Error('Batch not found');
    }

    if (!['pending', 'validating'].includes(batch.status)) {
      throw new Error(`Cannot cancel batch with status: ${batch.status}`);
    }

    await this.updateBatchStatus(batchId, 'cancelled');

    // Mark all pending items as skipped
    await this.supabase
      .from('transfer_batch_items')
      .update({ status: 'skipped' })
      .eq('batch_id', batchId)
      .eq('status', 'pending');

    return (await this.getBatch(batchId, tenantId))!;
  }

  /**
   * Parse CSV file into batch items
   */
  parseCSV(csvContent: string): BatchTransferItem[] {
    const records = csvParse(csvContent, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });

    return records.map((record: any) => ({
      fromAccountId: record.from_account_id || record.fromAccountId || record.source,
      toAccountId: record.to_account_id || record.toAccountId || record.destination,
      amount: parseFloat(record.amount),
      currency: record.currency || 'USDC',
      destinationCurrency: record.destination_currency || record.destinationCurrency,
      description: record.description || record.memo,
      reference: record.reference || record.invoice_id || record.external_id,
      metadata: record.metadata ? JSON.parse(record.metadata) : undefined,
    }));
  }

  // ============================================
  // Helper Methods
  // ============================================

  private async updateBatchStatus(
    batchId: string,
    status: BatchStatus,
    failureReason?: string
  ): Promise<void> {
    const update: any = { status, updated_at: new Date().toISOString() };
    
    if (failureReason) {
      update.failure_reason = failureReason;
      update.failed_at = new Date().toISOString();
    }

    await this.supabase
      .from('transfer_batches')
      .update(update)
      .eq('id', batchId);
  }

  private async sendWebhookNotification(batch: BatchResponse): Promise<void> {
    if (!batch.webhookUrl) return;

    try {
      const response = await fetch(batch.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'batch.completed',
          data: batch,
          timestamp: new Date().toISOString(),
        }),
      });

      if (response.ok) {
        await this.supabase
          .from('transfer_batches')
          .update({ webhook_delivered_at: new Date().toISOString() })
          .eq('id', batch.id);
      }
    } catch (error) {
      console.error(`Failed to send batch webhook to ${batch.webhookUrl}:`, error);
    }
  }

  private mapBatchResponse(data: any): BatchResponse {
    return {
      id: data.id,
      status: data.status,
      name: data.name,
      type: data.type,
      totalItems: data.total_items,
      pendingItems: data.pending_items,
      processingItems: data.processing_items,
      completedItems: data.completed_items,
      failedItems: data.failed_items,
      totalAmount: parseFloat(data.total_amount),
      totalFees: parseFloat(data.total_fees || 0),
      currency: data.currency,
      createdAt: data.created_at,
      startedAt: data.started_at,
      completedAt: data.completed_at,
      webhookUrl: data.webhook_url,
    };
  }

  private mapItemResponse(data: any): BatchItemResponse {
    return {
      id: data.id,
      sequenceNumber: data.sequence_number,
      fromAccountId: data.from_account_id,
      toAccountId: data.to_account_id,
      amount: parseFloat(data.amount),
      currency: data.currency,
      status: data.status,
      transferId: data.transfer_id,
      validationErrors: data.validation_errors,
      feeAmount: data.fee_amount ? parseFloat(data.fee_amount) : undefined,
      netAmount: data.net_amount ? parseFloat(data.net_amount) : undefined,
      settlementRail: data.settlement_rail,
      processedAt: data.processed_at,
      failedAt: data.failed_at,
      failureReason: data.failure_reason,
    };
  }
}

// ============================================
// Factory Function
// ============================================

export function createBatchProcessor(supabase?: SupabaseClient): BatchProcessor {
  return new BatchProcessor(supabase);
}

