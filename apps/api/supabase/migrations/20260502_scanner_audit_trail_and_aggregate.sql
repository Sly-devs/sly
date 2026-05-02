-- Two coupled changes:
--
-- 1. Add request_id to merchant_scans so each scan result can be traced
--    back to the credit ledger row that paid for it. Today the ledger
--    only records source = "request:<uuid>" with no way to find the
--    actual scan output — partners can't audit "what did I get for
--    this charge?".
--
-- 2. Add scanner_usage_aggregate(tenant_id, from, to, group_by) so
--    /v1/scanner/usage can group server-side. The previous code path
--    fetched all usage rows into Node and aggregated in JS, which got
--    silently truncated at the supabase-js default 1000-row cap. For
--    Demo Fintech (3,652 rows) this dropped most of today's scan
--    activity from the "Top endpoints" view.

-- ============================================================
-- 1. merchant_scans.request_id
-- ============================================================

ALTER TABLE merchant_scans
  ADD COLUMN IF NOT EXISTS request_id text;

CREATE INDEX IF NOT EXISTS idx_merchant_scans_request_id
  ON merchant_scans (request_id)
  WHERE request_id IS NOT NULL;

-- ============================================================
-- 2. scanner_usage_aggregate
-- ============================================================
--
-- Returns one row per (method, path_template) with summed counts when
-- p_group_by = 'endpoint', or one row per UTC day when p_group_by = 'day'.
-- Filtered by tenant + optional time range. Errors counted via status_code.

CREATE OR REPLACE FUNCTION scanner_usage_aggregate(
  p_tenant_id uuid,
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL,
  p_group_by text DEFAULT 'endpoint'
)
RETURNS TABLE (
  bucket text,
  method text,
  path_template text,
  requests bigint,
  credits bigint,
  errors bigint,
  total_duration_ms bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF p_group_by = 'day' THEN
    RETURN QUERY
    SELECT
      to_char(date_trunc('day', e.minute_bucket), 'YYYY-MM-DD') AS bucket,
      NULL::text AS method,
      NULL::text AS path_template,
      SUM(e.count)::bigint AS requests,
      SUM(e.credits_consumed)::bigint AS credits,
      SUM(CASE WHEN e.status_code >= 400 THEN e.count ELSE 0 END)::bigint AS errors,
      SUM(e.total_duration_ms)::bigint AS total_duration_ms
    FROM scanner_usage_events e
    WHERE e.tenant_id = p_tenant_id
      AND (p_from IS NULL OR e.minute_bucket >= p_from)
      AND (p_to   IS NULL OR e.minute_bucket <= p_to)
    GROUP BY date_trunc('day', e.minute_bucket)
    ORDER BY bucket;
  ELSE
    -- Default: group by endpoint (method + path_template)
    RETURN QUERY
    SELECT
      NULL::text AS bucket,
      e.method,
      e.path_template,
      SUM(e.count)::bigint AS requests,
      SUM(e.credits_consumed)::bigint AS credits,
      SUM(CASE WHEN e.status_code >= 400 THEN e.count ELSE 0 END)::bigint AS errors,
      SUM(e.total_duration_ms)::bigint AS total_duration_ms
    FROM scanner_usage_events e
    WHERE e.tenant_id = p_tenant_id
      AND (p_from IS NULL OR e.minute_bucket >= p_from)
      AND (p_to   IS NULL OR e.minute_bucket <= p_to)
    GROUP BY e.method, e.path_template
    ORDER BY requests DESC;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION scanner_usage_aggregate(uuid, timestamptz, timestamptz, text) TO service_role;

-- ============================================================
-- 3. scanner_credits_by_endpoint
-- ============================================================
--
-- Ground-truth credit aggregation per endpoint, sourced from the credit
-- ledger (synchronous, never undercounts). Used by the dashboard's
-- "Top endpoints" table for the credits column so pre-2026-05-02 data
-- loss in scanner_usage_events doesn't make billed activity appear smaller
-- than it really was. Refunds net against the original consume.

CREATE OR REPLACE FUNCTION scanner_credits_by_endpoint(
  p_tenant_id uuid,
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL
)
RETURNS TABLE (
  endpoint text,
  scans bigint,
  credits bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    COALESCE(l.metadata->>'endpoint', 'unknown')::text AS endpoint,
    SUM(CASE WHEN l.reason = 'consume' THEN 1 ELSE -1 END)::bigint AS scans,
    SUM(-l.delta)::bigint AS credits
  FROM scanner_credit_ledger l
  WHERE l.tenant_id = p_tenant_id
    AND l.reason IN ('consume', 'refund')
    AND (p_from IS NULL OR l.created_at >= p_from)
    AND (p_to   IS NULL OR l.created_at <= p_to)
  GROUP BY l.metadata->>'endpoint'
  HAVING SUM(CASE WHEN l.reason = 'consume' THEN 1 ELSE -1 END) > 0
  ORDER BY credits DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION scanner_credits_by_endpoint(uuid, timestamptz, timestamptz) TO service_role;
