/**
 * Connected Accounts API Routes
 * Epic 48, Story 48.2: CRUD API for payment handler accounts
 *
 * Endpoints:
 * - GET /v1/organization/connected-accounts - List all connected accounts
 * - POST /v1/organization/connected-accounts - Add new handler connection
 * - GET /v1/organization/connected-accounts/:id - Get single account details
 * - PATCH /v1/organization/connected-accounts/:id - Update account
 * - DELETE /v1/organization/connected-accounts/:id - Remove handler connection
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { createClient } from '../../db/client.js';
import {
  encryptAndSerialize,
  deserializeAndDecrypt,
  validateCredentialStructure,
  maskCredentials,
} from '../../services/credential-vault/index.js';
import { validateStripeCredentials } from '../../services/handlers/stripe.js';
import { validatePayPalCredentials } from '../../services/handlers/paypal.js';
import { validateCircleCredentials } from '../../services/handlers/circle.js';

const connectedAccounts = new Hono();

// Validation schemas
const HARDCODED_HANDLERS = ['stripe', 'paypal', 'circle', 'sly_native'] as const;

const createConnectedAccountSchema = z.object({
  handler_type: z.string().min(1).max(100),
  handler_name: z.string().min(1).max(100),
  credentials: z.record(z.unknown()).default({}),
  metadata: z.record(z.unknown()).optional(),
});

const updateConnectedAccountSchema = z.object({
  handler_name: z.string().min(1).max(100).optional(),
  credentials: z.record(z.unknown()).optional(),
  status: z.enum(['active', 'inactive']).optional(),
  metadata: z.record(z.unknown()).optional(),
});

// Helper to get current user and tenant from JWT
async function getCurrentUserAndTenant(c: any) {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { error: { status: 401, body: { error: 'Missing or invalid authorization header' } } };
  }

  const accessToken = authHeader.slice(7);
  const supabase = createClient();

  const { data: userData, error } = await (supabase as any).auth.getUser(accessToken);
  if (error || !userData?.user) {
    return { error: { status: 401, body: { error: 'Invalid or expired token' } } };
  }

  const userId = userData.user.id;

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('tenant_id, role, name')
    .eq('id', userId)
    .single();

  if (!profile?.tenant_id) {
    return { error: { status: 403, body: { error: 'User is not linked to any organization' } } };
  }

  return {
    user: userData.user,
    userProfile: profile,
    tenantId: profile.tenant_id,
  };
}

// Log audit event for connected accounts
async function logAuditEvent(
  tenantId: string,
  connectedAccountId: string,
  action: string,
  actorType: string,
  actorId: string | null,
  metadata: Record<string, unknown> = {}
) {
  const supabase = createClient();
  await supabase.from('connected_accounts_audit').insert({
    tenant_id: tenantId,
    connected_account_id: connectedAccountId,
    action,
    actor_type: actorType,
    actor_id: actorId,
    metadata,
  });
}

// ============================================
// GET /connected-accounts - List all
// ============================================
connectedAccounts.get('/', async (c) => {
  const result = await getCurrentUserAndTenant(c);
  if ('error' in result) {
    return c.json(result.error.body, result.error.status);
  }

  const { tenantId } = result;
  const supabase = createClient();

  const { data, error } = await supabase
    .from('connected_accounts')
    .select('id, handler_type, handler_name, status, last_verified_at, metadata, created_at, updated_at')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Failed to fetch connected accounts:', error);
    return c.json({ error: 'Failed to fetch connected accounts' }, 500);
  }

  return c.json({
    data: data.map((account) => ({
      id: account.id,
      handler_type: account.handler_type,
      handler_name: account.handler_name,
      status: account.status,
      last_verified_at: account.last_verified_at,
      metadata: account.metadata,
      connected_at: account.created_at,
      updated_at: account.updated_at,
    })),
  });
});

// ============================================
// GET /connected-accounts/:id - Get single
// ============================================
connectedAccounts.get('/:id', async (c) => {
  const result = await getCurrentUserAndTenant(c);
  if ('error' in result) {
    return c.json(result.error.body, result.error.status);
  }

  const { tenantId } = result;
  const accountId = c.req.param('id');
  const supabase = createClient();

  const { data, error } = await supabase
    .from('connected_accounts')
    .select('*')
    .eq('id', accountId)
    .eq('tenant_id', tenantId)
    .single();

  if (error || !data) {
    return c.json({ error: 'Connected account not found' }, 404);
  }

  // Mask credentials for response
  let maskedCredentials: Record<string, string> | null = null;
  if (data.credentials_encrypted) {
    try {
      const credentials = deserializeAndDecrypt(data.credentials_encrypted);
      maskedCredentials = maskCredentials(credentials);
    } catch {
      maskedCredentials = { error: 'Unable to decrypt' };
    }
  }

  return c.json({
    id: data.id,
    handler_type: data.handler_type,
    handler_name: data.handler_name,
    status: data.status,
    credentials_preview: maskedCredentials,
    last_verified_at: data.last_verified_at,
    error_message: data.error_message,
    error_code: data.error_code,
    metadata: data.metadata,
    connected_at: data.created_at,
    updated_at: data.updated_at,
  });
});

// ============================================
// POST /connected-accounts - Create new
// ============================================
connectedAccounts.post('/', async (c) => {
  const result = await getCurrentUserAndTenant(c);
  if ('error' in result) {
    return c.json(result.error.body, result.error.status);
  }

  const { tenantId, user, userProfile } = result;

  // Only owners and admins can connect accounts
  const role = userProfile.role as string;
  if (role !== 'owner' && role !== 'admin') {
    return c.json({ error: 'Only owners and admins can connect payment accounts' }, 403);
  }

  let body: z.infer<typeof createConnectedAccountSchema>;
  try {
    const rawBody = await c.req.json();
    body = createConnectedAccountSchema.parse(rawBody);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json({ error: 'Validation failed', details: error.errors }, 400);
    }
    return c.json({ error: 'Invalid request body' }, 400);
  }

  const supabase = createClient();

  // Determine if this is a hardcoded handler or a DB-driven one
  const isHardcodedHandler = (HARDCODED_HANDLERS as readonly string[]).includes(body.handler_type);
  let dbHandlerMode: string | null = null;

  if (!isHardcodedHandler) {
    // Look up handler in payment_handlers table
    const { data: dbHandler } = await supabase
      .from('payment_handlers')
      .select('id, integration_mode, display_name')
      .eq('id', body.handler_type)
      .eq('status', 'active')
      .single();

    if (!dbHandler) {
      return c.json({ error: `Unknown handler type: ${body.handler_type}` }, 400);
    }
    dbHandlerMode = dbHandler.integration_mode;
  }

  // Validate credential structure (hardcoded handlers enforce structure, DB handlers pass through)
  const validation = validateCredentialStructure(body.handler_type, body.credentials);
  if (!validation.valid) {
    return c.json({ error: 'Invalid credentials', details: validation.errors }, 400);
  }

  // Validate credentials work (for supported hardcoded handlers)
  let verificationResult: { valid: boolean; error?: string; accountInfo?: Record<string, unknown> } = {
    valid: true,
  };

  if (dbHandlerMode === 'demo') {
    // Demo-mode DB handlers: no credential validation needed
    verificationResult = { valid: true, accountInfo: { integration_mode: 'demo' } };
  } else if (body.handler_type === 'stripe') {
    verificationResult = await validateStripeCredentials(body.credentials as { api_key: string });
  } else if (body.handler_type === 'paypal') {
    verificationResult = await validatePayPalCredentials(body.credentials as {
      client_id: string;
      client_secret: string;
      sandbox?: boolean;
    });
  } else if (body.handler_type === 'circle') {
    verificationResult = await validateCircleCredentials(body.credentials as {
      api_key: string;
      sandbox?: boolean;
    });
  }
  // PayOS Native and non-demo DB handlers don't have API validation

  // Check for existing account with same handler type and name
  const { data: existing } = await supabase
    .from('connected_accounts')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('handler_type', body.handler_type)
    .eq('handler_name', body.handler_name)
    .single();

  if (existing) {
    return c.json(
      { error: `A ${body.handler_type} account with name "${body.handler_name}" already exists` },
      409
    );
  }

  // Encrypt credentials
  const encryptedCredentials = encryptAndSerialize(body.credentials);

  // Create the connected account
  const { data: created, error: createError } = await supabase
    .from('connected_accounts')
    .insert({
      tenant_id: tenantId,
      handler_type: body.handler_type,
      handler_name: body.handler_name,
      credentials_encrypted: encryptedCredentials,
      credentials_key_id: 'v1',
      status: verificationResult.valid ? 'active' : 'error',
      last_verified_at: verificationResult.valid ? new Date().toISOString() : null,
      error_message: verificationResult.error || null,
      metadata: {
        ...body.metadata,
        ...(verificationResult.accountInfo || {}),
      },
    })
    .select('id, handler_type, handler_name, status, last_verified_at, metadata, created_at')
    .single();

  if (createError) {
    console.error('Failed to create connected account:', createError);
    return c.json({ error: 'Failed to create connected account' }, 500);
  }

  // Log audit event
  await logAuditEvent(tenantId, created.id, 'created', 'user', user.id, {
    handler_type: body.handler_type,
    handler_name: body.handler_name,
    verification_status: verificationResult.valid ? 'success' : 'failed',
  });

  return c.json(
    {
      id: created.id,
      handler_type: created.handler_type,
      handler_name: created.handler_name,
      status: created.status,
      last_verified_at: created.last_verified_at,
      metadata: created.metadata,
      connected_at: created.created_at,
      message: verificationResult.valid
        ? 'Account connected successfully'
        : `Account created but verification failed: ${verificationResult.error}`,
    },
    201
  );
});

// ============================================
// PATCH /connected-accounts/:id - Update
// ============================================
connectedAccounts.patch('/:id', async (c) => {
  const result = await getCurrentUserAndTenant(c);
  if ('error' in result) {
    return c.json(result.error.body, result.error.status);
  }

  const { tenantId, user, userProfile } = result;
  const accountId = c.req.param('id');

  // Only owners and admins can update accounts
  const role = userProfile.role as string;
  if (role !== 'owner' && role !== 'admin') {
    return c.json({ error: 'Only owners and admins can update payment accounts' }, 403);
  }

  let body: z.infer<typeof updateConnectedAccountSchema>;
  try {
    const rawBody = await c.req.json();
    body = updateConnectedAccountSchema.parse(rawBody);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json({ error: 'Validation failed', details: error.errors }, 400);
    }
    return c.json({ error: 'Invalid request body' }, 400);
  }

  const supabase = createClient();

  // Get existing account
  const { data: existing, error: fetchError } = await supabase
    .from('connected_accounts')
    .select('*')
    .eq('id', accountId)
    .eq('tenant_id', tenantId)
    .single();

  if (fetchError || !existing) {
    return c.json({ error: 'Connected account not found' }, 404);
  }

  // Build update object
  const updates: Record<string, unknown> = {};

  if (body.handler_name) {
    updates.handler_name = body.handler_name;
  }

  if (body.status) {
    updates.status = body.status;
  }

  if (body.metadata) {
    updates.metadata = { ...existing.metadata, ...body.metadata };
  }

  if (body.credentials) {
    // Validate new credentials
    const validation = validateCredentialStructure(existing.handler_type, body.credentials);
    if (!validation.valid) {
      return c.json({ error: 'Invalid credentials', details: validation.errors }, 400);
    }

    // Verify new credentials work
    let verificationResult = { valid: true, error: undefined as string | undefined };
    if (existing.handler_type === 'stripe') {
      verificationResult = await validateStripeCredentials(body.credentials as { api_key: string });
    } else if (existing.handler_type === 'paypal') {
      verificationResult = await validatePayPalCredentials(body.credentials as {
        client_id: string;
        client_secret: string;
        sandbox?: boolean;
      });
    } else if (existing.handler_type === 'circle') {
      verificationResult = await validateCircleCredentials(body.credentials as {
        api_key: string;
        sandbox?: boolean;
      });
    }

    updates.credentials_encrypted = encryptAndSerialize(body.credentials);
    updates.last_verified_at = verificationResult.valid ? new Date().toISOString() : null;
    updates.status = verificationResult.valid ? 'active' : 'error';
    updates.error_message = verificationResult.error || null;

    // Log credential update
    await logAuditEvent(tenantId, accountId, 'credentials_updated', 'user', user.id, {
      verification_status: verificationResult.valid ? 'success' : 'failed',
    });
  }

  if (Object.keys(updates).length === 0) {
    return c.json({ error: 'No changes provided' }, 400);
  }

  const { data: updated, error: updateError } = await supabase
    .from('connected_accounts')
    .update(updates)
    .eq('id', accountId)
    .eq('tenant_id', tenantId)
    .select('id, handler_type, handler_name, status, last_verified_at, metadata, created_at, updated_at')
    .single();

  if (updateError) {
    console.error('Failed to update connected account:', updateError);
    return c.json({ error: 'Failed to update connected account' }, 500);
  }

  return c.json({
    id: updated.id,
    handler_type: updated.handler_type,
    handler_name: updated.handler_name,
    status: updated.status,
    last_verified_at: updated.last_verified_at,
    metadata: updated.metadata,
    connected_at: updated.created_at,
    updated_at: updated.updated_at,
  });
});

// ============================================
// DELETE /connected-accounts/:id - Remove
// ============================================
connectedAccounts.delete('/:id', async (c) => {
  const result = await getCurrentUserAndTenant(c);
  if ('error' in result) {
    return c.json(result.error.body, result.error.status);
  }

  const { tenantId, user, userProfile } = result;
  const accountId = c.req.param('id');

  // Only owners and admins can delete accounts
  const role = userProfile.role as string;
  if (role !== 'owner' && role !== 'admin') {
    return c.json({ error: 'Only owners and admins can disconnect payment accounts' }, 403);
  }

  const supabase = createClient();

  // Verify account exists and belongs to tenant
  const { data: existing, error: fetchError } = await supabase
    .from('connected_accounts')
    .select('id, handler_type, handler_name')
    .eq('id', accountId)
    .eq('tenant_id', tenantId)
    .single();

  if (fetchError || !existing) {
    return c.json({ error: 'Connected account not found' }, 404);
  }

  // Log audit event before deletion
  await logAuditEvent(tenantId, accountId, 'deleted', 'user', user.id, {
    handler_type: existing.handler_type,
    handler_name: existing.handler_name,
  });

  // Delete the account
  const { error: deleteError } = await supabase
    .from('connected_accounts')
    .delete()
    .eq('id', accountId)
    .eq('tenant_id', tenantId);

  if (deleteError) {
    console.error('Failed to delete connected account:', deleteError);
    return c.json({ error: 'Failed to delete connected account' }, 500);
  }

  return c.json({ message: 'Account disconnected successfully' });
});

// ============================================
// POST /connected-accounts/:id/verify - Re-verify credentials
// ============================================
connectedAccounts.post('/:id/verify', async (c) => {
  const result = await getCurrentUserAndTenant(c);
  if ('error' in result) {
    return c.json(result.error.body, result.error.status);
  }

  const { tenantId, user } = result;
  const accountId = c.req.param('id');
  const supabase = createClient();

  // Get existing account with encrypted credentials
  const { data: existing, error: fetchError } = await supabase
    .from('connected_accounts')
    .select('*')
    .eq('id', accountId)
    .eq('tenant_id', tenantId)
    .single();

  if (fetchError || !existing) {
    return c.json({ error: 'Connected account not found' }, 404);
  }

  // Decrypt credentials
  let credentials: Record<string, unknown>;
  try {
    credentials = deserializeAndDecrypt(existing.credentials_encrypted);
  } catch {
    return c.json({ error: 'Failed to decrypt credentials' }, 500);
  }

  // Log credential access
  await logAuditEvent(tenantId, accountId, 'credentials_read', 'user', user.id, {
    purpose: 'verification',
  });

  // Verify based on handler type
  let verificationResult = { valid: true, error: undefined as string | undefined, accountInfo: {} as Record<string, unknown> };

  if (existing.handler_type === 'stripe') {
    verificationResult = await validateStripeCredentials(credentials as { api_key: string });
  } else if (existing.handler_type === 'paypal') {
    verificationResult = await validatePayPalCredentials(credentials as {
      client_id: string;
      client_secret: string;
      sandbox?: boolean;
    });
  } else if (existing.handler_type === 'circle') {
    verificationResult = await validateCircleCredentials(credentials as {
      api_key: string;
      sandbox?: boolean;
    });
  }
  // PayOS Native doesn't have API validation

  // Update account status
  const { error: updateError } = await supabase
    .from('connected_accounts')
    .update({
      status: verificationResult.valid ? 'active' : 'error',
      last_verified_at: verificationResult.valid ? new Date().toISOString() : existing.last_verified_at,
      error_message: verificationResult.error || null,
      error_code: verificationResult.valid ? null : 'VERIFICATION_FAILED',
      metadata: {
        ...existing.metadata,
        ...verificationResult.accountInfo,
      },
    })
    .eq('id', accountId);

  if (updateError) {
    console.error('Failed to update verification status:', updateError);
  }

  // Log verification result
  await logAuditEvent(
    tenantId,
    accountId,
    verificationResult.valid ? 'verified' : 'verification_failed',
    'user',
    user.id,
    { error: verificationResult.error }
  );

  return c.json({
    verified: verificationResult.valid,
    error: verificationResult.error,
    account_info: verificationResult.accountInfo,
  });
});

export default connectedAccounts;
