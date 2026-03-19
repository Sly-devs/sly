/**
 * MPP Streamed Payment SSE Handler
 *
 * Proxies Server-Sent Events from MPP services with per-token
 * spend tracking, budget enforcement mid-stream, and graceful termination.
 *
 * @see Story 71.10: Streamed Payment SSE
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { MppSessionManager } from './session-manager.js';
import { trackOp } from '../ops/track-op.js';
import { OpType } from '../ops/operation-types.js';

// ============================================
// Types
// ============================================

export interface StreamOptions {
  sessionId: string;
  tenantId: string;
  /** Target URL to proxy SSE from */
  targetUrl: string;
  /** Cost per token/unit (for metered streams) */
  costPerUnit?: number;
  /** Budget threshold for mid-stream warning */
  warningThreshold?: number;
  /** Correlation ID */
  correlationId?: string;
}

export interface StreamEvent {
  type: 'data' | 'budget_warning' | 'budget_exhausted' | 'error' | 'done';
  data?: string;
  spent?: number;
  remaining?: number;
  voucherIndex?: number;
}

// ============================================
// Stream Handler
// ============================================

export class MppStreamHandler {
  private sessionManager: MppSessionManager;

  constructor(supabase: SupabaseClient) {
    this.sessionManager = new MppSessionManager(supabase);
  }

  /**
   * Create an SSE stream that proxies from an MPP service
   * while tracking spending per token/chunk.
   *
   * Returns a ReadableStream<Uint8Array> for use with Hono's streaming response.
   */
  createStream(options: StreamOptions): ReadableStream<Uint8Array> {
    const { sessionId, tenantId, targetUrl, costPerUnit = 0, warningThreshold = 0.8, correlationId } = options;
    const sessionManager = this.sessionManager;
    const encoder = new TextEncoder();

    let aborted = false;
    let totalUnits = 0;

    return new ReadableStream({
      async start(controller) {
        try {
          // Verify session is valid
          const session = await sessionManager.getSession(sessionId, tenantId);
          if (!session || (session.status !== 'open' && session.status !== 'active')) {
            const errEvent = `data: ${JSON.stringify({ type: 'error', data: 'Session not active' })}\n\n`;
            controller.enqueue(encoder.encode(errEvent));
            controller.close();
            return;
          }

          const budget = session.maxBudget || session.depositAmount;
          let cumulativeSpent = session.spentAmount;

          // Fetch SSE from target
          const response = await fetch(targetUrl, {
            headers: { 'Accept': 'text/event-stream' },
            signal: AbortSignal.timeout(300000), // 5 min max
          });

          if (!response.ok || !response.body) {
            const errEvent = `data: ${JSON.stringify({ type: 'error', data: `Upstream error: ${response.status}` })}\n\n`;
            controller.enqueue(encoder.encode(errEvent));
            controller.close();
            return;
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder();

          while (!aborted) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            totalUnits++;

            // Track spend per chunk
            if (costPerUnit > 0) {
              cumulativeSpent += costPerUnit;

              // Sign voucher periodically (every 10 units or every $0.01)
              if (totalUnits % 10 === 0 || costPerUnit >= 0.01) {
                const voucherResult = await sessionManager.signVoucher({
                  sessionId,
                  tenantId,
                  amount: costPerUnit * Math.min(10, totalUnits),
                  correlationId,
                });

                if (!voucherResult.success) {
                  // Budget exhausted - graceful termination
                  const exhaustedEvent = `data: ${JSON.stringify({
                    type: 'budget_exhausted',
                    spent: cumulativeSpent,
                    remaining: 0,
                  })}\n\n`;
                  controller.enqueue(encoder.encode(exhaustedEvent));

                  trackOp({
                    tenantId,
                    operation: OpType.MPP_SESSION_EXHAUSTED,
                    subject: `session/${sessionId}`,
                    correlationId,
                    success: false,
                    amountUsd: cumulativeSpent,
                    data: { totalUnits, reason: 'budget_exhausted_mid_stream' },
                  });

                  aborted = true;
                  reader.cancel();
                  break;
                }
              }

              // Warning when approaching budget
              const usageRatio = cumulativeSpent / budget;
              if (usageRatio >= warningThreshold && usageRatio < 1) {
                const warnEvent = `data: ${JSON.stringify({
                  type: 'budget_warning',
                  spent: cumulativeSpent,
                  remaining: budget - cumulativeSpent,
                })}\n\n`;
                controller.enqueue(encoder.encode(warnEvent));
              }
            }

            // Forward the chunk
            controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
          }

          // Send done event
          if (!aborted) {
            const doneEvent = `data: ${JSON.stringify({
              type: 'done',
              spent: cumulativeSpent,
              remaining: budget - cumulativeSpent,
              totalUnits,
            })}\n\n`;
            controller.enqueue(encoder.encode(doneEvent));
          }

          controller.close();
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : 'Unknown stream error';
          try {
            const errEvent = `data: ${JSON.stringify({ type: 'error', data: errMsg })}\n\n`;
            controller.enqueue(encoder.encode(errEvent));
            controller.close();
          } catch {
            // Controller may already be closed
          }
        }
      },

      cancel() {
        aborted = true;
      },
    });
  }
}
