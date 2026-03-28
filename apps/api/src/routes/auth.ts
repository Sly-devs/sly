import { Hono } from 'hono';
import { z } from 'zod';
import { createClient } from '../db/client.js';
import { createAdminClient } from '../db/admin-client.js';
import { ValidationError } from '../middleware/error.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  validatePassword,
  generateApiKey,
  hashApiKey,
  getKeyPrefix,
  checkRateLimit,
  logSecurityEvent,
  addRandomDelay,
} from '../utils/auth.js';
import { provisionTenant, TenantProvisioningError } from '../services/tenant-provisioning.js';
import { generateAgentToken } from '../utils/crypto.js';
import { logAudit } from '../utils/helpers.js';
import { sendInviteAcceptedEmail, sendWelcomeEmail, sendAccountLockedEmail, getUserEmail, sendBetaApplicationReceivedEmail, sendBetaNewApplicationNotification } from '../services/email.js';
import { isFeatureEnabled } from '../config/environment.js';
import { validateBetaCode, redeemBetaCode, submitApplication, trackFunnelEvent } from '../services/beta-access.js';

const auth = new Hono();

// ============================================
// VALIDATION SCHEMAS
// ============================================

const signupSchema = z.object({
  email: z.string().email().min(1).max(255),
  password: z.string().min(12).max(128),
  organizationName: z.string().min(1).max(255),
  userName: z.string().min(1).max(255).optional(),
});

const loginSchema = z.object({
  email: z.string().email().min(1).max(255),
  password: z.string().min(1).max(255),
});

const acceptInviteSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(12).max(128),
  name: z.string().min(1).max(255).optional(),
});

function getClientInfo(c: any): { ip: string; userAgent: string } {
  const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    || c.req.header('x-real-ip')
    || 'unknown';
  const userAgent = c.req.header('user-agent') || 'unknown';
  return { ip, userAgent };
}

