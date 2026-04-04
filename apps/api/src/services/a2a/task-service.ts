/**
 * A2A Task Service
 *
 * Core task lifecycle operations for the A2A protocol (v1.0).
 * Manages tasks, messages, and artifacts in the database.
 *
 * @see Epic 57: Google A2A Protocol Integration
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  A2ATask,
  A2ATaskState,
  A2AMessage,
  A2AArtifact,
  A2APart,
  A2ATaskRow,
  A2AMessageRow,
  A2AArtifactRow,
  InputRequiredContext,
} from './types.js';
import { normalizeParts } from './types.js';
import { taskEventBus, type AuditContext } from './task-event-bus.js';

/** Default maximum messages to include in context window (Story 58.18). */
const DEFAULT_MAX_CONTEXT_MESSAGES = 100;

export interface ListTasksFilters {
  agentId?: string | null;
  callerAgentId?: string | null;
  state?: A2ATaskState;
  direction?: 'inbound' | 'outbound';
  contextId?: string | null;
  page?: number;
  limit?: number;
}

export class A2ATaskService {
  constructor(
    private supabase: SupabaseClient,
    private tenantId: string,
    private environment: 'test' | 'live' = 'test',
  ) {}

  /**
   * Create a new A2A task with an initial message.
   */
  async createTask(
    agentId: string,
    message: { role?: 'user' | 'agent'; parts: A2APart[]; metadata?: Record<string, unknown> },
    contextId?: string,
    direction: 'inbound' | 'outbound' = 'inbound',
    remoteAgentUrl?: string,
    remoteTaskId?: string,
    callbackUrl?: string,
    callbackSecret?: string,
    clientAgentId?: string,
  ): Promise<A2ATask> {
    // Insert task
    const { data: taskRow, error: taskError } = await this.supabase
      .from('a2a_tasks')
      .insert({
        tenant_id: this.tenantId,
        environment: this.environment,
        agent_id: agentId,
        context_id: contextId || crypto.randomUUID(),
        state: 'submitted',
        direction,
        remote_agent_url: remoteAgentUrl || null,
        remote_task_id: remoteTaskId || null,
        callback_url: callbackUrl || null,
        callback_secret: callbackSecret || null,
        client_agent_id: clientAgentId || null,
      })
      .select()
      .single();

    if (taskError || !taskRow) {
      throw new Error(`Failed to create task: ${taskError?.message || 'unknown error'}`);
    }

    // Insert initial message
    const { data: msgRow, error: msgError } = await this.supabase
      .from('a2a_messages')
      .insert({
        tenant_id: this.tenantId,
        environment: this.environment,
        task_id: taskRow.id,
        role: message.role || 'user',
        parts: normalizeParts(message.parts),
        metadata: message.metadata || {},
      })
      .select()
      .single();

    if (msgError) {
      throw new Error(`Failed to create message: ${msgError.message}`);
    }

    return this.rowToTask(taskRow as A2ATaskRow, [msgRow as A2AMessageRow], []);
  }

  /**
   * Get a task by ID with its messages and artifacts.
   *
   * Story 58.18: Context window management — limits messages to the most
   * recent N (not oldest N). Applies a default cap of 100 if no explicit
   * historyLength is provided and the agent hasn't configured one.
   */
  async getTask(taskId: string, historyLength?: number): Promise<A2ATask | null> {
    const { data: taskRow, error: taskError } = await this.supabase
      .from('a2a_tasks')
      .select('*')
      .eq('id', taskId)
      .eq('tenant_id', this.tenantId)
      .eq('environment', this.environment)
      .single();

    if (taskError || !taskRow) return null;

    // Resolve effective context window limit:
    // 1. Explicit historyLength from caller (e.g. A2AConfiguration)
    // 2. Agent-level max_context_messages setting
    // 3. Global default (100)
    let effectiveLimit = historyLength;
    if (!effectiveLimit) {
      const { data: agentRow } = await this.supabase
        .from('agents')
        .select('max_context_messages')
        .eq('id', taskRow.agent_id)
        .eq('tenant_id', this.tenantId)
        .eq('environment', this.environment)
        .maybeSingle();
      effectiveLimit = agentRow?.max_context_messages || DEFAULT_MAX_CONTEXT_MESSAGES;
    }

    // Fetch the most recent N messages (descending), then reverse to chronological order
    const { data: messagesDesc } = await this.supabase
      .from('a2a_messages')
      .select('*')
      .eq('task_id', taskId)
      .eq('tenant_id', this.tenantId)
      .order('created_at', { ascending: false })
      .limit(effectiveLimit);

    const messages = (messagesDesc || []).reverse();

    // Fetch artifacts
    const { data: artifacts } = await this.supabase
      .from('a2a_artifacts')
      .select('*')
      .eq('task_id', taskId)
      .eq('tenant_id', this.tenantId)
      .order('created_at', { ascending: true });

    return this.rowToTask(
      taskRow as A2ATaskRow,
      (messages || []) as A2AMessageRow[],
      (artifacts || []) as A2AArtifactRow[],
    );
  }

