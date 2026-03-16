import { Hono } from 'hono';
import { z } from 'zod';
import {
  platformAdminMiddleware,
  verifyGoogleIdToken,
  createAdminSessionToken,
} from '../middleware/platform-admin.js';
import { authRateLimiter } from '../middleware/rate-limit.js';
import {
  listApplications,
  approveApplication,
  rejectApplication,
  listBetaCodes,
  createBetaCode,
  revokeBetaCode,
  getFunnelStats,
} from '../services/beta-access.js';
import {
  sendBetaApprovedEmail,
  sendBetaRejectedEmail,
} from '../services/email.js';
import { getTenantResourceUsage, updateTenantLimits } from '../services/tenant-limits.js';
import { createClient } from '../db/client.js';

const betaAdmin = new Hono();

// Heuristic patterns that indicate a test/dev tenant
const TEST_PATTERNS = [
  /test/i,
  /demo/i,
  /seed/i,
  /^frontend/i,
  /^acme/i,
  /^competitor/i,
  /^updated org/i,
  /^techcorp/i,
  /^beta llc$/i,
];

/** Classify a tenant based on onboarded_via + name heuristics. */
function classifyTenant(tenant: { name: string; onboarded_via: string }): string {
  if (tenant.onboarded_via === 'beta_code' || tenant.onboarded_via === 'partner_code') return 'beta';
  if (TEST_PATTERNS.some((p) => p.test(tenant.name))) return 'test';
  return 'organic';
}

// ============================================
// POST /admin/beta/auth/google (public — rate limited, no admin auth)
// ============================================
betaAdmin.post('/auth/google', authRateLimiter, async (c) => {
  const { idToken } = await c.req.json();
  if (!idToken) {
    return c.json({ error: 'Missing idToken' }, 400);
  }

  const googleUser = await verifyGoogleIdToken(idToken);
  if (!googleUser) {
    return c.json({ error: 'Invalid Google credentials or unauthorized domain' }, 403);
  }

  const session = createAdminSessionToken(googleUser.email, googleUser.name);

  return c.json({
    token: session.token,
    expiresAt: session.expiresAt,
    email: googleUser.email,
    name: googleUser.name,
    picture: googleUser.picture,
  });
});

// All other routes require platform admin auth (skip /auth/*)
betaAdmin.use('*', async (c, next) => {
  if (c.req.path.endsWith('/auth/google')) {
    await next();
    return;
  }
  return platformAdminMiddleware(c, next);
});

// ============================================
// GET /admin/beta/applications
// ============================================
betaAdmin.get('/applications', async (c) => {
  const status = c.req.query('status');
  const applicantType = c.req.query('applicantType');
  const page = parseInt(c.req.query('page') || '1');
  const limit = parseInt(c.req.query('limit') || '50');

  const result = await listApplications({ status, applicantType, page, limit });

  return c.json({
    data: result.data,
    pagination: {
      page,
      limit,
      total: result.total,
      totalPages: Math.ceil(result.total / limit),
    },
  });
});

// ============================================
// POST /admin/beta/applications/:id/approve
// ============================================
betaAdmin.post('/applications/:id/approve', async (c) => {
  const id = c.req.param('id');

  const { application, code } = await approveApplication(id, 'platform_admin');

  // Send approval email if applicant has an email
  if (application.email) {
    sendBetaApprovedEmail({
      to: application.email,
      code: code.code,
      organizationName: application.organization_name,
    }).catch(err => console.error('[email] Beta approved email error:', err));
  }

  return c.json({
    application,
    code: {
      id: code.id,
      code: code.code,
      expiresAt: code.expires_at,
    },
  });
});

// ============================================
// POST /admin/beta/applications/:id/reject
// ============================================
betaAdmin.post('/applications/:id/reject', async (c) => {
  let notes: string | undefined;
  try {
    const body = await c.req.json();
    notes = body.notes;
  } catch {
    // Body is optional
  }

  const id = c.req.param('id');
  const application = await rejectApplication(id, 'platform_admin', notes);

  // Send rejection email if applicant has an email
  if (application.email) {
    sendBetaRejectedEmail({
      to: application.email,
      organizationName: application.organization_name,
    }).catch(err => console.error('[email] Beta rejected email error:', err));
  }

  return c.json({ application });
});

// ============================================
// GET /admin/beta/codes
// ============================================
betaAdmin.get('/codes', async (c) => {
  const status = c.req.query('status');
  const partnerName = c.req.query('partnerName');
  const page = parseInt(c.req.query('page') || '1');
  const limit = parseInt(c.req.query('limit') || '50');

  const result = await listBetaCodes({ status, partnerName, page, limit });

  return c.json({
    data: result.data,
    pagination: {
      page,
      limit,
      total: result.total,
      totalPages: Math.ceil(result.total / limit),
    },
  });
});

