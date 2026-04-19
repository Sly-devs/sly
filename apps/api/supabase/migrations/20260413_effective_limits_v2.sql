-- Epic 73, Story 73.4: Effective Limit Calculation Trigger
-- Recalculates effective_limit_* columns on agents when:
--   1. An agent's kya_tier changes
--   2. A parent account's verification_tier changes (cascades to all child agents)
-- Uses MIN(kya_tier_limit, parent_account_tier_limit) rule.
-- T3 (value = 0) is treated as unlimited (no cap from that side).

-- =============================================================================
-- Helper function: recalculate effective limits for a single agent
-- =============================================================================
CREATE OR REPLACE FUNCTION public.recalculate_agent_effective_limits(p_agent_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_kya_tier INTEGER;
  v_parent_account_id UUID;
  v_parent_verification_tier INTEGER;
  v_kya_per_tx NUMERIC;
  v_kya_daily NUMERIC;
  v_kya_monthly NUMERIC;
  v_acct_per_tx NUMERIC;
  v_acct_daily NUMERIC;
  v_acct_monthly NUMERIC;
  v_eff_per_tx NUMERIC;
  v_eff_daily NUMERIC;
  v_eff_monthly NUMERIC;
  v_capped BOOLEAN;
BEGIN
  -- Get agent's KYA tier and parent account
  SELECT kya_tier, parent_account_id
  INTO v_kya_tier, v_parent_account_id
  FROM public.agents
  WHERE id = p_agent_id;

  IF NOT FOUND THEN RETURN; END IF;

  -- Get KYA tier limits
  SELECT per_transaction, daily, monthly
  INTO v_kya_per_tx, v_kya_daily, v_kya_monthly
  FROM public.kya_tier_limits
  WHERE tier = COALESCE(v_kya_tier, 0);

  -- Defaults if tier not found
  v_kya_per_tx := COALESCE(v_kya_per_tx, 0);
  v_kya_daily := COALESCE(v_kya_daily, 0);
  v_kya_monthly := COALESCE(v_kya_monthly, 0);

  -- If no parent account (standalone agent), use KYA limits only
  IF v_parent_account_id IS NULL THEN
    UPDATE public.agents SET
      effective_limit_per_tx = v_kya_per_tx,
      effective_limit_daily = v_kya_daily,
      effective_limit_monthly = v_kya_monthly,
      effective_limits_capped = false,
      updated_at = now()
    WHERE id = p_agent_id;
    RETURN;
  END IF;

  -- Get parent account's verification tier
  SELECT verification_tier
  INTO v_parent_verification_tier
  FROM public.accounts
  WHERE id = v_parent_account_id;

  -- Get account tier limits (NULL entity_type row for backwards compat)
  SELECT per_transaction, daily, monthly
  INTO v_acct_per_tx, v_acct_daily, v_acct_monthly
  FROM public.verification_tier_limits
  WHERE tier = COALESCE(v_parent_verification_tier, 0)
    AND entity_type IS NULL;

  v_acct_per_tx := COALESCE(v_acct_per_tx, 0);
  v_acct_daily := COALESCE(v_acct_daily, 0);
  v_acct_monthly := COALESCE(v_acct_monthly, 0);

  -- Apply MIN rule. T3 = 0 means unlimited (no cap from that side).
  -- If KYA limit is 0 (T3/custom), use account limit. And vice versa.
  -- If both are 0, result is 0 (both T3 = custom, set manually).
  IF v_kya_per_tx = 0 THEN
    v_eff_per_tx := v_acct_per_tx;
  ELSIF v_acct_per_tx = 0 THEN
    v_eff_per_tx := v_kya_per_tx;
  ELSE
    v_eff_per_tx := LEAST(v_kya_per_tx, v_acct_per_tx);
  END IF;

  IF v_kya_daily = 0 THEN
    v_eff_daily := v_acct_daily;
  ELSIF v_acct_daily = 0 THEN
    v_eff_daily := v_kya_daily;
  ELSE
    v_eff_daily := LEAST(v_kya_daily, v_acct_daily);
  END IF;

  IF v_kya_monthly = 0 THEN
    v_eff_monthly := v_acct_monthly;
  ELSIF v_acct_monthly = 0 THEN
    v_eff_monthly := v_kya_monthly;
  ELSE
    v_eff_monthly := LEAST(v_kya_monthly, v_acct_monthly);
  END IF;

  -- Capped = effective < kya (parent account is the bottleneck)
  v_capped := (v_eff_per_tx < v_kya_per_tx AND v_kya_per_tx > 0)
           OR (v_eff_daily < v_kya_daily AND v_kya_daily > 0)
           OR (v_eff_monthly < v_kya_monthly AND v_kya_monthly > 0);

  UPDATE public.agents SET
    effective_limit_per_tx = v_eff_per_tx,
    effective_limit_daily = v_eff_daily,
    effective_limit_monthly = v_eff_monthly,
    effective_limits_capped = v_capped,
    updated_at = now()
  WHERE id = p_agent_id;
END;
$$;

COMMENT ON FUNCTION public.recalculate_agent_effective_limits IS
  'Story 73.4: Recalculates effective limits for a single agent using MIN(KYA tier, parent account tier). T3 (0) = unlimited.';

-- =============================================================================
-- Trigger: recalculate on agent kya_tier change
-- =============================================================================
CREATE OR REPLACE FUNCTION public.trg_agent_kya_tier_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF OLD.kya_tier IS DISTINCT FROM NEW.kya_tier THEN
    PERFORM public.recalculate_agent_effective_limits(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_kya_tier_recalc ON agents;
CREATE TRIGGER agent_kya_tier_recalc
  AFTER UPDATE OF kya_tier ON agents
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_agent_kya_tier_change();

-- =============================================================================
-- Trigger: recalculate all child agents when account verification_tier changes
-- =============================================================================
CREATE OR REPLACE FUNCTION public.trg_account_verification_tier_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_agent_id UUID;
BEGIN
  IF OLD.verification_tier IS DISTINCT FROM NEW.verification_tier THEN
    FOR v_agent_id IN
      SELECT id FROM public.agents WHERE parent_account_id = NEW.id
    LOOP
      PERFORM public.recalculate_agent_effective_limits(v_agent_id);
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS account_verification_tier_recalc ON accounts;
CREATE TRIGGER account_verification_tier_recalc
  AFTER UPDATE OF verification_tier ON accounts
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_account_verification_tier_change();
