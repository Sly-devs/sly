/**
 * Context Injector (Story 58.2)
 *
 * Auto-fills agent context into tool arguments.
 * Saves LLM from wasting a tool call to discover "which wallet am I?"
 */

export interface AgentContext {
  tenantId: string;
  agentId: string;
  accountId: string;
  walletId?: string;
  mandateIds: string[];
  permissions: string[];
  currentTaskId?: string;
  contextId?: string;
}

/**
 * Enrich tool arguments with agent context where applicable.
 * Only fills in values that are missing — never overrides explicit args.
 */
export function injectContext(
  ctx: AgentContext,
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const enriched = { ...args };

  switch (toolName) {
    // Wallet tools: auto-fill walletId
    case 'get_wallet_balance':
    case 'get_wallet':
    case 'wallet_deposit':
    case 'wallet_withdraw':
    case 'wallet_test_fund':
      if (!enriched.walletId && ctx.walletId) {
        enriched.walletId = ctx.walletId;
      }
      break;

    // Agent tools: auto-fill agentId
    case 'get_agent':
    case 'get_agent_limits':
    case 'get_agent_transactions':
      if (!enriched.agentId) {
        enriched.agentId = ctx.agentId;
      }
      break;

    // AP2 mandate tools: validate mandate belongs to agent
    case 'ap2_get_mandate':
    case 'ap2_execute_mandate':
    case 'ap2_update_mandate':
    case 'ap2_cancel_mandate':
      if (!enriched.agentId) {
        enriched.agentId = ctx.agentId;
      }
      break;

    // A2A tools: inject context_id and initiating agent metadata
    case 'a2a_send_task':
      if (!enriched.context_id && ctx.contextId) {
        enriched.context_id = ctx.contextId;
      }
      if (!enriched.initiatingAgentId) {
        enriched.initiatingAgentId = ctx.agentId;
      }
      if (!enriched.initiatingTaskId && ctx.currentTaskId) {
        enriched.initiatingTaskId = ctx.currentTaskId;
      }
      break;

    // Escalation: inject current task ID
    case 'escalate_to_human':
      // No extra injection needed — handler reads ctx.currentTaskId directly
      break;

    // Checkout tools: auto-fill agent_id
    case 'acp_create_checkout':
    case 'ucp_create_checkout':
      if (!enriched.agent_id) {
        enriched.agent_id = ctx.agentId;
      }
      if (!enriched.account_id) {
        enriched.account_id = ctx.accountId;
      }
      break;

    // x402 payment: auto-fill walletId
    case 'x402_pay':
      if (!enriched.walletId && ctx.walletId) {
        enriched.walletId = ctx.walletId;
      }
      break;

    // AP2 mandate creation: auto-fill account_id and agent_id
    case 'ap2_create_mandate':
      if (!enriched.account_id) {
        enriched.account_id = ctx.accountId;
      }
      if (!enriched.agent_id) {
        enriched.agent_id = ctx.agentId;
      }
      break;
  }

  return enriched;
}
