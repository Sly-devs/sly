import { Hono } from 'hono';
import { z } from 'zod';
import { createClient } from '../db/client.js';
import { ValidationError } from '../middleware/error.js';
import type { RequestContext } from '../middleware/auth.js';

const app = new Hono<{ Variables: { ctx: RequestContext } }>();

const limitShape = z.object({
  per_transaction: z.number().min(0).max(10_000_000),
  daily: z.number().min(0).max(10_000_000),
  monthly: z.number().min(0).max(10_000_000),
  max_active_streams: z.number().int().min(0).max(100).optional(),
});

function requireAdminRole(ctx: RequestContext) {
  if (ctx.actorType === 'user' && ctx.userRole !== 'owner' && ctx.userRole !== 'admin') {
    return { error: 'Owner or admin role required to edit tier limits' };
  }
  return null;
}

// GET /v1/tier-limits — list both KYA (agent) and verification (account) tiers
app.get('/', async (c) => {
  const supabase = createClient();

  const [kyaRes, verRes] = await Promise.all([
    supabase.from('kya_tier_limits').select('tier, per_transaction, daily, monthly, max_active_streams, updated_at').order('tier'),
    supabase.from('verification_tier_limits').select('tier, entity_type, per_transaction, daily, monthly, updated_at').order('tier'),
  ]);

  return c.json({
    kya: kyaRes.data ?? [],
    verification: verRes.data ?? [],
  });
});

// PATCH /v1/tier-limits/kya/:tier — update a KYA agent tier
app.patch('/kya/:tier', async (c) => {
  const ctx = c.get('ctx');
  const forbidden = requireAdminRole(ctx);
  if (forbidden) return c.json(forbidden, 403);

  const tier = Number.parseInt(c.req.param('tier'), 10);
  if (!Number.isInteger(tier) || tier < 0 || tier > 3) {
    throw new ValidationError('Tier must be 0, 1, 2, or 3');
  }

  const body = await c.req.json();
  const parsed = limitShape.parse(body);

  const supabase = createClient();

  const { data: updated, error } = await (supabase.from('kya_tier_limits') as any)
    .update({
      per_transaction: parsed.per_transaction,
      daily: parsed.daily,
      monthly: parsed.monthly,
      ...(parsed.max_active_streams !== undefined && { max_active_streams: parsed.max_active_streams }),
      updated_at: new Date().toISOString(),
    })
    .eq('tier', tier)
    .select()
    .single();

  if (error) {
    return c.json({ error: error.message }, 500);
  }

  // Propagate to existing agents at this tier — recompute effective_limit_*
  // respecting parent account caps (min of agent-tier vs parent-verification-tier).
  const affected = await recomputeEffectiveLimitsForKyaTier(supabase, tier);

  return c.json({
    tier: updated,
    agentsUpdated: affected,
  });
});

// PATCH /v1/tier-limits/verification/:tier — update a verification account tier
// Optional ?entity_type=person|business (null matches the default row)
app.patch('/verification/:tier', async (c) => {
  const ctx = c.get('ctx');
  const forbidden = requireAdminRole(ctx);
  if (forbidden) return c.json(forbidden, 403);

  const tier = Number.parseInt(c.req.param('tier'), 10);
  if (!Number.isInteger(tier) || tier < 0 || tier > 3) {
    throw new ValidationError('Tier must be 0, 1, 2, or 3');
  }

  const entityTypeRaw = c.req.query('entity_type');
  const entityType = entityTypeRaw === 'person' || entityTypeRaw === 'business' ? entityTypeRaw : null;

  const body = await c.req.json();
  const parsed = limitShape.parse(body);

  const supabase = createClient();

  let query = (supabase.from('verification_tier_limits') as any)
    .update({
      per_transaction: parsed.per_transaction,
      daily: parsed.daily,
      monthly: parsed.monthly,
      updated_at: new Date().toISOString(),
    })
    .eq('tier', tier);

  query = entityType === null ? query.is('entity_type', null) : query.eq('entity_type', entityType);

  const { data: updated, error } = await query.select().single();
  if (error) {
    return c.json({ error: error.message }, 500);
  }

  // Propagate to agents whose parent account is at this verification tier
  const affected = await recomputeEffectiveLimitsForVerificationTier(supabase, tier, entityType);

  return c.json({
    tier: updated,
    agentsUpdated: affected,
  });
});

