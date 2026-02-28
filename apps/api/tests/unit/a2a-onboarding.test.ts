/**
 * A2A Agent Onboarding Tests (Epic 60)
 *
 * Tests register_agent, update_agent, and get_my_status handlers
 * via the gateway handler with mocked Supabase.
 */

import { describe, it, expect, vi } from 'vitest';
import { handleGatewayJsonRpc, type GatewayAuthContext } from '../../src/services/a2a/gateway-handler.js';
import type { A2AJsonRpcRequest, A2AJsonRpcResponse } from '../../src/services/a2a/types.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/**
 * Creates a Supabase mock where each table has a configurable final result.
 * Every chain method (select, eq, insert, update, etc.) returns `this`.
 * Terminal methods (single, limit, order at the end) resolve to the configured result.
 *
 * Usage: configure per-table via `tableResults` map:
 *   - `{ data: ..., error: null }` for the default resolution
 *   - Call count resets each test
 */
function createMockSupabase(tableResults: Record<string, { data: any; error: any }> = {}) {
  const tables: Record<string, any> = {};

  function makeChain(result: { data: any; error: any }) {
    const chain: any = {};
    const self = () => chain;

    // All chainable methods return the chain itself
    for (const m of ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'in', 'neq', 'gt', 'lt', 'gte', 'lte', 'ilike', 'order', 'limit']) {
      chain[m] = vi.fn(self);
    }

    // single() is a terminal async method
    chain.single = vi.fn().mockResolvedValue(result);

    // Make the chain itself thenable (for await without single)
    chain.then = (resolve: any, reject?: any) => Promise.resolve(result).then(resolve, reject);

    return chain;
  }

  const fromFn = vi.fn((table: string) => {
    if (!tables[table]) {
      const result = tableResults[table] || { data: null, error: null };
      tables[table] = makeChain(result);
    }
    return tables[table];
  });

  return { from: fromFn, _tables: tables } as any;
}

function buildMessage(data: Record<string, unknown>): A2AJsonRpcRequest {
  return {
    jsonrpc: '2.0',
    method: 'message/send',
    params: {
      message: {
        parts: [{ data }],
      },
    },
    id: 'test-1',
  };
}

function getResultData(response: A2AJsonRpcResponse): Record<string, any> | undefined {
  const result = response.result as any;
  return result?.artifacts?.[0]?.parts?.[0]?.data;
}

const BASE_URL = 'http://localhost:4000';

// ---------------------------------------------------------------------------
// register_agent
// ---------------------------------------------------------------------------

