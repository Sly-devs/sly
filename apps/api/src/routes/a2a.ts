/**
 * A2A (Agent-to-Agent) Protocol Routes
 *
 * Google A2A protocol implementation for Sly agents.
 * Provides agent card discovery, JSON-RPC task handling,
 * and management endpoints.
 *
 * @see Epic 57: Google A2A Protocol Integration
 * @see https://google.github.io/A2A/
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { createClient } from '../db/client.js';
import { generateAgentCard, getBaseUrlFromRequest } from '../services/a2a/agent-card.js';
import { A2ATaskService } from '../services/a2a/task-service.js';
import { handleJsonRpc } from '../services/a2a/jsonrpc-handler.js';
import { handleGatewayJsonRpc, type GatewayAuthContext } from '../services/a2a/gateway-handler.js';
import { A2AWebhookHandler } from '../services/a2a/webhook-handler.js';
import { taskEventBus } from '../services/a2a/task-event-bus.js';
import type { A2AJsonRpcRequest, A2APart, A2ATaskState, A2AConfiguration } from '../services/a2a/types.js';
import { normalizeParts } from '../services/a2a/types.js';
import { verifyApiKey } from '../utils/crypto.js';
import { getEnv } from '../utils/helpers.js';
import { trackOp } from '../services/ops/track-op.js';
import { OpType } from '../services/ops/operation-types.js';
import { validateProcessingConfig } from '../utils/processing-config-validation.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Derive the public base URL from the incoming request. */
function getBaseUrl(c: any): string {
  return getBaseUrlFromRequest(c);
}

// =============================================================================
// Shared Helpers
// =============================================================================

/** Fetch agent + account + wallet and generate an A2A Agent Card. */
async function fetchAgentCard(agentId: string, tenantId?: string, baseUrl?: string) {
  const supabase = createClient();

  let query = supabase
    .from('agents')
    .select('id, name, description, status, kya_tier, permissions, parent_account_id')
    .eq('id', agentId);
  if (tenantId) query = query.eq('tenant_id', tenantId);

  const { data: agent, error: agentError } = await query.single();
  if (agentError || !agent) return { error: 'Agent not found' as const, status: 404 as const };
  if (agent.status !== 'active') return { error: 'Agent is not active' as const, status: 404 as const };

  let accountQuery = supabase
    .from('accounts')
    .select('id, name')
    .eq('id', agent.parent_account_id);
  if (tenantId) accountQuery = accountQuery.eq('tenant_id', tenantId);
  const { data: account } = await accountQuery.single();

  let walletQuery = supabase
    .from('wallets')
    .select('id, currency')
    .eq('managed_by_agent_id', agentId)
    .limit(1);
  if (tenantId) walletQuery = walletQuery.eq('tenant_id', tenantId);
  const { data: wallet } = await walletQuery.maybeSingle();

  // Fetch DB-registered skills for this agent
  let skillsQuery = supabase
    .from('agent_skills')
    .select('skill_id, name, description, input_modes, output_modes, tags, input_schema, base_price, currency')
    .eq('agent_id', agentId)
    .eq('status', 'active')
    .order('created_at');
  if (tenantId) skillsQuery = skillsQuery.eq('tenant_id', tenantId);
  const { data: dbSkills } = await skillsQuery;

  const card = generateAgentCard(
    agent as any,
    account || { id: agent.parent_account_id, name: 'Unknown' },
    wallet,
    baseUrl,
    dbSkills || [],
  );

  return { card };
}

/** Return a raw A2A Agent Card response with proper headers. */
function agentCardResponse(card: object) {
  return new Response(JSON.stringify(card), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*',
      'A2A-Version': '1.0',
    },
  });
}

/** CORS preflight response for GET endpoints. */
function corsPreflightGet() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    },
  });
}

// =============================================================================
// Public Routes (no auth — discovery must be frictionless)
// =============================================================================

export const a2aPublicRouter = new Hono();

/**
 * GET /a2a/agents/:agentId/card
 * Public per-agent Agent Card (no auth required).
 */
a2aPublicRouter.get('/agents/:agentId/card', async (c) => {
  const agentId = c.req.param('agentId');
  if (!UUID_RE.test(agentId)) return c.json({ error: 'Invalid agent ID format' }, 400);

  const result = await fetchAgentCard(agentId, undefined, getBaseUrl(c));
  if ('error' in result) return c.json({ error: result.error }, result.status);

  // Note: public discovery routes skip trackOp — no tenant context,
  // and 'public' is not a valid UUID for the tenant_id FK.

  return agentCardResponse(result.card);
});

/**
 * OPTIONS /a2a/agents/:agentId/card
 * CORS preflight for agent card discovery.
 */
a2aPublicRouter.options('/agents/:agentId/card', () => corsPreflightGet());

/**
 * GET /a2a/:agentId/.well-known/agent.json
 * Spec-compliant per-agent discovery (Layer 2).
 */
a2aPublicRouter.get('/:agentId/.well-known/agent.json', async (c) => {
  const agentId = c.req.param('agentId');
  if (!UUID_RE.test(agentId)) return c.json({ error: 'Invalid agent ID format' }, 400);

  const result = await fetchAgentCard(agentId, undefined, getBaseUrl(c));
  if ('error' in result) return c.json({ error: result.error }, result.status);

  return agentCardResponse(result.card);
});

/**
 * OPTIONS /a2a/:agentId/.well-known/agent.json
 * CORS preflight for spec-compliant discovery.
 */
a2aPublicRouter.options('/:agentId/.well-known/agent.json', () => corsPreflightGet());

/**
 * POST /a2a
 * Platform gateway JSON-RPC endpoint (Layer 1).
 * Handles agent discovery via find_agent / list_agents skills.
 * Auth is optional — discovery skills remain public, onboarding skills require auth.
 */
a2aPublicRouter.post('/', async (c) => {
  const jsonRpc = (body: Record<string, unknown>, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        'Content-Type': 'application/json',
        'A2A-Version': '1.0',
        'Access-Control-Allow-Origin': '*',
      },
    });

  let rpcRequest: A2AJsonRpcRequest;
  try {
    rpcRequest = await c.req.json();
  } catch {
    return jsonRpc({
      jsonrpc: '2.0',
      error: { code: -32700, message: 'Parse error' },
      id: null,
    }, 400);
  }

  if (rpcRequest.jsonrpc !== '2.0' || !rpcRequest.method || !rpcRequest.id) {
    return jsonRpc({
      jsonrpc: '2.0',
      error: { code: -32600, message: 'Invalid JSON-RPC request' },
      id: rpcRequest?.id ?? null,
    }, 400);
  }

  // Optional auth extraction — onboarding skills need it, discovery skills don't
  let authContext: GatewayAuthContext | undefined;
  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const supabaseAuth = createClient();

    if (token.startsWith('pk_')) {
      const prefix = token.slice(0, 12);
      const { data: apiKey } = await (supabaseAuth.from('api_keys') as any)
        .select('id, tenant_id, key_hash')
        .eq('key_prefix', prefix)
        .single();
      if (apiKey && apiKey.key_hash && verifyApiKey(token, apiKey.key_hash)) {
        authContext = { tenantId: apiKey.tenant_id, authType: 'api_key', apiKeyId: apiKey.id };
      }
    } else if (token.startsWith('agent_')) {
      const prefix = token.slice(0, 12);
      const { data: agentRow } = await (supabaseAuth.from('agents') as any)
        .select('id, tenant_id, auth_token_hash')
        .eq('auth_token_prefix', prefix)
        .single();
      if (agentRow && agentRow.auth_token_hash && verifyApiKey(token, agentRow.auth_token_hash)) {
        authContext = { tenantId: agentRow.tenant_id, authType: 'agent', agentId: agentRow.id };
      }
    }
  }

  const supabase = createClient();
  const rpcResponse = await handleGatewayJsonRpc(rpcRequest, supabase, getBaseUrl(c), authContext);
  return jsonRpc(rpcResponse as Record<string, unknown>);
});

/**
 * OPTIONS /a2a
 * CORS preflight for platform gateway.
 */
a2aPublicRouter.options('/', () => {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    },
  });
});

/**
 * POST /a2a/:agentId
 * JSON-RPC 2.0 endpoint for A2A tasks (inbound).
 *
 * Auth: Sly API key or agent token via Authorization header.
 * External bearer token support planned for federation.
 */
