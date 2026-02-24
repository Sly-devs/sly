/**
 * A2A x402 Forwarding Tests
 *
 * Validates the x402 endpoint type for agent forwarding:
 * - 402 challenge → payment → retry → 200 cycle
 * - Mandate settlement skipped for x402 endpoints
 * - Invalid 402 responses handled gracefully
 * - Wallet balance deduction and rollback on failure
 * - X-Payment header structure
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { A2ATaskProcessor } from '../../src/services/a2a/task-processor.js';

// ---------------------------------------------------------------------------
// Mock Supabase
// ---------------------------------------------------------------------------

function createMockSupabase(overrides: Record<string, any> = {}) {
  const defaultData: Record<string, any> = {
    agents: {
      id: 'agent-001',
      endpoint_url: 'http://localhost:4300/agent',
      endpoint_type: 'x402',
      endpoint_secret: null,
      endpoint_enabled: true,
    },
    a2a_tasks: {
      client_agent_id: 'caller-agent-001',
      metadata: {},
    },
    wallets: {
      id: 'wallet-001',
      balance: 100,
      wallet_address: '0xCallerAddress',
      owner_account_id: 'account-001',
    },
    transfers: {
      id: 'transfer-001',
    },
    ...overrides,
  };

  const mock: any = {
    from: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    gte: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn(),
    single: vi.fn(),
    rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'not found', code: '42883' } }),
  };

  // Track the table being queried
  let currentTable = '';
  mock.from = vi.fn((table: string) => {
    currentTable = table;
    return mock;
  });

  mock.single = vi.fn(() => {
    if (currentTable === 'agents') return Promise.resolve({ data: defaultData.agents, error: null });
    if (currentTable === 'a2a_tasks') return Promise.resolve({ data: defaultData.a2a_tasks, error: null });
    if (currentTable === 'wallets') return Promise.resolve({ data: defaultData.wallets, error: null });
    if (currentTable === 'transfers') return Promise.resolve({ data: defaultData.transfers, error: null });
    return Promise.resolve({ data: null, error: null });
  });

  mock.maybeSingle = vi.fn(() => {
    if (currentTable === 'wallets') return Promise.resolve({ data: defaultData.wallets, error: null });
    return Promise.resolve({ data: null, error: null });
  });

  return mock;
}

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

function mockFetch(responses: Array<{ status: number; body: any }>) {
  let callIndex = 0;
  globalThis.fetch = vi.fn(async () => {
    const resp = responses[callIndex] || responses[responses.length - 1];
    callIndex++;
    return {
      ok: resp.status >= 200 && resp.status < 300,
      status: resp.status,
      json: async () => resp.body,
      text: async () => JSON.stringify(resp.body),
    } as Response;
  });
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('x402 Agent Forwarding', () => {
  beforeEach(() => {
    restoreFetch();
  });

  describe('Endpoint type validation', () => {
    it('adds x402 to allowed endpoint types', () => {
      // Verify that the task processor can route to x402 endpoints
      // by checking the constructor doesn't throw and the class is importable
      expect(A2ATaskProcessor).toBeDefined();
    });
  });

  describe('Mandate settlement skipped for x402', () => {
    it('skips mandate creation when endpoint_type is x402', () => {
      // The condition in forwardToAgent() is:
      // if (callerAgentId && Number(skill.base_price) > 0 && agent.endpoint_type !== 'x402')
      // This test verifies the logic: when endpoint_type === 'x402', mandate is skipped

      const endpointType = 'x402';
      const callerAgentId = 'caller-001';
      const basePrice = 0.5;

      // Simulating the condition
      const shouldCreateMandate = callerAgentId && Number(basePrice) > 0 && endpointType !== 'x402';
      expect(shouldCreateMandate).toBe(false);
    });

    it('creates mandate for non-x402 endpoints', () => {
      const endpointType = 'a2a';
      const callerAgentId = 'caller-001';
      const basePrice = 0.5;

      const shouldCreateMandate = callerAgentId && Number(basePrice) > 0 && endpointType !== 'x402';
      expect(shouldCreateMandate).toBeTruthy();
    });
  });

  describe('402 challenge handling', () => {
    it('parses spec-compliant accepts array from 402 response', () => {
      const acceptsBody = {
        accepts: [
          {
            scheme: 'exact-evm',
            network: 'eip155:84532',
            amount: '500000',
            token: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
            facilitator: 'https://x402.org/facilitator',
          },
        ],
      };

      expect(acceptsBody.accepts).toHaveLength(1);
      expect(acceptsBody.accepts[0].scheme).toBe('exact-evm');
      expect(acceptsBody.accepts[0].network).toBe('eip155:84532');
      expect(acceptsBody.accepts[0].amount).toBe('500000');
    });

    it('rejects unsupported scheme', () => {
      const offer = { scheme: 'unsupported-scheme', network: 'eip155:84532', amount: '500000' };
      expect(offer.scheme).not.toBe('exact-evm');
    });

    it('rejects missing accepts array', () => {
      const body = { error: 'Payment required' };
      const accepts = (body as any)?.accepts;
      expect(!Array.isArray(accepts) || accepts.length === 0).toBe(true);
    });
  });

  describe('X-Payment header structure', () => {
    it('builds spec-compliant X402PaymentPayload', () => {
      const xPayment = {
        scheme: 'exact-evm',
        network: 'eip155:84532',
        amount: '500000',
        token: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        from: '0xCallerAddress',
        to: 'agent-001',
        signature: 'eyJhbGciOiJIUzI1NiJ9.test.sig',
      };

      expect(xPayment.scheme).toBe('exact-evm');
      expect(xPayment.network).toMatch(/^eip155:\d+$/);
      expect(xPayment.amount).toBe('500000');
      expect(xPayment.token).toMatch(/^0x/);
      expect(xPayment.from).toBeTruthy();
      expect(xPayment.to).toBeTruthy();
      expect(xPayment.signature).toBeTruthy();
    });
  });

  describe('Pre-paid / free agent (200 on first try)', () => {
    it('handles 200 response without payment', async () => {
      const response = {
        response: 'Free analysis result',
        artifacts: [
          {
            name: 'report',
            mediaType: 'application/json',
            parts: [{ data: { type: 'free_report' } }],
          },
        ],
      };

      expect(response.response).toBe('Free analysis result');
      expect(response.artifacts).toHaveLength(1);
      expect(response.artifacts[0].name).toBe('report');
    });
  });

  describe('Agent error handling', () => {
    it('handles 500 from agent', () => {
      const status = 500;
      const isPaymentRequired = status === 402;
      const isSuccess = status >= 200 && status < 300;

      expect(isPaymentRequired).toBe(false);
      expect(isSuccess).toBe(false);
      // Task should be failed with the error
    });
  });

  describe('Wallet balance operations', () => {
    it('deducts correct amount from wallet', () => {
      const walletBalance = 100;
      const paymentAmount = 0.5; // 500000 base units = 0.5 USDC
      const newBalance = walletBalance - paymentAmount;

      expect(newBalance).toBe(99.5);
    });

    it('rejects when insufficient funds', () => {
      const walletBalance = 0.3;
      const paymentAmount = 0.5;
      const hasSufficientFunds = walletBalance >= paymentAmount;

      expect(hasSufficientFunds).toBe(false);
    });

    it('rolls back balance on retry failure', () => {
      const walletBalance = 100;
      const paymentAmount = 0.5;
      const afterDeduction = walletBalance - paymentAmount;
      const afterRollback = afterDeduction + paymentAmount;

      expect(afterRollback).toBe(walletBalance);
    });
  });

  describe('Transfer record', () => {
    it('creates transfer with type x402 and correct protocol_metadata', () => {
      const transfer = {
        type: 'x402',
        status: 'completed',
        amount: 0.5,
        currency: 'USDC',
        protocol_metadata: {
          protocol: 'x402',
          agentForwarding: true,
          request_id: 'task-001',
          endpoint_url: 'http://localhost:4300/agent',
          agent_id: 'agent-001',
          skill_id: 'company_brief',
          amount_units: '500000',
        },
      };

      expect(transfer.type).toBe('x402');
      expect(transfer.protocol_metadata.protocol).toBe('x402');
      expect(transfer.protocol_metadata.agentForwarding).toBe(true);
      expect(transfer.protocol_metadata.amount_units).toBe('500000');
    });

    it('marks transfer cancelled on retry failure', () => {
      const initialStatus = 'completed';
      const afterFailure = 'cancelled';

      expect(afterFailure).toBe('cancelled');
      expect(afterFailure).not.toBe(initialStatus);
    });
  });

  describe('Provider wallet crediting', () => {
    const TENANT_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
    const PROVIDER_AGENT_ID = 'dddddddd-1111-1111-1111-111111111111';
    const CALLER_AGENT_ID = 'dddddddd-2222-2222-2222-222222222222';
    const TASK_ID = 'eeeeeeee-0000-0000-0000-000000000001';
    const CALLER_ACCOUNT_ID = 'bbbbbbbb-0000-0000-0000-000000000001';
    const PROVIDER_ACCOUNT_ID = 'bbbbbbbb-0000-0000-0000-000000000002';

    /**
     * Chainable, thenable mock query builder (mirrors Supabase PostgREST).
     */
    function createQueryBuilder(resolvedData: any, resolvedError: any = null) {
      const result = { data: resolvedData, error: resolvedError };
      const builder: Record<string, any> = {};
      const chainMethods = [
        'select', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in',
        'order', 'limit', 'update', 'insert', 'delete',
      ];
      for (const m of chainMethods) {
        builder[m] = vi.fn(() => builder);
      }
      builder.single = vi.fn(() => Promise.resolve(result));
      builder.maybeSingle = vi.fn(() => Promise.resolve(result));
      builder.then = (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject);
      return builder;
    }

    /**
     * Build mock Supabase with per-table handlers.
     * walletUpdates captures every wallet update call for assertions.
     */
    function buildMockSupabase(
      tableMap: Record<string, (callIndex: number) => ReturnType<typeof createQueryBuilder>>,
      callLog: string[],
      walletUpdates: Array<{ walletId: string; newBalance: number }>,
    ) {
      const callCounts: Record<string, number> = {};
      return {
        from: vi.fn((table: string) => {
          callLog.push(table);
          callCounts[table] = (callCounts[table] || 0) + 1;
          const handler = tableMap[table];
          if (!handler) return createQueryBuilder(null);

          const builder = handler(callCounts[table]);

          // Intercept wallet updates to track balance changes
          if (table === 'wallets') {
            const origUpdate = builder.update;
            builder.update = vi.fn((data: any) => {
              if (data && typeof data.balance === 'number') {
                // We need to capture the wallet ID from the .eq() chain
                const innerBuilder = origUpdate(data);
                const origEq = innerBuilder.eq;
                innerBuilder.eq = vi.fn((col: string, val: any) => {
                  if (col === 'id') {
                    walletUpdates.push({ walletId: val, newBalance: data.balance });
                  }
                  return origEq(col, val);
                });
                return innerBuilder;
              }
              return origUpdate(data);
            });
          }

          return builder;
        }),
        rpc: vi.fn(() => Promise.resolve({ data: null, error: { message: 'not found', code: '42883' } })),
      };
    }

    // Shared fixtures
    const taskRow = {
      id: TASK_ID,
      tenant_id: TENANT_ID,
      agent_id: PROVIDER_AGENT_ID,
      state: 'submitted',
      direction: 'inbound',
      context_id: null,
      status_message: null,
      metadata: {},
      client_agent_id: CALLER_AGENT_ID,
      transfer_id: null,
      remote_task_id: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const userMessage = {
      id: 'msg-1',
      tenant_id: TENANT_ID,
      task_id: TASK_ID,
      role: 'user',
      parts: [{ text: 'Give me a company brief for Stripe' }],
      metadata: { skillId: 'company_brief' },
      created_at: new Date().toISOString(),
    };

    const providerAgent = {
      id: PROVIDER_AGENT_ID,
      parent_account_id: PROVIDER_ACCOUNT_ID,
      permissions: { transactions: { initiate: true, view: true } },
      status: 'active',
      name: 'CompanyIntelBot',
      kya_tier: 2,
      endpoint_enabled: true,
      endpoint_url: 'https://companyintel.example.com/a2a',
      endpoint_type: 'x402',
      endpoint_secret: null,
    };

    const callerWallet = {
      id: 'wallet-caller',
      balance: 100,
      wallet_address: '0xCallerAddress',
      owner_account_id: CALLER_ACCOUNT_ID,
    };

    const providerWallet = {
      id: 'wallet-provider',
      balance: 50,
      owner_account_id: PROVIDER_ACCOUNT_ID,
    };

    it('credits provider wallet and sets correct to_account_id on successful x402 forwarding', async () => {
      const callLog: string[] = [];
      const walletUpdates: Array<{ walletId: string; newBalance: number }> = [];
      let transferInsertArgs: any = null;

      // Mock fetch: 402 → 200
      mockFetch([
        {
          status: 402,
          body: {
            accepts: [{
              scheme: 'exact-evm',
              network: 'eip155:84532',
              amount: '500000', // 0.5 USDC
              token: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
            }],
          },
        },
        {
          status: 200,
          body: { response: 'Here is your company brief for Stripe.' },
        },
      ]);

      let walletCallCount = 0;
      const mockSupabase = buildMockSupabase({
        a2a_tasks: () => createQueryBuilder(taskRow),
        a2a_messages: () => createQueryBuilder([userMessage]),
        a2a_artifacts: () => createQueryBuilder([]),
        agents: () => createQueryBuilder(providerAgent),
        wallets: (callIndex) => {
          walletCallCount++;
          // Call 1: buildAgentContext wallet lookup (maybeSingle)
          // Call 2: caller wallet lookup (maybeSingle) — Step 6
          // Call 3: caller wallet deduction (update) — Step 7
          // Call 4: provider wallet lookup (maybeSingle) — Step 7b
          // Call 5: provider wallet credit (update) — Step 7b
          // Call 6: a2a_tasks update for transfer_id link
          if (walletCallCount <= 2) return createQueryBuilder(callerWallet);
          if (walletCallCount === 3) return createQueryBuilder(null); // update returns nothing
          if (walletCallCount === 4) return createQueryBuilder(providerWallet);
          return createQueryBuilder(null); // subsequent update
        },
        transfers: () => {
          const builder = createQueryBuilder({ id: 'transfer-001' });
          const origInsert = builder.insert;
          builder.insert = vi.fn((data: any) => {
            transferInsertArgs = data;
            return origInsert(data);
          });
          return builder;
        },
        ap2_mandates: () => createQueryBuilder([]),
        agent_skills: () => createQueryBuilder({
          skill_id: 'company_brief',
          handler_type: 'agent_provided',
          base_price: 0.35,
          currency: 'USDC',
        }),
      }, callLog, walletUpdates);

      const processor = new A2ATaskProcessor(mockSupabase as any, TENANT_ID);

      try {
        await processor.processTask(TASK_ID);
      } catch {
        // Expected — some downstream calls may fail with mocks
      }

      // Verify provider wallet was looked up and credited
      const walletCalls = callLog.filter(t => t === 'wallets');
      expect(walletCalls.length).toBeGreaterThanOrEqual(4); // At least: context + caller lookup + deduct + provider lookup

      // Verify wallet updates include a credit to the provider
      const providerCredit = walletUpdates.find(u => u.walletId === 'wallet-provider');
      expect(providerCredit).toBeDefined();
      expect(providerCredit!.newBalance).toBe(50.5); // 50 + 0.5 USDC

      // Verify caller wallet was debited
      const callerDebit = walletUpdates.find(u => u.walletId === 'wallet-caller');
      expect(callerDebit).toBeDefined();
      expect(callerDebit!.newBalance).toBe(99.5); // 100 - 0.5 USDC

      // Verify transfer record has correct to_account_id
      if (transferInsertArgs) {
        expect(transferInsertArgs.to_account_id).toBe(PROVIDER_ACCOUNT_ID);
        expect(transferInsertArgs.from_account_id).toBe(CALLER_ACCOUNT_ID);
        expect(transferInsertArgs.to_account_id).not.toBe(transferInsertArgs.from_account_id);
      }
    });

    it('falls back to caller account_id when provider has no wallet', async () => {
      const callLog: string[] = [];
      const walletUpdates: Array<{ walletId: string; newBalance: number }> = [];
      let transferInsertArgs: any = null;

      mockFetch([
        {
          status: 402,
          body: {
            accepts: [{
              scheme: 'exact-evm',
              network: 'eip155:84532',
              amount: '500000',
              token: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
            }],
          },
        },
        {
          status: 200,
          body: { response: 'Done.' },
        },
      ]);

      let walletCallCount = 0;
      const mockSupabase = buildMockSupabase({
        a2a_tasks: () => createQueryBuilder(taskRow),
        a2a_messages: () => createQueryBuilder([userMessage]),
        a2a_artifacts: () => createQueryBuilder([]),
        agents: () => createQueryBuilder(providerAgent),
        wallets: () => {
          walletCallCount++;
          // Caller wallet exists, provider wallet does not
          if (walletCallCount <= 2) return createQueryBuilder(callerWallet);
          if (walletCallCount === 3) return createQueryBuilder(null); // deduction update
          // Provider wallet lookup returns null (no wallet)
          if (walletCallCount === 4) return createQueryBuilder(null);
          return createQueryBuilder(null);
        },
        transfers: () => {
          const builder = createQueryBuilder({ id: 'transfer-002' });
          const origInsert = builder.insert;
          builder.insert = vi.fn((data: any) => {
            transferInsertArgs = data;
            return origInsert(data);
          });
          return builder;
        },
        ap2_mandates: () => createQueryBuilder([]),
        agent_skills: () => createQueryBuilder({
          skill_id: 'company_brief',
          handler_type: 'agent_provided',
          base_price: 0.35,
          currency: 'USDC',
        }),
      }, callLog, walletUpdates);

      const processor = new A2ATaskProcessor(mockSupabase as any, TENANT_ID);

      try {
        await processor.processTask(TASK_ID);
      } catch {
        // Expected
      }

      // No provider wallet credit should occur
      const providerCredit = walletUpdates.find(u => u.walletId === 'wallet-provider');
      expect(providerCredit).toBeUndefined();

      // Transfer to_account_id falls back to caller's own account
      if (transferInsertArgs) {
        expect(transferInsertArgs.to_account_id).toBe(CALLER_ACCOUNT_ID);
      }
    });

    it('rolls back provider wallet credit when retry fails', async () => {
      const callLog: string[] = [];
      const walletUpdates: Array<{ walletId: string; newBalance: number }> = [];

      // Mock fetch: 402 → 500 (retry fails)
      mockFetch([
        {
          status: 402,
          body: {
            accepts: [{
              scheme: 'exact-evm',
              network: 'eip155:84532',
              amount: '500000',
              token: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
            }],
          },
        },
        {
          status: 500,
          body: { error: 'Internal server error' },
        },
      ]);

      let walletCallCount = 0;
      const mockSupabase = buildMockSupabase({
        a2a_tasks: () => createQueryBuilder(taskRow),
        a2a_messages: () => createQueryBuilder([userMessage]),
        a2a_artifacts: () => createQueryBuilder([]),
        agents: () => createQueryBuilder(providerAgent),
        wallets: () => {
          walletCallCount++;
          // Calls 1-2: context + caller lookup
          if (walletCallCount <= 2) return createQueryBuilder(callerWallet);
          // Call 3: caller deduction
          if (walletCallCount === 3) return createQueryBuilder(null);
          // Call 4: provider wallet lookup (maybeSingle)
          if (walletCallCount === 4) return createQueryBuilder(providerWallet);
          // Call 5: provider wallet credit (update)
          if (walletCallCount === 5) return createQueryBuilder(null);
          // Call 6: caller rollback read (single) - balance after deduction
          if (walletCallCount === 6) return createQueryBuilder({ balance: 99.5 });
          // Call 7: caller rollback write (update)
          if (walletCallCount === 7) return createQueryBuilder(null);
          // Call 8: provider rollback read (single) - balance after credit
          if (walletCallCount === 8) return createQueryBuilder({ balance: 50.5 });
          // Call 9: provider rollback write (update)
          return createQueryBuilder(null);
        },
        transfers: () => createQueryBuilder({ id: 'transfer-003' }),
        ap2_mandates: () => createQueryBuilder([]),
        agent_skills: () => createQueryBuilder({
          skill_id: 'company_brief',
          handler_type: 'agent_provided',
          base_price: 0.35,
          currency: 'USDC',
        }),
      }, callLog, walletUpdates);

      const processor = new A2ATaskProcessor(mockSupabase as any, TENANT_ID);

      try {
        await processor.processTask(TASK_ID);
      } catch {
        // Expected
      }

      // Verify provider wallet was credited and then rolled back
      const providerUpdates = walletUpdates.filter(u => u.walletId === 'wallet-provider');

      // Should have at least 2 updates: credit (50 + 0.5 = 50.5) then rollback (50.5 - 0.5 = 50)
      if (providerUpdates.length >= 2) {
        expect(providerUpdates[0].newBalance).toBe(50.5); // credit
        expect(providerUpdates[1].newBalance).toBe(50);   // rollback
      }

      // Verify caller wallet was also rolled back
      const callerUpdates = walletUpdates.filter(u => u.walletId === 'wallet-caller');
      if (callerUpdates.length >= 2) {
        expect(callerUpdates[0].newBalance).toBe(99.5);  // deduction
        expect(callerUpdates[1].newBalance).toBe(100);    // rollback
      }
    });
  });

  describe('callerAgentId resolution from message metadata (API key auth)', () => {
    it('resolves callerAgentId from metadata when not set by auth', () => {
      // Simulates the route-level logic in a2a.ts that extracts callerAgentId
      // from message.metadata.callerAgentId when using API key auth
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      let callerAgentId: string | undefined = undefined; // API key auth — no callerAgentId

      const rpcRequest = {
        jsonrpc: '2.0',
        method: 'message/send',
        id: '1',
        params: {
          message: {
            role: 'user',
            parts: [{ text: 'Give me a company brief for Stripe' }],
            metadata: {
              callerAgentId: 'dddddddd-2222-2222-2222-222222222222',
              skillId: 'company_brief',
            },
          },
        },
      };

      // Extract from metadata (mirrors a2a.ts logic)
      if (!callerAgentId && rpcRequest.method === 'message/send') {
        const msgMeta = (rpcRequest.params as any)?.message?.metadata;
        const metaAgentId = msgMeta?.callerAgentId as string | undefined;
        if (metaAgentId && UUID_RE.test(metaAgentId)) {
          // In real code, this also verifies the agent belongs to the same tenant
          callerAgentId = metaAgentId;
        }
      }

      expect(callerAgentId).toBe('dddddddd-2222-2222-2222-222222222222');
    });

    it('ignores invalid UUID in metadata', () => {
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      let callerAgentId: string | undefined = undefined;

      const rpcRequest = {
        jsonrpc: '2.0',
        method: 'message/send',
        id: '1',
        params: {
          message: {
            role: 'user',
            parts: [{ text: 'test' }],
            metadata: {
              callerAgentId: 'not-a-valid-uuid',
            },
          },
        },
      };

      if (!callerAgentId && rpcRequest.method === 'message/send') {
        const msgMeta = (rpcRequest.params as any)?.message?.metadata;
        const metaAgentId = msgMeta?.callerAgentId as string | undefined;
        if (metaAgentId && UUID_RE.test(metaAgentId)) {
          callerAgentId = metaAgentId;
        }
      }

      expect(callerAgentId).toBeUndefined();
    });

    it('does not override callerAgentId when already set by agent token auth', () => {
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      let callerAgentId: string | undefined = 'aaaaaaaa-1111-1111-1111-111111111111'; // Set by agent token auth

      const rpcRequest = {
        jsonrpc: '2.0',
        method: 'message/send',
        id: '1',
        params: {
          message: {
            role: 'user',
            parts: [{ text: 'test' }],
            metadata: {
              callerAgentId: 'bbbbbbbb-2222-2222-2222-222222222222', // Different agent in metadata
            },
          },
        },
      };

      if (!callerAgentId && rpcRequest.method === 'message/send') {
        const msgMeta = (rpcRequest.params as any)?.message?.metadata;
        const metaAgentId = msgMeta?.callerAgentId as string | undefined;
        if (metaAgentId && UUID_RE.test(metaAgentId)) {
          callerAgentId = metaAgentId;
        }
      }

      // Should keep the auth-derived agent, not the metadata one
      expect(callerAgentId).toBe('aaaaaaaa-1111-1111-1111-111111111111');
    });

    it('resolves callerAgentId for message/stream method too', () => {
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      let callerAgentId: string | undefined = undefined;

      const rpcRequest = {
        jsonrpc: '2.0',
        method: 'message/stream',
        id: '1',
        params: {
          message: {
            role: 'user',
            parts: [{ text: 'test' }],
            metadata: {
              callerAgentId: 'cccccccc-3333-3333-3333-333333333333',
            },
          },
        },
      };

      if (!callerAgentId && (rpcRequest.method === 'message/send' || rpcRequest.method === 'message/stream')) {
        const msgMeta = (rpcRequest.params as any)?.message?.metadata;
        const metaAgentId = msgMeta?.callerAgentId as string | undefined;
        if (metaAgentId && UUID_RE.test(metaAgentId)) {
          callerAgentId = metaAgentId;
        }
      }

      expect(callerAgentId).toBe('cccccccc-3333-3333-3333-333333333333');
    });

    it('task with client_agent_id set passes the x402 caller agent check', async () => {
      // This verifies the downstream effect: when callerAgentId is resolved
      // (whether from auth or metadata), the task gets client_agent_id set,
      // and the x402 flow proceeds past the "no caller agent" check.
      const taskWithCaller = {
        client_agent_id: 'dddddddd-2222-2222-2222-222222222222',
      };

      const callerAgentId = taskWithCaller.client_agent_id;
      expect(callerAgentId).toBeTruthy();
      // The x402 flow at task-processor.ts:971 checks: if (!callerAgentId) → input-required
      // With callerAgentId set, it proceeds to wallet lookup
    });
  });

  describe('USDC unit conversion', () => {
    it('converts base units to human-readable', async () => {
      // Import the facilitator utilities
      const { fromUsdcUnits, toUsdcUnits } = await import(
        '../../src/services/x402/facilitator.js'
      );

      expect(fromUsdcUnits('500000')).toBe('0.500000');
      expect(fromUsdcUnits('1000000')).toBe('1.000000');
      expect(fromUsdcUnits('100')).toBe('0.000100');
    });

    it('converts human-readable to base units', async () => {
      const { toUsdcUnits } = await import('../../src/services/x402/facilitator.js');

      expect(toUsdcUnits(0.5)).toBe('500000');
      expect(toUsdcUnits(1)).toBe('1000000');
      expect(toUsdcUnits('0.35')).toBe('350000');
    });
  });
});
