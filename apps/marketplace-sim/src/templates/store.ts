/**
 * Scenario template store — CRUD over the `scenario_templates` Supabase table.
 *
 * Templates are markdown documents (frontmatter + body) that the sim sidecar
 * interprets at runtime via the markdown engine. The store is the source of
 * truth — every other component (runner, /scenarios listing, viewer modal)
 * reads from here.
 *
 * Save semantics (per planning decision 4): every write sets is_active=true.
 * Drafts that haven't been saved cannot run.
 */

import { getSupabase } from '../db.js';

export interface TemplateRow {
  id: string;
  template_id: string;
  name: string;
  markdown: string;
  building_block: string | null;
  compiled: Record<string, unknown> | null;
  compiled_at: string | null;
  compile_warnings: Array<{ severity: 'warn' | 'error'; message: string; source?: string }>;
  is_built_in: boolean;
  is_active: boolean;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateTemplateInput {
  template_id: string;
  name: string;
  markdown: string;
  building_block?: string | null;
  is_built_in?: boolean;
}

export interface UpdateTemplateInput {
  name?: string;
  markdown?: string;
  building_block?: string | null;
}

const TABLE = 'scenario_templates';

/** List active templates by default; pass {includeInactive:true} to see all. */
export async function list(opts: { includeInactive?: boolean } = {}): Promise<TemplateRow[]> {
  const sb = getSupabase();
  let q = sb.from(TABLE).select('*').order('is_built_in', { ascending: false }).order('name', { ascending: true });
  if (!opts.includeInactive) q = q.eq('is_active', true);
  const { data, error } = await q;
  if (error) throw new Error(`templates.list failed: ${error.message}`);
  return (data || []) as TemplateRow[];
}

/** Resolve by template_id (the stable string id, not the UUID). */
export async function getByTemplateId(templateId: string): Promise<TemplateRow | null> {
  const sb = getSupabase();
  const { data, error } = await sb.from(TABLE).select('*').eq('template_id', templateId).maybeSingle();
  if (error) throw new Error(`templates.get failed: ${error.message}`);
  return (data as TemplateRow) || null;
}

/** Create a new template. Initial save is active by default. */
export async function create(input: CreateTemplateInput): Promise<TemplateRow> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from(TABLE)
    .insert({
      template_id: input.template_id,
      name: input.name,
      markdown: input.markdown,
      building_block: input.building_block ?? null,
      is_built_in: input.is_built_in ?? false,
      is_active: true,
      // Compiled is null on create; user must run /compile before /run.
      compiled: null,
      compiled_at: null,
      compile_warnings: [],
    })
    .select('*')
    .single();
  if (error) throw new Error(`templates.create failed: ${error.message}`);
  return data as TemplateRow;
}

/**
 * Update an existing template. Always:
 *   - sets is_active = true (save = activate, decision 4)
 *   - clears compiled config (forces a fresh compile, decision 2 — separate buttons)
 */
export async function update(templateId: string, input: UpdateTemplateInput): Promise<TemplateRow> {
  const sb = getSupabase();

  // Save a version snapshot of the current state before applying the update
  if (input.markdown !== undefined) {
    const current = await getByTemplateId(templateId);
    if (current) {
      await saveVersion(templateId, current.markdown, current.building_block).catch(() => {});
    }
  }

  const patch: Record<string, unknown> = {
    is_active: true,
    compiled: null,
    compiled_at: null,
    compile_warnings: [],
  };
  if (input.name !== undefined) patch.name = input.name;
  if (input.markdown !== undefined) patch.markdown = input.markdown;
  if (input.building_block !== undefined) patch.building_block = input.building_block;

  const { data, error } = await sb.from(TABLE).update(patch).eq('template_id', templateId).select('*').single();
  if (error) throw new Error(`templates.update failed: ${error.message}`);
  return data as TemplateRow;
}

/** Upsert by template_id. Used by the built-in seeder. */
export async function upsert(input: CreateTemplateInput): Promise<TemplateRow> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from(TABLE)
    .upsert(
      {
        template_id: input.template_id,
        name: input.name,
        markdown: input.markdown,
        building_block: input.building_block ?? null,
        is_built_in: input.is_built_in ?? false,
        is_active: true,
      },
      { onConflict: 'template_id' },
    )
    .select('*')
    .single();
  if (error) throw new Error(`templates.upsert failed: ${error.message}`);
  return data as TemplateRow;
}

/**
 * Persist the result of a compile pass. Phase B uses this; Phase A leaves
 * compiled = null and the runner can fall back to frontmatter-only parsing.
 */
export async function setCompiled(
  templateId: string,
  compiled: Record<string, unknown>,
  warnings: TemplateRow['compile_warnings'],
): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb
    .from(TABLE)
    .update({
      compiled,
      compiled_at: new Date().toISOString(),
      compile_warnings: warnings,
    })
    .eq('template_id', templateId);
  if (error) throw new Error(`templates.setCompiled failed: ${error.message}`);
}

/** Mark a template as run (bookkeeping for sorting / reporting). */
export async function markRun(templateId: string): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb
    .from(TABLE)
    .update({ last_run_at: new Date().toISOString() })
    .eq('template_id', templateId);
  if (error) console.warn(`[templates] markRun failed: ${error.message}`);
}

/** Hard delete. Built-ins are deletable too — they'll re-seed on next sidecar restart. */
export async function remove(templateId: string): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb.from(TABLE).delete().eq('template_id', templateId);
  if (error) throw new Error(`templates.remove failed: ${error.message}`);
}

// ─── Template versioning ────────────────────────────────────────────────

/** Save a version snapshot before applying an update (called from update/upsert). */
async function saveVersion(templateId: string, markdown: string, buildingBlock: string | null, editSummary?: string): Promise<void> {
  const sb = getSupabase();
  // Get the latest version number
  const { data: latest } = await sb
    .from('scenario_template_versions')
    .select('version')
    .eq('template_id', templateId)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextVersion = (latest?.version ?? 0) + 1;
  await sb.from('scenario_template_versions').insert({
    template_id: templateId,
    version: nextVersion,
    markdown,
    building_block: buildingBlock,
    edit_summary: editSummary || null,
  });
}

/** List version history for a template. */
export async function listVersions(templateId: string, limit = 20): Promise<Array<{
  id: string;
  version: number;
  building_block: string | null;
  edit_summary: string | null;
  created_at: string;
}>> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('scenario_template_versions')
    .select('id, version, building_block, edit_summary, created_at')
    .eq('template_id', templateId)
    .order('version', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listVersions failed: ${error.message}`);
  return data || [];
}

/** Get a specific version's full markdown. */
export async function getVersion(templateId: string, version: number): Promise<{ markdown: string; version: number; created_at: string } | null> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('scenario_template_versions')
    .select('markdown, version, created_at')
    .eq('template_id', templateId)
    .eq('version', version)
    .maybeSingle();
  if (error) throw new Error(`getVersion failed: ${error.message}`);
  return data;
}
