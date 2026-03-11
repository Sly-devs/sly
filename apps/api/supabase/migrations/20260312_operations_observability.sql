-- =============================================================================
-- Epic 65: Operations Observability & Usage Tracking
-- Story 65.1: Database schema for api_request_counts, operation_events, portal_tokens
-- =============================================================================

-- =============================================================================
-- 1. api_request_counts — Layer 1: aggregated API request counters
-- =============================================================================

CREATE TABLE IF NOT EXISTS api_request_counts (
  id UUID DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  minute_bucket TIMESTAMPTZ NOT NULL,
  method TEXT NOT NULL,
  path_template TEXT NOT NULL,
  status_code INT NOT NULL,
  actor_type TEXT NOT NULL,
  count INT NOT NULL DEFAULT 1,
  total_duration_ms INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tenant_id, minute_bucket, method, path_template, status_code, actor_type)
) PARTITION BY RANGE (minute_bucket);

-- Create initial partitions (current month + next month)
CREATE TABLE IF NOT EXISTS api_request_counts_2026_03 PARTITION OF api_request_counts
  FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE IF NOT EXISTS api_request_counts_2026_04 PARTITION OF api_request_counts
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');

-- Enable RLS on partitions (not inherited from parent)
ALTER TABLE api_request_counts_2026_03 ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_request_counts_2026_04 ENABLE ROW LEVEL SECURITY;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_api_request_counts_tenant_bucket
  ON api_request_counts (tenant_id, minute_bucket DESC);
CREATE INDEX IF NOT EXISTS idx_api_request_counts_path
  ON api_request_counts (tenant_id, path_template, minute_bucket DESC);

-- RLS
ALTER TABLE api_request_counts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "api_request_counts_tenant_isolation" ON api_request_counts
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY "api_request_counts_service_role" ON api_request_counts
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- =============================================================================
-- 2. operation_events — Layer 2: CloudEvents operation log
-- =============================================================================

CREATE TABLE IF NOT EXISTS operation_events (
  id UUID DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  specversion TEXT NOT NULL DEFAULT '1.0',
  type TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'sly-api',
  subject TEXT NOT NULL,
  time TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  category TEXT NOT NULL,
  operation TEXT NOT NULL,
  amount_usd NUMERIC(20,6),
  currency TEXT,
  protocol TEXT,
  success BOOLEAN NOT NULL DEFAULT true,
  duration_ms INT,
  external_cost_usd NUMERIC(20,8),
  data JSONB DEFAULT '{}'::jsonb
) PARTITION BY RANGE (time);

-- Create initial partitions (current month + next month)
CREATE TABLE IF NOT EXISTS operation_events_2026_03 PARTITION OF operation_events
  FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE IF NOT EXISTS operation_events_2026_04 PARTITION OF operation_events
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');

-- Enable RLS on partitions (not inherited from parent)
ALTER TABLE operation_events_2026_03 ENABLE ROW LEVEL SECURITY;
ALTER TABLE operation_events_2026_04 ENABLE ROW LEVEL SECURITY;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_operation_events_tenant_time
  ON operation_events (tenant_id, time DESC);
CREATE INDEX IF NOT EXISTS idx_operation_events_category_time
  ON operation_events (category, time DESC);
CREATE INDEX IF NOT EXISTS idx_operation_events_protocol_time
  ON operation_events (protocol, time DESC) WHERE protocol IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_operation_events_operation
  ON operation_events (tenant_id, operation, time DESC);

-- RLS
ALTER TABLE operation_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "operation_events_tenant_isolation" ON operation_events
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY "operation_events_service_role" ON operation_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- =============================================================================
-- 3. portal_tokens — Portal token authentication for usage API
-- =============================================================================

CREATE TABLE IF NOT EXISTS portal_tokens (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  token_prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  scopes TEXT[] NOT NULL DEFAULT '{usage:read}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'expired')),
  expires_at TIMESTAMPTZ,
  created_by UUID,
  created_at TIMESTAMPTZ DEFAULT now(),
  last_used_at TIMESTAMPTZ
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_portal_tokens_prefix ON portal_tokens (token_prefix);
CREATE INDEX IF NOT EXISTS idx_portal_tokens_tenant ON portal_tokens (tenant_id);

-- RLS
ALTER TABLE portal_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "portal_tokens_tenant_isolation" ON portal_tokens
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY "portal_tokens_service_role" ON portal_tokens
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- =============================================================================
-- 4. Materialized view for usage summary (refreshed by partition manager)
-- =============================================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS usage_summary_hourly AS
SELECT
  tenant_id,
  date_trunc('hour', time) AS hour,
  category,
  operation,
  protocol,
  COUNT(*) AS op_count,
  SUM(CASE WHEN success THEN 1 ELSE 0 END) AS success_count,
  SUM(CASE WHEN NOT success THEN 1 ELSE 0 END) AS failure_count,
  SUM(COALESCE(amount_usd, 0)) AS total_amount_usd,
  SUM(COALESCE(external_cost_usd, 0)) AS total_cost_usd,
  AVG(duration_ms) AS avg_duration_ms
FROM operation_events
GROUP BY tenant_id, date_trunc('hour', time), category, operation, protocol;

CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_summary_hourly_unique
  ON usage_summary_hourly (tenant_id, hour, category, operation, protocol);
