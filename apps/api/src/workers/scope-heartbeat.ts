/**
 * Epic 82 Story 82.8 — daily heartbeat for active standing grants.
 *
 * Standing grants persist until expires_at or explicit revoke. The
 * spec calls out the "I forgot I approved this" failure mode — a
 * tenant owner approves a tenant_write grant, an hour later the
 * agent has burned through it without anyone noticing.
 *
 * This worker emits one `scope_heartbeat` audit row per active
 * standing grant per day. The dashboard's audit feed surfaces them
 * as recurring reminders that long-lived elevations exist; ops
 * tooling can flag heartbeats whose grants haven't been used (use
 * count == 0 over many days) for proactive cleanup.
 *
 * Cadence: once per hour the worker checks which active standing
 * grants have NOT had a scope_heartbeat in the last 24h, and emits
 * one for each. Hourly tick window means a fresh grant gets its
 * first heartbeat within ~1h and subsequent ones every ~24h.
 */

import { createClient } from '../db/client.js';

const HEARTBEAT_INTERVAL_HOURS = 24;

export async function emitMissingHeartbeats(): Promise<number> {
  const supabase: any = createClient();

  // Pull every active standing grant that's still in its window.
  // One_shot grants don't qualify — they're consumed on first use,
  // no point heartbeating something that may already be gone.
  const { data: candidates, error: candidatesErr } = await supabase
    .from('auth_scope_grants')
    .select('id, tenant_id, agent_id, scope, environment, granted_at, expires_at')
    .eq('status', 'active')
    .eq('lifecycle', 'standing')
    .gt('expires_at', new Date().toISOString());

  if (candidatesErr) {
    console.error('[scope-heartbeat] candidate fetch failed:', candidatesErr.message);
    return 0;
  }
  if (!candidates || candidates.length === 0) return 0;

  // For each candidate, check whether a heartbeat exists in the last
  // HEARTBEAT_INTERVAL_HOURS. Pull all recent heartbeats in one query
  // to avoid N+1.
  const grantIds = candidates.map((c: any) => c.id);
  const cutoffIso = new Date(Date.now() - HEARTBEAT_INTERVAL_HOURS * 3_600_000).toISOString();

  const { data: recentHeartbeats } = await supabase
    .from('auth_scope_audit')
    .select('grant_id')
    .eq('action', 'scope_heartbeat')
    .gt('created_at', cutoffIso)
    .in('grant_id', grantIds);

  const recentSet = new Set(((recentHeartbeats ?? []) as Array<{ grant_id: string }>).map((r) => r.grant_id));
  const needHeartbeat = (candidates as any[]).filter((c) => !recentSet.has(c.id));
  if (needHeartbeat.length === 0) return 0;

  const auditRows = needHeartbeat.map((g) => ({
    tenant_id: g.tenant_id,
    grant_id: g.id,
    agent_id: g.agent_id,
    scope: g.scope,
    action: 'scope_heartbeat' as const,
    actor_type: 'system' as const,
    actor_id: null,
    request_summary: {
      reason: 'daily heartbeat',
      grant_age_hours: Math.round((Date.now() - new Date(g.granted_at).getTime()) / 3_600_000),
      remaining_hours: Math.round((new Date(g.expires_at).getTime() - Date.now()) / 3_600_000),
    },
    environment: g.environment ?? null,
  }));
  const { error: insertErr } = await supabase.from('auth_scope_audit').insert(auditRows);
  if (insertErr) {
    console.error('[scope-heartbeat] audit insert failed:', insertErr.message);
    return 0;
  }

  console.log(`[scope-heartbeat] Emitted ${needHeartbeat.length} heartbeat(s)`);
  return needHeartbeat.length;
}

export function startScopeHeartbeatWorker(intervalMs: number = 60 * 60 * 1000): () => void {
  console.log(`[scope-heartbeat] Starting with ${intervalMs / 1000}s interval`);

  // Kick once on boot so freshly-issued standing grants get an
  // initial heartbeat within ~1h instead of racing the first tick.
  emitMissingHeartbeats().catch((e) => {
    console.error('[scope-heartbeat] initial run error:', e);
  });

  const interval = setInterval(async () => {
    try {
      await emitMissingHeartbeats();
    } catch (error) {
      console.error('[scope-heartbeat] tick error:', error);
    }
  }, intervalMs);

  return () => {
    console.log('[scope-heartbeat] Stopping');
    clearInterval(interval);
  };
}
