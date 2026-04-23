-- =============================================================================
-- Scanner Partner Access: API keys
-- Separate from api_keys so scanner-key leakage can't touch the payments API.
-- Keys are formatted psk_live_<rand> or psk_test_<rand>.
-- =============================================================================

CREATE TABLE IF NOT EXISTS scanner_api_keys (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('test', 'live')),
  scopes TEXT[] NOT NULL DEFAULT ARRAY['scan', 'batch', 'read']::TEXT[],
  rate_limit_per_min INT NOT NULL DEFAULT 60,
  last_used_at TIMESTAMPTZ,
  last_used_ip TEXT,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_scanner_api_keys_prefix_active
  ON scanner_api_keys (key_prefix)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_scanner_api_keys_tenant
  ON scanner_api_keys (tenant_id);

ALTER TABLE scanner_api_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY "scanner_api_keys_tenant_isolation" ON scanner_api_keys
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY "scanner_api_keys_service_role" ON scanner_api_keys
  FOR ALL TO service_role USING (true) WITH CHECK (true);
