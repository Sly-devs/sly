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
 * GET /admin/round/scenarios
 * List all available marketplace scenarios.
 */
roundViewerRouter.get('/scenarios', async (c) => {
  const { SCENARIOS } = await import('../services/scenarios/registry.js');
  return c.json({ data: SCENARIOS });
});

/**
 * POST /admin/round/execute
 * Execute a scenario. Requires agent tokens in the request body.
 * Runs async — returns immediately, streams events via SSE.
 */
roundViewerRouter.post('/execute', async (c) => {
  const body = await c.req.json();
  const scenarioId = body?.scenario;
  const agentTokens = body?.agentTokens || {};

  if (!scenarioId) return c.json({ error: 'Missing scenario' }, 400);

  const apiBase = body?.apiBase || `https://${c.req.header('Host')}`;

  // Execute async — don't block the response
  const { executeScenario } = await import('../services/scenarios/registry.js');
  executeScenario(scenarioId, agentTokens, apiBase).then(result => {
    console.log(`[Scenario] ${scenarioId}: ${result.summary}`);
  }).catch(err => {
    console.error(`[Scenario] ${scenarioId} failed:`, err.message);
  });

  return c.json({ data: { scenario: scenarioId, status: 'started' } });
});

/**
 * POST /admin/round/start
 * Announce a round start (for scripts calling from outside).
 */
roundViewerRouter.post('/start', async (c) => {
  const body = await c.req.json();
  taskEventBus.emit('task:all', {
    type: 'status' as const,
    taskId: 'round:' + Date.now(),
    data: { state: 'round_start', scenario: body?.scenario || 'custom', description: body?.description || '', startedAt: new Date().toISOString() },
    timestamp: new Date().toISOString(),
  });
  return c.json({ data: { scenario: body?.scenario, startedAt: new Date().toISOString() } });
});

/**
 * POST /admin/round/comment
 * Add a live commentary event to the stream.
 */
roundViewerRouter.post('/comment', async (c) => {
  const body = await c.req.json();
  const text = body?.text || '';
  const commentType = body?.type || 'info';
  // Persist to the ring buffer first so a viewer fetching /comments later
  // sees it even if the SSE stream wasn't connected at this instant.
  bufferNarration({ kind: 'comment', text, type: commentType });
  taskEventBus.emit('task:all', {
    type: 'status' as const,
    taskId: 'comment:' + Date.now(),
    data: { state: 'commentary', text, commentType },
    timestamp: new Date().toISOString(),
  });
  return c.json({ data: { text, type: commentType } });
});

/**
 * GET /admin/round/comments?since=<iso>&limit=<n>
 * Returns the in-memory ring buffer of comment + milestone events. Used by
 * the viewer at report-generation time to recover anything the live SSE
 * stream missed (slow connect, mid-run reconnect, etc.).
 */
roundViewerRouter.get('/comments', async (c) => {
  const since = c.req.query('since');
  const limit = Math.min(parseInt(c.req.query('limit') || '500', 10), NARRATION_BUFFER_CAP);
  let items = narrationBuffer;
  if (since) items = items.filter((e) => e.timestamp >= since);
  if (items.length > limit) items = items.slice(items.length - limit);
  return c.json({ data: items, meta: { total: narrationBuffer.length, capacity: NARRATION_BUFFER_CAP } });
});

/**
 * POST /admin/round/milestone
 * Emit a pinned milestone to the live viewer (shows in Key Findings bar
 * and attaches a star to the agent node on the graph). Intended for external
 * scenario runners like @sly/marketplace-sim that narrate rounds via public APIs.
 *
 * Body: { text: string, agentId?: string, agentName?: string, icon?: string }
 */
roundViewerRouter.post('/milestone', async (c) => {
  const body = await c.req.json();
  if (!body?.text) return c.json({ error: 'Missing text' }, 400);
  // Persist to the ring buffer so post-run report fetches catch it.
  bufferNarration({
    kind: 'milestone',
    text: body.text,
    type: 'milestone',
    agentId: body.agentId,
    agentName: body.agentName,
    icon: body.icon || '\u272e',
  });
  taskEventBus.emit('task:all', {
    type: 'status' as const,
    taskId: 'milestone:' + Date.now(),
    data: {
      state: 'commentary',
      text: body.text,
      commentType: 'milestone',
      milestone: true,
      agentId: body.agentId,
      agentName: body.agentName,
      icon: body.icon || '\u272e',
    },
    timestamp: new Date().toISOString(),
  });
  return c.json({ data: { text: body.text, agentId: body.agentId } });
});

/**
 * POST /admin/round/seed-agent
 * Create (or reuse) a marketplace-sim persona agent and return its plaintext
 * auth token. Only the admin key can call this — intended for the standalone
 * @sly/marketplace-sim runner to bootstrap persona agents before a round.
 *
 * Body: { name: string, description?: string, kyaTier?: number }
 * Returns: { id, name, token, walletId, balance, reused }
 */