describe('register_agent', () => {
  it('rejects without auth', async () => {
    const supabase = createMockSupabase();
    const request = buildMessage({ skill: 'register_agent', name: 'TestBot' });
    const response = await handleGatewayJsonRpc(request, supabase, BASE_URL);

    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(-32004);
    expect(response.error!.message).toContain('API key authentication');
  });

  it('rejects agent token auth (requires API key)', async () => {
    const supabase = createMockSupabase();
    const request = buildMessage({ skill: 'register_agent', name: 'TestBot' });
    const auth: GatewayAuthContext = {
      tenantId: 'tenant-1',
      authType: 'agent',
      agentId: 'agent-1',
    };
    const response = await handleGatewayJsonRpc(request, supabase, BASE_URL, auth);

    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(-32004);
  });

  it('rejects missing name', async () => {
    const supabase = createMockSupabase();
    const request = buildMessage({ skill: 'register_agent' });
    const auth: GatewayAuthContext = {
      tenantId: 'tenant-1',
      authType: 'api_key',
      apiKeyId: 'key-1',
    };
    const response = await handleGatewayJsonRpc(request, supabase, BASE_URL, auth);

    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(-32602);
    expect(response.error!.message).toContain('name is required');
  });

  it('rejects invalid accountId', async () => {
    const supabase = createMockSupabase();
    const request = buildMessage({ skill: 'register_agent', name: 'TestBot', accountId: 'not-a-uuid' });
    const auth: GatewayAuthContext = {
      tenantId: 'tenant-1',
      authType: 'api_key',
      apiKeyId: 'key-1',
    };
    const response = await handleGatewayJsonRpc(request, supabase, BASE_URL, auth);

    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(-32602);
    expect(response.error!.message).toContain('valid UUID');
  });

  it('successfully registers agent with auto-selected account', async () => {
    const agentId = 'aaaaaaaa-1111-1111-1111-111111111111';
    const accountId = 'bbbbbbbb-1111-1111-1111-111111111111';
    const walletId = 'cccccccc-1111-1111-1111-111111111111';

    const supabase = createMockSupabase({
      accounts: {
        data: [{ id: accountId, verification_tier: 1 }],
        error: null,
      },
      agents: {
        data: {
          id: agentId,
          name: 'TestBot',
          description: null,
          status: 'active',
          kya_tier: 1,
          kya_status: 'verified',
          created_at: '2026-02-28T00:00:00Z',
        },
        error: null,
      },
      wallets: {
        data: { id: walletId },
        error: null,
      },
      kya_tier_limits: {
        data: { per_transaction: 100, daily: 500, monthly: 5000 },
        error: null,
      },
      verification_tier_limits: {
        data: { per_transaction: 200, daily: 1000, monthly: 10000 },
        error: null,
      },
    });

    const request = buildMessage({ skill: 'register_agent', name: 'TestBot' });
    const auth: GatewayAuthContext = {
      tenantId: 'tenant-1',
      authType: 'api_key',
      apiKeyId: 'key-1',
    };

    const response = await handleGatewayJsonRpc(request, supabase, BASE_URL, auth);

    expect(response.error).toBeUndefined();
    const data = getResultData(response);
    expect(data).toBeDefined();
    expect(data!.agent).toBeDefined();
    expect(data!.agent.id).toBe(agentId);
    expect(data!.agent.kyaTier).toBe(1);
    expect(data!.credentials).toBeDefined();
    expect(data!.credentials.token).toMatch(/^agent_/);
    expect(data!.credentials.warning).toContain('SAVE THIS TOKEN');
    expect(data!.wallet).toBeDefined();
    expect(data!.wallet.id).toBe(walletId);
    expect(data!.limits).toBeDefined();
    expect(data!.limits.effective.per_transaction).toBe(100);
  });

  it('registers agent with skills', async () => {
    const agentId = 'aaaaaaaa-2222-2222-2222-222222222222';

    const supabase = createMockSupabase({
      accounts: {
        data: [{ id: 'acc-1', verification_tier: 1 }],
        error: null,
      },
      agents: {
        data: {
          id: agentId,
          name: 'SkillBot',
          description: null,
          status: 'active',
          kya_tier: 1,
          kya_status: 'verified',
          created_at: '2026-02-28T00:00:00Z',
        },
        error: null,
      },
      wallets: {
        data: { id: 'w-1' },
        error: null,
      },
      agent_skills: {
        data: null,
        error: null,
      },
      kya_tier_limits: {
        data: { per_transaction: 100, daily: 500, monthly: 5000 },
        error: null,
      },
      verification_tier_limits: {
        data: { per_transaction: 200, daily: 1000, monthly: 10000 },
        error: null,
      },
    });

    const request = buildMessage({
      skill: 'register_agent',
      name: 'SkillBot',
      skills: [
        { id: 'research', name: 'Research', description: 'Web research', base_price: 0.5 },
        { id: 'summarize', name: 'Summarize', base_price: 0.1 },
      ],
    });
    const auth: GatewayAuthContext = { tenantId: 'tenant-1', authType: 'api_key', apiKeyId: 'key-1' };

    const response = await handleGatewayJsonRpc(request, supabase, BASE_URL, auth);
    expect(response.error).toBeUndefined();
    const data = getResultData(response);
    expect(data!.skills).toEqual(['research', 'summarize']);
  });
});

// ---------------------------------------------------------------------------
// update_agent
// ---------------------------------------------------------------------------

