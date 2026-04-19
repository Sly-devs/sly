-- Epic 73, Story 73.2: Account Table Schema Updates
-- Adds verification path, partner reliance, and compliance contact fields.

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS verification_path TEXT DEFAULT 'standard'
  CHECK (verification_path IN ('standard', 'partner_reliance', 'enterprise'));

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS reliance_partner_id UUID;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS reliance_agreement_date TIMESTAMPTZ;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS compliance_contact_name TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS compliance_contact_email TEXT;

COMMENT ON COLUMN accounts.verification_path IS
  'Story 73.2: How this account was verified — standard (Persona/Sumsub), partner_reliance (Zindigi/ACBA), or enterprise (relationship-managed).';
COMMENT ON COLUMN accounts.reliance_partner_id IS
  'Story 73.2: UUID of the partner institution that vouched for this account under reliance.';
COMMENT ON COLUMN accounts.compliance_contact_email IS
  'Story 73.2: Designated compliance contact email for T3 enterprise accounts.';
