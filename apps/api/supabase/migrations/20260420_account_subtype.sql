-- Account subtype column.
--
-- Before: accounts had type ∈ {'person', 'business', 'agent'} and merchants
-- were distinguished only by metadata.pos_provider being set. That made
-- merchant-specific UI ("render this account as a merchant") rely on a
-- JSONB probe, and joining merchants against other tables was noisy.
--
-- After: accounts gain a `subtype TEXT` column that further classifies
-- businesses. Initial conventions (not a DB enum — stays flexible):
--   type='business', subtype='merchant'  → merchant accounts
--   type='business', subtype='standard' or NULL → regular business
--   type='person' or 'agent'              → subtype always NULL
--
-- Backfill populates 'merchant' on every existing business account whose
-- metadata.pos_provider is set, so code that already relies on that flag
-- keeps working but can migrate to the cleaner subtype check over time.

ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS subtype TEXT;

UPDATE public.accounts
   SET subtype = 'merchant'
 WHERE type = 'business'
   AND metadata->>'pos_provider' IS NOT NULL
   AND subtype IS DISTINCT FROM 'merchant';

-- Index to keep the accounts list's subtype filter cheap.
CREATE INDEX IF NOT EXISTS accounts_tenant_type_subtype_idx
  ON public.accounts (tenant_id, type, subtype);

COMMENT ON COLUMN public.accounts.subtype IS
  'Sub-classification for the account type. For type=''business'': ''merchant'' | ''standard'' | NULL. NULL for non-business accounts.';