roundViewerRouter.post('/seed-agent', async (c) => {
  const body = await c.req.json();
  const name: string | undefined = body?.name;
  if (!name) return c.json({ error: 'Missing name' }, 400);

  const supabase = createClient();

  // Reuse any existing sim agent with this name (marketplace-sim personas are stable)
  const { data: existing } = await supabase
    .from('agents')
    .select('id, tenant_id, status, parent_account_id')
    .eq('name', name)
    .eq('status', 'active')
    .limit(1)
    .maybeSingle();

  if (existing) {
    // Rotate the token so we hand back a fresh plaintext value
    const { generateAgentToken, hashApiKey, getKeyPrefix } = await import('../utils/crypto.js');
    const newToken = generateAgentToken();
    await supabase
      .from('agents')
      .update({
        auth_token_hash: hashApiKey(newToken),
        auth_token_prefix: getKeyPrefix(newToken),
        auth_client_id: getKeyPrefix(newToken),
      })
      .eq('id', existing.id);

    // Find or top up wallet — create one if it doesn't exist yet.
    let wallet: { id: string; balance: number } | null = null;
    const { data: existingWallet } = await supabase
      .from('wallets')
      .select('id, balance')
      .eq('managed_by_agent_id', existing.id)
      .eq('status', 'active')
      .order('balance', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existingWallet) {
      wallet = existingWallet as any;
    } else if (existing.parent_account_id) {
      // No wallet yet — create one so the persona can transact
      const { data: created, error: createErr } = await supabase
        .from('wallets')
        .insert({
          tenant_id: existing.tenant_id,
          owner_account_id: existing.parent_account_id,
          managed_by_agent_id: existing.id,
          wallet_type: 'internal',
          balance: 200,
          currency: 'USDC',
          status: 'active',
        })
        .select('id, balance')
        .single();
      if (createErr) console.error('[seed-agent] wallet create failed:', createErr.message);
      if (created) wallet = created as any;
    }

    let effectiveBalance = Number(wallet?.balance ?? 0);
    if (wallet && effectiveBalance < 50 && existing.parent_account_id) {
      await supabase.from('wallets').update({ balance: 200 }).eq('id', wallet.id);
      effectiveBalance = 200;
    }

    // ERC-8004: Register on-chain if not already registered
    const { data: agentCheck } = await supabase
      .from('agents').select('erc8004_agent_id').eq('id', existing.id).maybeSingle();
    if (!agentCheck?.erc8004_agent_id) {
      try {
        const { registerAgent } = await import('../services/erc8004/registry.js');
        registerAgent(existing.id, name, body?.description || '').catch((err: any) =>
          console.warn('[seed-agent] ERC-8004 registration failed:', err.message)
        );
      } catch {}
    }

    return c.json({
      data: {
        id: existing.id,
        name,
        tenantId: existing.tenant_id,
        parentAccountId: existing.parent_account_id,
        token: newToken,
        walletId: wallet?.id,
        balance: effectiveBalance,
        reused: true,
      },
    });
  }

  // Pick the tenant to host this sim persona. Priority:
  //   1. tenantId in request body (explicit override)
  //   2. process.env.SIM_TENANT_ID (pinned sim tenant)
  //   3. First active tenant in the DB (non-deterministic fallback)
  // This lets a demo align sim agents with whichever tenant the dashboard user is on.
  const explicitTenantId: string | undefined = body?.tenantId;
  const pinnedTenantId = process.env.SIM_TENANT_ID;

  let tenant: { id: string } | null = null;
  if (explicitTenantId || pinnedTenantId) {
    const target = explicitTenantId || pinnedTenantId!;
    const { data } = await supabase
      .from('tenants')
      .select('id')
      .eq('id', target)
      .eq('status', 'active')
      .maybeSingle();
    tenant = data as any;
    if (!tenant) {
      return c.json(
        { error: `Requested tenant ${target} not found or not active` },
        400
      );
    }
  } else {
    const { data } = await supabase
      .from('tenants')
      .select('id')
      .eq('status', 'active')
      .limit(1)
      .maybeSingle();
    tenant = data as any;
  }

  if (!tenant) return c.json({ error: 'No active tenant found to host sim persona' }, 500);

  // Find any account under this tenant for wallet ownership
  const { data: account } = await supabase
    .from('accounts')
    .select('id')
    .eq('tenant_id', tenant.id)
    .limit(1)
    .maybeSingle();

  const { generateAgentToken, hashApiKey, getKeyPrefix } = await import('../utils/crypto.js');
  const token = generateAgentToken();

  const { data: agent, error: agentErr } = await supabase
    .from('agents')
    .insert({
      tenant_id: tenant.id,
      parent_account_id: account?.id || null,
      name,
      description: body?.description || `marketplace-sim persona: ${name}`,
      status: 'active',
      kya_tier: body?.kyaTier ?? 1,
      kya_status: 'verified',
      auth_type: 'api_key',
      auth_token_hash: hashApiKey(token),
      auth_token_prefix: getKeyPrefix(token),
      auth_client_id: getKeyPrefix(token),
      permissions: [],
      effective_limit_per_tx: 1000,
    })
    .select('id')
    .single();

  if (agentErr || !agent) {
    return c.json({ error: `Failed to create agent: ${agentErr?.message}` }, 500);
  }

  // Auto-create a funded wallet so the persona can pay for services
  let walletId: string | null = null;
  if (account?.id) {
    const { data: wallet, error: walletErr } = await supabase
      .from('wallets')
      .insert({
        tenant_id: tenant.id,
        owner_account_id: account.id,
        managed_by_agent_id: agent.id,
        wallet_type: 'internal',
        balance: 200,
        currency: 'USDC',
        status: 'active',
      })
      .select('id')
      .single();
    if (walletErr) console.error('[seed-agent] wallet create (new) failed:', walletErr.message);
    walletId = wallet?.id || null;
  }

  // ERC-8004: Auto-register agent on-chain (fire-and-forget)
  try {
    const { registerAgent } = await import('../services/erc8004/registry.js');
    registerAgent(agent.id, name, body?.description || '').catch((err: any) =>
      console.warn('[seed-agent] ERC-8004 registration failed:', err.message)
    );
  } catch {}

  return c.json({
    data: {
      id: agent.id,
      name,
      tenantId: tenant.id,
      parentAccountId: account?.id || null,
      token,
      walletId,
      balance: 200,
      reused: false,
    },
  });
});

/**
 * POST /admin/round/attest
 * Write a trade attestation to EAS on Base Sepolia.
 * Body: { taskId, buyerAgentId, sellerAgentId, skill, amount, artifactHash, buyerScore, sellerScore }
 */
