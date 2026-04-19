-- Scenario Templates
--
-- Markdown-authored scenarios for the marketplace-sim sidecar.
--
-- Each row is one scenario the sim sidecar can run. The `markdown` column is
-- the source of truth — frontmatter declares which building block (loop
-- engine) the scenario uses, plus structured params and hooks. The body is
-- natural-language documentation + cycle logic that the LLM compiler turns
-- into the `compiled` jsonb config.
--
-- Global table (no tenant_id): the marketplace-sim is a Sly-internal tool
-- and templates are shared across all employees / environments.
--
-- The sim sidecar reads/writes this table directly via the service role key
-- (set in apps/marketplace-sim/.env). The viewer talks to the sidecar
-- through the existing /admin/round/sim/* admin proxies.

create table if not exists scenario_templates (
  id uuid primary key default gen_random_uuid(),

  -- Stable identifier used by the sim runner (e.g. 'price_discovery_real').
  -- Matches the frontmatter `id:` field. Unique across the platform.
  template_id text not null unique,

  -- Display name shown in the viewer dropdown
  name text not null,

  -- The full markdown source. Source of truth — everything else is derived.
  markdown text not null,

  -- Building block (loop engine) the scenario uses. Denormalized from the
  -- frontmatter for filtering. Examples: 'bake_off', 'one_to_one', 'broadcast'.
  building_block text,

  -- LLM-compiled structured config. Null until the user clicks Compile.
  -- Shape depends on the building_block — see src/scenarios/blocks/*.
  compiled jsonb,

  -- When the compile succeeded
  compiled_at timestamptz,

  -- Array of warnings/errors from the last compile attempt.
  -- Shape: [{ severity: 'warn'|'error', message: string, source?: string }]
  compile_warnings jsonb default '[]'::jsonb,

  -- Marks templates that ship with the sim sidecar (built-ins).
  -- Built-ins can be reset via a viewer button.
  is_built_in boolean not null default false,

  -- Save = activate. The runner only lists active templates in the dropdown.
  -- Decision 4 from the planning session: drafts that have not been saved
  -- explicitly cannot run.
  is_active boolean not null default true,

  -- Bookkeeping — when this template was most recently used in a run
  last_run_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists scenario_templates_template_id_idx on scenario_templates(template_id);
create index if not exists scenario_templates_active_idx on scenario_templates(is_active) where is_active = true;

-- updated_at trigger
create or replace function scenario_templates_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists scenario_templates_updated_at on scenario_templates;
create trigger scenario_templates_updated_at
  before update on scenario_templates
  for each row execute function scenario_templates_set_updated_at();

-- RLS: enable but allow only the service role to access. The sim sidecar uses
-- the service role key directly, and the viewer reaches the table through the
-- /admin/round/sim/templates proxy (which goes through the platform admin key
-- on the API → admin auth on the sidecar → service role to the DB).
alter table scenario_templates enable row level security;

-- No explicit policies = no rows visible to authenticated/anon roles.
-- Service role bypasses RLS, which is the only path we want.

comment on table scenario_templates is
  'Markdown-authored scenarios for the marketplace-sim sidecar. Global table; service-role-only access.';