// ============================================
// POST /v1/auth/signup - Self-service signup
// ============================================
auth.post('/signup', async (c) => {
  try {
    const { ip, userAgent } = getClientInfo(c);

    // Rate limiting: 10 signups per hour per IP
    const rateLimit = await checkRateLimit(`signup:${ip}`, 60 * 60 * 1000, 10);
    if (!rateLimit.allowed) {
      await logSecurityEvent('signup_rate_limited', 'warning', { ip, userAgent });
      return c.json(
        {
          error: 'Too many signup attempts. Please try again later.',
          retryAfter: rateLimit.retryAfter,
        },
        429
      );
    }

    // Validate request body
    const body = await c.req.json();
    const validated = signupSchema.parse(body);

    // Validate password strength
    const passwordValidation = validatePassword(validated.password);
    if (!passwordValidation.valid) {
      return c.json(
        {
          error: 'Password validation failed',
          details: passwordValidation.errors,
        },
        400
      );
    }

    // Beta access gate
    if (isFeatureEnabled('closedBeta')) {
      const inviteCode = body.inviteCode;
      if (!inviteCode) {
        return c.json(
          { error: 'An invite code is required during the closed beta. Apply at /auth/signup to request access.' },
          403
        );
      }

      const validation = await validateBetaCode(inviteCode, 'human');
      if (!validation.valid) {
        return c.json({ error: validation.error }, 403);
      }
    }

    const supabase = createClient();

    // Get Supabase URL and service role key for admin operations
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    
    if (!supabaseUrl || !serviceRoleKey) {
      return c.json(
        {
          error: 'Server configuration error',
        },
        500
      );
    }

    // Create user in Supabase Auth using REST API
    // We'll handle duplicate email errors generically
    const createUserResponse = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${serviceRoleKey}`,
        'apikey': serviceRoleKey,
      },
      body: JSON.stringify({
        email: validated.email,
        password: validated.password,
        email_confirm: true,
        user_metadata: {
          name: validated.userName || validated.email.split('@')[0],
        },
      }),
    });

    if (!createUserResponse.ok) {
      const errorData = await createUserResponse.json().catch(() => ({}));
      
      // Generic error for any failure (including duplicate email) to prevent enumeration
      await addRandomDelay();
      await logSecurityEvent('signup_failure', 'info', {
        ip,
        userAgent,
        email: validated.email,
        reason: errorData.msg || 'unknown_error',
      });
      return c.json(
        {
          error: 'Unable to create account. Please check your information and try again.',
        },
        400
      );
    }

    const authData = await createUserResponse.json();

    if (!authData || !authData.id) {
      await logSecurityEvent('signup_failure', 'warning', {
        ip,
        userAgent,
        email: validated.email,
        error: 'user_creation_failed',
      });
      return c.json(
        {
          error: 'Unable to create account. Please try again.',
        },
        500
      );
    }

    const userId = authData.id;

    // Provision tenant, user profile, settings, and API keys
    let result;
    try {
      result = await provisionTenant(supabase, {
        userId,
        email: validated.email,
        organizationName: validated.organizationName,
        userName: validated.userName,
      });
    } catch (err) {
      // Rollback: delete auth user on provisioning failure
      await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${serviceRoleKey}`,
          'apikey': serviceRoleKey,
        },
      });
      await logSecurityEvent('signup_failure', 'warning', {
        ip,
        userAgent,
        userId,
        error: err instanceof TenantProvisioningError ? err.code : 'provisioning_failed',
      });
      return c.json(
        {
          error: err instanceof TenantProvisioningError ? err.message : 'Failed to create organization',
        },
        500
      );
    }

    // Redeem beta code if closed beta is enabled
    if (isFeatureEnabled('closedBeta') && body.inviteCode) {
      try {
        const redeemResult = await redeemBetaCode(body.inviteCode, result.tenant.id);
        trackFunnelEvent('signup_completed', {
          accessCodeId: redeemResult.code.id,
          tenantId: result.tenant.id,
          actorType: 'human',
          metadata: { email: validated.email },
        }).catch(() => {});
      } catch (err) {
        console.error('[signup] Beta code redemption failed (non-fatal):', err);
      }
    }

    // Generate session tokens
    const sessionResponse = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${serviceRoleKey}`,
        'apikey': serviceRoleKey,
      },
      body: JSON.stringify({
        email: validated.email,
        password: validated.password,
      }),
    });

    let sessionData: { access_token?: string; refresh_token?: string } | null = null;
    if (sessionResponse.ok) {
      sessionData = await sessionResponse.json();
    }

    // Log security event
    await logSecurityEvent('signup_success', 'info', {
      userId,
      tenantId: result.tenant.id,
      ip,
      userAgent,
    });

    // Send welcome email (fire-and-forget)
    sendWelcomeEmail({
      to: validated.email,
      userName: validated.userName || validated.email.split('@')[0],
      organizationName: validated.organizationName,
    }).catch(err => console.error('[email] Welcome email error:', err));

    // Return response (keys shown only once)
    return c.json(
      {
        user: result.user,
        tenant: result.tenant,
        apiKeys: result.apiKeys,
        session: {
          accessToken: sessionData?.access_token || null,
          refreshToken: sessionData?.refresh_token || null,
        },
        warning: 'API keys are shown only once. Please save them securely.',
      },
      201
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json(
        {
          error: 'Validation failed',
          details: error.errors,
        },
        400
      );
    }
    throw error;
  }
});

// ============================================
// POST /v1/auth/login - Email/password login
// ============================================
auth.post('/login', async (c) => {
  try {
    const { ip, userAgent } = getClientInfo(c);

    // Validate request body
    const body = await c.req.json();
    const validated = loginSchema.parse(body);

    // Rate limiting: 5 attempts per 15 minutes per account and IP
    const accountLimit = await checkRateLimit(
      `login:${validated.email}`,
      15 * 60 * 1000,
      5
    );
    if (!accountLimit.allowed) {
      await logSecurityEvent('login_rate_limited', 'warning', {
        ip,
        userAgent,
        email: validated.email,
      });
      return c.json(
        {
          error: 'Too many login attempts. Please try again later.',
          retryAfter: accountLimit.retryAfter,
        },
        429
      );
    }

    const ipLimit = await checkRateLimit(
      `login:ip:${ip}`,
      15 * 60 * 1000,
      100
    );
    if (!ipLimit.allowed) {
      await logSecurityEvent('login_rate_limited', 'warning', {
        ip,
        userAgent,
        email: validated.email,
      });
      return c.json(
        {
          error: 'Too many login attempts. Please try again later.',
          retryAfter: ipLimit.retryAfter,
        },
        429
      );
    }

    const supabase = createClient();
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceRoleKey) {
      return c.json(
        {
          error: 'Server configuration error',
        },
        500
      );
    }

    // Find user profile & tenant for lockout and context
    let userId: string | null = null;
    try {
      const listUsersResp = await fetch(
        `${supabaseUrl}/auth/v1/admin/users?email=${encodeURIComponent(
          validated.email
        )}`,
        {
          headers: {
            Authorization: `Bearer ${serviceRoleKey}`,
            apikey: serviceRoleKey,
          },
        }
      );
      if (listUsersResp.ok) {
        const listData: any = await listUsersResp.json();
        if (Array.isArray(listData.users) && listData.users.length > 0) {
          userId = listData.users[0].id;
        }
      }
    } catch {
      // Ignore admin lookup errors; we'll still attempt login
    }

    // If we have a userId, check lockout status from user_profiles
    if (userId) {
      const { data: profile } = await (supabase
        .from('user_profiles') as any)
        .select('failed_login_attempts, locked_until, tenant_id, role, name')
        .eq('id', userId)
        .single();

      if (profile?.locked_until && new Date(profile.locked_until) > new Date()) {
        await logSecurityEvent('account_locked', 'warning', {
          ip,
          userAgent,
          userId,
        });
        return c.json(
          {
            error: 'Too many login attempts. Your account is temporarily locked.',
          },
          429
        );
      }
    }

    // Attempt to create a session via Supabase Auth (password grant)
    const sessionResponse = await fetch(
      `${supabaseUrl}/auth/v1/token?grant_type=password`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${serviceRoleKey}`,
          apikey: serviceRoleKey,
        },
        body: JSON.stringify({
          email: validated.email,
          password: validated.password,
        }),
      }
    );

    if (!sessionResponse.ok) {
      // Login failed: invalid credentials or other error
      if (userId) {
        // Increment failed_login_attempts and possibly lock account
        const { data: profile } = await (supabase
          .from('user_profiles') as any)
          .select('failed_login_attempts')
          .eq('id', userId)
          .single();

        const attempts = (profile?.failed_login_attempts ?? 0) + 1;
        const updates: any = {
          failed_login_attempts: attempts,
          last_failed_login_at: new Date().toISOString(),
          last_failed_login_ip: ip,
        };

        if (attempts >= 5) {
          const lockedUntil = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
          updates.locked_until = lockedUntil.toISOString();
        }

        await (supabase.from('user_profiles') as any)
          .update(updates)
          .eq('id', userId);

        if (attempts >= 5) {
          await logSecurityEvent('account_locked', 'warning', {
            ip,
            userAgent,
            userId,
          });

          // Send account locked email (fire-and-forget)
          getUserEmail(userId).then(email => {
            if (email) {
              const { data: profile } = (supabase.from('user_profiles') as any)
                .select('name')
                .eq('id', userId)
                .single();
              // Use email as fallback name
              sendAccountLockedEmail({
                to: email,
                userName: email.split('@')[0],
              }).catch(err => console.error('[email] Account locked email error:', err));
            }
          }).catch(() => {});
        }
      }

      await addRandomDelay();
      await logSecurityEvent('login_failure', 'info', {
        ip,
        userAgent,
        email: validated.email,
      });

      return c.json(
        {
          error: 'Invalid credentials',
        },
        400
      );
    }

    const sessionData: any = await sessionResponse.json();
    const accessToken: string | undefined = sessionData.access_token;
    const refreshToken: string | undefined = sessionData.refresh_token;

    // Look up user profile & tenant info for response
    let userProfile: any = null;
    let tenant: any = null;
    if (userId) {
      const { data: profile } = await (supabase
        .from('user_profiles') as any)
        .select('tenant_id, role, name')
        .eq('id', userId)
        .single();
      userProfile = profile;

      if (profile?.tenant_id) {
        const { data: tenantData } = await (supabase
          .from('tenants') as any)
          .select('id, name, status')
          .eq('id', profile.tenant_id)
          .single();
        tenant = tenantData;
      }
    }

    if (userId) {
      // Reset failed_login_attempts on success
      await (supabase.from('user_profiles') as any)
        .update({
          failed_login_attempts: 0,
          locked_until: null,
        })
        .eq('id', userId);
    }

    await logSecurityEvent('login_success', 'info', {
      ip,
      userAgent,
      userId,
      tenantId: tenant?.id,
    });

    return c.json(
      {
        user: {
          id: userId,
          email: validated.email,
          name: userProfile?.name || validated.email.split('@')[0],
          role: userProfile?.role || 'member',
        },
        tenant: tenant
          ? {
              id: tenant.id,
              name: tenant.name,
              status: tenant.status,
            }
          : null,
        session: {
          accessToken: accessToken || null,
          refreshToken: refreshToken || null,
        },
      },
      200
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json(
        {
          error: 'Validation failed',
          details: error.errors,
        },
        400
      );
    }
    throw error;
  }
});