a2aPublicRouter.post('/:agentId', async (c) => {
  const agentId = c.req.param('agentId');

  // Helper: return raw JSON-RPC (bypasses response wrapper for A2A interop)
  const jsonRpc = (body: Record<string, unknown>, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        'Content-Type': 'application/json',
        'A2A-Version': '1.0',
        'Access-Control-Allow-Origin': '*',
      },
    });

  if (!UUID_RE.test(agentId)) {
    return jsonRpc({
      jsonrpc: '2.0',
      error: { code: -32602, message: 'Invalid agent ID format' },
      id: null,
    }, 400);
  }

  // ---- Auth: try Sly API key / agent token (prefix lookup + hash verification) ----
  //
  // Auth model for POST /a2a/:agentId:
  //   - No Authorization header at all        → anonymous caller, proceed
  //     (matches x402-style "payment is auth" for external clients)
  //   - Valid Bearer token (pk_* or agent_*)  → authenticated, set callerAgentId
  //   - Invalid/malformed Bearer token        → 401 reject (do NOT silently fall through)
  //
  // The "silently accept failed auth as anonymous" behavior that shipped earlier
  // was masking token corruption and bypassing cross-tenant charging. Strict
  // rejection on a present-but-invalid token is the standard HTTP pattern.
  const authHeader = c.req.header('Authorization');
  let tenantId: string | null = null;
  let callerAgentId: string | undefined;

  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const supabase = createClient();

    if (token.startsWith('pk_')) {
      // API key auth — prefix lookup + hash verification
      const prefix = token.slice(0, 12);
      const { data: apiKey } = await (supabase.from('api_keys') as any)
        .select('tenant_id, key_hash')
        .eq('key_prefix', prefix)
        .single();
      if (apiKey && apiKey.key_hash && verifyApiKey(token, apiKey.key_hash)) {
        tenantId = apiKey.tenant_id;
      }
    } else if (token.startsWith('agent_')) {
      // Agent token auth — prefix lookup + hash verification
      const prefix = token.slice(0, 12);
      const { data: agentRow } = await (supabase.from('agents') as any)
        .select('id, tenant_id, auth_token_hash')
        .eq('auth_token_prefix', prefix)
        .single();
      if (agentRow && agentRow.auth_token_hash && verifyApiKey(token, agentRow.auth_token_hash)) {
        tenantId = agentRow.tenant_id;
        callerAgentId = agentRow.id;
      }
    }

    // A token was provided but failed verification → reject with 401.
    // This is the "don't silently accept bad tokens" fix.
    if (!tenantId && !callerAgentId) {
      return jsonRpc({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Invalid or expired credential' },
        id: null,
      }, 401);
    }
  }

  // Always resolve target agent's tenant — tasks must be created in the provider's tenant
  // even when the caller authenticates with their own token (cross-tenant support).
  {
    const supabase = createClient();
    const { data: targetAgent } = await supabase
      .from('agents')
      .select('tenant_id, status')
      .eq('id', agentId)
      .single();

    if (!targetAgent || targetAgent.status !== 'active') {
      return jsonRpc({
        jsonrpc: '2.0',
        error: { code: -32002, message: 'Agent not found or inactive' },
        id: null,
      }, 404);
    }

    // Always use the target agent's tenant for task creation and skill validation
    tenantId = targetAgent.tenant_id;
  }

  // Parse JSON-RPC request
  let rpcRequest: A2AJsonRpcRequest;
  try {
    rpcRequest = await c.req.json();
  } catch {
    return jsonRpc({
      jsonrpc: '2.0',
      error: { code: -32700, message: 'Parse error' },
      id: null,
    }, 400);
  }

  // Validate JSON-RPC envelope
  if (rpcRequest.jsonrpc !== '2.0' || !rpcRequest.method || !rpcRequest.id) {
    return jsonRpc({
      jsonrpc: '2.0',
      error: { code: -32600, message: 'Invalid JSON-RPC request' },
      id: rpcRequest?.id ?? null,
    }, 400);
  }

  // Resolve callerAgentId from message metadata when using API key auth
  if (!callerAgentId && (rpcRequest.method === 'message/send' || rpcRequest.method === 'message/stream')) {
    const msgMeta = (rpcRequest.params as any)?.message?.metadata;
    const metaAgentId = msgMeta?.callerAgentId as string | undefined;
    if (metaAgentId && UUID_RE.test(metaAgentId)) {
      const supabaseCheck = createClient();
      const { data: callerAgent } = await supabaseCheck
        .from('agents')
        .select('id, tenant_id')
        .eq('id', metaAgentId)
        .eq('tenant_id', tenantId)
        .single();
      if (callerAgent) {
        callerAgentId = callerAgent.id;
      }
    }
  }

  // Reject self-targeting (agent sending task to itself)
  if (callerAgentId && callerAgentId === agentId && rpcRequest.method === 'message/send') {
    return jsonRpc({
      jsonrpc: '2.0',
      error: { code: -32600, message: 'Agent cannot send tasks to itself' },
      id: rpcRequest.id,
    }, 400);
  }

  // ---- SSE streaming for message/stream ----
  if (rpcRequest.method === 'message/stream') {
    return handleMessageStream(c, rpcRequest, agentId, tenantId);
  }

  // Dispatch to JSON-RPC handler
  const supabase = createClient();
  const taskService = new A2ATaskService(supabase, tenantId);
  const rpcResponse = await handleJsonRpc(rpcRequest, agentId, taskService, supabase, tenantId || undefined, callerAgentId);

  // Track A2A task operations
  if (tenantId && (rpcRequest.method === 'message/send' || rpcRequest.method === 'message/stream')) {
    const rpcResult = rpcResponse as any;
    const resultTaskId = rpcResult?.result?.id || rpcResult?.result?.taskId;
    trackOp({
      tenantId,
      operation: OpType.A2A_TASK_SENT,
      subject: `a2a/task/${resultTaskId || agentId}`,
      actorType: callerAgentId ? 'agent' : 'api_key',
      actorId: callerAgentId || 'external',
      correlationId: c.get('requestId'),
      success: !rpcResult?.error,
    });
  }

  return jsonRpc(rpcResponse as Record<string, unknown>);
});

/**
 * OPTIONS /a2a/:agentId
 * CORS preflight for JSON-RPC endpoint.
 */
a2aPublicRouter.options('/:agentId', (c) => {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    },
  });
});

// =============================================================================
// Webhook Callback Receiver (Agent Forwarding)
// =============================================================================

/**
 * POST /a2a/:agentId/callback
 * Agents POST task results back to Sly after processing a forwarded task.
 * Verifies HMAC signature if endpoint_secret is configured.
 * Updates the a2a_tasks row and triggers completion webhook to original caller.
 */
a2aPublicRouter.post('/:agentId/callback', async (c) => {
  const agentId = c.req.param('agentId');

  if (!UUID_RE.test(agentId)) {
    return c.json({ error: 'Invalid agent ID format' }, 400);
  }

  const supabase = createClient();

  // Look up the agent and its endpoint secret
  const { data: agent, error: agentError } = await supabase
    .from('agents')
    .select('id, tenant_id, endpoint_secret, endpoint_enabled')
    .eq('id', agentId)
    .single();

  if (agentError || !agent) {
    return c.json({ error: 'Agent not found' }, 404);
  }

  // Verify HMAC signature if secret is configured
  if (agent.endpoint_secret) {
    const signatureHeader = c.req.header('X-Sly-Signature');
    if (!signatureHeader) {
      return c.json({ error: 'Missing X-Sly-Signature header' }, 401);
    }

    const rawBody = await c.req.text();

    // Parse signature: "t=timestamp,v1=signature"
    const parts = signatureHeader.split(',');
    const timestampPart = parts.find((p: string) => p.startsWith('t='));
    const sigPart = parts.find((p: string) => p.startsWith('v1='));

    if (!timestampPart || !sigPart) {
      return c.json({ error: 'Invalid signature format' }, 401);
    }

    const timestamp = timestampPart.slice(2);
    const providedSig = sigPart.slice(3);

    // Verify timestamp is within 5 minutes
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - parseInt(timestamp)) > 300) {
      return c.json({ error: 'Signature timestamp expired' }, 401);
    }

    // Compute expected signature
    const { createHmac } = await import('crypto');
    const payloadString = `${timestamp}.${rawBody}`;
    const expectedSig = createHmac('sha256', agent.endpoint_secret)
      .update(payloadString)
      .digest('hex');

    // Constant-time comparison
    const { timingSafeEqual } = await import('crypto');
    const a = Buffer.from(providedSig, 'hex');
    const b = Buffer.from(expectedSig, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return c.json({ error: 'Invalid signature' }, 401);
    }

    // Re-parse body from raw text (since we consumed it for signature verification)
    var body = JSON.parse(rawBody);
  } else {
    var body = await c.req.json();
  }

  const taskId = body.taskId || body.task_id;
  if (!taskId || !UUID_RE.test(taskId)) {
    return c.json({ error: 'taskId is required' }, 400);
  }

  const newState = body.state || body.status;
  if (!newState || !['completed', 'failed'].includes(newState)) {
    return c.json({ error: 'state must be "completed" or "failed"' }, 400);
  }

  // Verify the task belongs to this agent and tenant
  const { data: task, error: taskError } = await supabase
    .from('a2a_tasks')
    .select('id, state, tenant_id, callback_url, callback_secret')
    .eq('id', taskId)
    .eq('agent_id', agentId)
    .eq('tenant_id', agent.tenant_id)
    .single();

  if (taskError || !task) {
    return c.json({ error: 'Task not found for this agent' }, 404);
  }

  const taskService = new A2ATaskService(supabase, agent.tenant_id);

  // Add agent's response message if provided
  if (body.message?.parts?.length) {
    await taskService.addMessage(taskId, 'agent', normalizeParts(body.message.parts), body.message.metadata);
  } else if (body.result) {
    // Accept a simple text/data result
    const parts: A2APart[] = typeof body.result === 'string'
      ? [{ text: body.result }]
      : [{ data: body.result, metadata: { mimeType: 'application/json' } }];
    await taskService.addMessage(taskId, 'agent', parts);
  }

  // Add artifacts if provided
  if (body.artifacts?.length) {
    for (const artifact of body.artifacts) {
      if (artifact.parts?.length) {
        await taskService.addArtifact(taskId, {
          name: artifact.name,
          mediaType: artifact.mediaType,
          parts: normalizeParts(artifact.parts),
          metadata: artifact.metadata,
        });
      }
    }
  }

  // Read task metadata BEFORE state transition (needed for gate check)
  const { data: taskWithMeta } = await supabase
    .from('a2a_tasks')
    .select('metadata')
    .eq('id', taskId)
    .eq('tenant_id', agent.tenant_id)
    .single();
  const taskMetadata = (taskWithMeta as any)?.metadata || {};

  // Check acceptance gate for completed tasks with settlement mandates
  if (taskMetadata.settlementMandateId && newState === 'completed') {
    const { A2ATaskProcessor } = await import('../services/a2a/task-processor.js');
    const processor = new A2ATaskProcessor(supabase, agent.tenant_id);
    const gateEngaged = await processor.checkAcceptanceGate(
      taskId,
      taskMetadata.settlementMandateId,
      'completed',
    );
    if (gateEngaged) {
      // Gate engaged — task is now input-required, skip settlement
      const updated = await taskService.getTask(taskId);
      return c.json({ ok: true, taskId, state: 'input-required', acceptance_review: true, task: updated });
    }
  }

  // Transition task state
  await taskService.updateTaskState(taskId, newState, body.statusMessage || `Agent ${newState}`);

  // Resolve settlement mandate if one exists (no gate or failed state)
  if (taskMetadata.settlementMandateId) {
    const { A2ATaskProcessor } = await import('../services/a2a/task-processor.js');
    const processor = new A2ATaskProcessor(supabase, agent.tenant_id);
    await processor.resolveSettlementMandate(
      taskId,
      taskMetadata.settlementMandateId,
      newState === 'completed' ? 'completed' : 'failed',
    );
  }

  // Trigger completion webhook to original caller if callback_url is set
  if ((task as any).callback_url) {
    const webhookHandler = new A2AWebhookHandler(supabase);
    const deliveryId = crypto.randomUUID();
    try {
      const result = await webhookHandler.dispatch(
        { id: taskId, tenant_id: agent.tenant_id, agent_id: agentId, state: newState, context_id: null },
        { callbackUrl: (task as any).callback_url, callbackSecret: (task as any).callback_secret },
        deliveryId,
      );
      if (result.success) {
        await webhookHandler.recordSuccess(taskId, result);
      }
    } catch (err: any) {
      console.error(`[A2A Callback] Failed to notify original caller for task ${taskId.slice(0, 8)}:`, err.message);
    }
  }

  console.log(`[A2A Callback] Agent ${agentId.slice(0, 8)} reported task ${taskId.slice(0, 8)} as ${newState}`);

  trackOp({
    tenantId: agent.tenant_id,
    operation: OpType.A2A_TASK_STATE_CHANGED,
    subject: `a2a/task/${taskId}`,
    actorType: 'agent',
    actorId: agentId,
    correlationId: c.get('requestId'),
    success: true,
    data: { toState: newState, source: 'callback' },
  });

  return c.json({ data: { taskId, state: newState, received: true } });
});

