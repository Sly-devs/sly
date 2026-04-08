/**
 * In-Process Tool Handlers (Story 58.2)
 *
 * Execute MCP tools via direct service calls instead of HTTP.
 * Saves ~100ms per tool call vs the HTTP path.
 *
 * Each handler receives the agent context and enriched arguments,
 * calls the appropriate Supabase query or service, and returns
 * a structured ToolResult.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AgentContext } from './context-injector.js';

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string; suggestedAction?: string };
}

type ToolHandler = (
  supabase: SupabaseClient,
  ctx: AgentContext,
  args: Record<string, unknown>,
) => Promise<ToolResult>;

/**
 * Synthetic get_agent_info tool — returns the agent's own details
 * without making any API call.
 */
async function handleGetAgentInfo(
  supabase: SupabaseClient,
  ctx: AgentContext,
  _args: Record<string, unknown>,
): Promise<ToolResult> {
  const { data: agent } = await supabase
    .from('agents')
    .select('id, name, description, status, kya_tier, permissions')
    .eq('id', ctx.agentId)
    .eq('tenant_id', ctx.tenantId)
    .single();

  if (!agent) {
    return { success: false, error: { code: 'AGENT_NOT_FOUND', message: 'Could not load agent info' } };
  }

  const result: Record<string, unknown> = {
    agentId: ctx.agentId,
    accountId: ctx.accountId,
    name: agent.name,
    description: agent.description,
    status: agent.status,
    kyaTier: agent.kya_tier,
    permissions: agent.permissions,
    walletId: ctx.walletId || null,
    mandateIds: ctx.mandateIds,
  };

  // Load wallet balance if available
  if (ctx.walletId) {
    const { data: wallet } = await supabase
      .from('wallets')
      .select('balance, currency')
      .eq('id', ctx.walletId)
      .eq('tenant_id', ctx.tenantId)
      .single();
    if (wallet) {
      result.walletBalance = wallet.balance;
      result.walletCurrency = wallet.currency;
    }
  }

  return { success: true, data: result };
}

/**
 * get_wallet_balance — direct Supabase query
 */
async function handleGetWalletBalance(
  supabase: SupabaseClient,
  ctx: AgentContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const walletId = (args.walletId as string) || ctx.walletId;
  if (!walletId) {
    return { success: false, error: { code: 'MISSING_WALLET', message: 'No walletId provided and agent has no default wallet' } };
  }

  const { data, error } = await supabase
    .from('wallets')
    .select('id, balance, currency, status, name')
    .eq('id', walletId)
    .eq('tenant_id', ctx.tenantId)
    .single();

  if (error || !data) {
    return { success: false, error: { code: 'WALLET_NOT_FOUND', message: `Wallet ${walletId} not found` } };
  }

  return { success: true, data };
}

/**
 * list_wallets — list wallets for the tenant
 */
async function handleListWallets(
  supabase: SupabaseClient,
  ctx: AgentContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  let query = supabase
    .from('wallets')
    .select('id, balance, currency, status, name, owner_account_id, managed_by_agent_id')
    .eq('tenant_id', ctx.tenantId)
    .order('created_at', { ascending: false })
    .limit(Number(args.limit) || 20);

  if (args.ownerAccountId) query = query.eq('owner_account_id', args.ownerAccountId);
  if (args.managedByAgentId) query = query.eq('managed_by_agent_id', args.managedByAgentId);

  const { data, error } = await query;
  if (error) {
    return { success: false, error: { code: 'QUERY_ERROR', message: error.message } };
  }

  return { success: true, data };
}

/**
 * list_accounts — list accounts for the tenant
 */
async function handleListAccounts(
  supabase: SupabaseClient,
  ctx: AgentContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  let query = supabase
    .from('accounts')
    .select('id, name, type, email, verification_tier, verification_status')
    .eq('tenant_id', ctx.tenantId)
    .order('created_at', { ascending: false })
    .limit(Number(args.limit) || 20);

  if (args.type) query = query.eq('type', args.type);

  const { data, error } = await query;
  if (error) {
    return { success: false, error: { code: 'QUERY_ERROR', message: error.message } };
  }

  return { success: true, data };
}