// ============================================
// GET /v1/auth/me - Get current user from access token
// ============================================
/**
 * GET /v1/auth/me
 * Supports BOTH session tokens (for dashboard) and API keys (for SDKs)
 */
auth.get('/me', async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'Missing or invalid authorization header' }, 401);
    }

    const token = authHeader.slice(7);
    
    // Detect token type: API keys start with pk_ or ak_, session tokens don't
    const isApiKey = token.startsWith('pk_') || token.startsWith('ak_') || token.startsWith('agent_');
    
    if (isApiKey) {
      // API KEY PATH - for SDKs
      // Apply auth middleware logic inline
      const supabase = createAdminClient();
      
      // Hash the provided key
      const keyHash = hashApiKey(token);
      
      // Look up API key
      const { data: apiKeyRecord } = await supabase
        .from('api_keys')
        .select('*')
        .eq('key_hash', keyHash)
        .eq('status', 'active')
        .single();
      
      if (!apiKeyRecord) {
        return c.json({ error: 'Invalid or expired API key' }, 401);
      }
      
      console.log('[/v1/auth/me] API key found:', { 
        tenant_id: apiKeyRecord.tenant_id, 
        created_by_user_id: apiKeyRecord.created_by_user_id 
      });
      
      // Check if it's a user key or agent key
      if (apiKeyRecord.created_by_user_id) {
        // USER API KEY (pk_)
        const { data: profile, error: profileError } = await supabase
          .from('user_profiles')
          .select('id, tenant_id, name, role')
          .eq('id', apiKeyRecord.created_by_user_id)
          .single();
        
        if (!profile) {
          return c.json({ error: 'User not found', details: profileError?.message }, 404);
        }
        
        // Get user's primary account
        const { data: accounts } = await supabase
          .from('accounts')
          .select('id, type')
          .eq('tenant_id', apiKeyRecord.tenant_id)
          .order('created_at', { ascending: true })
          .limit(1);
        
        return c.json({
          data: {
            type: 'user',
            userId: profile.id,
            accountId: accounts?.[0]?.id || null,
            organizationId: apiKeyRecord.tenant_id,
            name: profile.name,
            role: profile.role
          }
        });
      }
      
      // If no user ID, check if it's an agent API key
      // Look for agent with matching auth_token_prefix
      const keyPrefix = token.split('_')[0] + '_' + token.split('_')[1]; // e.g., "agent_BPdeBu"
      
      const { data: agent } = await supabase
        .from('agents')
        .select('id, name, type, status, parent_account_id, tenant_id, x402_enabled')
        .eq('auth_token_prefix', keyPrefix)
        .single();
      
      if (agent) {
        // AGENT API KEY (ak_ or agent_)
        const { data: wallet } = await supabase
          .from('wallets')
          .select('id, balance, currency')
          .eq('managed_by_agent_id', agent.id)
          .eq('status', 'active')
          .single();
        
        return c.json({
          data: {
            type: 'agent',
            agentId: agent.id,
            accountId: agent.parent_account_id,
            walletId: wallet?.id || null,
            walletBalance: wallet?.balance || 0,
            walletCurrency: wallet?.currency || 'USDC',
            organizationId: agent.tenant_id,
            name: agent.name,
            status: agent.status,
            x402Enabled: agent.x402_enabled
          }
        });
      }
      
      return c.json({ error: 'API key not associated with user or agent' }, 404);
      
    } else {
      // SESSION TOKEN PATH - for dashboard
      const supabase = createClient();
      
      const { data: userData, error } = await (supabase as any).auth.getUser(token);
      
      if (error || !userData?.user) {
        return c.json({ error: 'Invalid or expired session token' }, 401);
      }
      
      const userId = userData.user.id;
      
      const { data: profile } = await (supabase
        .from('user_profiles') as any)
        .select('tenant_id, role, name')
        .eq('id', userId)
        .single();
      
      let tenant: any = null;
      if (profile?.tenant_id) {
        const { data: tenantData } = await (supabase
          .from('tenants') as any)
          .select('id, name, status')
          .eq('id', profile.tenant_id)
          .single();
        tenant = tenantData;
      }
      
      return c.json({
        user: {
          id: userId,
          email: userData.user.email,
          name: profile?.name || userData.user.email?.split('@')[0],
          role: profile?.role || 'member',
        },
        tenant: tenant
          ? {
              id: tenant.id,
              name: tenant.name,
              status: tenant.status,
            }
          : null,
      });
    }
  } catch (error) {
    console.error('[/v1/auth/me] Error:', error);
    return c.json({ error: 'Failed to fetch user info' }, 500);
  }
});

// ============================================
// POST /v1/auth/provision - Provision tenant for authenticated user
// Called by web UI after email confirmation or OAuth
// ============================================
const provisionSchema = z.object({
  organizationName: z.string().min(1).max(255).optional(),
  userName: z.string().min(1).max(255).optional(),
});

