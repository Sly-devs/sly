-- ============================================================================
-- Migration: tenant_payout_wallets (Worktree A — Foundations)
--
-- On-chain wallets bound per (tenant, account, network) that receive funds
-- from x402 endpoints published on agentic.market.
--
-- Why this is required:
--   x402_endpoints.payment_address today is "internal://payos/{tenant}/{account}"
--   which is a no-op outside Sly. To publish, the endpoint's 402 challenge
--   needs an on-chain payTo so external buyers can pay the tenant directly.
--   This table is the source of truth for those payTo addresses.
--
-- Provisioning:
--   - 'user'   = tenant supplied an existing on-chain address.
--   - 'auto'   = Sly created a smart wallet via CDP/Privy on first publish.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.tenant_payout_wallets (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID         NOT NULL REFERENCES public.tenants(id)  ON DELETE CASCADE,
  account_id      UUID         NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  network         TEXT         NOT NULL,
  address         TEXT         NOT NULL,
  provisioned_by  TEXT         NOT NULL DEFAULT 'user'
                  CHECK (provisioned_by IN ('user', 'auto')),
  provider        TEXT         NOT NULL DEFAULT 'external'
                  CHECK (provider IN ('cdp', 'privy', 'external')),
  metadata        JSONB        DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Network is stored as CAIP-2 (e.g. 'eip155:8453' for Base mainnet) OR as
-- the legacy Sly slug (e.g. 'base-mainnet'); the app-layer helper normalizes.
-- Format guard: non-empty, no whitespace.
ALTER TABLE public.tenant_payout_wallets
  ADD CONSTRAINT tenant_payout_wallets_network_check
  CHECK (network ~ '^[A-Za-z0-9:_\-]+$');

-- Address: 0x-prefixed 40-hex for EVM networks; relax to non-empty for
-- non-EVM networks. Stricter checksum validation happens in app code.
ALTER TABLE public.tenant_payout_wallets
  ADD CONSTRAINT tenant_payout_wallets_address_check
  CHECK (length(address) BETWEEN 16 AND 128);

-- One wallet per (tenant, account, network)
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_payout_wallets_unique
  ON public.tenant_payout_wallets(tenant_id, account_id, network);

CREATE INDEX IF NOT EXISTS idx_tenant_payout_wallets_tenant
  ON public.tenant_payout_wallets(tenant_id);

CREATE INDEX IF NOT EXISTS idx_tenant_payout_wallets_account
  ON public.tenant_payout_wallets(account_id);

-- updated_at trigger (function already exists in this database)
DROP TRIGGER IF EXISTS update_tenant_payout_wallets_updated_at ON public.tenant_payout_wallets;
CREATE TRIGGER update_tenant_payout_wallets_updated_at
  BEFORE UPDATE ON public.tenant_payout_wallets
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE public.tenant_payout_wallets ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_payout_wallets_select ON public.tenant_payout_wallets
  FOR SELECT
  USING (tenant_id = (SELECT public.get_user_tenant_id()));

CREATE POLICY tenant_payout_wallets_insert ON public.tenant_payout_wallets
  FOR INSERT
  WITH CHECK (tenant_id = (SELECT public.get_user_tenant_id()));

CREATE POLICY tenant_payout_wallets_update ON public.tenant_payout_wallets
  FOR UPDATE
  USING (tenant_id = (SELECT public.get_user_tenant_id()));

CREATE POLICY tenant_payout_wallets_delete ON public.tenant_payout_wallets
  FOR DELETE
  USING (tenant_id = (SELECT public.get_user_tenant_id()));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_payout_wallets TO authenticated;

-- ── Comments ─────────────────────────────────────────────────────────────────
COMMENT ON TABLE  public.tenant_payout_wallets IS
  'On-chain payTo wallets per (tenant, account, network) for x402 endpoints published on agentic.market.';
COMMENT ON COLUMN public.tenant_payout_wallets.network IS
  'CAIP-2 (e.g. eip155:8453) or Sly slug (e.g. base-mainnet). App-layer helper normalizes between forms.';
COMMENT ON COLUMN public.tenant_payout_wallets.provisioned_by IS
  'user = supplied by tenant; auto = Sly-provisioned smart wallet at publish time.';
COMMENT ON COLUMN public.tenant_payout_wallets.provider IS
  'cdp = Coinbase CDP smart wallet; privy = Privy-managed; external = self-custody address.';

DO $$
BEGIN
  RAISE NOTICE '✅ tenant_payout_wallets table created';
  RAISE NOTICE '✅ RLS policies enabled (tenant-scoped via get_user_tenant_id)';
END $$;