roundViewerRouter.post('/attest', async (c) => {
  const body = await c.req.json();
  try {
    const { attestTrade } = await import('../services/eas/index.js');
    const result = await attestTrade({
      taskId: body.taskId,
      buyerAgentId: body.buyerAgentId,
      sellerAgentId: body.sellerAgentId,
      skill: body.skill || 'general',
      amount: body.amount || 2,
      artifactHash: body.artifactHash || '',
      buyerScore: body.buyerScore || 0,
      sellerScore: body.sellerScore || 0,
    });
    if (!result) return c.json({ error: 'Attestation disabled (no EVM_PRIVATE_KEY)' }, 503);

    // Persist attestation to the task so the app can surface the on-chain link
    // on rating rows, agent detail, etc. Merge into existing metadata.
    if (body.taskId) {
      try {
        const supabase = createClient();
        const { data: existing } = await (supabase.from('a2a_tasks') as any)
          .select('metadata')
          .eq('id', body.taskId)
          .maybeSingle();
        const prev = (existing?.metadata as any) ?? {};
        const nextMetadata = {
          ...prev,
          attestation: {
            uid: result.uid,
            txHash: result.txHash,
            eascanUrl: result.eascanUrl,
            artifactHash: body.artifactHash || '',
            attestedAt: new Date().toISOString(),
          },
        };
        await (supabase.from('a2a_tasks') as any)
          .update({ metadata: nextMetadata })
          .eq('id', body.taskId);
      } catch (err: any) {
        console.warn('[attest] failed to persist to task metadata:', err?.message);
      }
    }

    return c.json({ data: result });
  } catch (err: any) {
    console.error('[attest] EAS attestation failed:', err.message);
    return c.json({ error: err.message }, 500);
  }
});

/**
 * POST /admin/round/announce
 * Announce the start of a round — used by external runners so the live viewer
 * can update its scenario name/description from a customer-driven source.
 *
 * Body: { scenario: string, description?: string }
 */
roundViewerRouter.post('/announce', async (c) => {
  const body = await c.req.json();
  if (!body?.scenario) return c.json({ error: 'Missing scenario' }, 400);
  taskEventBus.emit('task:all', {
    type: 'status' as const,
    taskId: 'round:' + Date.now(),
    data: {
      state: 'round_start',
      scenario: body.scenario,
      description: body.description || '',
      startedAt: new Date().toISOString(),
    },
    timestamp: new Date().toISOString(),
  });
  return c.json({ data: { scenario: body.scenario, startedAt: new Date().toISOString() } });
});

/**
 * GET /admin/round/report
 * Generate a post-scenario report from the last N minutes of activity.
 * Returns structured analysis: volume, completion rate, top performers, governance assessment.
 */