auth.post('/provision', async (c) => {
  try {
    const { ip, userAgent } = getClientInfo(c);

    // Rate limiting: 10 provisions per hour per IP
    const rateLimit = await checkRateLimit(`provision:${ip}`, 60 * 60 * 1000, 10);
    if (!rateLimit.allowed) {
      await logSecurityEvent('provision_rate_limited', 'warning', { ip, userAgent });
      return c.json(
        { error: 'Too many attempts. Please try again later.', retryAfter: rateLimit.retryAfter },
        429
      );
    }

    // Validate JWT from Authorization header
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'Missing or invalid authorization header' }, 401);
    }

    const token = authHeader.slice(7);
    const supabase = createClient();

    const { data: userData, error: authError } = await (supabase as any).auth.getUser(token);
    if (authError || !userData?.user) {
      return c.json({ error: 'Invalid or expired session token' }, 401);
    }

    const userId = userData.user.id;
    const userEmail = userData.user.email;
    const userMetadata = userData.user.user_metadata || {};

    // Parse optional body
    let body: { organizationName?: string; userName?: string } = {};
    try {
      body = provisionSchema.parse(await c.req.json());
    } catch {
      // Body is optional — allow empty requests
    }

    // Resolve organization name: body > user_metadata > fallback
    const organizationName =
      body.organizationName ||
      userMetadata.organization_name ||
      userMetadata.full_name ||
      `${userEmail?.split('@')[0]}'s Organization`;

    const userName =
      body.userName ||
      userMetadata.name ||
      userMetadata.full_name ||
      userEmail?.split('@')[0];

    // Beta access gate for OAuth provision flow
    if (isFeatureEnabled('closedBeta')) {
      const inviteCode = (body as any).inviteCode;
      if (!inviteCode) {
        return c.json(
          { error: 'An invite code is required during the closed beta.' },
          403
        );
      }

      const validation = await validateBetaCode(inviteCode, 'human');
      if (!validation.valid) {
        return c.json({ error: validation.error }, 403);
      }
    }

    const result = await provisionTenant(supabase, {
      userId,
      email: userEmail || '',
      organizationName,
      userName,
    });

    // Redeem beta code and track funnel event
    if (isFeatureEnabled('closedBeta') && (body as any).inviteCode && !result.alreadyProvisioned) {
      try {
        const redeemResult = await redeemBetaCode((body as any).inviteCode, result.tenant.id);
        trackFunnelEvent('tenant_provisioned', {
          accessCodeId: redeemResult.code.id,
          tenantId: result.tenant.id,
          actorType: 'human',
        }).catch(() => {});
      } catch (err) {
        console.error('[provision] Beta code redemption failed (non-fatal):', err);
      }
    }

    await logSecurityEvent(
      result.alreadyProvisioned ? 'provision_idempotent' : 'provision_success',
      'info',
      { userId, tenantId: result.tenant.id, ip, userAgent }
    );

    return c.json(
      {
        user: result.user,
        tenant: result.tenant,
        apiKeys: result.alreadyProvisioned ? undefined : result.apiKeys,
        alreadyProvisioned: result.alreadyProvisioned,
        warning: result.alreadyProvisioned
          ? undefined
          : 'API keys are shown only once. Please save them securely.',
      },
      result.alreadyProvisioned ? 200 : 201
    );
  } catch (error) {
    if (error instanceof TenantProvisioningError) {
      return c.json({ error: error.message }, 500);
    }
    if (error instanceof z.ZodError) {
      return c.json({ error: 'Validation failed', details: error.errors }, 400);
    }
    console.error('[/v1/auth/provision] Error:', error);
    return c.json({ error: 'Failed to provision tenant' }, 500);
  }
});

