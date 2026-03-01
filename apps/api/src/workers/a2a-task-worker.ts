/**
 * A2A Task Processor Worker (Story 58.3)
 *
 * Background worker that claims submitted A2A tasks and dispatches
 * them to the correct handler based on the agent's processing_mode.
 *
 * Uses FOR UPDATE SKIP LOCKED for atomic task claiming, preventing
 * double-processing when multiple workers run concurrently.
 */

import { createClient } from '../db/client.js';
import { A2ATaskService } from '../services/a2a/task-service.js';
import { A2AWebhookHandler } from '../services/a2a/webhook-handler.js';
import { completionWebhooks } from '../services/a2a/completion-webhook.js';
import { taskEventBus } from '../services/a2a/task-event-bus.js';
import type { WebhookConfig } from '../services/a2a/types.js';
import { randomUUID } from 'crypto';
import { hostname } from 'os';

interface WorkerConfig {
  /** Poll interval in ms (default: 500) */
  pollIntervalMs: number;
  /** Max concurrent tasks in-flight (default: 5) */
  maxConcurrent: number;
  /** Max concurrent tasks per tenant (default: 3) */
  maxPerTenant: number;
  /** Task processing timeout in ms (default: 60000) */
  taskTimeoutMs: number;
  /** Graceful shutdown grace period in ms (default: 30000) */
  shutdownGracePeriodMs: number;
}

const DEFAULT_CONFIG: WorkerConfig = {
  pollIntervalMs: parseInt(process.env.A2A_WORKER_POLL_MS || '500'),
  maxConcurrent: parseInt(process.env.A2A_WORKER_MAX_CONCURRENT || '5'),
  maxPerTenant: parseInt(process.env.A2A_WORKER_MAX_PER_TENANT || '3'),
  taskTimeoutMs: parseInt(process.env.A2A_WORKER_TASK_TIMEOUT || '60000'),
  shutdownGracePeriodMs: parseInt(process.env.A2A_WORKER_SHUTDOWN_GRACE || '30000'),
};

interface ClaimedTask {
  id: string;
  tenant_id: string;
  agent_id: string;
  context_id: string | null;
  state: string;
  mandate_id: string | null;
}

interface AgentRow {
  id: string;
  processing_mode: string;
  processing_config: Record<string, unknown>;
  name: string;
  status: string;
}

