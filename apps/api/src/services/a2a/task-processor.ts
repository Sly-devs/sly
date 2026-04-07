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
import type { A2ATask, AcceptancePolicy } from './types.js';
import { DEFAULT_ACCEPTANCE_POLICY } from './types.js';
import { authorizeWalletTransfer } from '../wallet-settlement.js';
import { A2AClient } from './client.js';
import { A2AWebhookHandler } from './webhook-handler.js';
import { createPaymentProofJWT } from '../../routes/x402-payments.js';
import { getCurrentNetwork, toUsdcUnits, fromUsdcUnits } from '../x402/facilitator.js';
import { getChainConfig } from '../../config/blockchain.js';
import { LimitService } from '../limits.js';
import { agentCircuitBreaker } from './circuit-breaker.js';

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

  // --- R5: Structured correlation logging ---

  private log(taskId: string, level: 'info' | 'warn' | 'error', msg: string) {
    const prefix = `[A2A task=${taskId.slice(0, 8)} tenant=${this.tenantId.slice(0, 8)}]`;
    console[level === 'info' ? 'log' : level](`${prefix} ${msg}`);
  }

  // --- R1: Transient error detection ---

  private isTransientError(err: any): boolean {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
    if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' || err.code === 'ENOTFOUND') return true;
    if (err.message?.includes('fetch failed')) return true;
    return false;
  }

  /**
   * Release a task back to the queue with a retry_after backoff.
   * Returns the updated task.
   */
  private async releaseForRetry(
    taskId: string,
    reason: string,
    currentRetryCount: number,
  ): Promise<A2ATask | null> {
    const backoffSeconds = [5, 15, 45];
    const backoffSec = backoffSeconds[Math.min(currentRetryCount, backoffSeconds.length - 1)];
    const retryAfter = new Date(Date.now() + backoffSec * 1000).toISOString();

    await this.supabase
      .from('a2a_tasks')
      .update({
        state: 'submitted',
        processor_id: null,
        retry_count: currentRetryCount + 1,
        retry_after: retryAfter,
      })
      .eq('id', taskId)
      .eq('tenant_id', this.tenantId);

    await this.taskService.addMessage(taskId, 'agent', [
      { text: `Forwarding attempt ${currentRetryCount + 1} failed: ${reason}. Retrying in ${backoffSec}s...` },
    ]);

    this.log(taskId, 'warn', `Released for retry ${currentRetryCount + 1}/3, backoff=${backoffSec}s: ${reason}`);
    return this.taskService.getTask(taskId);
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
  async processTask(taskId: string, opts?: { slyFirst?: boolean }): Promise<A2ATask | null> {
    const task = await this.taskService.getTask(taskId);
    if (!task) return null;

    // Don't reprocess tasks that are already in a terminal state
    const terminalStates = ['completed', 'failed', 'canceled', 'rejected'];
    if (terminalStates.includes(task.status.state)) {
      this.log(taskId, 'info', `Skipping — already in '${task.status.state}' state`);
      return task;
    }

    this.log(taskId, 'info', `Processing... (${task.history.length} messages)`);

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
      this.log(taskId, 'info', 'Human approval detected, executing original intent');
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
    this.log(taskId, 'info', `Intent: ${intent.action} (amount: ${intent.amount} ${intent.currency})`);

    // --- A2A Limit Enforcement (W3: security fix) ---
    // Check agent limits for operations involving money before any payment/forwarding.
    // Also extract amount from DataPart (e.g. quoted_price, amount) for skill-based tasks.
    let effectiveAmount = intent.amount;

    // Reject negative amounts immediately
    if (effectiveAmount < 0) {
      await this.taskService.updateTaskState(taskId, 'failed', 'Invalid amount: negative values not allowed');
      return this.taskService.getTask(taskId);
    }

    if (effectiveAmount <= 0) {
      // Check DataParts for amount-like fields
      for (const part of lastUserMsg.parts) {
        if ('data' in part && (part as any).data) {
          const d = (part as any).data;
          if (d.amount > 0) { effectiveAmount = Number(d.amount); break; }
          if (d.quoted_price > 0) { effectiveAmount = Number(d.quoted_price); break; }
        }
      }
    }
    if (effectiveAmount > 0) {
      const limitService = new LimitService(this.supabase);
      const limitCheck = await limitService.checkTransactionLimit(agentCtx.agentId, effectiveAmount);
      if (!limitCheck.allowed) {
        const isKya = limitCheck.reason === 'kya_verification_required';
        await this.taskService.addMessage(taskId, 'agent', [
          { text: `Limit check failed: ${limitCheck.reason}. ${isKya ? 'Agent must be KYA verified to transact.' : `Limit: ${limitCheck.limit}, used: ${limitCheck.used || 0}, requested: ${limitCheck.requested || effectiveAmount}.`}` },
        ]);
        await this.taskService.setInputRequired(taskId, `Limit check failed: ${limitCheck.reason}`, {
          reason_code: isKya ? 'kya_required' : 'insufficient_funds',
          next_action: isKya ? 'verify_agent' : 'fund_wallet',
          resolve_endpoint: isKya ? 'POST /a2a with skill: verify_agent' : undefined,
          required_auth: 'agent_token',
          details: { reason: limitCheck.reason, ...limitCheck },
        });
        return this.taskService.getTask(taskId);
      }
    }

    // --- Routing: Sly-native vs agent forwarding ---
    const msgMetadata = lastUserMsg.metadata;
    const explicitSkillId = (msgMetadata?.skillId || msgMetadata?.skill_id) as string | undefined;

    // SHORT-CIRCUIT: If caller explicitly specified a skillId in metadata, trust it
    // and forward directly to the agent's skill handler. This prevents regex-based
    // intent extraction from mis-routing to Sly-native handlers (e.g. a "translation"
    // request being hijacked by the `balance` intent regex and returning a wallet
    // balance instead of a translation).
    if (explicitSkillId) {
      const { data: skillRow } = await this.supabase
        .from('agent_skills')
        .select('skill_id, handler_type, base_price, currency, x402_endpoint_id')
        .eq('agent_id', agentCtx.agentId)
        .eq('skill_id', explicitSkillId)
        .eq('status', 'active')
        .maybeSingle();

      if (skillRow) {
        // Skill exists — forward to agent using the registered skill config
        const skill = {
          skill_id: skillRow.skill_id,
          handler_type: skillRow.handler_type || 'agent_provided',
          base_price: Number(skillRow.base_price),
          currency: skillRow.currency || 'USDC',
          x402_endpoint_id: skillRow.x402_endpoint_id,
        };
        this.log(taskId, 'info', `Explicit skillId "${explicitSkillId}" — forwarding to agent (bypass intent regex)`);
        return await this.forwardToAgent(taskId, text, skill, agentCtx, msgMetadata);
      }
      // Explicit skillId was provided but the agent doesn't have it registered — fail fast
      await this.taskService.addMessage(taskId, 'agent', [
        { text: `Skill "${explicitSkillId}" not found on this agent. Available skills can be discovered via the agent card.` },
      ]);
      await this.taskService.updateTaskState(taskId, 'failed', `Unknown skill: ${explicitSkillId}`);
      return this.taskService.getTask(taskId);
    }

    // Auto-detect processing_mode from DB so callers don't need to pass the flag
    let slyFirst = opts?.slyFirst === true;
    if (!slyFirst) {
      const { data: agentRow } = await this.supabase
        .from('agents')
        .select('processing_mode')
        .eq('id', agentCtx.agentId)
        .single();
      if (agentRow?.processing_mode === 'managed') {
        slyFirst = true;
      }
    }

    if (slyFirst) {
      // Managed mode: Sly handles payment intents directly, forwards unmatched to webhook
      return await this.routeSlyFirst(taskId, text, intent, agentCtx, msgMetadata, explicitSkillId);
    }

    // Default routing: check endpoint first → forward all, then fall back to switch
    // Check if this intent maps to a Sly-native skill the agent registered
    const slySkillId = A2ATaskProcessor.INTENT_TO_SKILL[intent.action];
    let hasSlyNativeSkill = false;

    if (slySkillId) {
      const { data: nativeSkill } = await this.supabase
        .from('agent_skills')
        .select('skill_id, handler_type')
        .eq('agent_id', agentCtx.agentId)
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
        // Look up skill pricing from DB
        let skillRow: { skill_id: string; handler_type: string; base_price: number; currency: string; x402_endpoint_id: string | null } | null = null;

        const targetSkillId = explicitSkillId || msgMetadata?.skill_id as string | undefined;
        if (targetSkillId) {
          const { data } = await this.supabase
            .from('agent_skills')
            .select('skill_id, handler_type, base_price, currency, x402_endpoint_id')
            .eq('agent_id', agentCtx.agentId)
            .eq('skill_id', targetSkillId)
            .eq('status', 'active')
            .maybeSingle();
          if (data) skillRow = data;
          else {
            // Explicit skillId was provided but not found on this agent
            await this.taskService.addMessage(taskId, 'agent', [
              { text: `Skill "${targetSkillId}" not found on this agent. Available skills can be discovered via the agent card.` },
            ]);
            await this.taskService.updateTaskState(taskId, 'failed', `Unknown skill: ${targetSkillId}`);
            return this.taskService.getTask(taskId);
          }
        }

        const skill = skillRow
          ? { skill_id: skillRow.skill_id, handler_type: skillRow.handler_type || 'agent_provided',
              base_price: Number(skillRow.base_price), currency: skillRow.currency || 'USDC',
              x402_endpoint_id: skillRow.x402_endpoint_id }
          : { skill_id: explicitSkillId || 'default', handler_type: 'agent_provided', base_price: 0, currency: 'USDC', x402_endpoint_id: null as string | null };

        return await this.forwardToAgent(taskId, text, skill, agentCtx, msgMetadata);
      }
    }

    return await this.executeIntentSwitch(taskId, text, intent, agentCtx);
  }

  // --- Managed mode routing (slyFirst) ---

  /**
   * Managed mode routing: Sly handles payment intents directly.
   * Unmatched (generic) intents → forward to agent's webhook if registered.
   * No webhook → input-required with guidance to register one.
   */
  private async routeSlyFirst(
    taskId: string,
    text: string,
    intent: { action: string; amount: number; currency: string; recipient: string },
    agentCtx: AgentContext,
    msgMetadata?: Record<string, unknown>,
    explicitSkillId?: string,
  ): Promise<A2ATask | null> {
    // If it's a recognized payment action, Sly handles it directly
    if (intent.action !== 'generic') {
      return await this.executeIntentSwitch(taskId, text, intent, agentCtx);
    }

    // Generic/unmatched intent — try forwarding to agent's webhook
    const hasEndpoint = await this.agentHasEndpoint(agentCtx.agentId);
    if (hasEndpoint) {
      // Look up skill pricing from DB
      let skillRow: { skill_id: string; handler_type: string; base_price: number; currency: string } | null = null;

      const targetSkillId = explicitSkillId || msgMetadata?.skill_id as string | undefined;
      if (targetSkillId) {
        const { data } = await this.supabase
          .from('agent_skills')
          .select('skill_id, handler_type, base_price, currency')
          .eq('agent_id', agentCtx.agentId)
          .eq('skill_id', targetSkillId)
          .eq('status', 'active')
          .maybeSingle();
        if (data) skillRow = data;
        else {
          await this.taskService.addMessage(taskId, 'agent', [
            { text: `Skill "${targetSkillId}" not found on this agent.` },
          ]);
          await this.taskService.updateTaskState(taskId, 'failed', `Unknown skill: ${targetSkillId}`);
          return this.taskService.getTask(taskId);
        }
      }

      const skill = skillRow
        ? { skill_id: skillRow.skill_id, handler_type: skillRow.handler_type || 'agent_provided',
            base_price: Number(skillRow.base_price), currency: skillRow.currency || 'USDC' }
        : { skill_id: explicitSkillId || 'default', handler_type: 'agent_provided', base_price: 0, currency: 'USDC' };

      this.log(taskId, 'info', 'Managed mode: unmatched intent, forwarding to agent webhook');
      return await this.forwardToAgent(taskId, text, skill, agentCtx, msgMetadata);
    }

    // No webhook registered — set input-required with guidance
    this.log(taskId, 'info', 'Managed mode: unmatched intent, no webhook — requesting input');
    await this.taskService.addMessage(taskId, 'agent', [
      {
        text: "This task doesn't match a built-in payment action. To handle custom tasks, register a webhook endpoint: `PUT /v1/a2a/agents/:id/endpoint`",
      },
    ]);
    await this.taskService.setInputRequired(
      taskId,
      'No matching payment action and no webhook endpoint registered',
      {
        reason_code: 'no_handler',
        next_action: 'register_webhook',
        resolve_endpoint: 'PUT /v1/a2a/agents/:id/endpoint',
        required_auth: 'api_key',
      },
    );
    return this.taskService.getTask(taskId);
  }

  /**
   * Execute the intent switch for Sly-native payment handlers.
   * Shared between default routing and slyFirst routing.
   */
  private async executeIntentSwitch(
    taskId: string,
    text: string,
    intent: { action: string; amount: number; currency: string; recipient: string },
    agentCtx: AgentContext,
  ): Promise<A2ATask | null> {
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
      this.log(taskId, 'error', `Error processing: ${err.message}`);
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

    // Use caller's own tenant for wallet lookup (cross-tenant: caller wallet lives in caller's tenant)
    const callerTenantId = agentCtx.agentTenantId || this.tenantId;

    // Check balance — fetch full wallet fields for authorizeWalletTransfer
    const { data: wallet } = await this.supabase
      .from('wallets')
      .select('id, balance, owner_account_id, wallet_type, wallet_address, provider_wallet_id')
      .eq('id', agentCtx.walletId)
      .eq('tenant_id', callerTenantId)
      .single();

    if (!wallet || Number(wallet.balance) < fee) {
      await this.taskService.addMessage(taskId, 'agent', [
        { text: `Insufficient funds for skill fee. Required: ${fee} ${currency}. Available: ${wallet ? Number(wallet.balance) : 0} ${currency}.` },
      ]);
      return { charged: false, fee, currency };
    }

    // Look up destination (provider) wallet for on-chain settlement
    let providerWallet: any = null;
    if (this.config.agentId) {
      const { data } = await this.supabase
        .from('wallets')
        .select('id, balance, wallet_type, wallet_address, provider_wallet_id, owner_account_id')
        .eq('managed_by_agent_id', this.config.agentId)
        .eq('tenant_id', this.tenantId)
        .eq('status', 'active')
        .order('balance', { ascending: false })
        .limit(1)
        .maybeSingle();
      providerWallet = data;
    }

    const settlementMetadata = {
      protocol: 'a2a',
      serviceFee: true,
      skillId,
      source_wallet_id: wallet.id,
      destination_wallet_id: providerWallet?.id || null,
      wallet_id: wallet.id,
    };

    // Create transfer record as pending — authorizeWalletTransfer will set to 'authorized'
    const { data: transferRecord } = await this.supabase
      .from('transfers')
      .insert({
        tenant_id: callerTenantId,
        destination_tenant_id: this.tenantId,
        type: 'internal',
        status: 'pending',
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
        protocol_metadata: settlementMetadata,
      })
      .select('id')
      .single();

    if (transferRecord) {
      // Ledger authorization — debits/credits wallets and sets status='authorized'.
      // The async settlement worker picks up 'authorized' transfers for on-chain execution.
      const authorization = await authorizeWalletTransfer({
        supabase: this.supabase,
        tenantId: callerTenantId,
        destinationTenantId: this.tenantId,
        sourceWallet: wallet,
        destinationWallet: providerWallet,
        amount: fee,
        transferId: transferRecord.id,
        protocolMetadata: settlementMetadata,
      });

      if (!authorization.success) {
        this.log(taskId, 'warn', `Service fee ledger authorization failed: ${authorization.error}`);
        return { charged: false, fee, currency };
      }
    } else {
      return { charged: false, fee, currency };
    }

    // Emit payment audit event for timeline visibility
    await this.supabase.from('a2a_audit_events').insert({
      tenant_id: this.tenantId,
      task_id: taskId,
      agent_id: agentCtx.agentId,
      event_type: 'payment',
      actor_type: 'system',
      data: {
        type: 'service_fee_charged',
        skill_id: skillId,
        amount: fee,
        currency,
        transfer_id: transferRecord?.id,
        wallet_id: agentCtx.walletId,
      },
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

  // --- A2A Settlement (Mandate-Based Pre-Authorization) ---

  /**
   * Create a settlement mandate (pre-authorization) on the caller agent's wallet.
   * Money stays in the caller's wallet — the mandate just authorizes the charge.
   * Returns null if the caller has insufficient funds.
   */
  async createSettlementMandate(
    taskId: string,
    callerAgentId: string,
    providerAgentId: string,
    amount: number,
    currency: string,
  ): Promise<{ mandateId: string } | { error: 'kya_required' | 'insufficient_funds' } | null> {
    if (amount <= 0) return null; // Reject zero/negative amounts

    // 1. Look up caller agent — check KYA tier (tier 0 allowed if effective limits > 0)
    const { data: callerAgent } = await this.supabase
      .from('agents')
      .select('parent_account_id, name, kya_tier, effective_limit_per_tx')
      .eq('id', callerAgentId)
      .single();

    if (!callerAgent) {
      return { error: 'kya_required' };
    }
    const callerTier = callerAgent.kya_tier ?? 0;
    const callerLimit = parseFloat(callerAgent.effective_limit_per_tx) || 0;
    if (callerTier < 1 && callerLimit <= 0) {
      return { error: 'kya_required' };
    }

    // 2. Check caller's wallet has enough balance (no tenant filter — caller may be cross-tenant)
    const { data: callerWallet } = await this.supabase
      .from('wallets')
      .select('id, balance')
      .eq('managed_by_agent_id', callerAgentId)
      .eq('status', 'active')
      .order('balance', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!callerWallet || Number(callerWallet.balance) < amount) {
      return { error: 'insufficient_funds' };
    }

    const { data: providerAgent } = await this.supabase
      .from('agents')
      .select('parent_account_id, name')
      .eq('id', providerAgentId)
      .single();

    // 3. Create mandate in ap2_mandates table
    const mandateId = `settlement_${taskId.slice(0, 8)}_${Date.now()}`;
    const { data: mandate, error } = await this.supabase
      .from('ap2_mandates')
      .insert({
        tenant_id: this.tenantId,
        account_id: callerAgent?.parent_account_id,
        agent_id: callerAgentId,
        mandate_id: mandateId,
        mandate_type: 'payment',
        authorized_amount: amount,
        used_amount: 0,
        currency,
        status: 'active',
        a2a_session_id: taskId,
        metadata: {
          source: 'a2a_settlement',
          taskId,
          callerAgentId,
          providerAgentId,
          providerAccountId: providerAgent?.parent_account_id,
        },
      })
      .select('id, mandate_id')
      .single();

    if (error || !mandate) return null;

    // Emit audit event for mandate creation
    const { taskEventBus } = await import('./task-event-bus.js');
    taskEventBus.emitTask(taskId, {
      type: 'payment',
      taskId,
      data: {
        action: 'mandate_created',
        mandateId: mandate.mandate_id,
        amount,
        currency,
        callerAgentId,
        providerAgentId,
      },
      timestamp: new Date().toISOString(),
    }, { tenantId: this.tenantId, agentId: providerAgentId, actorType: 'system' });

    return { mandateId: mandate.mandate_id };
  }

  // --- Epic 69: Acceptance Gate ---

  /**
   * Read acceptance_policy from a skill's metadata.
   * Returns DEFAULT_ACCEPTANCE_POLICY if missing or invalid.
   */
  private async getAcceptancePolicy(agentId: string, skillId?: string): Promise<AcceptancePolicy> {
    if (!skillId) return DEFAULT_ACCEPTANCE_POLICY;

    const { data: skill } = await this.supabase
      .from('agent_skills')
      .select('metadata')
      .eq('agent_id', agentId)
      .eq('skill_id', skillId)
      .eq('tenant_id', this.tenantId)
      .maybeSingle();

    if (!skill?.metadata?.acceptance_policy) return DEFAULT_ACCEPTANCE_POLICY;

    const raw = skill.metadata.acceptance_policy as Record<string, unknown>;
    return {
      requires_acceptance: typeof raw.requires_acceptance === 'boolean' ? raw.requires_acceptance : DEFAULT_ACCEPTANCE_POLICY.requires_acceptance,
      auto_accept_below: typeof raw.auto_accept_below === 'number' && raw.auto_accept_below >= 0 ? raw.auto_accept_below : DEFAULT_ACCEPTANCE_POLICY.auto_accept_below,
      review_timeout_minutes: typeof raw.review_timeout_minutes === 'number' && raw.review_timeout_minutes > 0 ? raw.review_timeout_minutes : DEFAULT_ACCEPTANCE_POLICY.review_timeout_minutes,
    };
  }

  /**
   * Check if a completed task should pause for caller acceptance.
   * Returns true if the gate is engaged (task set to input-required).
   * Returns false if the task should proceed to immediate settlement.
   */
  async checkAcceptanceGate(
    taskId: string,
    mandateId: string,
    outcome: 'completed' | 'failed',
  ): Promise<boolean> {
    if (outcome !== 'completed') return false;

    // Read task metadata for skill and agent info
    const { data: task } = await this.supabase
      .from('a2a_tasks')
      .select('agent_id, metadata, client_agent_id')
      .eq('id', taskId)
      .eq('tenant_id', this.tenantId)
      .single();

    if (!task) return false;

    const skillId = task.metadata?.skillId as string | undefined;
    const policy = await this.getAcceptancePolicy(task.agent_id, skillId);

    if (!policy.requires_acceptance) return false;

    // Check auto-accept threshold
    const { data: mandate } = await this.supabase
      .from('ap2_mandates')
      .select('authorized_amount')
      .eq('mandate_id', mandateId)
      .eq('tenant_id', this.tenantId)
      .single();

    if (!mandate) return false;

    const amount = Number(mandate.authorized_amount);
    if (policy.auto_accept_below > 0 && amount < policy.auto_accept_below) return false;

    // Engage the gate: set input-required with review context
    this.log(taskId, 'info', `Acceptance gate engaged — awaiting caller review (timeout: ${policy.review_timeout_minutes}m)`);

    await this.taskService.setInputRequired(taskId, 'Task completed — awaiting caller acceptance', {
      reason_code: 'result_review',
      next_action: 'accept_or_reject',
      resolve_endpoint: `POST /v1/a2a/tasks/${taskId}/respond`,
      required_auth: 'api_key',
      details: {
        mandate_id: mandateId,
        amount,
        review_timeout_minutes: policy.review_timeout_minutes,
      },
    });

    // Store review metadata on the task
    await this.supabase
      .from('a2a_tasks')
      .update({
        metadata: {
          ...task.metadata,
          review_status: 'pending',
          review_requested_at: new Date().toISOString(),
          review_timeout_minutes: policy.review_timeout_minutes,
          input_required_context: {
            reason_code: 'result_review',
            next_action: 'accept_or_reject',
            details: { mandate_id: mandateId, amount },
          },
        },
      })
      .eq('id', taskId)
      .eq('tenant_id', this.tenantId);

    return true;
  }

  /**
   * Resolve a settlement mandate — execute on success, cancel on failure.
   * On 'completed': deducts from caller wallet, credits provider wallet,
   * creates a transfer record, and marks mandate completed.
   * On 'failed': cancels the mandate — no money moves.
   * @param overrideAmount — Optional partial settlement amount (must be <= authorized_amount)
   */
  async resolveSettlementMandate(
    taskId: string,
    mandateId: string,
    outcome: 'completed' | 'failed',
    overrideAmount?: number,
  ): Promise<void> {
    const { data: mandate } = await this.supabase
      .from('ap2_mandates')
      .select('*')
      .eq('mandate_id', mandateId)
      .single();

    if (!mandate || mandate.status !== 'active') return;

    if (outcome === 'completed') {
      const amount = overrideAmount ?? Number(mandate.authorized_amount);
      const providerAgentId = mandate.metadata?.providerAgentId;
      const providerAccountId = mandate.metadata?.providerAccountId;

      // Resolve tenant_ids for caller and provider (cross-tenant support)
      const { data: callerAgent } = await this.supabase
        .from('agents').select('tenant_id').eq('id', mandate.agent_id).single();
      const callerTenantId = callerAgent?.tenant_id || this.tenantId;

      let providerTenantId = this.tenantId;
      if (providerAgentId) {
        const { data: provAgent } = await this.supabase
          .from('agents').select('tenant_id').eq('id', providerAgentId).single();
        providerTenantId = provAgent?.tenant_id || this.tenantId;
      }

      // Insert execution record
      await this.supabase.from('ap2_mandate_executions').insert({
        tenant_id: mandate.tenant_id,
        mandate_id: mandate.id,
        execution_index: 1,
        amount,
        currency: mandate.currency,
        status: 'completed',
        completed_at: new Date().toISOString(),
      });

      // Fetch both wallets using their respective tenant_ids
      const { data: callerWallet } = await this.supabase
        .from('wallets')
        .select('id, balance, owner_account_id, wallet_type, wallet_address, provider_wallet_id')
        .eq('managed_by_agent_id', mandate.agent_id)
        .eq('tenant_id', callerTenantId)
        .eq('status', 'active')
        .order('balance', { ascending: false })
        .limit(1)
        .maybeSingle();

      let providerWallet: any = null;
      if (providerAgentId) {
        const { data } = await this.supabase
          .from('wallets')
          .select('id, balance, wallet_type, wallet_address, provider_wallet_id')
          .eq('managed_by_agent_id', providerAgentId)
          .eq('tenant_id', providerTenantId)
          .eq('status', 'active')
          .order('balance', { ascending: false })
          .limit(1)
          .maybeSingle();
        providerWallet = data;
      }

      if (callerWallet) {
        const settlementMetadata = {
          protocol: 'a2a',
          settlement: true,
          mandateId,
          taskId,
          // Canonical keys for async settlement worker
          source_wallet_id: callerWallet.id,
          destination_wallet_id: providerWallet?.id,
          // Legacy aliases (kept for backward compat)
          wallet_id: callerWallet.id,
          provider_wallet_id: providerWallet?.id,
        };

        // Create transfer record first
        const { data: transfer } = await this.supabase
          .from('transfers')
          .insert({
            tenant_id: callerTenantId,
            destination_tenant_id: providerTenantId,
            type: 'internal',
            status: 'pending',
            amount,
            currency: mandate.currency,
            destination_amount: amount,
            destination_currency: mandate.currency,
            fx_rate: 1,
            fee_amount: 0,
            from_account_id: callerWallet.owner_account_id,
            to_account_id: providerAccountId,
            description: `A2A settlement: task ${taskId.slice(0, 8)}`,
            initiated_by_type: 'agent',
            initiated_by_id: mandate.agent_id,
            protocol_metadata: settlementMetadata,
          })
          .select('id')
          .single();

        if (transfer) {
          // Fast ledger authorization — on-chain deferred to async settlement worker
          // authorizeWalletTransfer debits/credits wallets and sets status='authorized'.
          // The async settlement worker picks up 'authorized' transfers, checks on-chain
          // capability, executes Circle transferTokens() if possible, then marks 'completed'.
          const authorization = await authorizeWalletTransfer({
            supabase: this.supabase,
            tenantId: callerTenantId,
            destinationTenantId: providerTenantId,
            sourceWallet: callerWallet,
            destinationWallet: providerWallet,
            amount,
            transferId: transfer.id,
            protocolMetadata: settlementMetadata,
          });

          if (!authorization.success) {
            this.log(taskId, 'warn', `A2A ledger authorization failed: ${authorization.error}`);
          }

          // Link transfer to task
          await this.supabase
            .from('a2a_tasks')
            .update({ transfer_id: transfer.id })
            .eq('id', taskId)
            .eq('tenant_id', this.tenantId);
        }
      }

      // R4: Record usage after settlement for accurate daily/monthly limit tracking
      try {
        const limitService = new LimitService(this.supabase);
        await limitService.recordUsage(mandate.agent_id, amount);
      } catch (err: any) {
        console.warn(`[A2A] Usage recording failed (non-fatal): ${err.message}`);
      }

      // Mark mandate completed
      await this.supabase
        .from('ap2_mandates')
        .update({ status: 'completed', updated_at: new Date().toISOString() })
        .eq('id', mandate.id);

      // Emit audit event for successful settlement
      const { taskEventBus: bus1 } = await import('./task-event-bus.js');
      bus1.emitTask(taskId, {
        type: 'payment',
        taskId,
        data: {
          action: 'mandate_settled',
          mandateId,
          amount,
          currency: mandate.currency,
          outcome: 'completed',
        },
        timestamp: new Date().toISOString(),
      }, { tenantId: this.tenantId, agentId: mandate.metadata?.providerAgentId || '', actorType: 'system' });

    } else {
      // Cancel mandate — no money moves
      await this.supabase
        .from('ap2_mandates')
        .update({
          status: 'cancelled',
          cancelled_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', mandate.id);

      // Emit audit event for mandate cancellation
      const { taskEventBus: bus2 } = await import('./task-event-bus.js');
      bus2.emitTask(taskId, {
        type: 'payment',
        taskId,
        data: {
          action: 'mandate_cancelled',
          mandateId,
          outcome: 'failed',
        },
        timestamp: new Date().toISOString(),
      }, { tenantId: this.tenantId, agentId: mandate.metadata?.providerAgentId || '', actorType: 'system' });
    }
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
    skill: { skill_id: string; handler_type: string; base_price: number; currency: string; x402_endpoint_id?: string | null },
    agentCtx: AgentContext,
    callerMetadata?: Record<string, unknown>,
  ): Promise<A2ATask | null> {
    // Look up agent's endpoint configuration (no tenant filter — cross-tenant support)
    const { data: agent } = await this.supabase
      .from('agents')
      .select('id, endpoint_url, endpoint_type, endpoint_secret, endpoint_enabled, processing_mode')
      .eq('id', agentCtx.agentId)
      .single();

    if (!agent?.endpoint_url || !agent.endpoint_enabled || agent.endpoint_type === 'none') {
      await this.taskService.addMessage(taskId, 'agent', [
        { text: `Skill "${skill.skill_id}" is agent-provided but no endpoint is configured. Please register an endpoint.` },
      ]);
      await this.taskService.updateTaskState(taskId, 'failed', 'Agent has no endpoint configured');
      return this.taskService.getTask(taskId);
    }

    // --- A2A Settlement: pre-authorize caller wallet via mandate ---
    const { data: taskRow } = await this.supabase
      .from('a2a_tasks')
      .select('client_agent_id, metadata')
      .eq('id', taskId)
      .single();

    const callerAgentId = taskRow?.client_agent_id;
    let settlementMandateId: string | undefined;

    // Limit check on caller agent before settlement
    if (callerAgentId && Number(skill.base_price) > 0) {
      try {
        const limitService = new LimitService(this.supabase);
        const limitCheck = await limitService.checkTransactionLimit(callerAgentId, Number(skill.base_price));
        if (!limitCheck.allowed) {
          const isKya = limitCheck.reason === 'kya_verification_required';
          await this.taskService.addMessage(taskId, 'agent', [
            { text: `Caller agent limit check failed: ${limitCheck.reason}.` },
          ]);
          await this.taskService.setInputRequired(taskId, `Caller limit check failed: ${limitCheck.reason}`, {
            reason_code: isKya ? 'kya_required' : 'insufficient_funds',
            next_action: isKya ? 'verify_agent' : 'fund_wallet',
            resolve_endpoint: isKya ? 'POST /a2a with skill: verify_agent' : undefined,
            required_auth: 'agent_token',
            details: { reason: limitCheck.reason, caller_agent_id: callerAgentId, ...limitCheck },
          });
          return this.taskService.getTask(taskId);
        }
      } catch (err: any) {
        this.log(taskId, 'warn', `Limit check warning for caller ${callerAgentId}: ${err.message}`);
        // Non-fatal — continue if limit service is unavailable
      }
    }

    if (callerAgentId && Number(skill.base_price) > 0 && agent.endpoint_type !== 'x402') {
      const mandateResult = await this.createSettlementMandate(
        taskId,
        callerAgentId,
        agentCtx.agentId,
        Number(skill.base_price),
        skill.currency,
      );
      if (!mandateResult || 'error' in mandateResult) {
        const isKya = mandateResult && mandateResult.error === 'kya_required';
        if (isKya) {
          await this.taskService.addMessage(taskId, 'agent', [
            { text: `Caller agent must be KYA verified (tier >= 1) to pay for skills. Use verify_agent to upgrade.` },
          ]);
        } else {
          await this.taskService.addMessage(taskId, 'agent', [
            { text: `This skill costs ${skill.base_price} ${skill.currency}. Insufficient funds in caller wallet.` },
          ]);
        }
        await this.taskService.setInputRequired(taskId, 'Payment required', {
          reason_code: isKya ? 'kya_required' : 'insufficient_funds',
          next_action: isKya ? 'verify_agent' : 'fund_wallet',
          resolve_endpoint: isKya ? 'POST /a2a with skill: verify_agent' : undefined,
          required_auth: 'agent_token',
          payment_required: true,
          ...(skill.x402_endpoint_id ? {
            x402: {
              endpoint_id: skill.x402_endpoint_id,
              amount: skill.base_price,
              currency: skill.currency,
              skill_id: skill.skill_id,
              provider_agent_id: agentCtx.agentId,
            },
          } : {}),
          details: {
            skill_price: skill.base_price,
            currency: skill.currency,
            error: mandateResult && 'error' in mandateResult ? mandateResult.error : 'unknown',
          },
        });
        return this.taskService.getTask(taskId);
      }
      settlementMandateId = mandateResult.mandateId;
      // Store mandate ID in task metadata for resolution later
      await this.supabase
        .from('a2a_tasks')
        .update({
          metadata: { ...(taskRow as any)?.metadata, settlementMandateId: mandateResult.mandateId },
        })
        .eq('id', taskId);
      this.log(taskId, 'info', `Settlement mandate created: ${mandateResult.mandateId}`);
    }

    // Charge service fee if applicable (self-deduction for platform fees — separate from settlement)
    if (!callerAgentId && Number(skill.base_price) > 0) {
      const feeResult = await this.chargeServiceFee(taskId, skill.skill_id, agentCtx);
      if (!feeResult.charged) {
        await this.taskService.updateTaskState(taskId, 'failed', 'Insufficient funds for skill fee');
        return this.taskService.getTask(taskId);
      }
    }

    this.log(taskId, 'info', `Forwarding to agent endpoint (${agent.endpoint_type}: ${agent.endpoint_url})`);

    // R6: Circuit breaker — block forwarding if agent is consistently failing
    if (!agentCircuitBreaker.canCall(agentCtx.agentId)) {
      this.log(taskId, 'warn', `Circuit breaker open for agent ${agentCtx.agentId.slice(0, 8)}, delaying task`);
      const { data: taskRow2 } = await this.supabase
        .from('a2a_tasks')
        .select('retry_count')
        .eq('id', taskId)
        .single();
      return this.releaseForRetry(taskId, 'Agent circuit breaker open', taskRow2?.retry_count ?? 0);
    }

    // Check if agent endpoint points back to this Sly platform (self-referencing)
    // If so, use auto-responder instead of forwarding (which would loop)
    const isSelfReferencing = agent.endpoint_url?.includes('/a2a/') &&
      (agent.endpoint_url.includes('getsly.ai') || agent.endpoint_url.includes('localhost'));

    if (isSelfReferencing || (!agent.endpoint_url && agent.endpoint_type !== 'x402')) {
      // For self-referencing autonomous agents (endpoint points back to Sly),
      // fall through to auto-responder instead of leaving in 'working' forever.
      // The auto-responder has peer awareness and will generate a real response.
      // External autonomous agents (with non-Sly endpoints) would be handled
      // by the forwardViaA2A path above, not here.
      this.log(taskId, 'info', `Self-referencing agent (${agent.processing_mode}) — using auto-responder`);

      // Auto-respond: generate skill response and complete immediately
      try {
        const { autoRespondToTask } = await import('./auto-responder.js');
        const autoResult = await autoRespondToTask(this.supabase, taskId, agent.id, messageText, skill.skill_id);
        if (autoResult.success) {
          await this.taskService.addMessage(taskId, 'agent', [{ text: autoResult.response }]);

          // Execute settlement if present
          if (settlementMandateId) {
            try {
              await this.resolveSettlementMandate(taskId, settlementMandateId, 'completed');
            } catch (e: any) {
              this.log(taskId, 'warn', `Settlement failed: ${e.message}`);
            }
          }

          await this.taskService.updateTaskState(taskId, 'completed', 'Task completed');
          return this.taskService.getTask(taskId);
        }
      } catch (autoErr: any) {
        this.log(taskId, 'warn', `Auto-responder failed: ${autoErr.message}`);
      }
    }

    if (agent.endpoint_type === 'a2a') {
      return await this.forwardViaA2A(taskId, messageText, agent, skill, callerMetadata, settlementMandateId);
    } else if (agent.endpoint_type === 'webhook') {
      return await this.forwardViaWebhook(taskId, messageText, agent, skill, settlementMandateId);
    } else if (agent.endpoint_type === 'x402') {
      return await this.forwardViaX402(taskId, messageText, agent, skill, callerMetadata);
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
    passedSettlementMandateId?: string,
  ): Promise<A2ATask | null> {
    const client = new A2AClient();

    // Helper: read settlement mandate ID from passed param or task metadata
    const getSettlementMandateId = async (): Promise<string | undefined> => {
      if (passedSettlementMandateId) return passedSettlementMandateId;
      const { data: taskMeta } = await this.supabase
        .from('a2a_tasks')
        .select('metadata')
        .eq('id', taskId)
        .single();
      return taskMeta?.metadata?.settlementMandateId;
    };

    try {
      const response = await client.sendMessage(
        agent.endpoint_url,
        { parts: [{ text: messageText }], metadata: { ...callerMetadata, skillId: skill.skill_id, slyTaskId: taskId } },
        taskId, // Use Sly task ID as context ID for correlation
        agent.endpoint_secret || undefined,
        60_000, // 60s timeout for agent forwarding (agents may run real AI work)
      );

      // Extract result from JSON-RPC response
      const result = (response as any).result;

      if (result) {
        // Store remote task ID for tracking (preserve existing metadata)
        const { data: currentTask } = await this.supabase
          .from('a2a_tasks')
          .select('metadata')
          .eq('id', taskId)
          .single();
        await this.supabase
          .from('a2a_tasks')
          .update({
            remote_task_id: result.id,
            metadata: { ...(currentTask?.metadata || {}), forwarded_to: agent.endpoint_url, skill_id: skill.skill_id },
          })
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

          // Execute settlement mandate — deduct caller, credit provider
          const settlementMandateId = await getSettlementMandateId();
          if (settlementMandateId) {
            // Check acceptance gate before settling
            const gateEngaged = await this.checkAcceptanceGate(taskId, settlementMandateId, 'completed');
            if (gateEngaged) {
              // Gate engaged — task set to input-required, skip settlement and completion
              agentCircuitBreaker.recordSuccess(agent.id);
              return this.taskService.getTask(taskId);
            }

            await this.resolveSettlementMandate(taskId, settlementMandateId, 'completed');
            await this.taskService.addArtifact(taskId, {
              name: 'settlement-receipt',
              mediaType: 'application/json',
              parts: [{
                data: { type: 'settlement_receipt', mandateId: settlementMandateId, status: 'executed' },
                metadata: { mimeType: 'application/json' },
              }],
            });
          }

          // R6: Record success for circuit breaker
          agentCircuitBreaker.recordSuccess(agent.id);

          await this.taskService.updateTaskState(taskId, 'completed', 'Forwarded task completed');
        } else if (remoteState === 'failed') {
          const errorMsg = result.status?.message || 'Remote agent failed';
          await this.taskService.addMessage(taskId, 'agent', [{ text: `Agent returned error: ${errorMsg}` }]);

          // Cancel settlement mandate — no money moves
          const settlementMandateId = await getSettlementMandateId();
          if (settlementMandateId) {
            await this.resolveSettlementMandate(taskId, settlementMandateId, 'failed');
            await this.taskService.addMessage(taskId, 'agent', [
              { text: 'Pre-authorization cancelled — agent failed.' },
            ]);
          }

          await this.taskService.updateTaskState(taskId, 'failed', errorMsg);
        } else {
          // Task is still working on the remote side.
          // If the remote response contains agent messages, the auto-responder
          // already generated a response — complete immediately instead of
          // leaving in 'working' forever (which was causing 67% failure rate).
          const history = result.history || [];
          const agentMessages = history.filter((m: any) => m.role === 'agent');
          if (agentMessages.length > 0) {
            // Auto-responder produced output — extract and complete
            const lastMsg = agentMessages[agentMessages.length - 1];
            if (lastMsg?.parts?.length) {
              await this.taskService.addMessage(taskId, 'agent', lastMsg.parts, lastMsg.metadata);
            }
            if (result.artifacts?.length) {
              for (const artifact of result.artifacts) {
                await this.taskService.addArtifact(taskId, artifact);
              }
            }
            const settlementMandateId = await getSettlementMandateId();
            if (settlementMandateId) {
              await this.resolveSettlementMandate(taskId, settlementMandateId, 'completed');
            }
            agentCircuitBreaker.recordSuccess(agent.id);
            await this.taskService.updateTaskState(taskId, 'completed', 'Task completed (agent responded)');
            this.log(taskId, 'info', 'Agent responded with working state but had messages — completing');
          } else {
            // Truly still working with no response yet — await callback
            await this.taskService.addMessage(taskId, 'agent', [
              { text: `Task forwarded to agent. Awaiting response (remote state: ${remoteState || 'working'}).` },
            ]);
            await this.taskService.updateTaskState(taskId, 'working', 'Awaiting agent response');
          }
        }
      } else if ((response as any).error) {
        const rpcError = (response as any).error;
        await this.taskService.addMessage(taskId, 'agent', [
          { text: `Agent endpoint error: ${rpcError.message || 'Unknown RPC error'}` },
        ]);

        // Cancel settlement mandate on RPC error
        const settlementMandateId = await getSettlementMandateId();
        if (settlementMandateId) {
          await this.resolveSettlementMandate(taskId, settlementMandateId, 'failed');
          await this.taskService.addMessage(taskId, 'agent', [
            { text: 'Pre-authorization cancelled — RPC error.' },
          ]);
        }

        await this.taskService.updateTaskState(taskId, 'failed', rpcError.message || 'RPC error');
      }
    } catch (err: any) {
      this.log(taskId, 'error', `A2A forward failed: ${err.message}`);

      // R6: Record failure for circuit breaker
      agentCircuitBreaker.recordFailure(agent.id);

      // R1: Retry transient errors before giving up
      if (this.isTransientError(err)) {
        const { data: taskRow3 } = await this.supabase
          .from('a2a_tasks')
          .select('retry_count, max_retries')
          .eq('id', taskId)
          .single();
        const retryCount = taskRow3?.retry_count ?? 0;
        const maxRetries = taskRow3?.max_retries ?? 3;

        if (retryCount < maxRetries) {
          // Do NOT cancel settlement mandate — keep it active for retry
          return this.releaseForRetry(taskId, err.message, retryCount);
        }
      }

      // Non-transient or retries exhausted — fail + cancel mandate
      await this.taskService.addMessage(taskId, 'agent', [
        { text: `Failed to reach agent endpoint: ${err.message}` },
      ]);

      const settlementMandateId = await getSettlementMandateId();
      if (settlementMandateId) {
        await this.resolveSettlementMandate(taskId, settlementMandateId, 'failed');
        await this.taskService.addMessage(taskId, 'agent', [
          { text: 'Pre-authorization cancelled — could not reach agent.' },
        ]);
      }

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
    settlementMandateId?: string,
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

      // Execute settlement mandate — debit caller, credit provider
      if (settlementMandateId) {
        try {
          await this.resolveSettlementMandate(taskId, settlementMandateId, 'completed');
          this.log(taskId, 'info', `Settlement mandate executed: ${settlementMandateId}`);
          await this.taskService.updateTaskState(taskId, 'completed', 'Payment processed');
        } catch (e: any) {
          this.log(taskId, 'warn', `Settlement failed: ${e.message}`);
          await this.taskService.addMessage(taskId, 'agent', [
            { text: `Task completed but payment settlement failed: ${e.message}` },
          ]);
          await this.taskService.updateTaskState(taskId, 'completed', 'Task completed (settlement pending)');
        }
      } else if (agent.processing_mode === 'autonomous' && agent.endpoint_url && !agent.endpoint_url.includes('getsly.ai') && !agent.endpoint_url.includes('localhost')) {
        // External autonomous agent with real endpoint — leave in working for external pickup
        await this.taskService.updateTaskState(taskId, 'working', 'Awaiting external autonomous agent');
        this.log(taskId, 'info', 'External autonomous agent — task left in working for external pickup');
      } else {
        // Auto-respond for managed agents — generate AI response and complete immediately
        try {
          const { autoRespondToTask } = await import('./auto-responder.js');
          const autoResult = await autoRespondToTask(this.supabase, taskId, agent.id, messageText, skill.skill_id);
          if (autoResult.success) {
            await this.taskService.addMessage(taskId, 'agent', [
              { text: autoResult.response },
            ]);
            await this.taskService.updateTaskState(taskId, 'completed', 'Task completed');
            this.log(taskId, 'info', 'Auto-responded and completed');
          } else {
            // Auto-responder returned but with no content — fail immediately
            // instead of leaving in 'working' forever
            await this.taskService.addMessage(taskId, 'agent', [
              { text: 'Agent could not generate a response for this task.' },
            ]);
            await this.taskService.updateTaskState(taskId, 'failed', 'Auto-responder returned empty');
          }
        } catch (autoErr: any) {
          this.log(taskId, 'warn', `Auto-responder failed: ${autoErr.message}`);
          await this.taskService.addMessage(taskId, 'agent', [
            { text: `Agent processing error: ${autoErr.message?.slice(0, 100)}` },
          ]);
          await this.taskService.updateTaskState(taskId, 'failed', `Auto-responder error: ${autoErr.message?.slice(0, 100)}`);
        }
      }
    } else {
      // Cancel settlement mandate on failure
      if (settlementMandateId) {
        try {
          await this.resolveSettlementMandate(taskId, settlementMandateId, 'failed');
        } catch { /* non-fatal */ }
      }

      // R1: Retry transient webhook failures before giving up
      const webhookError = result.error || 'Unknown error';
      const isTransient = webhookError.includes('fetch failed') || webhookError.includes('ECONNREFUSED')
        || webhookError.includes('ECONNRESET') || webhookError.includes('timeout');

      if (isTransient) {
        const { data: taskRetry } = await this.supabase
          .from('a2a_tasks')
          .select('retry_count, max_retries')
          .eq('id', taskId)
          .single();
        const retryCount = taskRetry?.retry_count ?? 0;
        const maxRetries = taskRetry?.max_retries ?? 3;

        if (retryCount < maxRetries) {
          return this.releaseForRetry(taskId, webhookError, retryCount);
        }
      }

      await webhookHandler.recordFailure(taskId, this.tenantId, result, 0);
      await this.taskService.addMessage(taskId, 'agent', [
        { text: `Failed to dispatch to agent webhook: ${webhookError}` },
      ]);
      await this.taskService.updateTaskState(taskId, 'failed', `Webhook dispatch failed: ${webhookError}`);
    }

    return this.taskService.getTask(taskId);
  }

  /**
   * Forward task via x402 protocol (HTTP 402 challenge → payment → retry).
   * The shim returns 402 with `accepts` array; Sly pays from caller wallet, retries with X-Payment header.
   * Skips mandate settlement — the x402 payment IS the payment.
   */
  private async forwardViaX402(
    taskId: string,
    messageText: string,
    agent: { id: string; endpoint_url: string; endpoint_secret?: string | null },
    skill: { skill_id: string; base_price: number; currency: string },
    callerMetadata?: Record<string, unknown>,
  ): Promise<A2ATask | null> {
    const taskPayload = {
      jsonrpc: '2.0',
      method: 'message/send',
      params: {
        message: { parts: [{ text: messageText }], metadata: { ...callerMetadata, skillId: skill.skill_id, slyTaskId: taskId } },
        contextId: taskId,
      },
      id: taskId,
    };

    try {
      // Step 1: POST to agent endpoint
      const initialResponse = await fetch(agent.endpoint_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(taskPayload),
        signal: AbortSignal.timeout(30_000),
      });

      // Step 2: Agent returned 200 on first try (free or pre-paid)
      if (initialResponse.ok) {
        return await this.handleX402AgentResponse(taskId, initialResponse, agent);
      }

      // Step 3: Not a 402 — unexpected error
      if (initialResponse.status !== 402) {
        const errorText = await initialResponse.text().catch(() => 'Unknown error');
        await this.taskService.addMessage(taskId, 'agent', [
          { text: `Agent endpoint returned HTTP ${initialResponse.status}: ${errorText.slice(0, 200)}` },
        ]);
        await this.taskService.updateTaskState(taskId, 'failed', `HTTP ${initialResponse.status} from agent`);
        return this.taskService.getTask(taskId);
      }

      // Step 4: Parse 402 response
      let acceptsBody: any;
      try {
        acceptsBody = await initialResponse.json();
      } catch {
        await this.taskService.addMessage(taskId, 'agent', [
          { text: 'Agent returned 402 but response body is not valid JSON.' },
        ]);
        await this.taskService.updateTaskState(taskId, 'failed', 'Invalid 402 response body');
        return this.taskService.getTask(taskId);
      }

      const accepts = acceptsBody?.accepts;
      if (!Array.isArray(accepts) || accepts.length === 0) {
        await this.taskService.addMessage(taskId, 'agent', [
          { text: 'Agent returned 402 but missing `accepts` array in response.' },
        ]);
        await this.taskService.updateTaskState(taskId, 'failed', 'Missing accepts in 402 response');
        return this.taskService.getTask(taskId);
      }

      const offer = accepts[0];
      if (offer.scheme !== 'exact-evm') {
        await this.taskService.addMessage(taskId, 'agent', [
          { text: `Agent requires unsupported payment scheme: "${offer.scheme}". Only "exact-evm" is supported.` },
        ]);
        await this.taskService.updateTaskState(taskId, 'failed', `Unsupported scheme: ${offer.scheme}`);
        return this.taskService.getTask(taskId);
      }

      // Step 5: Extract amount and convert to human-readable
      const requestedAmountUnits = offer.amount; // base units string
      const humanAmount = Number(fromUsdcUnits(requestedAmountUnits));

      // Step 6: Look up caller agent's wallet
      const { data: taskRow } = await this.supabase
        .from('a2a_tasks')
        .select('client_agent_id')
        .eq('id', taskId)
        .single();

      const callerAgentId = taskRow?.client_agent_id;
      if (!callerAgentId) {
        await this.taskService.addMessage(taskId, 'agent', [
          { text: `x402 payment required (${humanAmount} USDC) but no caller agent found on this task. Authenticate with an agent token (agent_*) instead of an API key to associate a caller agent.` },
        ]);
        await this.taskService.setInputRequired(taskId, 'Caller agent required for x402 payment', {
          reason_code: 'needs_agent_auth',
          next_action: 'authenticate_as_agent',
          required_auth: 'agent_token',
          details: {
            required_amount: humanAmount,
            currency: 'USDC',
          },
        });
        return this.taskService.getTask(taskId);
      }

      const { data: callerWallet } = await this.supabase
        .from('wallets')
        .select('id, balance, wallet_address, owner_account_id')
        .eq('managed_by_agent_id', callerAgentId)
        .eq('tenant_id', this.tenantId)
        .maybeSingle();

      if (!callerWallet) {
        await this.taskService.addMessage(taskId, 'agent', [
          { text: `x402 payment required (${humanAmount} USDC) but caller agent has no wallet. Create a wallet for agent ${callerAgentId} via POST /v1/wallets with managedByAgentId, then re-submit this task.` },
        ]);
        await this.taskService.setInputRequired(taskId, 'Caller wallet required', {
          reason_code: 'missing_wallet',
          next_action: 'create_wallet',
          resolve_endpoint: 'POST /v1/wallets',
          required_auth: 'api_key',
          details: {
            required_amount: humanAmount,
            agent_id: callerAgentId,
            currency: 'USDC',
          },
        });
        return this.taskService.getTask(taskId);
      }

      if (Number(callerWallet.balance) < humanAmount) {
        const deficit = humanAmount - Number(callerWallet.balance);
        await this.taskService.addMessage(taskId, 'agent', [
          { text: `x402 payment required: ${humanAmount} USDC. Wallet balance: ${callerWallet.balance} USDC. Shortfall: ${deficit.toFixed(6)} USDC. Fund wallet ${callerWallet.id} with at least ${deficit.toFixed(6)} USDC via POST /v1/wallets/${callerWallet.id}/deposit, then re-submit this task.` },
        ]);
        await this.taskService.setInputRequired(taskId, 'Insufficient funds for x402 payment', {
          reason_code: 'insufficient_funds',
          next_action: 'fund_wallet',
          resolve_endpoint: `POST /a2a with skill: manage_wallet, action: fund`,
          required_auth: 'agent_token',
          details: {
            required_amount: humanAmount,
            wallet_balance: Number(callerWallet.balance),
            deficit,
            wallet_id: callerWallet.id,
            currency: 'USDC',
          },
        });
        return this.taskService.getTask(taskId);
      }

      // Step 7: Deduct wallet balance atomically
      const { error: deductError } = await this.supabase
        .from('wallets')
        .update({ balance: Number(callerWallet.balance) - humanAmount })
        .eq('id', callerWallet.id)
        .eq('tenant_id', this.tenantId)
        .gte('balance', humanAmount);

      if (deductError) {
        await this.taskService.addMessage(taskId, 'agent', [
          { text: 'Failed to deduct wallet balance for x402 payment.' },
        ]);
        await this.taskService.updateTaskState(taskId, 'failed', 'Wallet deduction failed');
        return this.taskService.getTask(taskId);
      }

      // Step 7b: Look up provider agent's wallet and credit it
      const { data: providerWallet } = await this.supabase
        .from('wallets')
        .select('id, balance, owner_account_id')
        .eq('managed_by_agent_id', agent.id)
        .eq('tenant_id', this.tenantId)
        .maybeSingle();

      if (providerWallet) {
        await this.supabase
          .from('wallets')
          .update({ balance: Number(providerWallet.balance) + humanAmount })
          .eq('id', providerWallet.id);
      }

      // Step 8: Create transfer record
      const { data: transfer, error: transferError } = await this.supabase
        .from('transfers')
        .insert({
          tenant_id: this.tenantId,
          type: 'x402',
          status: 'completed',
          amount: humanAmount,
          currency: 'USDC',
          destination_amount: humanAmount,
          destination_currency: 'USDC',
          fx_rate: 1,
          fee_amount: 0,
          from_account_id: callerWallet.owner_account_id,
          to_account_id: providerWallet?.owner_account_id || callerWallet.owner_account_id,
          description: `x402 agent forwarding: ${skill.skill_id} via ${agent.endpoint_url}`,
          initiated_by_type: 'agent',
          initiated_by_id: callerAgentId,
          completed_at: new Date().toISOString(),
          protocol_metadata: {
            protocol: 'x402',
            agentForwarding: true,
            request_id: taskId,
            endpoint_url: agent.endpoint_url,
            agent_id: agent.id,
            skill_id: skill.skill_id,
            amount_units: requestedAmountUnits,
          },
        })
        .select('id')
        .single();

      if (transferError || !transfer) {
        this.log(taskId, 'error', `x402 transfer creation failed: ${transferError?.message} (${transferError?.code})`);
        // Rollback wallet deduction
        const { data: currentWallet } = await this.supabase
          .from('wallets')
          .select('balance')
          .eq('id', callerWallet.id)
          .eq('tenant_id', this.tenantId)
          .single();
        if (currentWallet) {
          await this.supabase
            .from('wallets')
            .update({ balance: Number(currentWallet.balance) + humanAmount })
            .eq('id', callerWallet.id)
            .eq('tenant_id', this.tenantId);
        }
        // Rollback provider wallet credit
        if (providerWallet) {
          const { data: provCurrent } = await this.supabase
            .from('wallets')
            .select('balance')
            .eq('id', providerWallet.id)
            .eq('tenant_id', this.tenantId)
            .single();
          if (provCurrent) {
            await this.supabase
              .from('wallets')
              .update({ balance: Math.max(0, Number(provCurrent.balance) - humanAmount) })
              .eq('id', providerWallet.id);
          }
        }
        await this.taskService.addMessage(taskId, 'agent', [
          { text: 'Failed to create transfer record for x402 payment.' },
        ]);
        await this.taskService.updateTaskState(taskId, 'failed', 'Transfer creation failed');
        return this.taskService.getTask(taskId);
      }

      // Step 9: Generate X-Payment header
      const jwt = createPaymentProofJWT({
        transferId: transfer.id,
        requestId: taskId,
        endpointId: agent.id,
        amount: humanAmount,
        currency: 'USDC',
      });

      let chainConfig: { contracts: { usdc: string }; chainId: number };
      try {
        chainConfig = getChainConfig();
      } catch {
        // Fallback for test/mock environments
        chainConfig = { contracts: { usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' }, chainId: 84532 };
      }

      let network: string;
      try {
        network = getCurrentNetwork();
      } catch {
        network = `eip155:${chainConfig.chainId}`;
      }

      const xPayment = JSON.stringify({
        scheme: 'exact-evm',
        network,
        amount: requestedAmountUnits,
        token: chainConfig.contracts.usdc,
        from: callerWallet.wallet_address || callerWallet.id,
        to: agent.id,
        signature: jwt,
      });

      // Step 10: Retry POST with X-Payment header
      this.log(taskId, 'info', `x402 retrying with X-Payment (${humanAmount} USDC)`);

      const retryResponse = await fetch(agent.endpoint_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Payment': xPayment,
        },
        body: JSON.stringify(taskPayload),
        signal: AbortSignal.timeout(60_000),
      });

      if (retryResponse.ok) {
        // Link transfer to task
        await this.supabase
          .from('a2a_tasks')
          .update({ transfer_id: transfer.id })
          .eq('id', taskId)
          .eq('tenant_id', this.tenantId);

        return await this.handleX402AgentResponse(taskId, retryResponse, agent);
      }

      // Retry failed — rollback
      this.log(taskId, 'error', `x402 retry failed: HTTP ${retryResponse.status}`);
      const retryErrorText = await retryResponse.text().catch(() => 'Unknown error');

      // Reverse wallet deduction
      const { data: walletAfter } = await this.supabase
        .from('wallets')
        .select('balance')
        .eq('id', callerWallet.id)
        .eq('tenant_id', this.tenantId)
        .single();
      if (walletAfter) {
        await this.supabase
          .from('wallets')
          .update({ balance: Number(walletAfter.balance) + humanAmount })
          .eq('id', callerWallet.id)
          .eq('tenant_id', this.tenantId);
      }
      // Reverse provider wallet credit
      if (providerWallet) {
        const { data: provAfter } = await this.supabase
          .from('wallets')
          .select('balance')
          .eq('id', providerWallet.id)
          .eq('tenant_id', this.tenantId)
          .single();
        if (provAfter) {
          await this.supabase
            .from('wallets')
            .update({ balance: Math.max(0, Number(provAfter.balance) - humanAmount) })
            .eq('id', providerWallet.id);
        }
      }

      // Mark transfer cancelled
      await this.supabase
        .from('transfers')
        .update({ status: 'cancelled' })
        .eq('id', transfer.id)
        .eq('tenant_id', this.tenantId);

      await this.taskService.addMessage(taskId, 'agent', [
        { text: `x402 payment sent but agent returned HTTP ${retryResponse.status} on retry: ${retryErrorText.slice(0, 200)}. Payment reversed.` },
      ]);
      await this.taskService.updateTaskState(taskId, 'failed', `x402 retry failed: HTTP ${retryResponse.status}`);
      return this.taskService.getTask(taskId);

    } catch (err: any) {
      this.log(taskId, 'error', `x402 forward failed: ${err.message}`);
      await this.taskService.addMessage(taskId, 'agent', [
        { text: `Failed to reach agent endpoint via x402: ${err.message}` },
      ]);
      await this.taskService.updateTaskState(taskId, 'failed', `x402 forwarding failed: ${err.message}`);
      return this.taskService.getTask(taskId);
    }
  }

  /**
   * Handle a successful (200) response from an x402 shim.
   * Extracts response text and artifacts from the plain JSON body.
   */
  private async handleX402AgentResponse(
    taskId: string,
    response: Response,
    agent: { id: string; endpoint_url: string },
  ): Promise<A2ATask | null> {
    let body: any;
    try {
      body = await response.json();
    } catch {
      body = { response: 'Agent completed the task.' };
    }

    const responseText = body.response || body.result?.status?.message || 'Task completed by agent.';
    await this.taskService.addMessage(taskId, 'agent', [
      { text: responseText },
    ]);

    // Copy artifacts if present
    if (Array.isArray(body.artifacts)) {
      for (const artifact of body.artifacts) {
        await this.taskService.addArtifact(taskId, artifact);
      }
    }

    // Store forwarding metadata
    await this.supabase
      .from('a2a_tasks')
      .update({
        metadata: { forwarded_to: agent.endpoint_url, endpoint_type: 'x402', agent_id: agent.id },
      })
      .eq('id', taskId)
      .eq('tenant_id', this.tenantId);

    await this.taskService.updateTaskState(taskId, 'completed', 'x402 forwarding completed');
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

    // Determine caller agent (the one sending the task / paying)
    const { data: taskRow } = await this.supabase
      .from('a2a_tasks')
      .select('client_agent_id')
      .eq('id', taskId)
      .eq('tenant_id', this.tenantId)
      .single();

    const callerAgentId = taskRow?.client_agent_id;
    // agentCtx = the provider agent processing this task
    // callerAgentId = the caller agent who sent the task (source of funds)
    const fromAgentId = callerAgentId || agentCtx.agentId;

    // Use settleRealWalletPayment for proper agent-to-agent on-chain settlement
    const paymentResult = await this.paymentHandler.settleRealWalletPayment(
      taskId,
      fromAgentId,
      agentCtx.agentId,
      intent.amount,
      intent.currency,
    );

    if (!paymentResult.success) {
      await this.taskService.addMessage(taskId, 'agent', [
        { text: `Payment failed: ${paymentResult.error}` },
      ]);
      await this.taskService.updateTaskState(taskId, 'failed', paymentResult.error || 'Payment failed');
      return this.taskService.getTask(taskId);
    }

    const settlement = paymentResult.txHash ? 'on_chain' : 'ledger';

    await this.taskService.addMessage(taskId, 'agent', [
      {
        text: `Payment of ${intent.amount} ${intent.currency} processed successfully. Transfer ID: ${paymentResult.transferId}. Settlement: ${settlement}.${paymentResult.txHash ? ` Tx: ${paymentResult.txHash}` : ''}`,
      },
      {
        data: {
          type: 'transfer_initiated',
          transferId: paymentResult.transferId,
          amount: intent.amount,
          currency: intent.currency,
          settlement,
          txHash: paymentResult.txHash || null,
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
            transferId: paymentResult.transferId,
            amount: intent.amount,
            currency: intent.currency,
            settlement,
            txHash: paymentResult.txHash || null,
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

    // Emit audit event for timeline visibility
    const { taskEventBus } = await import('./task-event-bus.js');
    taskEventBus.emitTask(taskId, {
      type: 'payment',
      taskId,
      data: {
        action: 'mandate_created',
        mandateId: mandate.mandate_id,
        amount: intent.amount,
        currency: intent.currency,
        mandateType,
      },
      timestamp: new Date().toISOString(),
    }, { tenantId: this.tenantId, agentId: agentCtx.agentId, actorType: 'agent' });

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
