# Epic 73: Per-Tenant Tier Limits with Platform Ceiling — Implementation Status

**Status**: ✅ Complete
**Date**: April 19, 2026
**Epic PRD**: [`docs/prd/epics/epic-73-kyc-kya-tiers.md`](../../prd/epics/epic-73-kyc-kya-tiers.md)
**Related Commits**: `507a31d` (initial editable limits), `d1184d1` (per-tenant refactor)

---

## What Was Built

Epic 73 Story 73.1 originally defined `tier_limits` as a single global table shared across every tenant. During a security review we realized any tenant owner/admin using a JWT could `PATCH /v1/tier-limits` and mutate caps that applied to every other tenant's agents — a cross-tenant data hazard and a compliance gap.

This follow-up refactor makes tier limits **per-tenant** with a **platform ceiling**:

- Rows with `tenant_id IS NULL` are the platform ceiling (service-role only).
- Rows with a `tenant_id` are per-tenant overrides. Tenants can **tighten** limits below the ceiling, never raise them above.
- The Postgres trigger + utility function prefer the tenant row, falling back to the platform row. Agent `effective_limit_*` columns automatically pick up whichever is stricter.
- API layer (`checkCeiling()`) rejects any PATCH that would exceed the platform ceiling.
- Dashboard surfaces both: ceiling is shown under each tier card; a "Custom" badge marks tenant overrides; a "Reset to default" button DELETEs the tenant row.
- Tenants needing headroom above a ceiling go through the existing `limit_increase_requests` flow (human review, per-industry).

### Tables affected

| Table | Change |
|---|---|
| `kya_tier_limits` | `id UUID PK`, added `tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE`; composite unique index `(tenant_id, tier) NULLS NOT DISTINCT` |
| `verification_tier_limits` | Same shape, `entity_type` included in the uniqueness key |

Existing rows are preserved with `tenant_id = NULL` — they automatically become the platform ceiling. No data migration was needed beyond the schema change.

### Functions affected

Both overloads of `calculate_agent_effective_limits` were rewritten:

1. **BEFORE INSERT/UPDATE trigger (zero-arg)** — fires on `agents.kya_tier` or `agents.parent_account_id` changes. Resolves tenant row first, falls back to platform.
2. **Utility function (`p_agent_id UUID` arg)** — used by reporting. Same resolution logic. The agent's `custom_limits` JSONB still overrides both.

Resolution query pattern (used by both functions):

```sql
SELECT per_transaction, daily, monthly
FROM public.kya_tier_limits
WHERE tier = :tier AND (tenant_id = :tenant_id OR tenant_id IS NULL)
ORDER BY (tenant_id IS NULL)  -- tenant row first, NULL row last
LIMIT 1;
```

### RLS policies

- `authenticated_read_kya_tier_limits` / `authenticated_read_verification_tier_limits` — SELECT open to `authenticated`, `anon` so the dashboard can show the ceiling.
- `service_role_write_kya_tier_limits` / `service_role_write_verification_tier_limits` — ALL restricted to `service_role`. The API layer owns tenant scoping + ceiling enforcement.

---

## API Endpoint Changes

**Before (global, vulnerable)**: `PATCH /v1/tier-limits/kya/:tier` mutated the single global row.

**After (per-tenant)**:

| Endpoint | Behavior |
|---|---|
| `GET /v1/tier-limits` | Returns `{ kya: {platform, tenant}, verification: {platform, tenant} }`. Both arrays, one per tier. |
| `PATCH /v1/tier-limits/kya/:tier` | Upserts the caller's tenant row. Loads platform ceiling first; rejects any field > ceiling. |
| `PATCH /v1/tier-limits/verification/:tier` | Same, plus optional `?entity_type=person\|business` narrowing. |
| `DELETE /v1/tier-limits/kya/:tier` | Removes the tenant row → tier reverts to platform ceiling for that tenant. |
| `DELETE /v1/tier-limits/verification/:tier` | Same. |

**Auth**: All mutations require a JWT session with role `owner` or `admin`. API keys and agent tokens are rejected outright — they should not make platform-policy decisions.

Recompute helpers are scoped to `ctx.tenantId`, so a PATCH from Tenant A never touches Tenant B's agents.

---

## Files Modified

| File | Role |
|---|---|
| `apps/api/supabase/migrations/20260419_tier_limits_per_tenant.sql` | Schema + function rewrites |
| `apps/api/src/routes/tier-limits.ts` | Full rewrite. `checkCeiling()` helper, tenant-scoped upsert, DELETE endpoints, recompute helpers |
| `apps/web/src/app/dashboard/settings/agent-tiers/page.tsx` | Ceiling + override UI, "Custom" badge, ceiling-capped inputs, Reset-to-default button |

---

## Verification

Ran on the live DB (April 19, 2026):

1. Tenant A sets T2 daily=400 (below platform ceiling of 500) → upsert succeeds.
2. Tenant A's T2 agent `limit_daily` updates 500 → 400 via the trigger.
3. Tenant B's T2 agent unchanged — still reads 500 (platform ceiling).
4. DELETE on Tenant A's T2 row → agent `limit_daily` snaps back to 500.
5. Resolution query returns the tenant row for A, NULL row for B. Confirmed.
6. RLS policy audit: only `service_role` has write access; reads open to authenticated.

CI green on `d1184d1`: TypeScript Check ✅, RLS Coverage Check ✅.

---

## Design Rationale

**Why ceiling enforcement instead of floor-only or admin-approval?**

Tenants needing *tighter* limits (most common case — a conservative fintech wants T2 capped at half of what the platform allows) can self-serve. Tenants needing *looser* limits (rare, high-risk) go through the increase-request flow where compliance can evaluate per-industry. This matches Epic 73's design principle 3 ("progressive disclosure — friction appears only when use case demands").

**Why `NULLS NOT DISTINCT` on the unique index?**

Postgres normally treats `NULL` as a distinct value in unique indexes — you could insert multiple `(NULL, 2)` rows. `NULLS NOT DISTINCT` (PG15+) treats NULL as a concrete value, so the single platform ceiling row per tier is enforced at the DB layer, not just in app code.

**Why resolve in both the trigger and the API layer's `applyEffectiveLimits`?**

The pg trigger fires on individual agent UPDATEs, which is fast and automatic. The API layer's recompute fires after a PATCH to the tier row, which the trigger can't observe (it's watching agents, not tier_limits). Both need identical resolution logic. The API implementation does it in TS for clarity.

---

## What's Next

- **Increase-request UX** — `limit_increase_requests` table exists (Epic 73 Story 73.7-ish) but no dashboard surface yet. Future work: inline "Request increase" button on each tier card when the ceiling is the binding constraint.
- **Verification tier editing in the dashboard** — `apps/web/src/app/dashboard/settings/verification-tiers/page.tsx` is still read-only and reads hardcoded seed values. The API endpoints support it; UI needs the same treatment as agent-tiers.
