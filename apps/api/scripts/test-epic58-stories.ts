#!/usr/bin/env tsx
import { config } from 'dotenv';
config({ path: new URL('../.env', import.meta.url).pathname });

/**
 * E2E Test: Epic 58 Stories 58.11, 58.15, 58.17, 58.18
 *
 * Tests:
 *   1. SDK Types — Verify A2A types are accessible (compile-time)
 *   2. Custom Tools (58.15) — CRUD + execution for agent_custom_tools
 *   3. Audit Trail (58.17) — Verify a2a_audit_events populated after task processing
 *   4. Context Window (58.18) — Verify historyLength returns most recent N messages
 *   5. Epic 65 Integration — Verify operation_events populated with A2A_TASK_STATE_CHANGED
 *
 * Prerequisites:
 *   - API running on :4000
 *   - Seed data loaded (pnpm --filter @sly/api seed:db)
 *
 * Usage: cd apps/api && source .env && npx tsx scripts/test-epic58-stories.ts
 */

import { createClient } from '@supabase/supabase-js';

const API = process.env.SLY_URL || 'http://localhost:4000';
const API_KEY = process.env.SLY_API_KEY || 'pk_test_demo_fintech_key_12345';

// Treasury Agent (seeded by seed:db)
const AGENT_ID = 'de6881d4-af43-4510-b40e-841ceb9d8c0a';
const TENANT_ID = 'aaaaaaaa-0000-0000-0000-000000000001';

// Supabase admin client for verifying DB state
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

let passCount = 0;
let failCount = 0;

function assert(condition: boolean, label: string, detail?: string) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passCount++;
  } else {
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
    failCount++;
  }
}

async function jsonRpc(agentId: string, method: string, params: Record<string, unknown>) {
  const res = await fetch(`${API}/a2a/${agentId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method,
      params,
      id: `req-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    }),
  });
  return res.json() as Promise<any>;
}

async function apiGet(path: string) {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  return res.json() as Promise<any>;
}

async function apiPost(path: string, body: Record<string, unknown>) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<any>;
}

async function processTask(taskId: string) {
  return apiPost(`/v1/a2a/tasks/${taskId}/process`, {});
}

// =============================================================================
// Test 1: Story 58.15 — Custom Tools CRUD
// =============================================================================

async function testCustomTools() {
  console.log('\n🔧 Test 1: Custom Tools (Story 58.15)\n');

  // 1a. Insert a custom tool directly via Supabase (simulating API route)
  const toolName = `test_tool_${Date.now()}`;
  const { data: tool, error: insertErr } = await supabase
    .from('agent_custom_tools')
    .insert({
      tenant_id: TENANT_ID,
      agent_id: AGENT_ID,
      tool_name: toolName,
      description: 'A test tool for E2E validation',
      input_schema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Search query' } },
        required: ['query'],
      },
      handler_type: 'noop',
      status: 'active',
    })
    .select()
    .single();

  assert(!insertErr && !!tool, 'Custom tool created in DB', insertErr?.message);

  // 1b. Verify the tool appears in the registry via agent card
  const agentCard = await apiGet(`/a2a/${AGENT_ID}/.well-known/agent.json`);
  assert(!!agentCard?.id, 'Agent card retrieved');

  // 1c. Verify the tool is listed
  const { data: tools } = await supabase
    .from('agent_custom_tools')
    .select('tool_name, status')
    .eq('agent_id', AGENT_ID)
    .eq('tenant_id', TENANT_ID)
    .eq('status', 'active');

  const found = tools?.find((t: any) => t.tool_name === toolName);
  assert(!!found, 'Custom tool found in DB query');

  // 1d. Clean up — deactivate the tool
  await supabase
    .from('agent_custom_tools')
    .update({ status: 'inactive' })
    .eq('agent_id', AGENT_ID)
    .eq('tool_name', toolName);

  const { data: deactivated } = await supabase
    .from('agent_custom_tools')
    .select('status')
    .eq('agent_id', AGENT_ID)
    .eq('tool_name', toolName)
    .single();

  assert(deactivated?.status === 'inactive', 'Custom tool deactivated');

  // 1e. Insert a webhook-backed tool and verify schema
  const webhookToolName = `webhook_tool_${Date.now()}`;
  const { data: whTool, error: whErr } = await supabase
    .from('agent_custom_tools')
    .insert({
      tenant_id: TENANT_ID,
      agent_id: AGENT_ID,
      tool_name: webhookToolName,
      description: 'Webhook-backed tool for testing',
      input_schema: {
        type: 'object',
        properties: {
          sku: { type: 'string' },
          quantity: { type: 'number' },
        },
        required: ['sku'],
      },
      handler_type: 'webhook',
      handler_url: 'https://httpbin.org/post',
      handler_method: 'POST',
      handler_timeout_ms: 10000,
      status: 'active',
    })
    .select()
    .single();

  assert(!whErr && !!whTool, 'Webhook tool created', whErr?.message);
  assert(whTool?.handler_type === 'webhook', 'Handler type is webhook');
  assert(whTool?.handler_timeout_ms === 10000, 'Timeout is 10s');

  // Clean up
  await supabase.from('agent_custom_tools').delete().eq('id', whTool?.id);
  await supabase.from('agent_custom_tools').delete().eq('tool_name', toolName).eq('agent_id', AGENT_ID);
}

