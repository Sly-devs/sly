import { Context, Next } from 'hono';
import { createClient } from '../db/client.js';
import { hashApiKey, getKeyPrefix, verifyApiKey } from '../utils/crypto.js';
import { logSecurityEvent } from '../utils/auth.js';
import { trackFirstEvent } from '../services/beta-access.js';

export interface RequestContext {
  tenantId: string;
  actorType: 'api_key' | 'user' | 'agent' | 'portal';
  // Environment scoping (test = sandbox, live = production)
  environment?: 'test' | 'live';
  // For user (JWT) auth
  userId?: string;
  userRole?: 'owner' | 'admin' | 'member' | 'viewer';
  userName?: string;
  // For API key auth
  apiKeyId?: string;
  apiKeyEnvironment?: 'test' | 'live';
  // For agent auth
  actorId?: string;
  actorName?: string;
  kyaTier?: number;
  parentAccountId?: string;
  // For portal token auth (Epic 65)
  portalTokenId?: string;
  portalScopes?: string[];
}

declare module 'hono' {
  interface ContextVariableMap {
    ctx: RequestContext;
  }
}

// =============================================================================
// JWT Auth Cache (performance optimization)
// =============================================================================

interface JWTCacheEntry {
  ctx: RequestContext;
  expiresAt: number;
}

const JWT_CACHE = new Map<string, JWTCacheEntry>();
const JWT_CACHE_TTL_MS = 60 * 1000; // 1 minute cache
const JWT_CACHE_MAX_SIZE = 1000;

function getJWTCacheKey(token: string): string {
  // Use last 20 chars of token as cache key (faster than hashing)
  return token.slice(-20);
}

function getCachedJWT(token: string): RequestContext | null {
  const key = getJWTCacheKey(token);
  const entry = JWT_CACHE.get(key);
  if (!entry) return null;
  
  if (Date.now() > entry.expiresAt) {
    JWT_CACHE.delete(key);
    return null;
  }
  
  return entry.ctx;
}

function setCachedJWT(token: string, ctx: RequestContext): void {
  // Cleanup if cache is too large
  if (JWT_CACHE.size >= JWT_CACHE_MAX_SIZE) {
    const now = Date.now();
    const keysToDelete: string[] = [];
    JWT_CACHE.forEach((entry, key) => {
      if (now > entry.expiresAt) keysToDelete.push(key);
    });
    keysToDelete.forEach(key => JWT_CACHE.delete(key));
    
    // If still too large, delete oldest entries
    if (JWT_CACHE.size >= JWT_CACHE_MAX_SIZE) {
      const entries = Array.from(JWT_CACHE.entries());
      entries.sort((a, b) => a[1].expiresAt - b[1].expiresAt);
      const toDelete = entries.slice(0, Math.floor(JWT_CACHE_MAX_SIZE / 2));
      toDelete.forEach(([key]) => JWT_CACHE.delete(key));
    }
  }
  
  JWT_CACHE.set(getJWTCacheKey(token), {
    ctx,
    expiresAt: Date.now() + JWT_CACHE_TTL_MS,
  });
}

// ============================================
// Agent Token Cache (mirrors JWT cache pattern)
// ============================================

interface AgentCacheEntry {
  ctx: RequestContext;
  agentRow: Record<string, unknown>;
  tokenHash: string;
  expiresAt: number;
}

const AGENT_TOKEN_CACHE = new Map<string, AgentCacheEntry>();
const AGENT_TOKEN_CACHE_TTL_MS = 60 * 1000; // 60 second TTL
const AGENT_TOKEN_CACHE_MAX_SIZE = 1000;

function getAgentCacheKey(tokenPrefix: string): string {
  return tokenPrefix;
}

function getCachedAgent(tokenPrefix: string, tokenHash: string): { ctx: RequestContext; agentRow: Record<string, unknown> } | null {
  const entry = AGENT_TOKEN_CACHE.get(getAgentCacheKey(tokenPrefix));
  if (!entry) return null;

  if (Date.now() > entry.expiresAt) {
    AGENT_TOKEN_CACHE.delete(getAgentCacheKey(tokenPrefix));
    return null;
  }

  // Verify hash still matches (constant-time comparison happens in caller)
  if (entry.tokenHash !== tokenHash) return null;

  return { ctx: entry.ctx, agentRow: entry.agentRow };
}