/**
 * OPTIONS /a2a/:agentId/callback
 * CORS preflight for callback endpoint.
 */
a2aPublicRouter.options('/:agentId/callback', () => {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Sly-Signature',
      'Access-Control-Max-Age': '86400',
    },
  });
});

// =============================================================================
// SSE Streaming Handler (Story 58.13)
// =============================================================================

const TERMINAL_STATES = new Set(['completed', 'failed', 'canceled', 'rejected']);
const SSE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const HEARTBEAT_INTERVAL_MS = 30 * 1000; // 30 seconds

/**
 * Handle `message/stream` JSON-RPC method.
 * Creates/resumes a task (same logic as message/send), then returns an SSE
 * stream that forwards lifecycle events from the TaskEventBus.
 */
async function handleMessageStream(
  c: any,
  rpcRequest: A2AJsonRpcRequest,
  agentId: string,
  tenantId: string,
) {
  const params = rpcRequest.params || {};
  const message = params.message as { role?: string; parts?: A2APart[]; metadata?: Record<string, unknown> } | undefined;

  if (!message?.parts?.length) {
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32602, message: 'message.parts is required and must not be empty' },
        id: rpcRequest.id,
      }),
      { status: 400, headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0' } },
    );
  }

  const role = (message.role === 'agent' ? 'agent' : 'user') as 'user' | 'agent';
  const contextId = params.contextId as string | undefined;
  const taskId = params.id as string | undefined;
  const configuration = params.configuration as A2AConfiguration | undefined;
  const callbackUrl = configuration?.callbackUrl;
  const callbackSecret = configuration?.callbackSecret;

  const supabase = createClient();
  const taskService = new A2ATaskService(supabase, tenantId);

  // Resolve or create the task (mirrors message/send logic)
  let task: any;
  try {
    if (taskId) {
      const existing = await taskService.getTask(taskId, configuration?.historyLength);
      if (!existing) {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32001, message: `Task not found: ${taskId}` },
            id: rpcRequest.id,
          }),
          { status: 404, headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0' } },
        );
      }
      if (['completed', 'failed', 'canceled'].includes(existing.status.state)) {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32602, message: `Cannot stream task in state: ${existing.status.state}` },
            id: rpcRequest.id,
          }),
          { status: 400, headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0' } },
        );
      }
      await taskService.addMessage(taskId, role, message.parts, message.metadata);
      if (existing.status.state === 'input-required') {
        await taskService.updateTaskState(taskId, 'working', 'Processing new input');
      }
      task = await taskService.getTask(taskId, configuration?.historyLength);
    } else if (contextId) {
      const existing = await taskService.findTaskByContext(agentId, contextId, callerAgentId);
      if (existing && !TERMINAL_STATES.has(existing.status.state)) {
        await taskService.addMessage(existing.id, role, message.parts, message.metadata);
        if (existing.status.state === 'input-required') {
          await taskService.updateTaskState(existing.id, 'working', 'Processing new input');
        }
        task = await taskService.getTask(existing.id, configuration?.historyLength);
      } else {
        task = await taskService.createTask(agentId, { role, parts: message.parts, metadata: message.metadata }, contextId, 'inbound', undefined, undefined, callbackUrl, callbackSecret);
      }
    } else {
      task = await taskService.createTask(agentId, { role, parts: message.parts, metadata: message.metadata }, undefined, 'inbound', undefined, undefined, callbackUrl, callbackSecret);
    }
  } catch (err: any) {
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32603, message: err.message || 'Internal error' },
        id: rpcRequest.id,
      }),
      { status: 500, headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0' } },
    );
  }

  const streamTaskId = task.id;

  // Set SSE-specific headers
  c.header('X-Accel-Buffering', 'no');
  c.header('A2A-Version', '1.0');

  return streamSSE(c, async (stream) => {
    let isActive = true;

    // Send initial status event
    await stream.writeSSE({
      event: 'status',
      data: JSON.stringify({
        taskId: streamTaskId,
        state: task.status.state,
        statusMessage: task.status.message || null,
        timestamp: new Date().toISOString(),
      }),
    });

    // If the task is already in a terminal state, close immediately
    if (TERMINAL_STATES.has(task.status.state)) {
      return;
    }

    // Subscribe to task events
    const unsubscribe = taskEventBus.subscribe(streamTaskId, async (event) => {
      if (!isActive) return;
      try {
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify({
            taskId: event.taskId,
            ...event.data,
            timestamp: event.timestamp,
          }),
        });

        // Close stream on terminal state
        if (event.type === 'status' && TERMINAL_STATES.has(event.data.state as string)) {
          isActive = false;
          cleanup();
        }
      } catch {
        // Stream probably closed by client
        isActive = false;
        cleanup();
      }
    });

    // Heartbeat to keep connection alive
    const heartbeatId = setInterval(async () => {
      if (!isActive) {
        clearInterval(heartbeatId);
        return;
      }
      try {
        await stream.writeSSE({
          event: 'heartbeat',
          data: JSON.stringify({ timestamp: new Date().toISOString() }),
        });
      } catch {
        isActive = false;
        cleanup();
      }
    }, HEARTBEAT_INTERVAL_MS);

    // Safety timeout — 5 minutes max
    const timeoutId = setTimeout(async () => {
      if (!isActive) return;
      try {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({
            taskId: streamTaskId,
            message: 'Stream timeout: 5 minute limit reached',
            timestamp: new Date().toISOString(),
          }),
        });
      } catch {
        // ignore
      }
      isActive = false;
      cleanup();
    }, SSE_TIMEOUT_MS);

    function cleanup() {
      unsubscribe();
      clearInterval(heartbeatId);
      clearTimeout(timeoutId);
    }

    // Handle client disconnect
    stream.onAbort(() => {
      isActive = false;
      cleanup();
    });

    // Keep the stream alive until closed
    await new Promise(() => {});
  });
}

// =============================================================================
// Authenticated Management Routes (mounted under /v1/a2a)
// =============================================================================

export const a2aRouter = new Hono();

/**
 * GET /v1/a2a/agents/:agentId/card
 * Per-agent card (authenticated, for dashboard use).
 */
a2aRouter.get('/agents/:agentId/card', async (c) => {
  const ctx = c.get('ctx');
  const agentId = c.req.param('agentId');
  if (!UUID_RE.test(agentId)) return c.json({ error: 'Invalid agent ID format' }, 400);

  const result = await fetchAgentCard(agentId, ctx.tenantId, getBaseUrl(c));
  if ('error' in result) return c.json({ error: result.error }, result.status);

  trackOp({
    tenantId: ctx.tenantId,
    operation: OpType.A2A_AGENT_DISCOVERED,
    subject: `a2a/agent/${agentId}/card`,
    actorType: ctx.actorType,
    actorId: ctx.actorId || ctx.userId || ctx.apiKeyId,
    correlationId: c.get('requestId'),
    success: true,
  });

  return c.json({ data: result.card });
});

/**
 * GET /v1/a2a/agents/:agentId/config
 * Get agent processing configuration.
 */
a2aRouter.get('/agents/:agentId/config', async (c) => {
  const ctx = c.get('ctx');
  const agentId = c.req.param('agentId');
  if (!UUID_RE.test(agentId)) return c.json({ error: 'Invalid agent ID format' }, 400);

  const supabase = createClient();
  const { data: agent, error } = await supabase
    .from('agents')
    .select('processing_mode, processing_config')
    .eq('id', agentId)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();

  if (error || !agent) {
    return c.json({ error: 'Agent not found' }, 404);
  }

  // Only return processing_mode to the agent itself (self-query).
  // Other callers see a generic config response without internal architecture details.
  const isSelf = ctx.actorType === 'agent' && ctx.actorId === agentId;
  return c.json({
    ...(isSelf ? { processingMode: (agent as any).processing_mode || 'managed' } : {}),
    processingConfig: isSelf ? ((agent as any).processing_config || {}) : {},
  });
});

