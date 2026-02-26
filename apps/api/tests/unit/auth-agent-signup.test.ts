import { describe, it, expect, vi, beforeEach } from 'vitest';
import app from '../../src/app.js';

// Mock Supabase client
const insertResults: Record<string, any> = {};
const selectResults: Record<string, any> = {};

vi.mock('../../src/db/client.js', () => ({
  createClient: vi.fn(() => ({
    from: vi.fn((table: string) => {
      if (table === 'tenants') {
        return {
          insert: vi.fn(() => ({
            select: vi.fn(() => ({
              single: vi.fn(() => Promise.resolve(
                insertResults.tenants || {
                  data: { id: 'tenant-agent-001', name: 'TestBot (Agent)', status: 'active', is_agent_tenant: true },
                  error: null,
                }
              )),
            })),
          })),
          delete: vi.fn(() => ({
            eq: vi.fn(() => Promise.resolve({ error: null })),
          })),
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(() => Promise.resolve(
                selectResults.tenants || { data: null, error: null }
              )),
            })),
          })),
          update: vi.fn(() => ({
            eq: vi.fn(() => Promise.resolve({ error: null })),
          })),
        };
      }
      if (table === 'accounts') {
        return {
          insert: vi.fn(() => ({
            select: vi.fn(() => ({
              single: vi.fn(() => Promise.resolve(
                insertResults.accounts || {
                  data: { id: 'account-agent-001', type: 'agent', name: 'TestBot' },
                  error: null,
                }
              )),
            })),
          })),
          delete: vi.fn(() => ({
            eq: vi.fn(() => Promise.resolve({ error: null })),
          })),
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(() => Promise.resolve({ data: null, error: null })),
              eq: vi.fn(() => ({
                single: vi.fn(() => Promise.resolve({ data: null, error: null })),
              })),
            })),
          })),
          update: vi.fn(() => ({
            in: vi.fn(() => Promise.resolve({ error: null })),
          })),
        };
      }
      if (table === 'agents') {
        return {
          insert: vi.fn(() => ({
            select: vi.fn(() => ({
              single: vi.fn(() => Promise.resolve(
                insertResults.agents || {
                  data: {
                    id: 'agent-001', tenant_id: 'tenant-agent-001',
                    name: 'TestBot', status: 'active', type: 'custom',
                    kya_tier: 0, kya_status: 'unverified',
                    parent_account_id: null,
                    auth_token_prefix: 'agent_mock12',
                    permissions: {},
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                  },
                  error: null,
                }
              )),
            })),
          })),
          delete: vi.fn(() => ({
            eq: vi.fn(() => Promise.resolve({ error: null })),
          })),
        };
      }
      if (table === 'wallets') {
        return {
          insert: vi.fn(() => ({
            select: vi.fn(() => ({
              single: vi.fn(() => Promise.resolve(
                insertResults.wallets || {
                  data: { id: 'wallet-001', balance: 0, currency: 'USDC', wallet_address: 'internal://test' },
                  error: null,
                }
              )),
            })),
          })),
          update: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => Promise.resolve({ error: null })),
            })),
          })),
        };
      }
      if (table === 'kya_tier_limits') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(() => Promise.resolve({
                data: { per_transaction: 10, daily: 50, monthly: 200 },
                error: null,
              })),
            })),
          })),
        };
      }
      if (table === 'api_keys') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                single: vi.fn(() => Promise.resolve(
                  selectResults.api_keys || { data: null, error: null }
                )),
              })),
            })),
          })),
        };
      }
      if (table === 'audit_logs') {
        return {
          insert: vi.fn(() => Promise.resolve({ error: null })),
        };
      }
      // Default: return chainable mock
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            single: vi.fn(() => Promise.resolve({ data: null, error: null })),
          })),
        })),
        insert: vi.fn(() => Promise.resolve({ error: null })),
      };
    }),
    auth: {
      getUser: vi.fn(() => ({ data: { user: null }, error: { message: 'Invalid token' } })),
    },
  })),
}));

// Mock admin client
vi.mock('../../src/db/admin-client.js', () => ({
  createAdminClient: vi.fn(() => ({
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          single: vi.fn(() => ({ data: null, error: null })),
        })),
      })),
    })),
  })),
}));

