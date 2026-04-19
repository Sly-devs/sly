-- Scenario run results — persists every marketplace-sim run so the platform
-- has a permanent record of each scenario's validation.
CREATE TABLE scenario_runs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  scenario_id TEXT NOT NULL,
  scenario_name TEXT,
  mode TEXT NOT NULL DEFAULT 'openrouter',
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  duration_seconds INTEGER,
  result JSONB,           -- {completedTrades, totalVolume, findings[]}
  report JSONB,           -- full report from /admin/round/report
  assessment JSONB,       -- assessment array extracted from report
  verdict TEXT,
  by_style JSONB,         -- per-style win rate breakdown
  rogue JSONB,            -- rogue containment metrics (if adversarial)
  error TEXT,             -- null if succeeded
  llm_cost_usd NUMERIC(10,6),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_scenario_runs_scenario ON scenario_runs(scenario_id);
CREATE INDEX idx_scenario_runs_created ON scenario_runs(created_at DESC);

ALTER TABLE scenario_runs ENABLE ROW LEVEL SECURITY;

-- Service-role only access (sim sidecar writes via service key, admin reads)
CREATE POLICY "service_role_all" ON scenario_runs
  FOR ALL USING (true) WITH CHECK (true);
