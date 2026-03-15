-- Change default processing_mode from 'manual' to 'managed'
-- Most agents are expected to process tasks autonomously. Safety is enforced
-- by KYA tiers and spending limits regardless of processing mode.
ALTER TABLE agents ALTER COLUMN processing_mode SET DEFAULT 'managed';
