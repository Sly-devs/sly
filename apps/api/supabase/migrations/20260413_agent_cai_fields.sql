-- Epic 73, Story 73.3: Agent Table Schema Updates — CAI Fields
-- Adds model provenance, skill manifest, behavioral tracking, and kill-switch fields.

-- Model identity (CAI Layer 4)
ALTER TABLE agents ADD COLUMN IF NOT EXISTS model_family TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS model_version TEXT;

-- Delegation Scope Document (CAI Layer 1 — DSD)
ALTER TABLE agents ADD COLUMN IF NOT EXISTS skill_manifest JSONB;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS use_case_description TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS escalation_policy TEXT DEFAULT 'DECLINE'
  CHECK (escalation_policy IN ('DECLINE', 'SUSPEND_AND_NOTIFY', 'REQUEST_APPROVAL'));

-- Behavioral observation (CAI Layer 3 — APT)
ALTER TABLE agents ADD COLUMN IF NOT EXISTS operational_history_start TIMESTAMPTZ;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS policy_violation_count INTEGER DEFAULT 0;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS behavioral_consistency_score NUMERIC(5,2);

-- Enterprise override for expedited KYA T2
ALTER TABLE agents ADD COLUMN IF NOT EXISTS kya_enterprise_override BOOLEAN DEFAULT false;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS kya_override_assessed_at TIMESTAMPTZ;

-- Kill switch (KYA T3 requirement)
ALTER TABLE agents ADD COLUMN IF NOT EXISTS kill_switch_operator_id UUID;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS kill_switch_operator_name TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS kill_switch_operator_email TEXT;

COMMENT ON COLUMN agents.skill_manifest IS
  'Story 73.3: JSONB skill manifest — protocols, action_types, domain, description. Required for KYA T1+.';
COMMENT ON COLUMN agents.escalation_policy IS
  'Story 73.3: What happens when agent encounters an out-of-scope situation. DECLINE (default), SUSPEND_AND_NOTIFY, or REQUEST_APPROVAL.';
COMMENT ON COLUMN agents.operational_history_start IS
  'Story 73.3: Set automatically on first transaction. Used for KYA T2 30-day history check.';
COMMENT ON COLUMN agents.behavioral_consistency_score IS
  'Story 73.3: 0.00-1.00 score computed from behavioral observation engine. Required >= threshold for KYA T2.';
COMMENT ON COLUMN agents.kill_switch_operator_id IS
  'Story 73.3: Designated human who can suspend this agent within 60 seconds. Required for KYA T3.';
