-- Migration: Agent Wallet Identity (BYOW)
-- Epic 61.1-61.2: Agents can register with their own wallet address
-- Enables "Bring Your Own Wallet" for A2A agents

-- 1. Add wallet identity columns to agents table
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS wallet_address TEXT,
  ADD COLUMN IF NOT EXISTS wallet_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS wallet_verification_status TEXT DEFAULT 'unverified'
    CHECK (wallet_verification_status IN ('unverified', 'pending', 'verified'));

-- 2. Unique index on wallet_address (only for non-null values)
CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_wallet_address
  ON agents (wallet_address)
  WHERE wallet_address IS NOT NULL;

-- 3. Index for finding agents by verification status
CREATE INDEX IF NOT EXISTS idx_agents_wallet_verified
  ON agents (tenant_id, wallet_verification_status)
  WHERE wallet_address IS NOT NULL;

-- 4. Add tx_hash to transfers table for on-chain settlement tracking
ALTER TABLE transfers
  ADD COLUMN IF NOT EXISTS tx_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_transfers_tx_hash
  ON transfers (tx_hash)
  WHERE tx_hash IS NOT NULL;

-- 5. Comments
COMMENT ON COLUMN agents.wallet_address IS 'On-chain wallet address (BYOW or Circle-provisioned)';
COMMENT ON COLUMN agents.wallet_verified_at IS 'When wallet ownership was verified via EIP-191 signature';
COMMENT ON COLUMN agents.wallet_verification_status IS 'Wallet verification state: unverified | pending | verified';
COMMENT ON COLUMN transfers.tx_hash IS 'On-chain transaction hash for real wallet settlements';
