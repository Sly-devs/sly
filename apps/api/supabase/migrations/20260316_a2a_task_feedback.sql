-- Epic 69: A2A Result Acceptance & Quality Feedback
-- Story 69.4: Feedback table for quality signals

-- =============================================================================
-- a2a_task_feedback — stores caller feedback on task results
-- =============================================================================

CREATE TABLE IF NOT EXISTS a2a_task_feedback (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  task_id       UUID NOT NULL,
  caller_agent_id  UUID,
  provider_agent_id UUID NOT NULL,
  skill_id      TEXT,
  action        TEXT NOT NULL CHECK (action IN ('accept', 'reject')),
  satisfaction  TEXT CHECK (satisfaction IN ('excellent', 'acceptable', 'partial', 'unacceptable')),
  score         INTEGER CHECK (score IS NULL OR (score >= 0 AND score <= 100)),
  comment       TEXT,
  mandate_id    TEXT,
  original_amount NUMERIC,
  settlement_amount NUMERIC,
  currency      TEXT DEFAULT 'USDC',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_a2a_feedback_tenant_provider ON a2a_task_feedback(tenant_id, provider_agent_id);
CREATE INDEX idx_a2a_feedback_task ON a2a_task_feedback(task_id);
CREATE INDEX idx_a2a_feedback_tenant_provider_skill ON a2a_task_feedback(tenant_id, provider_agent_id, skill_id);
CREATE INDEX idx_a2a_feedback_created ON a2a_task_feedback(created_at);

-- RLS
ALTER TABLE a2a_task_feedback ENABLE ROW LEVEL SECURITY;

CREATE POLICY a2a_task_feedback_tenant_isolation ON a2a_task_feedback
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY a2a_task_feedback_service_role ON a2a_task_feedback
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- =============================================================================
-- Extend a2a_audit_events event_type CHECK to include 'acceptance' and 'feedback'
-- =============================================================================

ALTER TABLE a2a_audit_events DROP CONSTRAINT IF EXISTS a2a_audit_events_event_type_check;
ALTER TABLE a2a_audit_events ADD CONSTRAINT a2a_audit_events_event_type_check
  CHECK (event_type IN ('status', 'message', 'artifact', 'error', 'payment', 'timeout', 'webhook', 'acceptance', 'feedback'));