// ============================================
// POST /admin/beta/codes
// ============================================
const createCodeSchema = z.object({
  codeType: z.enum(['single_use', 'multi_use']).optional(),
  maxUses: z.number().int().positive().optional(),
  partnerName: z.string().max(100).optional(),
  targetActorType: z.enum(['human', 'agent', 'both']).optional(),
  grantedMaxTeamMembers: z.number().int().positive().optional(),
  grantedMaxAgents: z.number().int().positive().optional(),
  expiresAt: z.string().datetime().optional(),
  metadata: z.record(z.any()).optional(),
});

betaAdmin.post('/codes', async (c) => {
  const body = await c.req.json();
  const parsed = createCodeSchema.parse(body);

  const code = await createBetaCode({
    ...parsed,
    createdBy: 'platform_admin',
  });

  return c.json({ code }, 201);
});

// ============================================
// DELETE /admin/beta/codes/:id
// ============================================
betaAdmin.delete('/codes/:id', async (c) => {
  const id = c.req.param('id');
  await revokeBetaCode(id);
  return c.json({ success: true });
});

// ============================================
// GET /admin/beta/funnel
// ============================================
betaAdmin.get('/funnel', async (c) => {
  const stats = await getFunnelStats();
  return c.json(stats);
});

// ============================================
// GET /admin/beta/tenants
// ============================================
betaAdmin.get('/tenants', async (c) => {
  const supabase = createClient();
  const page = parseInt(c.req.query('page') || '1');
  const limit = parseInt(c.req.query('limit') || '50');
  const filter = c.req.query('filter') || 'all';
  const search = c.req.query('search') || '';

  let query = (supabase
    .from('tenants') as any)
    .select('id, name, status, beta_access_code_id, onboarded_via, max_team_members, max_agents, created_at', { count: 'exact' })
    .order('created_at', { ascending: false });

  // Pre-filter by onboarded_via where possible (beta filter)
  if (filter === 'beta') {
    query = query.in('onboarded_via', ['beta_code', 'partner_code']);
  }
  // test, organic, and all are post-filtered after name heuristics

  // Apply search
  if (search) {
    query = query.ilike('name', `%${search}%`);
  }

  query = query.range((page - 1) * limit, page * limit - 1);

  const { data: tenants, count, error } = await query;

  if (error) {
    return c.json({ error: `Failed to list tenants: ${error.message}` }, 500);
  }

  // Enrich with resource usage and derive category
  const enriched = await Promise.all(
    (tenants || []).map(async (tenant: any) => {
      const usage = await getTenantResourceUsage(tenant.id);
      const category = classifyTenant(tenant);
      return { ...tenant, usage, category };
    })
  );

  // Post-query filtering for categories that need name heuristics
  let filtered = enriched;
  if (filter === 'test') {
    filtered = enriched.filter((t: any) => t.category === 'test');
  } else if (filter === 'organic') {
    filtered = enriched.filter((t: any) => t.category === 'organic');
  }

  return c.json({
    data: filtered,
    pagination: {
      page,
      limit,
      total: count || 0,
      totalPages: Math.ceil((count || 0) / limit),
    },
  });
});

// ============================================
// GET /admin/beta/tenants/:id
// ============================================
betaAdmin.get('/tenants/:id', async (c) => {
  const supabase = createClient();
  const id = c.req.param('id');

  // Fetch tenant
  const { data: tenant, error: tenantError } = await (supabase
    .from('tenants') as any)
    .select('id, name, status, beta_access_code_id, onboarded_via, max_team_members, max_agents, created_at')
    .eq('id', id)
    .single();

  if (tenantError || !tenant) {
    return c.json({ error: 'Tenant not found' }, 404);
  }

  // Fetch enrichment data and per-tenant stats in parallel
  const [
    usage,
    usersResult,
    agentsResult,
    accountsResult,
    transfersResult,
    streamsResult,
    volumeResult,
  ] = await Promise.all([
    getTenantResourceUsage(id),
    (supabase.from('user_profiles') as any)
      .select('id, user_id, name, email, role, created_at')
      .eq('tenant_id', id)
      .order('created_at', { ascending: false }),
    (supabase.from('agents') as any)
      .select('id, name, status, kya_tier, created_at')
      .eq('tenant_id', id)
      .order('created_at', { ascending: false })
      .limit(20),
    (supabase.from('accounts') as any)
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', id),
    (supabase.from('transfers') as any)
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', id),
    (supabase.from('streams') as any)
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', id),
    (supabase.from('transfers') as any)
      .select('amount')
      .eq('tenant_id', id)
      .eq('status', 'completed'),
  ]);

  const totalVolume = (volumeResult.data || []).reduce(
    (sum: number, t: any) => sum + (parseFloat(t.amount) || 0),
    0
  );

  const category = classifyTenant(tenant);

  return c.json({
    tenant: { ...tenant, usage, category },
    users: usersResult.data || [],
    agents: agentsResult.data || [],
    stats: {
      users: usersResult.data?.length || 0,
      agents: agentsResult.data?.length || 0,
      accounts: accountsResult.count || 0,
      transfers: transfersResult.count || 0,
      streams: streamsResult.count || 0,
      totalVolume,
    },
  });
});