// =============================================================================
// Test 2: Story 58.17 — Audit Trail
// =============================================================================

async function testAuditTrail() {
  console.log('\n📋 Test 2: Audit Trail (Story 58.17)\n');

  // Record the baseline count before our test
  const { count: beforeCount } = await supabase
    .from('a2a_audit_events')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', TENANT_ID)
    .eq('agent_id', AGENT_ID);

  // 2a. Send a task and process it
  const sendResult = await jsonRpc(AGENT_ID, 'message/send', {
    message: { role: 'user', parts: [{ text: 'Check my wallet balance' }] },
  });

  const taskId = sendResult.result?.id;
  assert(!!taskId, 'Task created for audit test', JSON.stringify(sendResult.error));

  if (!taskId) return;

  // Process the task (response shape: { data: { id, status: { state } } })
  const processResult = await processTask(taskId);
  const processedState = processResult.data?.status?.state || processResult.status?.state || processResult.state;
  assert(
    processedState === 'completed',
    'Task processed to completion',
    `state=${processedState}, keys=${Object.keys(processResult).join(',')}`,
  );

  // Wait a moment for fire-and-forget audit writes
  await new Promise((r) => setTimeout(r, 1500));

  // 2b. Check audit events were created
  const { data: auditEvents, count: afterCount } = await supabase
    .from('a2a_audit_events')
    .select('*', { count: 'exact' })
    .eq('tenant_id', TENANT_ID)
    .eq('task_id', taskId)
    .order('created_at', { ascending: true });

  assert((auditEvents?.length || 0) > 0, `Audit events created (${auditEvents?.length || 0} for this task)`);

  // 2c. Verify event types include status transitions
  const eventTypes = new Set((auditEvents || []).map((e: any) => e.event_type));
  assert(eventTypes.has('status'), 'Audit has status event');

  // 2d. Verify status events have from_state/to_state
  const statusEvents = (auditEvents || []).filter((e: any) => e.event_type === 'status');
  const hasStateTransition = statusEvents.some((e: any) => e.to_state);
  assert(hasStateTransition, 'Status events have to_state field');

  // 2e. Check that message events were also logged
  const hasMessageEvent = eventTypes.has('message');
  assert(hasMessageEvent, 'Audit has message event(s)');

  // 2f. Verify Epic 65 integration — check operation_events for A2A state changes
  // Wait for the 5s flush buffer
  await new Promise((r) => setTimeout(r, 7000));

  // First try exact match
  let { data: opEvents } = await supabase
    .from('operation_events')
    .select('*')
    .eq('tenant_id', TENANT_ID)
    .eq('operation', 'a2a.task_state_changed')
    .eq('subject', `a2a/task/${taskId}`)
    .order('time', { ascending: false })
    .limit(5);

  // If no exact match, try broader query (any recent A2A events for this tenant)
  if (!opEvents?.length) {
    const { data: broadEvents } = await supabase
      .from('operation_events')
      .select('operation, subject, time')
      .eq('tenant_id', TENANT_ID)
      .like('operation', 'a2a.%')
      .order('time', { ascending: false })
      .limit(5);
    if (broadEvents?.length) {
      console.log(`    (debug: found ${broadEvents.length} broad A2A events: ${JSON.stringify(broadEvents.map(e => ({ op: e.operation, subj: e.subject })))})`);
    } else {
      console.log(`    (debug: zero A2A operation_events for tenant)`);
    }
  }

  assert(
    (opEvents?.length || 0) > 0,
    `Epic 65 operation_events has A2A state changes (${opEvents?.length || 0} events)`,
  );
}