describe('update_agent', () => {
  it('rejects without auth', async () => {
    const supabase = createMockSupabase();
    const request = buildMessage({ skill: 'update_agent', name: 'NewName' });
    const response = await handleGatewayJsonRpc(request, supabase, BASE_URL);

    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(-32004);
    expect(response.error!.message).toContain('agent token');
  });

  it('rejects API key auth (requires agent token)', async () => {
    const supabase = createMockSupabase();
    const request = buildMessage({ skill: 'update_agent', name: 'NewName' });
    const auth: GatewayAuthContext = { tenantId: 'tenant-1', authType: 'api_key', apiKeyId: 'key-1' };
    const response = await handleGatewayJsonRpc(request, supabase, BASE_URL, auth);

    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(-32004);
  });

  it('successfully updates agent name and returns state', async () => {
    const agentId = 'aaaaaaaa-3333-3333-3333-333333333333';

    const supabase = createMockSupabase({
      agents: {
        data: {
          id: agentId,
          name: 'UpdatedBot',
          description: 'New desc',
          status: 'active',
          kya_tier: 1,
          kya_status: 'verified',
          metadata: null,
        },
        error: null,
      },
      agent_skills: {
        data: [
          { skill_id: 'research', name: 'Research', description: null, base_price: 0.5, currency: 'USDC', tags: [], status: 'active' },
        ],
        error: null,
      },
    });

    const request = buildMessage({ skill: 'update_agent', name: 'UpdatedBot', description: 'New desc' });
    const auth: GatewayAuthContext = { tenantId: 'tenant-1', authType: 'agent', agentId };

    const response = await handleGatewayJsonRpc(request, supabase, BASE_URL, auth);
    expect(response.error).toBeUndefined();
    const data = getResultData(response);
    expect(data!.agent.name).toBe('UpdatedBot');
    expect(data!.skills).toHaveLength(1);
    expect(data!.skills[0].id).toBe('research');
  });

  it('adds and removes skills', async () => {
    const agentId = 'aaaaaaaa-4444-4444-4444-444444444444';

    const supabase = createMockSupabase({
      agents: {
        data: {
          id: agentId,
          name: 'Bot',
          description: null,
          status: 'active',
          kya_tier: 1,
          kya_status: 'verified',
          metadata: null,
        },
        error: null,
      },
      agent_skills: {
        data: [],
        error: null,
      },
    });

    const request = buildMessage({
      skill: 'update_agent',
      add_skills: [{ id: 'new_skill', name: 'New Skill' }],
      remove_skills: ['old_skill'],
    });
    const auth: GatewayAuthContext = { tenantId: 'tenant-1', authType: 'agent', agentId };

    const response = await handleGatewayJsonRpc(request, supabase, BASE_URL, auth);
    expect(response.error).toBeUndefined();

    // Verify agent_skills was accessed for upsert
    expect(supabase.from).toHaveBeenCalledWith('agent_skills');
  });

  it('accepts "skills" as alias for "add_skills"', async () => {
    const agentId = 'aaaaaaaa-6666-6666-6666-666666666666';

    const supabase = createMockSupabase({
      agents: {
        data: {
          id: agentId,
          name: 'Bot',
          description: null,
          status: 'active',
          kya_tier: 1,
          kya_status: 'verified',
          metadata: null,
        },
        error: null,
      },
      agent_skills: {
        data: [
          { skill_id: 'translate', name: 'Translate', description: null, base_price: 0, currency: 'USDC', tags: [], status: 'active' },
        ],
        error: null,
      },
    });

    // Send "skills" instead of "add_skills" — should still work
    const request = buildMessage({
      skill: 'update_agent',
      skills: [{ id: 'translate', name: 'Translate' }],
    });
    const auth: GatewayAuthContext = { tenantId: 'tenant-1', authType: 'agent', agentId };

    const response = await handleGatewayJsonRpc(request, supabase, BASE_URL, auth);
    expect(response.error).toBeUndefined();

    // Verify upsert was called on agent_skills
    expect(supabase.from).toHaveBeenCalledWith('agent_skills');
    const data = getResultData(response);
    expect(data!.skills).toHaveLength(1);
    expect(data!.skills[0].id).toBe('translate');
  });
});

// ---------------------------------------------------------------------------
// get_my_status
// ---------------------------------------------------------------------------

