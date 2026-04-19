-- Story 73.16: Agent Behavioral Observations
-- Stores daily aggregate behavioral data for KYA tier advancement

CREATE TABLE IF NOT EXISTS kya_agent_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  agent_id UUID NOT NULL,
  observation_date DATE NOT NULL,
  tx_count INTEGER DEFAULT 0,
  tx_volume NUMERIC(20,8) DEFAULT 0,
  unique_counterparties INTEGER DEFAULT 0,
  scope_violations INTEGER DEFAULT 0,
  error_count INTEGER DEFAULT 0,
  avg_tx_amount NUMERIC(20,8) DEFAULT 0,
  max_tx_amount NUMERIC(20,8) DEFAULT 0,
  protocols_used TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (tenant_id, agent_id, observation_date)
);

CREATE INDEX idx_kya_agent_observations_agent ON kya_agent_observations(agent_id, observation_date);

ALTER TABLE kya_agent_observations ENABLE ROW LEVEL SECURITY;

-- RLS: Tenant isolation using service role with explicit tenant_id filtering
CREATE POLICY "Tenant isolation" ON kya_agent_observations
  FOR ALL
  USING (tenant_id = auth.uid()::uuid);
