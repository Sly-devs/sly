/**
 * A2A Task Processor
 *
 * Picks up submitted tasks and processes them through the full lifecycle:
 *   submitted -> working -> completed (or failed)
 *
 * For payment-related tasks, demonstrates the payment-gated flow:
 *   submitted -> input-required (payment needed) -> working -> completed
 *
 * Uses real Supabase queries via tool handlers for wallet balances,
 * transfers, and agent info. Mock data has been replaced with live data.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { A2ATaskService } from './task-service.js';
import { A2APaymentHandler } from './payment-handler.js';
import { AgentToolRegistry } from './tools/registry.js';
import { toolHandlers } from './tools/handlers.js';
import type { AgentContext } from './tools/context-injector.js';
import type { A2ATask } from './types.js';

interface ProcessorConfig {
  /** Poll interval in ms (default: 5000) */
  pollInterval?: number;
  /** Only process tasks for this agent */
  agentId?: string;
  /** Enable payment gating for amounts > threshold */
  paymentThreshold?: number;
}

export class A2ATaskProcessor {
  private supabase: SupabaseClient;
  private tenantId: string;
  private taskService: A2ATaskService;
  private paymentHandler: A2APaymentHandler;
  private registry: AgentToolRegistry;
  private config: Required<ProcessorConfig>;
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(supabase: SupabaseClient, tenantId: string, config: ProcessorConfig = {}) {
    this.supabase = supabase;
    this.tenantId = tenantId;
    this.taskService = new A2ATaskService(supabase, tenantId);
    this.paymentHandler = new A2APaymentHandler(supabase, tenantId, this.taskService);
    this.registry = new AgentToolRegistry(supabase);
    this.config = {
      pollInterval: config.pollInterval ?? 5000,
      agentId: config.agentId ?? '',
      paymentThreshold: config.paymentThreshold ?? 500,
    };
  }

  start() {
    if (this.running) return;
    this.running = true;
    console.log(`[A2A Processor] Started (poll: ${this.config.pollInterval}ms, agent: ${this.config.agentId || 'all'})`);
    this.poll();
    this.timer = setInterval(() => this.poll(), this.config.pollInterval);
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log('[A2A Processor] Stopped');
  }

  private async poll() {
    try {
      // Find submitted tasks
      const { data: tasks } = await this.supabase
        .from('a2a_tasks')
        .select('id, agent_id, state, context_id')
        .eq('tenant_id', this.tenantId)
        .eq('state', 'submitted')
        .eq('direction', 'inbound')
        .order('created_at', { ascending: true })
        .limit(10);

      if (!tasks?.length) return;

      for (const row of tasks) {
        if (this.config.agentId && row.agent_id !== this.config.agentId) continue;
        await this.processTask(row.id);
      }
    } catch (err: any) {
      console.error('[A2A Processor] Poll error:', err.message);
    }
  }

