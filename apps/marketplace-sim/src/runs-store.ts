/**
 * Scenario run persistence — CRUD for the scenario_runs table.
 *
 * Each row records one complete scenario execution: the result from the
 * runner, the full report from the API, extracted assessment/verdict/byStyle,
 * and any error. Used by the run-all batch script and the viewer's run
 * history modal.
 */

import { getSupabase } from './db.js';

const TABLE = 'scenario_runs';

export interface ScenarioRunRecord {
  id: string;
  scenario_id: string;
  scenario_name: string | null;
  mode: string;
  started_at: string;
  finished_at: string | null;
  duration_seconds: number | null;
  result: Record<string, unknown> | null;
  report: Record<string, unknown> | null;
  assessment: Array<{ category: string; status: string; finding: string }> | null;
  verdict: string | null;
  by_style: Record<string, unknown> | null;
  rogue: Record<string, unknown> | null;
  error: string | null;
  llm_cost_usd: number | null;
  analysis: Record<string, unknown> | null;
  created_at: string;
}

export interface SaveRunInput {
  scenarioId: string;
  scenarioName?: string;
  mode: string;
  startedAt: string;
  finishedAt: string;
  durationSeconds: number;
  result?: Record<string, unknown>;
  report?: Record<string, unknown>;
  error?: string;
  llmCostUsd?: number;
}

export async function saveRun(input: SaveRunInput): Promise<ScenarioRunRecord> {
  const sb = getSupabase();
  const report = input.report || {};

  const { data, error } = await sb
    .from(TABLE)
    .insert({
      scenario_id: input.scenarioId,
      scenario_name: input.scenarioName || null,
      mode: input.mode,
      started_at: input.startedAt,
      finished_at: input.finishedAt,
      duration_seconds: input.durationSeconds,
      result: input.result || null,
      report: report,
      assessment: (report as any).assessment || null,
      verdict: (report as any).verdict || null,
      by_style: (report as any).byStyle || null,
      rogue: (report as any).rogue || null,
      error: input.error || null,
      llm_cost_usd: input.llmCostUsd || null,
    })
    .select('*')
    .single();

  if (error) throw new Error(`saveRun failed: ${error.message}`);
  return data as ScenarioRunRecord;
}

export async function listRuns(opts: {
  scenarioId?: string;
  limit?: number;
} = {}): Promise<ScenarioRunRecord[]> {
  const sb = getSupabase();
  let q = sb
    .from(TABLE)
    .select('*')
    .order('created_at', { ascending: false })
    .limit(opts.limit || 100);
  if (opts.scenarioId) q = q.eq('scenario_id', opts.scenarioId);
  const { data, error } = await q;
  if (error) throw new Error(`listRuns failed: ${error.message}`);
  return (data || []) as ScenarioRunRecord[];
}

export async function getRunById(id: string): Promise<ScenarioRunRecord | null> {
  const sb = getSupabase();
  const { data, error } = await sb.from(TABLE).select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(`getRun failed: ${error.message}`);
  return (data as ScenarioRunRecord) || null;
}

export async function saveAnalysis(runId: string, analysis: Record<string, unknown>): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb.from(TABLE).update({ analysis }).eq('id', runId);
  if (error) throw new Error(`saveAnalysis failed: ${error.message}`);
}
