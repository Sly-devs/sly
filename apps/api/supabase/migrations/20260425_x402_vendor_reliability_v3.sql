-- Epic 81 (extension) — fold per-call quality into vendor reliability.
--
-- v2 shipped the paid-vs-unredeemed split. v3 adds two more columns
-- that pick up x402_call_quality ratings:
--   * delivered_correctness — share of rated calls with
--     delivered_what_asked = true (0 .. 1)
--   * avg_result_score      — mean of the 0–100 score across rated calls
--
-- Both are NULL when no ratings exist for the host so callers can
-- distinguish "unrated" from "rated badly." Rated-call count also
-- bubbles up so the UI can show "5 rated / 27 calls" confidence.
--
-- When an agent rates the same transfer multiple times as the same
-- rater, the unique index on (transfer_id, rated_by_type, rated_by_id)
-- keeps one row — safe to aggregate without de-duping here. If both an
-- agent and a user rate the same transfer we count both, which is the
-- right behavior: two independent signals.

DROP FUNCTION IF EXISTS x402_vendor_reliability(uuid, timestamptz, text);

CREATE OR REPLACE FUNCTION x402_vendor_reliability(
  p_tenant_id uuid,
  p_since timestamptz DEFAULT (now() - interval '30 days'),
  p_environment text DEFAULT NULL
) RETURNS TABLE (
  host                             text,
  marketplace                      text,
  settlement_network               text,
  total_calls                      bigint,
  completed_count                  bigint,
  cancelled_count                  bigint,
  pending_count                    bigint,
  success_rate                     numeric,
  avg_response_size                numeric,
  avg_duration_ms                  numeric,
  classification_histogram         jsonb,
  last_success_at                  timestamptz,
  last_failure_at                  timestamptz,
  first_seen_at                    timestamptz,
  total_usdc_spent                 numeric,
  total_usdc_authorized_unredeemed numeric,
  total_usdc_paid_unreturned       numeric,
  rated_call_count                 bigint,
  delivered_correctness            numeric,
  avg_result_score                 numeric,
  top_quality_flags                jsonb
) LANGUAGE sql STABLE AS $$
  WITH scoped AS (
    SELECT
      id                                               AS transfer_id,
      protocol_metadata->'resource'->>'host'           AS host,
      protocol_metadata->'resource'->>'marketplace'    AS marketplace,
      settlement_network,
      status,
      tx_hash,
      amount::numeric                                  AS amount_usdc,
      (protocol_metadata->'response'->>'durationMs')::numeric AS duration_ms,
      (protocol_metadata->'response'->>'sizeBytes')::numeric  AS size_bytes,
      COALESCE(protocol_metadata->'classification'->>'code', 'UNCLASSIFIED') AS classification_code,
      created_at
    FROM transfers
    WHERE tenant_id = p_tenant_id
      AND type = 'x402'
      AND protocol_metadata->>'direction' = 'external'
      AND protocol_metadata->'resource'->>'host' IS NOT NULL
      AND created_at >= p_since
      AND (p_environment IS NULL OR environment = p_environment)
  ),
  histograms AS (
    SELECT host, jsonb_object_agg(classification_code, cnt) AS classification_histogram
    FROM (
      SELECT host, classification_code, COUNT(*) AS cnt
      FROM scoped WHERE status <> 'completed'
      GROUP BY host, classification_code
    ) h
    GROUP BY host
  ),
  quality AS (
    SELECT
      s.host,
      COUNT(q.id)                                                              AS rated_call_count,
      AVG(CASE WHEN q.delivered_what_asked THEN 1.0 ELSE 0.0 END)              AS delivered_correctness,
      AVG(q.score)                                                             AS avg_result_score
    FROM scoped s
    JOIN x402_call_quality q ON q.transfer_id = s.transfer_id
    GROUP BY s.host
  ),
  flags AS (
    SELECT host, jsonb_object_agg(flag, cnt) AS top_quality_flags
    FROM (
      SELECT s.host, f.flag, COUNT(*) AS cnt
      FROM scoped s
      JOIN x402_call_quality q ON q.transfer_id = s.transfer_id
      CROSS JOIN LATERAL unnest(COALESCE(q.flags, ARRAY[]::text[])) AS f(flag)
      GROUP BY s.host, f.flag
    ) fc
    GROUP BY host
  )
  SELECT
    s.host,
    max(s.marketplace)                                                            AS marketplace,
    mode() WITHIN GROUP (ORDER BY s.settlement_network)                           AS settlement_network,
    count(*)                                                                       AS total_calls,
    count(*) FILTER (WHERE s.status = 'completed')                                 AS completed_count,
    count(*) FILTER (WHERE s.status = 'cancelled')                                 AS cancelled_count,
    count(*) FILTER (WHERE s.status IN ('pending', 'processing'))                  AS pending_count,
    CASE WHEN count(*) > 0
      THEN round((count(*) FILTER (WHERE s.status = 'completed'))::numeric / count(*), 4)
      ELSE 0
    END                                                                           AS success_rate,
    round(avg(s.size_bytes) FILTER (WHERE s.size_bytes IS NOT NULL), 0)           AS avg_response_size,
    round(avg(s.duration_ms) FILTER (WHERE s.duration_ms IS NOT NULL), 0)         AS avg_duration_ms,
    COALESCE(h.classification_histogram, '{}'::jsonb)                             AS classification_histogram,
    max(s.created_at) FILTER (WHERE s.status = 'completed')                       AS last_success_at,
    max(s.created_at) FILTER (WHERE s.status = 'cancelled')                       AS last_failure_at,
    min(s.created_at)                                                             AS first_seen_at,
    COALESCE(sum(s.amount_usdc) FILTER (WHERE s.status = 'completed'), 0)         AS total_usdc_spent,
    COALESCE(sum(s.amount_usdc) FILTER (WHERE s.status = 'cancelled' AND s.tx_hash IS NULL), 0)      AS total_usdc_authorized_unredeemed,
    COALESCE(sum(s.amount_usdc) FILTER (WHERE s.status = 'cancelled' AND s.tx_hash IS NOT NULL), 0)  AS total_usdc_paid_unreturned,
    COALESCE(q.rated_call_count, 0)                                               AS rated_call_count,
    CASE WHEN q.rated_call_count > 0
      THEN round(q.delivered_correctness, 4)
      ELSE NULL
    END                                                                           AS delivered_correctness,
    CASE WHEN q.rated_call_count > 0
      THEN round(q.avg_result_score, 2)
      ELSE NULL
    END                                                                           AS avg_result_score,
    COALESCE(f.top_quality_flags, '{}'::jsonb)                                    AS top_quality_flags
  FROM scoped s
  LEFT JOIN histograms h USING (host)
  LEFT JOIN quality    q USING (host)
  LEFT JOIN flags      f USING (host)
  GROUP BY s.host, h.classification_histogram, q.rated_call_count, q.delivered_correctness, q.avg_result_score, f.top_quality_flags
  ORDER BY total_calls DESC;
$$;

GRANT EXECUTE ON FUNCTION x402_vendor_reliability(uuid, timestamptz, text) TO service_role;
GRANT EXECUTE ON FUNCTION x402_vendor_reliability(uuid, timestamptz, text) TO authenticated;