/**
 * ap2_get_mandate — get mandate details
 */
async function handleAp2GetMandate(
  supabase: SupabaseClient,
  ctx: AgentContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const mandateId = args.mandateId as string;
  if (!mandateId) {
    return { success: false, error: { code: 'MISSING_PARAM', message: 'mandateId is required' } };
  }

  const { data, error } = await supabase
    .from('ap2_mandates')
    .select('*')
    .eq('id', mandateId)
    .eq('tenant_id', ctx.tenantId)
    .single();

  if (error || !data) {
    return { success: false, error: { code: 'MANDATE_NOT_FOUND', message: `Mandate ${mandateId} not found` } };
  }

  return {
    success: true,
    data: {
      id: data.id,
      mandateId: data.mandate_id,
      type: data.mandate_type,
      agentId: data.agent_id,
      accountId: data.account_id,
      authorizedAmount: data.authorized_amount,
      usedAmount: data.used_amount,
      remainingAmount: data.remaining_amount,
      currency: data.currency,
      status: data.status,
      expiresAt: data.expires_at,
    },
  };
}

/**
 * ap2_list_mandates — list mandates
 */
async function handleAp2ListMandates(
  supabase: SupabaseClient,
  ctx: AgentContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  let query = supabase
    .from('ap2_mandates')
    .select('id, mandate_id, mandate_type, agent_id, account_id, authorized_amount, used_amount, remaining_amount, currency, status, expires_at')
    .eq('tenant_id', ctx.tenantId)
    .order('created_at', { ascending: false })
    .limit(Number(args.limit) || 20);

  if (args.agentId) query = query.eq('agent_id', args.agentId);
  if (args.status) query = query.eq('status', args.status);

  const { data, error } = await query;
  if (error) {
    return { success: false, error: { code: 'QUERY_ERROR', message: error.message } };
  }

  return { success: true, data };
}

/**
 * get_agent_transactions — get agent transaction history
 */
async function handleGetAgentTransactions(
  supabase: SupabaseClient,
  ctx: AgentContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const agentId = (args.agentId as string) || ctx.agentId;
  const limit = Number(args.limit) || 20;

  const { data, error } = await supabase
    .from('transfers')
    .select('id, type, status, amount, currency, description, created_at, completed_at')
    .eq('tenant_id', ctx.tenantId)
    .eq('initiated_by_id', agentId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    return { success: false, error: { code: 'QUERY_ERROR', message: error.message } };
  }

  return { success: true, data };
}

/**
 * escalate_to_human — Transition task to input-required so a human can respond.
 * (Story 58.6: Human-in-the-Loop Escalation)
 */
async function handleEscalateToHuman(
  supabase: SupabaseClient,
  ctx: AgentContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const taskId = ctx.currentTaskId;
  if (!taskId) {
    return { success: false, error: { code: 'NO_TASK', message: 'No active task to escalate' } };
  }

  const reason = (args.reason as string) || 'Agent requested human review';
  const message = (args.message as string) || reason;

  // Transition task to input-required
  const { error: updateError } = await supabase
    .from('a2a_tasks')
    .update({
      state: 'input-required',
      status_message: `Escalated: ${reason}`,
    })
    .eq('id', taskId)
    .eq('tenant_id', ctx.tenantId);

  if (updateError) {
    return { success: false, error: { code: 'UPDATE_FAILED', message: updateError.message } };
  }

  // Add an agent message explaining the escalation
  await supabase
    .from('a2a_messages')
    .insert({
      tenant_id: ctx.tenantId,
      task_id: taskId,
      role: 'agent',
      parts: [{ text: message }],
      metadata: { escalation: true, reason },
    });

  // Emit event so SSE/webhooks pick it up
  const { taskEventBus } = await import('../task-event-bus.js');
  taskEventBus.emitTask(taskId, {
    type: 'status',
    taskId,
    data: { state: 'input-required', statusMessage: `Escalated: ${reason}` },
    timestamp: new Date().toISOString(),
  });

  return {
    success: true,
    data: {
      taskId,
      state: 'input-required',
      reason,
      message: 'Task escalated to human. Waiting for response.',
    },
  };
}

