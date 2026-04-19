-- Fix the DB linter warnings surfaced on 2026-04-19:
--
--  1. rls_policy_always_true (18 policies):
--     policies named "service_role_*" / "System can *" were created without
--     `TO service_role` — Postgres defaults to PUBLIC, which means anon + auth
--     can read/write these tables through the Supabase public API. Restrict
--     each to service_role so the policy is only a bypass for our trusted
--     server-side code and RLS still applies to everyone else.
--
--  2. function_search_path_mutable (23 functions):
--     functions without a pinned search_path can be hijacked by objects in a
--     schema earlier on the caller's search_path (e.g. pg_temp). Lock
--     search_path = '' so every reference inside the function must be
--     fully-qualified (which they already are in our definitions).
--
--  3. public_bucket_allows_listing (agent-avatars):
--     the public read policy on storage.objects allows LIST operations, not
--     just direct URL access. Drop it — Supabase serves public-bucket URLs
--     through the CDN without a matching row-level SELECT policy, so avatars
--     still render in the browser.
--
--  4. auth_leaked_password_protection — enabled via Supabase dashboard, not
--     SQL. Tracked in followups.

-- ============================================================================
-- 1. Restrict broad "service_role" policies to the actual service_role
-- ============================================================================

DO $$
DECLARE
  rec RECORD;
  rels TEXT[] := ARRAY[
    'agent_observations', 'agent_shopping_tests', 'agent_skills',
    'agent_traffic_events', 'census_mcp_servers', 'census_scans',
    'checkout_telemetry', 'demand_intelligence', 'merchant_scans',
    'scan_accessibility', 'scan_batches', 'scan_protocol_results',
    'scan_snapshots', 'scan_structured_data', 'scenario_runs',
    'scenario_template_versions'
  ];
  r TEXT;
BEGIN
  FOREACH r IN ARRAY rels LOOP
    FOR rec IN
      SELECT policyname
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = r
        AND policyname ILIKE 'service_role%'
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', rec.policyname, r);
    END LOOP;
    -- Recreate as a single service-role-only bypass policy.
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
      'service_role_' || r,
      r
    );
  END LOOP;
END $$;

-- The audit / executions tables had differently-named policies — handle them explicitly.
DROP POLICY IF EXISTS "System can insert audit logs" ON public.connected_accounts_audit;
CREATE POLICY "service_role_insert_audit_logs"
  ON public.connected_accounts_audit
  FOR INSERT TO service_role WITH CHECK (true);

DROP POLICY IF EXISTS "System can insert rule executions" ON public.settlement_rule_executions;
CREATE POLICY "service_role_insert_rule_executions"
  ON public.settlement_rule_executions
  FOR INSERT TO service_role WITH CHECK (true);

DROP POLICY IF EXISTS "System can update rule executions" ON public.settlement_rule_executions;
CREATE POLICY "service_role_update_rule_executions"
  ON public.settlement_rule_executions
  FOR UPDATE TO service_role USING (true) WITH CHECK (true);

-- ============================================================================
-- 2. Pin search_path on every flagged function
-- ============================================================================

ALTER FUNCTION public.update_ucp_checkout_updated_at()         SET search_path = '';
ALTER FUNCTION public.update_workflow_templates_updated_at()   SET search_path = '';
ALTER FUNCTION public.update_ucp_order_updated_at()            SET search_path = '';
ALTER FUNCTION public.update_ucp_oauth_client_updated_at()     SET search_path = '';
ALTER FUNCTION public.update_ucp_linked_account_updated_at()   SET search_path = '';
ALTER FUNCTION public.update_ucp_settlement_updated_at()       SET search_path = '';
ALTER FUNCTION public.update_workflow_instances_updated_at()   SET search_path = '';
ALTER FUNCTION public.cleanup_expired_ucp_auth_codes()         SET search_path = '';
ALTER FUNCTION public.update_connected_accounts_updated_at()   SET search_path = '';
ALTER FUNCTION public.update_settlement_rules_updated_at()     SET search_path = '';
ALTER FUNCTION public.update_workflow_step_executions_updated_at() SET search_path = '';
ALTER FUNCTION public.update_payment_handler_updated_at()      SET search_path = '';
ALTER FUNCTION public.update_merchant_scans_updated_at()       SET search_path = '';
ALTER FUNCTION public.update_scan_batches_updated_at()         SET search_path = '';
ALTER FUNCTION public.update_a2a_tasks_updated_at()            SET search_path = '';
ALTER FUNCTION public.update_ap2_mandate_usage()               SET search_path = '';
ALTER FUNCTION public.scenario_templates_set_updated_at()      SET search_path = '';
ALTER FUNCTION public.increment_agent_counters(p_agent_id uuid, p_volume numeric) SET search_path = '';
ALTER FUNCTION public.create_default_settlement_rules()        SET search_path = '';
ALTER FUNCTION public.find_applicable_settlement_rules(p_tenant_id uuid, p_wallet_id uuid, p_transfer_type text) SET search_path = '';
ALTER FUNCTION public.check_threshold_rules(p_tenant_id uuid, p_wallet_id uuid, p_balance numeric, p_currency text) SET search_path = '';
ALTER FUNCTION public.reveal_double_blind_ratings(feedback_id_a uuid, feedback_id_b uuid) SET search_path = '';
ALTER FUNCTION public.settle_x402_payment(p_payment_id uuid, p_settlement_tx text) SET search_path = '';
ALTER FUNCTION public.settle_x402_payment(
  p_consumer_wallet_id uuid, p_provider_wallet_id uuid, p_gross_amount numeric,
  p_net_amount numeric, p_transfer_id uuid, p_tenant_id uuid, p_provider_tenant_id uuid
) SET search_path = '';

-- ============================================================================
-- 3. Drop the broad listing policy on the agent-avatars bucket.
--     Public-bucket URLs served via the CDN don't need a SELECT row policy,
--     so dropping this blocks LIST operations while images still render.
-- ============================================================================

DROP POLICY IF EXISTS "agent_avatars_public_read" ON storage.objects;
-- service_role write policy stays (added in 20260416_agent_avatars.sql).