// =============================================================================
// Test 3: Story 58.18 — Context Window Management
// =============================================================================

async function testContextWindow() {
  console.log('\n📐 Test 3: Context Window Management (Story 58.18)\n');

  // 3a. Create a task with multiple messages
  const ctxId = `ctx-test-${Date.now()}`;
  const sendResult = await jsonRpc(AGENT_ID, 'message/send', {
    message: { role: 'user', parts: [{ text: 'Message 1: Check balance' }] },
    contextId: ctxId,
  });

  const taskId = sendResult.result?.id;
  assert(!!taskId, 'Task created for context window test');
  if (!taskId) return;

  // Process to get an agent response (adds message 2)
  await processTask(taskId);

  // Add more messages directly via Supabase to simulate a long conversation
  for (let i = 3; i <= 8; i++) {
    await supabase.from('a2a_messages').insert({
      tenant_id: TENANT_ID,
      task_id: taskId,
      role: i % 2 === 0 ? 'agent' : 'user',
      parts: [{ text: `Message ${i}: Test padding for context window` }],
      metadata: {},
    });
    // Small delay to ensure ordering by created_at
    await new Promise((r) => setTimeout(r, 50));
  }

  // 3b. Fetch with no limit — should get all messages (up to default 100)
  const fullResult = await jsonRpc(AGENT_ID, 'tasks/get', { id: taskId });
  const fullHistory = fullResult.result?.history || [];
  assert(fullHistory.length >= 8, `Full history has all messages (${fullHistory.length})`, `expected >= 8`);

  // 3c. Fetch with historyLength=3 — should get the MOST RECENT 3
  const limitedResult = await jsonRpc(AGENT_ID, 'tasks/get', { id: taskId, historyLength: 3 });
  const limitedHistory = limitedResult.result?.history || [];
  assert(limitedHistory.length === 3, `Limited history has 3 messages (got ${limitedHistory.length})`);

  // 3d. Verify it's the MOST RECENT 3, not the oldest 3
  // The last message should be "Message 8"
  const lastMsg = limitedHistory[limitedHistory.length - 1];
  const lastText = lastMsg?.parts?.[0]?.text || '';
  assert(lastText.includes('Message 8'), 'Limited history returns most recent messages', `got: "${lastText}"`);

  // The first message in the limited set should NOT be "Message 1"
  const firstMsg = limitedHistory[0];
  const firstText = firstMsg?.parts?.[0]?.text || '';
  assert(!firstText.includes('Message 1'), 'Limited history excludes oldest messages', `got: "${firstText}"`);

  // 3e. Verify per-agent max_context_messages column exists
  const { data: agentRow } = await supabase
    .from('agents')
    .select('max_context_messages')
    .eq('id', AGENT_ID)
    .single();

  assert(agentRow?.max_context_messages !== undefined, `Agent has max_context_messages field (${agentRow?.max_context_messages})`);

  // 3f. Test that setting a low max_context_messages limits the default fetch
  // Note: CHECK constraint requires BETWEEN 10 AND 1000, so minimum is 10
  // We need enough messages to test; add more padding to exceed 10
  for (let i = 9; i <= 14; i++) {
    await supabase.from('a2a_messages').insert({
      tenant_id: TENANT_ID,
      task_id: taskId,
      role: i % 2 === 0 ? 'agent' : 'user',
      parts: [{ text: `Message ${i}: Extra padding for cap test` }],
      metadata: {},
    });
    await new Promise((r) => setTimeout(r, 50));
  }

  const { error: updateErr } = await supabase.from('agents').update({ max_context_messages: 10 }).eq('id', AGENT_ID);
  if (updateErr) console.log(`    (debug: agent update error: ${updateErr.message})`);

  const cappedResult = await jsonRpc(AGENT_ID, 'tasks/get', { id: taskId });
  const cappedHistory = cappedResult.result?.history || [];
  assert(
    cappedHistory.length <= 10,
    `Agent-level cap enforced (${cappedHistory.length} <= 10)`,
    `got ${cappedHistory.length}`,
  );

  // Restore default
  await supabase.from('agents').update({ max_context_messages: 100 }).eq('id', AGENT_ID);
}