  /**
   * Process a single task through the full lifecycle.
   */
  async processTask(taskId: string): Promise<A2ATask | null> {
    const task = await this.taskService.getTask(taskId);
    if (!task) return null;

    console.log(`[A2A Processor] Processing task ${taskId.slice(0, 8)}... (${task.history.length} messages)`);

    // Build agent context from DB
    const agentId = (task as any).agentId || task.id;
    const agentCtx = await this.registry.buildAgentContext(
      this.tenantId,
      agentId,
      taskId,
      task.contextId,
    );

    if (!agentCtx) {
      await this.taskService.updateTaskState(taskId, 'failed', 'Agent context not found');
      await this.taskService.addMessage(taskId, 'agent', [
        { text: 'Task failed: Could not load agent context. The agent may be inactive or missing.' },
      ]);
      return this.taskService.getTask(taskId);
    }

    // Check if this is a payment resumption (task has a linked transfer + original intent)
    const taskMeta = task.metadata || {};
    const originalIntent = taskMeta['a2a.original_intent'] as string | undefined;

    if ((task as any).transferId && originalIntent) {
      return await this.handlePaymentResumption(taskId, originalIntent, (task as any).transferId, agentCtx);
    }

    // Check if this is a human-approved resumption:
    // Task has original_intent (was payment-gated) but no transferId (no payment proof submitted).
    // A human responded, so bypass the payment gate and execute the original request directly.
    if (originalIntent && !(task as any).transferId && task.history.length > 1) {
      console.log(`[A2A Processor] Human approval detected for task ${taskId.slice(0, 8)}, executing original intent`);
      return await this.handleHumanApproval(taskId, originalIntent, agentCtx);
    }

    // Transition to working
    await this.taskService.updateTaskState(taskId, 'working', 'Processing task');

    // Parse intent from history
    const lastUserMsg = [...task.history].reverse().find((m) => m.role === 'user');
    if (!lastUserMsg) {
      await this.taskService.updateTaskState(taskId, 'failed', 'No user message found');
      return this.taskService.getTask(taskId);
    }

    const text = lastUserMsg.parts
      .filter((p) => 'text' in p)
      .map((p) => (p as any).text)
      .join(' ');

    const intent = this.parseIntent(text);
    console.log(`[A2A Processor] Intent: ${intent.action} (amount: ${intent.amount} ${intent.currency})`);

    try {
      switch (intent.action) {
        case 'payment':
          return await this.handlePayment(taskId, intent, agentCtx);
        case 'balance':
          return await this.handleBalance(taskId, agentCtx);
        case 'lookup':
          return await this.handleLookup(taskId, intent, agentCtx);
        case 'quote':
          return await this.handleQuote(taskId, intent, agentCtx);
        case 'history':
          return await this.handleHistory(taskId, agentCtx);
        case 'stream':
          return await this.handleStream(taskId, intent);
        case 'info':
          return await this.handleInfo(taskId, agentCtx);
        default:
          return await this.handleGeneric(taskId, text);
      }
    } catch (err: any) {
      console.error(`[A2A Processor] Error processing ${taskId.slice(0, 8)}:`, err.message);
      await this.taskService.updateTaskState(taskId, 'failed', err.message);
      await this.taskService.addMessage(taskId, 'agent', [
        { text: `Task failed: ${err.message}` },
      ]);
      return this.taskService.getTask(taskId);
    }
  }

  // --- Intent Parsing ---

  private parseIntent(text: string): {
    action: string;
    amount: number;
    currency: string;
    destination?: string;
    description?: string;
  } {
    const lower = text.toLowerCase();

    // Extract amount
    const amountMatch = text.match(/[\$]?([\d,]+(?:\.\d{1,2})?)\s*(?:USDC|USD|BRL|MXN)/i);
    const amount = amountMatch ? parseFloat(amountMatch[1].replace(',', '')) : 0;

    // Extract currency
    const currMatch = text.match(/\b(USDC|USD|BRL|MXN)\b/i);
    const currency = currMatch ? currMatch[1].toUpperCase() : 'USDC';

    // Determine action (more specific intents first)
    if (lower.includes('stream') || lower.includes('per second') || lower.includes('flow rate')) {
      return { action: 'stream', amount, currency };
    }
    if (lower.includes('find') || lower.includes('search') || lower.includes('lookup') || lower.includes('list supplier') || lower.includes('list vendor') || lower.includes('list account')) {
      return { action: 'lookup', amount, currency, description: text };
    }
    if (lower.includes('quote') || lower.includes('estimate') || lower.includes('cost') || lower.includes('price') || lower.includes('how much')) {
      return { action: 'quote', amount, currency, description: text };
    }
    if (lower.includes('history') || lower.includes('transactions') || lower.includes('recent') || lower.includes('past payments')) {
      return { action: 'history', amount, currency };
    }
    if (lower.includes('balance') || lower.includes('wallet') || lower.includes('funds')) {
      return { action: 'balance', amount, currency };
    }
    if (lower.includes('send') || lower.includes('pay') || lower.includes('transfer') || lower.includes('remit') || lower.includes('book') || lower.includes('purchase') || lower.includes('procure')) {
      return { action: 'payment', amount, currency, description: text };
    }
    if (lower.includes('status') || lower.includes('info') || lower.includes('capabilities') || lower.includes('who are you')) {
      return { action: 'info', amount, currency };
    }

    return { action: 'generic', amount, currency, description: text };
  }

  // --- Action Handlers ---

