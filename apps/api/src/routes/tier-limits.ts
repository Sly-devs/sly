import { Hono } from 'hono';
import { z } from 'zod';
import { createClient } from '../db/client.js';
import { ValidationError } from '../middleware/error.js';
import type { RequestContext } from '../middleware/auth.js';

const app = new Hono<{ Variables: { ctx: RequestContext } }>();

// ============================================================================
// Per-tenant tier limits with platform ceiling.
//
// Schema (post-migration 20260419_tier_limits_per_tenant.sql):
//   - Rows with tenant_id IS NULL are the PLATFORM CEILING. Set by platform
//     staff, read-only for tenant users (surfaced here so the dashboard can
//     render the ceiling alongside the tenant's own value).
//   - Rows with a tenant_id are per-tenant overrides. Tenant owners/admins
//     may upsert these, but only with values ≤ the platform ceiling (ceiling
//     enforcement lives in this file — see PATCH handlers).
//   - calculate_agent_effective_limits() resolves tenant-specific first,
//     falling back to NULL-tenant, so agents automatically pick up whichever
//     is stricter.
// ============================================================================

const limitShape = z.object({
  per_transaction: z.number().min(0).max(10_000_000),
  daily: z.number().min(0).max(10_000_000),
  monthly: z.number().min(0).max(10_000_000),
  max_active_streams: z.number().int().min(0).max(100).optional(),
});

type LimitRow = {
  id: string;
  tier: number;
  tenant_id: string | null;
  per_transaction: number;
  daily: number;
  monthly: number;
  max_active_streams: number | null;
  entity_type?: string | null;
  updated_at: string;
};

function requireOwnerOrAdmin(ctx: RequestContext) {
  // Mutations write a row scoped to ctx.tenantId, so only dashboard users
  // with owner/admin role may touch them. API keys and agent tokens are
  // rejected outright — they shouldn't make platform-policy decisions.
  if (ctx.actorType !== 'user') {
    return { error: 'Only dashboard users can edit tier limits (API keys and agent tokens are rejected)' };
  }
  if (ctx.userRole !== 'owner' && ctx.userRole !== 'admin') {
    return { error: 'Owner or admin role required to edit tier limits' };
  }
  return null;
}

/**
 * GET /v1/tier-limits
 * Returns both the platform ceiling (tenant_id IS NULL) and the caller's
 * tenant-specific overrides. Dashboard uses this to render a ceiling +
 * editable-override pair per tier.
 */
app.get('/', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();

  const [kyaRes, verRes] = await Promise.all([
    supabase
      .from('kya_tier_limits')
      .select('id, tier, tenant_id, per_transaction, daily, monthly, max_active_streams, updated_at')
      .or(`tenant_id.is.null,tenant_id.eq.${ctx.tenantId}`)
      .order('tier'),
    supabase
      .from('verification_tier_limits')
      .select('id, tier, tenant_id, entity_type, per_transaction, daily, monthly, updated_at')
      .or(`tenant_id.is.null,tenant_id.eq.${ctx.tenantId}`)
      .order('tier'),
  ]);

  const kyaRows = (kyaRes.data ?? []) as LimitRow[];
  const verRows = (verRes.data ?? []) as LimitRow[];

  return c.json({
    kya: {
      platform: kyaRows.filter(r => r.tenant_id === null),
      tenant: kyaRows.filter(r => r.tenant_id === ctx.tenantId),
    },
    verification: {
      platform: verRows.filter(r => r.tenant_id === null),
      tenant: verRows.filter(r => r.tenant_id === ctx.tenantId),
    },
  });
});

/**
 * Shared ceiling-enforcement helper. Given a ceiling row and a proposed
 * new limit set, returns a ValidationError message if any field would
 * exceed the ceiling, or null if the proposal is valid.
 */
