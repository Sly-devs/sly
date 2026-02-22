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
import { handleGatewayJsonRpc } from '../services/a2a/gateway-handler.js';
import { A2AWebhookHandler } from '../services/a2a/webhook-handler.js';
import { taskEventBus } from '../services/a2a/task-event-bus.js';
import type { A2AJsonRpcRequest, A2APart, A2ATaskState, A2AConfiguration } from '../services/a2a/types.js';
import { normalizeParts } from '../services/a2a/types.js';
import { verifyApiKey } from '../utils/crypto.js';

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
 * No auth required — public front door for the directory.
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

  const supabase = createClient();
  const rpcResponse = await handleGatewayJsonRpc(rpcRequest, supabase, getBaseUrl(c));
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
  const authHeader = c.req.header('Authorization');
  let tenantId: string | null = null;

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
        .select('tenant_id, auth_token_hash')
        .eq('auth_token_prefix', prefix)
        .single();
      if (agentRow && agentRow.auth_token_hash && verifyApiKey(token, agentRow.auth_token_hash)) {
        tenantId = agentRow.tenant_id;
      }
    }
  }

  // If no Sly auth, check the target agent exists and use its tenant
  if (!tenantId) {
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

  // ---- SSE streaming for message/stream ----
  if (rpcRequest.method === 'message/stream') {
    return handleMessageStream(c, rpcRequest, agentId, tenantId);
  }

  // Dispatch to JSON-RPC handler
  const supabase = createClient();
  const taskService = new A2ATaskService(supabase, tenantId);
  const rpcResponse = await handleJsonRpc(rpcRequest, agentId, taskService, supabase, tenantId || undefined);

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

  // Transition task state
  await taskService.updateTaskState(taskId, newState, body.statusMessage || `Agent ${newState}`);

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
      const existing = await taskService.findTaskByContext(agentId, contextId);
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
    .single();

  if (error || !agent) {
    return c.json({ error: 'Agent not found' }, 404);
  }

  return c.json({
    processingMode: (agent as any).processing_mode || 'manual',
    processingConfig: (agent as any).processing_config || {},
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

  // Validate processing mode
  if (!processingMode || !['managed', 'webhook', 'manual'].includes(processingMode)) {
    return c.json({ error: 'processing_mode must be one of: managed, webhook, manual' }, 400);
  }

  // Mode-specific validation
  if (processingMode === 'managed') {
    if (!processingConfig.model || typeof processingConfig.model !== 'string' || processingConfig.model.trim() === '') {
      return c.json({ error: 'managed mode requires a non-empty model string' }, 400);
    }
    if (!processingConfig.systemPrompt || typeof processingConfig.systemPrompt !== 'string' || processingConfig.systemPrompt.trim() === '') {
      return c.json({ error: 'managed mode requires a non-empty systemPrompt' }, 400);
    }
    if (processingConfig.systemPrompt.length > 10000) {
      return c.json({ error: 'systemPrompt must be 10000 characters or less' }, 400);
    }
    if (processingConfig.maxTokens !== undefined) {
      const maxTokens = Number(processingConfig.maxTokens);
      if (isNaN(maxTokens) || maxTokens < 512 || maxTokens > 200000) {
        return c.json({ error: 'maxTokens must be between 512 and 200000' }, 400);
      }
    }
    if (processingConfig.temperature !== undefined) {
      const temp = Number(processingConfig.temperature);
      if (isNaN(temp) || temp < 0 || temp > 2) {
        return c.json({ error: 'temperature must be between 0 and 2' }, 400);
      }
    }
  } else if (processingMode === 'webhook') {
    if (!processingConfig.callbackUrl || typeof processingConfig.callbackUrl !== 'string') {
      return c.json({ error: 'webhook mode requires a callbackUrl' }, 400);
    }
    try {
      const url = new URL(processingConfig.callbackUrl);
      if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
        return c.json({ error: 'callbackUrl must use HTTPS (or localhost for development)' }, 400);
      }
    } catch {
      return c.json({ error: 'callbackUrl must be a valid URL' }, 400);
    }
    if (processingConfig.timeoutMs !== undefined) {
      const timeout = Number(processingConfig.timeoutMs);
      if (isNaN(timeout) || timeout < 1000 || timeout > 120000) {
        return c.json({ error: 'timeoutMs must be between 1000 and 120000' }, 400);
      }
    }
  } else if (processingMode === 'manual') {
    // Manual mode: config should be empty
    const keys = Object.keys(processingConfig);
    if (keys.length > 0) {
      return c.json({ error: 'manual mode does not accept processing config' }, 400);
    }
  }

  const supabase = createClient();

  // Verify agent exists and belongs to tenant
  const { data: existing, error: fetchError } = await supabase
    .from('agents')
    .select('id')
    .eq('id', agentId)
    .eq('tenant_id', ctx.tenantId)
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
    .eq('tenant_id', ctx.tenantId);

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

  try {
    const { A2AClient } = await import('../services/a2a/client.js');
    const client = new A2AClient();
    const card = await client.discover(body.url);
    return c.json({ data: card });
  } catch (error: any) {
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
  const taskService = new A2ATaskService(supabase, ctx.tenantId);

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

  return c.json({ data: task });
});

/**
 * GET /v1/a2a/tasks
 * List A2A tasks (inbound + outbound) for the tenant.
 */
a2aRouter.get('/tasks', async (c) => {
  const ctx = c.get('ctx');
  const agentId = c.req.query('agent_id');
  const state = c.req.query('state');
  const direction = c.req.query('direction') as 'inbound' | 'outbound' | undefined;
  const contextId = c.req.query('context_id');
  const page = parseInt(c.req.query('page') || '1');
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 100);

  const supabase = createClient();
  const taskService = new A2ATaskService(supabase, ctx.tenantId);

  const result = await taskService.listTasks({
    agentId,
    state: state as any,
    direction,
    contextId,
    page,
    limit,
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

  const taskService = new A2ATaskService(supabase, ctx.tenantId);

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
  const taskService = new A2ATaskService(supabase, ctx.tenantId);

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
    .select('id, state, tenant_id')
    .eq('id', taskId)
    .eq('tenant_id', ctx.tenantId)
    .single();

  if (fetchError || !task) {
    return c.json({ error: 'Task not found' }, 404);
  }

  if ((task as any).state !== 'input-required') {
    return c.json({
      error: `Task is in '${(task as any).state}' state. Only 'input-required' tasks can be responded to.`,
    }, 400);
  }

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

  const taskService = new A2ATaskService(supabase, ctx.tenantId);

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
  const taskService = new A2ATaskService(supabase, ctx.tenantId);

  const task = await taskService.cancelTask(taskId);

  if (!task) {
    return c.json({ error: 'Task not found' }, 404);
  }

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
    .eq('tenant_id', ctx.tenantId);

  if (error) {
    return c.json({ error: `Failed to fetch stats: ${error.message}` }, 500);
  }

  const rows = tasks || [];
  const activeStates = ['submitted', 'working', 'input-required'];
  const transferIds = rows
    .map((r: any) => r.transfer_id)
    .filter(Boolean) as string[];

  let totalCost = 0;
  if (transferIds.length > 0) {
    const { data: transfers } = await supabase
      .from('transfers')
      .select('amount')
      .in('id', transferIds)
      .eq('tenant_id', ctx.tenantId);
    totalCost = (transfers || []).reduce((sum: number, t: any) => sum + (Number(t.amount) || 0), 0);
  }

  return c.json({
    data: {
      total: rows.length,
      active: rows.filter((r: any) => activeStates.includes(r.state)).length,
      completed: rows.filter((r: any) => r.state === 'completed').length,
      inbound: rows.filter((r: any) => r.direction === 'inbound').length,
      outbound: rows.filter((r: any) => r.direction === 'outbound').length,
      totalCost,
      transferCount: transferIds.length,
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
    .select('id, context_id, state, direction, agent_id, transfer_id, created_at, updated_at, agents!inner(name)')
    .eq('tenant_id', ctx.tenantId)
    .not('context_id', 'is', null)
    .order('created_at', { ascending: false });

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
  const allTransferIds = rows
    .map((r: any) => r.transfer_id)
    .filter(Boolean) as string[];
  const transferAmounts = new Map<string, number>();
  if (allTransferIds.length > 0) {
    const { data: transfers } = await supabase
      .from('transfers')
      .select('id, amount')
      .in('id', allTransferIds)
      .eq('tenant_id', ctx.tenantId);
    for (const t of transfers || []) {
      transferAmounts.set(t.id, Number(t.amount) || 0);
    }
  }

  // Batch fetch message counts for all tasks
  const allTaskIds = rows.map((r: any) => r.id);
  const messageCounts = new Map<string, number>();
  if (allTaskIds.length > 0) {
    const { data: messages } = await supabase
      .from('a2a_messages')
      .select('task_id')
      .in('task_id', allTaskIds)
      .eq('tenant_id', ctx.tenantId);
    for (const m of messages || []) {
      messageCounts.set(m.task_id, (messageCounts.get(m.task_id) || 0) + 1);
    }
  }

  // Build sessions
  const sessions = Array.from(sessionMap.entries()).map(([contextId, taskRows]) => {
    const agentNames = [...new Set(taskRows.map((r: any) => (r as any).agents?.name).filter(Boolean))];
    const directions = [...new Set(taskRows.map((r: any) => r.direction))];
    const latestTask = taskRows[0]; // already sorted desc
    const transferIds = taskRows.map((r: any) => r.transfer_id).filter(Boolean);
    const totalCost = transferIds.reduce((sum: number, tid: string) => sum + (transferAmounts.get(tid) || 0), 0);
    const msgCount = taskRows.reduce((sum: number, r: any) => sum + (messageCounts.get(r.id) || 0), 0);

    return {
      contextId,
      taskCount: taskRows.length,
      agentNames,
      directions,
      latestState: latestTask.state,
      totalCost,
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

export default a2aRouter;