  /**
   * Update a task's state.
   */
  async updateTaskState(
    taskId: string,
    state: A2ATaskState,
    statusMessage?: string,
    metadata?: Record<string, unknown>,
  ): Promise<A2ATask | null> {
    const updateData: Record<string, unknown> = { state };
    if (statusMessage !== undefined) updateData.status_message = statusMessage;

    // Read current state + metadata before the update (for audit trail from_state)
    const { data: currentRow } = await this.supabase
      .from('a2a_tasks')
      .select('state, metadata')
      .eq('id', taskId)
      .eq('tenant_id', this.tenantId)
      .eq('environment', this.environment)
      .single();

    const previousState = currentRow?.state !== state ? currentRow?.state : undefined;

    // Merge metadata so existing keys aren't lost
    if (metadata) {
      updateData.metadata = { ...(currentRow?.metadata || {}), ...metadata };
    }

    // When re-submitting a task, clear processor claim so worker can re-acquire it
    if (state === 'submitted') {
      updateData.processor_id = null;
      updateData.processing_started_at = null;
    }

    const terminalStates = ['completed', 'failed', 'canceled', 'rejected'];

    let query = this.supabase
      .from('a2a_tasks')
      .update(updateData)
      .eq('id', taskId)
      .eq('tenant_id', this.tenantId)
      .eq('environment', this.environment);

    // If transitioning to a terminal state, guard against already-terminal
    if (terminalStates.includes(state)) {
      query = query.not('state', 'in', `(${terminalStates.join(',')})`);
    }

    const { data: taskRow, error } = await query.select().single();

    if (error || !taskRow) return null; // Already terminal or not found — skip event emission

    taskEventBus.emitTask(taskId, {
      type: 'status',
      taskId,
      data: { state, statusMessage: statusMessage || null },
      timestamp: new Date().toISOString(),
    }, {
      tenantId: this.tenantId,
      agentId: taskRow.agent_id,
      actorType: 'system',
      fromState: previousState,
      toState: state,
    });

    return this.getTask(taskId);
  }

  /**
   * Add a message to an existing task.
   */
  async addMessage(
    taskId: string,
    role: 'user' | 'agent',
    parts: A2APart[],
    metadata?: Record<string, unknown>,
  ): Promise<A2AMessage> {
    const { data: msgRow, error } = await this.supabase
      .from('a2a_messages')
      .insert({
        tenant_id: this.tenantId,
        environment: this.environment,
        task_id: taskId,
        role,
        parts: normalizeParts(parts),
        metadata: metadata || {},
      })
      .select()
      .single();

    if (error || !msgRow) {
      throw new Error(`Failed to add message: ${error?.message || 'unknown error'}`);
    }

    const msg = this.rowToMessage(msgRow as A2AMessageRow);

    // Look up agent_id for audit context
    const { data: taskRow } = await this.supabase
      .from('a2a_tasks')
      .select('agent_id')
      .eq('id', taskId)
      .eq('tenant_id', this.tenantId)
      .eq('environment', this.environment)
      .maybeSingle();

    taskEventBus.emitTask(taskId, {
      type: 'message',
      taskId,
      data: { messageId: msg.messageId, role, parts: msg.parts },
      timestamp: new Date().toISOString(),
    }, taskRow ? {
      tenantId: this.tenantId,
      agentId: taskRow.agent_id,
      actorType: role === 'user' ? 'user' : 'agent',
    } : undefined);

    return msg;
  }

