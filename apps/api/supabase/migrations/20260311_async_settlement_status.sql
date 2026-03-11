-- Epic 38, Story 38.1: Add 'authorized' to transfers status check constraint
-- 'authorized' = ledger settled, on-chain settlement pending (async worker)
-- This enables sub-200ms payment responses by deferring on-chain settlement

ALTER TABLE transfers DROP CONSTRAINT IF EXISTS transfers_status_check;
ALTER TABLE transfers ADD CONSTRAINT transfers_status_check
  CHECK (status IN ('pending', 'processing', 'authorized', 'completed', 'failed', 'cancelled'));
