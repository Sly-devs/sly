-- ============================================
-- Migration: Fix Tempo Wallet Currency & Fields
-- Purpose: Delete incorrectly provisioned Tempo wallet (USDC on base-mainnet)
--          and update tempo-method transfers to use pathUSD currency
-- ============================================

-- 1. Expand wallets currency constraint to include pathUSD (Tempo testnet token)
ALTER TABLE wallets DROP CONSTRAINT IF EXISTS wallets_currency_check;
ALTER TABLE wallets ADD CONSTRAINT wallets_currency_check
  CHECK (currency IN ('USDC', 'EURC', 'pathUSD'));

-- 2. Delete the incorrect wallet (USDC on base-mainnet instead of pathUSD on tempo-testnet)
DELETE FROM wallets WHERE id = 'fde6b2ae-836a-4656-b530-1822ee22b4ca';

-- 3. Update tempo-method MPP transfers to use pathUSD currency
UPDATE transfers
SET currency = 'pathUSD'
WHERE type = 'mpp'
  AND protocol_metadata->>'payment_method' = 'tempo'
  AND protocol_metadata->>'protocol_intent' IS NOT NULL
  AND currency != 'pathUSD';

DO $$
BEGIN
  RAISE NOTICE '✅ Deleted incorrect Tempo wallet (was USDC on base-mainnet)';
  RAISE NOTICE '✅ Updated tempo-method transfers to pathUSD currency';
END $$;
