-- Agent Skills Table
-- Stores skills that agents register with pricing, enabling a DB-driven agent skill economy.
-- Skills are discoverable via A2A agent cards and the task processor routes to them.

CREATE TABLE IF NOT EXISTS agent_skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,

  -- Skill identity (matches A2A protocol)
  skill_id VARCHAR(255) NOT NULL,          -- 'make_payment', 'create_checkout', 'research'
  name VARCHAR(255) NOT NULL,              -- 'Make Payment'
  description TEXT,                        -- What this skill does

  -- A2A protocol fields
  input_modes TEXT[] DEFAULT ARRAY['text'],
  output_modes TEXT[] DEFAULT ARRAY['text', 'data'],
  tags TEXT[] DEFAULT '{}'::TEXT[],
  input_schema JSONB,                      -- JSON Schema for inputs

  -- Pricing
  base_price DECIMAL(15, 8) NOT NULL DEFAULT 0,
  currency VARCHAR(10) DEFAULT 'USDC',

  -- Status & visibility
  status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'disabled')),

  -- Usage tracking
  total_invocations INT DEFAULT 0,
  total_fees_collected DECIMAL(20, 8) DEFAULT 0,

  -- Metadata
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(tenant_id, agent_id, skill_id)
);

CREATE INDEX idx_agent_skills_agent ON agent_skills(tenant_id, agent_id, status);

ALTER TABLE agent_skills ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_agent_skills" ON agent_skills
  FOR ALL USING (true) WITH CHECK (true);