roundViewerRouter.get('/report', async (c) => {
  const minutes = parseInt(c.req.query('minutes') || '15');
  const cutoff = new Date(Date.now() - minutes * 60 * 1000).toISOString();
  const supabase = createClient();

  const [tasksRes, mandatesRes] = await Promise.all([
    supabase.from('a2a_tasks')
      .select('id, state, agent_id, client_agent_id, metadata, status_message, created_at, updated_at')
      .gte('created_at', cutoff).order('created_at', { ascending: false }).limit(1000),
    supabase.from('ap2_mandates')
      .select('mandate_id, status, authorized_amount, used_amount, agent_id, a2a_session_id, created_at, metadata')
      .gte('created_at', cutoff).order('created_at', { ascending: false }).limit(500),
  ]);

  const tasks = tasksRes.data || [];
  const mandates = mandatesRes.data || [];

  // Resolve agent names
  const agentIdSet = new Set<string>();
  for (const t of tasks) {
    if (t.agent_id) agentIdSet.add(t.agent_id);
    if (t.client_agent_id) agentIdSet.add(t.client_agent_id);
  }
  const agentNames: Record<string, string> = {};
  if (agentIdSet.size > 0) {
    const { data: agentsData } = await supabase.from('agents').select('id, name').in('id', Array.from(agentIdSet));
    for (const a of (agentsData || [])) agentNames[a.id] = a.name;
  }

  // Aggregate stats
  const completed = tasks.filter(t => t.state === 'completed').length;
  const failed = tasks.filter(t => t.state === 'failed').length;
  const inputRequired = tasks.filter(t => t.state === 'input-required').length;
  const working = tasks.filter(t => t.state === 'working').length;
  const total = tasks.length;

  const completedMandates = mandates.filter(m => m.status === 'completed');
  const activeMandates = mandates.filter(m => m.status === 'active');
  const totalVolume = completedMandates.reduce((s, m) => s + Number(m.authorized_amount || 0), 0);
  const escrowedVolume = activeMandates.reduce((s, m) => s + Number(m.authorized_amount || 0), 0);

  // ─── Outcome-aware analysis ────────────────────────────────────────────
  // Some mandates are cancelled by intent (e.g. losers in a competitive
  // bake-off), not by platform failure. Marketplace-sim tags those with
  // metadata.outcome so we can subtract them from the throughput / failure
  // metrics and report them as their own "Bidding" line. Without this the
  // report calls a successful 5-bidder bake-off a "20% completion failure".
  const outcomeCounts: Record<string, number> = {};
  for (const m of mandates) {
    const outcome = (m as any).metadata?.outcome;
    if (typeof outcome === 'string') {
      outcomeCounts[outcome] = (outcomeCounts[outcome] || 0) + 1;
    }
  }
  const outbidFromMandates = (outcomeCounts.outbid || 0) + (outcomeCounts.not_selected || 0);
  // Also count cancelled tasks — these are losing bids that never had a mandate
  // (double_auction creates mandates only for winners).
  const cancelledTasks = tasks.filter(t => t.state === 'canceled' || t.state === 'cancelled').length;
  const outbidCount = outbidFromMandates + cancelledTasks;
  // Buyer-rejected mandates (outcome='rejected') are intentional quality gates,
  // NOT platform failures. Subtract them from the effective total just like outbid.
  const rejectedCount = outcomeCounts.rejected || 0;
  // All "intentional non-completions" — auction losers + quality rejections + cancelled bids.
  // These are NOT platform failures and should not inflate the failure rate.
  const intentionalNonCompletions = outbidCount + rejectedCount;

  // ─── Rogue containment analysis (one_to_one block) ───────────────────────
  // The marketplace-sim one_to_one block tags each cycle's mandate with
  // metadata.isRogueCycle + metadata.rogueRole so the report can bucket
  // adversarial outcomes without needing scenario-specific knowledge.
  //
  //   * mandate completed + rogueRole=seller   → rogueSucceeded (containment FAIL)
  //   * mandate completed + rogueRole=buyer    → rogueDefeated  (rogue had to accept)
  //   * mandate cancelled + outcome=rogueRejected → rogueRejected (containment WIN)
  //   * mandate cancelled + outcome=rogueDisputed → rogueDisputed (extraction attempt)
  //
  // (rogueBlockedByPlatform isn't visible here — those mandates were never
  // created. The block emits a comment instead.)
  const rogueMandates = mandates.filter((m: any) => m.metadata?.isRogueCycle === true);
  const rogueBuckets = {
    rogueRejected: 0,
    rogueSucceeded: 0,
    rogueDisputed: 0,
    rogueDefeated: 0,
  };
  for (const m of rogueMandates as any[]) {
    const role = m.metadata?.rogueRole;
    const outcome = m.metadata?.outcome;
    if (m.status === 'completed') {
      if (role === 'seller') rogueBuckets.rogueSucceeded++;
      else if (role === 'buyer') rogueBuckets.rogueDefeated++;
    } else if (outcome === 'rogueRejected') {
      rogueBuckets.rogueRejected++;
    } else if (outcome === 'rogueDisputed') {
      rogueBuckets.rogueDisputed++;
    }
  }
  const containmentTotal =
    rogueBuckets.rogueRejected + rogueBuckets.rogueSucceeded + rogueBuckets.rogueDisputed;
  const containmentRate = containmentTotal > 0
    ? Math.round((rogueBuckets.rogueRejected / containmentTotal) * 100)
    : null;
  // Effective denominator: tasks the buyer actually intended to settle.
  // (Bake-off losers were meant to lose.)
  const effectiveTotal = Math.max(0, total - intentionalNonCompletions);
  const effectiveCompletionRate = effectiveTotal > 0
    ? Math.round((completed / effectiveTotal) * 100)
    : 0;
  // Failures that are NOT outbid losers — these are real failures worth flagging.
  const realFailed = Math.max(0, failed - intentionalNonCompletions);
  // Legacy "raw" completion rate kept for backwards compatibility with the
  // viewer's metric bar; assessment uses effectiveCompletionRate.
  const completionRate = total > 0 ? Math.round(completed / total * 100) : 0;

  // Federation analysis: mandates where settlement routed to an external A2A address
  const federationMandates = completedMandates.filter((m: any) => m.metadata?.source === 'a2a_federation');
  const federationVolume = federationMandates.reduce((s, m) => s + Number(m.authorized_amount || 0), 0);
  const externalDestinations = new Set(
    federationMandates.map((m: any) => m.metadata?.payoutAddress).filter(Boolean) as string[]
  );
  const externalPayoutsByAddress: Record<string, { amount: number; count: number; txHashes: string[] }> = {};
  for (const m of federationMandates) {
    const meta = (m as any).metadata || {};
    const addr = meta.payoutAddress;
    if (!addr) continue;
    if (!externalPayoutsByAddress[addr]) externalPayoutsByAddress[addr] = { amount: 0, count: 0, txHashes: [] };
    externalPayoutsByAddress[addr].amount += Number(m.authorized_amount || 0);
    externalPayoutsByAddress[addr].count += 1;
    if (meta.settlement_tx_hash) externalPayoutsByAddress[addr].txHashes.push(meta.settlement_tx_hash);
  }
  const onChainSettlementCount = federationMandates.filter(
    (m: any) => m.metadata?.settlement_type === 'on_chain'
  ).length;

  // Build the set of task IDs that were INTENTIONALLY outbid in a bake-off.
  // We tag mandates with metadata.outcome='outbid' when the buyer rejects a
  // losing bid. Their tasks land in 'failed' state but they're not platform
  // failures — we exclude them from the per-agent failure count and surface
  // them as a separate "outbid" column so winRate measures bake-off wins, not
  // failure freedom.
  // Build sets of task IDs by intentional outcome so per-agent stats can
  // separate bake-off losses and quality rejections from real failures.
  const outbidTaskIds = new Set<string>();
  const rejectedTaskIds = new Set<string>();
  for (const m of mandates as any[]) {
    if (m.metadata?.outcome === 'outbid' && m.a2a_session_id) {
      outbidTaskIds.add(m.a2a_session_id);
    } else if (m.metadata?.outcome === 'rejected' && m.a2a_session_id) {
      rejectedTaskIds.add(m.a2a_session_id);
    }
  }

  // Per-agent breakdown — outbid + rejected kept separate from real failures.
  type AgentStat = {
    name: string;
    sent: number;
    received: number;
    completed: number;
    outbid: number;
    rejected: number;
    failed: number;
  };
  const agentStats: Record<string, AgentStat> = {};
  for (const t of tasks) {
    if (t.client_agent_id) {
      const id = t.client_agent_id;
      if (!agentStats[id]) agentStats[id] = { name: agentNames[id] || id.slice(0, 8), sent: 0, received: 0, completed: 0, outbid: 0, rejected: 0, failed: 0 };
      agentStats[id].sent++;
    }
    if (t.agent_id) {
      const id = t.agent_id;
      if (!agentStats[id]) agentStats[id] = { name: agentNames[id] || id.slice(0, 8), sent: 0, received: 0, completed: 0, outbid: 0, rejected: 0, failed: 0 };
      agentStats[id].received++;
      if (t.state === 'completed') {
        agentStats[id].completed++;
      } else if (t.state === 'failed') {
        if (outbidTaskIds.has(t.id)) {
          agentStats[id].outbid++;
        } else if (rejectedTaskIds.has(t.id)) {
          agentStats[id].rejected++;
        } else {
          agentStats[id].failed++;
        }
      }
    }
  }

  // We surface up to 25 agents (was 5) so the LLM analyzer can see the full
  // interaction pattern instead of guessing about agents that didn't make the
  // top 5. Small-N runs caused real false-positives where rogues that received
  // 1 task each were dropped from the report and the analyzer assumed "data gap".
  const TOP_N_AGENTS = 25;
  const topByVolume = Object.entries(agentStats)
    .sort((a, b) => (b[1].sent + b[1].received) - (a[1].sent + a[1].received))
    .slice(0, TOP_N_AGENTS)
    .map(([id, s]) => ({ id, ...s }));

  // winRate = bake-off wins / total bake-offs entered.
  // (completed + outbid) is the number of bids the seller delivered for. We
  // ignore real failures in the denominator — those are platform issues, not
  // a fair signal of how often this seller's work gets picked.
  const topByCompletion = Object.entries(agentStats)
    .filter(([_, s]) => s.completed + s.outbid >= 1)
    .map(([id, s]) => {
      const bakeoffs = s.completed + s.outbid;
      const winRate = bakeoffs > 0 ? s.completed / bakeoffs : 0;
      return { id, ...s, rate: winRate };
    })
    .sort((a, b) => b.rate - a.rate)
    .slice(0, TOP_N_AGENTS);

  // ─── Per-style win-rate rollup ──────────────────────────────────────────
  // Infer style from sim agent name prefix. Non-sim agents are 'unknown'.
  const STYLE_BY_PREFIX: Record<string, string> = {
    'sim-HonestBot': 'honest',
    'sim-QualityReviewer': 'quality-reviewer',
    'sim-DisputeBot': 'rogue-disputer',
    'sim-WhaleBot': 'whale',
    'sim-BudgetBot': 'budget',
    'sim-SpecialistBot': 'specialist',
    'sim-NewcomerBot': 'newcomer',
    'sim-SpamBot': 'rogue-spam',
    'sim-MMBot': 'market-maker',
    'sim-ConservativeBot': 'conservative',
    'sim-OpportunistBot': 'opportunist',
    'sim-ResearchBot': 'researcher',
    'sim-ColluderBot': 'colluder',
  };
  function inferStyle(name: string): string {
    for (const [prefix, style] of Object.entries(STYLE_BY_PREFIX)) {
      if (name.startsWith(prefix)) return style;
    }
    return 'unknown';
  }
  type StyleRollup = { agents: number; received: number; wins: number; outbid: number; rejected: number; avgScore: number; winRate: number };
  const byStyleMap: Record<string, { agents: Set<string>; received: number; wins: number; outbid: number; rejected: number; totalScore: number; scoreCount: number }> = {};
  for (const [id, s] of Object.entries(agentStats)) {
    const style = inferStyle(s.name);
    if (!byStyleMap[style]) byStyleMap[style] = { agents: new Set(), received: 0, wins: 0, outbid: 0, rejected: 0, totalScore: 0, scoreCount: 0 };
    const entry = byStyleMap[style];
    entry.agents.add(id);
    entry.received += s.received;
    entry.wins += s.completed;
    entry.outbid += s.outbid;
    entry.rejected += s.rejected;
  }
  // Merge rating data into the style rollup
  // (ratings come from the viewer's snapshot — the report endpoint itself
  // doesn't have per-task scores, but we can compute from mandate metadata)
  const byStyle: Record<string, StyleRollup> = {};
  for (const [style, data] of Object.entries(byStyleMap)) {
    const contested = data.wins + data.outbid + data.rejected;
    byStyle[style] = {
      agents: data.agents.size,
      received: data.received,
      wins: data.wins,
      outbid: data.outbid,
      rejected: data.rejected,
      avgScore: 0, // computed client-side from ratings
      winRate: contested > 0 ? data.wins / contested : 0,
    };
  }

  // Pair analysis (top buyer-seller pairs)
  const pairCounts: Record<string, { count: number; from: string; to: string }> = {};
  for (const t of tasks) {
    if (t.client_agent_id && t.agent_id) {
      const key = t.client_agent_id + '|' + t.agent_id;
      if (!pairCounts[key]) pairCounts[key] = { count: 0, from: agentNames[t.client_agent_id] || '?', to: agentNames[t.agent_id] || '?' };
      pairCounts[key].count++;
    }
  }
  const topPairs = Object.values(pairCounts).sort((a, b) => b.count - a.count).slice(0, TOP_N_AGENTS);

  // Governance assessment — heuristic analysis
  const assessment: { category: string; status: 'pass' | 'warn' | 'fail'; finding: string }[] = [];

  // Check 1: Completion rate (excludes outbid bake-off losers)
  const excludeNote = intentionalNonCompletions > 0
    ? `, excluding ${outbidCount > 0 ? outbidCount + ' outbid' : ''}${outbidCount > 0 && rejectedCount > 0 ? ' + ' : ''}${rejectedCount > 0 ? rejectedCount + ' quality-rejected' : ''}`
    : '';
  const completionLabel = intentionalNonCompletions > 0
    ? `${effectiveCompletionRate}% of intended trades settled (${completed}/${effectiveTotal}${excludeNote})`
    : `${effectiveCompletionRate}% completion rate (${completed}/${effectiveTotal})`;
  if (effectiveTotal === 0) {
    // Pure bake-off cycle with all bids outbid except winners — already covered by Bidding line
    // Skip the throughput line entirely.
  } else if (effectiveCompletionRate >= 80) {
    assessment.push({ category: 'Throughput', status: 'pass', finding: `${completionLabel} — healthy` });
  } else if (effectiveCompletionRate >= 50) {
    assessment.push({ category: 'Throughput', status: 'warn', finding: `${completionLabel} — moderate` });
  } else {
    assessment.push({ category: 'Throughput', status: 'fail', finding: `${completionLabel} — low (${realFailed} platform failures)` });
  }

  // Check 1b: Bidding (info-only — competitive bake-offs are not failures)
  if (outbidCount > 0 || rejectedCount > 0) {
    const parts: string[] = [];
    if (outbidCount > 0) parts.push(`${outbidCount} outbid in bake-offs`);
    if (rejectedCount > 0) parts.push(`${rejectedCount} quality-rejected by buyer`);
    assessment.push({
      category: 'Bidding',
      status: 'pass',
      finding: `${parts.join(', ')} (intentional, not platform failures)`,
    });
  }

  // Check 2: Mandate creation + settlement
  // Cancelled mandates that were intentionally outbid don't count against settlement.
  const settleableMandates = Math.max(1, mandates.length - intentionalNonCompletions);
  if (mandates.length === 0) {
    assessment.push({ category: 'Settlement', status: 'fail', finding: 'No mandates created — settlement pipeline not engaged' });
  } else if (federationMandates.length === completedMandates.length && federationMandates.length > 0) {
    // All settlements went to external addresses via A2A federation
    assessment.push({
      category: 'Settlement',
      status: 'pass',
      finding: `A2A federation: $${federationVolume.toFixed(2)} routed to ${externalDestinations.size} external address${externalDestinations.size === 1 ? '' : 'es'}`,
    });
  } else if (completedMandates.length / settleableMandates >= 0.8) {
    const fedNote = federationVolume > 0 ? ` (incl. $${federationVolume.toFixed(2)} external)` : '';
    const intentionalParts: string[] = [];
    if (outbidCount > 0) intentionalParts.push(`${outbidCount} outbid`);
    if (rejectedCount > 0) intentionalParts.push(`${rejectedCount} rejected`);
    const outbidNote = intentionalParts.length > 0 ? `, ${intentionalParts.join(' + ')}` : '';
    assessment.push({
      category: 'Settlement',
      status: 'pass',
      finding: `${completedMandates.length}/${settleableMandates} settleable mandates settled${outbidNote}, $${totalVolume.toFixed(2)} volume${fedNote}`,
    });
  } else {
    assessment.push({
      category: 'Settlement',
      status: 'warn',
      finding: `${completedMandates.length}/${settleableMandates} mandates settled — ${activeMandates.length} still in escrow`,
    });
  }

  // Check 3: Escrow protection (disputes held funds)
  if (escrowedVolume > 0) assessment.push({ category: 'Escrow', status: 'pass', finding: `$${escrowedVolume.toFixed(2)} held in escrow — disputes protected` });

  // Check 4: Concentration / fairness
  const topAgent = topByVolume[0];
  if (topAgent && total > 0) {
    const topShare = (topAgent.sent + topAgent.received) / (total * 2);
    if (topShare > 0.4) assessment.push({ category: 'Concentration', status: 'warn', finding: `${topAgent.name} controls ${Math.round(topShare * 100)}% of activity — concentration risk` });
    else assessment.push({ category: 'Concentration', status: 'pass', finding: `Top agent ${topAgent.name} = ${Math.round(topShare * 100)}% of activity — diversified` });
  }

  // Check 5: Real failure analysis (outbid losers are excluded — they're a separate Bidding line)
  if (realFailed > 0 && effectiveTotal > 0) {
    const failRate = realFailed / effectiveTotal;
    if (failRate > 0.3) assessment.push({ category: 'Failures', status: 'warn', finding: `${realFailed} platform failures (${Math.round(failRate * 100)}% of intended trades) — investigate` });
    else assessment.push({ category: 'Failures', status: 'pass', finding: `${realFailed} platform failures (${Math.round(failRate * 100)}%) — within acceptable range` });
  }

  // Check 6: In-progress tasks
  if (working + inputRequired > 0) {
    assessment.push({ category: 'In-flight', status: 'warn', finding: `${working + inputRequired} tasks still in-flight at report time` });
  }

  // Check 7: Rogue containment (only when adversarial cycles actually ran)
  if (rogueMandates.length > 0) {
    const breakdown = `${rogueBuckets.rogueRejected} rejected · ${rogueBuckets.rogueSucceeded} succeeded · ${rogueBuckets.rogueDisputed} disputed · ${rogueBuckets.rogueDefeated} defeated`;
    if (containmentRate === null) {
      // All rogue cycles were rogueDefeated (rogue had to accept good work) —
      // platform never had to actively contain anything; that's a soft pass.
      assessment.push({
        category: 'Adversarial',
        status: 'pass',
        finding: `${rogueMandates.length} rogue cycles · all rogue buyers had to accept honest work (no containment needed)`,
      });
    } else if (containmentRate >= 80) {
      assessment.push({
        category: 'Adversarial',
        status: 'pass',
        finding: `Rogue containment ${containmentRate}% — ${breakdown}`,
      });
    } else if (containmentRate >= 50) {
      assessment.push({
        category: 'Adversarial',
        status: 'warn',
        finding: `Rogue containment ${containmentRate}% (target ≥80%) — ${breakdown}`,
      });
    } else {
      assessment.push({
        category: 'Adversarial',
        status: 'fail',
        finding: `Rogue containment ${containmentRate}% — too many bad outcomes accepted (${breakdown})`,
      });
    }
  }

  // Overall verdict
  const passCount = assessment.filter(a => a.status === 'pass').length;
  const failCount = assessment.filter(a => a.status === 'fail').length;
  const verdict = failCount === 0 && passCount >= assessment.length / 2
    ? 'Platform handled the scenario well — most checks passed'
    : failCount > 0
    ? 'Platform encountered failures — see findings'
    : 'Platform handled the scenario with caveats';

  return c.json({
    data: {
      windowMinutes: minutes,
      generatedAt: new Date().toISOString(),
      summary: {
        totalTasks: total,
        completed,
        failed,
        completionRate,
        // Outcome-aware metrics — separates intentional bake-off losses from real failures
        outbidCount,
        rejectedCount,
        realFailed,
        effectiveCompletionRate,
        totalMandates: mandates.length,
        completedMandates: completedMandates.length,
        totalVolume: Number(totalVolume.toFixed(2)),
        escrowedVolume: Number(escrowedVolume.toFixed(2)),
        uniqueAgents: Object.keys(agentStats).length,
        externalPayouts: Number(federationVolume.toFixed(2)),
        externalDestinations: externalDestinations.size,
        onChainSettlements: onChainSettlementCount,
      },
      externalPayoutsByAddress: Object.entries(externalPayoutsByAddress).map(([address, info]) => ({
        address,
        amount: Number(info.amount.toFixed(2)),
        count: info.count,
        txHashes: info.txHashes,
      })),
      topAgents: topByVolume,
      topReliability: topByCompletion,
      topPairs,
      byStyle,
      assessment,
      verdict,
      // Rogue / adversarial breakdown — only populated when the run included
      // rogue cycles tagged via mandate metadata. The LLM analyzer reads this
      // to surface containment metrics in plain language.
      rogue: rogueMandates.length > 0
        ? {
            totalRogueCycles: rogueMandates.length,
            buckets: rogueBuckets,
            containmentRate, // null when only rogueDefeated cycles ran
          }
        : null,
    },
  });
});