// ============================================
// PATCH /admin/beta/tenants/:id/limits
// ============================================
const updateLimitsSchema = z.object({
  maxTeamMembers: z.number().int().positive().optional(),
  maxAgents: z.number().int().positive().optional(),
});

betaAdmin.patch('/tenants/:id/limits', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const parsed = updateLimitsSchema.parse(body);

  const updated = await updateTenantLimits(id, parsed);
  return c.json({ tenant: updated });
});

// ============================================
// GET /admin/beta/health
// ============================================
betaAdmin.get('/health', async (c) => {
  const supabase = createClient();

  // Database connectivity check
  let dbStatus = 'healthy';
  try {
    const { error } = await (supabase.from('tenants') as any).select('id').limit(1);
    if (error) dbStatus = 'unhealthy';
  } catch {
    dbStatus = 'unhealthy';
  }

  return c.json({
    status: dbStatus === 'healthy' ? 'healthy' : 'degraded',
    database: dbStatus,
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development',
    nodeVersion: process.version,
    timestamp: new Date().toISOString(),
  });
});

// ============================================
// GET /admin/beta/stats
// ============================================
betaAdmin.get('/stats', async (c) => {
  const supabase = createClient();

  // Parallel count queries
  const [
    tenantsResult,
    usersResult,
    agentsResult,
    accountsResult,
    transfersResult,
    streamsResult,
    volumeResult,
  ] = await Promise.all([
    (supabase.from('tenants') as any).select('id', { count: 'exact', head: true }),
    (supabase.from('user_profiles') as any).select('id', { count: 'exact', head: true }),
    (supabase.from('agents') as any).select('id', { count: 'exact', head: true }),
    (supabase.from('accounts') as any).select('id', { count: 'exact', head: true }),
    (supabase.from('transfers') as any).select('id', { count: 'exact', head: true }),
    (supabase.from('streams') as any).select('id', { count: 'exact', head: true }),
    (supabase.from('transfers') as any)
      .select('amount')
      .eq('status', 'completed'),
  ]);

  // Sum completed transfer volume
  const totalVolume = (volumeResult.data || []).reduce(
    (sum: number, t: any) => sum + (parseFloat(t.amount) || 0),
    0
  );

  // Recent API requests in last 24h
  let recentApiRequests = 0;
  try {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: requestData } = await (supabase.from('api_request_counts') as any)
      .select('count')
      .gte('minute_bucket', oneDayAgo);
    recentApiRequests = (requestData || []).reduce(
      (sum: number, r: any) => sum + (parseInt(r.count) || 0),
      0
    );
  } catch {
    // Table may not exist yet
  }

  return c.json({
    counts: {
      tenants: tenantsResult.count || 0,
      users: usersResult.count || 0,
      agents: agentsResult.count || 0,
      accounts: accountsResult.count || 0,
      transfers: transfersResult.count || 0,
      streams: streamsResult.count || 0,
    },
    totalVolume,
    recentApiRequests,
  });
});