// ============================================
// POST /v1/auth/accept-invite - Accept team invite
// ============================================
auth.post('/accept-invite', async (c) => {
  try {
    const { ip, userAgent } = getClientInfo(c);

    // Rate limiting: 10 attempts per hour per IP
    const rateLimit = await checkRateLimit(`accept-invite:${ip}`, 60 * 60 * 1000, 10);
    if (!rateLimit.allowed) {
      await logSecurityEvent('accept_invite_rate_limited', 'warning', { ip, userAgent });
      return c.json(
        {
          error: 'Too many attempts. Please try again later.',
          retryAfter: rateLimit.retryAfter,
        },
        429
      );
    }

    const body = await c.req.json();
    const validated = acceptInviteSchema.parse(body);

    // Validate password strength
    const passwordValidation = validatePassword(validated.password);
    if (!passwordValidation.valid) {
      return c.json(
        {
          error: 'Password validation failed',
          details: passwordValidation.errors,
        },
        400
      );
    }

    const supabase = createClient();

    // Look up invite by token
    const { data: invite, error: inviteError } = await (supabase
      .from('team_invites') as any)
      .select('id, tenant_id, email, role, name, expires_at, accepted_at')
      .eq('token', validated.token)
      .single();

    if (inviteError || !invite) {
      await addRandomDelay();
      return c.json({ error: 'Invalid or expired invite token' }, 400);
    }

    // Check if already accepted
    if (invite.accepted_at) {
      return c.json({ error: 'This invite has already been accepted' }, 400);
    }

    // Check if expired
    if (new Date(invite.expires_at) < new Date()) {
      return c.json({ error: 'This invite has expired' }, 400);
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceRoleKey) {
      return c.json({ error: 'Server configuration error' }, 500);
    }

    // Use admin client to check if user exists
    const adminClient = createAdminClient();
    const { data: existingUsers, error: listError } = await adminClient.auth.admin.listUsers();
    
    let userId: string | null = null;
    if (existingUsers && existingUsers.users) {
      const matchingUser = existingUsers.users.find(
        (u: any) => u.email?.toLowerCase() === invite.email.toLowerCase()
      );
      
      if (matchingUser) {
        userId = matchingUser.id;
        
        // Check if user already has a profile (already belongs to an org)
        const { data: existingProfile } = await (supabase
          .from('user_profiles') as any)
          .select('id, tenant_id')
          .eq('id', userId)
          .single();

        if (existingProfile) {
          return c.json(
            { error: 'This email is already associated with an organization' },
            400
          );
        }
      }
    }

    // Create new user if doesn't exist
    if (!userId) {
      const createUserResponse = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${serviceRoleKey}`,
          'apikey': serviceRoleKey,
        },
        body: JSON.stringify({
          email: invite.email,
          password: validated.password,
          email_confirm: true,
          user_metadata: {
            name: validated.name || invite.name || invite.email.split('@')[0],
          },
        }),
      });

      if (!createUserResponse.ok) {
        const errorData = await createUserResponse.json().catch(() => ({}));
        await addRandomDelay();
        await logSecurityEvent('accept_invite_failure', 'warning', {
          ip,
          userAgent,
          email: invite.email,
          reason: errorData.msg || 'user_creation_failed',
        });
        return c.json({ error: 'Failed to create user account' }, 500);
      }

      const authData = await createUserResponse.json();
      if (!authData || !authData.id) {
        return c.json({ error: 'Failed to create user account' }, 500);
      }
      userId = authData.id;
    }

    // Create user profile
    const { error: profileError } = await (supabase
      .from('user_profiles') as any)
      .insert({
        id: userId,
        tenant_id: invite.tenant_id,
        role: invite.role,
        name: validated.name || invite.name || invite.email.split('@')[0],
      });

    if (profileError) {
      await logSecurityEvent('accept_invite_failure', 'critical', {
        ip,
        userAgent,
        userId,
        tenantId: invite.tenant_id,
        error: 'profile_creation_failed',
      });
      return c.json({ error: 'Failed to create user profile' }, 500);
    }

    // Mark invite as accepted
    await (supabase.from('team_invites') as any)
      .update({ accepted_at: new Date().toISOString() })
      .eq('id', invite.id);

    // Generate session
    const sessionResponse = await fetch(
      `${supabaseUrl}/auth/v1/token?grant_type=password`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${serviceRoleKey}`,
          apikey: serviceRoleKey,
        },
        body: JSON.stringify({
          email: invite.email,
          password: validated.password,
        }),
      }
    );

    let sessionData: { access_token?: string; refresh_token?: string } | null = null;
    if (sessionResponse.ok) {
      sessionData = await sessionResponse.json();
    }

    // Get tenant info
    const { data: tenant } = await (supabase
      .from('tenants') as any)
      .select('id, name, status')
      .eq('id', invite.tenant_id)
      .single();

    await logSecurityEvent('accept_invite_success', 'info', {
      userId,
      tenantId: invite.tenant_id,
      role: invite.role,
      ip,
      userAgent,
    });

    // Send welcome email (fire-and-forget)
    const userName = validated.name || invite.name || invite.email.split('@')[0];
    const dashboardUrl = `${process.env.APP_URL || 'http://localhost:3000'}/dashboard`;
    sendInviteAcceptedEmail({
      to: invite.email,
      userName,
      organizationName: tenant?.name || 'your organization',
      role: invite.role,
      dashboardUrl,
    }).catch(() => {});

    return c.json(
      {
        user: {
          id: userId,
          email: invite.email,
          name: validated.name || invite.name || invite.email.split('@')[0],
          role: invite.role,
        },
        tenant: tenant
          ? {
              id: tenant.id,
              name: tenant.name,
              status: tenant.status,
            }
          : null,
        session: {
          accessToken: sessionData?.access_token || null,
          refreshToken: sessionData?.refresh_token || null,
        },
      },
      201
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json(
        {
          error: 'Validation failed',
          details: error.errors,
        },
        400
      );
    }
    throw error;
  }
});

// ============================================
// POST /v1/auth/refresh - Refresh access token
// ============================================
auth.post('/refresh', async (c) => {
  try {
    const { refreshSession, detectAnomalies } = await import('../services/sessions.js');
    const { ip, userAgent } = getClientInfo(c);

    // Validate request body
    const body = await c.req.json();
    const refreshToken = body.refreshToken;

    if (!refreshToken || typeof refreshToken !== 'string') {
      return c.json(
        {
          error: 'Refresh token is required',
        },
        400
      );
    }

    // Detect anomalies (async, don't block)
    // This will log suspicious activity but won't block the refresh
    const clientInfo = { ip, userAgent };
    
    try {
      // Refresh the session with token rotation
      const result = await refreshSession(refreshToken, clientInfo);

      return c.json(
        {
          session: {
            accessToken: result.accessToken,
            refreshToken: result.refreshToken,
            expiresIn: result.expiresIn,
          },
        },
        200
      );
    } catch (error: any) {
      // Check if it's a security breach (token reuse)
      if (error.message?.includes('security breach')) {
        return c.json(
          {
            error: 'Session invalidated due to suspicious activity. Please log in again.',
          },
          401
        );
      }

      return c.json(
        {
          error: 'Invalid or expired refresh token',
        },
        401
      );
    }
  } catch (error) {
    console.error('Token refresh error:', error);
    return c.json(
      {
        error: 'Failed to refresh token',
      },
      500
    );
  }
});

// ============================================
// GET /v1/auth/sessions - Get active sessions
// ============================================
auth.get('/sessions', async (c) => {
  try {
    const { getUserSessions } = await import('../services/sessions.js');
    const userId = c.get('userId');

    if (!userId) {
      return c.json(
        {
          error: 'Unauthorized',
        },
        401
      );
    }

    const sessions = await getUserSessions(userId);

    // Don't expose sensitive data
    const sanitizedSessions = sessions.map((s) => ({
      id: s.id,
      ipAddress: s.ipAddress,
      userAgent: s.userAgent,
      createdAt: s.createdAt,
      lastActivityAt: s.createdAt, // TODO: Track real last activity
      isCurrent: false, // TODO: Detect current session
    }));

    return c.json({ data: sanitizedSessions }, 200);
  } catch (error) {
    console.error('Get sessions error:', error);
    return c.json(
      {
        error: 'Failed to get sessions',
      },
      500
    );
  }
});

