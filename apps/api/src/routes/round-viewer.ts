/**
 * Live Round Viewer — Admin-Protected Endpoints
 *
 * Bird's-eye view of all marketplace activity across all tenants.
 * Protected by platformAdminMiddleware (Google SSO @getsly.ai or PLATFORM_ADMIN_API_KEY).
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { platformAdminMiddleware } from '../middleware/platform-admin.js';
import { createClient } from '../db/client.js';
import { taskEventBus } from '../services/a2a/task-event-bus.js';

const roundViewerRouter = new Hono();

// CORS: allow any origin for the demo viewer (auth via admin key protects access)
roundViewerRouter.use('*', async (c, next) => {
  c.header('Access-Control-Allow-Origin', c.req.header('Origin') || '*');
  c.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  c.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  c.header('Access-Control-Allow-Credentials', 'true');
  if (c.req.method === 'OPTIONS') return c.text('', 204);
  return next();
});

// All routes require platform admin auth.
// SSE endpoints can't send headers, so also accept ?token= query param.
roundViewerRouter.use('*', async (c, next) => {
  // Check query param token for SSE connections
  const queryToken = c.req.query('token');
  if (queryToken && !c.req.header('Authorization')) {
    // Inject as Authorization header so platformAdminMiddleware picks it up
    c.req.raw.headers.set('Authorization', `Bearer ${queryToken}`);
  }
  return platformAdminMiddleware(c, next);
});

/**
 * GET /admin/round/stream
 * SSE stream of ALL marketplace task events across ALL tenants.
 */
roundViewerRouter.get('/stream', async (c) => {
  return streamSSE(c, async (stream) => {
    let eventId = 0;

    const unsub = taskEventBus.subscribeAll((event) => {
      try {
        stream.writeSSE({
          data: JSON.stringify(event),
          event: event.type,
          id: String(++eventId),
        });
      } catch { /* client disconnected */ }
    });

    const hb = setInterval(() => {
      try { stream.writeSSE({ data: new Date().toISOString(), event: 'heartbeat', id: String(++eventId) }); }
      catch { /* client disconnected */ }
    }, 15000);

    stream.onAbort(() => { unsub(); clearInterval(hb); });

    await new Promise(r => setTimeout(r, 600000)); // 10 min max
    unsub();
    clearInterval(hb);
  });
});

/**
 * GET /admin/round/snapshot
 * Cross-tenant snapshot of recent marketplace activity.
 */
roundViewerRouter.get('/snapshot', async (c) => {
  const minutes = parseInt(c.req.query('minutes') || '5');
  const cutoff = new Date(Date.now() - minutes * 60 * 1000).toISOString();
  const supabase = createClient(); // service role — bypasses RLS

  const [tasksRes, mandatesRes, transfersRes] = await Promise.all([
    supabase.from('a2a_tasks')
      .select('id, state, agent_id, client_agent_id, metadata, status_message, created_at, updated_at, webhook_status')
      .gte('created_at', cutoff).order('created_at', { ascending: false }).limit(200),
    supabase.from('ap2_mandates')
      .select('mandate_id, status, authorized_amount, agent_id, created_at')
      .gte('created_at', cutoff).order('created_at', { ascending: false }).limit(100),
    supabase.from('transfers')
      .select('id, amount, status, tx_hash, created_at')
      .gte('created_at', cutoff).order('created_at', { ascending: false }).limit(100),
  ]);

  // Collect all unique agent IDs from tasks (both buyer and seller)
  const agentIdSet = new Set<string>();
  for (const t of (tasksRes.data || [])) {
    if (t.agent_id) agentIdSet.add(t.agent_id);
    if (t.client_agent_id) agentIdSet.add(t.client_agent_id);
  }

  // Resolve names for ALL referenced agents (no status filter)
  const agentNames: Record<string, string> = {};
  if (agentIdSet.size > 0) {
    const { data: agentsData } = await supabase.from('agents')
      .select('id, name')
      .in('id', Array.from(agentIdSet));
    for (const a of (agentsData || [])) {
      agentNames[a.id] = a.name;
    }
  }

  return c.json({
    data: {
      tasks: tasksRes.data || [],
      mandates: mandatesRes.data || [],
      transfers: transfersRes.data || [],
      agentNames,
      timestamp: new Date().toISOString(),
    },
  });
});

/**
 * GET /admin/round/agents
 * All active agents with skills and wallets — cross-tenant.
 */
roundViewerRouter.get('/agents', async (c) => {
  const supabase = createClient();

  const { data: agents } = await supabase
    .from('agents')
    .select('id, name, status, kya_tier, description')
    .in('status', ['active', 'suspended', 'frozen'])
    .limit(50);

  const { data: skills } = await supabase
    .from('agent_skills')
    .select('agent_id, skill_id, name, base_price, currency')
    .eq('status', 'active')
    .limit(200);

  const { data: wallets } = await supabase
    .from('wallets')
    .select('managed_by_agent_id, wallet_type, balance, status')
    .eq('status', 'active');

  const agentMap: Record<string, any> = {};
  for (const a of (agents || [])) {
    agentMap[a.id] = { ...a, skills: [], wallets: [] };
  }
  for (const s of (skills || [])) {
    if (agentMap[s.agent_id]) {
      agentMap[s.agent_id].skills.push({ id: s.skill_id, name: s.name, price: s.base_price, currency: s.currency });
    }
  }
  for (const w of (wallets || [])) {
    if (w.managed_by_agent_id && agentMap[w.managed_by_agent_id]) {
      agentMap[w.managed_by_agent_id].wallets.push({ type: w.wallet_type, balance: Number(w.balance), status: w.status });
    }
  }

  return c.json({ data: Object.values(agentMap) });
});

/**
 * POST /admin/round/start
 * Start a marketplace round. Emits a round_start event via the event bus
 * so the live viewer knows which scenario is running.
 */
roundViewerRouter.post('/start', async (c) => {
  const body = await c.req.json();
  const scenario = body?.scenario || 'custom';
  const description = body?.description || '';

  // Emit round start event so the viewer picks it up
  taskEventBus.emit('task:all', {
    type: 'status' as const,
    taskId: 'round:' + Date.now(),
    data: {
      state: 'round_start',
      scenario,
      description,
      startedAt: new Date().toISOString(),
    },
    timestamp: new Date().toISOString(),
  });

  return c.json({ data: { scenario, startedAt: new Date().toISOString() } });
});

/**
 * POST /admin/round/comment
 * Add a live commentary event to the stream.
 */
roundViewerRouter.post('/comment', async (c) => {
  const body = await c.req.json();
  const text = body?.text || '';
  const type = body?.type || 'info'; // info, finding, alert, governance

  taskEventBus.emit('task:all', {
    type: 'status' as const,
    taskId: 'comment:' + Date.now(),
    data: { state: 'commentary', text, commentType: type },
    timestamp: new Date().toISOString(),
  });

  return c.json({ data: { text, type } });
});

export { roundViewerRouter };
