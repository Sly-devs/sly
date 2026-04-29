-- ============================================================================
-- Migration: x402_publish_events (Worktree A — Foundations)
--
-- Append-only audit log for the x402 publish lifecycle. Drives:
--   - the per-endpoint timeline UI on the dashboard detail page
--   - the cross-tenant operator audit view
--   - debug context when a publish/unpublish/republish fails
--
-- Inserts are made by the API (service role bypasses RLS); no INSERT policy
-- is exposed to authenticated clients. Reads are tenant-scoped.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.x402_publish_events (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID         NOT NULL REFERENCES public.tenants(id)         ON DELETE CASCADE,
  endpoint_id   UUID         NOT NULL REFERENCES public.x402_endpoints(id)  ON DELETE CASCADE,
  actor_type    TEXT         NOT NULL
                CHECK (actor_type IN ('user', 'agent', 'api_key', 'system')),
  actor_id      UUID,
  event         TEXT         NOT NULL
                CHECK (event IN (
                  'publish_requested',
                  'validated',
                  'extension_rejected',
                  'first_settle',
                  'indexed',
                  'republish_requested',
                  'unpublish_requested',
                  'unpublished',
                  'failed'
                )),
  details       JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Endpoint timeline view: most-recent-first per endpoint
CREATE INDEX IF NOT EXISTS idx_x402_publish_events_endpoint_created
  ON public.x402_publish_events(endpoint_id, created_at DESC);

-- Tenant-wide audit view
CREATE INDEX IF NOT EXISTS idx_x402_publish_events_tenant_created
  ON public.x402_publish_events(tenant_id, created_at DESC);

-- Operator dashboard: surface failures fast
CREATE INDEX IF NOT EXISTS idx_x402_publish_events_failures
  ON public.x402_publish_events(created_at DESC)
  WHERE event IN ('extension_rejected', 'failed');

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE public.x402_publish_events ENABLE ROW LEVEL SECURITY;

-- Read: tenant-scoped. Append-only — no UPDATE/DELETE/INSERT policy for
-- authenticated users. Service role bypasses RLS to insert.
CREATE POLICY x402_publish_events_select ON public.x402_publish_events
  FOR SELECT
  USING (tenant_id = (SELECT public.get_user_tenant_id()));

GRANT SELECT ON public.x402_publish_events TO authenticated;

-- ── Comments ─────────────────────────────────────────────────────────────────
COMMENT ON TABLE  public.x402_publish_events IS
  'Append-only audit log for x402 publish lifecycle (publish/republish/unpublish/index/fail).';
COMMENT ON COLUMN public.x402_publish_events.actor_type IS
  'user | agent | api_key | system. system = scheduled workers (poller, auto-republish).';
COMMENT ON COLUMN public.x402_publish_events.event IS
  'Lifecycle event. extension_rejected/failed carry diagnostic details in the details column.';
COMMENT ON COLUMN public.x402_publish_events.details IS
  'Free-form context: rejection reason, EXTENSION-RESPONSES header value, diff of changed fields, etc.';

DO $$
BEGIN
  RAISE NOTICE '✅ x402_publish_events table created';
  RAISE NOTICE '✅ Append-only RLS (read-only for authenticated, inserts via service role)';
END $$;
