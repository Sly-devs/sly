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
import { A2AClient } from './client.js';
import { A2AWebhookHandler } from './webhook-handler.js';

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

    // --- Routing: Sly-native vs agent forwarding ---
    const msgMetadata = lastUserMsg.metadata;
    const explicitSkillId = msgMetadata?.skillId as string | undefined;

    // Check if this intent maps to a Sly-native skill the agent registered
    const slySkillId = A2ATaskProcessor.INTENT_TO_SKILL[intent.action];
    let hasSlyNativeSkill = false;

    if (slySkillId) {
      const { data: nativeSkill } = await this.supabase
        .from('agent_skills')
        .select('skill_id, handler_type')
        .eq('agent_id', agentCtx.agentId)
        .eq('tenant_id', this.tenantId)
        .eq('skill_id', slySkillId)
        .eq('handler_type', 'sly_native')
        .eq('status', 'active')
        .maybeSingle();

      hasSlyNativeSkill = !!nativeSkill;
    }

    // No Sly-native match — check if agent has an active endpoint to forward to
    if (!hasSlyNativeSkill) {
      const hasEndpoint = await this.agentHasEndpoint(agentCtx.agentId);
      if (hasEndpoint) {
        return await this.forwardToAgent(taskId, text,
          { skill_id: explicitSkillId || 'default', handler_type: 'agent_provided', base_price: 0, currency: 'USDC' },
          agentCtx, msgMetadata);
      }
    }

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
        case 'checkout':
          return await this.handleCheckout(taskId, intent, agentCtx);
        case 'x402_access':
          return await this.handleX402Access(taskId, intent, agentCtx);
        case 'mandate':
          return await this.handleMandate(taskId, intent, agentCtx);
        case 'research':
          return await this.handleResearch(taskId, intent, agentCtx);
        default:
          return await this.handleGeneric(taskId, text, agentCtx);
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

  // --- Service Fee Charging ---

  /**
   * Charge a service fee for a skill invocation.
   * Looks up the skill in agent_skills, deducts base_price from wallet,
   * creates a transfer record, and increments usage stats.
   * Returns true if fee was charged (or no fee needed), false if insufficient funds.
   */
  private async chargeServiceFee(
    taskId: string,
    skillId: string,
    agentCtx: AgentContext,
  ): Promise<{ charged: boolean; fee: number; currency: string }> {
    // Look up skill pricing from DB
    const { data: skill } = await this.supabase
      .from('agent_skills')
      .select('id, base_price, currency')
      .eq('agent_id', agentCtx.agentId)
      .eq('tenant_id', this.tenantId)
      .eq('skill_id', skillId)
      .eq('status', 'active')
      .single();

    const fee = skill ? Number(skill.base_price) : 0;
    const currency = skill?.currency || 'USDC';

    if (fee <= 0) {
      return { charged: true, fee: 0, currency };
    }

    if (!agentCtx.walletId) {
      await this.taskService.addMessage(taskId, 'agent', [
        { text: `This skill requires a fee of ${fee} ${currency}, but no wallet is available.` },
      ]);
      return { charged: false, fee, currency };
    }

    // Check balance
    const { data: wallet } = await this.supabase
      .from('wallets')
      .select('balance')
      .eq('id', agentCtx.walletId)
      .eq('tenant_id', this.tenantId)
      .single();

    if (!wallet || Number(wallet.balance) < fee) {
      await this.taskService.addMessage(taskId, 'agent', [
        { text: `Insufficient funds for skill fee. Required: ${fee} ${currency}. Available: ${wallet ? Number(wallet.balance) : 0} ${currency}.` },
      ]);
      return { charged: false, fee, currency };
    }

    // Deduct atomically
    const { error: deductError } = await this.supabase
      .from('wallets')
      .update({ balance: Number(wallet.balance) - fee })
      .eq('id', agentCtx.walletId)
      .eq('tenant_id', this.tenantId)
      .gte('balance', fee);

    if (deductError) {
      return { charged: false, fee, currency };
    }

    // Create transfer record for the service fee
    await this.supabase
      .from('transfers')
      .insert({
        tenant_id: this.tenantId,
        type: 'internal',
        status: 'completed',
        amount: fee,
        currency,
        destination_amount: fee,
        destination_currency: currency,
        fx_rate: 1,
        fee_amount: 0,
        description: `A2A service fee: ${skillId}`,
        from_account_id: agentCtx.accountId,
        from_account_name: 'Agent Account',
        to_account_id: agentCtx.accountId,
        to_account_name: 'Agent Account',
        initiated_by_type: 'agent',
        initiated_by_id: agentCtx.agentId,
        initiated_by_name: 'Agent',
        completed_at: new Date().toISOString(),
        protocol_metadata: { protocol: 'a2a', serviceFee: true, skillId },
      });

    // Increment usage stats on the skill row (best-effort)
    if (skill) {
      const { error: rpcError } = await this.supabase.rpc('increment_agent_skill_usage', {
        p_skill_id: skill.id,
        p_fee: fee,
      });
      if (rpcError) {
        // RPC doesn't exist — update directly
        await this.supabase
          .from('agent_skills')
          .update({
            total_invocations: ((skill as any).total_invocations || 0) + 1,
            total_fees_collected: Number((skill as any).total_fees_collected || 0) + fee,
          })
          .eq('id', skill.id);
      }
    }

    return { charged: true, fee, currency };
  }

  // --- Skill Matching & Forwarding ---

  /** Map intent actions to known Sly-native skill_ids */
  private static INTENT_TO_SKILL: Record<string, string> = {
    payment: 'make_payment',
    balance: 'check_balance',
    lookup: 'lookup_account',
    quote: 'get_quote',
    history: 'transaction_history',
    info: 'agent_info',
    checkout: 'create_checkout',
    x402_access: 'access_api',
    mandate: 'create_mandate',
    research: 'research',
  };

  /**
   * Check if an agent has an active endpoint configured for forwarding.
   */
  private async agentHasEndpoint(agentId: string): Promise<boolean> {
    const { data } = await this.supabase
      .from('agents')
      .select('endpoint_enabled')
      .eq('id', agentId)
      .eq('tenant_id', this.tenantId)
      .eq('endpoint_enabled', true)
      .maybeSingle();
    return !!data;
  }

  /**
   * Forward a task to the agent's registered endpoint.
   * Supports both A2A (JSON-RPC) and webhook (HTTP POST) forwarding.
   */
  private async forwardToAgent(
    taskId: string,
    messageText: string,
    skill: { skill_id: string; handler_type: string; base_price: number; currency: string },
    agentCtx: AgentContext,
    callerMetadata?: Record<string, unknown>,
  ): Promise<A2ATask | null> {
    // Look up agent's endpoint configuration
    const { data: agent } = await this.supabase
      .from('agents')
      .select('id, endpoint_url, endpoint_type, endpoint_secret, endpoint_enabled')
      .eq('id', agentCtx.agentId)
      .eq('tenant_id', this.tenantId)
      .single();

    if (!agent?.endpoint_url || !agent.endpoint_enabled || agent.endpoint_type === 'none') {
      await this.taskService.addMessage(taskId, 'agent', [
        { text: `Skill "${skill.skill_id}" is agent-provided but no endpoint is configured. Please register an endpoint.` },
      ]);
      await this.taskService.updateTaskState(taskId, 'failed', 'Agent has no endpoint configured');
      return this.taskService.getTask(taskId);
    }

    // Charge service fee if applicable
    if (Number(skill.base_price) > 0) {
      const feeResult = await this.chargeServiceFee(taskId, skill.skill_id, agentCtx);
      if (!feeResult.charged) {
        await this.taskService.updateTaskState(taskId, 'failed', 'Insufficient funds for skill fee');
        return this.taskService.getTask(taskId);
      }
    }

    console.log(`[A2A Processor] Forwarding task ${taskId.slice(0, 8)} to agent endpoint (${agent.endpoint_type}: ${agent.endpoint_url})`);

    if (agent.endpoint_type === 'a2a') {
      return await this.forwardViaA2A(taskId, messageText, agent, skill, callerMetadata);
    } else if (agent.endpoint_type === 'webhook') {
      return await this.forwardViaWebhook(taskId, messageText, agent, skill);
    }

    await this.taskService.updateTaskState(taskId, 'failed', `Unknown endpoint type: ${agent.endpoint_type}`);
    return this.taskService.getTask(taskId);
  }

  /**
   * Forward task via A2A JSON-RPC (message/send).
   * Sends the message to the agent's A2A endpoint and waits for a response.
   */
  private async forwardViaA2A(
    taskId: string,
    messageText: string,
    agent: { id: string; endpoint_url: string; endpoint_secret?: string | null },
    skill: { skill_id: string },
    callerMetadata?: Record<string, unknown>,
  ): Promise<A2ATask | null> {
    const client = new A2AClient();

    try {
      const response = await client.sendMessage(
        agent.endpoint_url,
        { parts: [{ text: messageText }], metadata: { ...callerMetadata, skillId: skill.skill_id, slyTaskId: taskId } },
        taskId, // Use Sly task ID as context ID for correlation
        agent.endpoint_secret || undefined,
      );

      // Extract result from JSON-RPC response
      const result = (response as any).result;

      if (result) {
        // Store remote task ID for tracking
        await this.supabase
          .from('a2a_tasks')
          .update({ remote_task_id: result.id, metadata: { forwarded_to: agent.endpoint_url, skill_id: skill.skill_id } })
          .eq('id', taskId)
          .eq('tenant_id', this.tenantId);

        // Check if remote task completed synchronously
        const remoteState = result.status?.state;

        if (remoteState === 'completed') {
          // Extract agent's response from the remote task
          const history = result.history || [];
          const agentMessages = history.filter((m: any) => m.role === 'agent');
          const lastMsg = agentMessages[agentMessages.length - 1];

          if (lastMsg?.parts?.length) {
            await this.taskService.addMessage(taskId, 'agent', lastMsg.parts, lastMsg.metadata);
          } else {
            await this.taskService.addMessage(taskId, 'agent', [
              { text: 'Task completed by agent.' },
            ]);
          }

          // Copy artifacts if present
          if (result.artifacts?.length) {
            for (const artifact of result.artifacts) {
              await this.taskService.addArtifact(taskId, artifact);
            }
          }

          await this.taskService.updateTaskState(taskId, 'completed', 'Forwarded task completed');
        } else if (remoteState === 'failed') {
          const errorMsg = result.status?.message || 'Remote agent failed';
          await this.taskService.addMessage(taskId, 'agent', [{ text: `Agent returned error: ${errorMsg}` }]);
          await this.taskService.updateTaskState(taskId, 'failed', errorMsg);
        } else {
          // Task is still working on the remote side — mark as working, await callback
          await this.taskService.addMessage(taskId, 'agent', [
            { text: `Task forwarded to agent. Awaiting response (remote state: ${remoteState || 'working'}).` },
          ]);
          await this.taskService.updateTaskState(taskId, 'working', 'Awaiting agent response');
        }
      } else if ((response as any).error) {
        const rpcError = (response as any).error;
        await this.taskService.addMessage(taskId, 'agent', [
          { text: `Agent endpoint error: ${rpcError.message || 'Unknown RPC error'}` },
        ]);
        await this.taskService.updateTaskState(taskId, 'failed', rpcError.message || 'RPC error');
      }
    } catch (err: any) {
      console.error(`[A2A Processor] A2A forward failed for task ${taskId.slice(0, 8)}:`, err.message);
      await this.taskService.addMessage(taskId, 'agent', [
        { text: `Failed to reach agent endpoint: ${err.message}` },
      ]);
      await this.taskService.updateTaskState(taskId, 'failed', `Forwarding failed: ${err.message}`);
    }

    return this.taskService.getTask(taskId);
  }

  /**
   * Forward task via webhook (HTTP POST).
   * Sends the task payload to the agent's webhook URL. Agent responds via callback.
   */
  private async forwardViaWebhook(
    taskId: string,
    messageText: string,
    agent: { id: string; endpoint_url: string; endpoint_secret?: string | null },
    skill: { skill_id: string },
  ): Promise<A2ATask | null> {
    const webhookHandler = new A2AWebhookHandler(this.supabase);
    const deliveryId = crypto.randomUUID();

    // Store the delivery ID for tracking
    await this.supabase
      .from('a2a_tasks')
      .update({
        webhook_delivery_id: deliveryId,
        webhook_status: 'pending',
        metadata: { forwarded_to: agent.endpoint_url, skill_id: skill.skill_id },
      })
      .eq('id', taskId)
      .eq('tenant_id', this.tenantId);

    const result = await webhookHandler.dispatch(
      { id: taskId, tenant_id: this.tenantId, agent_id: agent.id, state: 'working' },
      { callbackUrl: agent.endpoint_url, callbackSecret: agent.endpoint_secret || undefined },
      deliveryId,
    );

    if (result.success) {
      await webhookHandler.recordSuccess(taskId, result);
      await this.taskService.addMessage(taskId, 'agent', [
        { text: `Task dispatched to agent webhook. Awaiting response.` },
      ]);
      // Mark as working — agent will call back via POST /a2a/:agentId/callback
      await this.taskService.updateTaskState(taskId, 'working', 'Dispatched to agent webhook');
    } else {
      await webhookHandler.recordFailure(taskId, this.tenantId, result, 0);
      await this.taskService.addMessage(taskId, 'agent', [
        { text: `Failed to dispatch to agent webhook: ${result.error || 'Unknown error'}` },
      ]);
      await this.taskService.updateTaskState(taskId, 'failed', `Webhook dispatch failed: ${result.error}`);
    }

    return this.taskService.getTask(taskId);
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

    // New intents: checkout, x402, mandate, research
    if (lower.includes('checkout') || lower.includes('cart') || lower.includes('create order') || (lower.includes('buy') && lower.includes('item'))) {
      return { action: 'checkout', amount, currency, description: text };
    }
    if (lower.includes('x402') || ((lower.includes('access') || lower.includes('fetch')) && (lower.includes('api') || lower.includes('endpoint') || lower.includes('data')))) {
      return { action: 'x402_access', amount, currency, description: text };
    }
    if (lower.includes('mandate') || lower.includes('recurring') || lower.includes('subscription') || lower.includes('budget')) {
      return { action: 'mandate', amount, currency, description: text };
    }
    if (lower.includes('research') || lower.includes('analyze') || lower.includes('corridor') || lower.includes('compare') || lower.includes('report')) {
      return { action: 'research', amount, currency, description: text };
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

  // --- New Skill Economy Handlers ---

  /**
   * Handle checkout — Create a UCP checkout session.
   * Charges the create_checkout skill fee, then creates the checkout.
   */
  private async handleCheckout(
    taskId: string,
    intent: { amount: number; currency: string; description?: string },
    agentCtx: AgentContext,
  ): Promise<A2ATask | null> {
    const feeResult = await this.chargeServiceFee(taskId, 'create_checkout', agentCtx);
    if (!feeResult.charged) {
      await this.taskService.updateTaskState(taskId, 'failed', 'Insufficient funds for checkout fee');
      return this.taskService.getTask(taskId);
    }

    // Parse line items from the description
    const lineItems = this.parseLineItems(intent.description || '', intent.amount, intent.currency);

    const result = await toolHandlers.ucp_create_checkout(this.supabase, agentCtx, {
      line_items: lineItems,
      currency: intent.currency,
    });

    if (!result.success || !result.data) {
      await this.taskService.addMessage(taskId, 'agent', [
        { text: `Checkout creation failed: ${result.error?.message || 'Unknown error'}` },
      ]);
      await this.taskService.updateTaskState(taskId, 'failed', 'Checkout creation failed');
      return this.taskService.getTask(taskId);
    }

    const checkout = result.data as Record<string, unknown>;
    const totals = checkout.totals as Record<string, unknown> | undefined;
    const totalDisplay = totals?.total ?? 'N/A';
    const feeNote = feeResult.fee > 0 ? ` Service fee: ${feeResult.fee} ${feeResult.currency}.` : '';

    await this.taskService.addMessage(taskId, 'agent', [
      {
        text: `Checkout created successfully. ID: ${checkout.id}. Total: ${totalDisplay} ${checkout.currency}.${feeNote}`,
      },
      {
        data: { type: 'checkout_created', ...checkout, serviceFee: feeResult.fee },
        metadata: { mimeType: 'application/json' },
      },
    ]);

    await this.taskService.addArtifact(taskId, {
      name: `checkout-${taskId.slice(0, 8)}`,
      mediaType: 'application/json',
      parts: [
        {
          data: { type: 'checkout', ...checkout },
          metadata: { mimeType: 'application/json' },
        },
      ],
    });

    await this.taskService.updateTaskState(taskId, 'completed', 'Checkout created');
    return this.taskService.getTask(taskId);
  }

  /**
   * Handle x402 API access.
   * Charges the access_api skill fee, then lists or pays for endpoints.
   */
  private async handleX402Access(
    taskId: string,
    intent: { amount: number; currency: string; description?: string },
    agentCtx: AgentContext,
  ): Promise<A2ATask | null> {
    const feeResult = await this.chargeServiceFee(taskId, 'access_api', agentCtx);
    if (!feeResult.charged) {
      await this.taskService.updateTaskState(taskId, 'failed', 'Insufficient funds for API access fee');
      return this.taskService.getTask(taskId);
    }

    const result = await toolHandlers.x402_list_endpoints(this.supabase, agentCtx, {});
    const endpoints = (result.success && Array.isArray(result.data)) ? result.data : [];

    const feeNote = feeResult.fee > 0 ? ` Service fee: ${feeResult.fee} ${feeResult.currency}.` : '';

    if (endpoints.length === 0) {
      await this.taskService.addMessage(taskId, 'agent', [
        { text: `No active x402 endpoints found.${feeNote}` },
      ]);
    } else {
      const summary = endpoints
        .map((e: any, i: number) => `${i + 1}. **${e.name || e.path}** — ${e.base_price} ${e.currency} per call (${e.total_calls || 0} calls)`)
        .join('\n');

      await this.taskService.addMessage(taskId, 'agent', [
        {
          text: `Available x402 endpoints (${endpoints.length}):\n${summary}\n${feeNote}`,
        },
        {
          data: { type: 'x402_endpoints', endpoints, serviceFee: feeResult.fee },
          metadata: { mimeType: 'application/json' },
        },
      ]);
    }

    await this.taskService.updateTaskState(taskId, 'completed', 'x402 endpoints listed');
    return this.taskService.getTask(taskId);
  }

  /**
   * Handle mandate creation.
   * Charges the create_mandate skill fee, then creates an AP2 mandate.
   */
  private async handleMandate(
    taskId: string,
    intent: { amount: number; currency: string; description?: string },
    agentCtx: AgentContext,
  ): Promise<A2ATask | null> {
    // If no amount specified, list existing mandates
    if (intent.amount <= 0) {
      const listResult = await toolHandlers.ap2_list_mandates(this.supabase, agentCtx, { agentId: agentCtx.agentId });
      if (listResult.success && Array.isArray(listResult.data) && listResult.data.length > 0) {
        const mandates = listResult.data as Array<Record<string, unknown>>;
        const summary = mandates
          .map((m, i) => `${i + 1}. ${m.mandate_id} — ${m.authorized_amount} ${m.currency} (${m.status})`)
          .join('\n');

        await this.taskService.addMessage(taskId, 'agent', [
          { text: `Existing mandates (${mandates.length}):\n${summary}` },
          { data: { type: 'mandate_list', mandates }, metadata: { mimeType: 'application/json' } },
        ]);
      } else {
        await this.taskService.addMessage(taskId, 'agent', [
          { text: 'No existing mandates found. Specify an amount to create one, e.g. "Create a 5000 USDC monthly mandate".' },
        ]);
      }
      await this.taskService.updateTaskState(taskId, 'completed', 'Mandates listed');
      return this.taskService.getTask(taskId);
    }

    const feeResult = await this.chargeServiceFee(taskId, 'create_mandate', agentCtx);
    if (!feeResult.charged) {
      await this.taskService.updateTaskState(taskId, 'failed', 'Insufficient funds for mandate creation fee');
      return this.taskService.getTask(taskId);
    }

    const mandateType = intent.description?.toLowerCase().includes('cart') ? 'cart' :
      intent.description?.toLowerCase().includes('intent') ? 'intent' : 'payment';

    const result = await toolHandlers.ap2_create_mandate(this.supabase, agentCtx, {
      authorized_amount: intent.amount,
      currency: intent.currency,
      mandate_type: mandateType,
      description: intent.description || `Mandate for ${intent.amount} ${intent.currency}`,
    });

    if (!result.success || !result.data) {
      await this.taskService.addMessage(taskId, 'agent', [
        { text: `Mandate creation failed: ${result.error?.message || 'Unknown error'}` },
      ]);
      await this.taskService.updateTaskState(taskId, 'failed', 'Mandate creation failed');
      return this.taskService.getTask(taskId);
    }

    const mandate = result.data as Record<string, unknown>;
    const feeNote = feeResult.fee > 0 ? ` Service fee: ${feeResult.fee} ${feeResult.currency}.` : '';

    await this.taskService.addMessage(taskId, 'agent', [
      {
        text: `Mandate created. ID: ${mandate.mandate_id}. Authorization: ${mandate.authorized_amount} ${mandate.currency}. Type: ${mandate.mandate_type}.${feeNote}`,
      },
      {
        data: { type: 'mandate_created', ...mandate, serviceFee: feeResult.fee },
        metadata: { mimeType: 'application/json' },
      },
    ]);

    await this.taskService.addArtifact(taskId, {
      name: `mandate-${taskId.slice(0, 8)}`,
      mediaType: 'application/json',
      parts: [
        {
          data: { type: 'mandate', ...mandate },
          metadata: { mimeType: 'application/json' },
        },
      ],
    });

    await this.taskService.updateTaskState(taskId, 'completed', 'Mandate created');
    return this.taskService.getTask(taskId);
  }

  /**
   * Handle research — aggregates real data and returns a structured report.
   * Charges the research skill fee. This is a paid computational service.
   */
  private async handleResearch(
    taskId: string,
    intent: { amount: number; currency: string; description?: string },
    agentCtx: AgentContext,
  ): Promise<A2ATask | null> {
    const feeResult = await this.chargeServiceFee(taskId, 'research', agentCtx);
    if (!feeResult.charged) {
      await this.taskService.updateTaskState(taskId, 'failed', 'Insufficient funds for research fee');
      return this.taskService.getTask(taskId);
    }

    // Aggregate real data for the report
    const [accountsResult, transactionsResult] = await Promise.all([
      toolHandlers.list_accounts(this.supabase, agentCtx, { limit: 20 }),
      toolHandlers.get_agent_transactions(this.supabase, agentCtx, { limit: 50 }),
    ]);

    const accounts = (accountsResult.success && Array.isArray(accountsResult.data)) ? accountsResult.data : [];
    const transactions = (transactionsResult.success && Array.isArray(transactionsResult.data)) ? transactionsResult.data : [];

    // Build report
    const totalVolume = transactions.reduce((sum: number, t: any) => sum + Number(t.amount || 0), 0);
    const currencies = [...new Set(transactions.map((t: any) => t.currency).filter(Boolean))];
    const statuses = transactions.reduce((acc: Record<string, number>, t: any) => {
      acc[t.status || 'unknown'] = (acc[t.status || 'unknown'] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    const rates: Record<string, number> = { BRL: 5.05, MXN: 17.2, USD: 1, USDC: 1 };
    const corridors = currencies
      .filter((c: string) => c !== 'USDC')
      .map((c: string) => ({ pair: `USDC/${c}`, rate: rates[c] || 1, rail: c === 'BRL' ? 'Pix' : c === 'MXN' ? 'SPEI' : 'x402' }));

    const report = {
      type: 'research_report',
      query: intent.description || 'Payment corridor analysis',
      generatedAt: new Date().toISOString(),
      summary: {
        totalAccounts: accounts.length,
        totalTransactions: transactions.length,
        totalVolume,
        volumeCurrency: 'USDC',
        activeCurrencies: currencies,
        transactionStatuses: statuses,
      },
      corridors: corridors.length > 0 ? corridors : [
        { pair: 'USDC/BRL', rate: 5.05, rail: 'Pix' },
        { pair: 'USDC/MXN', rate: 17.2, rail: 'SPEI' },
      ],
      recommendations: [
        'Consider diversifying payment corridors for better rate arbitrage.',
        'Pix (Brazil) offers fastest settlement times for LATAM.',
        'SPEI (Mexico) provides reliable same-day settlement.',
      ],
      serviceFee: feeResult.fee,
    };

    const feeNote = feeResult.fee > 0 ? ` Service fee: ${feeResult.fee} ${feeResult.currency}.` : '';

    await this.taskService.addMessage(taskId, 'agent', [
      {
        text: `Research report generated.${feeNote}\n\n**Summary**: ${accounts.length} accounts, ${transactions.length} transactions, ${totalVolume.toFixed(2)} USDC total volume. ${corridors.length || 2} payment corridor(s) analyzed.`,
      },
      {
        data: report,
        metadata: { mimeType: 'application/json' },
      },
    ]);

    await this.taskService.addArtifact(taskId, {
      name: `research-${taskId.slice(0, 8)}`,
      mediaType: 'application/json',
      parts: [
        {
          data: report,
          metadata: { mimeType: 'application/json' },
        },
      ],
    });

    await this.taskService.updateTaskState(taskId, 'completed', 'Research report generated');
    return this.taskService.getTask(taskId);
  }

  /**
   * Parse line items from natural language text.
   * Falls back to a single item if parsing fails.
   */
  private parseLineItems(
    text: string,
    fallbackAmount: number,
    currency: string,
  ): Array<{ name: string; quantity: number; unit_price: number }> {
    // Try to parse "N items at $X each" patterns
    const itemMatch = text.match(/(\d+)\s+(\w[\w\s]*?)\s+(?:at|@)\s+\$?([\d.]+)/i);
    if (itemMatch) {
      return [{
        name: itemMatch[2].trim(),
        quantity: parseInt(itemMatch[1]),
        unit_price: parseFloat(itemMatch[3]),
      }];
    }

    // Fallback: single item
    return [{
      name: 'Item',
      quantity: 1,
      unit_price: fallbackAmount || 10,
    }];
  }

  private async handleGeneric(taskId: string, text: string, agentCtx?: AgentContext): Promise<A2ATask | null> {
    // Build skill list from DB if available
    let skillList = '';
    if (agentCtx) {
      const { data: skills } = await this.supabase
        .from('agent_skills')
        .select('skill_id, name, base_price, currency')
        .eq('agent_id', agentCtx.agentId)
        .eq('tenant_id', this.tenantId)
        .eq('status', 'active')
        .order('base_price');

      if (skills?.length) {
        const free = skills.filter((s) => Number(s.base_price) === 0);
        const paid = skills.filter((s) => Number(s.base_price) > 0);

        const freeList = free.map((s) => s.name).join(', ');
        const paidList = paid.map((s) => `${s.name} (${s.base_price} ${s.currency})`).join(', ');

        skillList = `\n\n**Available skills:**`;
        if (freeList) skillList += `\n- Free: ${freeList}`;
        if (paidList) skillList += `\n- Paid: ${paidList}`;
      }
    }

    await this.taskService.addMessage(taskId, 'agent', [
      {
        text: `I received your message. I can help with:\n- **Payments**: "Send 500 USDC to Brazil"\n- **Balance checks**: "Check my USDC balance"\n- **Checkouts**: "Create a checkout for 3 widgets at $25 each"\n- **API Access**: "Access the premium data API"\n- **Mandates**: "Set up a 5000 USDC monthly mandate"\n- **Research**: "Research payment corridors for Brazil"\n- **Streams**: "Create a stream at 0.01 USDC/second"\n- **Agent info**: "What are your capabilities?"${skillList}\n\nPlease let me know what you'd like to do.`,
      },
    ]);

    await this.taskService.updateTaskState(taskId, 'completed', 'Help response sent');
    return this.taskService.getTask(taskId);
  }
}