// Mock auth utils
vi.mock('../../src/utils/auth.js', () => ({
  validatePassword: vi.fn(() => ({ valid: true, errors: [] })),
  generateApiKey: vi.fn((env: string) => `pk_${env}_mock_key`),
  hashApiKey: vi.fn((key: string) => `hash_${key}`),
  getKeyPrefix: vi.fn((key: string) => key.slice(0, 12)),
  checkRateLimit: vi.fn(() => ({ allowed: true, retryAfter: 0 })),
  logSecurityEvent: vi.fn(),
  addRandomDelay: vi.fn(),
}));

// Mock crypto utils
vi.mock('../../src/utils/crypto.js', () => ({
  generateAgentToken: vi.fn(() => 'agent_mock_token_123456789012'),
  hashApiKey: vi.fn((key: string) => `hash_${key}`),
  getKeyPrefix: vi.fn((key: string) => key.slice(0, 12)),
}));

// Mock helpers
vi.mock('../../src/utils/helpers.js', () => ({
  logAudit: vi.fn(() => Promise.resolve()),
  isValidUUID: vi.fn(() => true),
  mapAgentFromDb: vi.fn((row: any) => ({
    id: row.id,
    name: row.name,
    status: row.status,
    type: row.type,
    kyaTier: row.kya_tier,
    kyaStatus: row.kya_status,
  })),
  getPaginationParams: vi.fn(() => ({ page: 1, limit: 20 })),
  paginationResponse: vi.fn(),
  normalizeFields: vi.fn((data: any) => ({ data, deprecatedFieldsUsed: [] })),
  buildDeprecationHeader: vi.fn(() => null),
  sanitizeSearchInput: vi.fn((s: string) => s),
}));

describe('POST /v1/auth/agent-signup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset insert results
    Object.keys(insertResults).forEach(k => delete insertResults[k]);
    Object.keys(selectResults).forEach(k => delete selectResults[k]);
  });

  it('successfully registers a new autonomous agent', async () => {
    const res = await app.request('/v1/auth/agent-signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'TestBot',
        purpose: 'Automated testing',
        capabilities: ['api_calls', 'payments'],
        model: 'claude-4',
      }),
    });

    expect(res.status).toBe(201);
    const json = await res.json();
    const data = json.data || json;

    expect(data.agent).toBeDefined();
    expect(data.agent.id).toBe('agent-001');
    expect(data.agent.name).toBe('TestBot');
    expect(data.agent.kyaTier).toBe(0);

    expect(data.credentials).toBeDefined();
    expect(data.credentials.token).toContain('agent_');
    expect(data.credentials.warning).toContain('Save this token');

    expect(data.tenant).toBeDefined();
    expect(data.tenant.id).toBe('tenant-agent-001');

    expect(data.wallet).toBeDefined();
    expect(data.wallet.id).toBe('wallet-001');

    expect(data.limits).toBeDefined();
    expect(data.limits.tier).toBe(0);
    expect(data.limits.perTransaction).toBe(10);
  });

  it('rejects requests without a name', async () => {
    const res = await app.request('/v1/auth/agent-signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ purpose: 'testing' }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('Validation failed');
  });

  it('rejects requests with invalid JSON', async () => {
    const res = await app.request('/v1/auth/agent-signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });

    expect(res.status).toBe(400);
  });

  it('returns 429 when rate limited', async () => {
    const { checkRateLimit } = await import('../../src/utils/auth.js');
    (checkRateLimit as any).mockReturnValueOnce({ allowed: false, retryAfter: 3600 });

    const res = await app.request('/v1/auth/agent-signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'RateLimitBot' }),
    });

    expect(res.status).toBe(429);
    const data = await res.json();
    expect(data.error).toContain('Too many');
    expect(data.retryAfter).toBe(3600);
  });

  it('returns 500 when tenant creation fails', async () => {
    insertResults.tenants = { data: null, error: { message: 'DB error' } };

    const res = await app.request('/v1/auth/agent-signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'FailBot' }),
    });

    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toContain('Failed to register agent');
  });

  it('works with minimal input (name only)', async () => {
    const res = await app.request('/v1/auth/agent-signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'MinimalBot' }),
    });

    expect(res.status).toBe(201);
    const json = await res.json();
    const data = json.data || json;
    expect(data.agent).toBeDefined();
    expect(data.credentials).toBeDefined();
  });

  it('does not require authentication', async () => {
    // No Authorization header — should still work
    const res = await app.request('/v1/auth/agent-signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'PublicBot' }),
    });

    expect(res.status).toBe(201);
  });
});
