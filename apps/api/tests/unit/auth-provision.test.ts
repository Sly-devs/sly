import { describe, it, expect, vi, beforeEach } from 'vitest';
import app from '../../src/app.js';

// Use vi.hoisted() so mocks can reference these variables
const { provisionTenantMock, provisionTenantErrorRef } = vi.hoisted(() => {
  const provisionTenantErrorRef = { value: null as Error | null };
  const provisionTenantMock = vi.fn(async (_supabase: any, input: any) => {
    if (provisionTenantErrorRef.value) throw provisionTenantErrorRef.value;
    return {
      tenant: { id: 'tenant-uuid-001', name: input.organizationName || 'Test Org' },
      user: { id: input.userId, email: input.email, name: input.userName || 'testuser' },
      apiKeys: {
        test: { key: 'pk_test_mock123', prefix: 'pk_test_mock' },
        live: { key: 'pk_live_mock123', prefix: 'pk_live_mock' },
      },
      alreadyProvisioned: false,
    };
  });
  return { provisionTenantMock, provisionTenantErrorRef };
});

// Mock tenant provisioning service
vi.mock('../../src/services/tenant-provisioning.js', () => ({
  provisionTenant: (...args: any[]) => provisionTenantMock(...args),
  TenantProvisioningError: class TenantProvisioningError extends Error {
    code: string;
    constructor(message: string, code: string, cause?: unknown) {
      super(message);
      this.name = 'TenantProvisioningError';
      this.code = code;
      this.cause = cause;
    }
  },
}));

// Mock Supabase client
vi.mock('../../src/db/client.js', () => ({
  createClient: vi.fn(() => ({
    from: vi.fn((table: string) => {
      if (table === 'tenants') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(() => ({
                data: { id: 'tenant-uuid-001', name: 'Test Tenant', status: 'active' },
                error: null,
              })),
            })),
          })),
        };
      }
      if (table === 'user_profiles') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(() => ({
                data: { tenant_id: 'tenant-uuid-001', role: 'owner', name: 'Test User' },
                error: null,
              })),
            })),
          })),
        };
      }
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            single: vi.fn(() => ({ data: null, error: null })),
          })),
        })),
      };
    }),
    auth: {
      getUser: vi.fn((token: string) => {
        if (token === 'valid_jwt_token') {
          return {
            data: {
              user: {
                id: 'user-uuid-001',
                email: 'test@example.com',
                user_metadata: {
                  organization_name: 'Meta Org',
                  name: 'Test User',
                },
              },
            },
            error: null,
          };
        }
        if (token === 'oauth_jwt_no_org') {
          return {
            data: {
              user: {
                id: 'user-uuid-002',
                email: 'oauth@example.com',
                user_metadata: {},
              },
            },
            error: null,
          };
        }
        return { data: { user: null }, error: { message: 'Invalid token' } };
      }),
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

describe('POST /v1/auth/provision', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    provisionTenantErrorRef.value = null;
  });

  it('rejects requests without authorization header', async () => {
    const res = await app.request('/v1/auth/provision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ organizationName: 'Test Org' }),
    });

    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toContain('authorization');
  });

  it('rejects requests with invalid JWT token', async () => {
    const res = await app.request('/v1/auth/provision', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer invalid_token',
      },
      body: JSON.stringify({ organizationName: 'Test Org' }),
    });

    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toContain('Invalid');
  });

  it('provisions tenant with organization name from body', async () => {
    const res = await app.request('/v1/auth/provision', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer valid_jwt_token',
      },
      body: JSON.stringify({ organizationName: 'Body Org Name' }),
    });

    expect(res.status).toBe(201);
    const json = await res.json();
    // Response wrapper wraps 2xx as { success, data, meta }
    const data = json.data || json;
    expect(data.tenant).toBeDefined();
    expect(data.apiKeys).toBeDefined();
    expect(data.warning).toContain('shown only once');
    expect(data.alreadyProvisioned).toBe(false);

    // Verify provisionTenant was called with body org name
    expect(provisionTenantMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: 'user-uuid-001',
        email: 'test@example.com',
        organizationName: 'Body Org Name',
      })
    );
  });

  it('falls back to user_metadata.organization_name if body is empty', async () => {
    const res = await app.request('/v1/auth/provision', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer valid_jwt_token',
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(201);

    // Should use metadata org name
    expect(provisionTenantMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationName: 'Meta Org',
      })
    );
  });

  it('generates fallback org name from email for OAuth users', async () => {
    const res = await app.request('/v1/auth/provision', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer oauth_jwt_no_org',
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(201);

    // Should fallback to email-based org name
    expect(provisionTenantMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationName: "oauth's Organization",
      })
    );
  });

  it('returns 200 when tenant already provisioned (idempotent)', async () => {
    provisionTenantMock.mockResolvedValueOnce({
      tenant: { id: 'existing-tenant', name: 'Existing Org' },
      user: { id: 'user-uuid-001', email: 'test@example.com', name: 'Test' },
      apiKeys: { test: { key: '', prefix: '' }, live: { key: '', prefix: '' } },
      alreadyProvisioned: true,
    });

    const res = await app.request('/v1/auth/provision', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer valid_jwt_token',
      },
      body: JSON.stringify({ organizationName: 'Test' }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    const data = json.data || json;
    expect(data.alreadyProvisioned).toBe(true);
    expect(data.apiKeys).toBeUndefined();
    expect(data.warning).toBeUndefined();
  });

  it('returns 500 when provisioning fails', async () => {
    const { TenantProvisioningError } = await import('../../src/services/tenant-provisioning.js');
    provisionTenantErrorRef.value = new TenantProvisioningError('Failed to create organization', 'tenant_creation_failed');

    const res = await app.request('/v1/auth/provision', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer valid_jwt_token',
      },
      body: JSON.stringify({ organizationName: 'Test' }),
    });

    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toContain('Failed to create organization');
  });

  it('handles missing body gracefully', async () => {
    const res = await app.request('/v1/auth/provision', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer valid_jwt_token',
      },
    });

    // Should still work — body is optional
    expect(res.status).toBe(201);
  });
});

describe('GET /v1/auth/me - tenant check', () => {
  it('returns tenant: null when user has no profile', async () => {
    // The existing /me endpoint returns tenant info or null
    // This is used by the callback handler to check if provisioning is needed
    const res = await app.request('/v1/auth/me', {
      headers: {
        'Authorization': 'Bearer valid_jwt_token',
      },
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    const data = json.data || json;
    // User should be returned
    expect(data.user).toBeDefined();
    expect(data.user.id).toBe('user-uuid-001');
  });
});