function setCachedAgent(tokenPrefix: string, tokenHash: string, ctx: RequestContext, agentRow: Record<string, unknown>): void {
  if (AGENT_TOKEN_CACHE.size >= AGENT_TOKEN_CACHE_MAX_SIZE) {
    const now = Date.now();
    const keysToDelete: string[] = [];
    AGENT_TOKEN_CACHE.forEach((entry, key) => {
      if (now > entry.expiresAt) keysToDelete.push(key);
    });
    keysToDelete.forEach(key => AGENT_TOKEN_CACHE.delete(key));

    if (AGENT_TOKEN_CACHE.size >= AGENT_TOKEN_CACHE_MAX_SIZE) {
      const entries = Array.from(AGENT_TOKEN_CACHE.entries());
      entries.sort((a, b) => a[1].expiresAt - b[1].expiresAt);
      const toDelete = entries.slice(0, Math.floor(AGENT_TOKEN_CACHE_MAX_SIZE / 2));
      toDelete.forEach(([key]) => AGENT_TOKEN_CACHE.delete(key));
    }
  }

  AGENT_TOKEN_CACHE.set(getAgentCacheKey(tokenPrefix), {
    ctx,
    agentRow,
    tokenHash,
    expiresAt: Date.now() + AGENT_TOKEN_CACHE_TTL_MS,
  });
}

/**
 * Log authentication attempts for security monitoring
 */
async function logAuthAttempt(
  success: boolean,
  tokenType: string | null,
  tenantId: string | null,
  actorId: string | null,
  ip: string,
  userAgent: string,
  errorReason?: string
): Promise<void> {
  // Only log failures in production to avoid noise
  if (success && process.env.NODE_ENV !== 'production') {
    return;
  }

  try {
    const supabase = createClient();
    await (supabase.from('audit_log') as any).insert({
      tenant_id: tenantId || '00000000-0000-0000-0000-000000000000',
      entity_type: 'auth',
      entity_id: actorId || '00000000-0000-0000-0000-000000000000',
      action: success ? 'login_success' : 'login_failure',
      actor_type: tokenType === 'agent' ? 'agent' : 'user',
      actor_id: actorId,
      actor_name: null,
      metadata: {
        ip_address: ip,
        user_agent: userAgent,
        token_type: tokenType,
        error_reason: errorReason,
      },
    });
  } catch (error) {
    // Don't fail the request if logging fails
    console.error('Failed to log auth attempt:', error);
  }
}

function getClientInfo(c: Context): { ip: string; userAgent: string } {
  const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    || c.req.header('x-real-ip')
    || 'unknown';
  const userAgent = c.req.header('user-agent') || 'unknown';
  return { ip, userAgent };
}

