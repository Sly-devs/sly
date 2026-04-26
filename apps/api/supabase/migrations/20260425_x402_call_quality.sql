-- Epic 81 (extension) — per-call result quality ratings.
--
-- Complements x402_vendor_ratings (one rating per (agent, host),
-- "overall vibe") with per-transfer rows: did THIS specific call
-- actually deliver what the agent asked for? Mirrors A2A's
-- satisfaction + score + comment shape (20260316_a2a_task_feedback.sql)
-- but one-sided: the caller rates the vendor; vendors are APIs and
-- can't rate back.
--
-- Intent capture lives on transfers.protocol_metadata.intent (set at
-- sign time); the rating references its transfer_id so the yardstick
-- (what was asked) and the result (what came back) are joined in SQL.

CREATE TABLE IF NOT EXISTS x402_call_quality (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id            UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  transfer_id          UUID NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
  host                 TEXT NOT NULL,  -- denormalized from transfer for aggregation perf
  agent_id             UUID REFERENCES agents(id) ON DELETE SET NULL,
  delivered_what_asked BOOLEAN NOT NULL,
  satisfaction         TEXT NOT NULL CHECK (satisfaction IN ('excellent', 'acceptable', 'partial', 'unacceptable')),
  score                INTEGER NOT NULL CHECK (score >= 0 AND score <= 100),
  flags                TEXT[],  -- e.g. {stale_data, partial_response, hallucinated, rate_limited, schema_mismatch}
  note                 TEXT,
  evidence             JSONB,   -- optional: schema-check result, LLM-judge output, etc.
  rated_by_type        TEXT NOT NULL CHECK (rated_by_type IN ('agent', 'user', 'api_key', 'auto')),
  rated_by_id          TEXT,
  rated_by_name        TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One rating per (transfer, rater) — agent and user can each rate the
-- same call, stored separately so we can surface disagreement.
--
-- Uses NULLS NOT DISTINCT (Postgres 15+) so the constraint covers
-- raters with a null rated_by_id (system / api_key fallback paths).
-- Modeled as a constraint, not a functional index, because supabase-js
-- `.upsert(..., { onConflict: 'transfer_id,rated_by_type,rated_by_id' })`
-- needs the conflict target to match a real constraint on bare column
-- names — a `COALESCE(rated_by_id, '')` expression index won't resolve.
ALTER TABLE x402_call_quality
  ADD CONSTRAINT x402_call_quality_one_per_rater
  UNIQUE NULLS NOT DISTINCT (transfer_id, rated_by_type, rated_by_id);

CREATE INDEX IF NOT EXISTS x402_call_quality_tenant_host
  ON x402_call_quality (tenant_id, host);

CREATE INDEX IF NOT EXISTS x402_call_quality_transfer
  ON x402_call_quality (transfer_id);

CREATE OR REPLACE FUNCTION x402_call_quality_touch() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS x402_call_quality_touch_trigger ON x402_call_quality;
CREATE TRIGGER x402_call_quality_touch_trigger
  BEFORE UPDATE ON x402_call_quality
  FOR EACH ROW EXECUTE FUNCTION x402_call_quality_touch();

ALTER TABLE x402_call_quality ENABLE ROW LEVEL SECURITY;

CREATE POLICY "x402_call_quality_tenant_read"
  ON x402_call_quality
  FOR SELECT
  TO authenticated
  USING (
    tenant_id IN (
      SELECT tenant_id FROM user_profiles WHERE id = auth.uid()
    )
  );

COMMENT ON TABLE x402_call_quality IS
  'Epic 81. Per-call quality ratings — one row per (transfer, rater). '
  'Distinct from x402_vendor_ratings (host-level "overall vibe"): this '
  'is "did THIS specific call deliver what the agent asked for?" keyed '
  'to a transfer_id so intent (protocol_metadata.intent) and result '
  '(protocol_metadata.response) are joinable. Fuels the correctness '
  'column on the vendor leaderboard — a vendor with 100% HTTP success '
  'but 30% correctness reads as worse than 70% HTTP / 95% correctness.';
