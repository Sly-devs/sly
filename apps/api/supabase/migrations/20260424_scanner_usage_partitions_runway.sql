-- Pre-create scanner_usage_events partitions through 2027-12 so writes don't
-- start failing the day after 2026-06-30. Partitioned table inserts require
-- a partition covering the target minute_bucket — without one, the INSERT
-- raises "no partition of relation X found for row".
--
-- Also defines a helper function that the Vercel Cron endpoint calls monthly
-- to ensure the next 3 months exist, so we never have to remember this.

-- =============================================================================
-- Pre-create partitions: 2026-07 through 2027-12
-- =============================================================================

DO $$
DECLARE
  month_start DATE;
  month_end   DATE;
  part_name   TEXT;
BEGIN
  FOR month_start IN
    SELECT generate_series('2026-07-01'::date, '2027-12-01'::date, '1 month'::interval)::date
  LOOP
    month_end := month_start + INTERVAL '1 month';
    part_name := 'scanner_usage_events_' || TO_CHAR(month_start, 'YYYY_MM');

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF scanner_usage_events FOR VALUES FROM (%L) TO (%L)',
      part_name, month_start, month_end
    );
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', part_name);
  END LOOP;
END $$;

-- =============================================================================
-- Helper function — idempotent, creates missing partitions for a date window.
-- Invoked monthly by the scanner's /v1/admin/ensure-partitions cron endpoint
-- (see apps/scanner/src/routes/admin.ts).
-- =============================================================================

CREATE OR REPLACE FUNCTION ensure_scanner_usage_partitions(p_months_ahead INT DEFAULT 3)
RETURNS TABLE(created_partition TEXT)
LANGUAGE plpgsql
AS $$
DECLARE
  month_start DATE;
  month_end   DATE;
  part_name   TEXT;
  i           INT;
BEGIN
  FOR i IN 0..p_months_ahead LOOP
    month_start := DATE_TRUNC('month', now() + make_interval(months => i))::date;
    month_end   := month_start + INTERVAL '1 month';
    part_name   := 'scanner_usage_events_' || TO_CHAR(month_start, 'YYYY_MM');

    -- Check if partition already exists
    IF NOT EXISTS (
      SELECT 1 FROM pg_class
      WHERE relname = part_name AND relkind = 'r'
    ) THEN
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF scanner_usage_events FOR VALUES FROM (%L) TO (%L)',
        part_name, month_start, month_end
      );
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', part_name);

      created_partition := part_name;
      RETURN NEXT;
    END IF;
  END LOOP;
  RETURN;
END $$;