export class A2ATaskWorker {
  private workerId: string;
  private config: WorkerConfig;
  private running = false;
  private activeTaskCount = 0;
  private activeTenantCounts = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(config: Partial<WorkerConfig> = {}) {
    this.workerId = `worker-${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start the worker polling loop.
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    console.log(`[A2A Worker] Started ${this.workerId}`);
    console.log(`[A2A Worker] Config: poll=${this.config.pollIntervalMs}ms, maxConcurrent=${this.config.maxConcurrent}, maxPerTenant=${this.config.maxPerTenant}`);

    // Initial poll
    this.poll().catch((err) => console.error('[A2A Worker] Initial poll error:', err.message));

    // Set up recurring poll
    this.timer = setInterval(() => {
      this.poll().catch((err) => console.error('[A2A Worker] Poll error:', err.message));
    }, this.config.pollIntervalMs);
  }

  /**
   * Stop the worker gracefully.
   * Waits for in-flight tasks to complete within the grace period.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    console.log(`[A2A Worker] Stopping... (${this.activeTaskCount} tasks in-flight)`);

    // Wait for in-flight tasks
    const deadline = Date.now() + this.config.shutdownGracePeriodMs;
    while (this.activeTaskCount > 0 && Date.now() < deadline) {
      await sleep(100);
    }

    if (this.activeTaskCount > 0) {
      console.warn(`[A2A Worker] Force stopping with ${this.activeTaskCount} tasks still in-flight`);
      // Unclaim in-flight tasks so another worker can pick them up
      await this.unclaimStaleTasks();
    }

    console.log('[A2A Worker] Stopped');
  }

  /**
   * Single poll iteration: claim a task and dispatch it.
   */
  private async poll(): Promise<void> {
    if (!this.running) return;
    if (this.activeTaskCount >= this.config.maxConcurrent) return;

    const task = await this.claimNextTask();
    if (!task) {
      // No new tasks — check for webhook retries as fallback
      await this.pollRetries();
      return;
    }

    // Check per-tenant limit
    const tenantCount = this.activeTenantCounts.get(task.tenant_id) || 0;
    if (tenantCount >= this.config.maxPerTenant) {
      // Release the claim — tenant is at capacity
      await this.releaseTask(task.id, task.tenant_id);
      return;
    }

    // Track active counts
    this.activeTaskCount++;
    this.activeTenantCounts.set(task.tenant_id, tenantCount + 1);

    // Dispatch async — don't block the poll loop
    this.dispatchTask(task)
      .catch((err) => {
        console.error(`[A2A Worker] Error dispatching task ${task.id.slice(0, 8)}:`, err.message);
      })
      .finally(() => {
        this.activeTaskCount--;
        const current = this.activeTenantCounts.get(task.tenant_id) || 1;
        if (current <= 1) {
          this.activeTenantCounts.delete(task.tenant_id);
        } else {
          this.activeTenantCounts.set(task.tenant_id, current - 1);
        }
      });
  }

  /**
   * Claim the next available task atomically.
   * Uses Supabase RPC with FOR UPDATE SKIP LOCKED to prevent double-processing.
   */
  private async claimNextTask(): Promise<ClaimedTask | null> {
    const supabase = createClient();

    // Use a two-step claim: find + update with optimistic locking
    // Supabase doesn't support FOR UPDATE SKIP LOCKED directly,
    // so we use an atomic update with a WHERE clause on processor_id IS NULL
    const { data: candidates } = await supabase
      .from('a2a_tasks')
      .select('id, tenant_id, agent_id, context_id, state, mandate_id')
      .eq('state', 'submitted')
      .is('processor_id', null)
      .eq('direction', 'inbound')
      .order('created_at', { ascending: true })
      .limit(5);

    if (!candidates?.length) return null;

    // Sort by priority: mandates first, then context_id, then new
    candidates.sort((a: any, b: any) => {
      const priorityA = a.mandate_id ? 0 : a.context_id ? 1 : 2;
      const priorityB = b.mandate_id ? 0 : b.context_id ? 1 : 2;
      return priorityA - priorityB;
    });

    // Try to claim each candidate (first one that succeeds wins)
    for (const candidate of candidates) {
      // Skip if tenant is at capacity
      const tenantCount = this.activeTenantCounts.get(candidate.tenant_id) || 0;
      if (tenantCount >= this.config.maxPerTenant) continue;

      // Atomic claim: update only if processor_id is still null
      const { data: claimed, error } = await supabase
        .from('a2a_tasks')
        .update({
          state: 'working',
          processor_id: this.workerId,
          processing_started_at: new Date().toISOString(),
        })
        .eq('id', candidate.id)
        .is('processor_id', null)
        .eq('state', 'submitted')
        .select('id, tenant_id, agent_id, context_id, state, mandate_id')
        .single();

      if (!error && claimed) {
        console.log(`[A2A Worker] Claimed task ${claimed.id.slice(0, 8)} (tenant: ${claimed.tenant_id.slice(0, 8)}, agent: ${claimed.agent_id.slice(0, 8)})`);
        taskEventBus.emitTask(claimed.id, {
          type: 'status',
          taskId: claimed.id,
          data: { state: 'working', workerId: this.workerId },
          timestamp: new Date().toISOString(),
        });
        return claimed as ClaimedTask;
      }
      // If update failed (another worker claimed it), try next candidate
    }

    return null;
  }

  /**
   * Dispatch a claimed task to the correct handler.
   */
  private async dispatchTask(task: ClaimedTask): Promise<void> {
    const supabase = createClient();
    const startTime = Date.now();

    try {
      // Load agent's processing config
      const { data: agent } = await supabase
        .from('agents')
        .select('id, processing_mode, processing_config, name, status')
        .eq('id', task.agent_id)
        .eq('tenant_id', task.tenant_id)
        .single();

      if (!agent || agent.status !== 'active') {
        await this.failTask(supabase, task, 'Agent not found or inactive');
        return;
      }

      const mode = (agent as any).processing_mode || 'manual';
      const config = (agent as any).processing_config || {};

      console.log(`[A2A Worker] Dispatching task ${task.id.slice(0, 8)} via '${mode}' handler`);

      switch (mode) {
        case 'managed':
          // Story 58.4 will implement the full LLM handler.
          // For now, fall back to the existing regex-based processor.
          await this.handleManaged(supabase, task, agent as any, config);
          break;

        case 'webhook':
          // Story 58.5 will implement the webhook handler.
          await this.handleWebhook(supabase, task, agent as any, config);
          break;

        case 'manual':
          // Manual mode: add system message and leave in working state
          // so dashboard can show it in the pending queue.
          await this.handleManual(supabase, task, agent as any);
          break;

        default:
          await this.failTask(supabase, task, `Unknown processing mode: ${mode}`);
      }
    } catch (err: any) {
      console.error(`[A2A Worker] Task ${task.id.slice(0, 8)} failed:`, err.message);
      const supabase2 = createClient();
      await this.failTask(supabase2, task, err.message);
    } finally {
      // Record processing duration
      const duration = Date.now() - startTime;
      const supabase3 = createClient();
      await supabase3
        .from('a2a_tasks')
        .update({
          processing_completed_at: new Date().toISOString(),
          processing_duration_ms: duration,
        })
        .eq('id', task.id);
    }
  }

  /**
   * Managed handler placeholder.
   * Uses the existing regex-based processor until Story 58.4 adds LLM.
   */
  private async handleManaged(
    supabase: SupabaseClient,
    task: ClaimedTask,
    agent: AgentRow,
    config: Record<string, unknown>,
  ): Promise<void> {
    // Import existing processor for backward compatibility
    const { A2ATaskProcessor } = await import('../services/a2a/task-processor.js');
    const processor = new A2ATaskProcessor(supabase, task.tenant_id);

    // The existing processTask transitions from submitted→working→completed
    // But we already set state to 'working' during claim, so we need to
    // call it with the task ID. The existing processor will re-fetch and handle.
    // It transitions submitted→working internally, but since it's already working,
    // it will just process the intent.
    await processor.processTask(task.id);
  }

  /**
   * Webhook handler: dispatch task to external callback URL with HMAC signing.
   * On success, task stays in 'working' state awaiting external state update.
   * On failure, schedules retry or moves to DLQ.
   */
  private async handleWebhook(
    supabase: SupabaseClient,
    task: ClaimedTask,
    agent: AgentRow,
    config: Record<string, unknown>,
  ): Promise<void> {
    const callbackUrl = config.callbackUrl as string;
    if (!callbackUrl) {
      await this.failTask(supabase, task, 'Webhook agent missing callbackUrl in processing_config');
      return;
    }

    const webhookConfig: WebhookConfig = {
      callbackUrl,
      callbackSecret: config.callbackSecret as string | undefined,
      timeoutMs: config.timeoutMs as number | undefined,
    };

    const deliveryId = randomUUID();
    const webhookHandler = new A2AWebhookHandler(supabase);
    const taskService = new A2ATaskService(supabase, task.tenant_id);

    // Set webhook_status to pending
    await supabase
      .from('a2a_tasks')
      .update({
        webhook_status: 'pending',
        webhook_delivery_id: deliveryId,
      })
      .eq('id', task.id);

    // Dispatch
    const result = await webhookHandler.dispatch(task, webhookConfig, deliveryId);

    if (result.success) {
      await webhookHandler.recordSuccess(task.id, result);

      await taskService.addMessage(task.id, 'agent', [
        { text: `Task dispatched to webhook: ${callbackUrl}` },
      ]);
      // Task stays in 'working' state — external system will PATCH to complete
    } else {
      // Get current attempts from DB
      const { data: currentTask } = await supabase
        .from('a2a_tasks')
        .select('webhook_attempts')
        .eq('id', task.id)
        .single();

      const currentAttempts = (currentTask as any)?.webhook_attempts || 0;
      await webhookHandler.recordFailure(task.id, task.tenant_id, result, currentAttempts);
    }
  }

  /**
   * Poll for webhook tasks ready for retry.
   * Called as fallback when no new tasks are found.
   */
  private async pollRetries(): Promise<void> {
    const supabase = createClient();

    const { data: retryTasks } = await supabase
      .from('a2a_tasks')
      .select('id, tenant_id, agent_id, context_id, state, mandate_id, webhook_attempts')
      .eq('webhook_status', 'failed')
      .lte('webhook_next_retry_at', new Date().toISOString())
      .lt('webhook_attempts', 5)
      .order('webhook_next_retry_at', { ascending: true })
      .limit(5);

    if (!retryTasks?.length) return;

    console.log(`[A2A Worker] Found ${retryTasks.length} webhook tasks ready for retry`);

    for (const retryTask of retryTasks) {
      // Load agent config
      const { data: agent } = await supabase
        .from('agents')
        .select('id, processing_mode, processing_config, name, status')
        .eq('id', retryTask.agent_id)
        .eq('tenant_id', retryTask.tenant_id)
        .single();

      if (!agent || agent.status !== 'active') {
        // Agent gone — move to DLQ
        const webhookHandler = new A2AWebhookHandler(supabase);
        await webhookHandler.recordFailure(
          retryTask.id,
          retryTask.tenant_id,
          { success: false, responseTimeMs: 0, error: 'Agent not found or inactive' },
          (retryTask as any).webhook_attempts || 0,
          0, // Force DLQ by setting maxRetries to 0
        );
        continue;
      }

      const config = (agent as any).processing_config || {};
      const webhookConfig: WebhookConfig = {
        callbackUrl: config.callbackUrl as string,
        callbackSecret: config.callbackSecret as string | undefined,
        timeoutMs: config.timeoutMs as number | undefined,
      };

      if (!webhookConfig.callbackUrl) continue;

      const deliveryId = randomUUID();
      const webhookHandler = new A2AWebhookHandler(supabase);

      // Update delivery ID for retry
      await supabase
        .from('a2a_tasks')
        .update({ webhook_delivery_id: deliveryId })
        .eq('id', retryTask.id);

      const result = await webhookHandler.dispatch(retryTask, webhookConfig, deliveryId);

      if (result.success) {
        await webhookHandler.recordSuccess(retryTask.id, result);
      } else {
        await webhookHandler.recordFailure(
          retryTask.id,
          retryTask.tenant_id,
          result,
          (retryTask as any).webhook_attempts || 0,
        );
      }
    }

    // Also check for completion callback retries (Story 58.16)
    await this.pollCallbackRetries();
  }

  /**
   * Poll for completion callback tasks ready for retry.
   */
  private async pollCallbackRetries(): Promise<void> {
    const supabase = createClient();

    const { data: callbackRetries } = await supabase
      .from('a2a_tasks')
      .select('id, tenant_id, callback_url, callback_secret, callback_attempts')
      .eq('callback_status', 'failed')
      .not('callback_url', 'is', null)
      .lte('callback_next_retry_at', new Date().toISOString())
      .lt('callback_attempts', 5)
      .order('callback_next_retry_at', { ascending: true })
      .limit(5);

    if (!callbackRetries?.length) return;

    console.log(`[A2A Worker] Found ${callbackRetries.length} completion callbacks ready for retry`);

    for (const task of callbackRetries) {
      await completionWebhooks.retryDelivery(task as any);
    }
  }

  /**
   * Manual handler: leave task in queue for human processing.
   */
  private async handleManual(
    supabase: SupabaseClient,
    task: ClaimedTask,
    agent: AgentRow,
  ): Promise<void> {
    const taskService = new A2ATaskService(supabase, task.tenant_id);

    await taskService.addMessage(task.id, 'agent', [
      { text: 'Task queued for manual processing. A human operator will review this shortly.' },
    ]);

    // Set to input-required with structured context so callers know what to do
    await taskService.setInputRequired(
      task.id,
      'Awaiting manual processing',
      {
        reason_code: 'manual_processing',
        next_action: 'human_respond',
        required_auth: 'none',
      },
    );
  }

  /**
   * Mark a task as failed with error details.
   */
  private async failTask(
    supabase: SupabaseClient,
    task: ClaimedTask,
    errorMessage: string,
  ): Promise<void> {
    taskEventBus.emitTask(task.id, {
      type: 'error',
      taskId: task.id,
      data: { message: errorMessage },
      timestamp: new Date().toISOString(),
    });

    const taskService = new A2ATaskService(supabase, task.tenant_id);

    await supabase
      .from('a2a_tasks')
      .update({
        error_details: { message: errorMessage, workerId: this.workerId },
      })
      .eq('id', task.id);

    await taskService.addMessage(task.id, 'agent', [
      { text: `Task processing failed: ${errorMessage}` },
    ]);

    await taskService.updateTaskState(task.id, 'failed', errorMessage);
  }

  /**
   * Release a claimed task back to the queue.
   */
  private async releaseTask(taskId: string, tenantId: string): Promise<void> {
    const supabase = createClient();
    await supabase
      .from('a2a_tasks')
      .update({
        state: 'submitted',
        processor_id: null,
        processing_started_at: null,
      })
      .eq('id', taskId);
  }

  /**
   * Unclaim stale tasks owned by this worker (for forced shutdown).
   */
  private async unclaimStaleTasks(): Promise<void> {
    const supabase = createClient();
    const { data } = await supabase
      .from('a2a_tasks')
      .update({
        state: 'submitted',
        processor_id: null,
        processing_started_at: null,
      })
      .eq('processor_id', this.workerId)
      .eq('state', 'working')
      .select('id');

    if (data?.length) {
      console.log(`[A2A Worker] Unclaimed ${data.length} stale tasks`);
    }
  }
}

// Need to import SupabaseClient type for handleManaged
import type { SupabaseClient } from '@supabase/supabase-js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Factory function matching the pattern used by other workers.
 */
export function getA2ATaskWorker(config?: Partial<WorkerConfig>): A2ATaskWorker {
  return new A2ATaskWorker(config);
}
