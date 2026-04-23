-- Agent EOA wallets — unify the x402 signing EOA with the rest of the wallets UI
--
-- Problem: agent_signing_keys (algorithm='secp256k1') holds the on-chain
-- signing address for external x402 payments, but it's invisible to the
-- main /dashboard/wallets surface. That means no list card, no detail
-- page, no consistent deposit/withdraw/freeze controls across wallet
-- types — you have to drill into an agent to see or manage its spending
-- surface. This migration makes every agent EOA a first-class wallet row.
--
-- Scope:
--   1. Extend wallet_type enum to include 'agent_eoa'.
--   2. Backfill one wallet row per existing secp256k1 signing key.
--
-- The provisioning route (POST /v1/agents/:id/evm-keys) is updated in
-- apps/api/src/routes/agents.ts to create a wallet row alongside the key
-- going forward, so the two stay in lock-step without a trigger.

-- 1. Expand the wallet_type enum
ALTER TABLE wallets DROP CONSTRAINT IF EXISTS wallets_wallet_type_check;
ALTER TABLE wallets ADD CONSTRAINT wallets_wallet_type_check
  CHECK (wallet_type IN (
    'internal',
    'circle_custodial',
    'circle_mpc',
    'external',
    'smart_wallet',
    'tempo',
    'agent_eoa'          -- Sly-managed secp256k1 EOA used for EIP-3009 x402 signing
  ));

-- 2. Backfill wallets rows for existing signing keys
-- Skip keys that already have a wallet row (e.g. if the migration is rerun).
INSERT INTO wallets (
  tenant_id,
  owner_account_id,
  managed_by_agent_id,
  wallet_type,
  wallet_address,
  currency,
  blockchain,
  environment,
  name,
  purpose,
  status,
  balance,
  verification_status
)
SELECT
  sk.tenant_id,
  a.parent_account_id,
  a.id,
  'agent_eoa',
  sk.ethereum_address,
  'USDC',
  CASE WHEN a.environment = 'live' THEN 'base' ELSE 'base-sepolia' END,
  a.environment,
  COALESCE(a.name, 'Agent') || ' · x402 EOA',
  'External x402 signing (EIP-3009)',
  'active',
  0,
  'verified'  -- we provisioned the key ourselves, ownership is definitional
FROM agent_signing_keys sk
JOIN agents a ON a.id = sk.agent_id
WHERE sk.algorithm = 'secp256k1'
  AND sk.status = 'active'
  AND sk.ethereum_address IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM wallets w
    WHERE w.tenant_id = sk.tenant_id
      AND w.managed_by_agent_id = sk.agent_id
      AND w.wallet_type = 'agent_eoa'
      AND w.wallet_address = sk.ethereum_address
  );

-- Log
DO $$
DECLARE
  backfilled INTEGER;
BEGIN
  SELECT COUNT(*) INTO backfilled FROM wallets WHERE wallet_type = 'agent_eoa';
  RAISE NOTICE 'agent_eoa wallets present: %', backfilled;
END $$;
