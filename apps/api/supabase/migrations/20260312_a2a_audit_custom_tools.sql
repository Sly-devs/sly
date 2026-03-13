-- Epic 58: Stories 58.15 (Custom Tool Support) + 58.17 (Audit Trail)
-- Migration: A2A audit events table + agent custom tools table

-- =============================================================================
-- Story 58.17: A2A Audit Events
-- =============================================================================
-- Persistent audit log for all A2A task lifecycle events.
-- Captures state transitions, messages, artifacts, and errors.

CREATE TABLE IF NOT EXISTS a2a_audit_events (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  task_id       UUID NOT NULL,
  agent_id      UUID NOT NULL,
  event_type    TEXT NOT NULL CHECK (event_type IN ('status', 'message', 'artifact', 'error', 'payment', 'timeout', 'webhook')),
  -- State transition data
  from_state    TEXT,
  to_state      TEXT,
  -- Actor info
  actor_type    TEXT CHECK (actor_type IN ('system', 'agent', 'user', 'worker')),
  actor_id      TEXT,
  -- Event payload
  data          JSONB NOT NULL DEFAULT '{}',
  -- Timing
  duration_ms   INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for common queries
CREATE INDEX idx_a2a_audit_tenant_task ON a2a_audit_events(tenant_id, task_id);
CREATE INDEX idx_a2a_audit_tenant_agent ON a2a_audit_events(tenant_id, agent_id);
CREATE INDEX idx_a2a_audit_tenant_type ON a2a_audit_events(tenant_id, event_type);
CREATE INDEX idx_a2a_audit_created ON a2a_audit_events(created_at);

-- RLS
ALTER TABLE a2a_audit_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Tenant isolation for a2a_audit_events"
  ON a2a_audit_events
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY "a2a_audit_events_service_role"
  ON a2a_audit_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- =============================================================================
-- Story 58.15: Agent Custom Tools
-- =============================================================================
-- Tenant-defined tools that extend an agent's capabilities beyond MCP defaults.
-- Tools are JSON Schema definitions that map to webhook endpoints.

CREATE TABLE IF NOT EXISTS agent_custom_tools (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  tool_name       TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  input_schema    JSONB NOT NULL DEFAULT '{"type":"object","properties":{},"required":[]}',
  -- Execution config
  handler_type    TEXT NOT NULL DEFAULT 'webhook' CHECK (handler_type IN ('webhook', 'http', 'noop')),
  handler_url     TEXT,
  handler_secret  TEXT,
  handler_method  TEXT DEFAULT 'POST' CHECK (handler_method IN ('GET', 'POST', 'PUT', 'PATCH')),
  handler_timeout_ms INTEGER DEFAULT 30000 CHECK (handler_timeout_ms BETWEEN 1000 AND 120000),
  -- Status
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'deprecated')),
  -- Metadata
  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Unique tool name per agent
  UNIQUE(agent_id, tool_name)
);

CREATE INDEX idx_agent_custom_tools_tenant ON agent_custom_tools(tenant_id);
CREATE INDEX idx_agent_custom_tools_agent ON agent_custom_tools(agent_id, status);

-- RLS
ALTER TABLE agent_custom_tools ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Tenant isolation for agent_custom_tools"
  ON agent_custom_tools
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY "agent_custom_tools_service_role"
  ON agent_custom_tools
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- =============================================================================
-- Story 58.18: Context Window — add max_context_messages to agents table
-- =============================================================================

ALTER TABLE agents ADD COLUMN IF NOT EXISTS max_context_messages INTEGER DEFAULT 100
  CHECK (max_context_messages BETWEEN 10 AND 1000);

COMMENT ON COLUMN agents.max_context_messages IS 'Maximum number of messages to include in context window for task processing. Default: 100.';
