/**
 * Epic 82, Story 82.2 — Scope grant service.
 *
 * Issued, audited, and consumed scope grants live here. Routes call:
 *   - requireScope(ctx, 'tenant_read')      → throws if missing
 *   - requestScope({ ctx, scope, ... })     → agent-side request flow
 *   - decideScope({ requestId, decision })  → user-side approve/deny
 *   - listActiveGrants(ctx)                 → dashboard read
 *   - revokeGrant(grantId, byUserId)        → manual or kill-switch
 *   - cascadeRevokeForAgent(agentId, ctx)   → kill-switch helper
 *
 * Lifecycle invariants (per Epic 82 spec):
 *   - one_shot grants are consumed atomically on first scope_used
 *   - standing grants persist until expires_at OR explicit revoke
 *   - treasury can never be a standing grant (DB CHECK enforces)
 *   - Tier durations capped per KYA tier (enforced here, not at DB)
 */

import type { SupabaseClient } from '../../../db/client.js';
import type { RequestContext } from '../../../middleware/auth.js';

export type Scope = 'tenant_read' | 'tenant_write' | 'treasury';
export type ScopeLifecycle = 'one_shot' | 'standing';

const SCOPE_TIER_ORDER: Record<Scope | 'agent', number> = {
  agent: 0,
  tenant_read: 1,
  tenant_write: 2,
  treasury: 3,
};

// Standing-grant duration ceilings in minutes per scope. treasury is
// barred from standing entirely (DB CHECK + CHECK here for clarity).
// tenant_write is the dangerous mutation tier — kept tight on purpose.
const STANDING_MAX_MINUTES: Record<Scope, number> = {
  tenant_read: 60,
  tenant_write: 15,
  treasury: 0, // never
};

export class ScopeRequiredError extends Error {
  readonly statusCode = 403;
  readonly code = 'SCOPE_REQUIRED';
  constructor(
    public requiredScope: Scope,
    public currentScope: 'agent' | Scope,
    public hint: string,
  ) {
    super(
      `Scope '${requiredScope}' required; caller has '${currentScope}'. ${hint}`,
    );
    this.name = 'ScopeRequiredError';
  }
}

/**
 * Gate-keeper for routes that require an elevated scope. The auth
 * middleware sets ctx.elevatedScope on every request; this just
 * checks whether the caller's tier is >= the required tier.
 *
 * For tenant API key (`actorType === 'api_key'`) callers we treat
 * scope as 'tenant_write' implicitly — tenant keys are intentionally
 * broad. For user (JWT) callers, owner/admin roles imply 'tenant_write',
 * member/viewer imply 'tenant_read'. Pure agent-bound auth needs an
 * explicit grant row to elevate.
 */
export function requireScope(ctx: RequestContext, required: Scope): void {
  const current = effectiveScope(ctx);
  if (SCOPE_TIER_ORDER[current] >= SCOPE_TIER_ORDER[required]) return;
  throw new ScopeRequiredError(
    required,
    current,
    ctx.actorType === 'agent'
      ? `Call request_scope({ scope: '${required}', purpose: '...' }) and have the tenant owner approve, or have them issue a standing grant from the dashboard.`
      : `Re-authenticate as a tenant owner (JWT) or use a tenant API key with sufficient scope.`,
  );
}

/**
 * Compute the effective scope tier for a request. Pure-agent auth gets
 * 'agent' unless an elevated grant has been picked up by the auth
 * middleware. Tenant keys + owner JWTs implicitly get 'tenant_write'
 * (their existing power); member/viewer JWTs get 'tenant_read'.
 */
function effectiveScope(ctx: RequestContext): 'agent' | Scope {
  if (ctx.elevatedScope && ctx.elevatedScope !== 'agent') return ctx.elevatedScope;
  if (ctx.actorType === 'api_key') return 'tenant_write';
  if (ctx.actorType === 'user') {
    return ctx.userRole === 'owner' || ctx.userRole === 'admin'
      ? 'tenant_write'
      : 'tenant_read';
  }
  return 'agent';
}

// ============================================================
// REQUEST FLOW
// ============================================================

export interface RequestScopeArgs {
  supabase: SupabaseClient;
  ctx: RequestContext;
  scope: Scope;
  lifecycle: ScopeLifecycle;
  purpose: string;
  intentPayload?: Record<string, unknown>;
  durationMinutes?: number; // standing-grant only
}

