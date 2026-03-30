-- ============================================
-- Enable RLS on beta access tables
-- ============================================
-- These tables are admin-managed via service_role key (which bypasses RLS).
-- Enabling RLS with no permissive policies blocks anon/authenticated access
-- through PostgREST, which is the correct posture for admin-only tables.

ALTER TABLE beta_access_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE beta_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE beta_funnel_events ENABLE ROW LEVEL SECURITY;