/**
 * POST /admin/round/reset
 * Clean up scenario-created tasks from the last N minutes.
 * Keeps the DB clean between demo rounds.
 */
roundViewerRouter.post('/reset', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const minutes = body?.minutes || 10;
  const cutoff = new Date(Date.now() - minutes * 60 * 1000).toISOString();
  const supabase = createClient();

  // Delete recent mandates first (FK to tasks via a2a_session_id)
  const { data: deletedMandates } = await supabase
    .from('ap2_mandates')
    .delete()
    .gte('created_at', cutoff)
    .select('mandate_id');

  // Delete recent tasks that were created by scenarios (no callback = scenario-created)
  const { data: deleted, error } = await supabase
    .from('a2a_tasks')
    .delete()
    .gte('created_at', cutoff)
    .is('callback_url', null)
    .select('id');

  const taskCount = deleted?.length || 0;
  const mandateCount = deletedMandates?.length || 0;

  // Clear the narration ring buffer so old comments don't leak into the
  // next round's report. The buffer is module-level (see top of file).
  narrationBuffer.length = 0;
  narrationEventId = 0;

  // Emit reset event
  taskEventBus.emit('task:all', {
    type: 'status' as const,
    taskId: 'reset:' + Date.now(),
    data: { state: 'commentary', text: `Reset: ${taskCount} tasks, ${mandateCount} mandates cleaned`, commentType: 'info' },
    timestamp: new Date().toISOString(),
  });

  return c.json({ data: { cleaned: taskCount, mandatesCleaned: mandateCount, error: error?.message || null } });
});

