-- A2A Forwarding Reliability & Safety Hardening
-- Adds retry columns for forwarding retry with backoff (R1)

ALTER TABLE a2a_tasks ADD COLUMN IF NOT EXISTS retry_count integer DEFAULT 0;
ALTER TABLE a2a_tasks ADD COLUMN IF NOT EXISTS max_retries integer DEFAULT 3;
ALTER TABLE a2a_tasks ADD COLUMN IF NOT EXISTS retry_after timestamptz;

-- Partial index for efficient retry-eligible task claiming
CREATE INDEX IF NOT EXISTS idx_a2a_tasks_retry_after
  ON a2a_tasks (retry_after)
  WHERE state = 'submitted';
