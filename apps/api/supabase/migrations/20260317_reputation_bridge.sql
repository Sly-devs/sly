-- ============================================
-- Epic 63: External Reputation Bridge
-- ============================================
-- Unified reputation aggregation: combines ERC-8004,
-- external trust APIs, escrow history, and A2A feedback
-- into a single 0-1000 trust score with A-F tiers.

-- Cached reputation profiles
CREATE TABLE IF NOT EXISTS reputation_scores (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id            UUID REFERENCES agents(id),
  external_identifier TEXT,               -- wallet address for external agents
  unified_score       INTEGER CHECK (unified_score >= 0 AND unified_score <= 1000),
  unified_tier        TEXT CHECK (unified_tier IN ('A','B','C','D','E','F')),
  confidence          TEXT CHECK (confidence IN ('high','medium','low','none')),
  dimensions          JSONB NOT NULL DEFAULT '{}',
  source_data         JSONB NOT NULL DEFAULT '{}',
  data_points         INTEGER NOT NULL DEFAULT 0,
  last_refreshed      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_reputation_agent
  ON reputation_scores(agent_id) WHERE agent_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_reputation_external
  ON reputation_scores(external_identifier) WHERE external_identifier IS NOT NULL;

-- Per-tenant source config with weight overrides
CREATE TABLE IF NOT EXISTS reputation_source_configs (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants(id),
  source_type             TEXT NOT NULL,
  enabled                 BOOLEAN NOT NULL DEFAULT true,
  weight_override         NUMERIC,
  api_endpoint            TEXT,
  refresh_interval_secs   INTEGER DEFAULT 300,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, source_type)
);

-- Audit log for reputation queries
CREATE TABLE IF NOT EXISTS reputation_queries (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier          TEXT NOT NULL,
  source_type         TEXT NOT NULL,
  cache_hit           BOOLEAN NOT NULL DEFAULT false,
  latency_ms          INTEGER,
  error               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reputation_queries_created
  ON reputation_queries(created_at);

-- ============================================
-- RLS Policies
-- ============================================

ALTER TABLE reputation_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE reputation_source_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE reputation_queries ENABLE ROW LEVEL SECURITY;

-- reputation_scores: readable by all authenticated users (shared data)
CREATE POLICY reputation_scores_read ON reputation_scores
  FOR SELECT USING (true);
CREATE POLICY reputation_scores_service ON reputation_scores
  FOR ALL USING (current_setting('role') = 'service_role');

-- source_configs: tenant-scoped
CREATE POLICY rep_configs_tenant ON reputation_source_configs
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY rep_configs_service ON reputation_source_configs
  FOR ALL USING (current_setting('role') = 'service_role');

-- queries: service_role only (internal audit)
CREATE POLICY rep_queries_service ON reputation_queries
  FOR ALL USING (current_setting('role') = 'service_role');
