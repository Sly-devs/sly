-- Agent Forwarding: Add endpoint fields to agents and handler_type to agent_skills
-- Enables agents to register their own A2A or webhook endpoints for task forwarding.
-- Sly routes sly_native skills internally, agent_provided skills to the agent's endpoint.

-- Agent endpoint configuration
ALTER TABLE agents ADD COLUMN IF NOT EXISTS endpoint_url VARCHAR(1024);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS endpoint_type VARCHAR(20) DEFAULT 'none'
  CHECK (endpoint_type IN ('none', 'webhook', 'a2a'));
ALTER TABLE agents ADD COLUMN IF NOT EXISTS endpoint_secret VARCHAR(255);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS endpoint_enabled BOOLEAN DEFAULT false;

-- Skill handler type: determines whether Sly processes locally or forwards to agent
ALTER TABLE agent_skills ADD COLUMN IF NOT EXISTS handler_type VARCHAR(20) DEFAULT 'sly_native'
  CHECK (handler_type IN ('sly_native', 'agent_provided'));

-- Index for efficient endpoint lookups during forwarding
CREATE INDEX IF NOT EXISTS idx_agents_endpoint ON agents(id) WHERE endpoint_enabled = true AND endpoint_type != 'none';