/**
 * PUT /v1/a2a/agents/:agentId/config
 * Update agent processing configuration.
 */
a2aRouter.put('/agents/:agentId/config', async (c) => {
  const ctx = c.get('ctx');
  const agentId = c.req.param('agentId');
  if (!UUID_RE.test(agentId)) return c.json({ error: 'Invalid agent ID format' }, 400);

  let body: Record<string, any>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid request body' }, 400);
  }

  // Normalize snake_case or camelCase
  const processingMode = body.processing_mode || body.processingMode;
  const processingConfig = body.processing_config || body.processingConfig || {};

  // Validate processing mode + config via shared helper
  if (!processingMode) {
    return c.json({ error: 'processing_mode must be one of: managed, webhook, manual' }, 400);
  }
  const configResult = validateProcessingConfig(processingMode, processingConfig);
  if (!configResult.valid) {
    return c.json({ error: configResult.error }, 400);
  }

  const supabase = createClient();

  // Verify agent exists and belongs to tenant
  const { data: existing, error: fetchError } = await supabase
    .from('agents')
    .select('id')
    .eq('id', agentId)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();

  if (fetchError || !existing) {
    return c.json({ error: 'Agent not found' }, 404);
  }

  // Update
  const { error: updateError } = await supabase
    .from('agents')
    .update({
      processing_mode: processingMode,
      processing_config: processingConfig,
    })
    .eq('id', agentId)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx));

  if (updateError) {
    return c.json({ error: `Failed to update config: ${updateError.message}` }, 500);
  }

  return c.json({
    processingMode,
    processingConfig,
  });
});

/**
 * POST /v1/a2a/discover
 * Discover a remote A2A agent by URL.
 */
a2aRouter.post('/discover', async (c) => {
  let body: { url: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid request body' }, 400);
  }

  if (!body.url) {
    return c.json({ error: 'url is required' }, 400);
  }

  const ctx = c.get('ctx');
  try {
    const { A2AClient } = await import('../services/a2a/client.js');
    const client = new A2AClient();
    const card = await client.discover(body.url);

    trackOp({
      tenantId: ctx.tenantId,
      operation: OpType.A2A_AGENT_DISCOVERED,
      subject: `a2a/discover/${encodeURIComponent(body.url)}`,
      actorType: ctx.actorType,
      actorId: ctx.actorId || ctx.userId || ctx.apiKeyId,
      correlationId: c.get('requestId'),
      success: true,
      data: { remoteUrl: body.url },
    });

    return c.json({ data: card });
  } catch (error: any) {
    trackOp({
      tenantId: ctx.tenantId,
      operation: OpType.A2A_AGENT_DISCOVERED,
      subject: `a2a/discover/${encodeURIComponent(body.url)}`,
      actorType: ctx.actorType,
      actorId: ctx.actorId || ctx.userId || ctx.apiKeyId,
      correlationId: c.get('requestId'),
      success: false,
      data: { remoteUrl: body.url, error: error.message },
    });

    return c.json({ error: `Discovery failed: ${error.message}` }, 502);
  }
});

/**
 * POST /v1/a2a/tasks
 * Send task to a remote or local A2A agent (outbound).
 */
a2aRouter.post('/tasks', async (c) => {
  const ctx = c.get('ctx');
  let raw: Record<string, any>;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid request body' }, 400);
  }

  // Normalize snake_case → camelCase (MCP server sends snake_case)
  const body = {
    agentId: raw.agentId || raw.agent_id,
    remoteUrl: raw.remoteUrl || raw.remote_url,
    message: raw.message as { parts: A2APart[] },
    contextId: raw.contextId || raw.context_id,
    metadata: raw.metadata as Record<string, unknown> | undefined,
    callbackUrl: raw.callbackUrl || raw.callback_url,
    callbackSecret: raw.callbackSecret || raw.callback_secret,
  };

  if (!body.message?.parts?.length) {
    return c.json({ error: 'message.parts is required' }, 400);
  }

  const supabase = createClient();
  const taskService = new A2ATaskService(supabase, ctx.tenantId, getEnv(ctx) as 'test' | 'live');

  if (body.remoteUrl) {
    // Outbound: send to remote agent
    const { A2AClient } = await import('../services/a2a/client.js');
    const client = new A2AClient();
    try {
      const result = await client.sendMessage(body.remoteUrl, body.message, body.contextId);

      // Store outbound task locally for tracking
      const task = await taskService.createTask(
        body.agentId || ctx.actorId || 'unknown',
        body.message,
        body.contextId,
        'outbound',
        body.remoteUrl,
        result?.result?.id,
      );

      trackOp({
        tenantId: ctx.tenantId,
        operation: OpType.A2A_TASK_SENT,
        subject: `a2a/task/${task.id}`,
        actorType: ctx.actorType,
        actorId: ctx.actorId || ctx.userId || ctx.apiKeyId,
        correlationId: c.get('requestId'),
        success: true,
        data: { direction: 'outbound', remoteUrl: body.remoteUrl },
      });

      return c.json({ data: task });
    } catch (error: any) {
      return c.json({ error: `Failed to send task: ${error.message}` }, 502);
    }
  }

  // Local: create inbound task
  if (!body.agentId) {
    return c.json({ error: 'agentId is required for local tasks' }, 400);
  }

  const task = await taskService.createTask(
    body.agentId,
    body.message,
    body.contextId,
    'inbound',
    undefined,
    undefined,
    body.callbackUrl,
    body.callbackSecret,
  );

  trackOp({
    tenantId: ctx.tenantId,
    operation: OpType.A2A_TASK_SENT,
    subject: `a2a/task/${task.id}`,
    actorType: ctx.actorType,
    actorId: ctx.actorId || ctx.userId || ctx.apiKeyId,
    correlationId: c.get('requestId'),
    success: true,
    data: { direction: 'inbound', agentId: body.agentId },
  });

  return c.json({ data: task });
});

/**
 * GET /v1/a2a/tasks
 * List A2A tasks (inbound + outbound) for the tenant.
 */
a2aRouter.get('/tasks', async (c) => {
  const ctx = c.get('ctx');
  const agentId = c.req.query('agent_id');
  const callerAgentId = c.req.query('caller_agent_id');
  const state = c.req.query('state');
  const direction = c.req.query('direction') as 'inbound' | 'outbound' | undefined;
  const contextId = c.req.query('context_id');
  const page = parseInt(c.req.query('page') || '1');
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 100);

  const supabase = createClient();
  const taskService = new A2ATaskService(supabase, ctx.tenantId, getEnv(ctx) as 'test' | 'live');

  const result = await taskService.listTasks({
    agentId,
    callerAgentId,
    state: state as any,
    direction,
    contextId,
    page,
    limit,
    // Ownership scoping: when caller is an agent, only show tasks they're involved in
    scopeToAgentId: ctx.actorType === 'agent' ? ctx.actorId : undefined,
  });

  return c.json(result);
});

/**
 * GET /v1/a2a/tasks/dlq
 * List dead-letter-queue tasks (webhook delivery permanently failed).
 * Must be registered BEFORE /tasks/:taskId to avoid param capture.
 */
a2aRouter.get('/tasks/dlq', async (c) => {
  const ctx = c.get('ctx');
  const page = parseInt(c.req.query('page') || '1');
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 100);
  const offset = (page - 1) * limit;

  const supabase = createClient();

  const { data: tasks, count, error } = await supabase
    .from('a2a_tasks')
    .select('id, agent_id, webhook_attempts, webhook_dlq_at, webhook_dlq_reason, webhook_last_response_code, created_at, agents!inner(name)', { count: 'exact' })
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .eq('webhook_status', 'dlq')
    .order('webhook_dlq_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    return c.json({ error: `Failed to fetch DLQ tasks: ${error.message}` }, 500);
  }

  const dlqTasks = (tasks || []).map((t: any) => ({
    id: t.id,
    agentId: t.agent_id,
    agentName: t.agents?.name || null,
    webhookAttempts: t.webhook_attempts,
    lastResponseCode: t.webhook_last_response_code,
    dlqAt: t.webhook_dlq_at,
    dlqReason: t.webhook_dlq_reason,
    createdAt: t.created_at,
  }));

  return c.json({
    data: dlqTasks,
    pagination: {
      page,
      limit,
      total: count || 0,
      totalPages: Math.ceil((count || 0) / limit),
    },
  });
});

/**
 * PATCH /v1/a2a/tasks/:taskId
 * External state update for webhook-mode tasks.
 * Allows the external agent to report back task completion/failure.
 */