// ============================================
// DELETE /v1/auth/sessions/:id - Revoke a session
// ============================================
auth.delete('/sessions/:id', async (c) => {
  try {
    const { revokeSession } = await import('../services/sessions.js');
    const userId = c.get('userId');
    const sessionId = c.req.param('id');

    if (!userId) {
      return c.json(
        {
          error: 'Unauthorized',
        },
        401
      );
    }

    const success = await revokeSession(sessionId, userId);

    if (!success) {
      return c.json(
        {
          error: 'Session not found or already revoked',
        },
        404
      );
    }

    return c.json({ message: 'Session revoked successfully' }, 200);
  } catch (error) {
    console.error('Revoke session error:', error);
    return c.json(
      {
        error: 'Failed to revoke session',
      },
      500
    );
  }
});

// ============================================
// POST /v1/auth/sessions/revoke-all - Revoke all sessions
// ============================================
auth.post('/sessions/revoke-all', async (c) => {
  try {
    const { revokeAllUserSessions } = await import('../services/sessions.js');
    const userId = c.get('userId');

    if (!userId) {
      return c.json(
        {
          error: 'Unauthorized',
        },
        401
      );
    }

    const count = await revokeAllUserSessions(userId);

    return c.json(
      {
        message: 'All sessions revoked successfully',
        revokedCount: count,
      },
      200
    );
  } catch (error) {
    console.error('Revoke all sessions error:', error);
    return c.json(
      {
        error: 'Failed to revoke sessions',
      },
      500
    );
  }
});


// ============================================
// POST /v1/auth/agent-signup - Autonomous agent self-registration
// Story 59.14: Public endpoint (no auth required)
// ============================================
const agentSignupSchema = z.object({
  name: z.string().min(1).max(255),
  purpose: z.string().max(1000).optional(),
  capabilities: z.array(z.string().max(100)).max(20).optional(),
  model: z.string().max(255).optional(),
  callbackUrl: z.string().url().max(1024).optional(),
  inviteCode: z.string().optional(),
});

auth.post('/agent-signup', async (c) => {
  try {
    const { ip, userAgent } = getClientInfo(c);

    // Strict rate limiting: 5 agent signups per hour per IP
    const rateLimit = await checkRateLimit(`agent_signup:${ip}`, 60 * 60 * 1000, 5);
    if (!rateLimit.allowed) {
      await logSecurityEvent('agent_signup_rate_limited', 'warning', { ip, userAgent });
      return c.json(
        { error: 'Too many agent registration attempts. Please try again later.', retryAfter: rateLimit.retryAfter },
        429
      );
    }

    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const parsed = agentSignupSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
    }

    const { name, purpose, capabilities, model, callbackUrl } = parsed.data;

    // Beta access gate for agent signup
    if (isFeatureEnabled('closedBeta')) {
      const inviteCode = parsed.data.inviteCode || body.inviteCode;
      if (!inviteCode) {
        return c.json(
          { error: 'An invite code is required for agent registration during the closed beta.' },
          403
        );
      }

      const validation = await validateBetaCode(inviteCode, 'agent');
      if (!validation.valid) {
        return c.json({ error: validation.error }, 403);
      }
    }

    const supabase = createClient();

    // 1. Create agent tenant
    const legacyApiKey = generateApiKey('test');
    const tenantInsert: Record<string, any> = {
      name: `${name} (Agent)`,
      status: 'active',
      api_key: legacyApiKey,
      api_key_hash: hashApiKey(legacyApiKey),
      api_key_prefix: getKeyPrefix(legacyApiKey),
    };

    // Try with is_agent_tenant column (from migration 20260226)
    let { data: tenant, error: tenantError } = await (supabase
      .from('tenants') as any)
      .insert({ ...tenantInsert, is_agent_tenant: true })
      .select()
      .single();

    // Fallback: if is_agent_tenant column doesn't exist yet, insert without it
    if (tenantError && tenantError.message?.includes('is_agent_tenant')) {
      const fallback = await (supabase.from('tenants') as any)
        .insert(tenantInsert)
        .select()
        .single();
      tenant = fallback.data;
      tenantError = fallback.error;
    }

    if (tenantError || !tenant) {
      console.error('[agent-signup] Failed to create tenant:', tenantError);
      await logSecurityEvent('agent_signup_failure', 'error', { ip, reason: 'tenant_creation_failed' });
      return c.json({ error: 'Failed to register agent' }, 500);
    }

    // 2. Create agent account — use 'business' type (check constraint may not allow 'agent')
    const { data: account, error: accountError } = await (supabase
      .from('accounts') as any)
      .insert({
        tenant_id: tenant.id,
        type: 'business',
        name,
        agent_config: {
          purpose: purpose || null,
          capabilities: capabilities || ['api_calls', 'payments'],
          model: model || null,
          self_registered: true,
          version: '1.0.0',
        },
      })
      .select()
      .single();

    if (accountError || !account) {
      // Rollback tenant
      await supabase.from('tenants').delete().eq('id', tenant.id);
      console.error('[agent-signup] Failed to create account:', accountError);
      await logSecurityEvent('agent_signup_failure', 'error', { ip, reason: 'account_creation_failed' });
      return c.json({ error: 'Failed to register agent' }, 500);
    }

    // 3. Create agent record
    const authToken = generateAgentToken();
    const authTokenHash = hashApiKey(authToken);
    const authTokenPrefix = getKeyPrefix(authToken);

    const defaultPermissions = {
      transactions: { initiate: true, approve: false, view: true },
      streams: { initiate: true, modify: true, pause: true, terminate: true, view: true },
      accounts: { view: true, create: false },
      treasury: { view: false, rebalance: false },
    };

    const { data: agent, error: agentError } = await (supabase
      .from('agents') as any)
      .insert({
        tenant_id: tenant.id,
        parent_account_id: account.id, // Use own account as parent (self-referential)
        name,
        description: purpose || null,
        status: 'active',
        type: 'custom',
        kya_tier: 0,
        kya_status: 'unverified',
        auth_type: 'api_key',
        auth_client_id: authTokenPrefix,
        auth_token_hash: authTokenHash,
        auth_token_prefix: authTokenPrefix,
        permissions: defaultPermissions,
        endpoint_url: callbackUrl || null,
        endpoint_type: callbackUrl ? 'webhook' : 'none',
        endpoint_enabled: !!callbackUrl,
      })
      .select()
      .single();

    if (agentError || !agent) {
      // Rollback
      await supabase.from('accounts').delete().eq('id', account.id);
      await supabase.from('tenants').delete().eq('id', tenant.id);
      console.error('[agent-signup] Failed to create agent:', agentError);
      await logSecurityEvent('agent_signup_failure', 'error', { ip, reason: 'agent_creation_failed' });
      return c.json({ error: 'Failed to register agent' }, 500);
    }

    // 4. Create wallet for the agent
    const walletAddress = `internal://payos/${tenant.id}/${account.id}/agent/${agent.id}`;
    const { data: wallet, error: walletError } = await (supabase
      .from('wallets') as any)
      .insert({
        tenant_id: tenant.id,
        owner_account_id: account.id,
        managed_by_agent_id: agent.id,
        balance: 0,
        currency: 'USDC',
        wallet_address: walletAddress,
        network: 'internal',
        status: 'active',
        wallet_type: 'internal',
        name: `${name} Wallet`,
        purpose: `Auto-created wallet for self-registered agent`,
      })
      .select('id, balance, currency, wallet_address')
      .single();

    if (walletError) {
      console.error('[agent-signup] Warning: Failed to create wallet:', walletError);
      // Non-fatal — agent can still function
    }

    // 5. Fetch KYA tier 0 limits for the response
    const { data: kyaLimits } = await (supabase
      .from('kya_tier_limits') as any)
      .select('per_transaction, daily, monthly')
      .eq('tier', 0)
      .single();

    // 6. Audit log
    await logAudit(supabase as any, {
      tenantId: tenant.id,
      entityType: 'agent',
      entityId: agent.id,
      action: 'self_registered',
      actorType: 'agent',
      actorId: agent.id,
      actorName: name,
      metadata: { ip, purpose, capabilities, model, selfRegistered: true },
    });

    await logSecurityEvent('agent_signup_success', 'info', {
      ip,
      agentId: agent.id,
      tenantId: tenant.id,
      name,
    });

    // Redeem beta code if closed beta is enabled
    if (isFeatureEnabled('closedBeta') && (parsed.data.inviteCode || body.inviteCode)) {
      try {
        const redeemResult = await redeemBetaCode(parsed.data.inviteCode || body.inviteCode, tenant.id);
        trackFunnelEvent('signup_completed', {
          accessCodeId: redeemResult.code.id,
          tenantId: tenant.id,
          agentId: agent.id,
          actorType: 'agent',
        }).catch(() => {});
      } catch (err) {
        console.error('[agent-signup] Beta code redemption failed (non-fatal):', err);
      }
    }

    return c.json({
      agent: {
        id: agent.id,
        name: agent.name,
        status: agent.status,
        kyaTier: agent.kya_tier,
        kyaStatus: agent.kya_status,
      },
      credentials: {
        token: authToken,
        prefix: authTokenPrefix,
        warning: 'Save this token now - it will never be shown again!',
      },
      tenant: {
        id: tenant.id,
        name: tenant.name,
      },
      wallet: wallet ? {
        id: wallet.id,
        balance: wallet.balance,
        currency: wallet.currency,
        address: wallet.wallet_address,
      } : null,
      limits: kyaLimits ? {
        tier: 0,
        perTransaction: kyaLimits.per_transaction,
        daily: kyaLimits.daily,
        monthly: kyaLimits.monthly,
      } : null,
    }, 201);
  } catch (error) {
    console.error('[agent-signup] Unexpected error:', error);
    return c.json({ error: 'Failed to register agent' }, 500);
  }
});

