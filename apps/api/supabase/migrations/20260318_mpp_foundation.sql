-- ============================================
-- Epic 71, Story 71.3: MPP Foundation Data Model
-- ============================================
-- Adds 'mpp' transfer type and settlement_network column.
-- Tempo wallet network values for MPP wallet provisioning.

-- 1. Add 'mpp' to the transfers type constraint
-- First drop the existing constraint, then recreate with mpp
DO $$
BEGIN
  -- Check if the constraint exists and drop it
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'transfers_type_check'
    AND table_name = 'transfers'
  ) THEN
    ALTER TABLE transfers DROP CONSTRAINT transfers_type_check;
  END IF;
END $$;

-- Add updated constraint including 'mpp'
DO $$
BEGIN
  ALTER TABLE transfers ADD CONSTRAINT transfers_type_check
    CHECK (type IN (
      'cross_border', 'internal', 'stream_start', 'stream_withdraw', 'stream_cancel',
      'wrap', 'unwrap', 'deposit', 'withdrawal',
      'x402', 'ap2', 'acp', 'mpp',
      'payout', 'refund', 'wallet_transfer'
    ));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- 2. Add settlement_network column (nullable, for tracking which network settled the payment)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'transfers' AND column_name = 'settlement_network'
  ) THEN
    ALTER TABLE transfers ADD COLUMN settlement_network TEXT;
  END IF;
END $$;

-- 3. Indexes for MPP transfer queries
CREATE INDEX IF NOT EXISTS idx_transfers_type_mpp
  ON transfers (type) WHERE type = 'mpp';

CREATE INDEX IF NOT EXISTS idx_transfers_settlement_network
  ON transfers (settlement_network) WHERE settlement_network IS NOT NULL;

-- 4. Add tempo network values to wallets network constraint (if constraint exists)
-- This allows wallets to specify tempo-mainnet or tempo-testnet as their network
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'wallets_network_check'
    AND table_name = 'wallets'
  ) THEN
    ALTER TABLE wallets DROP CONSTRAINT wallets_network_check;
  END IF;
EXCEPTION
  WHEN undefined_object THEN NULL;
END $$;

-- Note: If there is no wallets_network_check constraint, we skip.
-- Tempo networks will be stored as free-text values in the network column.
