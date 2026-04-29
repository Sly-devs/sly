-- Epic 88, Phase 1 — Buyer-side Stripe wallet
--
-- Stores the user → Stripe Customer mapping and the user's vaulted
-- payment methods. NO card data is stored locally — Stripe holds the
-- PAN; we only keep brand/last4/exp for display.
--
-- The user_id FK points at user_profiles(id), which is the same UUID as
-- the Supabase auth.users id. The dashboard user (the actual human) is
-- the wallet owner — not the `accounts` rows in the multi-tenant ledger.

-- ── Stripe customer mapping ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wallet_stripe_customers (
  user_id              UUID PRIMARY KEY REFERENCES user_profiles(id) ON DELETE CASCADE,
  tenant_id            UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  stripe_customer_id   TEXT NOT NULL UNIQUE,
  environment          TEXT NOT NULL DEFAULT 'test' CHECK (environment IN ('test', 'live')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wallet_stripe_customers_tenant
  ON wallet_stripe_customers(tenant_id);

-- ── Payment methods (vaulted cards) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS wallet_payment_methods (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id                  UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  stripe_customer_id       TEXT NOT NULL,
  stripe_payment_method_id TEXT NOT NULL UNIQUE,
  brand                    TEXT,
  last4                    TEXT,
  exp_month                INT,
  exp_year                 INT,
  is_default               BOOLEAN NOT NULL DEFAULT false,
  environment              TEXT NOT NULL DEFAULT 'test' CHECK (environment IN ('test', 'live')),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  detached_at              TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_wallet_payment_methods_user
  ON wallet_payment_methods(user_id) WHERE detached_at IS NULL;

-- One default payment method per (user, environment) at any time
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_payment_methods_default
  ON wallet_payment_methods(user_id, environment)
  WHERE is_default = true AND detached_at IS NULL;

-- ── RLS ───────────────────────────────────────────────────────────────
ALTER TABLE wallet_stripe_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_payment_methods  ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS (the API uses service role + explicit
-- tenant filters per the codebase convention). Add a permissive policy
-- so direct dashboard reads with the user's JWT also work.
CREATE POLICY wallet_stripe_customers_self_read ON wallet_stripe_customers
  FOR SELECT
  USING (user_id = (SELECT auth.uid()));

CREATE POLICY wallet_payment_methods_self_read ON wallet_payment_methods
  FOR SELECT
  USING (user_id = (SELECT auth.uid()));
