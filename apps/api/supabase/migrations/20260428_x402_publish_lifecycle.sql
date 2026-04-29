-- ============================================================================
-- Migration: x402 Publish Lifecycle (Worktree A — Foundations)
--
-- Adds the columns required to publish a Sly-tenant's x402 endpoint into
-- Coinbase's Bazaar catalog (agentic.market) and operate the gateway at
-- https://{tenant.slug}.x402.getsly.ai/{service_slug}.
--
-- Companion migrations (same date):
--   20260428_tenant_payout_wallets.sql   — on-chain payTo per tenant/network
--   20260428_x402_publish_audit.sql      — append-only event log
-- ============================================================================

-- ── tenants.slug ─────────────────────────────────────────────────────────────
-- Required to form the gateway URL. Existing tenants are left NULL and will
-- be backfilled at publish time (or via seed/admin tooling).

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS slug TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_slug
  ON public.tenants(slug)
  WHERE slug IS NOT NULL;

COMMENT ON COLUMN public.tenants.slug IS
  'URL-safe tenant identifier. Used as the subdomain in {slug}.x402.getsly.ai. Reserved-slug guard lives in the app layer.';

-- ── x402_endpoints lifecycle + gateway columns ───────────────────────────────

ALTER TABLE public.x402_endpoints
  ADD COLUMN IF NOT EXISTS visibility           TEXT        NOT NULL DEFAULT 'private',
  ADD COLUMN IF NOT EXISTS publish_status       TEXT        NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS publish_error        TEXT,
  ADD COLUMN IF NOT EXISTS published_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_indexed_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_settle_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS catalog_service_id   TEXT,
  ADD COLUMN IF NOT EXISTS discovery_metadata   JSONB,
  ADD COLUMN IF NOT EXISTS metadata_dirty       BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS facilitator_mode     TEXT        NOT NULL DEFAULT 'internal',
  ADD COLUMN IF NOT EXISTS category             TEXT,
  ADD COLUMN IF NOT EXISTS service_slug         TEXT,
  ADD COLUMN IF NOT EXISTS backend_url          TEXT,
  ADD COLUMN IF NOT EXISTS backend_auth         JSONB;

-- CHECK constraints (added separately to be idempotent across re-runs)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'x402_endpoints_visibility_check'
  ) THEN
    ALTER TABLE public.x402_endpoints
      ADD CONSTRAINT x402_endpoints_visibility_check
      CHECK (visibility IN ('private', 'public'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'x402_endpoints_publish_status_check'
  ) THEN
    ALTER TABLE public.x402_endpoints
      ADD CONSTRAINT x402_endpoints_publish_status_check
      CHECK (publish_status IN ('draft','validating','publishing','processing','published','failed','unpublished'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'x402_endpoints_facilitator_mode_check'
  ) THEN
    ALTER TABLE public.x402_endpoints
      ADD CONSTRAINT x402_endpoints_facilitator_mode_check
      CHECK (facilitator_mode IN ('internal', 'cdp'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'x402_endpoints_service_slug_format_check'
  ) THEN
    ALTER TABLE public.x402_endpoints
      ADD CONSTRAINT x402_endpoints_service_slug_format_check
      CHECK (service_slug IS NULL OR service_slug ~ '^[a-z0-9][a-z0-9-]{1,39}$');
  END IF;
END
$$;

-- (tenant_id, service_slug) must be unique when set — drives gateway routing
CREATE UNIQUE INDEX IF NOT EXISTS idx_x402_endpoints_tenant_service_slug
  ON public.x402_endpoints(tenant_id, service_slug)
  WHERE service_slug IS NOT NULL;

-- Operator audit / dashboard scan: visibility + publish_status by tenant
CREATE INDEX IF NOT EXISTS idx_x402_endpoints_publish_state
  ON public.x402_endpoints(tenant_id, visibility, publish_status);

-- Worker poll target: rows in 'processing' awaiting catalog confirmation
CREATE INDEX IF NOT EXISTS idx_x402_endpoints_publish_status_processing
  ON public.x402_endpoints(publish_status, last_settle_at)
  WHERE publish_status IN ('publishing', 'processing');

-- Column comments
COMMENT ON COLUMN public.x402_endpoints.visibility IS
  'Opt-in publish flag. private = tenant-only; public = routed via CDP Facilitator and indexed on agentic.market.';
COMMENT ON COLUMN public.x402_endpoints.publish_status IS
  'Lifecycle: draft -> validating -> publishing -> published -> [failed|unpublished].';
COMMENT ON COLUMN public.x402_endpoints.facilitator_mode IS
  'internal = Sly facilitator; cdp = Coinbase CDP Facilitator (required for Bazaar indexing).';
COMMENT ON COLUMN public.x402_endpoints.discovery_metadata IS
  'Frozen Bazaar extension payload (description, input/output schema, examples, category) at last successful publish.';
COMMENT ON COLUMN public.x402_endpoints.metadata_dirty IS
  'Set TRUE when discovery-relevant fields change on a published endpoint; auto-republish hook clears it.';
COMMENT ON COLUMN public.x402_endpoints.service_slug IS
  'URL-safe path component. Gateway URL = https://{tenants.slug}.x402.getsly.ai/{service_slug}.';
COMMENT ON COLUMN public.x402_endpoints.backend_url IS
  'Tenant origin URL Sly proxies to after settlement. Never exposed to buyers.';
COMMENT ON COLUMN public.x402_endpoints.backend_auth IS
  'Optional auth Sly attaches when proxying to backend_url, e.g. {"hmac_secret": "...", "header": "..."}.';

-- ── Verification ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  RAISE NOTICE '✅ tenants.slug column ensured';
  RAISE NOTICE '✅ x402_endpoints publish-lifecycle columns added';
  RAISE NOTICE '✅ Indexes for gateway routing and worker polling created';
END $$;
