-- Environment Scoping: Stripe-style test/live data isolation
-- Both Railway environments share one DB; this column isolates data per API key environment.
-- DEFAULT 'test' backfills all existing rows.

-- Add environment column to core tables
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'test'
  CHECK (environment IN ('test', 'live'));
ALTER TABLE agents ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'test'
  CHECK (environment IN ('test', 'live'));
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'test'
  CHECK (environment IN ('test', 'live'));
ALTER TABLE streams ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'test'
  CHECK (environment IN ('test', 'live'));

-- Composite indexes for query performance (tenant_id + environment is the hot path)
CREATE INDEX IF NOT EXISTS idx_accounts_tenant_env ON accounts(tenant_id, environment);
CREATE INDEX IF NOT EXISTS idx_agents_tenant_env ON agents(tenant_id, environment);
CREATE INDEX IF NOT EXISTS idx_transfers_tenant_env ON transfers(tenant_id, environment);
CREATE INDEX IF NOT EXISTS idx_streams_tenant_env ON streams(tenant_id, environment);