// ============================================
// POST /v1/agents/:id/claim - Claim an autonomous agent
// Story 59.16: Bring a self-registered agent under a human tenant
// ============================================
auth.post('/agent-claim/:agentId', async (c) => {
  try {
    // This endpoint requires API key auth (human tenant)
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'Missing or invalid authorization header' }, 401);
    }

    const token = authHeader.slice(7);

    // Must be an API key (not JWT, not agent token)
    if (!token.startsWith('pk_')) {
      return c.json({ error: 'API key authentication required for claiming agents' }, 401);
    }

    const supabase = createClient();
    const keyHash = hashApiKey(token);

    const { data: apiKey } = await (supabase
      .from('api_keys') as any)
      .select('tenant_id, created_by_user_id')
      .eq('key_hash', keyHash)
      .eq('status', 'active')
      .single();

    if (!apiKey) {
      return c.json({ error: 'Invalid or expired API key' }, 401);
    }

    const claimingTenantId = apiKey.tenant_id;
    const agentId = c.req.param('agentId');

    // Find the agent
    const { data: agent, error: agentError } = await (supabase
      .from('agents') as any)
      .select('id, name, tenant_id, parent_account_id, status')
      .eq('id', agentId)
      .single();

    if (agentError || !agent) {
      return c.json({ error: 'Agent not found' }, 404);
    }

    // Verify it's a standalone agent on an agent tenant
    let agentTenant: any = null;
    // Try with is_agent_tenant column first
    const { data: t1, error: t1Err } = await (supabase
      .from('tenants') as any)
      .select('id, name, is_agent_tenant, claimed_by_tenant_id')
      .eq('id', agent.tenant_id)
      .single();

    if (t1Err && t1Err.message?.includes('is_agent_tenant')) {
      // Column doesn't exist yet — fall back to name-based check
      const { data: t2 } = await (supabase
        .from('tenants') as any)
        .select('id, name')
        .eq('id', agent.tenant_id)
        .single();
      agentTenant = t2 ? { ...t2, is_agent_tenant: t2.name?.endsWith('(Agent)'), claimed_by_tenant_id: null } : null;
    } else {
      agentTenant = t1;
    }

    if (!agentTenant?.is_agent_tenant) {
      return c.json({ error: 'This agent is not a self-registered agent and cannot be claimed' }, 400);
    }

    if (agentTenant.claimed_by_tenant_id) {
      return c.json({ error: 'This agent has already been claimed' }, 409);
    }

    // Transfer: update agent's tenant_id to the claiming tenant
    const { error: updateAgentError } = await (supabase
      .from('agents') as any)
      .update({ tenant_id: claimingTenantId })
      .eq('id', agentId);

    if (updateAgentError) {
      console.error('[agent-claim] Failed to update agent:', updateAgentError);
      return c.json({ error: 'Failed to claim agent' }, 500);
    }

    // Transfer the agent's account to the claiming tenant
    const { data: agentAccounts } = await (supabase
      .from('accounts') as any)
      .select('id')
      .eq('tenant_id', agent.tenant_id)
      .eq('type', 'agent');

    if (agentAccounts?.length) {
      await (supabase
        .from('accounts') as any)
        .update({ tenant_id: claimingTenantId })
        .in('id', agentAccounts.map((a: any) => a.id));
    }

    // Transfer wallets managed by this agent
    await (supabase
      .from('wallets') as any)
      .update({ tenant_id: claimingTenantId })
      .eq('managed_by_agent_id', agentId);

    // Also update wallet owner_account_id if the account was transferred
    if (agentAccounts?.length) {
      await (supabase
        .from('wallets') as any)
        .update({ owner_account_id: agentAccounts[0].id })
        .eq('managed_by_agent_id', agentId)
        .eq('tenant_id', claimingTenantId);
    }

    // Mark the original agent tenant as claimed
    await (supabase
      .from('tenants') as any)
      .update({ claimed_by_tenant_id: claimingTenantId })
      .eq('id', agentTenant.id);

    // Audit log
    await logAudit(supabase as any, {
      tenantId: claimingTenantId,
      entityType: 'agent',
      entityId: agentId,
      action: 'claimed',
      actorType: 'api_key',
      actorId: apiKey.created_by_user_id || 'unknown',
      actorName: 'API Key',
      metadata: {
        previousTenantId: agent.tenant_id,
        claimingTenantId,
        agentName: agent.name,
      },
    });

    await logSecurityEvent('agent_claimed', 'info', {
      agentId,
      agentName: agent.name,
      fromTenantId: agent.tenant_id,
      toTenantId: claimingTenantId,
    });

    return c.json({
      claimed: true,
      agent: {
        id: agentId,
        name: agent.name,
        tenantId: claimingTenantId,
      },
    });
  } catch (error) {
    console.error('[agent-claim] Unexpected error:', error);
    return c.json({ error: 'Failed to claim agent' }, 500);
  }
});