// =============================================================================
// Test 4: Story 58.15 — Custom Tool Execution (noop handler)
// =============================================================================

async function testCustomToolExecution() {
  console.log('\n⚙️  Test 4: Custom Tool Execution (Story 58.15)\n');

  // Insert a noop custom tool
  const toolName = `exec_test_${Date.now()}`;
  await supabase.from('agent_custom_tools').insert({
    tenant_id: TENANT_ID,
    agent_id: AGENT_ID,
    tool_name: toolName,
    description: 'Noop tool for execution testing',
    input_schema: { type: 'object', properties: { q: { type: 'string' } }, required: [] },
    handler_type: 'noop',
    status: 'active',
  });

  // Verify the tool can be found in the DB
  const { data: toolRow } = await supabase
    .from('agent_custom_tools')
    .select('id, tool_name, handler_type')
    .eq('agent_id', AGENT_ID)
    .eq('tool_name', toolName)
    .single();

  assert(!!toolRow, 'Noop tool inserted for execution test');
  assert(toolRow?.handler_type === 'noop', 'Tool handler type is noop');

  // Verify unique constraint — attempt duplicate insert
  const { error: dupErr } = await supabase.from('agent_custom_tools').insert({
    tenant_id: TENANT_ID,
    agent_id: AGENT_ID,
    tool_name: toolName,
    description: 'Duplicate',
    handler_type: 'noop',
  });
  assert(!!dupErr, 'Unique constraint prevents duplicate tool name per agent');

  // Clean up
  await supabase.from('agent_custom_tools').delete().eq('id', toolRow?.id);
}

// =============================================================================
// Test 5: Story 58.11 — SDK Types export verification
// =============================================================================

async function testSDKTypes() {
  console.log('\n📦 Test 5: SDK Types Export (Story 58.11)\n');

  // We can't import the SDK at runtime in this script without building,
  // but we can verify the types package exports the A2A module
  // by checking that the dist files exist.
  const fs = await import('fs');
  const path = await import('path');
  const { fileURLToPath } = await import('url');

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const typesDistDir = path.resolve(__dirname, '../../../packages/types/dist');
  const sdkDistDir = path.resolve(__dirname, '../../../packages/sdk/dist');

  // Check types package
  const typesIndexPath = path.join(typesDistDir, 'index.d.ts');
  if (fs.existsSync(typesIndexPath)) {
    const typesContent = fs.readFileSync(typesIndexPath, 'utf-8');
    assert(typesContent.includes('A2ATask'), '@sly/types exports A2ATask');
    assert(typesContent.includes('A2AAgentCard'), '@sly/types exports A2AAgentCard');
    assert(typesContent.includes('A2AMessage'), '@sly/types exports A2AMessage');
    assert(typesContent.includes('A2ACustomTool'), '@sly/types exports A2ACustomTool');
    assert(typesContent.includes('A2AInputRequiredContext'), '@sly/types exports A2AInputRequiredContext');
  } else {
    assert(false, '@sly/types dist exists', 'run pnpm build first');
  }

  // Check SDK package
  const sdkA2aPath = path.join(sdkDistDir, 'a2a.d.ts');
  if (fs.existsSync(sdkA2aPath)) {
    const sdkContent = fs.readFileSync(sdkA2aPath, 'utf-8');
    assert(sdkContent.includes('A2AClient'), '@sly/sdk/a2a exports A2AClient');
  } else {
    assert(false, '@sly/sdk/a2a dist exists', 'run pnpm build first');
  }

  // Check main SDK index
  const sdkIndexPath = path.join(sdkDistDir, 'index.d.ts');
  if (fs.existsSync(sdkIndexPath)) {
    const sdkIndex = fs.readFileSync(sdkIndexPath, 'utf-8');
    assert(sdkIndex.includes('a2a') || sdkIndex.includes('A2AClient'), '@sly/sdk main exports a2a client');
  } else {
    assert(false, '@sly/sdk dist exists', 'run pnpm build first');
  }
}