  /**
   * Add an artifact to a task.
   * v1.0: accepts `name` and `mediaType` (not `label`/`mimeType`).
   */
  async addArtifact(
    taskId: string,
    artifact: { name?: string; mediaType?: string; parts: A2APart[]; metadata?: Record<string, unknown> },
  ): Promise<A2AArtifact> {
    const { data: row, error } = await this.supabase
      .from('a2a_artifacts')
      .insert({
        tenant_id: this.tenantId,
        environment: this.environment,
        task_id: taskId,
        label: artifact.name || null,
        mime_type: artifact.mediaType || 'text/plain',
        parts: normalizeParts(artifact.parts),
        metadata: artifact.metadata || {},
      })
      .select()
      .single();

    if (error || !row) {
      throw new Error(`Failed to add artifact: ${error?.message || 'unknown error'}`);
    }

    const art = this.rowToArtifact(row as A2AArtifactRow);

    // Look up agent_id for audit context
    const { data: artTaskRow } = await this.supabase
      .from('a2a_tasks')
      .select('agent_id')
      .eq('id', taskId)
      .eq('tenant_id', this.tenantId)
      .eq('environment', this.environment)
      .maybeSingle();

    taskEventBus.emitTask(taskId, {
      type: 'artifact',
      taskId,
      data: {
        artifactId: art.artifactId,
        name: art.name || null,
        mediaType: art.mediaType,
        parts: art.parts,
      },
      timestamp: new Date().toISOString(),
    }, artTaskRow ? {
      tenantId: this.tenantId,
      agentId: artTaskRow.agent_id,
      actorType: 'agent',
    } : undefined);

    return art;
  }

  /**
   * Cancel a task.
   */
  async cancelTask(taskId: string): Promise<A2ATask | null> {
    return this.updateTaskState(taskId, 'canceled', 'Task canceled by user');
  }

  /**
   * Set a task to input-required with structured context.
   * Provides machine-readable guidance so callers know how to resolve.
   */
  async setInputRequired(
    taskId: string,
    statusMessage: string,
    context: InputRequiredContext,
  ): Promise<A2ATask | null> {
    return this.updateTaskState(taskId, 'input-required', statusMessage, {
      input_required_context: context,
    });
  }

  /**
   * List tasks with filtering and pagination.
   */
  async listTasks(filters: ListTasksFilters = {}) {
    const { agentId, callerAgentId, state, direction, contextId, page = 1, limit = 20 } = filters;
    const offset = (page - 1) * limit;

    let query = this.supabase
      .from('a2a_tasks')
      .select('*, agents!inner(name)', { count: 'exact' })
      .eq('tenant_id', this.tenantId)
      .eq('environment', this.environment)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (agentId) query = query.eq('agent_id', agentId);
    if (callerAgentId) query = query.eq('client_agent_id', callerAgentId);
    if (state) query = query.eq('state', state);
    if (direction) query = query.eq('direction', direction);
    if (contextId) query = query.eq('context_id', contextId);

    const { data: rows, count, error } = await query;

    if (error) {
      throw new Error(`Failed to list tasks: ${error.message}`);
    }

    // Batch-fetch transfer amounts for tasks with linked transfers
    const transferIds = (rows || [])
      .map((r: any) => r.transfer_id)
      .filter(Boolean) as string[];
    const transferAmounts = new Map<string, { amount: number; currency: string; status: string }>();
    if (transferIds.length > 0) {
      const { data: transfers } = await this.supabase
        .from('transfers')
        .select('id, amount, currency, status')
        .in('id', transferIds)
        .eq('tenant_id', this.tenantId);
      for (const t of transfers || []) {
        transferAmounts.set(t.id, { amount: Number(t.amount) || 0, currency: t.currency, status: t.status });
      }
    }

    // Batch-fetch message counts per task
    const taskIds = (rows || []).map((r: any) => r.id);
    const messageCounts = new Map<string, number>();
    if (taskIds.length > 0) {
      const { data: msgCounts } = await this.supabase
        .from('a2a_messages')
        .select('task_id')
        .in('task_id', taskIds)
        .eq('tenant_id', this.tenantId);
      for (const m of msgCounts || []) {
        messageCounts.set(m.task_id, (messageCounts.get(m.task_id) || 0) + 1);
      }
    }

    const tasks = (rows || []).map((row: any) => {
      const transfer = row.transfer_id ? transferAmounts.get(row.transfer_id) : undefined;
      return {
        id: row.id,
        agentId: row.agent_id,
        agentName: row.agents?.name || null,
        contextId: row.context_id,
        state: row.state,
        statusMessage: row.status_message,
        direction: row.direction,
        remoteAgentUrl: row.remote_agent_url,
        clientAgentId: row.client_agent_id,
        transferId: row.transfer_id || undefined,
        transferAmount: transfer?.amount,
        transferCurrency: transfer?.currency,
        transferStatus: transfer?.status,
        mandateId: row.mandate_id || undefined,
        sessionId: row.a2a_session_id || undefined,
        messageCount: messageCounts.get(row.id) || 0,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });

    return {
      data: tasks,
      pagination: {
        page,
        limit,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limit),
      },
    };
  }