/**
 * Agent submits a request for elevated scope. Writes a 'scope_requested'
 * audit row; does NOT issue a grant. Approval flows through Epic 83
 * (pending_approvals queue + three channels). For now (MVP), tenant
 * owners must approve via the dashboard route in Story 82.5 — auto
 * elevation is gated on Epic 83 landing.
 */
export async function requestScope(args: RequestScopeArgs): Promise<{ requestId: string }> {
  const { supabase, ctx, scope, lifecycle, purpose, intentPayload, durationMinutes } = args;

  if (ctx.actorType !== 'agent' || !ctx.actorId) {
    throw new Error('Only agent-bound callers can request scope elevation.');
  }
  if (lifecycle === 'standing' && scope === 'treasury') {
    throw new Error("scope='treasury' cannot be issued as a standing grant; request lifecycle='one_shot'.");
  }
  if (lifecycle === 'standing') {
    const cap = STANDING_MAX_MINUTES[scope];
    const requested = durationMinutes ?? cap;
    if (requested > cap) {
      throw new Error(`Standing grants for scope='${scope}' max out at ${cap} minutes (you asked for ${requested}).`);
    }
  }

  // Insert an audit row representing the pending request. The grant_id
  // is null here — it gets backfilled on decideScope if approved.
  const requestSummary = {
    requested_lifecycle: lifecycle,
    requested_duration_minutes: durationMinutes ?? null,
    intent: intentPayload ?? null,
    parent_session_id: ctx.sessionId ?? null,
    purpose,
  };
  const { data, error } = await ((supabase as any).from('auth_scope_audit'))
    .insert({
      tenant_id: ctx.tenantId,
      grant_id: null,
      agent_id: ctx.actorId,
      scope,
      action: 'scope_requested',
      actor_type: 'agent',
      actor_id: ctx.actorId,
      request_summary: requestSummary,
      environment: ctx.environment ?? null,
    })
    .select('id')
    .single();
  if (error || !data?.id) {
    throw new Error(`Failed to record scope request: ${error?.message || 'unknown'}`);
  }
  return { requestId: data.id };
}

// ============================================================
// DECISION FLOW (tenant-owner approval / direct issuance)
// ============================================================

export interface IssueGrantArgs {
  supabase: SupabaseClient;
  ctx: RequestContext;            // must be a user JWT (tenant owner/admin)
  agentId: string;
  scope: Scope;
  lifecycle: ScopeLifecycle;
  purpose: string;
  durationMinutes: number;        // hard ceiling per scope
  parentSessionId?: string;       // when approving an agent request, anchor to the session
  intentPayload?: Record<string, unknown>;
  decisionChannel?: 'dashboard' | 'mcp_elicit' | 'push';
}

/**
 * Resolve which user_id to record as `granted_by_user_id`. For user
 * (JWT) auth this is just ctx.userId. For tenant API key auth we look
 * up the tenant's primary owner so the column stays populated; the
 * audit row separately records actor_type='api_key' for traceability.
 */
async function resolveGranterUserId(
  supabase: SupabaseClient,
  ctx: RequestContext,
): Promise<string> {
  if (ctx.actorType === 'user' && ctx.userId) return ctx.userId;
  if (ctx.actorType === 'api_key') {
    const { data: owner } = await ((supabase as any).from('user_profiles'))
      .select('id')
      .eq('tenant_id', ctx.tenantId)
      .eq('role', 'owner')
      .limit(1)
      .maybeSingle();
    if (owner?.id) return owner.id;
    const { data: anyAdmin } = await ((supabase as any).from('user_profiles'))
      .select('id')
      .eq('tenant_id', ctx.tenantId)
      .in('role', ['owner', 'admin'])
      .limit(1)
      .maybeSingle();
    if (anyAdmin?.id) return anyAdmin.id;
    throw new Error('Cannot issue grant via API key — tenant has no owner/admin user to attribute the grant to.');
  }
  throw new Error('Only tenant users (JWT) or tenant API keys can issue scope grants.');
}

/**
 * Tenant-owner side of the decision flow — issues a grant row directly.
 * Used by the dashboard "approve" button and by direct issuance of
 * standing grants. Audits both 'scope_granted' and (separately) the
 * matching 'scope_requested' if a requestId was passed. Returns the
 * grant id.
 */