// =============================================================================
// Test 6: Audit Trail — Detailed field validation
// =============================================================================

async function testAuditTrailFields() {
  console.log('\n🔍 Test 6: Audit Trail Field Validation (Story 58.17)\n');

  // Send and process a task
  const sendResult = await jsonRpc(AGENT_ID, 'message/send', {
    message: { role: 'user', parts: [{ text: 'Who are you? What are your capabilities?' }] },
  });
  const taskId = sendResult.result?.id;
  assert(!!taskId, 'Task created for field validation test');
  if (!taskId) return;

  await processTask(taskId);
  await new Promise((r) => setTimeout(r, 1500));

  // Fetch audit events
  const { data: events } = await supabase
    .from('a2a_audit_events')
    .select('*')
    .eq('task_id', taskId)
    .order('created_at', { ascending: true });

  assert((events?.length || 0) >= 2, `At least 2 audit events (got ${events?.length || 0})`);

  if (events && events.length > 0) {
    const first = events[0];
    assert(!!first.tenant_id, 'Audit event has tenant_id');
    assert(!!first.agent_id, 'Audit event has agent_id');
    assert(!!first.event_type, `Audit event has event_type (${first.event_type})`);
    assert(!!first.created_at, 'Audit event has created_at timestamp');
    assert(typeof first.data === 'object', 'Audit event data is JSONB object');
    assert(!!first.actor_type, `Audit event has actor_type (${first.actor_type})`);
  }
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  Epic 58 Stories E2E Test Suite');
  console.log('  Stories: 58.11, 58.15, 58.17, 58.18');
  console.log(`  Target: ${API}`);
  console.log(`  Agent: ${AGENT_ID}`);
  console.log('═══════════════════════════════════════════════');

  // Verify API is running
  try {
    const health = await fetch(`${API}/health`);
    assert(health.ok, 'API server is reachable');
  } catch {
    console.error('\n❌ API server not reachable at', API);
    console.error('   Start with: pnpm --filter @sly/api dev\n');
    process.exit(1);
  }

  // Verify agent exists (discovery is a REST GET, not JSON-RPC)
  const agentCard = await apiGet(`/a2a/${AGENT_ID}/.well-known/agent.json`);
  assert(!!agentCard?.id, 'Treasury Agent exists', JSON.stringify(agentCard?.error));
  if (!agentCard?.id) {
    console.error('\n❌ Treasury Agent not found. Run: pnpm --filter @sly/api seed:db\n');
    process.exit(1);
  }

  // Run tests
  await testSDKTypes();
  await testCustomTools();
  await testCustomToolExecution();
  await testAuditTrail();
  await testAuditTrailFields();
  await testContextWindow();

  // Summary
  console.log('\n═══════════════════════════════════════════════');
  console.log(`  Results: ${passCount} passed, ${failCount} failed (${passCount + failCount} total)`);
  console.log('═══════════════════════════════════════════════\n');

  if (failCount > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