/**
 * a2a_send_task — Send a task to another agent (intra-platform).
 * (Story 58.7: Intra-Platform Agent-to-Agent)
 *
 * For same-tenant agents, creates a task directly via TaskService.
 * Waits for the child task to reach a terminal state (up to 30s).
 */
async function handleSendA2aTask(
  supabase: SupabaseClient,
  ctx: AgentContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const targetAgentId = args.agent_id as string;
  const remoteUrl = args.remote_url as string | undefined;
  const messageText = args.message as string;
  const contextId = (args.context_id as string) || ctx.contextId;

  if (!targetAgentId && !remoteUrl) {
    return { success: false, error: { code: 'MISSING_PARAM', message: 'agent_id or remote_url is required' } };
  }
  if (!messageText) {
    return { success: false, error: { code: 'MISSING_PARAM', message: 'message is required' } };
  }
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (targetAgentId && !UUID_RE.test(targetAgentId)) {
    return { success: false, error: { code: 'INVALID_PARAM', message: 'agent_id must be a valid UUID' } };
  }

  // Build parts from string message
  const parts = [{ text: messageText }];
  const metadata: Record<string, unknown> = {
    initiatingAgentId: ctx.agentId,
    initiatingTaskId: ctx.currentTaskId,
  };

  if (remoteUrl) {
    // External A2A agent — use A2AClient
    try {
      const { A2AClient } = await import('../client.js');
      const client = new A2AClient();
      const result = await client.sendMessage(remoteUrl, { parts }, contextId);
      return {
        success: true,
        data: {
          taskId: result?.result?.id || null,
          state: result?.result?.status?.state || 'submitted',
          remote: true,
          url: remoteUrl,
        },
      };
    } catch (err: any) {
      return { success: false, error: { code: 'REMOTE_ERROR', message: err.message } };
    }
  }

  // Intra-platform: verify target agent exists (cross-tenant OK for marketplace)
  const { data: targetAgent } = await supabase
    .from('agents')
    .select('id, status, tenant_id')
    .eq('id', targetAgentId)
    .single();

  if (!targetAgent || targetAgent.status !== 'active') {
    return { success: false, error: { code: 'AGENT_NOT_FOUND', message: `Agent ${targetAgentId} not found or inactive` } };
  }

  // Create child task in the TARGET agent's tenant (cross-tenant support)
  const { A2ATaskService } = await import('../task-service.js');
  const taskService = new A2ATaskService(supabase, targetAgent.tenant_id);

  const childTask = await taskService.createTask(
    targetAgentId,
    { role: 'user', parts, metadata },
    contextId,
    'inbound',
  );

  // Wait for child task to reach terminal state (up to 30s)
  const { taskEventBus } = await import('../task-event-bus.js');
  const WAIT_TIMEOUT = 30_000;
  const TERMINAL = new Set(['completed', 'failed', 'canceled']);

  const finalTask = await new Promise<any>((resolve) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        unsub();
        resolve(null); // timeout
      }
    }, WAIT_TIMEOUT);

    const unsub = taskEventBus.subscribe(childTask.id, (event) => {
      if (!settled && event.type === 'status' && TERMINAL.has(event.data.state as string)) {
        settled = true;
        clearTimeout(timer);
        unsub();
        resolve(event.data);
      }
    });

    // Check if already terminal
    if (TERMINAL.has(childTask.status.state)) {
      settled = true;
      clearTimeout(timer);
      unsub();
      resolve({ state: childTask.status.state });
    }
  });

  // Fetch the final task state
  const result = await taskService.getTask(childTask.id);

  if (!finalTask) {
    // Timed out — return what we have
    return {
      success: true,
      data: {
        taskId: childTask.id,
        state: result?.status?.state || 'working',
        timedOut: true,
        message: 'Child task did not complete within 30s. You can check status later.',
        history: result?.history || [],
        artifacts: result?.artifacts || [],
      },
    };
  }

  return {
    success: true,
    data: {
      taskId: childTask.id,
      state: result?.status?.state || finalTask.state,
      timedOut: false,
      history: result?.history || [],
      artifacts: result?.artifacts || [],
    },
  };
}