// ─── Marketplace-sim sidecar proxy ────────────────────────────────────────
//
// The real-mode scenarios live in `apps/marketplace-sim`, which runs as a
// separate Node process. The viewer talks to those scenarios through these
// proxy endpoints so the user gets one-button control without the API
// having to know how to drive the public A2A path itself.

const SIM_URL = process.env.SIM_URL || 'http://localhost:4500';
const SIM_SHARED_SECRET = process.env.SIM_SHARED_SECRET || '';

async function callSim(
  path: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  body?: unknown,
  opts: { timeoutMs?: number } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (SIM_SHARED_SECRET) headers['Authorization'] = `Bearer ${SIM_SHARED_SECRET}`;
  try {
    const res = await fetch(`${SIM_URL}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* keep as text */ }
    return { status: res.status, body: parsed };
  } catch (err: any) {
    return {
      status: 502,
      body: { error: `Cannot reach marketplace-sim at ${SIM_URL}: ${err?.message || err}` },
    };
  }
}

/**
 * GET /admin/round/sim/health
 * Pings the sim sidecar so the viewer can disable real-mode buttons when
 * the sim isn't running.
 */
roundViewerRouter.get('/sim/health', async (c) => {
  const r = await callSim('/health', 'GET');
  return c.json({ data: { reachable: r.status === 200, simUrl: SIM_URL, ...r.body } }, r.status as any);
});

/**
 * GET /admin/round/sim/scenarios
 * Lists scenarios advertised by the sim sidecar.
 */
roundViewerRouter.get('/sim/scenarios', async (c) => {
  const r = await callSim('/scenarios', 'GET');
  return c.json(r.body ?? { error: 'sim returned empty body' }, r.status as any);
});

/**
 * GET /admin/round/sim/status
 * Current run state from the sim sidecar.
 */
roundViewerRouter.get('/sim/status', async (c) => {
  const r = await callSim('/status', 'GET');
  return c.json(r.body ?? { error: 'sim returned empty body' }, r.status as any);
});

/**
 * POST /admin/round/sim/run
 * Starts a real-mode scenario via the sim sidecar.
 * Body: { scenarioId, mode?, durationMs?, personas? }
 */
roundViewerRouter.post('/sim/run', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const r = await callSim('/run', 'POST', body);
  return c.json(r.body ?? { error: 'sim returned empty body' }, r.status as any);
});

/**
 * GET /admin/round/task/:id
 * Returns full task detail (state, messages, artifacts, mandate, audit events,
 * feedback) for the live viewer's task drill-down. Service-role bypasses
 * tenant filtering so the admin viewer can inspect any task across all tenants.
 */
roundViewerRouter.get('/task/:id', async (c) => {
  const taskId = c.req.param('id');
  if (!UUID_RE.test(taskId)) return c.json({ error: 'Invalid task ID format' }, 400);
  const supabase = createClient();

  const [taskRes, messagesRes, artifactsRes, auditRes, feedbackRes] = await Promise.all([
    supabase.from('a2a_tasks').select('*').eq('id', taskId).maybeSingle(),
    supabase
      .from('a2a_messages')
      .select('id, role, parts, metadata, created_at')
      .eq('task_id', taskId)
      .order('created_at', { ascending: true }),
    supabase
      .from('a2a_artifacts')
      .select('id, label, mime_type, parts, metadata, created_at')
      .eq('task_id', taskId)
      .order('created_at', { ascending: true }),
    supabase
      .from('a2a_audit_events')
      .select('id, event_type, from_state, to_state, actor_type, actor_id, data, created_at')
      .eq('task_id', taskId)
      .order('created_at', { ascending: true })
      .limit(50),
    supabase
      .from('a2a_task_feedback')
      .select('id, action, score, satisfaction, comment, direction, caller_agent_id, provider_agent_id, created_at')
      .eq('task_id', taskId)
      .order('created_at', { ascending: true }),
  ]);

  const task = (taskRes as any).data;
  if (!task) return c.json({ error: 'Task not found' }, 404);

  // Resolve agent display names for buyer + seller
  const agentIds = [task.agent_id, task.client_agent_id].filter(Boolean) as string[];
  const agentNames: Record<string, string> = {};
  if (agentIds.length > 0) {
    const { data: agentRows } = await supabase.from('agents').select('id, name').in('id', agentIds);
    for (const a of (agentRows || []) as any[]) agentNames[a.id] = a.name;
  }

  // If a settlement mandate is linked, fetch its current state
  let mandate: any = null;
  const mandateId = (task.metadata as any)?.settlementMandateId
    || (task.metadata as any)?.input_required_context?.details?.mandate_id
    || null;
  if (mandateId) {
    const { data: m } = await supabase
      .from('ap2_mandates')
      .select('mandate_id, status, authorized_amount, used_amount, currency, created_at, updated_at, metadata')
      .eq('mandate_id', mandateId)
      .maybeSingle();
    if (m) mandate = m;
  }

  return c.json({
    data: {
      task,
      buyerName: task.client_agent_id ? (agentNames[task.client_agent_id] || null) : null,
      sellerName: task.agent_id ? (agentNames[task.agent_id] || null) : null,
      messages: (messagesRes as any).data || [],
      artifacts: (artifactsRes as any).data || [],
      auditEvents: (auditRes as any).data || [],
      feedback: (feedbackRes as any).data || [],
      mandate,
    },
  });
});

/**
 * POST /admin/round/sim/stop
 * Stops the currently-running real-mode scenario.
 */
roundViewerRouter.post('/sim/stop', async (c) => {
  const r = await callSim('/stop', 'POST');
  return c.json(r.body ?? { error: 'sim returned empty body' }, r.status as any);
});

/**
 * GET /admin/round/sim/agents
 * Lists the seeded agent pool from tokens.json.
 */
roundViewerRouter.get('/sim/agents', async (c) => {
  const r = await callSim('/agents', 'GET');
  return c.json(r.body ?? { error: 'sim returned empty body' }, r.status as any);
});

/**
 * POST /admin/round/sim/seed
 * Re-seeds the sim agent pool. Body: { honest, quality, rogue }.
 */
roundViewerRouter.post('/sim/seed', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const r = await callSim('/seed', 'POST', body);
  return c.json(r.body ?? { error: 'sim returned empty body' }, r.status as any);
});

/**
 * POST /admin/round/sim/analyze
 * Asks the sim sidecar to LLM-analyze a finished-round report. Bumped
 * timeout because the LLM call routinely takes 10-30s for sonnet/opus.
 * Body: { report, scenarioName?, pool?, model? }
 */
roundViewerRouter.post('/sim/analyze', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const r = await callSim('/analyze', 'POST', body, { timeoutMs: 90_000 });
  return c.json(r.body ?? { error: 'sim returned empty body' }, r.status as any);
});

// ─── Scenario template proxies ───────────────────────────────────────────
//
// Forward the viewer's CRUD calls to the sim sidecar's /templates endpoints.
// The sim sidecar owns the scenario_templates table; the API just relays.

roundViewerRouter.get('/sim/templates', async (c) => {
  const r = await callSim('/templates', 'GET');
  return c.json(r.body ?? { error: 'sim returned empty body' }, r.status as any);
});

roundViewerRouter.post('/sim/templates', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const r = await callSim('/templates', 'POST', body);
  return c.json(r.body ?? { error: 'sim returned empty body' }, r.status as any);
});

roundViewerRouter.post('/sim/templates/assist', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  // Bumped timeout: Opus can take 30-60s for complex scenario generation.
  const r = await callSim('/templates/assist', 'POST', body, { timeoutMs: 120_000 });
  return c.json(r.body ?? { error: 'sim returned empty body' }, r.status as any);
});

roundViewerRouter.get('/sim/templates/:id', async (c) => {
  const id = c.req.param('id');
  const r = await callSim(`/templates/${encodeURIComponent(id)}`, 'GET');
  return c.json(r.body ?? { error: 'sim returned empty body' }, r.status as any);
});

roundViewerRouter.put('/sim/templates/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const r = await callSim(`/templates/${encodeURIComponent(id)}`, 'PUT', body);
  return c.json(r.body ?? { error: 'sim returned empty body' }, r.status as any);
});

roundViewerRouter.delete('/sim/templates/:id', async (c) => {
  const id = c.req.param('id');
  const r = await callSim(`/templates/${encodeURIComponent(id)}`, 'DELETE');
  return c.json(r.body ?? { error: 'sim returned empty body' }, r.status as any);
});

roundViewerRouter.post('/sim/templates/:id/reset', async (c) => {
  const id = c.req.param('id');
  const r = await callSim(`/templates/${encodeURIComponent(id)}/reset`, 'POST');
  return c.json(r.body ?? { error: 'sim returned empty body' }, r.status as any);
});

roundViewerRouter.post('/sim/templates/:id/compile', async (c) => {
  const id = c.req.param('id');
  // Bumped timeout because Phase B will swap this with an LLM call.
  const r = await callSim(`/templates/${encodeURIComponent(id)}/compile`, 'POST', undefined, { timeoutMs: 90_000 });
  return c.json(r.body ?? { error: 'sim returned empty body' }, r.status as any);
});

// ─── Run history + batch proxies ────────────────────────────────────────

roundViewerRouter.get('/sim/runs', async (c) => {
  const r = await callSim('/runs', 'GET');
  return c.json(r.body ?? { error: 'sim returned empty body' }, r.status as any);
});

roundViewerRouter.get('/sim/runs/:id', async (c) => {
  const id = c.req.param('id');
  const r = await callSim(`/runs/${encodeURIComponent(id)}`, 'GET');
  return c.json(r.body ?? { error: 'sim returned empty body' }, r.status as any);
});

roundViewerRouter.post('/sim/runs/:id/analyze', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const r = await callSim(`/runs/${encodeURIComponent(id)}/analyze`, 'POST', body, { timeoutMs: 120_000 });
  return c.json(r.body ?? { error: 'sim returned empty body' }, r.status as any);
});

roundViewerRouter.post('/sim/run-all', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  // Very long timeout — run-all can take 30-60 min for 21 scenarios
  const r = await callSim('/run-all', 'POST', body, { timeoutMs: 10_000 });
  return c.json(r.body ?? { error: 'sim returned empty body' }, r.status as any);
});

export { roundViewerRouter };
