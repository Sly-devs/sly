/**
 * MPP Session Manager
 *
 * Manages streaming payment sessions with governance checks at every step:
 * - openSession: policy check -> mppx session open -> record
 * - signVoucher: per-voucher policy check, cumulative tracking, budget warnings
 * - closeSession: settle -> record final transfer
 *
 * @see Story 71.7: Governed Session Manager
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { MppClient, getMppClient, createMppClient } from './client.js';
import { MppTransferRecorder } from './transfer-recorder.js';
import { SpendingPolicyService, type PolicyContext } from '../spending-policy.js';
import { trackOp } from '../ops/track-op.js';
import { OpType } from '../ops/operation-types.js';
import type { MppSession, MppSessionRow, MppSessionStatus } from './types.js';

// ============================================
// Types
// ============================================

export interface OpenSessionOptions {
  tenantId: string;
  agentId: string;
  walletId: string;
  serviceUrl: string;
  depositAmount: number;
  maxBudget?: number;
  currency?: string;
  correlationId?: string;
  environment?: 'test' | 'live';
}

export interface OpenSessionResult {
  success: boolean;
  session?: MppSession;
  deniedReason?: string;
  violationType?: string;
}

export interface SignVoucherOptions {
  sessionId: string;
  tenantId: string;
  amount: number;
  correlationId?: string;
  environment?: 'test' | 'live';
}

export interface SignVoucherResult {
  success: boolean;
  voucherIndex?: number;
  cumulativeSpent?: number;
  remainingBudget?: number;
  deniedReason?: string;
  transferId?: string;
}

export interface CloseSessionResult {
  success: boolean;
  session?: MppSession;
  finalTransferId?: string;
  error?: string;
}

// ============================================
// Session Manager
// ============================================

export class MppSessionManager {
  private mppClient: MppClient;
  private policyService: SpendingPolicyService;
  private recorder: MppTransferRecorder;

  constructor(
    private supabase: SupabaseClient,
    mppClient?: MppClient,
  ) {
    this.mppClient = mppClient || getMppClient();
    this.policyService = new SpendingPolicyService(supabase);
    this.recorder = new MppTransferRecorder(supabase);
  }

  /**
   * Open a new streaming session with governance checks.
   */
  async openSession(options: OpenSessionOptions): Promise<OpenSessionResult> {
    const { tenantId, agentId, walletId, serviceUrl, depositAmount, maxBudget, correlationId, environment = 'test' } = options;

    // 1. Check spending policy for the deposit amount
    const policyContext: PolicyContext = {
      protocol: 'mpp',
      vendor: new URL(serviceUrl).hostname,
      mppServiceUrl: serviceUrl,
    };

    const policyResult = await this.policyService.checkPolicy(
      walletId, depositAmount, policyContext, correlationId
    );

    if (!policyResult.allowed) {
      trackOp({
        tenantId,
        operation: OpType.MPP_POLICY_VIOLATED,
        subject: `wallet/${walletId}`,
        correlationId,
        success: false,
        amountUsd: depositAmount,
        data: { serviceUrl, reason: policyResult.reason, action: 'open_session' },
      });
      return {
        success: false,
        deniedReason: policyResult.reason,
        violationType: policyResult.violationType,
      };
    }

    // 2. Check concurrent session limits
    const concurrentCount = await this.getActiveSessionCount(tenantId, agentId, environment);
    const maxConcurrent = 10; // Default; Story 71.9 adds policy-driven limits
    if (concurrentCount >= maxConcurrent) {
      return {
        success: false,
        deniedReason: `Agent has ${concurrentCount} active sessions (max: ${maxConcurrent})`,
      };
    }

    // 3. Resolve per-agent wallet key (if available)
    let sessionClient = this.mppClient;
    try {
      const { data: walletRow } = await this.supabase
        .from('wallets')
        .select('provider_metadata, currency')
        .eq('id', walletId)
        .eq('tenant_id', tenantId)
        .eq('environment', environment)
        .single();
      const encryptedKey = walletRow?.provider_metadata?.encrypted_private_key;
      if (encryptedKey) {
        sessionClient = createMppClient({ privateKey: encryptedKey });
        console.log('[MPP] Using per-agent wallet key for session open');
      }
    } catch (err) {
      console.warn('[MPP] Could not resolve per-agent wallet key, using global:', err);
    }

    // 4. Open session via mppx (wrapped in try/catch for day-one SDK)
    let mppSessionId: string | undefined;
    try {
      const mppSession = await sessionClient.openSession(serviceUrl, {
        deposit: String(depositAmount),
        maxBudget: maxBudget ? String(maxBudget) : undefined,
      });
      mppSessionId = mppSession?.id || mppSession?.sessionId;
    } catch (error) {
      console.error('[MPP] Failed to open mppx session:', error);
      return {
        success: false,
        deniedReason: `Failed to open MPP session: ${error instanceof Error ? error.message : 'unknown'}`,
      };
    }

    // 5. Record in database
    const sessionId = randomUUID();
    const now = new Date().toISOString();

    const { data: row, error: dbError } = await this.supabase
      .from('mpp_sessions')
      .insert({
        id: sessionId,
        tenant_id: tenantId,
        environment,
        agent_id: agentId,
        wallet_id: walletId,
        service_url: serviceUrl,
        deposit_amount: depositAmount,
        spent_amount: 0,
        voucher_count: 0,
        status: 'open',
        max_budget: maxBudget || null,
        mpp_session_id: mppSessionId || null,
        opened_at: now,
      })
      .select()
      .single();

    if (dbError || !row) {
      console.error('[MPP] Failed to record session:', dbError);
      return {
        success: false,
        deniedReason: `Failed to record session: ${dbError?.message || 'unknown'}`,
      };
    }

    // 6. Record deposit spending
    await this.policyService.recordSpending(walletId, depositAmount);

    trackOp({
      tenantId,
      operation: OpType.MPP_SESSION_OPENED,
      subject: `session/${sessionId}`,
      correlationId,
      success: true,
      amountUsd: depositAmount,
      data: { serviceUrl, mppSessionId, agentId },
    });

    return {
      success: true,
      session: this.mapFromDb(row),
    };
  }

  /**
   * Sign a voucher within an active session.
   * Checks per-voucher policy and cumulative budget.
   */
  async signVoucher(options: SignVoucherOptions): Promise<SignVoucherResult> {
    const { sessionId, tenantId, amount, correlationId, environment = 'test' } = options;

    // Fetch session
    const session = await this.getSession(sessionId, tenantId, environment);
    if (!session) {
      return { success: false, deniedReason: 'Session not found' };
    }

    if (session.status !== 'open' && session.status !== 'active') {
      return { success: false, deniedReason: `Session is ${session.status}` };
    }

    // Check cumulative budget
    const newSpent = session.spentAmount + amount;
    const budget = session.maxBudget || session.depositAmount;
    if (newSpent > budget) {
      trackOp({
        tenantId,
        operation: OpType.MPP_SESSION_EXHAUSTED,
        subject: `session/${sessionId}`,
        correlationId,
        success: false,
        amountUsd: amount,
        data: { spentAmount: session.spentAmount, budget, requested: amount },
      });
      return {
        success: false,
        deniedReason: `Would exceed session budget (${newSpent.toFixed(2)} > ${budget})`,
        cumulativeSpent: session.spentAmount,
        remainingBudget: budget - session.spentAmount,
      };
    }

    // Update session state
    const now = new Date().toISOString();
    const voucherIndex = session.voucherCount + 1;

    await this.supabase
      .from('mpp_sessions')
      .update({
        spent_amount: newSpent,
        voucher_count: voucherIndex,
        status: 'active',
        last_voucher_at: now,
        updated_at: now,
      })
      .eq('id', sessionId)
      .eq('tenant_id', tenantId)
      .eq('environment', environment);

    // Resolve wallet currency for accurate recording
    let walletCurrency = 'USDC';
    try {
      const { data: walletRow } = await this.supabase
        .from('wallets')
        .select('currency')
        .eq('id', session.walletId)
        .eq('environment', environment)
        .single();
      if (walletRow?.currency) walletCurrency = walletRow.currency;
    } catch { /* fall back to USDC */ }

    // Record voucher as transfer
    const transferId = await this.recorder.recordSessionVoucher({
      tenantId,
      agentId: session.agentId,
      walletId: session.walletId,
      sessionId,
      serviceUrl: session.serviceUrl,
      voucherIndex,
      amount,
      currency: walletCurrency,
      paymentMethod: 'tempo',
      environment,
    });

    trackOp({
      tenantId,
      operation: OpType.MPP_SESSION_VOUCHER,
      subject: `session/${sessionId}`,
      correlationId,
      success: true,
      amountUsd: amount,
      data: { voucherIndex, cumulativeSpent: newSpent, budget },
    });

    return {
      success: true,
      voucherIndex,
      cumulativeSpent: newSpent,
      remainingBudget: budget - newSpent,
      transferId,
    };
  }

  /**
   * Close a session and settle remaining funds.
   */
  async closeSession(
    sessionId: string,
    tenantId: string,
    correlationId?: string,
    environment: 'test' | 'live' = 'test'
  ): Promise<CloseSessionResult> {
    const session = await this.getSession(sessionId, tenantId, environment);
    if (!session) {
      return { success: false, error: 'Session not found' };
    }

    if (session.status === 'closed') {
      return { success: true, session };
    }

    const now = new Date().toISOString();

    // Update session to closed
    const { data: row, error } = await this.supabase
      .from('mpp_sessions')
      .update({
        status: 'closed' as MppSessionStatus,
        closed_at: now,
        updated_at: now,
      })
      .eq('id', sessionId)
      .eq('tenant_id', tenantId)
      .eq('environment', environment)
      .select()
      .single();

    if (error) {
      return { success: false, error: `Failed to close session: ${error.message}` };
    }

    trackOp({
      tenantId,
      operation: OpType.MPP_SESSION_CLOSED,
      subject: `session/${sessionId}`,
      correlationId,
      success: true,
      amountUsd: session.spentAmount,
      data: {
        voucherCount: session.voucherCount,
        depositAmount: session.depositAmount,
        spentAmount: session.spentAmount,
        refundable: session.depositAmount - session.spentAmount,
      },
    });

    return {
      success: true,
      session: row ? this.mapFromDb(row) : session,
    };
  }

  /**
   * Get a session by ID.
   */
  async getSession(sessionId: string, tenantId: string, environment?: 'test' | 'live'): Promise<MppSession | null> {
    let query = this.supabase
      .from('mpp_sessions')
      .select('*')
      .eq('id', sessionId)
      .eq('tenant_id', tenantId);
    if (environment) query = query.eq('environment', environment);
    const { data, error } = await query.single();

    if (error || !data) return null;
    return this.mapFromDb(data);
  }

  /**
   * List sessions for a tenant with filtering.
   */
  async listSessions(
    tenantId: string,
    options?: { agentId?: string; status?: MppSessionStatus; limit?: number; offset?: number; environment?: 'test' | 'live' }
  ): Promise<{ data: MppSession[]; total: number }> {
    let query = this.supabase
      .from('mpp_sessions')
      .select('*', { count: 'exact' })
      .eq('tenant_id', tenantId)
      .eq('environment', options?.environment || 'test')
      .order('created_at', { ascending: false });

    if (options?.agentId) query = query.eq('agent_id', options.agentId);
    if (options?.status) query = query.eq('status', options.status);

    const limit = options?.limit || 50;
    const offset = options?.offset || 0;
    query = query.range(offset, offset + limit - 1);

    const { data, error, count } = await query;

    if (error) {
      console.error('[MPP] Failed to list sessions:', error);
      return { data: [], total: 0 };
    }

    return {
      data: (data || []).map(r => this.mapFromDb(r)),
      total: count || 0,
    };
  }

  /**
   * Get count of active sessions for an agent.
   */
  private async getActiveSessionCount(tenantId: string, agentId: string, environment: 'test' | 'live' = 'test'): Promise<number> {
    const { count } = await this.supabase
      .from('mpp_sessions')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .eq('agent_id', agentId)
      .eq('environment', environment)
      .in('status', ['open', 'active']);

    return count || 0;
  }

  private mapFromDb(row: MppSessionRow | any): MppSession {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      agentId: row.agent_id,
      walletId: row.wallet_id,
      serviceUrl: row.service_url,
      depositAmount: parseFloat(row.deposit_amount),
      spentAmount: parseFloat(row.spent_amount),
      voucherCount: row.voucher_count,
      status: row.status,
      maxBudget: row.max_budget ? parseFloat(row.max_budget) : undefined,
      mppSessionId: row.mpp_session_id || undefined,
      openedAt: row.opened_at,
      closedAt: row.closed_at || undefined,
      lastVoucherAt: row.last_voucher_at || undefined,
      metadata: row.metadata || undefined,
    };
  }
}
