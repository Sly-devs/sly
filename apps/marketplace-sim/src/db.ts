/**
 * Supabase client for the marketplace-sim sidecar.
 *
 * The sim sidecar reads/writes the `scenario_templates` table directly using
 * the service role key. The viewer reaches the table only through the sidecar
 * — there is no direct browser → Supabase path.
 *
 * Service role bypasses RLS, which is correct for this table since it's a
 * Sly-internal tool with no per-tenant rows.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let cachedClient: SupabaseClient | null = null;

/**
 * Returns the shared Supabase client. Lazy-initialized so the sidecar can
 * still start (and serve /health, /scenarios for the existing TS scenarios)
 * even if SUPABASE_URL is not configured — only the templates feature breaks.
 *
 * Throws if called when env vars are missing, so callers see a clear error
 * instead of a silent null.
 */
export function getSupabase(): SupabaseClient {
  if (cachedClient) return cachedClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in apps/marketplace-sim/.env to use the scenario template store',
    );
  }
  cachedClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cachedClient;
}

/** True iff the Supabase env is configured. Used by /health and startup. */
export function isSupabaseConfigured(): boolean {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}
