/**
 * Agent Tool Registry (Story 58.2)
 *
 * Provides tool schemas for LLM function calling and executes tools
 * in-process via direct Supabase queries (not HTTP).
 *
 * Reuses MCP tool definitions as the canonical schema, filtered
 * by agent permissions and enriched with agent context.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { TOOL_PERMISSION_MAP, flattenPermissions } from './permission-map.js';
import { injectContext, type AgentContext } from './context-injector.js';
import { toolHandlers, type ToolResult } from './handlers.js';

/** Tool definition shape for LLM function calling. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// Synthetic tools: not in MCP server, implemented in-process
const SYNTHETIC_TOOLS: ToolDefinition[] = [
  {
    name: 'get_agent_info',
    description:
      'Get your own agent details including name, wallet balance, mandate IDs, and permissions. ' +
      'Call this first to understand your capabilities before taking action.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'escalate_to_human',
    description:
      'Escalate the current task to a human for review or approval. ' +
      'Use this when you need human authorization (e.g., payment above threshold) ' +
      'or when the request is ambiguous and needs human clarification. ' +
      'The task will transition to input-required state until a human responds.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Why the task needs human review (e.g., "Payment of 5000 USDC exceeds approval threshold")',
        },
        message: {
          type: 'string',
          description: 'Message to display to the human reviewer',
        },
      },
      required: ['reason'],
    },
  },
];

export class AgentToolRegistry {
  private supabase: SupabaseClient;

  constructor(supabase: SupabaseClient) {
    this.supabase = supabase;
  }

  /**
   * Get tool definitions available to a specific agent,
   * filtered by the agent's permissions + custom tools.
   *
   * Note: Lazily imports @sly/mcp-server to avoid its top-level
   * process.exit(1) when SLY_API_KEY is not set (which is normal
   * for the API server — only the MCP CLI needs that env var).
   *
   * Story 58.15: Also loads tenant-defined custom tools from
   * `agent_custom_tools` table.
   */
  async getToolsForAgent(ctx: AgentContext): Promise<ToolDefinition[]> {
    const agentPerms = ctx.permissions;

    let mcpToolDefinitions: Array<{ name: string; description?: string; inputSchema: unknown }> = [];
    try {
      const mod = await import('@sly_ai/mcp-server');
      mcpToolDefinitions = mod.tools || [];
    } catch {
      // MCP server not available — continue with synthetic + custom tools only
    }

    const filtered = mcpToolDefinitions
      .filter((tool) => {
        const required = TOOL_PERMISSION_MAP[tool.name];
        // If tool not in permission map, exclude it (unknown tool)
        if (required === undefined) return false;
        // If empty array, tool is always available
        if (required.length === 0) return true;
        // Check all required permissions are present
        return required.every((p) => agentPerms.includes(p));
      })
      .map((tool) => ({
        name: tool.name,
        description: tool.description || '',
        inputSchema: tool.inputSchema as Record<string, unknown>,
      }));

    // Story 58.15: Load custom tools for this agent
    const customTools = await this.getCustomToolsForAgent(ctx.tenantId, ctx.agentId);

    // Add synthetic tools + MCP tools + custom tools
    return [...SYNTHETIC_TOOLS, ...filtered, ...customTools];
  }

  /**
   * Load tenant-defined custom tools for a specific agent (Story 58.15).
   */
  private async getCustomToolsForAgent(
    tenantId: string,
    agentId: string,
  ): Promise<ToolDefinition[]> {
    const { data: rows } = await this.supabase
      .from('agent_custom_tools')
      .select('tool_name, description, input_schema')
      .eq('agent_id', agentId)
      .eq('tenant_id', tenantId)
      .eq('status', 'active');

    if (!rows || rows.length === 0) return [];

    return rows.map((row: any) => ({
      name: `custom:${row.tool_name}`,
      description: row.description || '',
      inputSchema: row.input_schema || { type: 'object', properties: {}, required: [] },
    }));
  }

  /**
   * Execute a tool call with context injection and permission checking.
   */
  async executeTool(
    ctx: AgentContext,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    // Story 58.15: Custom tools bypass TOOL_PERMISSION_MAP (they're tenant-defined)
    if (toolName.startsWith('custom:')) {
      const enrichedArgs = injectContext(ctx, toolName, args);
      return this.executeCustomTool(ctx, toolName, enrichedArgs);
    }

    // Permission check for built-in tools
    const required = TOOL_PERMISSION_MAP[toolName];
    if (required === undefined) {
      return {
        success: false,
        error: { code: 'UNKNOWN_TOOL', message: `Tool '${toolName}' is not registered` },
      };
    }
    if (required.length > 0) {
      const missing = required.filter((p) => !ctx.permissions.includes(p));
      if (missing.length > 0) {
        return {
          success: false,
          error: {
            code: 'PERMISSION_DENIED',
            message: `Agent lacks required permissions: ${missing.join(', ')}`,
            suggestedAction: 'Request elevated permissions or use a different approach',
          },
        };
      }
    }

    // Inject agent context into args
    const enrichedArgs = injectContext(ctx, toolName, args);

    // Try in-process handler first (fastest path)
    const handler = toolHandlers[toolName];
    if (handler) {
      try {
        return await handler(this.supabase, ctx, enrichedArgs);
      } catch (err: any) {
        return {
          success: false,
          error: { code: 'TOOL_ERROR', message: err.message },
        };
      }
    }

    // No in-process handler — return error suggesting the tool exists
    // but execution isn't implemented yet. Story 58.4 will add HTTP fallback.
    return {
      success: false,
      error: {
        code: 'NOT_IMPLEMENTED',
        message: `Tool '${toolName}' is defined but has no in-process handler yet. Use the Sly API directly.`,
      },
    };
  }

  /**
   * Execute a tenant-defined custom tool via its configured handler (Story 58.15).
   */
  private async executeCustomTool(
    ctx: AgentContext,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const rawName = toolName.replace(/^custom:/, '');

    const { data: tool } = await this.supabase
      .from('agent_custom_tools')
      .select('*')
      .eq('agent_id', ctx.agentId)
      .eq('tenant_id', ctx.tenantId)
      .eq('tool_name', rawName)
      .eq('status', 'active')
      .maybeSingle();

    if (!tool) {
      return { success: false, error: { code: 'TOOL_NOT_FOUND', message: `Custom tool '${rawName}' not found` } };
    }

    if (tool.handler_type === 'noop') {
      return { success: true, data: { message: `Tool '${rawName}' executed (noop handler)` } };
    }

    if (!tool.handler_url) {
      return { success: false, error: { code: 'NO_HANDLER', message: `Custom tool '${rawName}' has no handler URL` } };
    }

    // Execute via HTTP
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), tool.handler_timeout_ms || 30000);

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      // HMAC signing if secret is configured
      if (tool.handler_secret) {
        const { createHmac } = await import('crypto');
        const bodyStr = JSON.stringify({ tool: rawName, args, agentId: ctx.agentId, tenantId: ctx.tenantId });
        const signature = createHmac('sha256', tool.handler_secret).update(bodyStr).digest('hex');
        headers['x-sly-signature'] = `sha256=${signature}`;
      }

      const response = await fetch(tool.handler_url, {
        method: tool.handler_method || 'POST',
        headers,
        body: JSON.stringify({ tool: rawName, args, agentId: ctx.agentId, tenantId: ctx.tenantId }),
        signal: controller.signal,
      });

      const responseText = await response.text();
      let data: any;
      try { data = JSON.parse(responseText); } catch { data = { raw: responseText }; }
      if (!response.ok) {
        return { success: false, error: { code: 'HANDLER_ERROR', message: `HTTP ${response.status}`, data } };
      }
      return { success: true, data };
    } catch (err: any) {
      if (err.name === 'AbortError') {
        return { success: false, error: { code: 'TIMEOUT', message: `Custom tool '${rawName}' timed out after ${tool.handler_timeout_ms}ms` } };
      }
      return { success: false, error: { code: 'HANDLER_ERROR', message: err.message } };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Build an AgentContext from database for a given agent.
   */
  async buildAgentContext(
    tenantId: string,
    agentId: string,
    taskId?: string,
    contextId?: string,
  ): Promise<AgentContext | null> {
    // Load agent + parent account
    const { data: agent } = await this.supabase
      .from('agents')
      .select('id, parent_account_id, permissions, status')
      .eq('id', agentId)
      .eq('tenant_id', tenantId)
      .single();

    if (!agent || agent.status !== 'active') return null;

    // Load wallet managed by this agent (include wallet details for context)
    const { data: wallet } = await this.supabase
      .from('wallets')
      .select('id, wallet_address, wallet_type, balance')
      .eq('managed_by_agent_id', agentId)
      .eq('tenant_id', tenantId)
      .limit(1)
      .maybeSingle();

    // Load active mandates for this agent
    const { data: mandates } = await this.supabase
      .from('ap2_mandates')
      .select('id')
      .eq('agent_id', agentId)
      .eq('tenant_id', tenantId)
      .eq('status', 'active');

    const permissions = flattenPermissions(
      agent.permissions || {
        transactions: { initiate: true, approve: false, view: true },
        streams: { initiate: true, modify: true, pause: true, terminate: true, view: true },
        accounts: { view: true, create: false },
        treasury: { view: false, rebalance: false },
      },
    );

    return {
      tenantId,
      agentId,
      accountId: agent.parent_account_id,
      walletId: wallet?.id,
      walletAddress: wallet?.wallet_address || undefined,
      walletType: wallet?.wallet_type || undefined,
      walletBalance: wallet?.balance ? parseFloat(wallet.balance) : undefined,
      mandateIds: (mandates || []).map((m: any) => m.id),
      permissions,
      currentTaskId: taskId,
      contextId,
    };
  }
}