  /**
   * Find an existing task by contextId for multi-turn conversations.
   */
  async findTaskByContext(agentId: string, contextId: string): Promise<A2ATask | null> {
    const { data: taskRow } = await this.supabase
      .from('a2a_tasks')
      .select('*')
      .eq('agent_id', agentId)
      .eq('context_id', contextId)
      .eq('tenant_id', this.tenantId)
      .eq('environment', this.environment)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!taskRow) return null;
    return this.getTask(taskRow.id);
  }

  /**
   * Find the most recent session (context_id) for a caller+agent pair within a time window.
   * Used for session affinity — grouping tasks from the same caller to the same agent.
   */
  async findRecentSession(agentId: string, callerAgentId: string, windowMs = 3_600_000): Promise<string | null> {
    const cutoff = new Date(Date.now() - windowMs).toISOString();
    const { data } = await this.supabase
      .from('a2a_tasks')
      .select('context_id')
      .eq('agent_id', agentId)
      .eq('client_agent_id', callerAgentId)
      .eq('tenant_id', this.tenantId)
      .eq('environment', this.environment)
      .not('context_id', 'is', null)
      .gte('updated_at', cutoff)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    return data?.context_id || null;
  }

  /**
   * Link a payment to a task.
   */
  async linkPayment(
    taskId: string,
    transferId?: string,
    mandateId?: string,
  ): Promise<void> {
    const update: Record<string, unknown> = {};
    if (transferId) update.transfer_id = transferId;
    if (mandateId) update.mandate_id = mandateId;

    await this.supabase
      .from('a2a_tasks')
      .update(update)
      .eq('id', taskId)
      .eq('tenant_id', this.tenantId)
      .eq('environment', this.environment);
  }

  // ==========================================================================
  // Private helpers
  // ==========================================================================

  private rowToTask(
    row: A2ATaskRow,
    messages: A2AMessageRow[],
    artifacts: A2AArtifactRow[],
  ): A2ATask & {
    direction?: string;
    transferId?: string;
    mandateId?: string;
    agentId?: string;
    remoteAgentUrl?: string;
    clientAgentId?: string;
  } {
    return {
      id: row.id,
      contextId: row.context_id || undefined,
      status: {
        state: row.state,
        message: row.status_message || undefined,
        timestamp: row.updated_at,
      },
      history: messages.map((m) => this.rowToMessage(m)),
      artifacts: artifacts.map((a) => this.rowToArtifact(a)),
      metadata: row.metadata || undefined,
      direction: row.direction || undefined,
      transferId: row.transfer_id || undefined,
      mandateId: row.mandate_id || undefined,
      agentId: row.agent_id || undefined,
      remoteAgentUrl: row.remote_agent_url || undefined,
      clientAgentId: row.client_agent_id || undefined,
    };
  }

  private rowToMessage(row: A2AMessageRow): A2AMessage {
    return {
      messageId: row.id,
      role: row.role,
      parts: normalizeParts(row.parts),
      metadata: row.metadata || undefined,
      createdAt: row.created_at,
    };
  }

  private rowToArtifact(row: A2AArtifactRow): A2AArtifact {
    return {
      artifactId: row.id,
      name: row.label || undefined,
      mediaType: row.mime_type,
      parts: normalizeParts(row.parts),
      metadata: row.metadata || undefined,
    };
  }
}
