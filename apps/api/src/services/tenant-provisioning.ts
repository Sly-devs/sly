import { SupabaseClient } from '@supabase/supabase-js';
import {
  generateApiKey,
  hashApiKey,
  getKeyPrefix,
  logSecurityEvent,
} from '../utils/auth.js';

export interface ProvisionTenantInput {
  userId: string;
  email: string;
  organizationName: string;
  userName?: string;
}

export interface ProvisionTenantResult {
  tenant: { id: string; name: string };
  user: { id: string; email: string; name: string };
  apiKeys: {
    test: { key: string; prefix: string };
    live: { key: string; prefix: string };
  };
  alreadyProvisioned: boolean;
}

/**
 * Provisions a new tenant with user profile, settings, and API keys.
 * Idempotent: returns existing tenant if user already has one.
 */
export async function provisionTenant(
  supabase: SupabaseClient,
  input: ProvisionTenantInput
): Promise<ProvisionTenantResult> {
  const { userId, email, organizationName, userName } = input;
  const displayName = userName || email.split('@')[0];

  // Idempotency: check if user already has a profile with a tenant
  const { data: existingProfile } = await (supabase
    .from('user_profiles') as any)
    .select('id, tenant_id, name, role')
    .eq('id', userId)
    .single();

  if (existingProfile?.tenant_id) {
    const { data: existingTenant } = await (supabase
      .from('tenants') as any)
      .select('id, name')
      .eq('id', existingProfile.tenant_id)
      .single();

    if (existingTenant) {
      // Return existing tenant — no API keys (already shown once)
      return {
        tenant: { id: existingTenant.id, name: existingTenant.name },
        user: { id: userId, email, name: existingProfile.name || displayName },
        apiKeys: {
          test: { key: '', prefix: '' },
          live: { key: '', prefix: '' },
        },
        alreadyProvisioned: true,
      };
    }
  }

  // Create tenant
  // Legacy api_key fields required for backwards compatibility
  const legacyApiKey = generateApiKey('test');
  const { data: tenant, error: tenantError } = await (supabase
    .from('tenants') as any)
    .insert({
      name: organizationName,
      status: 'active',
      api_key: legacyApiKey,
      api_key_hash: hashApiKey(legacyApiKey),
      api_key_prefix: getKeyPrefix(legacyApiKey),
    })
    .select()
    .single();

  if (tenantError || !tenant) {
    throw new TenantProvisioningError('Failed to create organization', 'tenant_creation_failed', tenantError);
  }

  // Create user profile
  const { error: profileError } = await (supabase
    .from('user_profiles') as any)
    .insert({
      id: userId,
      tenant_id: tenant.id,
      role: 'owner',
      name: displayName,
    });

  if (profileError) {
    // Rollback: delete tenant
    await supabase.from('tenants').delete().eq('id', tenant.id);
    throw new TenantProvisioningError('Failed to create user profile', 'profile_creation_failed', profileError);
  }

  // Create tenant settings with defaults
  await (supabase.from('tenant_settings') as any).insert({
    tenant_id: tenant.id,
  });

  // Generate API keys (test + live)
  const testKey = generateApiKey('test');
  const liveKey = generateApiKey('live');

  const { error: keysError } = await (supabase.from('api_keys') as any).insert([
    {
      tenant_id: tenant.id,
      created_by_user_id: userId,
      name: 'Default Test Key',
      environment: 'test',
      key_prefix: getKeyPrefix(testKey),
      key_hash: hashApiKey(testKey),
    },
    {
      tenant_id: tenant.id,
      created_by_user_id: userId,
      name: 'Default Live Key',
      environment: 'live',
      key_prefix: getKeyPrefix(liveKey),
      key_hash: hashApiKey(liveKey),
    },
  ]);

  if (keysError) {
    // Keys are optional — log but don't fail
    console.error('Failed to create API keys:', keysError);
  }

  await logSecurityEvent('tenant_provisioned', 'info', {
    userId,
    tenantId: tenant.id,
    organizationName,
  });

  return {
    tenant: { id: tenant.id, name: tenant.name },
    user: { id: userId, email, name: displayName },
    apiKeys: {
      test: { key: testKey, prefix: getKeyPrefix(testKey) },
      live: { key: liveKey, prefix: getKeyPrefix(liveKey) },
    },
    alreadyProvisioned: false,
  };
}

export class TenantProvisioningError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'TenantProvisioningError';
  }
}