export async function issueGrant(args: IssueGrantArgs): Promise<{ grantId: string }> {
  const {
    supabase, ctx, agentId, scope, lifecycle, purpose,
    durationMinutes, parentSessionId, intentPayload, decisionChannel,
  } = args;

  if (ctx.actorType !== 'user' && ctx.actorType !== 'api_key') {
    throw new Error('Only tenant users (JWT) or tenant API keys can issue scope grants.');
  }
  if (lifecycle === 'standing' && scope === 'treasury') {
    throw new Error("scope='treasury' must be one_shot.");
  }
  if (lifecycle === 'standing' && durationMinutes > STANDING_MAX_MINUTES[scope]) {
    throw new Error(`Standing grant duration exceeds ceiling for scope='${scope}'.`);
  }

  const expiresAt = new Date(Date.now() + durationMinutes * 60_000).toISOString();
  const granterUserId = await resolveGranterUserId(supabase, ctx);

  // Pull the target agent's environment so the grant + audit rows
  // are properly env-scoped. Necessary because the issuer (user JWT
  // or tenant API key) might be acting against either env via the
  // X-Environment header — the grant should follow the agent.
  const { data: targetAgent } = await ((supabase as any).from('agents'))
    .select('environment')
    .eq('id', agentId)
    .eq('tenant_id', ctx.tenantId)
    .maybeSingle();
  const targetEnv: 'test' | 'live' | null =
    targetAgent?.environment === 'live' ? 'live'
      : targetAgent?.environment === 'test' ? 'test'
        : null;

  const { data: grant, error: grantErr } = await ((supabase as any).from('auth_scope_grants'))
    .insert({
      tenant_id: ctx.tenantId,
      agent_id: agentId,
      parent_session_id: parentSessionId ?? null,
      scope,
      lifecycle,
      status: 'active',
      purpose,
      intent_payload: intentPayload ?? null,
      granted_by_user_id: granterUserId,
      expires_at: expiresAt,
      environment: targetEnv,
    })
    .select('id')
    .single();
  if (grantErr || !grant?.id) {
    throw new Error(`Failed to issue grant: ${grantErr?.message || 'unknown'}`);
  }

  await ((supabase as any).from('auth_scope_audit')).insert({
    tenant_id: ctx.tenantId,
    grant_id: grant.id,
    agent_id: agentId,
    scope,
    action: 'scope_granted',
    actor_type: ctx.actorType,
    actor_id: ctx.actorType === 'user' ? ctx.userId : ctx.actorId,
    request_summary: {
      lifecycle,
      duration_minutes: durationMinutes,
      decision_channel: decisionChannel ?? 'dashboard',
      purpose,
      ...(ctx.actorType === 'api_key' ? { granted_via_api_key: true } : {}),
    },
    environment: targetEnv,
  });

  return { grantId: grant.id };
}

// ============================================================
// READ + LIFECYCLE
// ============================================================

export interface ScopeGrantSummary {
  id: string;
  agent_id: string;
  agent_name?: string | null;
  scope: Scope;
  lifecycle: ScopeLifecycle;
  status: 'active' | 'consumed' | 'revoked' | 'expired';
  purpose: string;
  granted_by_user_id: string;
  granted_at: string;
  expires_at: string;
  last_used_at: string | null;
  use_count: number;
}

export async function listActiveGrants(
  supabase: SupabaseClient,
  ctx: RequestContext,
  options: { envScope?: 'current' | 'all' } = {},
): Promise<ScopeGrantSummary[]> {
  const envScope = options.envScope ?? 'current';
  let query = ((supabase as any).from('auth_scope_grants'))
    .select('*, agent:agents!auth_scope_grants_agent_id_fkey(name)')
    .eq('tenant_id', ctx.tenantId)
    .eq('status', 'active')
    .order('granted_at', { ascending: false });
  if (envScope === 'current') {
    const env = ctx.environment ?? ctx.apiKeyEnvironment ?? 'live';
    query = query.or(`environment.eq.${env},environment.is.null`);
  }
  const { data, error } = await query;
  if (error) throw new Error(`Failed to list scope grants: ${error.message}`);
  return ((data ?? []) as any[]).map((row) => ({
    id: row.id,
    agent_id: row.agent_id,
    agent_name: row.agent?.name ?? null,
    scope: row.scope,
    lifecycle: row.lifecycle,
    status: row.status,
    purpose: row.purpose,
    granted_by_user_id: row.granted_by_user_id,
    granted_at: row.granted_at,
    expires_at: row.expires_at,
    last_used_at: row.last_used_at,
    use_count: row.use_count,
  }));
}