a2aRouter.patch('/tasks/:taskId', async (c) => {
  const ctx = c.get('ctx');
  const taskId = c.req.param('taskId');

  if (!UUID_RE.test(taskId)) {
    return c.json({ error: 'Invalid task ID format' }, 400);
  }

  let body: Record<string, any>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid request body' }, 400);
  }

  const newState = body.state as A2ATaskState;
  if (!newState) {
    return c.json({ error: 'state is required' }, 400);
  }

  const supabase = createClient();

  // Fetch current task
  const { data: task, error: fetchError } = await supabase
    .from('a2a_tasks')
    .select('id, state, tenant_id')
    .eq('id', taskId)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();

  if (fetchError || !task) {
    return c.json({ error: 'Task not found' }, 404);
  }

  // Validate state transition
  const currentState = (task as any).state as string;
  const validTransitions: Record<string, string[]> = {
    'working': ['completed', 'failed', 'input-required'],
    'input-required': ['working', 'completed', 'failed'],
  };

  const allowed = validTransitions[currentState];
  if (!allowed || !allowed.includes(newState)) {
    return c.json({
      error: `Invalid state transition: ${currentState} → ${newState}. ` +
        `Allowed transitions from '${currentState}': ${allowed ? allowed.join(', ') : 'none'}`,
    }, 400);
  }

  const taskService = new A2ATaskService(supabase, ctx.tenantId, getEnv(ctx) as 'test' | 'live');

  // Add message if provided
  if (body.message?.parts?.length) {
    await taskService.addMessage(
      taskId,
      body.message.role || 'agent',
      normalizeParts(body.message.parts),
      body.message.metadata,
    );
  }

  // Add artifacts if provided
  if (body.artifacts?.length) {
    for (const artifact of body.artifacts) {
      if (artifact.parts?.length) {
        await taskService.addArtifact(taskId, {
          name: artifact.name,
          mediaType: artifact.mediaType,
          parts: normalizeParts(artifact.parts),
          metadata: artifact.metadata,
        });
      }
    }
  }

  // Update state
  const updated = await taskService.updateTaskState(
    taskId,
    newState,
    body.statusMessage,
  );

  if (!updated) {
    return c.json({ error: 'Failed to update task state' }, 500);
  }

  trackOp({
    tenantId: ctx.tenantId,
    operation: OpType.A2A_TASK_STATE_CHANGED,
    subject: `a2a/task/${taskId}`,
    actorType: ctx.actorType,
    actorId: ctx.actorId || ctx.userId || ctx.apiKeyId,
    correlationId: c.get('requestId'),
    success: true,
    data: { fromState: currentState, toState: newState },
  });

  return c.json({ data: updated });
});

/**
 * POST /v1/a2a/tasks/:taskId/retry
 * Retry a DLQ'd task. Resets to 'submitted' so the worker re-dispatches.
 */
a2aRouter.post('/tasks/:taskId/retry', async (c) => {
  const ctx = c.get('ctx');
  const taskId = c.req.param('taskId');

  if (!UUID_RE.test(taskId)) {
    return c.json({ error: 'Invalid task ID format' }, 400);
  }

  const supabase = createClient();
  const webhookHandler = new A2AWebhookHandler(supabase);

  const success = await webhookHandler.retryFromDlq(taskId, ctx.tenantId);

  if (!success) {
    return c.json({ error: 'Task not found in DLQ or retry failed' }, 404);
  }

  return c.json({ data: { id: taskId, state: 'submitted', message: 'Task requeued for retry' } });
});

/**
 * GET /v1/a2a/tasks/:taskId
 * Get a specific A2A task with messages and artifacts.
 */
a2aRouter.get('/tasks/:taskId', async (c) => {
  const ctx = c.get('ctx');
  const taskId = c.req.param('taskId');

  if (!UUID_RE.test(taskId)) {
    return c.json({ error: 'Invalid task ID format' }, 400);
  }

  const supabase = createClient();
  const taskService = new A2ATaskService(supabase, ctx.tenantId, getEnv(ctx) as 'test' | 'live');

  const task = await taskService.getTask(taskId);

  if (!task) {
    return c.json({ error: 'Task not found' }, 404);
  }

  return c.json({ data: task });
});

/**
 * POST /v1/a2a/tasks/:taskId/respond
 * Respond to an escalated (input-required) task.
 * Used by humans or dashboards to provide input that unblocks the agent.
 * (Story 58.6: Human-in-the-Loop Escalation)
 */
a2aRouter.post('/tasks/:taskId/respond', async (c) => {
  const ctx = c.get('ctx');
  const taskId = c.req.param('taskId');

  if (!UUID_RE.test(taskId)) {
    return c.json({ error: 'Invalid task ID format' }, 400);
  }

  let body: Record<string, any>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid request body' }, 400);
  }

  const supabase = createClient();

  // Verify task exists and is in input-required state
  const { data: task, error: fetchError } = await supabase
    .from('a2a_tasks')
    .select('id, state, tenant_id, metadata, agent_id, client_agent_id')
    .eq('id', taskId)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();

  if (fetchError || !task) {
    return c.json({ error: 'Task not found' }, 404);
  }

  if ((task as any).state !== 'input-required') {
    return c.json({
      error: `Task is in '${(task as any).state}' state. Only 'input-required' tasks can be responded to.`,
    }, 400);
  }

  const taskService = new A2ATaskService(supabase, ctx.tenantId, getEnv(ctx) as 'test' | 'live');
  const taskMeta = (task as any).metadata || {};
  const inputContext = taskMeta.input_required_context;

  // --- Epic 69: Result Review Branch ---
  if (inputContext?.reason_code === 'result_review') {
    const action = body.action;
    if (!action || !['accept', 'reject'].includes(action)) {
      return c.json({ error: 'action must be "accept" or "reject" for result review' }, 400);
    }

    const mandateId = inputContext.details?.mandate_id || taskMeta.settlementMandateId;
    if (!mandateId) {
      return c.json({ error: 'No settlement mandate found for this task' }, 500);
    }

    // Parse optional feedback
    const satisfaction = body.satisfaction;
    const score = body.score;
    const comment = body.comment;
    const settlementAmount = body.settlement_amount;

    // Validate feedback fields
    if (satisfaction && !['excellent', 'acceptable', 'partial', 'unacceptable'].includes(satisfaction)) {
      return c.json({ error: 'satisfaction must be excellent, acceptable, partial, or unacceptable' }, 400);
    }
    if (score !== undefined && score !== null && (typeof score !== 'number' || score < 0 || score > 100)) {
      return c.json({ error: 'score must be a number between 0 and 100' }, 400);
    }

    const { A2ATaskProcessor } = await import('../services/a2a/task-processor.js');
    const processor = new A2ATaskProcessor(supabase, ctx.tenantId);

    // Handle partial settlement
    let overrideAmount: number | undefined;
    if (action === 'accept' && settlementAmount !== undefined && settlementAmount !== null) {
      // Read mandate to validate amount
      const { data: mandate } = await supabase
        .from('ap2_mandates')
        .select('authorized_amount, metadata')
        .eq('mandate_id', mandateId)
        .eq('tenant_id', ctx.tenantId)
        .eq('environment', getEnv(ctx))
        .single();

      if (!mandate) {
        return c.json({ error: 'Mandate not found' }, 404);
      }

      const originalAmount = Number(mandate.authorized_amount);
      if (typeof settlementAmount !== 'number' || settlementAmount <= 0 || settlementAmount > originalAmount) {
        return c.json({ error: `settlement_amount must be between 0 and ${originalAmount}` }, 400);
      }

      // Check if provider skill allows partial settlement
      const skillId = taskMeta.skillId;
      if (skillId) {
        const { data: skill } = await supabase
          .from('agent_skills')
          .select('metadata')
          .eq('agent_id', (task as any).agent_id)
          .eq('skill_id', skillId)
          .eq('tenant_id', ctx.tenantId)
          .maybeSingle();

        if (!skill?.metadata?.allows_partial_settlement) {
          return c.json({ error: 'Provider skill does not allow partial settlement' }, 400);
        }
      }

      overrideAmount = settlementAmount;
    }

    // Resolve mandate
    if (action === 'accept') {
      await processor.resolveSettlementMandate(taskId, mandateId, 'completed', overrideAmount);
      await taskService.updateTaskState(taskId, 'completed', 'Accepted by caller');
    } else {
      await processor.resolveSettlementMandate(taskId, mandateId, 'failed');
      await taskService.updateTaskState(taskId, 'failed', 'Rejected by caller');
    }

    // Store feedback if provided
    const originalAmount = inputContext.details?.amount;
    if (satisfaction || score !== undefined || comment) {
      await supabase.from('a2a_task_feedback').insert({
        tenant_id: ctx.tenantId,
        environment: getEnv(ctx),
        task_id: taskId,
        caller_agent_id: (task as any).client_agent_id,
        provider_agent_id: (task as any).agent_id,
        skill_id: taskMeta.skillId || null,
        action,
        satisfaction: satisfaction || null,
        score: score ?? null,
        comment: comment || null,
        mandate_id: mandateId,
        original_amount: originalAmount ?? null,
        settlement_amount: overrideAmount ?? originalAmount ?? null,
        currency: 'USDC',
      });

      // Emit feedback audit event
      const { taskEventBus: feedbackBus } = await import('../services/a2a/task-event-bus.js');
      const auditActorType = (ctx.actorType === 'api_key' ? 'user' : ctx.actorType) as 'system' | 'agent' | 'user' | 'worker';
      feedbackBus.emitTask(taskId, {
        type: 'feedback',
        taskId,
        data: { satisfaction, score, comment, action },
        timestamp: new Date().toISOString(),
      }, {
        tenantId: ctx.tenantId,
        agentId: (task as any).agent_id,
        actorType: auditActorType,
      });
    }

    // Emit acceptance audit event (enriched with mandate context)
    const { taskEventBus } = await import('../services/a2a/task-event-bus.js');
    const acceptActorType = (ctx.actorType === 'api_key' ? 'user' : ctx.actorType) as 'system' | 'agent' | 'user' | 'worker';
    taskEventBus.emitTask(taskId, {
      type: 'acceptance',
      taskId,
      data: {
        action,
        satisfaction,
        score,
        comment,
        mandateId,
        originalAmount,
        settlementAmount: overrideAmount ?? originalAmount,
        partial: overrideAmount !== undefined,
      },
      timestamp: new Date().toISOString(),
    }, {
      tenantId: ctx.tenantId,
      agentId: (task as any).agent_id,
      actorType: acceptActorType,
    });

    const updated = await taskService.getTask(taskId);
    return c.json({ data: updated });
  }

  // --- Standard input-required flow (non-review) ---

  // Validate response body — accept multiple formats:
  // { parts: [...] }, { message: { parts: [...] } }, { message: "text" }, { text: "text" }
  let parts = body.parts || body.message?.parts;
  if (!parts?.length) {
    const plainText = typeof body.message === 'string' ? body.message : body.text;
    if (plainText) {
      parts = [{ text: plainText }];
    } else {
      return c.json({ error: 'message.parts, parts, message (string), or text is required' }, 400);
    }
  }

  // Add the human response as a user message
  await taskService.addMessage(
    taskId,
    'user',
    normalizeParts(parts),
    body.metadata || body.message?.metadata,
  );

  // Transition back to working
  await taskService.updateTaskState(taskId, 'working', 'Human response received, resuming processing');

  const updated = await taskService.getTask(taskId);
  return c.json({ data: updated });
});

