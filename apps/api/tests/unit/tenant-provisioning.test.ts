import { describe, it, expect, vi, beforeEach } from 'vitest';
import { provisionTenant, TenantProvisioningError } from '../../src/services/tenant-provisioning.js';

// Mock auth utilities
vi.mock('../../src/utils/auth.js', () => ({
  generateApiKey: vi.fn((env: string) => `pk_${env}_mock_key_12345678901234`),
  hashApiKey: vi.fn((key: string) => `hash_${key}`),
  getKeyPrefix: vi.fn((key: string) => key.slice(0, 12)),
  logSecurityEvent: vi.fn(),
}));

function createMockSupabase(overrides: Record<string, any> = {}) {
  const defaults: Record<string, any> = {
    user_profiles_select: { data: null, error: null },
    tenants_select: { data: null, error: null },
    tenants_insert: {
      data: { id: 'tenant-uuid-001', name: 'Test Org' },
      error: null,
    },
    user_profiles_insert: { error: null },
    tenant_settings_insert: { error: null },
    api_keys_insert: { error: null },
  };

  const cfg = { ...defaults, ...overrides };

  return {
    from: vi.fn((table: string) => {
      if (table === 'user_profiles') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(() => Promise.resolve(cfg.user_profiles_select)),
            })),
          })),
          insert: vi.fn(() => Promise.resolve(cfg.user_profiles_insert)),
        };
      }
      if (table === 'tenants') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(() => Promise.resolve(cfg.tenants_select)),
            })),
          })),
          insert: vi.fn(() => ({
            select: vi.fn(() => ({
              single: vi.fn(() => Promise.resolve(cfg.tenants_insert)),
            })),
          })),
          delete: vi.fn(() => ({
            eq: vi.fn(() => Promise.resolve({ error: null })),
          })),
        };
      }
      if (table === 'tenant_settings') {
        return {
          insert: vi.fn(() => Promise.resolve(cfg.tenant_settings_insert)),
        };
      }
      if (table === 'api_keys') {
        return {
          insert: vi.fn(() => Promise.resolve(cfg.api_keys_insert)),
        };
      }
      return {
        select: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(() => Promise.resolve({ data: null, error: null })) })) })),
        insert: vi.fn(() => Promise.resolve({ error: null })),
      };
    }),
  } as any;
}

describe('Tenant Provisioning Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('provisionTenant', () => {
    it('creates a new tenant with all required resources', async () => {
      const supabase = createMockSupabase();

      const result = await provisionTenant(supabase, {
        userId: 'user-uuid-001',
        email: 'test@example.com',
        organizationName: 'Test Org',
        userName: 'Test User',
      });

      expect(result.alreadyProvisioned).toBe(false);
      expect(result.tenant.id).toBe('tenant-uuid-001');
      expect(result.tenant.name).toBe('Test Org');
      expect(result.user.id).toBe('user-uuid-001');
      expect(result.user.email).toBe('test@example.com');
      expect(result.user.name).toBe('Test User');
      expect(result.apiKeys.test.key).toContain('pk_test_');
      expect(result.apiKeys.live.key).toContain('pk_live_');
    });

    it('uses email prefix as userName when userName not provided', async () => {
      const supabase = createMockSupabase();

      const result = await provisionTenant(supabase, {
        userId: 'user-uuid-001',
        email: 'jane.doe@company.com',
        organizationName: 'Company Inc',
      });

      expect(result.user.name).toBe('jane.doe');
    });

    it('returns existing tenant when user already provisioned (idempotent)', async () => {
      const supabase = createMockSupabase({
        user_profiles_select: {
          data: { id: 'user-uuid-001', tenant_id: 'existing-tenant-id', name: 'Existing User', role: 'owner' },
          error: null,
        },
        tenants_select: {
          data: { id: 'existing-tenant-id', name: 'Existing Org' },
          error: null,
        },
      });

      const result = await provisionTenant(supabase, {
        userId: 'user-uuid-001',
        email: 'test@example.com',
        organizationName: 'New Org Name',
      });

      expect(result.alreadyProvisioned).toBe(true);
      expect(result.tenant.id).toBe('existing-tenant-id');
      expect(result.tenant.name).toBe('Existing Org');
      // API keys should be empty for already-provisioned
      expect(result.apiKeys.test.key).toBe('');
      expect(result.apiKeys.live.key).toBe('');
    });

    it('throws TenantProvisioningError when tenant creation fails', async () => {
      const supabase = createMockSupabase({
        tenants_insert: { data: null, error: { message: 'DB error' } },
      });

      await expect(
        provisionTenant(supabase, {
          userId: 'user-uuid-001',
          email: 'test@example.com',
          organizationName: 'Test Org',
        })
      ).rejects.toThrow(TenantProvisioningError);

      await expect(
        provisionTenant(supabase, {
          userId: 'user-uuid-001',
          email: 'test@example.com',
          organizationName: 'Test Org',
        })
      ).rejects.toThrow('Failed to create organization');
    });

    it('rolls back tenant when profile creation fails', async () => {
      const deleteMock = vi.fn(() => ({
        eq: vi.fn(() => Promise.resolve({ error: null })),
      }));

      const supabase = createMockSupabase({
        user_profiles_insert: { error: { message: 'Profile error' } },
      });
      // Override tenant.delete to track rollback
      const originalFrom = supabase.from;
      supabase.from = vi.fn((table: string) => {
        if (table === 'tenants') {
          const original = originalFrom(table);
          return { ...original, delete: deleteMock };
        }
        return originalFrom(table);
      });

      await expect(
        provisionTenant(supabase, {
          userId: 'user-uuid-001',
          email: 'test@example.com',
          organizationName: 'Test Org',
        })
      ).rejects.toThrow('Failed to create user profile');

      expect(deleteMock).toHaveBeenCalled();
    });

    it('succeeds even when API key creation fails (non-fatal)', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const supabase = createMockSupabase({
        api_keys_insert: { error: { message: 'Keys error' } },
      });

      const result = await provisionTenant(supabase, {
        userId: 'user-uuid-001',
        email: 'test@example.com',
        organizationName: 'Test Org',
      });

      // Should still succeed
      expect(result.alreadyProvisioned).toBe(false);
      expect(result.tenant.id).toBe('tenant-uuid-001');
      expect(consoleSpy).toHaveBeenCalledWith('Failed to create API keys:', expect.any(Object));

      consoleSpy.mockRestore();
    });
  });
});

describe('TenantProvisioningError', () => {
  it('has correct name and code', () => {
    const err = new TenantProvisioningError('test message', 'test_code', { detail: 'inner' });
    expect(err.name).toBe('TenantProvisioningError');
    expect(err.message).toBe('test message');
    expect(err.code).toBe('test_code');
    expect(err.cause).toEqual({ detail: 'inner' });
  });

  it('is an instance of Error', () => {
    const err = new TenantProvisioningError('msg', 'code');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(TenantProvisioningError);
  });
});
