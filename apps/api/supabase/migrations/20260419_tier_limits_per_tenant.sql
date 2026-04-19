-- Per-tenant tier limits with platform ceiling.
--
-- Before: kya_tier_limits + verification_tier_limits were GLOBAL — one row
-- per tier shared across every tenant. Any tenant owner who could edit them
-- via /v1/tier-limits PATCH affected everyone.
--
-- After: each table gets a `tenant_id UUID` column (nullable). Rows with
-- tenant_id IS NULL are the **platform ceiling** (set by platform staff).
-- Rows with a tenant_id are per-tenant overrides — tenants can tighten
-- their limits but not raise them above the ceiling. The API layer
-- enforces the ceiling; this migration just makes the data shape support it.
--
-- The calculate_agent_effective_limits trigger + utility function now prefer
-- tenant-specific rows, falling back to the platform default row. Existing
-- rows keep tenant_id=NULL so they become the platform defaults — no data
-- migration beyond the schema change.

-- ============================================================================
-- 1. Schema — id PK, tenant_id column, composite unique indexes
-- ============================================================================

-- kya_tier_limits: promote `id` to NOT NULL PK, drop old (tier) PK.
UPDATE public.kya_tier_limits SET id = gen_random_uuid() WHERE id IS NULL;
ALTER TABLE public.kya_tier_limits
  ALTER COLUMN id SET NOT NULL,
  ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE public.kya_tier_limits DROP CONSTRAINT IF EXISTS kya_tier_limits_pkey CASCADE;
ALTER TABLE public.kya_tier_limits DROP CONSTRAINT IF EXISTS kya_tier_limits_tier_key CASCADE;
ALTER TABLE public.kya_tier_limits ADD CONSTRAINT kya_tier_limits_pkey PRIMARY KEY (id);
ALTER TABLE public.kya_tier_limits ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id) ON DELETE CASCADE;

DROP INDEX IF EXISTS public.kya_tier_limits_tenant_tier_key;
CREATE UNIQUE INDEX kya_tier_limits_tenant_tier_key
  ON public.kya_tier_limits (tenant_id, tier) NULLS NOT DISTINCT;
CREATE INDEX IF NOT EXISTS kya_tier_limits_tenant_idx
  ON public.kya_tier_limits (tenant_id) WHERE tenant_id IS NOT NULL;

-- verification_tier_limits: same shape, entity_type in the uniqueness key.
UPDATE public.verification_tier_limits SET id = gen_random_uuid() WHERE id IS NULL;
ALTER TABLE public.verification_tier_limits
  ALTER COLUMN id SET NOT NULL,
  ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE public.verification_tier_limits DROP CONSTRAINT IF EXISTS verification_tier_limits_pkey CASCADE;
ALTER TABLE public.verification_tier_limits DROP CONSTRAINT IF EXISTS verification_tier_limits_tier_key CASCADE;
ALTER TABLE public.verification_tier_limits ADD CONSTRAINT verification_tier_limits_pkey PRIMARY KEY (id);
ALTER TABLE public.verification_tier_limits ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id) ON DELETE CASCADE;

DROP INDEX IF EXISTS public.verification_tier_limits_tenant_tier_key;
CREATE UNIQUE INDEX verification_tier_limits_tenant_tier_key
  ON public.verification_tier_limits (tenant_id, tier, entity_type) NULLS NOT DISTINCT;
CREATE INDEX IF NOT EXISTS verification_tier_limits_tenant_idx
  ON public.verification_tier_limits (tenant_id) WHERE tenant_id IS NOT NULL;

-- ============================================================================
-- 2. Trigger function — tenant-aware agent limit recalculation
-- ============================================================================
-- Fires BEFORE INSERT OR UPDATE OF kya_tier, parent_account_id on agents.
-- Prefers the tenant-specific tier row; falls back to the NULL-tenant row.

CREATE OR REPLACE FUNCTION public.calculate_agent_effective_limits()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
DECLARE
  v_parent_tier INTEGER;
  v_parent_type TEXT;
  v_agent_limits RECORD;
  v_parent_limits RECORD;