function checkCeiling(
  proposed: { per_transaction: number; daily: number; monthly: number; max_active_streams?: number },
  ceiling: Pick<LimitRow, 'per_transaction' | 'daily' | 'monthly' | 'max_active_streams'>,
): string | null {
  if (proposed.per_transaction > Number(ceiling.per_transaction)) {
    return `per_transaction (${proposed.per_transaction}) exceeds platform ceiling (${ceiling.per_transaction})`;
  }
  if (proposed.daily > Number(ceiling.daily)) {
    return `daily (${proposed.daily}) exceeds platform ceiling (${ceiling.daily})`;
  }
  if (proposed.monthly > Number(ceiling.monthly)) {
    return `monthly (${proposed.monthly}) exceeds platform ceiling (${ceiling.monthly})`;
  }
  if (
    proposed.max_active_streams !== undefined &&
    ceiling.max_active_streams != null &&
    proposed.max_active_streams > Number(ceiling.max_active_streams)
  ) {
    return `max_active_streams (${proposed.max_active_streams}) exceeds platform ceiling (${ceiling.max_active_streams})`;
  }
  return null;
}

/**
 * PATCH /v1/tier-limits/kya/:tier
 * Upsert the caller's tenant-specific KYA tier row. Rejects values above
 * the platform ceiling.
 */
app.patch('/kya/:tier', async (c) => {
  const ctx = c.get('ctx');
  const forbidden = requireOwnerOrAdmin(ctx);
  if (forbidden) return c.json(forbidden, 403);

  const tier = Number.parseInt(c.req.param('tier'), 10);
  if (!Number.isInteger(tier) || tier < 0 || tier > 3) {
    throw new ValidationError('Tier must be 0, 1, 2, or 3');
  }

  const body = await c.req.json();
  const parsed = limitShape.parse(body);

  const supabase = createClient();

  // Load the platform ceiling for this tier.
  const { data: ceiling } = await (supabase
    .from('kya_tier_limits')
    .select('per_transaction, daily, monthly, max_active_streams')
    .eq('tier', tier)
    .is('tenant_id', null)
    .maybeSingle()) as any;
  if (!ceiling) {
    return c.json({ error: `No platform ceiling defined for tier ${tier}` }, 500);
  }

  const ceilingError = checkCeiling(parsed, ceiling);
  if (ceilingError) {
    throw new ValidationError(ceilingError);
  }

  // Upsert the tenant's row. Composite unique index (tenant_id, tier) handles
  // the conflict; NULLS NOT DISTINCT isn't relevant here because we always
  // write a non-null tenant_id.
  const { data: upserted, error } = await (supabase.from('kya_tier_limits') as any)
    .upsert(
      {
        tenant_id: ctx.tenantId,
        tier,
        per_transaction: parsed.per_transaction,
        daily: parsed.daily,
        monthly: parsed.monthly,
        ...(parsed.max_active_streams !== undefined && { max_active_streams: parsed.max_active_streams }),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'tenant_id,tier' },
    )
    .select()
    .single();

  if (error) {
    return c.json({ error: error.message }, 500);
  }

  const affected = await recomputeForTenantKyaTier(supabase, ctx.tenantId, tier);
  return c.json({ tier: upserted, agentsUpdated: affected });
});

/**
 * PATCH /v1/tier-limits/verification/:tier
 * Upsert the caller's tenant-specific verification tier row. Optional
 * `?entity_type=person|business` narrows the target. Rejects values above
 * the platform ceiling.
 */
app.patch('/verification/:tier', async (c) => {
  const ctx = c.get('ctx');
  const forbidden = requireOwnerOrAdmin(ctx);
  if (forbidden) return c.json(forbidden, 403);

  const tier = Number.parseInt(c.req.param('tier'), 10);
  if (!Number.isInteger(tier) || tier < 0 || tier > 3) {
    throw new ValidationError('Tier must be 0, 1, 2, or 3');
  }

  const entityTypeRaw = c.req.query('entity_type');
  const entityType: 'person' | 'business' | null =
    entityTypeRaw === 'person' || entityTypeRaw === 'business' ? entityTypeRaw : null;

  const body = await c.req.json();
  const parsed = limitShape.parse(body);

  const supabase = createClient();

  // Load the matching platform ceiling. Prefer exact entity_type match,
  // fall back to NULL (generic) row.
  let ceilingQuery = supabase
    .from('verification_tier_limits')
    .select('per_transaction, daily, monthly, entity_type')
    .eq('tier', tier)
    .is('tenant_id', null) as any;
  ceilingQuery = entityType === null
    ? ceilingQuery.is('entity_type', null)
    : ceilingQuery.or(`entity_type.eq.${entityType},entity_type.is.null`);
  const { data: ceilingRows } = await ceilingQuery
    .order('entity_type', { nullsFirst: false })
    .limit(1);
  const ceiling = (ceilingRows ?? [])[0];
  if (!ceiling) {
    return c.json({ error: `No platform ceiling defined for verification tier ${tier}` }, 500);
  }

  const ceilingError = checkCeiling(parsed, ceiling);
  if (ceilingError) {
    throw new ValidationError(ceilingError);
  }

  const { data: upserted, error } = await (supabase.from('verification_tier_limits') as any)
    .upsert(
      {
        tenant_id: ctx.tenantId,
        tier,
        entity_type: entityType,
        per_transaction: parsed.per_transaction,
        daily: parsed.daily,
        monthly: parsed.monthly,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'tenant_id,tier,entity_type' },
    )
    .select()
    .single();

  if (error) {
    return c.json({ error: error.message }, 500);
  }

  const affected = await recomputeForTenantVerificationTier(
    supabase,
    ctx.tenantId,
    tier,
    entityType,
  );
  return c.json({ tier: upserted, agentsUpdated: affected });
});