/**
 * POST /v1/a2a/tasks/:taskId/complete
 * Complete a working task with a response message.
 * Used by autonomous agents (local processes) to post their AI-generated responses.
 * Accepts: { message: "response text" } or { parts: [{ text: "..." }] }
 */
a2aRouter.post('/tasks/:taskId/complete', async (c) => {
  const ctx = c.get('ctx');
  const taskId = c.req.param('taskId');

  if (!UUID_RE.test(taskId)) {
    return c.json({ error: 'Invalid task ID format' }, 400);
  }

  let body: Record<string, any>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid request body' }, 400);
  }

  const supabase = createClient();

  // Verify task exists, belongs to caller's tenant, and is in working state
  const { data: task, error: fetchError } = await supabase
    .from('a2a_tasks')
    .select('id, state, tenant_id, agent_id')
    .eq('id', taskId)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();

  if (fetchError || !task) {
    return c.json({ error: 'Task not found' }, 404);
  }

  if ((task as any).state !== 'working') {
    return c.json({
      error: `Task is in '${(task as any).state}' state. Only 'working' tasks can be completed.`,
    }, 400);
  }

  // Authorization: agent can only complete tasks assigned to them
  if (ctx.actorType === 'agent' && ctx.actorId !== (task as any).agent_id) {
    return c.json({ error: 'Agent can only complete tasks assigned to them' }, 403);
  }

  // Extract response text
  let responseText: string | undefined;
  if (typeof body.message === 'string') {
    responseText = body.message;
  } else if (body.text) {
    responseText = body.text;
  } else if (body.parts?.[0]?.text) {
    responseText = body.parts[0].text;
  }

  if (!responseText) {
    return c.json({ error: 'message (string), text, or parts[].text is required' }, 400);
  }

  const taskService = new A2ATaskService(supabase, (task as any).tenant_id, getEnv(ctx) as 'test' | 'live');

  // Add the agent's response message
  await taskService.addMessage(taskId, 'agent', [{ text: responseText }]);

  // Complete the task
  await taskService.updateTaskState(taskId, 'completed', 'Completed by autonomous agent');

  trackOp({
    tenantId: ctx.tenantId,
    operation: OpType.A2A_TASK_STATE_CHANGED,
    subject: `a2a/task/${taskId}`,
    actorType: ctx.actorType,
    actorId: ctx.actorId || ctx.userId || ctx.apiKeyId,
    correlationId: c.get('requestId'),
    success: true,
    data: { toState: 'completed', source: 'autonomous_agent' },
  });

  const updated = await taskService.getTask(taskId);
  return c.json({ data: updated });
});

/**
 * POST /v1/a2a/tasks/:taskId/cancel
 * Cancel an A2A task.
 */
a2aRouter.post('/tasks/:taskId/cancel', async (c) => {
  const ctx = c.get('ctx');
  const taskId = c.req.param('taskId');

  if (!UUID_RE.test(taskId)) {
    return c.json({ error: 'Invalid task ID format' }, 400);
  }

  const supabase = createClient();
  const taskService = new A2ATaskService(supabase, ctx.tenantId, getEnv(ctx) as 'test' | 'live');

  const task = await taskService.cancelTask(taskId);

  if (!task) {
    return c.json({ error: 'Task not found' }, 404);
  }

  trackOp({
    tenantId: ctx.tenantId,
    operation: OpType.A2A_TASK_STATE_CHANGED,
    subject: `a2a/task/${taskId}`,
    actorType: ctx.actorType,
    actorId: ctx.actorId || ctx.userId || ctx.apiKeyId,
    correlationId: c.get('requestId'),
    success: true,
    data: { toState: 'canceled' },
  });

  return c.json({ data: task });
});

/**
 * POST /v1/a2a/tasks/:taskId/process
 * Manually trigger processing of a submitted task.
 * Demonstrates the full lifecycle: submitted → working → completed.
 */
a2aRouter.post('/tasks/:taskId/process', async (c) => {
  const ctx = c.get('ctx');
  const taskId = c.req.param('taskId');

  if (!UUID_RE.test(taskId)) {
    return c.json({ error: 'Invalid task ID format' }, 400);
  }

  const supabase = createClient();
  const { A2ATaskProcessor } = await import('../services/a2a/task-processor.js');
  const processor = new A2ATaskProcessor(supabase, ctx.tenantId);

  const result = await processor.processTask(taskId);

  if (!result) {
    return c.json({ error: 'Task not found' }, 404);
  }

  return c.json({ data: result });
});

/**
 * POST /v1/a2a/process
 * Process all submitted tasks (batch). Optionally filter by agentId.
 */
a2aRouter.post('/process', async (c) => {
  const ctx = c.get('ctx');
  let body: Record<string, any> = {};
  try { body = await c.req.json(); } catch { /* empty body ok */ }

  const agentId = body.agentId || body.agent_id;
  const paymentThreshold = body.paymentThreshold || body.payment_threshold || 500;

  const supabase = createClient();
  const { A2ATaskProcessor } = await import('../services/a2a/task-processor.js');
  const processor = new A2ATaskProcessor(supabase, ctx.tenantId, {
    agentId,
    paymentThreshold,
  });

  // Find and process all submitted tasks
  const { data: tasks } = await supabase
    .from('a2a_tasks')
    .select('id')
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .eq('state', 'submitted')
    .eq('direction', 'inbound')
    .order('created_at', { ascending: true })
    .limit(20);

  if (!tasks?.length) {
    return c.json({ data: { processed: 0, message: 'No submitted tasks found' } });
  }

  const results = [];
  for (const row of tasks) {
    if (agentId) {
      const { data: task } = await supabase
        .from('a2a_tasks')
        .select('agent_id')
        .eq('id', row.id)
        .eq('environment', getEnv(ctx))
        .single();
      if (task?.agent_id !== agentId) continue;
    }
    const result = await processor.processTask(row.id);
    if (result) results.push({ id: result.id, state: result.status.state });
  }

  return c.json({ data: { processed: results.length, tasks: results } });
});

/**
 * GET /v1/a2a/stats
 * Get A2A task statistics for the tenant.
 */
a2aRouter.get('/stats', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();

  // Get task counts by state and direction
  const { data: tasks, error } = await supabase
    .from('a2a_tasks')
    .select('id, state, direction, transfer_id')
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx));

  if (error) {
    return c.json({ error: `Failed to fetch stats: ${error.message}` }, 500);
  }

  const rows = tasks || [];
  const activeStates = ['submitted', 'working', 'input-required'];
  const transferIds = rows
    .map((r: any) => r.transfer_id)
    .filter(Boolean) as string[];

  let totalCost = 0;
  const curCounts = new Map<string, number>();
  if (transferIds.length > 0) {
    const { data: transfers } = await supabase
      .from('transfers')
      .select('amount, currency')
      .in('id', transferIds)
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx));
    totalCost = (transfers || []).reduce((sum: number, t: any) => sum + (Number(t.amount) || 0), 0);
    for (const t of transfers || []) {
      if (t.currency) curCounts.set(t.currency, (curCounts.get(t.currency) || 0) + 1);
    }
  }

  // Also sum costs from payment audit events (for tasks without transfer_id)
  const tasksWithoutTransfer = rows.filter((r: any) => !r.transfer_id).map((r: any) => r.id);
  if (tasksWithoutTransfer.length > 0) {
    const { data: paymentEvents } = await supabase
      .from('a2a_audit_events')
      .select('task_id, data')
      .in('task_id', tasksWithoutTransfer.slice(0, 500))
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .eq('event_type', 'payment')
      .limit(10000);
    for (const e of paymentEvents || []) {
      const d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
      if (d?.amount && d?.currency) {
        totalCost += Number(d.amount) || 0;
        curCounts.set(d.currency, (curCounts.get(d.currency) || 0) + 1);
      }
    }
  }

  const totalCostCurrency = curCounts.size > 0
    ? [...curCounts.entries()].sort((a, b) => b[1] - a[1])[0][0]
    : 'USDC';

  return c.json({
    data: {
      total: rows.length,
      active: rows.filter((r: any) => activeStates.includes(r.state)).length,
      completed: rows.filter((r: any) => r.state === 'completed').length,
      inbound: rows.filter((r: any) => r.direction === 'inbound').length,
      outbound: rows.filter((r: any) => r.direction === 'outbound').length,
      totalCost,
      totalCostCurrency,
      transferCount: transferIds.length,
    },
  });
});

/**
 * GET /v1/a2a/sessions/:contextId
 * Get the full conversation for a session — all tasks, messages, and artifacts chronologically.
 */