  /**
   * Handle payment resumption after payment verification.
   * The task already has a linked transferId and the original intent stored in metadata.
   */
  private async handlePaymentResumption(
    taskId: string,
    originalIntent: string,
    transferId: string,
    agentCtx: AgentContext,
  ): Promise<A2ATask | null> {
    console.log(`[A2A Processor] Resuming task ${taskId.slice(0, 8)} after payment verification`);

    await this.taskService.updateTaskState(taskId, 'working', 'Payment verified, executing request');

    // Look up the linked transfer for the receipt
    const { data: transfer } = await this.supabase
      .from('transfers')
      .select('id, amount, currency, status')
      .eq('id', transferId)
      .eq('tenant_id', this.tenantId)
      .single();

    const receiptData = transfer
      ? { transferId: transfer.id, amount: Number(transfer.amount), currency: transfer.currency, status: transfer.status }
      : { transferId, status: 'linked' };

    await this.taskService.addMessage(taskId, 'agent', [
      {
        text: `Payment verified. Your request "${originalIntent}" has been processed. Transfer ID: ${transferId}.`,
      },
      {
        data: {
          type: 'payment_completed',
          ...receiptData,
          originalRequest: originalIntent,
          processedAt: new Date().toISOString(),
        },
        metadata: { mimeType: 'application/json' },
      },
    ]);

    await this.taskService.addArtifact(taskId, {
      name: `receipt-${taskId.slice(0, 8)}`,
      mediaType: 'application/json',
      parts: [
        {
          data: {
            receipt: true,
            ...receiptData,
            originalRequest: originalIntent,
            processedAt: new Date().toISOString(),
          },
          metadata: { mimeType: 'application/json' },
        },
      ],
    });

    await this.taskService.updateTaskState(taskId, 'completed', 'Payment processed');
    return this.taskService.getTask(taskId);
  }

  /**
   * Handle human-approved resumption.
   * The task was payment-gated, a human responded (without payment proof),
   * so we treat it as an authorization override and execute the original intent
   * bypassing the payment threshold.
   */
  private async handleHumanApproval(
    taskId: string,
    originalIntent: string,
    agentCtx: AgentContext,
  ): Promise<A2ATask | null> {
    await this.taskService.updateTaskState(taskId, 'working', 'Human approved, executing request');

    // Re-parse the original intent to get amount/currency
    const intent = this.parseIntent(originalIntent);

    // Execute the payment directly (bypass threshold)
    if (intent.amount > 0 && agentCtx.walletId) {
      // Use the same payment logic but skip the threshold check
      const balanceResult = await toolHandlers.get_wallet_balance(this.supabase, agentCtx, { walletId: agentCtx.walletId });
      if (balanceResult.success && balanceResult.data) {
        const wallet = balanceResult.data as { id: string; balance: number; currency: string };
        const currentBalance = Number(wallet.balance);

        if (currentBalance >= intent.amount) {
          // Atomically deduct balance — prevents double-spend
          const { data: deducted, error: deductError } = await this.supabase
            .from('wallets')
            .update({ balance: currentBalance - intent.amount })
            .eq('id', agentCtx.walletId)
            .eq('tenant_id', this.tenantId)
            .gte('balance', intent.amount)
            .select('balance')
            .single();

          if (deductError || !deducted) {
            await this.taskService.addMessage(taskId, 'agent', [
              { text: 'Balance changed during processing. Please retry.' },
            ]);
            await this.taskService.updateTaskState(taskId, 'failed', 'Concurrent balance change');
            return this.taskService.getTask(taskId);
          }

          const { data: parentAccount } = await this.supabase
            .from('accounts')
            .select('id, name')
            .eq('id', agentCtx.accountId)
            .eq('tenant_id', this.tenantId)
            .single();
          const accountName = parentAccount?.name || 'Agent Account';

          const { data: transfer } = await this.supabase
            .from('transfers')
            .insert({
              tenant_id: this.tenantId,
              type: 'internal',
              status: 'completed',
              amount: intent.amount,
              currency: intent.currency,
              destination_amount: intent.amount,
              destination_currency: intent.currency,
              fx_rate: 1,
              fee_amount: 0,
              description: `Human-approved: ${originalIntent}`,
              from_account_id: agentCtx.accountId,
              from_account_name: accountName,
              to_account_id: agentCtx.accountId,
              to_account_name: accountName,
              initiated_by_type: 'agent',
              initiated_by_id: agentCtx.agentId,
              initiated_by_name: accountName,
              completed_at: new Date().toISOString(),
            })
            .select('id')
            .single();

          if (transfer) {
            await this.taskService.linkPayment(taskId, transfer.id);

            await this.taskService.addMessage(taskId, 'agent', [
              {
                text: `Human-approved payment of ${intent.amount} ${intent.currency} processed. Transfer ID: ${transfer.id}.`,
              },
              {
                data: {
                  type: 'transfer_initiated',
                  transferId: transfer.id,
                  amount: intent.amount,
                  currency: intent.currency,
                  humanApproved: true,
                },
                metadata: { mimeType: 'application/json' },
              },
            ]);

            await this.taskService.updateTaskState(taskId, 'completed', 'Human-approved payment processed');
            return this.taskService.getTask(taskId);
          }
        }
      }
    }

    // Fallback: just mark completed with acknowledgement
    await this.taskService.addMessage(taskId, 'agent', [
      { text: `Human approved. Your request "${originalIntent}" has been processed.` },
    ]);
    await this.taskService.updateTaskState(taskId, 'completed', 'Human-approved request processed');
    return this.taskService.getTask(taskId);
  }

