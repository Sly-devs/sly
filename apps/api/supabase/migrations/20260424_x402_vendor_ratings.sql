-- Epic 81 (extension) — per-agent qualitative vendor ratings.
--
-- Complements the numeric success-rate aggregation in
-- x402_vendor_reliability with a per-agent thumb + optional note,
-- letting tenants capture signal beyond raw HTTP outcomes:
--   * "data was wrong even though the call succeeded" → 👎 completed
--   * "broken during business hours, works overnight" → note, no thumb
--   * "great docs, reliable" → 👍
--
-- One row per (agent, host); upserts let agents update their rating
-- over time as they collect more evidence.

CREATE TABLE IF NOT EXISTS x402_vendor_ratings (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id     UUID REFERENCES agents(id) ON DELETE CASCADE,  -- NULL for user ratings
  host         TEXT NOT NULL,                                 -- normalized lowercase
  thumb        TEXT NOT NULL CHECK (thumb IN ('up', 'down')),
  note         TEXT,                                          -- optional free text
  rated_by_type TEXT NOT NULL CHECK (rated_by_type IN ('agent', 'user', 'api_key')),
  rated_by_id  TEXT,                                          -- user.id / agent.id / api_key.id
  rated_by_name TEXT,                                         -- display name snapshot
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, COALESCE(agent_id, '00000000-0000-0000-0000-000000000000'::uuid), host)
);

CREATE INDEX IF NOT EXISTS idx_x402_ratings_tenant_host
  ON x402_vendor_ratings (tenant_id, host);
CREATE INDEX IF NOT EXISTS idx_x402_ratings_tenant_agent
  ON x402_vendor_ratings (tenant_id, agent_id)
  WHERE agent_id IS NOT NULL;

-- Keep updated_at fresh.
CREATE OR REPLACE FUNCTION x402_ratings_touch() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS x402_ratings_touch_trigger ON x402_vendor_ratings;
CREATE TRIGGER x402_ratings_touch_trigger
  BEFORE UPDATE ON x402_vendor_ratings
  FOR EACH ROW EXECUTE FUNCTION x402_ratings_touch();

ALTER TABLE x402_vendor_ratings ENABLE ROW LEVEL SECURITY;

-- Service role (Hono API) bypasses RLS via the service-role key;
-- authenticated users get tenant-scoped reads.
CREATE POLICY "x402_ratings_tenant_read"
  ON x402_vendor_ratings
  FOR SELECT
  TO authenticated
  USING (
    tenant_id IN (
      SELECT tenant_id FROM user_profiles WHERE id = auth.uid()
    )
  );

COMMENT ON TABLE x402_vendor_ratings IS
  'Epic 81. Per-agent / per-user qualitative ratings of x402 vendors. '
  'Separate from the numeric reliability aggregation (x402_vendor_reliability) '
  'so tenants can capture "data was wrong" and "docs great" signals even when '
  'HTTP status was 200.';
