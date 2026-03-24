-- Agent Skill x402 Endpoints
-- Links agent skills to x402 endpoints for automatic pay-per-call pricing.
-- When a skill has base_price > 0, an x402 endpoint is auto-created.
-- Other agents pay via the standard x402 flow to invoke the skill.

ALTER TABLE agent_skills
  ADD COLUMN IF NOT EXISTS x402_endpoint_id UUID REFERENCES x402_endpoints(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_agent_skills_x402_endpoint
  ON agent_skills (x402_endpoint_id) WHERE x402_endpoint_id IS NOT NULL;