/**
 * DELETE /v1/tier-limits/kya/:tier
 * Clear the caller's tenant-specific row so the tier reverts to the
 * platform ceiling.
 */
app.delete('/kya/:tier', async (c) => {
  const ctx = c.get('ctx');
  const forbidden = requireOwnerOrAdmin(ctx);
  if (forbidden) return c.json(forbidden, 403);

  const tier = Number.parseInt(c.req.param('tier'), 10);
  if (!Number.isInteger(tier) || tier < 0 || tier > 3) {
    throw new ValidationError('Tier must be 0, 1, 2, or 3');
  }

  const supabase = createClient();
  await (supabase.from('kya_tier_limits') as any)
    .delete()
    .eq('tenant_id', ctx.tenantId)
    .eq('tier', tier);

  const affected = await recomputeForTenantKyaTier(supabase, ctx.tenantId, tier);
  return c.json({ data: { tier, reset: true }, agentsUpdated: affected });
});

/**
 * DELETE /v1/tier-limits/verification/:tier
 * Same as above for verification tiers. `?entity_type=person|business`
 * narrows the row.
 */
app.delete('/verification/:tier', async (c) => {
  const ctx = c.get('ctx');
  const forbidden = requireOwnerOrAdmin(ctx);
  if (forbidden) return c.json(forbidden, 403);

  const tier = Number.parseInt(c.req.param('tier'), 10);
  if (!Number.isInteger(tier) || tier < 0 || tier > 3) {
    throw new ValidationError('Tier must be 0, 1, 2, or 3');
  }

  const entityTypeRaw = c.req.query('entity_type');
  const entityType: 'person' | 'business' | null =
    entityTypeRaw === 'person' || entityTypeRaw === 'business' ? entityTypeRaw : null;

  const supabase = createClient();
  let deleteQuery = (supabase.from('verification_tier_limits') as any)
    .delete()
    .eq('tenant_id', ctx.tenantId)
    .eq('tier', tier);
  deleteQuery = entityType === null
    ? deleteQuery.is('entity_type', null)
    : deleteQuery.eq('entity_type', entityType);
  await deleteQuery;

  const affected = await recomputeForTenantVerificationTier(
    supabase,
    ctx.tenantId,
    tier,
    entityType,
  );
  return c.json({ data: { tier, entity_type: entityType, reset: true }, agentsUpdated: affected });
});

// ============================================================================
// Recompute helpers — scoped to the caller's tenant only. Pulls the effective
// tier values via the same "tenant row OR platform fallback" logic the pg
// trigger uses, then writes each agent's limit_* + effective_limit_* columns.
// ============================================================================

async function recomputeForTenantKyaTier(
  supabase: ReturnType<typeof createClient>,
  tenantId: string,
  kyaTier: number,
): Promise<number> {
  const { data: agents } = await supabase
    .from('agents')
    .select('id, parent_account_id')
    .eq('tenant_id', tenantId)
    .eq('kya_tier', kyaTier) as any;
  if (!agents || agents.length === 0) return 0;
  return applyEffectiveLimits(supabase, tenantId, agents);
}