a2aRouter.get('/sessions/:contextId', async (c) => {
  const ctx = c.get('ctx');
  const contextId = c.req.param('contextId');
  const supabase = createClient();

  // 1. Fetch all tasks in this session, joined with agent names
  const { data: taskRows, error: taskError } = await supabase
    .from('a2a_tasks')
    .select('id, state, direction, agent_id, transfer_id, client_agent_id, created_at, updated_at, agents!inner(name)')
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .eq('context_id', contextId)
    .order('created_at', { ascending: true });

  if (taskError) {
    return c.json({ error: `Failed to fetch session: ${taskError.message}` }, 500);
  }

  if (!taskRows?.length) {
    return c.json({ error: 'Session not found' }, 404);
  }

  const taskIds = taskRows.map((r: any) => r.id);

  // 2. Batch-fetch messages, artifacts, transfers, and audit events in parallel
  const [messagesResult, artifactsResult, transfersResult, eventsResult] = await Promise.all([
    supabase
      .from('a2a_messages')
      .select('id, task_id, role, parts, created_at')
      .in('task_id', taskIds)
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .order('created_at', { ascending: true })
      .limit(10000),
    supabase
      .from('a2a_artifacts')
      .select('id, task_id, label, mime_type, parts, created_at')
      .in('task_id', taskIds)
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .order('created_at', { ascending: true })
      .limit(10000),
    (() => {
      const transferIds = taskRows.map((r: any) => r.transfer_id).filter(Boolean) as string[];
      if (transferIds.length === 0) return Promise.resolve({ data: [] });
      return supabase
        .from('transfers')
        .select('id, amount, currency')
        .in('id', transferIds)
        .eq('tenant_id', ctx.tenantId)
        .eq('environment', getEnv(ctx));
    })(),
    supabase
      .from('a2a_audit_events')
      .select('id, task_id, event_type, from_state, to_state, actor_type, actor_id, data, duration_ms, created_at')
      .in('task_id', taskIds)
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .order('created_at', { ascending: true })
      .limit(10000),
  ]);

  const messages = messagesResult.data || [];
  const artifacts = artifactsResult.data || [];
  const transfers = transfersResult.data || [];
  const auditEvents = eventsResult.data || [];

  // Build transfer amount + currency maps
  const transferAmounts = new Map<string, number>();
  const transferCurrencies = new Map<string, string>();
  for (const t of transfers) {
    transferAmounts.set(t.id, Number(t.amount) || 0);
    if (t.currency) transferCurrencies.set(t.id, t.currency);
  }

  // Resolve caller agent names (client_agent_id is VARCHAR, not FK — batch lookup)
  const callerAgentIds = [...new Set(
    taskRows.map((r: any) => r.client_agent_id).filter(Boolean)
  )] as string[];
  const callerNameMap = new Map<string, string>();
  if (callerAgentIds.length > 0) {
    const { data: callerAgents } = await supabase
      .from('agents')
      .select('id, name')
      .in('id', callerAgentIds)
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx));
    for (const a of callerAgents || []) {
      callerNameMap.set(a.id, a.name);
    }
  }

  // 3. Build response
  const tasks = taskRows.map((r: any) => ({
    id: r.id,
    state: r.state,
    direction: r.direction,
    agentId: r.agent_id,
    agentName: r.agents?.name || null,
    clientAgentId: r.client_agent_id || null,
    clientAgentName: callerNameMap.get(r.client_agent_id) || null,
    transferId: r.transfer_id || undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));

  const messageList = messages.map((m: any) => ({
    messageId: m.id,
    taskId: m.task_id,
    role: m.role,
    parts: normalizeParts(m.parts),
    createdAt: m.created_at,
  }));

  const artifactList = artifacts.map((a: any) => ({
    artifactId: a.id,
    taskId: a.task_id,
    name: a.label || undefined,
    parts: normalizeParts(a.parts),
    createdAt: a.created_at,
  }));

  const eventList = auditEvents.map((e: any) => ({
    eventId: e.id,
    taskId: e.task_id,
    eventType: e.event_type,
    fromState: e.from_state,
    toState: e.to_state,
    actorType: e.actor_type,
    data: e.data,
    durationMs: e.duration_ms,
    createdAt: e.created_at,
  }));

  // 4. Compute summary (with currency detection)
  // Extract cost from payment audit events (for tasks where transfer_id is not set on the task row)
  const auditPaymentsByTask = new Map<string, { amount: number; currency: string }>();
  for (const e of auditEvents as any[]) {
    if (e.event_type === 'payment' && e.data) {
      const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
      if (data.amount && data.currency) {
        const existing = auditPaymentsByTask.get(e.task_id);
        auditPaymentsByTask.set(e.task_id, {
          amount: (existing?.amount || 0) + (Number(data.amount) || 0),
          currency: data.currency,
        });
      }
    }
  }

  const totalCost = taskRows.reduce((sum: number, r: any) => {
    if (r.transfer_id) return sum + (transferAmounts.get(r.transfer_id) || 0);
    const auditPay = auditPaymentsByTask.get(r.id);
    return sum + (auditPay?.amount || 0);
  }, 0);
  // Determine dominant currency from transfers + audit payment events
  const currencyCounts = new Map<string, number>();
  for (const r of taskRows as any[]) {
    if (r.transfer_id) {
      const cur = transferCurrencies.get(r.transfer_id);
      if (cur) currencyCounts.set(cur, (currencyCounts.get(cur) || 0) + 1);
    } else {
      const auditPay = auditPaymentsByTask.get(r.id);
      if (auditPay?.currency) currencyCounts.set(auditPay.currency, (currencyCounts.get(auditPay.currency) || 0) + 1);
    }
  }
  const totalCostCurrency = currencyCounts.size > 0
    ? [...currencyCounts.entries()].sort((a, b) => b[1] - a[1])[0][0]
    : 'USDC';

  const allTimestamps = [
    ...messages.map((m: any) => m.created_at),
    ...artifacts.map((a: any) => a.created_at),
    ...auditEvents.map((e: any) => e.created_at),
    ...taskRows.map((r: any) => r.created_at),
  ].filter(Boolean).sort();

  // 5. Build unique agents list (both callers and callees)
  const agentMap = new Map<string, { id: string; name: string | null; role: 'provider' | 'caller' }>();
  for (const r of taskRows as any[]) {
    if (r.agent_id && !agentMap.has(r.agent_id)) {
      agentMap.set(r.agent_id, { id: r.agent_id, name: r.agents?.name || null, role: 'provider' });
    }
    if (r.client_agent_id && !agentMap.has(r.client_agent_id)) {
      agentMap.set(r.client_agent_id, { id: r.client_agent_id, name: callerNameMap.get(r.client_agent_id) || null, role: 'caller' });
    }
  }

  return c.json({
    contextId,
    agents: Array.from(agentMap.values()),
    tasks,
    messages: messageList,
    artifacts: artifactList,
    events: eventList,
    summary: {
      taskCount: taskRows.length,
      messageCount: messages.length,
      eventCount: auditEvents.length,
      totalCost,
      totalCostCurrency,
      firstActivity: allTimestamps[0] || null,
      lastActivity: allTimestamps[allTimestamps.length - 1] || null,
    },
  });
});

/**
 * GET /v1/a2a/sessions
 * List A2A sessions grouped by context_id.
 */
