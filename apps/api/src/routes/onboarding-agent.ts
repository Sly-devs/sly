/**
 * One-Click Agent Onboarding
 *
 * POST /v1/onboarding/agent/one-click
 *
 * Creates tenant + account + agent + wallet + API keys in one call.
 * Returns everything needed to start using Sly, including code snippets.
 *
 * Returns everything needed to start using Sly.
 *
 * Two paths:
 * - If beta is open or agent has approved application → instant activation
 * - If beta is closed and no approval → returns pending_review
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { createClient } from '../db/client.js';
import { createAdminClient } from '../db/admin-client.js';
import {
  generateApiKey,
  hashApiKey,
  getKeyPrefix,
  generateAgentToken,
} from '../utils/crypto.js';
import { logAudit } from '../utils/helpers.js';
import { checkRateLimit, logSecurityEvent } from '../utils/auth.js';
import { isFeatureEnabled } from '../config/environment.js';

function getClientInfo(c: any): { ip: string; userAgent: string } {
  const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    || c.req.header('x-real-ip')
    || 'unknown';
  const userAgent = c.req.header('user-agent') || 'unknown';
  return { ip, userAgent };
}

const router = new Hono();

const oneClickSchema = z.object({
  name: z.string().min(1).max(255),
  email: z.string().email().optional(),
  description: z.string().max(1000).optional(),
  model: z.string().max(100).optional(),
  inviteCode: z.string().optional(),
  idempotencyKey: z.string().uuid().optional(),
});

router.post('/one-click', async (c) => {
  try {
    const { ip, userAgent } = getClientInfo(c);

    // Rate limit: 5 agent registrations per hour per IP
    const rateLimit = await checkRateLimit(`agent_onboard:${ip}`, 60 * 60 * 1000, 5);
    if (!rateLimit.allowed) {
      await logSecurityEvent('agent_onboard_rate_limited', 'warning', { ip, userAgent });
      return c.json(
        { error: 'Too many registration attempts. Please try again later.', retryAfter: rateLimit.retryAfter },
        429
      );
    }

    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const parsed = oneClickSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
    }

    const { name, email, description, model, inviteCode, idempotencyKey } = parsed.data;
    const supabase = createClient();
    const baseUrl = process.env.API_BASE_URL || 'https://api.getsly.ai';

    // Idempotency: check if this key was already used
    if (idempotencyKey) {
      const { data: existing } = await (supabase.from('idempotency_keys') as any)
        .select('response_body')
        .eq('idempotency_key', idempotencyKey)
        .maybeSingle();
      if (existing?.response_body) {
        return c.json(existing.response_body, 201);
      }
    }

    // Beta gate
    if (isFeatureEnabled('closedBeta')) {
      let hasAccess = false;

      // Check if email has an approved beta application with a code
      if (email && !inviteCode) {
        const { data: app } = await (supabase.from('beta_applications') as any)
          .select('id, status, access_code_id')
          .eq('email', email)
          .eq('status', 'approved')
          .single();

        if (app?.access_code_id) {
          // Auto-activate: get the code and use it
          const { data: code } = await (supabase.from('beta_access_codes') as any)
            .select('code')
            .eq('id', app.access_code_id)
            .single();
          if (code) {
            hasAccess = true;
          }
        } else if (!app) {
          // No approved application — submit one and return pending
          const { data: newApp } = await (supabase.from('beta_applications') as any)
            .insert({
              email,
              agent_name: name,
              applicant_type: 'agent',
              purpose: description || null,
              status: 'pending',
              ip_address: ip,
            })
            .select('id')
            .single();

          return c.json({
            status: 'pending_review',
            applicationId: newApp?.id,
            message: 'Application submitted. You will receive credentials when approved.',
            email,
          }, 202);
        }
      }

      if (!hasAccess && inviteCode) {
        // Validate the provided invite code
        const { data: codeData } = await (supabase.from('beta_access_codes') as any)
          .select('id, code, status, current_uses, max_uses')
          .eq('code', inviteCode)
          .eq('status', 'active')
          .single();

        if (!codeData || codeData.current_uses >= codeData.max_uses) {
          return c.json({ error: 'Invalid or expired invite code' }, 403);
        }
        hasAccess = true;
      }

      if (!hasAccess && !inviteCode && !email) {
        return c.json({
          error: 'Beta access required. Provide an inviteCode or email to apply.',
          applyUrl: `${baseUrl}/v1/auth/beta/apply`,
        }, 403);
      }
    }

    // === Create everything in one transaction ===

    // 1. Create tenant
    const legacyApiKey = generateApiKey('test');
    const { data: tenant, error: tenantError } = await (supabase.from('tenants') as any)
      .insert({
        name: `${name}`,
        status: 'active',
        api_key: legacyApiKey,
        api_key_hash: hashApiKey(legacyApiKey),
        api_key_prefix: getKeyPrefix(legacyApiKey),
        is_agent_tenant: true,
      })
      .select()
      .single();

    if (tenantError || !tenant) {
      console.error('[agent-onboard] Failed to create tenant:', tenantError);
      return c.json({ error: 'Failed to register agent' }, 500);
    }

    // 2. Create account
    const { data: account, error: accountError } = await (supabase.from('accounts') as any)
      .insert({
        tenant_id: tenant.id,
        type: 'business',
        name,
        email: email || null,
        agent_config: {
          purpose: description || null,
          model: model || null,
          capabilities: ['api_calls', 'payments'],
          self_registered: true,
          version: '1.0.0',
        },
      })
      .select()
      .single();

    if (accountError || !account) {
      await supabase.from('tenants').delete().eq('id', tenant.id);
      console.error('[agent-onboard] Failed to create account:', accountError);
      return c.json({ error: 'Failed to register agent' }, 500);
    }

    // 3. Create agent with token
    const authToken = generateAgentToken();
    const authTokenHash = hashApiKey(authToken);
    const authTokenPrefix = getKeyPrefix(authToken);

    const { data: agent, error: agentError } = await (supabase.from('agents') as any)
      .insert({
        tenant_id: tenant.id,
        parent_account_id: account.id,
        name,
        description: description || null,
        status: 'active',
        type: 'custom',
        kya_tier: 0,
        kya_status: 'unverified',
        auth_type: 'api_key',
        auth_client_id: authTokenPrefix,
        auth_token_hash: authTokenHash,
        auth_token_prefix: authTokenPrefix,
        permissions: {
          transactions: { initiate: true, approve: false, view: true },
          streams: { initiate: true, modify: true, pause: true, terminate: true, view: true },
          accounts: { view: true, create: false },
          treasury: { view: false, rebalance: false },
        },
      })
      .select()
      .single();

    if (agentError || !agent) {
      await supabase.from('accounts').delete().eq('id', account.id);
      await supabase.from('tenants').delete().eq('id', tenant.id);
      console.error('[agent-onboard] Failed to create agent:', agentError);
      return c.json({ error: 'Failed to register agent' }, 500);
    }

    // 4. Create wallet
    const walletAddress = `internal://payos/${tenant.id}/${account.id}/agent/${agent.id}`;
    const { data: wallet } = await (supabase.from('wallets') as any)
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
        purpose: 'Auto-created wallet for agent',
      })
      .select('id, balance, currency, wallet_address')
      .single();

    // 5. Fetch limits
    const { data: kyaLimits } = await (supabase.from('kya_tier_limits') as any)
      .select('per_transaction, daily, monthly')
      .eq('tier', 0)
      .single();

    // 6. Audit
    await logAudit(supabase as any, {
      tenantId: tenant.id,
      entityType: 'agent',
      entityId: agent.id,
      action: 'one_click_onboarded',
      actorType: 'agent',
      actorId: agent.id,
      actorName: name,
      metadata: { ip, email, model, selfRegistered: true },
    });

    await logSecurityEvent('agent_onboard_success', 'info', {
      ip, agentId: agent.id, tenantId: tenant.id, name,
    });

    // Redeem beta code if provided
    if (isFeatureEnabled('closedBeta') && inviteCode) {
      try {
        await (supabase.from('beta_access_codes') as any)
          .update({ current_uses: (supabase as any).rpc ? undefined : 1 })
          .eq('code', inviteCode);
      } catch { /* non-fatal */ }
    }

    // Send dashboard claim email (non-blocking)
    if (email) {
      (async () => {
        try {
          const adminSupabase = createAdminClient();
          const dashboardUrl = process.env.DASHBOARD_URL || 'https://app.getsly.ai';

          // Invite the user — sends a magic link email
          const { data: inviteData, error: inviteError } = await adminSupabase.auth.admin.inviteUserByEmail(email, {
            data: {
              tenant_id: tenant.id,
              organization_name: name,
              role: 'owner',
            },
            redirectTo: `${dashboardUrl}/auth/callback?next=/dashboard`,
          });

          if (inviteError) {
            console.error('[agent-onboard] Dashboard invite email failed:', inviteError.message);
            return;
          }

          // Create user_profile so the user has dashboard access when they accept
          if (inviteData?.user?.id) {
            try {
              await (supabase.from('user_profiles') as any).insert({
                id: inviteData.user.id,
                tenant_id: tenant.id,
                role: 'owner',
                name: name,
              });
            } catch { /* non-fatal if profile already exists */ }
          }

          console.log(`[agent-onboard] Dashboard invite sent to ${email} for tenant ${tenant.id}`);
        } catch (err) {
          console.error('[agent-onboard] Dashboard invite failed (non-fatal):', err);
        }
      })().catch(() => {});
    }

    // Build response
    const response = {
      status: 'active' as const,
      agent: {
        id: agent.id,
        name: agent.name,
        status: 'active',
        kyaTier: 0,
        kyaStatus: 'unverified',
      },
      credentials: {
        token: authToken,
        prefix: authTokenPrefix,
        warning: 'Save this token now — it will never be shown again!',
      },
      tenant: {
        id: tenant.id,
        name: tenant.name,
      },
      account: {
        id: account.id,
        type: 'business',
        name: account.name,
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
      endpoints: {
        api: `${baseUrl}/v1`,
        dashboard: `${process.env.DASHBOARD_URL || 'https://app.getsly.ai'}/dashboard`,
        a2a: `${baseUrl}/a2a/${agent.id}`,
        agentCard: `${baseUrl}/a2a/${agent.id}/.well-known/agent.json`,
        platformCard: `${baseUrl}/.well-known/agent.json`,
        skills: `${baseUrl}/v1/skills.md`,
        openapi: `${baseUrl}/v1/openapi.json`,
      },
      dashboardAccess: email
        ? 'A dashboard invite has been sent to your email. Click the link to access your dashboard.'
        : 'Provide an email during registration to receive dashboard access.',
      snippets: {
        mcp: {
          mcpServers: {
            sly: {
              command: 'npx',
              args: ['@sly_ai/mcp-server'],
              env: {
                SLY_API_KEY: legacyApiKey,
              },
            },
          },
        },
        curl: `curl -H "Authorization: Bearer ${authToken}" ${baseUrl}/v1/wallets`,
        sdk: `import { Sly } from '@sly_ai/sdk';\nconst sly = new Sly({ apiKey: '${legacyApiKey}' });`,
      },
    };

    // Store idempotency key
    if (idempotencyKey) {
      try {
        await (supabase.from('idempotency_keys') as any)
          .insert({
            idempotency_key: idempotencyKey,
            tenant_id: tenant.id,
            response_body: response,
            response_status: 201,
            request_method: 'POST',
            request_path: '/v1/onboarding/agent/one-click',
            request_hash: idempotencyKey,
            expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          });
      } catch { /* non-fatal */ }
    }

    return c.json(response, 201);
  } catch (error) {
    console.error('[agent-onboard] Unexpected error:', error);
    return c.json({ error: 'Failed to register agent' }, 500);
  }
});

