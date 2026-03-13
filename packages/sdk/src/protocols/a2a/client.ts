/**
 * A2A Client - Google Agent-to-Agent Protocol
 *
 * SDK client for sending tasks to Sly-hosted agents, discovering agent
 * capabilities, and managing task lifecycle.
 *
 * @see Epic 57: Google A2A Protocol Integration
 * @see Epic 58: A2A Task Processor Worker (Story 58.11)
 */

import type { PayOSClient } from '../../client';
import type {
  A2AAgentCard,
  A2ATask,
  A2AListTasksOptions,
  A2AListTasksResponse,
  A2AConfiguration,
  A2APart,
  A2ACustomTool,
  A2ACreateCustomToolRequest,
} from '@sly/types';

export class A2AClient {
  private client: PayOSClient;

  constructor(client: PayOSClient) {
    this.client = client;
  }

  /**
   * Discover an agent's capabilities via its Agent Card.
   *
   * @example
   * ```typescript
   * const card = await sly.a2a.discover('agent-uuid');
   * console.log(card.skills);
   * ```
   */
  async discover(agentId: string): Promise<A2AAgentCard> {
    return this.client.request<A2AAgentCard>(
      `/v1/a2a/${agentId}/.well-known/agent.json`,
    );
  }

  /**
   * Send a message to an agent, creating or continuing a task.
   *
   * @example
   * ```typescript
   * const task = await sly.a2a.sendMessage('agent-uuid', {
   *   message: 'Check my wallet balance',
   * });
   * console.log(task.status.state); // 'submitted' or 'completed'
   * ```
   */
  async sendMessage(
    agentId: string,
    params: {
      message: string | A2APart[];
      contextId?: string;
      configuration?: A2AConfiguration;
      metadata?: Record<string, unknown>;
      skillId?: string;
    },
  ): Promise<A2ATask> {
    const parts: A2APart[] =
      typeof params.message === 'string'
        ? [{ text: params.message }]
        : params.message;

    const body = {
      jsonrpc: '2.0' as const,
      method: 'message/send',
      params: {
        message: { role: 'user', parts, metadata: params.metadata },
        ...(params.contextId && { contextId: params.contextId }),
        ...(params.configuration && { configuration: params.configuration }),
        ...(params.skillId && { skill_id: params.skillId }),
      },
      id: crypto.randomUUID(),
    };

    const response = await this.client.request<{ result: A2ATask }>(
      `/v1/a2a/${agentId}`,
      { method: 'POST', body: JSON.stringify(body) },
    );
    return response.result;
  }

  /**
   * Get a task by ID.
   *
   * @example
   * ```typescript
   * const task = await sly.a2a.getTask('agent-uuid', 'task-uuid');
   * console.log(task.status.state);
   * ```
   */
  async getTask(
    agentId: string,
    taskId: string,
    historyLength?: number,
  ): Promise<A2ATask> {
    const body = {
      jsonrpc: '2.0' as const,
      method: 'tasks/get',
      params: { id: taskId, ...(historyLength && { historyLength }) },
      id: crypto.randomUUID(),
    };

    const response = await this.client.request<{ result: A2ATask }>(
      `/v1/a2a/${agentId}`,
      { method: 'POST', body: JSON.stringify(body) },
    );
    return response.result;
  }

  /**
   * Cancel a task.
   */
  async cancelTask(agentId: string, taskId: string): Promise<A2ATask> {
    const body = {
      jsonrpc: '2.0' as const,
      method: 'tasks/cancel',
      params: { id: taskId },
      id: crypto.randomUUID(),
    };

    const response = await this.client.request<{ result: A2ATask }>(
      `/v1/a2a/${agentId}`,
      { method: 'POST', body: JSON.stringify(body) },
    );
    return response.result;
  }

  /**
   * List tasks for an agent (REST endpoint).
   *
   * @example
   * ```typescript
   * const { data, pagination } = await sly.a2a.listTasks({
   *   agentId: 'agent-uuid',
   *   state: 'completed',
   *   limit: 20,
   * });
   * ```
   */
  async listTasks(options: A2AListTasksOptions = {}): Promise<A2AListTasksResponse> {
    const params = new URLSearchParams();
    if (options.agentId) params.append('agent_id', options.agentId);
    if (options.state) params.append('state', options.state);
    if (options.direction) params.append('direction', options.direction);
    if (options.contextId) params.append('context_id', options.contextId);
    if (options.page) params.append('page', options.page.toString());
    if (options.limit) params.append('limit', options.limit.toString());

    const qs = params.toString();
    return this.client.request<A2AListTasksResponse>(
      qs ? `/v1/a2a/tasks?${qs}` : '/v1/a2a/tasks',
    );
  }

  /**
   * Respond to a task in input-required state (human-in-the-loop).
   */
  async respond(taskId: string, message: string): Promise<{ status: string }> {
    return this.client.request<{ status: string }>(
      `/v1/a2a/tasks/${taskId}/respond`,
      { method: 'POST', body: JSON.stringify({ message }) },
    );
  }

  // =========================================================================
  // Custom Tools (Story 58.15)
  // =========================================================================

  /**
   * Register a custom tool for an agent.
   *
   * @example
   * ```typescript
   * const tool = await sly.a2a.createCustomTool('agent-uuid', {
   *   toolName: 'lookup_inventory',
   *   description: 'Check product inventory levels',
   *   inputSchema: {
   *     type: 'object',
   *     properties: { sku: { type: 'string' } },
   *     required: ['sku'],
   *   },
   *   handlerUrl: 'https://api.example.com/inventory',
   * });
   * ```
   */
  async createCustomTool(
    agentId: string,
    request: A2ACreateCustomToolRequest,
  ): Promise<A2ACustomTool> {
    const response = await this.client.request<{ data: A2ACustomTool }>(
      `/v1/a2a/agents/${agentId}/tools`,
      { method: 'POST', body: JSON.stringify(request) },
    );
    return response.data;
  }

  /**
   * List custom tools for an agent.
   */
  async listCustomTools(agentId: string): Promise<A2ACustomTool[]> {
    const response = await this.client.request<{ data: A2ACustomTool[] }>(
      `/v1/a2a/agents/${agentId}/tools`,
    );
    return response.data;
  }

  /**
   * Delete a custom tool.
   */
  async deleteCustomTool(agentId: string, toolId: string): Promise<void> {
    await this.client.request<void>(
      `/v1/a2a/agents/${agentId}/tools/${toolId}`,
      { method: 'DELETE' },
    );
  }
}
