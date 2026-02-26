-- Migration: Agent Self-Registration Support
-- Epic 59, Story 59.13
-- Enables agents to self-register without a human tenant

-- 1. Make parent_account_id nullable on agents table
-- Standalone agents (self-registered) won't have a parent account
ALTER TABLE agents ALTER COLUMN parent_account_id DROP NOT NULL;

-- 2. Partial index for standalone agents (no parent)
CREATE INDEX idx_agents_standalone
  ON agents (tenant_id, created_at DESC)
  WHERE parent_account_id IS NULL;

-- 3. Add agent tenant tracking columns to tenants table
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS is_agent_tenant BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS claimed_by_tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL;

-- 4. Index for finding unclaimed agent tenants
CREATE INDEX idx_tenants_agent_unclaimed
  ON tenants (is_agent_tenant, claimed_by_tenant_id)
  WHERE is_agent_tenant = true;

-- 5. RLS policy for agent tenants: agents can read their own tenant
-- (existing tenant RLS already scopes by tenant_id, no change needed)

-- 6. Comment for documentation
COMMENT ON COLUMN tenants.is_agent_tenant IS 'True if this tenant was auto-created for an autonomous agent signup';
COMMENT ON COLUMN tenants.claimed_by_tenant_id IS 'If set, this agent tenant has been claimed by a human organization';
COMMENT ON INDEX idx_agents_standalone IS 'Fast lookup for standalone agents without parent accounts';