BEGIN
  SELECT verification_tier, type INTO v_parent_tier, v_parent_type
  FROM public.accounts WHERE id = NEW.parent_account_id;

  SELECT per_transaction, daily, monthly INTO v_agent_limits
  FROM public.kya_tier_limits
  WHERE tier = NEW.kya_tier
    AND (tenant_id = NEW.tenant_id OR tenant_id IS NULL)
  ORDER BY (tenant_id IS NULL)
  LIMIT 1;

  SELECT per_transaction, daily, monthly INTO v_parent_limits
  FROM public.verification_tier_limits
  WHERE tier = COALESCE(v_parent_tier, 0)
    AND (tenant_id = NEW.tenant_id OR tenant_id IS NULL)
    AND (entity_type = v_parent_type OR entity_type IS NULL)
  ORDER BY
    (tenant_id IS NULL),
    (entity_type IS NULL)
  LIMIT 1;

  NEW.limit_per_transaction := COALESCE(v_agent_limits.per_transaction, 0);
  NEW.limit_daily            := COALESCE(v_agent_limits.daily, 0);
  NEW.limit_monthly          := COALESCE(v_agent_limits.monthly, 0);

  NEW.effective_limit_per_tx := LEAST(
    COALESCE(v_agent_limits.per_transaction, 0),
    COALESCE(v_parent_limits.per_transaction, 0)
  );
  NEW.effective_limit_daily := LEAST(
    COALESCE(v_agent_limits.daily, 0),
    COALESCE(v_parent_limits.daily, 0)
  );
  NEW.effective_limit_monthly := LEAST(
    COALESCE(v_agent_limits.monthly, 0),
    COALESCE(v_parent_limits.monthly, 0)
  );

  NEW.effective_limits_capped := (
    COALESCE(v_agent_limits.per_transaction, 0) > COALESCE(v_parent_limits.per_transaction, 0) OR
    COALESCE(v_agent_limits.daily, 0) > COALESCE(v_parent_limits.daily, 0) OR
    COALESCE(v_agent_limits.monthly, 0) > COALESCE(v_parent_limits.monthly, 0)
  );

  RETURN NEW;
END;
$function$;

-- ============================================================================
-- 3. Utility function (p_agent_id uuid arg) — same tenant-aware resolution
-- ============================================================================

CREATE OR REPLACE FUNCTION public.calculate_agent_effective_limits(p_agent_id UUID)
RETURNS TABLE (
  max_transaction_amount NUMERIC,
  daily_transaction_limit NUMERIC,
  monthly_transaction_limit NUMERIC,
  max_active_streams INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_kya_tier INTEGER;
  v_tenant_id UUID;
  v_custom_limits JSONB;
  v_per_tx NUMERIC;
  v_daily NUMERIC;
  v_monthly NUMERIC;
  v_streams INTEGER;
BEGIN
  SELECT kya_tier, tenant_id, custom_limits
    INTO v_kya_tier, v_tenant_id, v_custom_limits
  FROM public.agents
  WHERE id = p_agent_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Agent not found: %', p_agent_id;
  END IF;

  SELECT per_transaction, daily, monthly, COALESCE(max_active_streams, 0)
    INTO v_per_tx, v_daily, v_monthly, v_streams
  FROM public.kya_tier_limits
  WHERE tier = v_kya_tier
    AND (tenant_id = v_tenant_id OR tenant_id IS NULL)
  ORDER BY (tenant_id IS NULL)
  LIMIT 1;

  IF NOT FOUND THEN
    v_per_tx := 1000;
    v_daily  := 5000;
    v_monthly := 50000;
    v_streams := 5;
  END IF;

  RETURN QUERY SELECT
    COALESCE((v_custom_limits->>'max_transaction_amount')::NUMERIC, v_per_tx) AS max_transaction_amount,
    COALESCE((v_custom_limits->>'daily_transaction_limit')::NUMERIC, v_daily) AS daily_transaction_limit,
    COALESCE((v_custom_limits->>'monthly_transaction_limit')::NUMERIC, v_monthly) AS monthly_transaction_limit,
    COALESCE((v_custom_limits->>'max_active_streams')::INTEGER, v_streams) AS max_active_streams;
END;
$$;

COMMENT ON FUNCTION public.calculate_agent_effective_limits(uuid) IS
  'Resolves an agent effective limits by preferring a tenant-specific row in kya_tier_limits over the platform default (tenant_id IS NULL). custom_limits JSONB on the agent row still overrides both.';

-- ============================================================================
-- 4. RLS — everyone authenticated can read the ceiling; only service_role
--          writes (API layer enforces tenant scoping + ceiling validation).
-- ============================================================================

DROP POLICY IF EXISTS "authenticated_read_kya_tier_limits"           ON public.kya_tier_limits;
DROP POLICY IF EXISTS "service_role_write_kya_tier_limits"           ON public.kya_tier_limits;
DROP POLICY IF EXISTS "Authenticated users can view kya tier limits" ON public.kya_tier_limits;

CREATE POLICY "authenticated_read_kya_tier_limits"
  ON public.kya_tier_limits FOR SELECT TO authenticated, anon USING (true);
CREATE POLICY "service_role_write_kya_tier_limits"
  ON public.kya_tier_limits FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "authenticated_read_verification_tier_limits"           ON public.verification_tier_limits;
DROP POLICY IF EXISTS "service_role_write_verification_tier_limits"           ON public.verification_tier_limits;
DROP POLICY IF EXISTS "Authenticated users can view verification tier limits" ON public.verification_tier_limits;

CREATE POLICY "authenticated_read_verification_tier_limits"
  ON public.verification_tier_limits FOR SELECT TO authenticated, anon USING (true);
CREATE POLICY "service_role_write_verification_tier_limits"
  ON public.verification_tier_limits FOR ALL TO service_role USING (true) WITH CHECK (true);
