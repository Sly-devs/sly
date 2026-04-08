import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { createClient } from '../db/client.js';

/**
 * Common passwords list (top 10k from SecLists)
 * In production, use a more comprehensive list or external service
 */
const COMMON_PASSWORDS = new Set([
  'password',
  'password123',
  '12345678',
  '123456789',
  '1234567890',
  'qwerty',
  'abc123',
  'password1',
  'Password1',
  'admin',
  'letmein',
  'welcome',
  'monkey',
  '1234567',
  'sunshine',
  'princess',
  'football',
  'iloveyou',
  'trustno1',
  '123123',
]);

/**
 * Password validation requirements
 */
export interface PasswordValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate password strength
 */
export function validatePassword(password: string): PasswordValidationResult {
  const errors: string[] = [];

  if (password.length < 12) {
    errors.push('Password must be at least 12 characters');
  }

  if (password.length > 128) {
    errors.push('Password must be less than 128 characters');
  }

  if (!/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter');
  }

  if (!/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter');
  }

  if (!/[0-9]/.test(password)) {
    errors.push('Password must contain at least one number');
  }

  // Check against common passwords
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    errors.push('Password is too common. Please choose a more unique password');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Generate API key with 256-bit entropy
 */
export function generateApiKey(environment: 'test' | 'live'): string {
  const random = randomBytes(32).toString('base64url');
  return `pk_${environment}_${random}`;
}

/**
 * Hash API key using SHA-256
 */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/**
 * Get key prefix (first 12 chars) for indexed lookup
 */
export function getKeyPrefix(key: string): string {
  return key.substring(0, 12);
}

/**
 * Constant-time string comparison to prevent timing attacks
 */
export function secureCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);

  if (bufA.length !== bufB.length) {
    // Still do comparison to maintain constant time
    timingSafeEqual(bufA, bufA);
    return false;
  }

  return timingSafeEqual(bufA, bufB);
}

/**
 * Rate limiting check result
 */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
  retryAfter?: number;
}

/**
 * In-memory rate limit store
 * TODO: Replace with Redis for production
 */
const rateLimitStore = new Map<string, { count: number; resetAt: Date }>();

// Clean up expired entries periodically
setInterval(() => {
  const now = new Date();
  for (const [key, entry] of rateLimitStore.entries()) {
    if (now > entry.resetAt) {
      rateLimitStore.delete(key);
    }
  }
}, 60000); // Clean every minute

/**
 * Check rate limit
 */
export async function checkRateLimit(
  key: string,
  windowMs: number,
  maxAttempts: number
): Promise<RateLimitResult> {
  // Rate limit bypass removed — was `if (true)` which disabled all rate limiting

  const now = new Date();
  const record = rateLimitStore.get(key);

  if (!record || now > record.resetAt) {
    const resetAt = new Date(now.getTime() + windowMs);
    rateLimitStore.set(key, { count: 1, resetAt });
    return {
      allowed: true,
      remaining: maxAttempts - 1,
      resetAt,
    };
  }

  if (record.count >= maxAttempts) {
    const retryAfter = Math.ceil((record.resetAt.getTime() - now.getTime()) / 1000);
    return {
      allowed: false,
      remaining: 0,
      resetAt: record.resetAt,
      retryAfter,
    };
  }

  record.count++;
  return {
    allowed: true,
    remaining: maxAttempts - record.count,
    resetAt: record.resetAt,
  };
}

/**
 * Security event types
 */
export type SecurityEventType =
  | 'signup_success'
  | 'signup_failure'
  | 'signup_rate_limited'
  | 'login_success'
  | 'login_failure'
  | 'login_rate_limited'
  | 'account_locked'
  | 'api_key_created'
  | 'api_key_revoked'
  | 'api_key_rotated'
  | 'api_key_create_rate_limited'
  | 'api_key_create_failure'
  | 'api_key_revoke_unauthorized'
  | 'api_key_revoke_failure'
  | 'api_key_rotate_unauthorized'
  | 'api_key_rotate_failure'
  | 'api_key_auth_failure'
  | 'jwt_auth_failure'
  | 'auth_failure'
  | 'user_role_changed'
  | 'user_removed'
  | 'team_invite_sent'
  | 'team_invite_revoked'
  | 'team_invite_resent'
  | 'accept_invite_rate_limited'
  | 'accept_invite_failure'
  | 'accept_invite_success';

export type SecurityEventSeverity = 'info' | 'warning' | 'critical';

/**
 * Log security event
 */
export async function logSecurityEvent(
  eventType: SecurityEventType,
  severity: SecurityEventSeverity,
  details: Record<string, any>
): Promise<void> {
  try {
    const supabase = createClient();
    await (supabase.from('security_events') as any).insert({
      event_type: eventType,
      severity,
      tenant_id: details.tenantId || null,
      user_id: details.userId || null,
      ip_address: details.ip,
      user_agent: details.userAgent,
      details: details,
    });
  } catch (error) {
    // Don't fail the request if logging fails
    console.error('Failed to log security event:', error);
  }
}

/**
 * Add random delay to prevent timing attacks
 */
export async function addRandomDelay(minMs: number = 100, maxMs: number = 300): Promise<void> {
  const delay = minMs + Math.random() * (maxMs - minMs);
  await new Promise((resolve) => setTimeout(resolve, delay));
}