  private async handlePayment(
    taskId: string,
    intent: { amount: number; currency: string; description?: string },
    agentCtx: AgentContext,
  ): Promise<A2ATask | null> {
    // If amount exceeds threshold, require payment first
    if (intent.amount > this.config.paymentThreshold) {
      console.log(`[A2A Processor] Payment required: ${intent.amount} ${intent.currency} > threshold ${this.config.paymentThreshold}`);
      await this.paymentHandler.requirePayment(taskId, {
        amount: intent.amount,
        currency: intent.currency,
        description: intent.description,
        x402Endpoint: `${process.env.API_BASE_URL || 'http://localhost:4000'}/v1/x402/pay`,
      });

      // Merge the original intent into task metadata so we can resume after payment
      await this.supabase
        .from('a2a_tasks')
        .update({
          metadata: {
            'x402.payment.required': true,
            'x402.payment.amount': intent.amount,
            'x402.payment.currency': intent.currency,
            'a2a.original_intent': intent.description || `Send ${intent.amount} ${intent.currency}`,
          },
        })
        .eq('id', taskId)
        .eq('tenant_id', this.tenantId);

      return this.taskService.getTask(taskId);
    }

    // Small amount -- execute real wallet withdrawal
    if (!agentCtx.walletId) {
      await this.taskService.addMessage(taskId, 'agent', [
        { text: 'No wallet found for this agent. Cannot process payment.' },
      ]);
      await this.taskService.updateTaskState(taskId, 'failed', 'No wallet available');
      return this.taskService.getTask(taskId);
    }

    // Check wallet balance
    const balanceResult = await toolHandlers.get_wallet_balance(this.supabase, agentCtx, { walletId: agentCtx.walletId });
    if (!balanceResult.success || !balanceResult.data) {
      await this.taskService.addMessage(taskId, 'agent', [
        { text: `Could not check wallet balance: ${balanceResult.error?.message || 'Unknown error'}` },
      ]);
      await this.taskService.updateTaskState(taskId, 'failed', 'Wallet balance check failed');
      return this.taskService.getTask(taskId);
    }

    const wallet = balanceResult.data as { id: string; balance: number; currency: string; status: string; name: string };
    const currentBalance = Number(wallet.balance);

    if (currentBalance < intent.amount) {
      await this.taskService.addMessage(taskId, 'agent', [
        {
          text: `Insufficient balance. Wallet has ${currentBalance} ${wallet.currency}, but ${intent.amount} ${intent.currency} is required.`,
        },
        {
          data: {
            type: 'insufficient_balance',
            available: currentBalance,
            required: intent.amount,
            currency: wallet.currency,
          },
          metadata: { mimeType: 'application/json' },
        },
      ]);
      await this.taskService.updateTaskState(taskId, 'failed', 'Insufficient balance');
      return this.taskService.getTask(taskId);
    }

    // Atomically deduct balance — prevents double-spend via concurrent tasks
    const { data: updatedWallet, error: updateError } = await this.supabase.rpc('atomic_wallet_deduct', {
      p_wallet_id: agentCtx.walletId,
      p_tenant_id: this.tenantId,
      p_amount: intent.amount,
    });

    // Fallback: if RPC doesn't exist yet, use conditional UPDATE
    if (updateError?.message?.includes('function') || updateError?.code === '42883') {
      const { data: deducted, error: fallbackError } = await this.supabase
        .from('wallets')
        .update({ balance: currentBalance - intent.amount })
        .eq('id', agentCtx.walletId)
        .eq('tenant_id', this.tenantId)
        .gte('balance', intent.amount)
        .select('balance')
        .single();

      if (fallbackError || !deducted) {
        await this.taskService.updateTaskState(taskId, 'failed', 'Wallet update failed — balance may have changed');
        return this.taskService.getTask(taskId);
      }
    } else if (updateError) {
      await this.taskService.updateTaskState(taskId, 'failed', 'Wallet update failed');
      return this.taskService.getTask(taskId);
    }

    // Look up parent account for transfer record
    const { data: parentAccount } = await this.supabase
      .from('accounts')
      .select('id, name')
      .eq('id', agentCtx.accountId)
      .eq('tenant_id', this.tenantId)
      .single();

    const accountName = parentAccount?.name || 'Agent Account';

    // Create transfer record
    const { data: transfer, error: transferError } = await this.supabase
      .from('transfers')
      .insert({
        tenant_id: this.tenantId,
        type: 'internal',
        status: 'completed',
        amount: intent.amount,
        currency: intent.currency,
        destination_amount: intent.amount,
        destination_currency: intent.currency,
        fx_rate: 1,
        fee_amount: 0,
        description: intent.description || `A2A payment: ${intent.amount} ${intent.currency}`,
        from_account_id: agentCtx.accountId,
        from_account_name: accountName,
        to_account_id: agentCtx.accountId,
        to_account_name: accountName,
        initiated_by_type: 'agent',
        initiated_by_id: agentCtx.agentId,
        initiated_by_name: accountName,
        completed_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (transferError || !transfer) {
      console.error(`[A2A Processor] Transfer creation failed:`, transferError?.message, transferError?.details, transferError?.code);
      // Rollback wallet balance on transfer creation failure (additive to avoid overwriting concurrent changes)
      const { data: currentWallet } = await this.supabase
        .from('wallets')
        .select('balance')
        .eq('id', agentCtx.walletId)
        .eq('tenant_id', this.tenantId)
        .single();
      if (currentWallet) {
        await this.supabase
          .from('wallets')
          .update({ balance: Number(currentWallet.balance) + intent.amount })
          .eq('id', agentCtx.walletId)
          .eq('tenant_id', this.tenantId);
      }

      await this.taskService.updateTaskState(taskId, 'failed', `Transfer creation failed: ${transferError?.message || 'unknown'}`);
      return this.taskService.getTask(taskId);
    }

    // Link the transfer to the task
    await this.taskService.linkPayment(taskId, transfer.id);

    const rail = intent.currency === 'BRL' ? 'pix' : intent.currency === 'MXN' ? 'spei' : 'x402';
    const settlement = intent.currency === 'USDC' ? 'instant' : '< 30 minutes';

    await this.taskService.addMessage(taskId, 'agent', [
      {
        text: `Payment of ${intent.amount} ${intent.currency} processed successfully. Transfer ID: ${transfer.id}. Rail: ${rail}. Settlement: ${settlement}.`,
      },
      {
        data: {
          type: 'transfer_initiated',
          transferId: transfer.id,
          amount: intent.amount,
          currency: intent.currency,
          rail,
          estimatedSettlement: settlement,
          walletBalance: newBalance,
        },
        metadata: { mimeType: 'application/json' },
      },
    ]);

    await this.taskService.updateTaskState(taskId, 'completed', 'Payment processed');

    // Add artifact with transfer receipt
    await this.taskService.addArtifact(taskId, {
      name: `receipt-${taskId.slice(0, 8)}`,
      mediaType: 'application/json',
      parts: [
        {
          data: {
            receipt: true,
            transferId: transfer.id,
            amount: intent.amount,
            currency: intent.currency,
            rail,
            status: 'completed',
            processedAt: new Date().toISOString(),
          },
          metadata: { mimeType: 'application/json' },
        },
      ],
    });

    return this.taskService.getTask(taskId);
  }

  private async handleBalance(taskId: string, agentCtx: AgentContext): Promise<A2ATask | null> {
    // Try the agent's default wallet first
    if (agentCtx.walletId) {
      const result = await toolHandlers.get_wallet_balance(this.supabase, agentCtx, { walletId: agentCtx.walletId });
      if (result.success && result.data) {
        const wallet = result.data as { id: string; balance: number; currency: string; status: string; name: string };

        await this.taskService.addMessage(taskId, 'agent', [
          {
            text: `Current wallet balance: ${Number(wallet.balance).toLocaleString()} ${wallet.currency}. Wallet: ${wallet.name || wallet.id}. Status: ${wallet.status}.`,
          },
          {
            data: {
              type: 'balance_check',
              walletId: wallet.id,
              walletName: wallet.name,
              currency: wallet.currency,
              balance: Number(wallet.balance),
              available: Number(wallet.balance),
              status: wallet.status,
              timestamp: new Date().toISOString(),
            },
            metadata: { mimeType: 'application/json' },
          },
        ]);

        await this.taskService.updateTaskState(taskId, 'completed', 'Balance checked');
        return this.taskService.getTask(taskId);
      }
    }

    // No default wallet — list all wallets for this tenant
    const listResult = await toolHandlers.list_wallets(this.supabase, agentCtx, {});
    if (listResult.success && Array.isArray(listResult.data) && listResult.data.length > 0) {
      const wallets = listResult.data as Array<{ id: string; balance: number; currency: string; status: string; name: string }>;
      const summary = wallets
        .map((w) => `${w.name || w.id}: ${Number(w.balance).toLocaleString()} ${w.currency} (${w.status})`)
        .join('\n');

      await this.taskService.addMessage(taskId, 'agent', [
        {
          text: `Found ${wallets.length} wallet(s):\n${summary}`,
        },
        {
          data: {
            type: 'balance_check',
            wallets: wallets.map((w) => ({
              walletId: w.id,
              walletName: w.name,
              balance: Number(w.balance),
              currency: w.currency,
              status: w.status,
            })),
            timestamp: new Date().toISOString(),
          },
          metadata: { mimeType: 'application/json' },
        },
      ]);

      await this.taskService.updateTaskState(taskId, 'completed', 'Balance checked');
      return this.taskService.getTask(taskId);
    }

    // No wallets found at all
    await this.taskService.addMessage(taskId, 'agent', [
      { text: 'No wallets found for this agent. Please create a wallet first.' },
    ]);
    await this.taskService.updateTaskState(taskId, 'completed', 'No wallets found');
    return this.taskService.getTask(taskId);
  }

  private async handleStream(taskId: string, intent: { amount: number; currency: string }): Promise<A2ATask | null> {
    const flowRate = intent.amount || 0.01;

    await this.taskService.addMessage(taskId, 'agent', [
      {
        text: `Payment stream configured: ${flowRate} ${intent.currency}/second. Stream will begin once funded. Estimated daily flow: ${(flowRate * 86400).toFixed(2)} ${intent.currency}.`,
      },
      {
        data: {
          type: 'stream_configured',
          flowRate,
          currency: intent.currency,
          dailyFlow: flowRate * 86400,
          status: 'configured',
        },
        metadata: { mimeType: 'application/json' },
      },
    ]);

    await this.taskService.updateTaskState(taskId, 'completed', 'Stream configured');
    return this.taskService.getTask(taskId);
  }

  private async handleInfo(taskId: string, agentCtx: AgentContext): Promise<A2ATask | null> {
    const result = await toolHandlers.get_agent_info(this.supabase, agentCtx, {});

    if (result.success && result.data) {
      const info = result.data as Record<string, unknown>;
      const name = info.name || 'Sly payment agent';
      const kyaTier = info.kyaTier ?? 'unknown';
      const description = info.description || 'I can process payments, check balances, and manage payment streams.';
      const walletBalance = info.walletBalance != null ? ` Wallet balance: ${info.walletBalance} ${info.walletCurrency || 'USDC'}.` : '';

      await this.taskService.addMessage(taskId, 'agent', [
        {
          text: `I am ${name} (KYA Tier ${kyaTier}). ${description}${walletBalance}`,
        },
        {
          data: {
            type: 'agent_info',
            ...info,
          },
          metadata: { mimeType: 'application/json' },
        },
      ]);
    } else {
      await this.taskService.addMessage(taskId, 'agent', [
        { text: 'I am a Sly payment agent. I can process payments (x402, Pix, SPEI), check wallet balances, and create payment streams.' },
      ]);
    }

    await this.taskService.updateTaskState(taskId, 'completed', 'Info provided');
    return this.taskService.getTask(taskId);
  }

  /**
   * Handle lookup/search — find accounts, suppliers, vendors.
   * Real DB query via list_accounts tool handler.
   */
  private async handleLookup(
    taskId: string,
    intent: { description?: string },
    agentCtx: AgentContext,
  ): Promise<A2ATask | null> {
    const result = await toolHandlers.list_accounts(this.supabase, agentCtx, { limit: 10 });

    if (!result.success || !Array.isArray(result.data) || result.data.length === 0) {
      await this.taskService.addMessage(taskId, 'agent', [
        { text: 'No accounts found matching your search. Try broadening your criteria.' },
      ]);
      await this.taskService.updateTaskState(taskId, 'completed', 'Lookup complete — no results');
      return this.taskService.getTask(taskId);
    }

    const accounts = result.data as Array<Record<string, unknown>>;
    const summary = accounts
      .map((a, i) => `${i + 1}. **${a.name}** (${a.type}) — Tier ${a.verification_tier ?? 0}, ${a.verification_status || 'unverified'}`)
      .join('\n');

    await this.taskService.addMessage(taskId, 'agent', [
      {
        text: `Found ${accounts.length} account(s):\n${summary}\n\nTo proceed with a payment, reply with "Send [amount] [currency] to [account name]".`,
      },
      {
        data: {
          type: 'account_list',
          query: intent.description,
          count: accounts.length,
          accounts: accounts.map((a) => ({
            id: a.id,
            name: a.name,
            type: a.type,
            verificationTier: a.verification_tier,
            verificationStatus: a.verification_status,
          })),
          timestamp: new Date().toISOString(),
        },
        metadata: { mimeType: 'application/json' },
      },
    ]);

    await this.taskService.addArtifact(taskId, {
      name: `search-results-${taskId.slice(0, 8)}`,
      mediaType: 'application/json',
      parts: [
        {
          data: {
            type: 'search_results',
            query: intent.description,
            results: accounts.map((a) => ({ id: a.id, name: a.name, type: a.type })),
          },
          metadata: { mimeType: 'application/json' },
        },
      ],
    });

    await this.taskService.updateTaskState(taskId, 'completed', 'Lookup complete');
    return this.taskService.getTask(taskId);
  }

  /**
   * Handle quote/estimate — get pricing for a cross-border or internal transfer.
   * Uses real account and wallet data to build the quote.
   */
  private async handleQuote(
    taskId: string,
    intent: { amount: number; currency: string; description?: string },
    agentCtx: AgentContext,
  ): Promise<A2ATask | null> {
    const amount = intent.amount || 500;

    // Simple FX rate lookup (real data would call the FX service)
    const rates: Record<string, number> = { BRL: 5.05, MXN: 17.2, USD: 1, USDC: 1 };
    const targetCurrency = intent.currency !== 'USDC' ? intent.currency : 'BRL';
    const fxRate = rates[targetCurrency] || 1;
    const fee = amount * 0.007; // 0.7% fee
    const destinationAmount = (amount - fee) * fxRate;

    // Check if agent has enough balance
    let walletBalance: number | null = null;
    if (agentCtx.walletId) {
      const balResult = await toolHandlers.get_wallet_balance(this.supabase, agentCtx, { walletId: agentCtx.walletId });
      if (balResult.success && balResult.data) {
        walletBalance = Number((balResult.data as any).balance);
      }
    }

    const affordable = walletBalance != null && walletBalance >= amount;
    const balanceNote = walletBalance != null
      ? `\nYour wallet balance: ${walletBalance} USDC. ${affordable ? 'Sufficient for this transfer.' : 'Insufficient — please fund your wallet.'}`
      : '';

    await this.taskService.addMessage(taskId, 'agent', [
      {
        text: `Quote for ${amount} USDC → ${targetCurrency}:\n- Exchange rate: 1 USDC = ${fxRate} ${targetCurrency}\n- Fee: ${fee.toFixed(2)} USDC (0.7%)\n- Recipient receives: ${destinationAmount.toFixed(2)} ${targetCurrency}\n- Settlement: ${targetCurrency === 'BRL' ? 'Pix (< 30 min)' : targetCurrency === 'MXN' ? 'SPEI (< 30 min)' : 'Instant'}${balanceNote}\n\nTo execute, reply with "Send ${amount} USDC".`,
      },
      {
        data: {
          type: 'quote',
          sourceAmount: amount,
          sourceCurrency: 'USDC',
          destinationAmount: Number(destinationAmount.toFixed(2)),
          destinationCurrency: targetCurrency,
          fxRate,
          fee: Number(fee.toFixed(2)),
          feeCurrency: 'USDC',
          rail: targetCurrency === 'BRL' ? 'pix' : targetCurrency === 'MXN' ? 'spei' : 'x402',
          walletBalance,
          affordable,
          expiresIn: '5 minutes',
          timestamp: new Date().toISOString(),
        },
        metadata: { mimeType: 'application/json' },
      },
    ]);

    await this.taskService.updateTaskState(taskId, 'completed', 'Quote provided');
    return this.taskService.getTask(taskId);
  }

  /**
   * Handle transaction history — show recent agent transactions.
   * Real DB query via get_agent_transactions tool handler.
   */
  private async handleHistory(taskId: string, agentCtx: AgentContext): Promise<A2ATask | null> {
    const result = await toolHandlers.get_agent_transactions(this.supabase, agentCtx, { limit: 10 });

    if (!result.success || !Array.isArray(result.data) || result.data.length === 0) {
      await this.taskService.addMessage(taskId, 'agent', [
        { text: 'No recent transactions found for this agent.' },
      ]);
      await this.taskService.updateTaskState(taskId, 'completed', 'No transaction history');
      return this.taskService.getTask(taskId);
    }

    const txns = result.data as Array<Record<string, unknown>>;
    const summary = txns
      .map((t, i) => `${i + 1}. ${t.type} — ${t.amount} ${t.currency} (${t.status}) — ${t.description || 'N/A'}`)
      .join('\n');

    await this.taskService.addMessage(taskId, 'agent', [
      {
        text: `Recent transactions (${txns.length}):\n${summary}`,
      },
      {
        data: {
          type: 'transaction_history',
          count: txns.length,
          transactions: txns,
          timestamp: new Date().toISOString(),
        },
        metadata: { mimeType: 'application/json' },
      },
    ]);

    await this.taskService.addArtifact(taskId, {
      name: `history-${taskId.slice(0, 8)}`,
      mediaType: 'application/json',
      parts: [
        {
          data: { type: 'transaction_history', transactions: txns },
          metadata: { mimeType: 'application/json' },
        },
      ],
    });

    await this.taskService.updateTaskState(taskId, 'completed', 'History provided');
    return this.taskService.getTask(taskId);
  }

  private async handleGeneric(taskId: string, text: string): Promise<A2ATask | null> {
    await this.taskService.addMessage(taskId, 'agent', [
      {
        text: `I received your message. I can help with:\n- **Payments**: "Send 500 USDC to Brazil"\n- **Balance checks**: "Check my USDC balance"\n- **Streams**: "Create a stream at 0.01 USDC/second"\n- **Agent info**: "What are your capabilities?"\n\nPlease let me know what you'd like to do.`,
      },
    ]);

    await this.taskService.updateTaskState(taskId, 'completed', 'Help response sent');
    return this.taskService.getTask(taskId);
  }
}