// ============================================
// GET /admin/beta/agents - Agent leaderboard
// ============================================
betaAdmin.get('/agents', async (c) => {
  const supabase = createClient();
  const page = parseInt(c.req.query('page') || '1');
  const limit = parseInt(c.req.query('limit') || '50');
  const status = c.req.query('status') || '';
  const search = c.req.query('search') || '';

  let query = (supabase.from('agents') as any)
    .select('id, name, description, status, kya_tier, discoverable, endpoint_url, total_volume, total_transactions, wallet_address, created_at, tenant_id', { count: 'exact' })
    .order('total_transactions', { ascending: false, nullsFirst: false });

  if (status) {
    query = query.eq('status', status);
  }
  if (search) {
    query = query.ilike('name', `%${search}%`);
  }

  query = query.range((page - 1) * limit, page * limit - 1);
  const { data: agents, count, error } = await query;

  if (error) {
    return c.json({ error: `Failed to list agents: ${error.message}` }, 500);
  }

  // Enrich with tenant name and task counts
  const agentIds = (agents || []).map((a: any) => a.id);
  const tenantIds = [...new Set((agents || []).map((a: any) => a.tenant_id))];

  const [tenantsResult, tasksResult] = await Promise.all([
    tenantIds.length
      ? (supabase.from('tenants') as any).select('id, name').in('id', tenantIds)
      : { data: [] },
    agentIds.length
      ? supabase.rpc('get_agent_task_counts', undefined).then(() => null).catch(() => null)
      : null,
  ]);

  const tenantMap = new Map((tenantsResult.data || []).map((t: any) => [t.id, t.name]));

  // Get task counts per agent via direct query
  let taskCountMap = new Map<string, { completed: number; failed: number; total: number }>();
  if (agentIds.length) {
    const { data: taskCounts } = await (supabase.from('a2a_tasks') as any)
      .select('agent_id, state')
      .in('agent_id', agentIds);

    if (taskCounts) {
      for (const t of taskCounts) {
        const entry = taskCountMap.get(t.agent_id) || { completed: 0, failed: 0, total: 0 };
        entry.total++;
        if (t.state === 'completed') entry.completed++;
        if (t.state === 'failed') entry.failed++;
        taskCountMap.set(t.agent_id, entry);
      }
    }
  }

  const enriched = (agents || []).map((a: any) => {
    const tasks = taskCountMap.get(a.id) || { completed: 0, failed: 0, total: 0 };
    return {
      ...a,
      tenant_name: tenantMap.get(a.tenant_id) || 'Unknown',
      tasks,
      success_rate: tasks.total > 0 ? Math.round((tasks.completed / tasks.total) * 100) : 0,
    };
  });

  // Sort by completed tasks descending (leaderboard)
  enriched.sort((a: any, b: any) => b.tasks.completed - a.tasks.completed);

  return c.json({
    data: enriched,
    pagination: {
      page,
      limit,
      total: count || 0,
      totalPages: Math.ceil((count || 0) / limit),
    },
  });
});

// ============================================
// GET /admin/beta/agents/:id - Agent detail
// ============================================
betaAdmin.get('/agents/:id', async (c) => {
  const supabase = createClient();
  const id = c.req.param('id');

  const [agentResult, tenantLookup, skillsResult, walletResult, tasksResult] = await Promise.all([
    (supabase.from('agents') as any)
      .select('id, name, description, status, kya_tier, kya_status, kya_verified_at, discoverable, endpoint_url, endpoint_type, endpoint_enabled, total_volume, total_transactions, wallet_address, permissions, metadata, type, x402_enabled, processing_mode, created_at, updated_at, tenant_id, parent_account_id')
      .eq('id', id)
      .single(),
    // We'll look up tenant name after we have tenant_id
    null,
    (supabase.from('agent_skills') as any)
      .select('skill_id, name, description, tags, base_price, currency, total_invocations, total_fees_collected, status, handler_type')
      .eq('agent_id', id)
      .order('total_invocations', { ascending: false }),
    (supabase.from('wallets') as any)
      .select('id, balance, currency, wallet_address, network, status, wallet_type, custody_type, provider, created_at')
      .eq('managed_by_agent_id', id)
      .limit(5),
    (supabase.from('a2a_tasks') as any)
      .select('id, state, status_message, direction, created_at, updated_at, processing_duration_ms')
      .eq('agent_id', id)
      .order('created_at', { ascending: false })
      .limit(20),
  ]);

  if (agentResult.error || !agentResult.data) {
    return c.json({ error: 'Agent not found' }, 404);
  }

  const agent = agentResult.data;

  // Fetch tenant name
  const { data: tenant } = await (supabase.from('tenants') as any)
    .select('id, name')
    .eq('id', agent.tenant_id)
    .single();

  // Fetch parent account name
  let parentAccount = null;
  if (agent.parent_account_id) {
    const { data } = await (supabase.from('accounts') as any)
      .select('id, name')
      .eq('id', agent.parent_account_id)
      .single();
    parentAccount = data;
  }

  // Compute task stats
  const tasks = tasksResult.data || [];
  const taskStats = {
    total: tasks.length,
    completed: tasks.filter((t: any) => t.state === 'completed').length,
    failed: tasks.filter((t: any) => t.state === 'failed').length,
    working: tasks.filter((t: any) => t.state === 'working').length,
    avgDurationMs: 0,
  };
  const completedWithDuration = tasks.filter((t: any) => t.state === 'completed' && t.processing_duration_ms);
  if (completedWithDuration.length) {
    taskStats.avgDurationMs = Math.round(
      completedWithDuration.reduce((s: number, t: any) => s + t.processing_duration_ms, 0) / completedWithDuration.length
    );
  }

  return c.json({
    agent: {
      ...agent,
      tenant_name: tenant?.name || 'Unknown',
      parent_account_name: parentAccount?.name || null,
    },
    skills: skillsResult.data || [],
    wallets: walletResult.data || [],
    recentTasks: tasks,
    taskStats,
  });
});

export default betaAdmin;