export async function authMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');
  const { ip, userAgent } = getClientInfo(c);

  if (!authHeader?.startsWith('Bearer ')) {
    await logAuthAttempt(false, null, null, null, ip, userAgent, 'Missing authorization header');
    return c.json({ error: 'Missing or invalid authorization header' }, 401);
  }

  const token = authHeader.slice(7);

  // Validate token format (basic sanity check)
  if (token.length < 10 || token.length > 2000) { // Increased max for JWTs
    await logAuthAttempt(false, null, null, null, ip, userAgent, 'Invalid token length');
    return c.json({ error: 'Invalid token format' }, 401);
  }

  const supabase = createClient();

  // ============================================
  // 1. API Key Auth (pk_test_* or pk_live_*)
  // ============================================
  if (token.startsWith('pk_')) {
    const keyPrefix = getKeyPrefix(token);
    const keyHash = hashApiKey(token);

    // Check the new api_keys table first
    const { data: apiKey, error: apiKeyError } = await (supabase
      .from('api_keys') as any)
      .select('id, tenant_id, environment, status, expires_at, key_hash')
      .eq('key_prefix', keyPrefix)
      .single();

    if (apiKey) {
      // Verify using constant-time hash comparison
      if (!verifyApiKey(token, apiKey.key_hash)) {
        await logAuthAttempt(false, 'api_key', null, null, ip, userAgent, 'Hash mismatch');
        await logSecurityEvent('api_key_auth_failure', 'warning', {
          keyPrefix,
          reason: 'hash_mismatch',
          ip,
          userAgent,
        });
        return c.json({ error: 'Invalid API key' }, 401);
      }

      // Check if key is revoked
      if (apiKey.status !== 'active' && apiKey.status !== 'grace_period') {
        await logAuthAttempt(false, 'api_key', apiKey.tenant_id, null, ip, userAgent, `Key status: ${apiKey.status}`);
        await logSecurityEvent('api_key_auth_failure', 'warning', {
          keyPrefix,
          tenantId: apiKey.tenant_id,
          reason: `key_${apiKey.status}`,
          ip,
          userAgent,
        });
        return c.json({ error: 'API key is not active' }, 401);
      }

      // Check if key is expired
      if (apiKey.expires_at && new Date(apiKey.expires_at) < new Date()) {
        await logAuthAttempt(false, 'api_key', apiKey.tenant_id, null, ip, userAgent, 'Key expired');
        await logSecurityEvent('api_key_auth_failure', 'warning', {
          keyPrefix,
          tenantId: apiKey.tenant_id,
          reason: 'key_expired',
          expiresAt: apiKey.expires_at,
          ip,
          userAgent,
        });
        return c.json({ error: 'API key has expired' }, 401);
      }

      // Get tenant info
      const { data: tenant, error: tenantError } = await (supabase
        .from('tenants') as any)
        .select('id, name, status')
        .eq('id', apiKey.tenant_id)
        .single();

      if (tenantError || !tenant) {
        await logAuthAttempt(false, 'api_key', apiKey.tenant_id, null, ip, userAgent, 'Tenant not found');
        return c.json({ error: 'Organization not found' }, 404);
      }

      if (tenant.status !== 'active') {
        await logAuthAttempt(false, 'api_key', tenant.id, null, ip, userAgent, `Tenant status: ${tenant.status}`);
        return c.json({ error: 'Organization is not active', status: tenant.status }, 403);
      }

      // Update last_used_at and last_used_ip (async, don't wait)
      (supabase.from('api_keys') as any)
        .update({
          last_used_at: new Date().toISOString(),
          last_used_ip: ip,
        })
        .eq('id', apiKey.id)
        .then(() => { })
        .catch((err: any) => console.error('Failed to update API key last_used:', err));

      await logAuthAttempt(true, 'api_key', tenant.id, apiKey.id, ip, userAgent);

      c.set('ctx', {
        tenantId: tenant.id,
        actorType: 'api_key',
        environment: apiKey.environment || 'test',
        actorId: apiKey.id,
        actorName: apiKey.name || 'API Key',
        apiKeyId: apiKey.id,
        apiKeyEnvironment: apiKey.environment,
      });

      // Track first API call for beta funnel (fire-and-forget)
      trackFirstEvent(tenant.id, 'first_api_call').catch(() => {});

      return next();
    }

    // Fallback to legacy tenants.api_key for backwards compatibility
    let { data: tenant, error } = await (supabase
      .from('tenants') as any)
      .select('id, name, status, api_key_hash')
      .eq('api_key_prefix', keyPrefix)
      .single();

    if (tenant && tenant.api_key_hash) {
      // Verify using secure hash comparison
      if (!verifyApiKey(token, tenant.api_key_hash)) {
        await logAuthAttempt(false, 'api_key', null, null, ip, userAgent, 'Hash mismatch (legacy)');
        return c.json({ error: 'Invalid API key' }, 401);
      }
    } else {
      // Fallback to legacy plaintext lookup (for backwards compatibility during migration)
      const legacyResult = await (supabase
        .from('tenants') as any)
        .select('id, name, status')
        .eq('api_key', token)
        .single();

      tenant = legacyResult.data;
      error = legacyResult.error;
    }

    if (error || !tenant) {
      await logAuthAttempt(false, 'api_key', null, null, ip, userAgent, 'Invalid API key (not found)');
      await logSecurityEvent('api_key_auth_failure', 'warning', {
        keyPrefix,
        reason: 'key_not_found',
        ip,
        userAgent,
      });
      return c.json({ error: 'Invalid API key' }, 401);
    }

    if (tenant.status !== 'active') {
      await logAuthAttempt(false, 'api_key', tenant.id, null, ip, userAgent, `Tenant status: ${tenant.status}`);
      return c.json({ error: 'Organization is not active', status: tenant.status }, 403);
    }

    await logAuthAttempt(true, 'api_key', tenant.id, 'legacy_api_key', ip, userAgent);

    const legacyEnv: 'test' | 'live' = token.startsWith('pk_live_') ? 'live' : 'test';
    c.set('ctx', {
      tenantId: tenant.id,
      actorType: 'api_key',
      environment: legacyEnv,
      actorId: 'legacy_api_key',
      actorName: tenant.name || 'Legacy API Key',
      apiKeyEnvironment: legacyEnv,
    });

    // Track first API call for beta funnel (fire-and-forget)
    trackFirstEvent(tenant.id, 'first_api_call').catch(() => {});

    return next();
  }

  // ============================================
  // 2. JWT Auth (Supabase session tokens)
  // ============================================
  // JWTs typically start with "eyJ" (base64 encoded JSON header)
  if (token.startsWith('eyJ')) {
    // Read environment header (may change per request even with same JWT)
    const envHeader = c.req.header('X-Environment');
    const requestEnv: 'test' | 'live' = envHeader === 'live' ? 'live' : 'test';

    // Check cache first for performance
    const cachedCtx = getCachedJWT(token);
    if (cachedCtx) {
      // Override environment from header (it can change per request)
      c.set('ctx', { ...cachedCtx, environment: requestEnv, apiKeyEnvironment: requestEnv });
      // Track first API call for beta funnel (fire-and-forget)
      trackFirstEvent(cachedCtx.tenantId, 'first_api_call').catch(() => {});
      return next();
    }

    try {
      // Verify JWT using Supabase client
      const { data: userData, error: authError } = await (supabase as any).auth.getUser(token);

      if (authError || !userData?.user) {
        await logAuthAttempt(false, 'jwt', null, null, ip, userAgent, authError?.message || 'Invalid JWT');
        await logSecurityEvent('jwt_auth_failure', 'info', {
          reason: authError?.message || 'invalid_jwt',
          ip,
          userAgent,
        });
        return c.json({ error: 'Invalid or expired session token' }, 401);
      }

      const userId = userData.user.id;

      // Get user profile and tenant
      const { data: profile, error: profileError } = await (supabase
        .from('user_profiles') as any)
        .select('tenant_id, role, name')
        .eq('id', userId)
        .single();

      if (profileError || !profile) {
        await logAuthAttempt(false, 'jwt', null, userId, ip, userAgent, 'User profile not found');
        await logSecurityEvent('jwt_auth_failure', 'critical', {
          userId,
          reason: 'profile_not_found',
          ip,
          userAgent,
        });
        return c.json({ error: 'User profile not found' }, 403);
      }

      // Get tenant info
      const { data: tenant, error: tenantError } = await (supabase
        .from('tenants') as any)
        .select('id, name, status')
        .eq('id', profile.tenant_id)
        .single();

      if (tenantError || !tenant) {
        await logAuthAttempt(false, 'jwt', profile.tenant_id, userId, ip, userAgent, 'Tenant not found');
        return c.json({ error: 'Organization not found' }, 404);
      }

      if (tenant.status !== 'active') {
        await logAuthAttempt(false, 'jwt', tenant.id, userId, ip, userAgent, `Tenant status: ${tenant.status}`);
        return c.json({ error: 'Organization is not active', status: tenant.status }, 403);
      }

      await logAuthAttempt(true, 'jwt', tenant.id, userId, ip, userAgent);

      const ctx: RequestContext = {
        tenantId: tenant.id,
        actorType: 'user',
        userId: userId,
        userRole: profile.role,
        userName: profile.name || userData.user.email?.split('@')[0] || 'Unknown',
        environment: requestEnv,
        apiKeyEnvironment: requestEnv,
      };

      // Cache the result for subsequent requests
      setCachedJWT(token, ctx);
      
      c.set('ctx', ctx);

      // Track first API call for beta funnel (fire-and-forget)
      trackFirstEvent(ctx.tenantId, 'first_api_call').catch(() => {});

      return next();
    } catch (error) {
      await logAuthAttempt(false, 'jwt', null, null, ip, userAgent, 'JWT verification failed');
      return c.json({ error: 'Authentication failed' }, 401);
    }
  }

  // ============================================
  // 3. Agent token (agent_xxx)
  // ============================================
  if (token.startsWith('agent_')) {
    const tokenPrefix = getKeyPrefix(token);
    const tokenHash = hashApiKey(token);

    // Check agent token cache first (avoids DB round-trip on repeat requests)
    const cached = getCachedAgent(tokenPrefix, tokenHash);
    if (cached) {
      c.set('ctx', cached.ctx);
      c.set('agentRow', cached.agentRow);
      return next();
    }

    // Cache miss — query DB
    let { data: agent, error } = await (supabase
      .from('agents') as any)
      .select('id, name, tenant_id, status, kya_tier, kya_status, auth_token_hash, parent_account_id, environment')
      .eq('auth_token_prefix', tokenPrefix)
      .single();

    if (agent && agent.auth_token_hash) {
      // Verify using secure hash comparison
      if (!verifyApiKey(token, agent.auth_token_hash)) {
        await logAuthAttempt(false, 'agent', null, null, ip, userAgent, 'Hash mismatch');
        return c.json({ error: 'Invalid agent token' }, 401);
      }
    } else {
      // Fallback to legacy plaintext lookup (for backwards compatibility during migration)
      const legacyResult = await (supabase
        .from('agents') as any)
        .select('id, name, tenant_id, status, kya_tier, kya_status, parent_account_id, environment')
        .eq('auth_client_id', token)
        .single();

      agent = legacyResult.data;
      error = legacyResult.error;
    }

    if (error || !agent) {
      await logAuthAttempt(false, 'agent', null, null, ip, userAgent, 'Invalid agent token');
      return c.json({ error: 'Invalid agent token' }, 401);
    }

    if (agent.status !== 'active') {
      await logAuthAttempt(false, 'agent', agent.tenant_id, agent.id, ip, userAgent, `Agent status: ${agent.status}`);
      return c.json({ error: 'Agent is not active', status: agent.status }, 403);
    }

    logAuthAttempt(true, 'agent', agent.tenant_id, agent.id, ip, userAgent).catch(() => {});

    const ctx: RequestContext = {
      tenantId: agent.tenant_id,
      actorType: 'agent',
      environment: agent.environment || 'test',
      actorId: agent.id,
      actorName: agent.name,
      kyaTier: agent.kya_tier,
      parentAccountId: agent.parent_account_id,
      apiKeyEnvironment: agent.environment || 'test',
    };

    // Cache the agent row + context for subsequent requests
    setCachedAgent(tokenPrefix, tokenHash, ctx, agent);
    c.set('ctx', ctx);
    c.set('agentRow', agent);

    // Track first API call for beta funnel (fire-and-forget)
    trackFirstEvent(agent.tenant_id, 'first_api_call').catch(() => {});

    return next();
  }

  // ============================================
  // 4. Portal Token Auth (portal_xxx) — Epic 65
  // ============================================
  if (token.startsWith('portal_')) {
    const tokenPrefix = getKeyPrefix(token);

    const { data: portalToken, error } = await (supabase
      .from('portal_tokens') as any)
      .select('id, tenant_id, name, token_hash, scopes, status, expires_at')
      .eq('token_prefix', tokenPrefix)
      .single();

    if (error || !portalToken) {
      await logAuthAttempt(false, 'portal', null, null, ip, userAgent, 'Invalid portal token');
      return c.json({ error: 'Invalid portal token' }, 401);
    }

    if (!verifyApiKey(token, portalToken.token_hash)) {
      await logAuthAttempt(false, 'portal', null, null, ip, userAgent, 'Hash mismatch');
      return c.json({ error: 'Invalid portal token' }, 401);
    }

    if (portalToken.status !== 'active') {
      await logAuthAttempt(false, 'portal', portalToken.tenant_id, null, ip, userAgent, `Portal token status: ${portalToken.status}`);
      return c.json({ error: 'Portal token is not active' }, 401);
    }

    if (portalToken.expires_at && new Date(portalToken.expires_at) < new Date()) {
      await logAuthAttempt(false, 'portal', portalToken.tenant_id, null, ip, userAgent, 'Portal token expired');
      return c.json({ error: 'Portal token has expired' }, 401);
    }

    // Update last_used_at (async)
    (supabase.from('portal_tokens') as any)
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', portalToken.id)
      .then(() => {})
      .catch((err: any) => console.error('Failed to update portal token last_used:', err));

    await logAuthAttempt(true, 'portal', portalToken.tenant_id, portalToken.id, ip, userAgent);

    c.set('ctx', {
      tenantId: portalToken.tenant_id,
      actorType: 'portal',
      actorId: portalToken.id,
      actorName: portalToken.name || 'Portal Token',
      portalTokenId: portalToken.id,
      portalScopes: portalToken.scopes || ['usage:read'],
    });

    // Track first API call for beta funnel (fire-and-forget)
    trackFirstEvent(portalToken.tenant_id, 'first_api_call').catch(() => {});

    return next();
  }

  await logAuthAttempt(false, null, null, null, ip, userAgent, 'Unknown token format');
  await logSecurityEvent('auth_failure', 'warning', {
    reason: 'unknown_token_format',
    tokenPrefix: token.substring(0, 10),
    ip,
    userAgent,
  });
  return c.json({ error: 'Invalid token format' }, 401);
}