/**
 * ucp_create_checkout — Create a UCP checkout session with line items.
 */
async function handleUcpCreateCheckout(
  supabase: SupabaseClient,
  ctx: AgentContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const lineItems = args.line_items as Array<{ name: string; quantity: number; unit_price: number }> | undefined;
  const currency = (args.currency as string) || 'USDC';
  const metadata = (args.metadata as Record<string, unknown>) || {};

  if (!lineItems || !Array.isArray(lineItems) || lineItems.length === 0) {
    return { success: false, error: { code: 'INVALID_INPUT', message: 'line_items array is required with at least one item' } };
  }

  const totalAmount = lineItems.reduce((sum, item) => sum + (item.quantity || 1) * (item.unit_price || 0), 0);

  const checkoutId = `cs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const { data, error } = await supabase
    .from('ucp_checkout_sessions')
    .insert({
      id: checkoutId,
      tenant_id: ctx.tenantId,
      agent_id: ctx.agentId,
      currency,
      line_items: lineItems,
      totals: { subtotal: totalAmount, total: totalAmount, currency },
      status: 'incomplete',
      metadata: { ...metadata, source: 'a2a', agentId: ctx.agentId },
    })
    .select('id, currency, status, line_items, totals, created_at')
    .single();

  if (error || !data) {
    return { success: false, error: { code: 'CREATE_FAILED', message: error?.message || 'Failed to create checkout' } };
  }

  return { success: true, data };
}

/**
 * x402_list_endpoints — List active x402 endpoints.
 */
async function handleX402ListEndpoints(
  supabase: SupabaseClient,
  ctx: AgentContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const limit = Number(args.limit) || 20;

  const { data, error } = await supabase
    .from('x402_endpoints')
    .select('id, name, path, base_price, currency, total_calls, status, created_at')
    .eq('tenant_id', ctx.tenantId)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    return { success: false, error: { code: 'QUERY_ERROR', message: error.message } };
  }

  return { success: true, data: data || [] };
}

/**
 * x402_pay — Pay for an x402 endpoint access.
 */
async function handleX402Pay(
  supabase: SupabaseClient,
  ctx: AgentContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const endpointId = args.endpoint_id as string;
  if (!endpointId) {
    return { success: false, error: { code: 'MISSING_PARAM', message: 'endpoint_id is required' } };
  }

  const walletId = (args.walletId as string) || ctx.walletId;
  if (!walletId) {
    return { success: false, error: { code: 'MISSING_WALLET', message: 'No wallet available' } };
  }

  // Fetch endpoint
  const { data: endpoint } = await supabase
    .from('x402_endpoints')
    .select('id, name, path, base_price, currency, status')
    .eq('id', endpointId)
    .eq('tenant_id', ctx.tenantId)
    .single();

  if (!endpoint || endpoint.status !== 'active') {
    return { success: false, error: { code: 'ENDPOINT_NOT_FOUND', message: 'Endpoint not found or inactive' } };
  }

  const amount = Number(endpoint.base_price);

  // Deduct from wallet
  const { data: wallet } = await supabase
    .from('wallets')
    .select('balance')
    .eq('id', walletId)
    .eq('tenant_id', ctx.tenantId)
    .single();

  if (!wallet || Number(wallet.balance) < amount) {
    return { success: false, error: { code: 'INSUFFICIENT_BALANCE', message: `Need ${amount} ${endpoint.currency}, wallet has ${wallet?.balance || 0}` } };
  }

  const { error: deductError } = await supabase
    .from('wallets')
    .update({ balance: Number(wallet.balance) - amount })
    .eq('id', walletId)
    .eq('tenant_id', ctx.tenantId)
    .gte('balance', amount);

  if (deductError) {
    return { success: false, error: { code: 'DEDUCT_FAILED', message: deductError.message } };
  }

  // Create transfer record
  const { data: transfer } = await supabase
    .from('transfers')
    .insert({
      tenant_id: ctx.tenantId,
      type: 'internal',
      status: 'completed',
      amount,
      currency: endpoint.currency,
      destination_amount: amount,
      destination_currency: endpoint.currency,
      fx_rate: 1,
      fee_amount: 0,
      description: `x402 payment: ${endpoint.name || endpoint.path}`,
      from_account_id: ctx.accountId,
      from_account_name: 'Agent Account',
      to_account_id: ctx.accountId,
      to_account_name: 'Agent Account',
      initiated_by_type: 'agent',
      initiated_by_id: ctx.agentId,
      initiated_by_name: 'Agent',
      completed_at: new Date().toISOString(),
      protocol_metadata: { protocol: 'x402', endpointId: endpoint.id },
    })
    .select('id')
    .single();

  // Increment endpoint stats (best-effort)
  await supabase.rpc('increment_x402_endpoint_calls', { p_endpoint_id: endpointId });

  return {
    success: true,
    data: {
      transferId: transfer?.id,
      endpointId: endpoint.id,
      endpointName: endpoint.name,
      amount,
      currency: endpoint.currency,
    },
  };
}

/**
 * ap2_create_mandate — Create an AP2 payment mandate.
 */
async function handleAp2CreateMandate(
  supabase: SupabaseClient,
  ctx: AgentContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const mandateType = (args.mandate_type as string) || 'payment';
  const authorizedAmount = Number(args.authorized_amount || args.amount || 0);
  const currency = (args.currency as string) || 'USDC';
  const description = (args.description as string) || '';

  if (authorizedAmount <= 0) {
    return { success: false, error: { code: 'INVALID_AMOUNT', message: 'authorized_amount must be positive' } };
  }

  const mandateId = `mandate_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const { data, error } = await supabase
    .from('ap2_mandates')
    .insert({
      tenant_id: ctx.tenantId,
      account_id: ctx.accountId,
      agent_id: ctx.agentId,
      mandate_id: mandateId,
      mandate_type: mandateType,
      authorized_amount: authorizedAmount,
      used_amount: 0,
      currency,
      status: 'active',
      metadata: { source: 'a2a', agentId: ctx.agentId, description },
    })
    .select('id, mandate_id, mandate_type, authorized_amount, currency, status, created_at')
    .single();

  if (error || !data) {
    return { success: false, error: { code: 'CREATE_FAILED', message: error?.message || 'Failed to create mandate' } };
  }

  return { success: true, data };
}

/**
 * Registry of in-process tool handlers.
 * Tools not in this map fall back to HTTP via the API client.
 */
export const toolHandlers: Record<string, ToolHandler> = {
  // Synthetic
  get_agent_info: handleGetAgentInfo,

  // Wallet read
  get_wallet_balance: handleGetWalletBalance,
  list_wallets: handleListWallets,

  // Account read
  list_accounts: handleListAccounts,

  // AP2 read
  ap2_get_mandate: handleAp2GetMandate,
  ap2_list_mandates: handleAp2ListMandates,

  // Agent read
  get_agent_transactions: handleGetAgentTransactions,

  // Human-in-the-loop (Story 58.6)
  escalate_to_human: handleEscalateToHuman,

  // Intra-platform agent-to-agent (Story 58.7)
  a2a_send_task: handleSendA2aTask,

  // Commerce & protocol handlers (Agent Skill Economy)
  ucp_create_checkout: handleUcpCreateCheckout,
  x402_list_endpoints: handleX402ListEndpoints,
  x402_pay: handleX402Pay,
  ap2_create_mandate: handleAp2CreateMandate,
};
