import type { Context, Next } from 'hono';
import { createHash } from 'node:crypto';
import { createClient } from '../db/client.js';
import {
  getScannerKeyPrefix,
  hashScannerKey,
  verifyScannerKey,
} from '../utils/crypto.js';

export type ScannerScope = 'scan' | 'batch' | 'read' | 'mcp' | 'tests';

export interface ScannerRequestContext {
  tenantId: string;
  actorType: 'api_key' | 'user';
  environment: 'test' | 'live';
  actorId: string;
  actorName?: string;
  scannerKeyId?: string;
  scopes?: ScannerScope[];
  rateLimitPerMin?: number;
  userId?: string;
  userRole?: string;
}

declare module 'hono' {
  interface ContextVariableMap {
    ctx: ScannerRequestContext;
  }
}

interface JwtCacheEntry {
  ctx: ScannerRequestContext;
  expiresAt: number;
}

const JWT_CACHE = new Map<string, JwtCacheEntry>();
const JWT_CACHE_TTL_MS = 60 * 1000;
const JWT_CACHE_MAX = 500;

function jwtCacheKey(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 32);
}

function readJwtCache(token: string): ScannerRequestContext | null {
  const entry = JWT_CACHE.get(jwtCacheKey(token));
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    JWT_CACHE.delete(jwtCacheKey(token));
    return null;
  }
  return entry.ctx;
}

function writeJwtCache(token: string, ctx: ScannerRequestContext): void {
  if (JWT_CACHE.size >= JWT_CACHE_MAX) {
    const now = Date.now();
    for (const [k, v] of JWT_CACHE) {
      if (now > v.expiresAt) JWT_CACHE.delete(k);
    }
    if (JWT_CACHE.size >= JWT_CACHE_MAX) {
      const oldest = Array.from(JWT_CACHE.entries())
        .sort((a, b) => a[1].expiresAt - b[1].expiresAt)
        .slice(0, Math.floor(JWT_CACHE_MAX / 2));
      for (const [k] of oldest) JWT_CACHE.delete(k);
    }
  }
  JWT_CACHE.set(jwtCacheKey(token), {
    ctx,
    expiresAt: Date.now() + JWT_CACHE_TTL_MS,
  });
}

export async function authMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid authorization header' }, 401);
  }

  const token = authHeader.slice(7);
  if (token.length < 10 || token.length > 2000) {
    return c.json({ error: 'Invalid token format' }, 401);
  }

  const supabase = createClient();

  // =========================================================================
  // 1. Scanner partner API key (psk_test_* / psk_live_*)
  // =========================================================================
  if (token.startsWith('psk_')) {
    const prefix = getScannerKeyPrefix(token);

    const { data: row } = await (supabase.from('scanner_api_keys') as any)
      .select(
        'id, tenant_id, name, key_hash, environment, scopes, rate_limit_per_min, revoked_at',
      )
      .eq('key_prefix', prefix)
      .is('revoked_at', null)
      .maybeSingle();

    if (!row) {
      return c.json({ error: 'Invalid scanner API key' }, 401);
    }

    if (!verifyScannerKey(token, row.key_hash)) {
      return c.json({ error: 'Invalid scanner API key' }, 401);
    }

    const { data: tenant } = await (supabase.from('tenants') as any)
      .select('id, status')
      .eq('id', row.tenant_id)
      .single();

    if (!tenant || tenant.status !== 'active') {
      return c.json({ error: 'Organization is not active' }, 403);
    }

    // Fire-and-forget last_used update
    (supabase.from('scanner_api_keys') as any)
      .update({
        last_used_at: new Date().toISOString(),
        last_used_ip:
          c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
          c.req.header('x-real-ip') ??
          null,
      })
      .eq('id', row.id)
      .then(() => {})
      .catch((err: any) =>
        console.error('[scanner-auth] Failed to update last_used:', err),
      );

    c.set('ctx', {
      tenantId: row.tenant_id,
      actorType: 'api_key',
      environment: row.environment,
      actorId: row.id,
      actorName: row.name,
      scannerKeyId: row.id,
      scopes: (row.scopes ?? ['scan', 'batch', 'read']) as ScannerScope[],
      rateLimitPerMin: row.rate_limit_per_min ?? 60,
    });

    return next();
  }

  // =========================================================================
  // 2. Supabase JWT session (SSO via Sly account)
  // =========================================================================
  if (token.startsWith('eyJ')) {
    const cached = readJwtCache(token);
    if (cached) {
      c.set('ctx', cached);
      return next();
    }

    const { data: userData, error: authError } = await (supabase as any).auth.getUser(
      token,
    );
    if (authError || !userData?.user) {
      return c.json({ error: 'Invalid or expired session token' }, 401);
    }

    const userId = userData.user.id;

    const { data: profile } = await (supabase.from('user_profiles') as any)
      .select('tenant_id, role, name')
      .eq('id', userId)
      .single();

    if (!profile) {
      return c.json({ error: 'User profile not found' }, 403);
    }

    const { data: tenant } = await (supabase.from('tenants') as any)
      .select('id, status')
      .eq('id', profile.tenant_id)
      .single();

    if (!tenant || tenant.status !== 'active') {
      return c.json({ error: 'Organization is not active' }, 403);
    }

    const envHeader = c.req.header('X-Environment');
    const environment: 'test' | 'live' = envHeader === 'live' ? 'live' : 'test';

    const ctx: ScannerRequestContext = {
      tenantId: tenant.id,
      actorType: 'user',
      environment,
      actorId: userId,
      actorName: profile.name ?? userData.user.email ?? 'Sly user',
      userId,
      userRole: profile.role,
      // JWT sessions get full access — the Sly dashboard uses this path.
      scopes: ['scan', 'batch', 'read', 'mcp', 'tests'],
      rateLimitPerMin: 120,
    };

    writeJwtCache(token, ctx);
    c.set('ctx', ctx);
    return next();
  }

  return c.json({ error: 'Unrecognized token format' }, 401);
}

/**
 * Require that the caller's key has a given scope. Use after authMiddleware.
 */
export function requireScope(scope: ScannerScope) {
  return async (c: Context, next: Next) => {
    const ctx = c.get('ctx');
    if (!ctx?.scopes || !ctx.scopes.includes(scope)) {
      return c.json(
        { error: 'Insufficient scope', required: scope, granted: ctx?.scopes ?? [] },
        403,
      );
    }
    return next();
  };
}

export { hashScannerKey };
