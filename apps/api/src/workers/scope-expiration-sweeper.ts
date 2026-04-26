/**
 * Epic 82 — scope grant expiration sweeper.
 *
 * auth_scope_grants.status defaults to 'active' on insert and stays
 * active until something flips it: 'consumed' (one_shot used),
 * 'revoked' (manual or kill-switch cascade), or 'expired'. The first
 * two happen inline with the request that triggered them. `expired`
 * has no inline trigger — a grant that's never used past its
 * expires_at simply ages out, and we want a clean audit row + status
 * flip so the dashboard reflects reality.
 *
 * This worker scans for active grants whose expires_at < now() and
 * flips them to status='expired'. Writes a 'scope_expired' audit
 * row per grant so the audit feed stays a complete log.
 *
 * The middleware's lookupElevatedScope() already filters by
 * expires_at > now() so an unswept expired grant doesn't accidentally
 * authorize a request — the sweeper is purely for accuracy of
 * stored state and audit completeness.
 */

import { createClient } from '../db/client.js';

export async function sweepExpiredScopeGrants(): Promise<number> {
  const supabase: any = createClient();
  const nowIso = new Date().toISOString();

  // Atomic flip — only rows still active and past expires_at.
  const { data: expired, error } = await supabase
    .from('auth_scope_grants')
    .update({ status: 'expired' })
    .eq('status', 'active')
    .lt('expires_at', nowIso)
    .select('id, tenant_id, agent_id, scope, environment');

  if (error) {
    console.error('[scope-expiration-sweeper] update failed:', error.message);
    return 0;
  }

  const rows = (expired ?? []) as Array<{
    id: string;
    tenant_id: string;
    agent_id: string;
    scope: string;
    environment: string | null;
  }>;

  if (rows.length === 0) return 0;

  // Audit each expiration so the dashboard timeline shows the lifecycle
  // event. Bulk insert — one query for all expired grants.
  const auditRows = rows.map((r) => ({
    tenant_id: r.tenant_id,
    grant_id: r.id,
    agent_id: r.agent_id,
    scope: r.scope,
    action: 'scope_expired' as const,
    actor_type: 'system' as const,
    actor_id: null,
    request_summary: { reason: 'expires_at passed' },
    environment: r.environment ?? null,
  }));
  const { error: auditErr } = await supabase
    .from('auth_scope_audit')
    .insert(auditRows);
  if (auditErr) {
    console.error('[scope-expiration-sweeper] audit insert failed:', auditErr.message);
  }

  console.log(`[scope-expiration-sweeper] Expired ${rows.length} grant(s)`);
  return rows.length;
}

export function startScopeExpirationSweeper(intervalMs: number = 5 * 60 * 1000): () => void {
  console.log(`[scope-expiration-sweeper] Starting with ${intervalMs / 1000}s interval`);

  // Kick one off immediately so cold-starts catch grants that expired
  // while the process was down.
  sweepExpiredScopeGrants().catch((e) => {
    console.error('[scope-expiration-sweeper] initial run error:', e);
  });

  const interval = setInterval(async () => {
    try {
      await sweepExpiredScopeGrants();
    } catch (error) {
      console.error('[scope-expiration-sweeper] tick error:', error);
    }
  }, intervalMs);

  return () => {
    console.log('[scope-expiration-sweeper] Stopping');
    clearInterval(interval);
  };
}
