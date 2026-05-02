-- Atomic-increment upsert for scanner_usage_events.
--
-- Why: the previous code path used supabase-js .upsert() with
-- ignoreDuplicates: false, which translates to ON CONFLICT DO UPDATE that
-- REPLACES the conflicting row's values. With Vercel's Fluid Compute running
-- multiple function instances in parallel, each instance has its own
-- in-memory buffer. When two instances flush a row for the same
-- (tenant, minute, endpoint, status) tuple, the second flush overwrote
-- the first instead of summing — silently dropping ~50% of recorded
-- requests in observed tests.
--
-- This RPC accepts a JSONB array of buffered rows and performs a single
-- atomic INSERT ... ON CONFLICT DO UPDATE that ADDS to the existing
-- count/duration/credits fields. Concurrent calls from different function
-- instances now sum correctly under the unique constraint added in
-- 20260424_scanner_usage_parent_unique.sql.

CREATE OR REPLACE FUNCTION scanner_usage_upsert(p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_rows integer;
BEGIN
  INSERT INTO scanner_usage_events (
    tenant_id,
    scanner_key_id,
    minute_bucket,
    method,
    path_template,
    status_code,
    actor_type,
    count,
    total_duration_ms,
    credits_consumed
  )
  SELECT
    (r->>'tenant_id')::uuid,
    NULLIF(r->>'scanner_key_id', '')::uuid,
    (r->>'minute_bucket')::timestamptz,
    r->>'method',
    r->>'path_template',
    (r->>'status_code')::int,
    r->>'actor_type',
    (r->>'count')::int,
    (r->>'total_duration_ms')::bigint,
    (r->>'credits_consumed')::int
  FROM jsonb_array_elements(p_rows) AS r
  ON CONFLICT (tenant_id, scanner_key_id, minute_bucket, method, path_template, status_code, actor_type)
  DO UPDATE SET
    count             = scanner_usage_events.count + EXCLUDED.count,
    total_duration_ms = scanner_usage_events.total_duration_ms + EXCLUDED.total_duration_ms,
    credits_consumed  = scanner_usage_events.credits_consumed + EXCLUDED.credits_consumed;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$$;

GRANT EXECUTE ON FUNCTION scanner_usage_upsert(jsonb) TO service_role;
