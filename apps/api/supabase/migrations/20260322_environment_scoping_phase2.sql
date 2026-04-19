-- Phase 2: Add environment column to protocol-specific tables
-- Phase 1 (20260322_environment_scoping.sql) covered: accounts, agents, transfers, streams
-- This migration covers: ap2_mandates, ap2_mandate_executions, acp_checkouts,
--   ucp_checkout_sessions, x402_endpoints, mpp_sessions

-- AP2 Mandates
ALTER TABLE ap2_mandates
  ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'test'
  CHECK (environment IN ('test', 'live'));

CREATE INDEX IF NOT EXISTS idx_ap2_mandates_tenant_env
  ON ap2_mandates (tenant_id, environment);

-- AP2 Mandate Executions
ALTER TABLE ap2_mandate_executions
  ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'test'
  CHECK (environment IN ('test', 'live'));

CREATE INDEX IF NOT EXISTS idx_ap2_mandate_executions_tenant_env
  ON ap2_mandate_executions (tenant_id, environment);

-- ACP Checkouts
ALTER TABLE acp_checkouts
  ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'test'
  CHECK (environment IN ('test', 'live'));

CREATE INDEX IF NOT EXISTS idx_acp_checkouts_tenant_env
  ON acp_checkouts (tenant_id, environment);

-- UCP Checkout Sessions
ALTER TABLE ucp_checkout_sessions
  ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'test'
  CHECK (environment IN ('test', 'live'));

CREATE INDEX IF NOT EXISTS idx_ucp_checkout_sessions_tenant_env
  ON ucp_checkout_sessions (tenant_id, environment);

-- x402 Endpoints
ALTER TABLE x402_endpoints
  ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'test'
  CHECK (environment IN ('test', 'live'));

CREATE INDEX IF NOT EXISTS idx_x402_endpoints_tenant_env
  ON x402_endpoints (tenant_id, environment);

-- MPP Sessions
ALTER TABLE mpp_sessions
  ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'test'
  CHECK (environment IN ('test', 'live'));

CREATE INDEX IF NOT EXISTS idx_mpp_sessions_tenant_env
  ON mpp_sessions (tenant_id, environment);