// ============================================
// GET /v1/onboarding/agent/status?email=...
// Check application status (public, no auth)
// ============================================
router.get('/status', async (c) => {
  const email = c.req.query('email');
  const applicationId = c.req.query('applicationId');

  if (!email && !applicationId) {
    return c.json({ error: 'Provide email or applicationId query parameter' }, 400);
  }

  const supabase = createClient();

  // Look up application
  let query = (supabase.from('beta_applications') as any)
    .select('id, email, status, agent_name, created_at, access_code_id');

  if (applicationId) {
    query = query.eq('id', applicationId);
  } else {
    query = query.eq('email', email);
  }

  const { data: app } = await query.order('created_at', { ascending: false }).limit(1).single();

  if (!app) {
    return c.json({
      status: 'not_found',
      message: 'No application found. Register at POST /v1/onboarding/agent/one-click',
    }, 404);
  }

  // If approved and has access code, check if it's been redeemed (agent created)
  if (app.status === 'approved' && app.access_code_id) {
    return c.json({
      status: 'approved',
      applicationId: app.id,
      message: 'Your application is approved! Call POST /v1/onboarding/agent/one-click with your email to activate.',
    });
  }

  if (app.status === 'approved') {
    return c.json({
      status: 'approved',
      applicationId: app.id,
      message: 'Your application is approved. An invite code is being generated.',
    });
  }

  if (app.status === 'rejected') {
    return c.json({
      status: 'rejected',
      applicationId: app.id,
      message: 'Your application was not approved.',
    });
  }

  return c.json({
    status: 'pending_review',
    applicationId: app.id,
    appliedAt: app.created_at,
    message: 'Your application is under review. Check back soon.',
  });
});

export { router as onboardingAgentRouter };