// ============================================================================
// Helpers — recompute per-agent effective limits when a tier changes.
// ============================================================================

async function recomputeEffectiveLimitsForKyaTier(
  supabase: ReturnType<typeof createClient>,
  kyaTier: number,
): Promise<number> {
  const { data: agents } = await supabase
    .from('agents')
    .select('id, parent_account_id')
    .eq('kya_tier', kyaTier) as any;

  if (!agents || agents.length === 0) return 0;

  return applyEffectiveLimits(supabase, agents);
}

async function recomputeEffectiveLimitsForVerificationTier(
  supabase: ReturnType<typeof createClient>,
  verificationTier: number,
  entityType: 'person' | 'business' | null,
): Promise<number> {
  // Find accounts at this tier (+ entity_type match if specified)
  let accountQuery = supabase
    .from('accounts')
    .select('id')
    .eq('verification_tier', verificationTier) as any;

  if (entityType !== null) accountQuery = accountQuery.eq('entity_type', entityType);

  const { data: accounts } = await accountQuery;
  if (!accounts || accounts.length === 0) return 0;

  const accountIds = accounts.map((a: any) => a.id);

  const { data: agents } = await supabase
    .from('agents')
    .select('id, parent_account_id')
    .in('parent_account_id', accountIds) as any;

  if (!agents || agents.length === 0) return 0;

  return applyEffectiveLimits(supabase, agents);
}

async function applyEffectiveLimits(
  supabase: ReturnType<typeof createClient>,
  agents: Array<{ id: string; parent_account_id: string | null }>,
): Promise<number> {
  const { data: kyaRows } = await supabase
    .from('kya_tier_limits')
    .select('tier, per_transaction, daily, monthly') as any;

  const { data: verRows } = await supabase
    .from('verification_tier_limits')
    .select('tier, entity_type, per_transaction, daily, monthly') as any;

  const kyaByTier = new Map<number, { per_transaction: number; daily: number; monthly: number }>();
  for (const r of kyaRows ?? []) kyaByTier.set(r.tier, r);

  const verByKey = new Map<string, { per_transaction: number; daily: number; monthly: number }>();
  for (const r of verRows ?? []) verByKey.set(`${r.tier}:${r.entity_type ?? 'null'}`, r);

  // Fetch each agent's actual kya_tier and its parent account's tier + type
  // Note: accounts.type is the column (enum: person/business/agent), not entity_type
  const { data: full } = await supabase
    .from('agents')
    .select('id, kya_tier, parent_account_id, accounts(verification_tier, type)')
    .in('id', agents.map(a => a.id)) as any;

  let updated = 0;
  for (const a of full ?? []) {
    const kya = kyaByTier.get(a.kya_tier);
    if (!kya) continue;

    const parent = a.accounts;
    let ver: { per_transaction: number; daily: number; monthly: number } | null = null;
    if (parent && typeof parent.verification_tier === 'number') {
      // accounts.type → verification_tier_limits.entity_type
      // person/business map directly; 'agent' falls through to null (default row)
      const entityType: string | null =
        parent.type === 'person' || parent.type === 'business' ? parent.type : null;
      ver =
        verByKey.get(`${parent.verification_tier}:${entityType ?? 'null'}`) ||
        verByKey.get(`${parent.verification_tier}:null`) ||
        null;
    }

    const eff = ver
      ? {
          per_transaction: Math.min(kya.per_transaction, ver.per_transaction),
          daily: Math.min(kya.daily, ver.daily),
          monthly: Math.min(kya.monthly, ver.monthly),
        }
      : kya;

    const { error } = await (supabase.from('agents') as any)
      .update({
        limit_per_transaction: kya.per_transaction,
        limit_daily: kya.daily,
        limit_monthly: kya.monthly,
        effective_limit_per_tx: eff.per_transaction,
        effective_limit_daily: eff.daily,
        effective_limit_monthly: eff.monthly,
        effective_limits_capped: ver
          ? eff.per_transaction < kya.per_transaction ||
            eff.daily < kya.daily ||
            eff.monthly < kya.monthly
          : false,
        updated_at: new Date().toISOString(),
      })
      .eq('id', a.id);

    if (!error) updated += 1;
  }

  return updated;
}

export default app;