// ============================================
// POST /v1/auth/beta/apply - Submit beta application
// ============================================
auth.post('/beta/apply', async (c) => {
  try {
    const { ip } = getClientInfo(c);

    // Rate limiting: 3 applications per hour per IP
    const rateLimit = await checkRateLimit(`beta_apply:${ip}`, 60 * 60 * 1000, 3);
    if (!rateLimit.allowed) {
      return c.json(
        { error: 'Too many applications. Please try again later.', retryAfter: rateLimit.retryAfter },
        429
      );
    }

    const body = await c.req.json();
    const schema = z.object({
      email: z.string().email().max(255),
      organizationName: z.string().max(255).optional(),
      useCase: z.string().max(2000).optional(),
      referralSource: z.string().max(255).optional(),
      applicantType: z.enum(['human', 'agent']).optional(),
      agentName: z.string().max(255).optional(),
      purpose: z.string().max(1000).optional(),
      model: z.string().max(255).optional(),
    });

    const validated = schema.parse(body);
    const isAgent = validated.applicantType === 'agent';

    const application = await submitApplication({
      email: validated.email,
      applicantType: validated.applicantType || 'human',
      ...(isAgent
        ? {
            agentName: validated.agentName,
            useCase: validated.purpose,
            metadata: validated.model ? { model: validated.model } : undefined,
          }
        : {
            organizationName: validated.organizationName,
            useCase: validated.useCase,
          }),
      referralSource: validated.referralSource,
      ipAddress: ip,
    });

    // Send confirmation email (fire-and-forget)
    sendBetaApplicationReceivedEmail({
      to: validated.email,
      organizationName: validated.organizationName,
    }).catch(err => console.error('[email] Beta application received email error:', err));

    // Notify platform admins (fire-and-forget)
    const adminEmail = process.env.BETA_ADMIN_EMAIL;
    if (adminEmail) {
      sendBetaNewApplicationNotification({
        to: adminEmail,
        applicantEmail: validated.email,
        organizationName: validated.organizationName,
        applicantType: validated.applicantType || 'human',
      }).catch(err => console.error('[email] Beta admin notification error:', err));
    }

    return c.json({
      message: 'Application submitted successfully. We will review it and get back to you.',
      applicationId: application.id,
    }, 201);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json({ error: 'Validation failed', details: error.errors }, 400);
    }
    throw error;
  }
});

// ============================================
// POST /v1/auth/beta/validate - Validate an invite code
// ============================================
auth.post('/beta/validate', async (c) => {
  try {
    const body = await c.req.json();
    const schema = z.object({
      code: z.string().min(1).max(100),
      actorType: z.enum(['human', 'agent']).optional(),
    });

    const validated = schema.parse(body);
    const result = await validateBetaCode(validated.code, validated.actorType || 'human');

    // If valid, look up the linked application to pre-fill signup form
    let applicant: { email?: string; organization_name?: string } | undefined;
    if (result.valid && result.code?.id) {
      const supabase = createClient();
      const { data: app } = await (supabase.from('beta_applications') as any)
        .select('email, organization_name')
        .eq('access_code_id', result.code.id)
        .single();
      if (app) {
        applicant = { email: app.email, organization_name: app.organization_name };
      }
    }

    return c.json({
      valid: result.valid,
      error: result.valid ? undefined : result.error,
      ...(applicant ? { applicant } : {}),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json({ error: 'Validation failed', details: error.errors }, 400);
    }
    throw error;
  }
});

export default auth;

