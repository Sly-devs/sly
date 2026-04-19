-- Epic 63: Add on-chain ERC-8004 agent identity token ID
-- TEXT because uint256 exceeds JS number range
ALTER TABLE agents ADD COLUMN IF NOT EXISTS erc8004_agent_id TEXT;

CREATE INDEX IF NOT EXISTS idx_agents_erc8004
  ON agents(erc8004_agent_id)
  WHERE erc8004_agent_id IS NOT NULL;