async function recomputeForTenantVerificationTier(
  supabase: ReturnType<typeof createClient>,
  tenantId: string,
  verificationTier: number,
  entityType: 'person' | 'business' | null,
): Promise<number> {
  let accountQuery = supabase
    .from('accounts')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('verification_tier', verificationTier) as any;
  if (entityType !== null) accountQuery = accountQuery.eq('type', entityType);

  const { data: accounts } = await accountQuery;
  if (!accounts || accounts.length === 0) return 0;

  const accountIds = accounts.map((a: any) => a.id);
  const { data: agents } = await supabase
    .from('agents')
    .select('id, parent_account_id')
    .eq('tenant_id', tenantId)
    .in('parent_account_id', accountIds) as any;
  if (!agents || agents.length === 0) return 0;

  return applyEffectiveLimits(supabase, tenantId, agents);
}

async function applyEffectiveLimits(
  supabase: ReturnType<typeof createClient>,
  tenantId: string,
  agents: Array<{ id: string; parent_account_id: string | null }>,
): Promise<number> {
  // Pull every KYA + verification row visible to this tenant (tenant rows
  // plus platform defaults). We resolve per-agent in JS.
  const { data: kyaRows } = await (supabase
    .from('kya_tier_limits')
    .select('tier, tenant_id, per_transaction, daily, monthly')
    .or(`tenant_id.is.null,tenant_id.eq.${tenantId}`)) as any;
  const { data: verRows } = await (supabase
    .from('verification_tier_limits')
    .select('tier, tenant_id, entity_type, per_transaction, daily, monthly')
    .or(`tenant_id.is.null,tenant_id.eq.${tenantId}`)) as any;

  // "tenant row preferred, else platform row" resolution.
  const pickKya = (tier: number) => {
    const rows = (kyaRows ?? []).filter((r: any) => r.tier === tier);
    return (
      rows.find((r: any) => r.tenant_id === tenantId) ??
      rows.find((r: any) => r.tenant_id === null) ??
      null
    );
  };
  const pickVer = (tier: number, type: string | null) => {
    const rows = (verRows ?? []).filter((r: any) => r.tier === tier);
    return (
      rows.find((r: any) => r.tenant_id === tenantId && r.entity_type === type) ??
      rows.find((r: any) => r.tenant_id === tenantId && r.entity_type === null) ??
      rows.find((r: any) => r.tenant_id === null && r.entity_type === type) ??
      rows.find((r: any) => r.tenant_id === null && r.entity_type === null) ??
      null
    );
  };

  // Re-fetch each agent with its kya_tier + parent account tier + entity type.
  const { data: full } = await (supabase
    .from('agents')
    .select('id, kya_tier, parent_account_id, accounts(verification_tier, type)')
    .in('id', agents.map(a => a.id))) as any;

  let updated = 0;
  for (const a of full ?? []) {
    const kya = pickKya(a.kya_tier);
    if (!kya) continue;

    const parent = a.accounts;
    const ver = parent && typeof parent.verification_tier === 'number'
      ? pickVer(parent.verification_tier, parent.type ?? null)
      : null;

    const eff = ver
      ? {
          per_transaction: Math.min(Number(kya.per_transaction), Number(ver.per_transaction)),
          daily: Math.min(Number(kya.daily), Number(ver.daily)),
          monthly: Math.min(Number(kya.monthly), Number(ver.monthly)),
        }
      : {
          per_transaction: Number(kya.per_transaction),
          daily: Number(kya.daily),
          monthly: Number(kya.monthly),
        };

    const { error } = await (supabase.from('agents') as any)
      .update({
        limit_per_transaction: kya.per_transaction,
        limit_daily: kya.daily,
        limit_monthly: kya.monthly,
        effective_limit_per_tx: eff.per_transaction,
        effective_limit_daily: eff.daily,
        effective_limit_monthly: eff.monthly,
        effective_limits_capped: !!ver && (
          Number(kya.per_transaction) > Number(ver.per_transaction) ||
          Number(kya.daily) > Number(ver.daily) ||
          Number(kya.monthly) > Number(ver.monthly)
        ),
        updated_at: new Date().toISOString(),
      })
      .eq('id', a.id);

    if (!error) updated += 1;
  }

  return updated;
}

export default app;