a2aRouter.get('/sessions', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();

  // Fetch all tasks with a non-null context_id
  const { data: tasks, error } = await supabase
    .from('a2a_tasks')
    .select('id, context_id, state, direction, agent_id, client_agent_id, transfer_id, created_at, updated_at, agents!inner(name)')
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .not('context_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(10000);

  if (error) {
    return c.json({ error: `Failed to fetch sessions: ${error.message}` }, 500);
  }

  const rows = tasks || [];

  // Group by context_id
  const sessionMap = new Map<string, any[]>();
  for (const row of rows) {
    const cid = (row as any).context_id;
    if (!sessionMap.has(cid)) sessionMap.set(cid, []);
    sessionMap.get(cid)!.push(row);
  }

  // Batch fetch transfer amounts for all linked transfers
  // Chunk .in() to avoid PostgREST URL length limits with many IDs
  const allTransferIds = rows
    .map((r: any) => r.transfer_id)
    .filter(Boolean) as string[];
  const transferAmounts = new Map<string, number>();
  const transferCurrencies = new Map<string, string>();
  if (allTransferIds.length > 0) {
    const T_CHUNK = 100;
    const tChunks: string[][] = [];
    for (let i = 0; i < allTransferIds.length; i += T_CHUNK) {
      tChunks.push(allTransferIds.slice(i, i + T_CHUNK));
    }
    const tResults = await Promise.all(
      tChunks.map(chunk =>
        supabase
          .from('transfers')
          .select('id, amount, currency')
          .in('id', chunk)
          .eq('tenant_id', ctx.tenantId)
          .eq('environment', getEnv(ctx))
      )
    );
    for (const { data: transfers } of tResults) {
      for (const t of transfers || []) {
        transferAmounts.set(t.id, Number(t.amount) || 0);
        if (t.currency) transferCurrencies.set(t.id, t.currency);
      }
    }
  }

  // Batch fetch message counts for all tasks
  // Note: .in() sends UUIDs as URL query params — with many tasks this exceeds
  // PostgREST's URL length limit (~8KB). Chunk into batches of 100.
  const allTaskIds = rows.map((r: any) => r.id);
  const messageCounts = new Map<string, number>();
  if (allTaskIds.length > 0) {
    const CHUNK_SIZE = 100;
    const chunks: string[][] = [];
    for (let i = 0; i < allTaskIds.length; i += CHUNK_SIZE) {
      chunks.push(allTaskIds.slice(i, i + CHUNK_SIZE));
    }
    const chunkResults = await Promise.all(
      chunks.map(chunk =>
        supabase
          .from('a2a_messages')
          .select('task_id')
          .in('task_id', chunk)
          .eq('tenant_id', ctx.tenantId)
          .eq('environment', getEnv(ctx))
          .limit(10000)
      )
    );
    for (const { data: messages } of chunkResults) {
      for (const m of messages || []) {
        messageCounts.set(m.task_id, (messageCounts.get(m.task_id) || 0) + 1);
      }
    }
  }

  // Batch fetch payment audit events for tasks without transfer_id
  const tasksWithoutTransfer = rows.filter((r: any) => !r.transfer_id).map((r: any) => r.id);
  const auditPaymentsByTask = new Map<string, { amount: number; currency: string }>();
  if (tasksWithoutTransfer.length > 0) {
    const A_CHUNK = 100;
    const aChunks: string[][] = [];
    for (let i = 0; i < tasksWithoutTransfer.length; i += A_CHUNK) {
      aChunks.push(tasksWithoutTransfer.slice(i, i + A_CHUNK));
    }
    const aResults = await Promise.all(
      aChunks.map(chunk =>
        supabase
          .from('a2a_audit_events')
          .select('task_id, data')
          .in('task_id', chunk)
          .eq('tenant_id', ctx.tenantId)
          .eq('environment', getEnv(ctx))
          .eq('event_type', 'payment')
          .limit(10000)
      )
    );
    for (const { data: events } of aResults) {
      for (const e of events || []) {
        const d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
        if (d?.amount && d?.currency) {
          const existing = auditPaymentsByTask.get(e.task_id);
          auditPaymentsByTask.set(e.task_id, {
            amount: (existing?.amount || 0) + (Number(d.amount) || 0),
            currency: d.currency,
          });
        }
      }
    }
  }

  // Resolve caller agent names (client_agent_id is VARCHAR, not FK)
  const allCallerIds = [...new Set(
    rows.map((r: any) => r.client_agent_id).filter(Boolean)
  )] as string[];
  const callerNameMap = new Map<string, string>();
  if (allCallerIds.length > 0) {
    const { data: callerAgents } = await supabase
      .from('agents')
      .select('id, name')
      .in('id', allCallerIds)
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx));
    for (const a of callerAgents || []) {
      callerNameMap.set(a.id, a.name);
    }
  }

  // Build sessions
  const sessions = Array.from(sessionMap.entries()).map(([contextId, taskRows]) => {
    const agentNames = [...new Set(taskRows.map((r: any) => (r as any).agents?.name).filter(Boolean))];
    const directions = [...new Set(taskRows.map((r: any) => r.direction))];
    const latestTask = taskRows[0]; // already sorted desc
    const transferIds = taskRows.map((r: any) => r.transfer_id).filter(Boolean);
    // Sum costs from transfer_id links + fallback to audit payment events
    const totalCost = taskRows.reduce((sum: number, r: any) => {
      if (r.transfer_id) return sum + (transferAmounts.get(r.transfer_id) || 0);
      const auditPay = auditPaymentsByTask.get(r.id);
      return sum + (auditPay?.amount || 0);
    }, 0);
    // Determine dominant currency for this session's transfers + audit payments
    const sessionCurrencyCounts = new Map<string, number>();
    for (const r of taskRows as any[]) {
      if (r.transfer_id) {
        const cur = transferCurrencies.get(r.transfer_id);
        if (cur) sessionCurrencyCounts.set(cur, (sessionCurrencyCounts.get(cur) || 0) + 1);
      } else {
        const auditPay = auditPaymentsByTask.get(r.id);
        if (auditPay?.currency) sessionCurrencyCounts.set(auditPay.currency, (sessionCurrencyCounts.get(auditPay.currency) || 0) + 1);
      }
    }
    const totalCostCurrency = sessionCurrencyCounts.size > 0
      ? [...sessionCurrencyCounts.entries()].sort((a, b) => b[1] - a[1])[0][0]
      : 'USDC';
    const msgCount = taskRows.reduce((sum: number, r: any) => sum + (messageCounts.get(r.id) || 0), 0);

    // Collect unique agents involved (both callers and callees)
    const agentsInSession = new Map<string, { id: string; name: string | null; role: 'provider' | 'caller' }>();
    for (const r of taskRows) {
      if (r.agent_id && !agentsInSession.has(r.agent_id)) {
        agentsInSession.set(r.agent_id, { id: r.agent_id, name: (r as any).agents?.name || null, role: 'provider' });
      }
      if (r.client_agent_id && !agentsInSession.has(r.client_agent_id)) {
        agentsInSession.set(r.client_agent_id, { id: r.client_agent_id, name: callerNameMap.get(r.client_agent_id) || null, role: 'caller' });
      }
    }

    return {
      contextId,
      taskCount: taskRows.length,
      agentNames,
      agents: Array.from(agentsInSession.values()),
      directions,
      latestState: latestTask.state,
      totalCost,
      totalCostCurrency,
      transferCount: transferIds.length,
      firstTaskAt: taskRows[taskRows.length - 1].created_at,
      lastTaskAt: latestTask.updated_at,
      messageCount: msgCount,
    };
  });

  // Sort by last activity desc
  sessions.sort((a, b) => new Date(b.lastTaskAt).getTime() - new Date(a.lastTaskAt).getTime());

  return c.json({ data: sessions });
});

// =============================================================================
// Custom Tools CRUD (Story 58.15)
// =============================================================================

/**
 * POST /v1/a2a/agents/:agentId/tools — Create a custom tool for an agent.
 */
a2aRouter.post('/agents/:agentId/tools', async (c) => {
  const ctx = c.get('ctx') as any;
  const agentId = c.req.param('agentId');
  if (!UUID_RE.test(agentId)) return c.json({ error: 'Invalid agentId' }, 400);

  let body: Record<string, any>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid request body' }, 400);
  }

  const toolName = body.toolName || body.tool_name;
  const description = body.description || '';
  const inputSchema = body.inputSchema || body.input_schema || { type: 'object', properties: {} };
  const handlerType = body.handlerType || body.handler_type || 'webhook';
  const handlerUrl = body.handlerUrl || body.handler_url;
  const handlerSecret = body.handlerSecret || body.handler_secret;
  const handlerMethod = body.handlerMethod || body.handler_method || 'POST';
  const handlerTimeoutMs = body.handlerTimeoutMs || body.handler_timeout_ms || 30000;

  if (!toolName || typeof toolName !== 'string') {
    return c.json({ error: 'toolName is required' }, 400);
  }
  if (!['webhook', 'http', 'noop'].includes(handlerType)) {
    return c.json({ error: 'handlerType must be one of: webhook, http, noop' }, 400);
  }
  if (handlerType !== 'noop' && !handlerUrl) {
    return c.json({ error: 'handlerUrl is required for webhook/http handler types' }, 400);
  }

  const supabase = createClient();

  // Verify agent belongs to tenant
  const { data: agent, error: agentErr } = await supabase
    .from('agents')
    .select('id')
    .eq('id', agentId)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();

  if (agentErr || !agent) return c.json({ error: 'Agent not found' }, 404);

  const { data: tool, error: insertErr } = await supabase
    .from('agent_custom_tools')
    .insert({
      tenant_id: ctx.tenantId,
      agent_id: agentId,
      tool_name: toolName,
      description,
      input_schema: inputSchema,
      handler_type: handlerType,
      handler_url: handlerUrl,
      handler_secret: handlerSecret,
      handler_method: handlerMethod,
      handler_timeout_ms: handlerTimeoutMs,
      status: 'active',
    })
    .select()
    .single();

  if (insertErr) {
    if (insertErr.code === '23505') {
      return c.json({ error: `Tool '${toolName}' already exists for this agent` }, 409);
    }
    return c.json({ error: insertErr.message }, 500);
  }

  return c.json({
    data: {
      id: tool.id,
      toolName: tool.tool_name,
      description: tool.description,
      inputSchema: tool.input_schema,
      handlerType: tool.handler_type,
      handlerUrl: tool.handler_url,
      handlerMethod: tool.handler_method,
      handlerTimeoutMs: tool.handler_timeout_ms,
      status: tool.status,
      metadata: tool.metadata,
      createdAt: tool.created_at,
      updatedAt: tool.updated_at,
    },
  }, 201);
});

/**
 * GET /v1/a2a/agents/:agentId/tools — List custom tools for an agent.
 */
a2aRouter.get('/agents/:agentId/tools', async (c) => {
  const ctx = c.get('ctx') as any;
  const agentId = c.req.param('agentId');
  if (!UUID_RE.test(agentId)) return c.json({ error: 'Invalid agentId' }, 400);

  const supabase = createClient();

  const { data: tools, error } = await supabase
    .from('agent_custom_tools')
    .select('*')
    .eq('agent_id', agentId)
    .eq('tenant_id', ctx.tenantId)
    .order('created_at', { ascending: false });

  if (error) return c.json({ error: error.message }, 500);

  return c.json({
    data: (tools || []).map((t: any) => ({
      id: t.id,
      toolName: t.tool_name,
      description: t.description,
      inputSchema: t.input_schema,
      handlerType: t.handler_type,
      handlerUrl: t.handler_url,
      handlerMethod: t.handler_method,
      handlerTimeoutMs: t.handler_timeout_ms,
      status: t.status,
      metadata: t.metadata,
      createdAt: t.created_at,
      updatedAt: t.updated_at,
    })),
  });
});

/**
 * DELETE /v1/a2a/agents/:agentId/tools/:toolId — Delete a custom tool.
 */
a2aRouter.delete('/agents/:agentId/tools/:toolId', async (c) => {
  const ctx = c.get('ctx') as any;
  const agentId = c.req.param('agentId');
  const toolId = c.req.param('toolId');
  if (!UUID_RE.test(agentId) || !UUID_RE.test(toolId)) {
    return c.json({ error: 'Invalid agentId or toolId' }, 400);
  }

  const supabase = createClient();

  const { error } = await supabase
    .from('agent_custom_tools')
    .delete()
    .eq('id', toolId)
    .eq('agent_id', agentId)
    .eq('tenant_id', ctx.tenantId);

  if (error) return c.json({ error: error.message }, 500);

  return c.body(null, 204);
});

export default a2aRouter;
