-- Census Scans: Agent profiles collected from external AI agent marketplaces
-- Part of Project Looking Glass (SLY-534)

CREATE TABLE IF NOT EXISTS census_scans (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Source identification
  platform           TEXT NOT NULL,
  platform_id        TEXT NOT NULL,
  dedup_hash         TEXT NOT NULL UNIQUE,

  -- Agent identity
  name               TEXT,
  description        TEXT,
  wallet_address     TEXT,
  avatar_url         TEXT,
  twitter_handle     TEXT,

  -- Platform-specific metrics
  reputation         NUMERIC,
  earnings           NUMERIC,
  trust_score        NUMERIC,
  karma              INTEGER,
  rank               INTEGER,
  rating             NUMERIC,
  rating_count       INTEGER,
  followers          INTEGER,

  -- Skills/capabilities (ClawMarket)
  skills_published   INTEGER,
  skills_installed   INTEGER,

  -- MoltRoad specific
  verified           BOOLEAN DEFAULT false,
  token_balance      NUMERIC,
  bond_balance       NUMERIC,
  listing_count      INTEGER,
  service_tags       TEXT[],
  achievements       JSONB,

  -- Moltbook specific
  claimed            BOOLEAN,

  -- Classification
  kya_tier           INTEGER NOT NULL DEFAULT 0,
  kya_signals        JSONB,
  data_completeness  NUMERIC NOT NULL DEFAULT 0,

  -- Raw data
  raw_profile        JSONB,

  -- Metadata
  scanned_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  scan_version       TEXT NOT NULL DEFAULT '1.0',

  CONSTRAINT census_scans_platform_check CHECK (platform IN ('clawmarket', 'moltroad', 'moltbook'))
);

-- Indexes
CREATE INDEX idx_census_scans_platform ON census_scans(platform);
CREATE INDEX idx_census_scans_kya_tier ON census_scans(kya_tier);
CREATE INDEX idx_census_scans_scanned_at ON census_scans(scanned_at);
CREATE INDEX idx_census_scans_wallet ON census_scans(wallet_address) WHERE wallet_address IS NOT NULL;
CREATE INDEX idx_census_scans_platform_id ON census_scans(platform, platform_id);

-- RLS: service role key bypasses RLS; no tenant_id since this is global census data
ALTER TABLE census_scans ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all" ON census_scans FOR ALL USING (true) WITH CHECK (true);