export async function revokeGrant(
  supabase: SupabaseClient,
  ctx: RequestContext,
  grantId: string,
): Promise<void> {
  if (ctx.actorType !== 'user' && ctx.actorType !== 'api_key') {
    throw new Error('Only tenant users (JWT) or tenant API keys can revoke grants.');
  }
  // Optimistic update — only flip if currently active.
  const { data, error } = await ((supabase as any).from('auth_scope_grants'))
    .update({ status: 'revoked', revoked_at: new Date().toISOString() })
    .eq('id', grantId)
    .eq('tenant_id', ctx.tenantId)
    .eq('status', 'active')
    .select('id, agent_id, scope, environment')
    .single();
  if (error) throw new Error(`Failed to revoke grant: ${error.message}`);
  if (!data) return; // already inactive — idempotent

  await ((supabase as any).from('auth_scope_audit')).insert({
    tenant_id: ctx.tenantId,
    grant_id: grantId,
    agent_id: (data as any).agent_id,
    scope: (data as any).scope,
    action: 'scope_revoked',
    actor_type: ctx.actorType,
    actor_id: ctx.actorType === 'user' ? ctx.userId : ctx.actorId,
    request_summary: {
      reason: 'manual_revoke',
      ...(ctx.actorType === 'api_key' ? { revoked_via_api_key: true } : {}),
    },
    environment: (data as any).environment ?? null,
  });
}

/**
 * Kill-switch cascade — when an agent is killed via the existing
 * agents.ts:2059 handler, every active scope grant for that agent is
 * revoked atomically. Audits each as 'scope_revoked' with reason
 * 'kill_switch_cascade' so the audit trail is clear that this wasn't
 * a manual action.
 */
export async function cascadeRevokeForAgent(
  supabase: SupabaseClient,
  tenantId: string,
  agentId: string,
  killedByUserId: string,
): Promise<{ revokedCount: number }> {
  const { data: revoked, error } = await ((supabase as any).from('auth_scope_grants'))
    .update({ status: 'revoked', revoked_at: new Date().toISOString() })
    .eq('tenant_id', tenantId)
    .eq('agent_id', agentId)
    .eq('status', 'active')
    .select('id, scope, environment');
  if (error) throw new Error(`Kill-switch scope cascade failed: ${error.message}`);
  const rows = (revoked ?? []) as Array<{ id: string; scope: Scope; environment: string | null }>;
  if (rows.length === 0) return { revokedCount: 0 };

  await ((supabase as any).from('auth_scope_audit')).insert(
    rows.map((r) => ({
      tenant_id: tenantId,
      grant_id: r.id,
      agent_id: agentId,
      scope: r.scope,
      action: 'scope_revoked',
      actor_type: 'user' as const,
      actor_id: killedByUserId,
      request_summary: { reason: 'kill_switch_cascade' },
      environment: r.environment ?? null,
    })),
  );
  return { revokedCount: rows.length };
}

/**
 * Mark a grant as used (for one_shot grants this is also when status
 * flips to 'consumed' atomically). Called by route handlers that
 * actually exercise the elevation.
 */
export async function recordScopeUse(
  supabase: SupabaseClient,
  tenantId: string,
  grantId: string,
  ctx: RequestContext,
  context: { mcp_tool?: string; route?: string; request_id?: string },
): Promise<void> {
  // Fetch + flip in one shot. For one_shot grants the optimistic update
  // also blocks parallel reuse.
  const { data: grant } = await ((supabase as any).from('auth_scope_grants'))
    .select('id, lifecycle, status, use_count, environment')
    .eq('id', grantId)
    .eq('tenant_id', tenantId)
    .single();
  if (!grant || grant.status !== 'active') return;

  const update: Record<string, any> = {
    last_used_at: new Date().toISOString(),
    use_count: (grant.use_count ?? 0) + 1,
  };
  if (grant.lifecycle === 'one_shot') {
    update.status = 'consumed';
    update.consumed_at = new Date().toISOString();
  }
  await ((supabase as any).from('auth_scope_grants'))
    .update(update)
    .eq('id', grantId)
    .eq('status', 'active'); // re-check to handle the race

  await ((supabase as any).from('auth_scope_audit')).insert({
    tenant_id: tenantId,
    grant_id: grantId,
    agent_id: ctx.actorId ?? null,
    scope: ctx.elevatedScope === 'agent' ? null : ctx.elevatedScope,
    action: 'scope_used',
    actor_type: ctx.actorType,
    environment: grant.environment ?? ctx.environment ?? null,
    actor_id: ctx.actorId ?? null,
    request_summary: context,
  });
}
