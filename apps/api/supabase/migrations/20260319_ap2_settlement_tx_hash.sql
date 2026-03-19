-- ============================================
-- Add settlement_tx_hash to ap2_mandate_executions
-- ============================================
-- Stores on-chain transaction hash when mandate executions
-- settle via Tempo (or other on-chain rails).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ap2_mandate_executions' AND column_name = 'settlement_tx_hash'
  ) THEN
    ALTER TABLE ap2_mandate_executions ADD COLUMN settlement_tx_hash TEXT;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ap2_mandate_executions' AND column_name = 'settlement_network'
  ) THEN
    ALTER TABLE ap2_mandate_executions ADD COLUMN settlement_network TEXT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ap2_executions_settlement_tx
  ON ap2_mandate_executions (settlement_tx_hash)
  WHERE settlement_tx_hash IS NOT NULL;
