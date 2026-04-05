-- x402 Step 3 Phase 1: Smart Account addresses for agents
--
-- Each agent with a secp256k1 EOA key (from Step 2) can optionally derive
-- a Coinbase Smart Wallet whose owner is that EOA. The smart account address
-- is CREATE2-deterministic and does not require contract deployment to be
-- known — we can store it counterfactually and deploy on first use.
--
-- The EOA continues to exist; the smart account is a complementary layer
-- for gas abstraction (via paymaster), ERC-1271 contract signatures, and
-- future ERC-7710 delegation support.

ALTER TABLE agent_signing_keys
  ADD COLUMN IF NOT EXISTS smart_account_address TEXT,
  ADD COLUMN IF NOT EXISTS smart_account_deployed BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS smart_account_chain_id INTEGER;

CREATE INDEX IF NOT EXISTS agent_signing_keys_smart_account_idx
  ON agent_signing_keys (smart_account_address)
  WHERE smart_account_address IS NOT NULL;

COMMENT ON COLUMN agent_signing_keys.smart_account_address IS
  'Coinbase Smart Wallet address (CREATE2-deterministic) owned by this EOA. '
  'Used for ERC-1271 signatures + ERC-4337 UserOperations. Null for agents '
  'that have not upgraded from plain EOA signing.';
