-- ============================================
-- Epic 71, Story 71.7: MPP Sessions Table
-- ============================================
-- Tracks streaming payment sessions for MPP.

CREATE TABLE IF NOT EXISTS mpp_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  agent_id UUID NOT NULL,
  wallet_id UUID NOT NULL,
  service_url TEXT NOT NULL,
  deposit_amount NUMERIC(20, 6) NOT NULL DEFAULT 0,
  spent_amount NUMERIC(20, 6) NOT NULL DEFAULT 0,
  voucher_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'active', 'closing', 'closed', 'exhausted', 'error')),
  max_budget NUMERIC(20, 6),
  mpp_session_id TEXT,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  last_voucher_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS
ALTER TABLE mpp_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY mpp_sessions_tenant_isolation ON mpp_sessions
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Service role bypass
CREATE POLICY mpp_sessions_service_role ON mpp_sessions
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_mpp_sessions_tenant_id ON mpp_sessions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_mpp_sessions_agent_id ON mpp_sessions(agent_id);
CREATE INDEX IF NOT EXISTS idx_mpp_sessions_status ON mpp_sessions(status) WHERE status IN ('open', 'active');
CREATE INDEX IF NOT EXISTS idx_mpp_sessions_service_url ON mpp_sessions(service_url);