describe('get_my_status', () => {
  it('rejects without auth', async () => {
    const supabase = createMockSupabase();
    const request = buildMessage({ skill: 'get_my_status' });
    const response = await handleGatewayJsonRpc(request, supabase, BASE_URL);

    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(-32004);
  });

  it('returns full agent status', async () => {
    const agentId = 'aaaaaaaa-5555-5555-5555-555555555555';
    const walletId = 'wwwwwwww-5555-5555-5555-555555555555';

    const supabase = createMockSupabase({
      agents: {
        data: {
          id: agentId,
          name: 'StatusBot',
          description: 'A status bot',
          status: 'active',
          kya_tier: 1,
          kya_status: 'verified',
          parent_account_id: 'acc-1',
          metadata: { a2a_endpoint: 'https://example.com/a2a' },
          permissions: {},
          created_at: '2026-02-28T00:00:00Z',
        },
        error: null,
      },
      wallets: {
        data: [
          { id: walletId, balance: 42.5, currency: 'USDC', status: 'active', wallet_type: 'internal', name: 'StatusBot Wallet' },
        ],
        error: null,
      },
      agent_skills: {
        data: [
          { skill_id: 'analyze', name: 'Analyze', description: 'Data analysis', base_price: 1.0, currency: 'USDC', tags: ['data'], status: 'active' },
        ],
        error: null,
      },
      accounts: {
        data: { verification_tier: 2 },
        error: null,
      },
      kya_tier_limits: {
        data: { per_transaction: 100, daily: 500, monthly: 5000 },
        error: null,
      },
      verification_tier_limits: {
        data: { per_transaction: 200, daily: 1000, monthly: 10000 },
        error: null,
      },
    });

    const request = buildMessage({ skill: 'get_my_status' });
    const auth: GatewayAuthContext = { tenantId: 'tenant-1', authType: 'agent', agentId };

    const response = await handleGatewayJsonRpc(request, supabase, BASE_URL, auth);
    expect(response.error).toBeUndefined();
    const data = getResultData(response);
    expect(data).toBeDefined();
    expect(data!.agent.id).toBe(agentId);
    expect(data!.agent.name).toBe('StatusBot');
    expect(data!.agent.kyaTier).toBe(1);
    expect(data!.agent.cardUrl).toContain(agentId);
    expect(data!.skills).toHaveLength(1);
    expect(data!.skills[0].id).toBe('analyze');
    expect(data!.limits.effective.per_transaction).toBe(100);
    expect(data!.limits.tier).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Discovery still works without auth
// ---------------------------------------------------------------------------

describe('discovery backward compatibility', () => {
  it('list_agents works without auth', async () => {
    const supabase = createMockSupabase({
      agents: {
        data: [
          { id: 'a-1', name: 'Agent1', description: null, status: 'active', kya_tier: 1, permissions: {}, parent_account_id: 'acc-1' },
        ],
        error: null,
      },
    });

    const request = buildMessage({ skill: 'list_agents' });
    const response = await handleGatewayJsonRpc(request, supabase, BASE_URL);

    expect(response.error).toBeUndefined();
    const data = getResultData(response);
    expect(data!.skill).toBe('list_agents');
    expect(data!.agents).toHaveLength(1);
  });

  it('find_agent works without auth', async () => {
    const supabase = createMockSupabase({
      agents: {
        data: [
          { id: 'a-1', name: 'PaymentBot', description: 'Handles payments', status: 'active', kya_tier: 1, permissions: { transactions: true }, parent_account_id: 'acc-1' },
        ],
        error: null,
      },
    });

    const request = buildMessage({ skill: 'find_agent', query: 'payment' });
    const response = await handleGatewayJsonRpc(request, supabase, BASE_URL);

    expect(response.error).toBeUndefined();
    const data = getResultData(response);
    expect(data!.skill).toBe('find_agent');
  });
});

// ---------------------------------------------------------------------------
// manage_wallet
// ---------------------------------------------------------------------------

describe('manage_wallet', () => {
  it('rejects without agent auth', async () => {
    const supabase = createMockSupabase();
    const request = buildMessage({ skill: 'manage_wallet', action: 'check_balance' });
    const response = await handleGatewayJsonRpc(request, supabase, BASE_URL);

    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(-32004);
    expect(response.error!.message).toContain('agent token');
  });

  it('rejects API key auth (requires agent token)', async () => {
    const supabase = createMockSupabase();
    const request = buildMessage({ skill: 'manage_wallet', action: 'check_balance' });
    const auth: GatewayAuthContext = { tenantId: 'tenant-1', authType: 'api_key', apiKeyId: 'key-1' };
    const response = await handleGatewayJsonRpc(request, supabase, BASE_URL, auth);

    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(-32004);
  });

  it('check_balance returns wallet list for authenticated agent', async () => {
    const agentId = 'aaaaaaaa-7777-7777-7777-777777777777';
    const walletId = 'wwwwwwww-7777-7777-7777-777777777777';

    const supabase = createMockSupabase({
      wallets: {
        data: [
          { id: walletId, balance: 50.0, currency: 'USDC', status: 'active' },
        ],
        error: null,
      },
    });

    const request = buildMessage({ skill: 'manage_wallet', action: 'check_balance' });
    const auth: GatewayAuthContext = { tenantId: 'tenant-1', authType: 'agent', agentId };

    const response = await handleGatewayJsonRpc(request, supabase, BASE_URL, auth);
    expect(response.error).toBeUndefined();
    const data = getResultData(response);
    expect(data!.action).toBe('check_balance');
    expect(data!.wallets).toHaveLength(1);
    expect(data!.wallets[0].id).toBe(walletId);
    expect(data!.wallets[0].balance).toBe(50.0);
  });

  it('defaults to check_balance when no action specified', async () => {
    const agentId = 'aaaaaaaa-7777-7777-7777-777777777777';

    const supabase = createMockSupabase({
      wallets: {
        data: [],
        error: null,
      },
    });

    const request = buildMessage({ skill: 'manage_wallet' });
    const auth: GatewayAuthContext = { tenantId: 'tenant-1', authType: 'agent', agentId };

    const response = await handleGatewayJsonRpc(request, supabase, BASE_URL, auth);
    expect(response.error).toBeUndefined();
    const data = getResultData(response);
    expect(data!.action).toBe('check_balance');
  });

  it('fund increments balance and returns previous/new amounts', async () => {
    const agentId = 'aaaaaaaa-8888-8888-8888-888888888888';
    const walletId = 'wwwwwwww-8888-8888-8888-888888888888';

    const supabase = createMockSupabase({
      wallets: {
        data: { id: walletId, balance: 25.0, currency: 'USDC', status: 'active' },
        error: null,
      },
      audit_log: {
        data: null,
        error: null,
      },
    });

    const request = buildMessage({ skill: 'manage_wallet', action: 'fund', amount: 100 });
    const auth: GatewayAuthContext = { tenantId: 'tenant-1', authType: 'agent', agentId };

    const response = await handleGatewayJsonRpc(request, supabase, BASE_URL, auth);
    expect(response.error).toBeUndefined();
    const data = getResultData(response);
    expect(data!.action).toBe('fund');
    expect(data!.wallet_id).toBe(walletId);
    expect(data!.previous_balance).toBe(25.0);
    expect(data!.funded_amount).toBe(100);
    expect(data!.new_balance).toBe(125.0);
    expect(data!.currency).toBe('USDC');
  });

  it('fund rejects invalid amount', async () => {
    const agentId = 'aaaaaaaa-8888-8888-8888-888888888888';
    const supabase = createMockSupabase();

    const request = buildMessage({ skill: 'manage_wallet', action: 'fund', amount: -10 });
    const auth: GatewayAuthContext = { tenantId: 'tenant-1', authType: 'agent', agentId };

    const response = await handleGatewayJsonRpc(request, supabase, BASE_URL, auth);
    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(-32602);
    expect(response.error!.message).toContain('amount');
  });

  it('fund rejects amount over 100,000', async () => {
    const agentId = 'aaaaaaaa-8888-8888-8888-888888888888';
    const supabase = createMockSupabase();

    const request = buildMessage({ skill: 'manage_wallet', action: 'fund', amount: 200_000 });
    const auth: GatewayAuthContext = { tenantId: 'tenant-1', authType: 'agent', agentId };

    const response = await handleGatewayJsonRpc(request, supabase, BASE_URL, auth);
    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(-32602);
  });

  it('fund rejects in production mode', async () => {
    const agentId = 'aaaaaaaa-8888-8888-8888-888888888888';
    const supabase = createMockSupabase();

    // Simulate production
    const origEnv = process.env.NODE_ENV;
    const origSandbox = process.env.SANDBOX_MODE;
    process.env.NODE_ENV = 'production';
    delete process.env.SANDBOX_MODE;

    try {
      const request = buildMessage({ skill: 'manage_wallet', action: 'fund', amount: 50 });
      const auth: GatewayAuthContext = { tenantId: 'tenant-1', authType: 'agent', agentId };

      const response = await handleGatewayJsonRpc(request, supabase, BASE_URL, auth);
      expect(response.error).toBeDefined();
      expect(response.error!.message).toContain('sandbox');
    } finally {
      process.env.NODE_ENV = origEnv;
      if (origSandbox !== undefined) {
        process.env.SANDBOX_MODE = origSandbox;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// check_task
// ---------------------------------------------------------------------------

describe('check_task', () => {
  it('rejects without agent auth', async () => {
    const supabase = createMockSupabase();
    const request = buildMessage({ skill: 'check_task', task_id: 'aaaaaaaa-0000-0000-0000-000000000001' });
    const response = await handleGatewayJsonRpc(request, supabase, BASE_URL);

    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(-32004);
    expect(response.error!.message).toContain('agent token');
  });

  it('rejects missing task_id', async () => {
    const agentId = 'aaaaaaaa-9999-9999-9999-999999999999';
    const supabase = createMockSupabase();
    const request = buildMessage({ skill: 'check_task' });
    const auth: GatewayAuthContext = { tenantId: 'tenant-1', authType: 'agent', agentId };

    const response = await handleGatewayJsonRpc(request, supabase, BASE_URL, auth);
    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(-32602);
    expect(response.error!.message).toContain('task_id');
  });

  it('rejects invalid task_id format', async () => {
    const agentId = 'aaaaaaaa-9999-9999-9999-999999999999';
    const supabase = createMockSupabase();
    const request = buildMessage({ skill: 'check_task', task_id: 'not-a-uuid' });
    const auth: GatewayAuthContext = { tenantId: 'tenant-1', authType: 'agent', agentId };

    const response = await handleGatewayJsonRpc(request, supabase, BASE_URL, auth);
    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(-32602);
  });

  it('returns not found for nonexistent task', async () => {
    const agentId = 'aaaaaaaa-9999-9999-9999-999999999999';
    const taskId = 'dddddddd-0000-0000-0000-000000000001';

    const supabase = createMockSupabase({
      a2a_tasks: {
        data: null,
        error: { message: 'not found' },
      },
    });

    const request = buildMessage({ skill: 'check_task', task_id: taskId });
    const auth: GatewayAuthContext = { tenantId: 'tenant-1', authType: 'agent', agentId };

    const response = await handleGatewayJsonRpc(request, supabase, BASE_URL, auth);
    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(-32001);
    expect(response.error!.message).toContain(taskId);
  });

  it('returns task with history and artifacts', async () => {
    const agentId = 'aaaaaaaa-9999-9999-9999-999999999999';
    const taskId = 'dddddddd-1111-1111-1111-111111111111';

    const supabase = createMockSupabase({
      a2a_tasks: {
        data: {
          id: taskId,
          state: 'completed',
          status_message: 'Done',
          direction: 'outbound',
          agent_id: 'other-agent',
          client_agent_id: agentId,
          created_at: '2026-02-28T00:00:00Z',
          updated_at: '2026-02-28T00:01:00Z',
          processing_duration_ms: 1200,
        },
        error: null,
      },
      a2a_messages: {
        data: [
          { role: 'user', parts: [{ text: 'Hello' }], created_at: '2026-02-28T00:00:00Z' },
          { role: 'agent', parts: [{ text: 'Hi there' }], created_at: '2026-02-28T00:00:01Z' },
        ],
        error: null,
      },
      a2a_artifacts: {
        data: [
          { label: 'result', mime_type: 'application/json', parts: [{ data: { answer: 42 } }] },
        ],
        error: null,
      },
    });

    const request = buildMessage({ skill: 'check_task', task_id: taskId });
    const auth: GatewayAuthContext = { tenantId: 'tenant-1', authType: 'agent', agentId };

    const response = await handleGatewayJsonRpc(request, supabase, BASE_URL, auth);
    expect(response.error).toBeUndefined();
    const data = getResultData(response);
    expect(data!.task.id).toBe(taskId);
    expect(data!.task.state).toBe('completed');
    expect(data!.task.status_message).toBe('Done');
    expect(data!.task.direction).toBe('outbound');
    expect(data!.task.processing_duration_ms).toBe(1200);
    expect(data!.history).toHaveLength(2);
    expect(data!.history[0].role).toBe('user');
    expect(data!.artifacts).toHaveLength(1);
    expect(data!.artifacts[0].label).toBe('result');
  });
});

// ---------------------------------------------------------------------------
// Platform capabilities includes new skills
// ---------------------------------------------------------------------------

describe('gateway capabilities', () => {
  it('returns capabilities including onboarding skills for unknown intent', async () => {
    const supabase = createMockSupabase();
    const request: A2AJsonRpcRequest = {
      jsonrpc: '2.0',
      method: 'message/send',
      params: {
        message: {
          parts: [{ data: { skill: 'nonexistent_skill' } }],
        },
      },
      id: 'test-caps',
    };

    const response = await handleGatewayJsonRpc(request, supabase, BASE_URL);
    expect(response.error).toBeUndefined();
    const data = getResultData(response);
    expect(data!.availableSkills).toBeDefined();
    const skillIds = data!.availableSkills.map((s: any) => s.id);
    expect(skillIds).toContain('register_agent');
    expect(skillIds).toContain('update_agent');
    expect(skillIds).toContain('get_my_status');
    expect(skillIds).toContain('manage_wallet');
    expect(skillIds).toContain('check_task');
    expect(skillIds).toContain('find_agent');
    expect(skillIds).toContain('list_agents');
  });
});
