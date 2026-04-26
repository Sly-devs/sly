/**
 * Epic 82, Story 82.5 — Tenant-owner scope management routes.
 *
 * Mounted at `/v1/organization/scopes`. These endpoints are called by
 * tenant owners/admins (JWT) — or, where appropriate, by the tenant
 * API key — to issue, decide, list, and revoke scope grants.
 *
 *   GET    /v1/organization/scopes                 — list active grants
 *   POST   /v1/organization/scopes                 — issue a standing grant directly
 *   POST   /v1/organization/scopes/:requestId/decide  — approve or deny a pending request
 *   DELETE /v1/organization/scopes/:grantId        — revoke a grant
 *   GET    /v1/organization/scopes/audit           — recent audit events for the tenant
 *
 * All write endpoints require user (JWT) auth — owner or admin role —
 * because every elevation must trace back to a human approver.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { createClient } from '../../db/client.js';
import { ValidationError } from '../../middleware/error.js';
import {
  type Scope,
  type ScopeLifecycle,
  issueGrant,
  listActiveGrants,
  revokeGrant,
} from '../../services/auth/scopes/index.js';

const router = new Hono();

const SCOPES = ['tenant_read', 'tenant_write', 'treasury'] as const;
const LIFECYCLES = ['one_shot', 'standing'] as const;

// ============================================
// AUTHZ HELPER
// ============================================

function requireOwnerOrAdmin(ctx: any): { ok: true } | { ok: false; reason: string; status: 401 | 403 } {
  // Tenant API keys carry full owner-equivalent privilege in Sly's
  // auth model (they're issued by tenant owners and bypass row-level
  // role checks elsewhere). Accept them here so server-to-server
  // automation can issue/decide/revoke without a JWT round-trip.
  if (ctx.actorType === 'api_key') return { ok: true };
  if (ctx.actorType !== 'user') {
    return { ok: false, reason: 'Tenant-owner endpoint — JWT or tenant API key required.', status: 403 };
  }
  if (ctx.userRole !== 'owner' && ctx.userRole !== 'admin') {
    return { ok: false, reason: 'Owner or admin role required.', status: 403 };
  }
  return { ok: true };
}

// ============================================
// GET /v1/organization/scopes
// List active grants for this tenant.
// ============================================
router.get('/', async (c) => {
  const ctx = c.get('ctx');
  // Read access: any authenticated user in the tenant. Lower bar than
  // mutation routes — non-owners can audit, just can't change.
  if (ctx.actorType !== 'user' && ctx.actorType !== 'api_key') {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const envParam = c.req.query('env');
  const agentIdParam = c.req.query('agent_id');
  const supabase = createClient();
  try {
    const grants = await listActiveGrants(supabase, ctx, {
      envScope: envParam === 'all' ? 'all' : 'current',
      agentId: agentIdParam || undefined,
    });
    return c.json({ grants });
  } catch (err: any) {
    return c.json({ error: err?.message ?? 'Failed to list scope grants' }, 500);
  }
});

// ============================================
// POST /v1/organization/scopes
// Issue a standing grant directly (no agent request flow).
// ============================================
const issueSchema = z.object({
  agent_id: z.string().uuid(),
  scope: z.enum(SCOPES),
  lifecycle: z.enum(LIFECYCLES),
  purpose: z.string().min(8).max(500),
  duration_minutes: z.number().int().positive().max(60),
  parent_session_id: z.string().uuid().optional(),
  intent: z.record(z.unknown()).optional(),
});

router.post('/', async (c) => {
  const ctx = c.get('ctx');
  const authz = requireOwnerOrAdmin(ctx);
  if (!authz.ok) return c.json({ error: authz.reason }, authz.status);

  const body = await c.req.json().catch(() => null);
  const parsed = issueSchema.safeParse(body);
  if (!parsed.success) throw new ValidationError('Invalid scope grant payload', parsed.error.flatten());

  const supabase = createClient();

  // Verify the agent belongs to this tenant before issuing.
  const { data: agent, error: agentErr } = await (supabase.from('agents') as any)
    .select('id, name, tenant_id, status')
    .eq('id', parsed.data.agent_id)
    .eq('tenant_id', ctx.tenantId)
    .single();
  if (agentErr || !agent) return c.json({ error: 'Agent not found in tenant' }, 404);
  if (agent.status !== 'active') {
    return c.json({ error: `Cannot issue grant to non-active agent (status: ${agent.status})` }, 400);
  }

  try {
    const { grantId } = await issueGrant({
      supabase,
      ctx,
      agentId: parsed.data.agent_id,
      scope: parsed.data.scope,
      lifecycle: parsed.data.lifecycle,
      purpose: parsed.data.purpose,
      durationMinutes: parsed.data.duration_minutes,
      parentSessionId: parsed.data.parent_session_id,
      intentPayload: parsed.data.intent,
      decisionChannel: 'dashboard',
    });
    return c.json({ grant_id: grantId, status: 'active' }, 201);
  } catch (err: any) {
    return c.json({ error: err?.message ?? 'Failed to issue grant' }, 400);
  }
});

// ============================================
// POST /v1/organization/scopes/:requestId/decide
// Approve or deny a pending request (audit row created by /v1/auth/scopes/request).
// ============================================
const decideSchema = z.object({
  decision: z.enum(['approve', 'deny']),
  // For 'approve' the issuer can override duration / lifecycle if the
  // requester asked for something tighter than the cap.
  duration_minutes: z.number().int().positive().max(60).optional(),
  lifecycle: z.enum(LIFECYCLES).optional(),
  // For 'deny' the user can attach a short reason that surfaces back
  // to the requesting agent.
  reason: z.string().max(500).optional(),
});

router.post('/:requestId/decide', async (c) => {
  const ctx = c.get('ctx');
  const authz = requireOwnerOrAdmin(ctx);
  if (!authz.ok) return c.json({ error: authz.reason }, authz.status);

  const requestId = c.req.param('requestId');
  if (!requestId) throw new ValidationError('Missing request id');

  const body = await c.req.json().catch(() => null);
  const parsed = decideSchema.safeParse(body);
  if (!parsed.success) throw new ValidationError('Invalid decision payload', parsed.error.flatten());

  const supabase = createClient();

  // Pull the original request audit row.
  const { data: requested, error: fetchErr } = await ((supabase as any).from('auth_scope_audit'))
    .select('id, tenant_id, agent_id, scope, action, request_summary, grant_id')
    .eq('id', requestId)
    .eq('tenant_id', ctx.tenantId)
    .single();
  if (fetchErr || !requested) return c.json({ error: 'Scope request not found' }, 404);
  if (requested.action !== 'scope_requested') {
    return c.json({ error: 'Provided id does not reference a scope request' }, 400);
  }
  if (requested.grant_id) {
    return c.json({ error: 'Request already decided' }, 409);
  }

  if (parsed.data.decision === 'deny') {
    await ((supabase as any).from('auth_scope_audit')).insert({
      tenant_id: ctx.tenantId,
      grant_id: null,
      agent_id: requested.agent_id,
      scope: requested.scope,
      action: 'scope_denied',
      actor_type: ctx.actorType,
      actor_id: ctx.actorType === 'user' ? ctx.userId : ctx.actorId,
      request_summary: {
        reason: parsed.data.reason ?? null,
        decision_channel: ctx.actorType === 'api_key' ? 'api_key' : 'dashboard',
      },
    });
    return c.json({ request_id: requestId, status: 'denied' });
  }

  // Approve path — issue the grant, then back-fill grant_id on the
  // original request row so future lookups can join.
  const requestedLifecycle = (requested.request_summary?.requested_lifecycle as ScopeLifecycle | undefined) ?? 'one_shot';
  const lifecycle: ScopeLifecycle = parsed.data.lifecycle ?? requestedLifecycle;
  const requestedDuration = requested.request_summary?.requested_duration_minutes as number | undefined;
  const duration = parsed.data.duration_minutes ?? requestedDuration ?? 15;
  const parentSessionId = requested.request_summary?.parent_session_id as string | undefined;

  try {
    const { grantId } = await issueGrant({
      supabase,
      ctx,
      agentId: requested.agent_id,
      scope: requested.scope as Scope,
      lifecycle,
      purpose: (requested.request_summary?.purpose as string) ?? 'Approved via dashboard',
      durationMinutes: duration,
      parentSessionId,
      intentPayload: requested.request_summary?.intent as Record<string, unknown> | undefined,
      decisionChannel: 'dashboard',
    });

    await ((supabase as any).from('auth_scope_audit'))
      .update({ grant_id: grantId })
      .eq('id', requestId);

    return c.json({ request_id: requestId, status: 'approved', grant_id: grantId });
  } catch (err: any) {
    return c.json({ error: err?.message ?? 'Failed to approve request' }, 400);
  }
});

// ============================================
// DELETE /v1/organization/scopes/:grantId
// Revoke a grant.
// ============================================
router.delete('/:grantId', async (c) => {
  const ctx = c.get('ctx');
  const authz = requireOwnerOrAdmin(ctx);
  if (!authz.ok) return c.json({ error: authz.reason }, authz.status);

  const grantId = c.req.param('grantId');
  if (!grantId) throw new ValidationError('Missing grant id');

  const supabase = createClient();
  try {
    await revokeGrant(supabase, ctx, grantId);
    return c.json({ grant_id: grantId, status: 'revoked' });
  } catch (err: any) {
    return c.json({ error: err?.message ?? 'Failed to revoke grant' }, 400);
  }
});

// ============================================
// GET /v1/organization/scopes/audit
// Recent scope audit events for the tenant — feeds the dashboard
// security view (Epic 82 spec, /dashboard/security/scopes).
// ============================================
router.get('/audit', async (c) => {
  const ctx = c.get('ctx');
  if (ctx.actorType !== 'user' && ctx.actorType !== 'api_key') {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const limitParam = c.req.query('limit');
  const limit = Math.min(Math.max(parseInt(limitParam ?? '50', 10) || 50, 1), 200);
  const envParam = c.req.query('env'); // 'all' opts out of env scoping; default scopes to ctx env
  const agentIdParam = c.req.query('agent_id'); // optional — scope to a single agent

  const supabase = createClient();
  let query = ((supabase as any).from('auth_scope_audit'))
    .select('id, grant_id, agent_id, scope, action, actor_type, actor_id, request_summary, created_at, environment')
    .eq('tenant_id', ctx.tenantId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (envParam !== 'all') {
    // Default behavior: scope to caller's environment. Pre-denorm rows
    // (environment IS NULL) are also surfaced so historical events
    // don't disappear from the dashboard.
    const env = ctx.environment ?? ctx.apiKeyEnvironment ?? 'live';
    query = query.or(`environment.eq.${env},environment.is.null`);
  }
  if (agentIdParam) {
    query = query.eq('agent_id', agentIdParam);
  }
  const { data, error } = await query;
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ events: data ?? [] });
});

export default router;
