-- =============================================================================
-- Scanner Partner Access: usage tracking + credit ledger
-- Mirrors the Epic 65 api_request_counts pattern (minute-bucketed aggregation,
-- PARTITION BY RANGE on time), with scanner_key_id and credits_consumed added.
-- =============================================================================

-- =============================================================================
-- 1. scanner_usage_events — per-minute aggregation of partner requests
-- =============================================================================

CREATE TABLE IF NOT EXISTS scanner_usage_events (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scanner_key_id UUID,
  minute_bucket TIMESTAMPTZ NOT NULL,
  method TEXT NOT NULL,
  path_template TEXT NOT NULL,
  status_code INT NOT NULL,
  actor_type TEXT NOT NULL,
  count INT NOT NULL DEFAULT 0,
  total_duration_ms BIGINT NOT NULL DEFAULT 0,
  credits_consumed INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
) PARTITION BY RANGE (minute_bucket);

-- Partitions (current month + next few). Partition manager script creates
-- subsequent months; we seed enough to cover the partner rollout window.
CREATE TABLE IF NOT EXISTS scanner_usage_events_2026_04 PARTITION OF scanner_usage_events
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE IF NOT EXISTS scanner_usage_events_2026_05 PARTITION OF scanner_usage_events
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE IF NOT EXISTS scanner_usage_events_2026_06 PARTITION OF scanner_usage_events
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

-- Unique constraint must include the partition key. Applied per-partition;
-- upserts target the same key so flush dedup works across the 10s window.
ALTER TABLE scanner_usage_events_2026_04
  ADD CONSTRAINT scanner_usage_events_2026_04_unique
  UNIQUE (tenant_id, scanner_key_id, minute_bucket, method, path_template, status_code, actor_type);
ALTER TABLE scanner_usage_events_2026_05
  ADD CONSTRAINT scanner_usage_events_2026_05_unique
  UNIQUE (tenant_id, scanner_key_id, minute_bucket, method, path_template, status_code, actor_type);
ALTER TABLE scanner_usage_events_2026_06
  ADD CONSTRAINT scanner_usage_events_2026_06_unique
  UNIQUE (tenant_id, scanner_key_id, minute_bucket, method, path_template, status_code, actor_type);

ALTER TABLE scanner_usage_events_2026_04 ENABLE ROW LEVEL SECURITY;
ALTER TABLE scanner_usage_events_2026_05 ENABLE ROW LEVEL SECURITY;
ALTER TABLE scanner_usage_events_2026_06 ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_scanner_usage_events_tenant_bucket
  ON scanner_usage_events (tenant_id, minute_bucket DESC);
CREATE INDEX IF NOT EXISTS idx_scanner_usage_events_key_bucket
  ON scanner_usage_events (scanner_key_id, minute_bucket DESC)
  WHERE scanner_key_id IS NOT NULL;

ALTER TABLE scanner_usage_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "scanner_usage_events_tenant_isolation" ON scanner_usage_events
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY "scanner_usage_events_service_role" ON scanner_usage_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- =============================================================================
-- 2. scanner_credit_ledger — append-only credit grants and debits
-- =============================================================================

CREATE TABLE IF NOT EXISTS scanner_credit_ledger (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  delta INT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('grant', 'consume', 'refund', 'adjustment')),
  source TEXT,
  balance_after INT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scanner_credit_ledger_tenant_created
  ON scanner_credit_ledger (tenant_id, created_at DESC);

ALTER TABLE scanner_credit_ledger ENABLE ROW LEVEL SECURITY;

CREATE POLICY "scanner_credit_ledger_tenant_isolation" ON scanner_credit_ledger
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY "scanner_credit_ledger_service_role" ON scanner_credit_ledger
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- =============================================================================
-- 3. Atomic debit helper — balance check + ledger append in one transaction
-- Returns the new balance, or -1 if the current balance is insufficient.
-- =============================================================================

CREATE OR REPLACE FUNCTION scanner_credit_debit(
  p_tenant_id UUID,
  p_cost INT,
  p_source TEXT,
  p_metadata JSONB DEFAULT '{}'::jsonb
) RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
  v_balance INT;
BEGIN
  SELECT COALESCE(SUM(delta), 0) INTO v_balance
  FROM scanner_credit_ledger
  WHERE tenant_id = p_tenant_id;

  IF v_balance < p_cost THEN
    RETURN -1;
  END IF;

  INSERT INTO scanner_credit_ledger (tenant_id, delta, reason, source, balance_after, metadata)
  VALUES (p_tenant_id, -p_cost, 'consume', p_source, v_balance - p_cost, p_metadata);

  RETURN v_balance - p_cost;
END;
$$;

CREATE OR REPLACE FUNCTION scanner_credit_grant(
  p_tenant_id UUID,
  p_amount INT,
  p_source TEXT,
  p_metadata JSONB DEFAULT '{}'::jsonb
) RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
  v_balance INT;
BEGIN
  SELECT COALESCE(SUM(delta), 0) INTO v_balance
  FROM scanner_credit_ledger
  WHERE tenant_id = p_tenant_id;

  INSERT INTO scanner_credit_ledger (tenant_id, delta, reason, source, balance_after, metadata)
  VALUES (p_tenant_id, p_amount, 'grant', p_source, v_balance + p_amount, p_metadata);

  RETURN v_balance + p_amount;
END;
$$;
