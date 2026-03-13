/**
 * A2A Task Event Bus (Story 58.13 + 58.17)
 *
 * In-process EventEmitter singleton for task lifecycle events.
 * Events are keyed by `task:<taskId>` so SSE handlers can subscribe
 * to a specific task's lifecycle without receiving unrelated traffic.
 *
 * Story 58.17: Events are persisted to `a2a_audit_events` table for
 * compliance and debugging. Persistence is fire-and-forget.
 */

import { EventEmitter } from 'events';
import type { SupabaseClient } from '@supabase/supabase-js';
import { trackOp } from '../ops/track-op.js';
import { OpType } from '../ops/operation-types.js';

export type TaskStreamEventType = 'status' | 'message' | 'artifact' | 'error' | 'payment' | 'timeout' | 'webhook';

export interface TaskStreamEvent {
  type: TaskStreamEventType;
  taskId: string;
  data: Record<string, unknown>;
  timestamp: string;
}

/** Context for persisting audit events. */
export interface AuditContext {
  tenantId: string;
  agentId: string;
  actorType?: 'system' | 'agent' | 'user' | 'worker';
  actorId?: string;
  fromState?: string;
  toState?: string;
  durationMs?: number;
}

const TERMINAL_STATES = new Set(['completed', 'failed', 'canceled']);

class TaskEventBus extends EventEmitter {
  private supabase: SupabaseClient | null = null;

  /**
   * Initialize the audit persistence layer.
   * Called once at server startup with the service-role client.
   */
  initAuditPersistence(supabase: SupabaseClient): void {
    this.supabase = supabase;
  }

  emitTask(taskId: string, event: TaskStreamEvent, auditCtx?: AuditContext): boolean {
    const result = super.emit(`task:${taskId}`, event);
    // Also emit on global channel for completion webhooks (Story 58.16)
    if (event.type === 'status' && TERMINAL_STATES.has(event.data.state as string)) {
      super.emit('task:terminal', event);
    }
    // Persist to audit log (fire-and-forget) — Story 58.17
    if (this.supabase && auditCtx) {
      this.persistAuditEvent(event, auditCtx).catch((err) => {
        console.warn(`[A2A-audit] Failed to persist event: ${err.message}`);
      });
    }
    // Also emit to Epic 65 operation_events for aggregate analytics
    if (auditCtx && event.type === 'status') {
      trackOp({
        tenantId: auditCtx.tenantId,
        operation: OpType.A2A_TASK_STATE_CHANGED,
        subject: `a2a/task/${taskId}`,
        actorType: auditCtx.actorType === 'worker' ? 'system' : (auditCtx.actorType as any) || 'system',
        actorId: auditCtx.actorId || auditCtx.agentId,
        success: !TERMINAL_STATES.has(event.data.state as string) || event.data.state === 'completed',
        durationMs: auditCtx.durationMs,
        data: { fromState: auditCtx.fromState, toState: auditCtx.toState || event.data.state },
      });
    }
    return result;
  }

  subscribe(taskId: string, listener: (event: TaskStreamEvent) => void): () => void {
    const channel = `task:${taskId}`;
    super.on(channel, listener);
    return () => {
      super.removeListener(channel, listener);
    };
  }

  /**
   * Persist an audit event directly (for events not routed through emitTask).
   * Used by the worker for timeout sweeps and mandate cleanup.
   */
  async persistAuditEvent(event: TaskStreamEvent, ctx: AuditContext): Promise<void> {
    if (!this.supabase) return;
    await this.supabase.from('a2a_audit_events').insert({
      tenant_id: ctx.tenantId,
      task_id: event.taskId,
      agent_id: ctx.agentId,
      event_type: event.type,
      from_state: ctx.fromState || null,
      to_state: ctx.toState || (event.data.state as string) || null,
      actor_type: ctx.actorType || 'system',
      actor_id: ctx.actorId || null,
      data: event.data,
      duration_ms: ctx.durationMs || null,
    });
  }
}

export const taskEventBus = new TaskEventBus();
