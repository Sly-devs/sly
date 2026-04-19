-- Epic 73, Story 73.1: Tier Limits Lookup Tables
-- Closes infra drift: these tables exist in live Supabase but had no CREATE migration.
-- RLS policies already exist in 20251217_enable_rls_lookup_tables.sql and
-- 20251219_optimize_rls_settings_lookup.sql.
--
-- Column names match what application code queries:
--   agents.ts:49   → .select('per_transaction, daily, monthly').eq('tier', kyaTier)
--   agents.ts:58   → .select('per_transaction, daily, monthly').eq('tier', parentTier)
--   onboarding-agent.ts:218 → same pattern

-- =============================================================================
-- KYA Agent Tier Limits (T0-T3)
-- =============================================================================
CREATE TABLE IF NOT EXISTS kya_tier_limits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tier INTEGER NOT NULL UNIQUE CHECK (tier BETWEEN 0 AND 3),
  per_transaction NUMERIC(20,8) NOT NULL DEFAULT 0,
  daily NUMERIC(20,8) NOT NULL DEFAULT 0,
  monthly NUMERIC(20,8) NOT NULL DEFAULT 0,
  max_active_streams INTEGER DEFAULT 0,
  max_flow_rate_per_stream NUMERIC(20,8) DEFAULT 0,
  max_total_outflow NUMERIC(20,8) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Seed KYA tier limits
-- T0: $20/$100/$500 (marketplace-validated, diverges from spec v1.0 $10/$50/$200)
-- T1: $100/$500/$2,000
-- T2: $1,000/$5,000/$20,000
-- T3: 0 = custom/unlimited (handled in application code)
INSERT INTO kya_tier_limits (tier, per_transaction, daily, monthly, max_active_streams)
VALUES
  (0, 20, 100, 500, 0),
  (1, 100, 500, 2000, 2),
  (2, 1000, 5000, 20000, 5),
  (3, 0, 0, 0, 0)
ON CONFLICT (tier) DO UPDATE SET
  per_transaction = EXCLUDED.per_transaction,
  daily = EXCLUDED.daily,
  monthly = EXCLUDED.monthly,
  max_active_streams = EXCLUDED.max_active_streams,
  updated_at = now();

-- =============================================================================
-- Account Verification Tier Limits (T0-T3, person/business split at T2+)
-- =============================================================================
CREATE TABLE IF NOT EXISTS verification_tier_limits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tier INTEGER NOT NULL CHECK (tier BETWEEN 0 AND 3),
  entity_type TEXT CHECK (entity_type IN ('person', 'business')),
  per_transaction NUMERIC(20,8) NOT NULL DEFAULT 0,
  daily NUMERIC(20,8) NOT NULL DEFAULT 0,
  monthly NUMERIC(20,8) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (tier, entity_type)
);

-- Seed account tier limits (person)
-- T0: $100/$500/$2,000  T1: $500/$2,000/$10,000  T2: $5,000/$20,000/$100,000  T3: custom
INSERT INTO verification_tier_limits (tier, entity_type, per_transaction, daily, monthly)
VALUES
  (0, 'person', 100, 500, 2000),
  (1, 'person', 500, 2000, 10000),
  (2, 'person', 5000, 20000, 100000),
  (3, 'person', 0, 0, 0)
ON CONFLICT (tier, entity_type) DO UPDATE SET
  per_transaction = EXCLUDED.per_transaction,
  daily = EXCLUDED.daily,
  monthly = EXCLUDED.monthly,
  updated_at = now();

-- Seed account tier limits (business)
-- T0-T1: same as person. T2: $50,000/$200,000/$500,000. T3: custom.
INSERT INTO verification_tier_limits (tier, entity_type, per_transaction, daily, monthly)
VALUES
  (0, 'business', 100, 500, 2000),
  (1, 'business', 500, 2000, 10000),
  (2, 'business', 50000, 200000, 500000),
  (3, 'business', 0, 0, 0)
ON CONFLICT (tier, entity_type) DO UPDATE SET
  per_transaction = EXCLUDED.per_transaction,
  daily = EXCLUDED.daily,
  monthly = EXCLUDED.monthly,
  updated_at = now();

-- Also insert NULL entity_type rows for backwards compat with existing code
-- that queries .eq('tier', X) without entity_type filter (agents.ts:58).
-- These use person limits as the default.
INSERT INTO verification_tier_limits (tier, entity_type, per_transaction, daily, monthly)
VALUES
  (0, NULL, 100, 500, 2000),
  (1, NULL, 500, 2000, 10000),
  (2, NULL, 5000, 20000, 100000),
  (3, NULL, 0, 0, 0)
ON CONFLICT (tier, entity_type) DO UPDATE SET
  per_transaction = EXCLUDED.per_transaction,
  daily = EXCLUDED.daily,
  monthly = EXCLUDED.monthly,
  updated_at = now();

-- =============================================================================
-- Update the calculate_agent_effective_limits function to use new column names
-- =============================================================================
-- The existing function (from 20251219) uses old column names
-- (max_transaction_amount, daily_transaction_limit, monthly_transaction_limit).
-- Rewrite to use per_transaction, daily, monthly to match application code.
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
  v_custom_limits JSONB;
BEGIN
  -- Get agent's KYA tier and custom limits
  SELECT kya_tier, custom_limits
  INTO v_kya_tier, v_custom_limits
  FROM public.agents
  WHERE id = p_agent_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Agent not found: %', p_agent_id;
  END IF;

  -- Get tier limits from kya_tier_limits table (using new column names)
  RETURN QUERY
  SELECT
    COALESCE(
      (v_custom_limits->>'max_transaction_amount')::NUMERIC,
      ktl.per_transaction
    ) as max_transaction_amount,
    COALESCE(
      (v_custom_limits->>'daily_transaction_limit')::NUMERIC,
      ktl.daily
    ) as daily_transaction_limit,
    COALESCE(
      (v_custom_limits->>'monthly_transaction_limit')::NUMERIC,
      ktl.monthly
    ) as monthly_transaction_limit,
    COALESCE(
      (v_custom_limits->>'max_active_streams')::INTEGER,
      ktl.max_active_streams
    ) as max_active_streams
  FROM public.kya_tier_limits ktl
  WHERE ktl.tier = v_kya_tier;

  -- If no tier limits found, return defaults
  IF NOT FOUND THEN
    RETURN QUERY SELECT
      1000::NUMERIC as max_transaction_amount,
      5000::NUMERIC as daily_transaction_limit,
      50000::NUMERIC as monthly_transaction_limit,
      5::INTEGER as max_active_streams;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.calculate_agent_effective_limits IS
  'Story 73.1: Calculates effective limits for an agent based on KYA tier. '
  'Uses per_transaction/daily/monthly columns from kya_tier_limits table. '
  'SECURITY DEFINER with empty search_path for security.';
