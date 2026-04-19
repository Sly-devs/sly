#!/usr/bin/env node
/**
 * marketplace-sim HTTP server
 *
 * Long-lived process that exposes the simulation runner over HTTP so the
 * Sly admin API (and the live round viewer through it) can start and stop
 * real-mode scenarios with a single click.
 *
 * Endpoints:
 *   GET  /health                — liveness probe
 *   GET  /scenarios             — list scenarios + their param schemas
 *   GET  /personas              — list available persona templates
 *   GET  /agents                — list seeded agent pool from tokens.json
 *   GET  /status                — current run state
 *   POST /run                   — { scenarioId, mode?, durationMs?, styles?, params? }
 *   POST /stop                  — halt the current run gracefully
 *   POST /seed                  — { honest, quality, rogue } re-seed the pool
 *   POST /analyze               — { report, scenarioName?, pool?, model? } LLM analysis of a finished round
 *
 * Auth: if SIM_SHARED_SECRET is set, every request must carry
 * `Authorization: Bearer <secret>`. Otherwise the server runs unauthenticated
 * (loopback dev only).
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { startRun, listScenarios, type RunHandle } from './runner.js';
import {
  list as listTemplates,
  getByTemplateId,
  create as createTemplate,
  update as updateTemplate,
  remove as deleteTemplate,
  setCompiled,
} from './templates/store.js';
import { seedBuiltIns, resetBuiltIn, BUILT_INS } from './templates/seed-builtins.js';
import { buildScenarioFromTemplate, parseFrontmatter, isKnownBlock, KNOWN_BLOCKS } from './scenarios/markdown-engine.js';
import {
  compileWithLlm,
  isLlmCompileAvailable,
  bodyHasSubstance,
  CompileBudgetExceededError,
  getCompileSessionCost,
} from './scenarios/compile-llm.js';
import { isSupabaseConfigured } from './db.js';
import { PERSONA_TEMPLATES } from './personas/index.js';
import { loadSimAgents } from './agents/registry.js';
import { seedPersonas } from './seeder.js';
import { analyzeReport } from './analyzer.js';
import { assistTemplate } from './scenarios/assist-llm.js';
import { saveRun, listRuns } from './runs-store.js';
import type { ScenarioResult } from './scenarios/types.js';

const PORT = parseInt(process.env.SIM_PORT || process.env.PORT || '4500', 10);
// Bind to loopback by default so a misconfigured deploy doesn't expose an
// unauthenticated sidecar to the internet. Containers/servers should set
// SIM_HOST=0.0.0.0 (and SIM_SHARED_SECRET) explicitly.
const HOST = process.env.SIM_HOST || process.env.HOST || '127.0.0.1';
const SHARED_SECRET = process.env.SIM_SHARED_SECRET || process.env.SHARED_SECRET || '';

// Model maps — duplicated from the processor files so we can expose them
// in the /agents endpoint without importing the full processor (which
// requires API keys at import time). Keep in sync with the processors.
const ANTHROPIC_MODEL_MAP: Record<string, string> = {
  'quality-reviewer': 'claude-sonnet-4-6',
  'whale': 'claude-sonnet-4-6',
  'honest': 'claude-haiku-4-5-20251001',
  'rogue-disputer': 'claude-haiku-4-5-20251001',
  'rogue-spam': 'claude-haiku-4-5-20251001',
  'colluder': 'claude-haiku-4-5-20251001',
  'mm': 'claude-haiku-4-5-20251001',
};
const OPENROUTER_MODEL_MAP: Record<string, string> = {
  'quality-reviewer': 'anthropic/claude-sonnet-4',
  'whale': 'anthropic/claude-sonnet-4',
  'honest': 'google/gemini-2.0-flash-001',
  'rogue-disputer': 'openai/gpt-4o-mini',
  'rogue-spam': 'deepseek/deepseek-chat-v3-0324',
  'colluder': 'mistralai/mistral-small-3.1-24b-instruct',
  'mm': 'qwen/qwen-2.5-72b-instruct',
};

interface CurrentRun {
  scenarioId: string;
  mode: string;
  styles: string[] | null;
  params: Record<string, unknown>;
  startedAt: string;
  durationMs: number;
  handle: RunHandle;
  result?: ScenarioResult;
  error?: string;
  finishedAt?: string;
}

let current: CurrentRun | null = null;
let lastFinished: CurrentRun | null = null;

// ─── HTTP helpers ─────────────────────────────────────────────────────────

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => {
      if (!buf) return resolve({});
      try {
        resolve(JSON.parse(buf));
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function checkAuth(req: IncomingMessage): boolean {
  if (!SHARED_SECRET) return true;
  const auth = req.headers['authorization'];
  if (!auth || typeof auth !== 'string') return false;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  return m[1] === SHARED_SECRET;
}

function statusSnapshot(run: CurrentRun | null) {
  if (!run) return null;
  return {
    scenarioId: run.scenarioId,
    mode: run.mode,
    styles: run.styles,
    params: run.params,
    startedAt: run.startedAt,
    durationMs: run.durationMs,
    finishedAt: run.finishedAt ?? null,
    result: run.result ?? null,
    error: run.error ?? null,
  };
}

// ─── Route handlers ───────────────────────────────────────────────────────

async function handleRun(req: IncomingMessage, res: ServerResponse) {
  if (current && !current.finishedAt) {
    return send(res, 409, {
      error: 'A scenario is already running',
      current: statusSnapshot(current),
    });
  }

  let body: any;
  try {
    body = await readJson(req);
  } catch (e: any) {
    return send(res, 400, { error: e.message });
  }

  const scenarioId: string = body?.scenarioId;
  if (!scenarioId) return send(res, 400, { error: 'Missing scenarioId' });

  const mode: 'scripted' | 'api' | 'subagent' = body?.mode || 'api';
  const durationMs: number = body?.durationMs ?? 120_000;
  const baseline: boolean = body?.baseline === true;
  // Optional style filter: ['honest', 'quality-reviewer', ...]. If absent,
  // the scenario receives the entire seeded pool.
  const styles: string[] | null = Array.isArray(body?.styles) && body.styles.length > 0
    ? body.styles
    : null;
  // Per-run scenario parameters — coerced/validated by the runner against
  // each scenario's ParamSpec[].
  const rawParams: Record<string, unknown> | undefined =
    body?.params && typeof body.params === 'object' ? body.params : undefined;

  let handle: RunHandle;
  try {
    handle = await startRun({
      scenarioId,
      mode,
      durationMs,
      baseline,
      styles: styles as any,
      params: rawParams,
    });
  } catch (e: any) {
    return send(res, 400, { error: e.message });
  }

  const run: CurrentRun = {
    scenarioId,
    mode,
    styles,
    params: rawParams || {},
    startedAt: new Date().toISOString(),
    durationMs,
    handle,
  };
  current = run;

  // Resolve the lifecycle in the background. We don't await it on the
  // request — the client will poll /status (or just watch the live viewer).
  handle.done
    .then(async (result) => {
      run.result = result;
      run.finishedAt = new Date().toISOString();
      lastFinished = run;
      console.log(
        `[sim-server] ${scenarioId} finished: ${result.completedTrades} trades, $${result.totalVolume.toFixed(2)}`,
      );
      // Auto-save: fetch the report from the API and persist the run
      await autoSaveRun(run);
    })
    .catch(async (err: any) => {
      run.error = err?.message || String(err);
      run.finishedAt = new Date().toISOString();
      lastFinished = run;
      console.error(`[sim-server] ${scenarioId} crashed:`, run.error);
      await autoSaveRun(run);
    })
    .finally(() => {
      if (current === run) current = null;
    });

  console.log(`[sim-server] started ${scenarioId} mode=${mode} duration=${durationMs}ms`);
  return send(res, 202, { data: { status: 'started', ...statusSnapshot(run) } });
}

/**
 * Fetch the report from the API and persist the run to scenario_runs.
 * Best-effort — failures here don't affect the scenario itself.
 */
async function autoSaveRun(run: CurrentRun): Promise<void> {
  if (!isSupabaseConfigured()) return;
  try {
    const baseUrl = process.env.SLY_API_URL;
    const adminKey = process.env.SLY_PLATFORM_ADMIN_KEY;
    if (!baseUrl || !adminKey) return;
    // Fetch the report from the API (same call the viewer makes)
    const elapsed = run.startedAt && run.finishedAt
      ? Math.max(5, Math.ceil((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 60000) + 1)
      : 10;
    const reportRes = await fetch(`${baseUrl}/admin/round/report?minutes=${elapsed}`, {
      headers: { 'Authorization': `Bearer ${adminKey}` },
    });
    const reportJson = await reportRes.json();
    const report = reportJson?.data || {};
    // Extract LLM cost from the result findings
    let llmCostUsd: number | undefined;
    const costFinding = (run.result?.findings as string[] || []).find((f: string) => f.startsWith('LLM cost:'));
    if (costFinding) {
      const m = costFinding.match(/\$([0-9.]+)/);
      if (m) llmCostUsd = parseFloat(m[1]);
    }
    const durationSeconds = run.startedAt && run.finishedAt
      ? Math.round((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)
      : 0;
    await saveRun({
      scenarioId: run.scenarioId,
      scenarioName: run.scenarioId.replace(/_/g, ' '),
      mode: run.mode,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt!,
      durationSeconds,
      result: run.result as any,
      report,
      error: run.error || undefined,
      llmCostUsd,
    });
    console.log(`[sim-server] run saved to scenario_runs: ${run.scenarioId}`);
  } catch (e: any) {
    console.warn(`[sim-server] auto-save failed (non-fatal): ${e?.message}`);
  }
}

function handleStop(req: IncomingMessage, res: ServerResponse) {
  if (!current) {
    return send(res, 404, { error: 'No scenario currently running' });
  }
  current.handle.stop();
  console.log(`[sim-server] stop requested for ${current.scenarioId}`);
  return send(res, 200, { data: { status: 'stopping', ...statusSnapshot(current) } });
}

function handleStatus(_req: IncomingMessage, res: ServerResponse) {
  return send(res, 200, {
    data: {
      running: !!current,
      current: statusSnapshot(current),
      lastFinished: statusSnapshot(lastFinished),
    },
  });
}

async function handleScenarios(_req: IncomingMessage, res: ServerResponse) {
  try {
    const data = await listScenarios();
    return send(res, 200, { data });
  } catch (e: any) {
    return send(res, 500, { error: e?.message || 'failed to list scenarios' });
  }
}

function handlePersonas(_req: IncomingMessage, res: ServerResponse) {
  // Returns persona TEMPLATES (the archetypes), not seeded agent instances.
  return send(res, 200, {
    data: Object.values(PERSONA_TEMPLATES).map((t) => ({
      id: t.id,
      namePrefix: t.namePrefix,
      role: t.role,
      style: t.style,
      defaultKyaTier: t.defaultKyaTier,
    })),
  });
}

async function handleAnalyze(req: IncomingMessage, res: ServerResponse) {
  let body: any;
  try {
    body = await readJson(req);
  } catch (e: any) {
    return send(res, 400, { error: e.message });
  }
  if (!body?.report || typeof body.report !== 'object') {
    return send(res, 400, { error: 'Missing report in body' });
  }

  // Pull pool composition for prompt context unless the caller passed one
  let pool: Array<{ name: string; style: string }> | undefined = body?.pool;
  if (!pool) {
    try {
      pool = loadSimAgents().map((a) => ({ name: a.name, style: a.style }));
    } catch {
      pool = undefined;
    }
  }

  // Look up scenario design hints from the markdown template store so we can
  // give the analyzer the context it needs to avoid flagging intentional
  // behavior as bugs. Caller may also pass an explicit scenarioHints override.
  let scenarioHints: string | undefined = body?.scenarioHints;
  if (!scenarioHints && body?.scenarioId) {
    try {
      const template = await getByTemplateId(body.scenarioId);
      if (template) {
        const scenario = buildScenarioFromTemplate(template);
        scenarioHints = scenario.analyzerHints;
      }
    } catch { /* fall through — analyzer still works without hints */ }
  }

  try {
    const result = await analyzeReport(body.report, {
      scenarioName: body.scenarioName,
      scenarioHints,
      pool,
      model: body.model,
    });
    console.log(`[sim-server] /analyze done: ${result.sections.length} sections, $${result.usage.costUsd.toFixed(4)}, hints=${scenarioHints ? 'yes' : 'no'}`);
    return send(res, 200, { data: result });
  } catch (e: any) {
    console.error('[sim-server] /analyze failed:', e);
    return send(res, 500, { error: e?.message || 'analyze failed' });
  }
}

async function handleSeed(req: IncomingMessage, res: ServerResponse) {
  // Block re-seeding mid-run — re-rolling agent identities under a live scenario
  // is asking for trouble.
  if (current && !current.finishedAt) {
    return send(res, 409, {
      error: 'A scenario is currently running — stop it before re-seeding',
      current: statusSnapshot(current),
    });
  }

  let body: any;
  try {
    body = await readJson(req);
  } catch (e: any) {
    return send(res, 400, { error: e.message });
  }

  const baseUrl = process.env.SLY_API_URL;
  const adminKey = process.env.SLY_PLATFORM_ADMIN_KEY;
  if (!baseUrl || !adminKey) {
    return send(res, 500, { error: 'Sim sidecar missing SLY_API_URL or SLY_PLATFORM_ADMIN_KEY' });
  }

  const honest = Number.isFinite(body?.honest) ? Math.max(0, Math.min(20, body.honest)) : 3;
  const quality = Number.isFinite(body?.quality) ? Math.max(0, Math.min(20, body.quality)) : 2;
  const rogue = Number.isFinite(body?.rogue) ? Math.max(0, Math.min(20, body.rogue)) : 1;
  const whale = Number.isFinite(body?.whale) ? Math.max(0, Math.min(5, body.whale)) : 0;
  const colluder = Number.isFinite(body?.colluder) ? Math.max(0, Math.min(10, body.colluder)) : 0;
  const budget = Number.isFinite(body?.budget) ? Math.max(0, Math.min(10, body.budget)) : 0;
  const specialist = Number.isFinite(body?.specialist) ? Math.max(0, Math.min(5, body.specialist)) : 0;
  const newcomer = Number.isFinite(body?.newcomer) ? Math.max(0, Math.min(10, body.newcomer)) : 0;
  const rogueSpam = Number.isFinite(body?.rogueSpam) ? Math.max(0, Math.min(5, body.rogueSpam)) : 0;
  const mm = Number.isFinite(body?.mm) ? Math.max(0, Math.min(5, body.mm)) : 0;
  const conservative = Number.isFinite(body?.conservative) ? Math.max(0, Math.min(5, body.conservative)) : 0;
  const opportunist = Number.isFinite(body?.opportunist) ? Math.max(0, Math.min(10, body.opportunist)) : 0;
  const researcher = Number.isFinite(body?.researcher) ? Math.max(0, Math.min(5, body.researcher)) : 0;

  const total = honest + quality + rogue + whale + colluder + budget + specialist + newcomer + rogueSpam + mm + conservative + opportunist + researcher;
  console.log(`[sim-server] re-seeding pool: ${total} agents (${honest}h ${quality}q ${rogue}r ${whale}w ${colluder}c ${budget}b ${specialist}s ${newcomer}n ${rogueSpam}rs ${mm}mm ${conservative}cb ${opportunist}o ${researcher}re)`);
  try {
    const result = await seedPersonas(
      { honest, quality, rogue, whale, colluder, budget, specialist, newcomer, rogueSpam, mm, conservative, opportunist, researcher },
      { baseUrl, adminKey, log: (m: string) => console.log(`[sim-server][seed] ${m}`) },
    );
    return send(res, 200, {
      data: {
        total: result.total,
        errors: result.errors,
        // Return the new pool so the viewer can refresh without a separate fetch
        agents: loadSimAgents().map((a) => ({
          agentId: a.agentId,
          name: a.name,
          templateId: a.templateId,
          style: a.style,
          balance: a.balance,
        })),
      },
    });
  } catch (e: any) {
    console.error('[sim-server] re-seed failed:', e);
    return send(res, 500, { error: e?.message || 'seed failed' });
  }
}

function handleAgents(_req: IncomingMessage, res: ServerResponse) {
  // Returns the actual seeded SimAgent pool from tokens.json — what scenarios
  // see when no style filter is applied.
  try {
    const agents = loadSimAgents();
    return send(res, 200, {
      data: agents.map((a) => ({
        agentId: a.agentId,
        name: a.name,
        templateId: a.templateId,
        style: a.style,
        balance: a.balance,
        models: {
          anthropic: ANTHROPIC_MODEL_MAP[a.style] || 'claude-haiku-4-5-20251001',
          openrouter: OPENROUTER_MODEL_MAP[a.style] || 'google/gemini-2.0-flash-001',
        },
      })),
    });
  } catch (e: any) {
    return send(res, 500, { error: e?.message || 'failed to load tokens.json' });
  }
}

// ─── Scenario template CRUD ───────────────────────────────────────────────
//
// All paths under /templates. The viewer reaches these via the existing
// /admin/round/sim/templates admin proxy on the API.

async function handleListTemplates(_req: IncomingMessage, res: ServerResponse) {
  if (!isSupabaseConfigured()) {
    return send(res, 503, { error: 'Supabase not configured on the sim sidecar' });
  }
  try {
    const all = await listTemplates({ includeInactive: true });
    return send(res, 200, {
      data: all.map((t) => ({
        id: t.id,
        templateId: t.template_id,
        name: t.name,
        buildingBlock: t.building_block,
        isBuiltIn: t.is_built_in,
        isActive: t.is_active,
        compiledAt: t.compiled_at,
        compileWarnings: t.compile_warnings,
        lastRunAt: t.last_run_at,
        updatedAt: t.updated_at,
      })),
    });
  } catch (e: any) {
    return send(res, 500, { error: e?.message || 'list failed' });
  }
}

async function handleGetTemplate(req: IncomingMessage, res: ServerResponse, templateId: string) {
  if (!isSupabaseConfigured()) {
    return send(res, 503, { error: 'Supabase not configured on the sim sidecar' });
  }
  try {
    const t = await getByTemplateId(templateId);
    if (!t) return send(res, 404, { error: `Template not found: ${templateId}` });
    return send(res, 200, { data: t });
  } catch (e: any) {
    return send(res, 500, { error: e?.message || 'get failed' });
  }
}

async function handleCreateTemplate(req: IncomingMessage, res: ServerResponse) {
  if (!isSupabaseConfigured()) {
    return send(res, 503, { error: 'Supabase not configured on the sim sidecar' });
  }
  let body: any;
  try {
    body = await readJson(req);
  } catch (e: any) {
    return send(res, 400, { error: e.message });
  }
  if (!body?.markdown || typeof body.markdown !== 'string') {
    return send(res, 400, { error: 'markdown (string) is required' });
  }

  // Pull template_id + name + buildingBlock from frontmatter unless explicitly provided
  let templateId: string | undefined = body.templateId;
  let name: string | undefined = body.name;
  let buildingBlock: string | undefined = body.buildingBlock;
  try {
    const { frontmatter } = parseFrontmatter(body.markdown);
    if (!templateId) templateId = frontmatter.id as string | undefined;
    if (!name) name = frontmatter.name as string | undefined;
    if (!buildingBlock) buildingBlock = frontmatter.buildingBlock as string | undefined;
  } catch (e: any) {
    return send(res, 400, { error: `Frontmatter parse failed: ${e.message}` });
  }

  if (!templateId) return send(res, 400, { error: 'templateId is required (in body or frontmatter `id:`)' });
  if (!name) return send(res, 400, { error: 'name is required (in body or frontmatter `name:`)' });
  if (!/^[a-z0-9_]+$/.test(templateId)) {
    return send(res, 400, { error: 'templateId must be snake_case (lowercase letters, digits, underscores)' });
  }

  try {
    const created = await createTemplate({
      template_id: templateId,
      name,
      markdown: body.markdown,
      building_block: buildingBlock || null,
    });
    return send(res, 201, { data: created });
  } catch (e: any) {
    return send(res, 400, { error: e?.message || 'create failed' });
  }
}

async function handleUpdateTemplate(req: IncomingMessage, res: ServerResponse, templateId: string) {
  if (!isSupabaseConfigured()) {
    return send(res, 503, { error: 'Supabase not configured on the sim sidecar' });
  }
  let body: any;
  try {
    body = await readJson(req);
  } catch (e: any) {
    return send(res, 400, { error: e.message });
  }

  // If markdown changed, refresh the denormalized name + building_block from
  // its frontmatter so the viewer dropdown stays in sync.
  let name: string | undefined = body.name;
  let buildingBlock: string | undefined = body.buildingBlock;
  if (typeof body.markdown === 'string') {
    try {
      const { frontmatter } = parseFrontmatter(body.markdown);
      if (name === undefined && typeof frontmatter.name === 'string') name = frontmatter.name;
      if (buildingBlock === undefined && typeof frontmatter.buildingBlock === 'string') {
        buildingBlock = frontmatter.buildingBlock;
      }
    } catch (e: any) {
      return send(res, 400, { error: `Frontmatter parse failed: ${e.message}` });
    }
  }

  try {
    const updated = await updateTemplate(templateId, {
      markdown: body.markdown,
      name,
      building_block: buildingBlock,
    });
    return send(res, 200, { data: updated });
  } catch (e: any) {
    return send(res, 400, { error: e?.message || 'update failed' });
  }
}

async function handleDeleteTemplate(_req: IncomingMessage, res: ServerResponse, templateId: string) {
  if (!isSupabaseConfigured()) {
    return send(res, 503, { error: 'Supabase not configured on the sim sidecar' });
  }
  try {
    await deleteTemplate(templateId);
    return send(res, 200, { data: { deleted: templateId } });
  } catch (e: any) {
    return send(res, 500, { error: e?.message || 'delete failed' });
  }
}

/**
 * Compile a template — Phase C stub.
 *
 * Phase C does frontmatter-only compilation: parse, instantiate the building
 * block, surface any errors as warnings. The "compiled" jsonb just mirrors the
 * frontmatter so the runner can prefer it (Phase B's LLM compile will replace
 * this with extracted natural-language config).
 *
 * The endpoint exists in Phase C so the viewer's Compile button has something
 * to call. Phase B will swap the implementation under the same endpoint.
 */
async function handleCompileTemplate(_req: IncomingMessage, res: ServerResponse, templateId: string) {
  if (!isSupabaseConfigured()) {
    return send(res, 503, { error: 'Supabase not configured on the sim sidecar' });
  }
  try {
    const template = await getByTemplateId(templateId);
    if (!template) return send(res, 404, { error: `Template not found: ${templateId}` });

    const warnings: Array<{ severity: 'warn' | 'error'; message: string; source?: string }> = [];

    // Step 1: parse frontmatter
    let frontmatter: Record<string, unknown>;
    try {
      const parsed = parseFrontmatter(template.markdown);
      frontmatter = parsed.frontmatter;
    } catch (e: any) {
      warnings.push({ severity: 'error', message: `Frontmatter parse failed: ${e.message}`, source: 'parser' });
      await setCompiled(templateId, {}, warnings);
      return send(res, 200, { data: { compiled: null, warnings } });
    }

    // Step 2: validate the building block exists. The runner closure throws
    // lazily on unknown blocks, so we check it here at compile time too.
    const buildingBlock = (frontmatter.buildingBlock as string) || template.building_block || '';
    if (!buildingBlock) {
      warnings.push({
        severity: 'error',
        message: 'No buildingBlock declared. Add `buildingBlock: bake_off` to the frontmatter.',
        source: 'engine',
      });
      await setCompiled(templateId, {}, warnings);
      return send(res, 200, { data: { compiled: null, warnings } });
    }
    if (!isKnownBlock(buildingBlock)) {
      warnings.push({
        severity: 'error',
        message: `Unknown buildingBlock "${buildingBlock}". Available: ${KNOWN_BLOCKS.join(', ')}`,
        source: 'engine',
      });
      await setCompiled(templateId, {}, warnings);
      return send(res, 200, { data: { compiled: null, warnings } });
    }

    // Step 3: instantiate the scenario via the markdown engine. This catches
    // missing required fields, malformed config, etc.
    try {
      buildScenarioFromTemplate({ ...template, compiled: null });
    } catch (e: any) {
      warnings.push({ severity: 'error', message: `Build failed: ${e.message}`, source: 'engine' });
      await setCompiled(templateId, {}, warnings);
      return send(res, 200, { data: { compiled: null, warnings } });
    }

    // Soft validations — surface common issues but don't block compile
    if (!frontmatter.requires || !Array.isArray(frontmatter.requires) || (frontmatter.requires as unknown[]).length === 0) {
      warnings.push({ severity: 'warn', message: 'No "requires" listed — scenario may run on any pool', source: 'soft' });
    }
    if (!frontmatter.params || !Array.isArray(frontmatter.params) || (frontmatter.params as unknown[]).length === 0) {
      warnings.push({ severity: 'warn', message: 'No "params" defined — scenario will not be tunable from the viewer', source: 'soft' });
    }
    if (!frontmatter.analyzerHints) {
      warnings.push({ severity: 'warn', message: 'No "analyzerHints" — the LLM analyzer will produce more false positives', source: 'soft' });
    }

    // Phase B: if an Anthropic key is configured AND the body has substance,
    // ask Claude to extract the blockConfig from the natural-language body.
    // Otherwise fall back to whatever the frontmatter declared.
    let source: 'llm' | 'frontmatter' = 'frontmatter';
    let llmCostUsd = 0;
    let llmInputTokens = 0;
    let llmOutputTokens = 0;
    let blockConfig: Record<string, unknown> = (frontmatter.blockConfig as Record<string, unknown>) || {};

    if (isLlmCompileAvailable() && bodyHasSubstance(template.markdown) && isKnownBlock(buildingBlock)) {
      try {
        const llm = await compileWithLlm(template.markdown, buildingBlock);
        if (llm.invoked) {
          // Surface LLM warnings to the viewer
          for (const w of llm.warnings) warnings.push(w);
          const hasError = llm.warnings.some((w) => w.severity === 'error');
          if (hasError || Object.keys(llm.blockConfig).length === 0) {
            warnings.push({
              severity: 'warn',
              message: `LLM compile produced ${hasError ? 'errors' : 'empty config'} — falling back to frontmatter`,
              source: 'llm',
            });
            // keep frontmatter blockConfig
          } else {
            blockConfig = llm.blockConfig;
            source = 'llm';
          }
          llmCostUsd = llm.costUsd;
          llmInputTokens = llm.inputTokens;
          llmOutputTokens = llm.outputTokens;
        }
      } catch (e: any) {
        if (e instanceof CompileBudgetExceededError) {
          warnings.push({
            severity: 'warn',
            message: `Compile budget cap reached ($${e.spent.toFixed(4)}/$${e.cap.toFixed(2)}) — using frontmatter`,
            source: 'llm',
          });
        } else {
          warnings.push({
            severity: 'warn',
            message: `LLM compile failed: ${e?.message || e} — falling back to frontmatter`,
            source: 'llm',
          });
        }
      }
    }

    // Dry-run gate: build the scenario from the compiled config and run one
    // cycle with no network calls. Catches runtime errors (missing fields,
    // bad config shapes) BEFORE the user clicks Run.
    const hasErrors = warnings.some((w) => w.severity === 'error');
    if (!hasErrors) {
      try {
        const dryTemplate = {
          ...template,
          compiled: {
            buildingBlock: frontmatter.buildingBlock || template.building_block,
            blockConfig,
          },
        };
        buildScenarioFromTemplate(dryTemplate);
      } catch (e: any) {
        warnings.push({
          severity: 'error',
          message: `Dry-run failed: ${e?.message || e}`,
          source: 'dry-run',
        });
      }
    }

    const compiled = {
      source,
      buildingBlock: frontmatter.buildingBlock || template.building_block,
      requires: frontmatter.requires || [],
      params: frontmatter.params || [],
      analyzerHints: frontmatter.analyzerHints || null,
      blockConfig,
      compiledAt: new Date().toISOString(),
      ...(source === 'llm'
        ? {
            llm: {
              model: process.env.COMPILE_MODEL || 'claude-sonnet-4-6',
              costUsd: llmCostUsd,
              inputTokens: llmInputTokens,
              outputTokens: llmOutputTokens,
              sessionTotalUsd: getCompileSessionCost(),
            },
          }
        : {}),
    };
    await setCompiled(templateId, compiled, warnings);
    return send(res, 200, { data: { compiled, warnings } });
  } catch (e: any) {
    return send(res, 500, { error: e?.message || 'compile failed' });
  }
}

async function handleAssistTemplate(req: IncomingMessage, res: ServerResponse) {
  let body: any;
  try {
    body = await readJson(req);
  } catch (e: any) {
    return send(res, 400, { error: e.message });
  }
  const instruction = body?.instruction;
  if (!instruction || typeof instruction !== 'string') {
    return send(res, 400, { error: 'instruction (string) is required' });
  }
  const currentMarkdown: string | undefined = body?.currentMarkdown;
  try {
    const result = await assistTemplate(instruction, currentMarkdown);
    return send(res, 200, { data: result });
  } catch (e: any) {
    return send(res, 500, { error: e?.message || 'assist failed' });
  }
}

async function handleListRuns(_req: IncomingMessage, res: ServerResponse) {
  if (!isSupabaseConfigured()) return send(res, 503, { error: 'Supabase not configured' });
  try {
    const runs = await listRuns({ limit: 100 });
    return send(res, 200, {
      data: runs.map((r) => ({
        id: r.id,
        scenarioId: r.scenario_id,
        scenarioName: r.scenario_name,
        mode: r.mode,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        durationSeconds: r.duration_seconds,
        verdict: r.verdict,
        assessment: r.assessment,
        completedTrades: (r.result as any)?.completedTrades ?? null,
        totalVolume: (r.result as any)?.totalVolume ?? null,
        llmCostUsd: r.llm_cost_usd,
        error: r.error,
      })),
    });
  } catch (e: any) {
    return send(res, 500, { error: e?.message || 'listRuns failed' });
  }
}

async function handleGetRun(_req: IncomingMessage, res: ServerResponse, runId: string) {
  if (!isSupabaseConfigured()) return send(res, 503, { error: 'Supabase not configured' });
  try {
    const { getRunById } = await import('./runs-store.js');
    const run = await getRunById(runId);
    if (!run) return send(res, 404, { error: `Run not found: ${runId}` });
    return send(res, 200, { data: run });
  } catch (e: any) {
    return send(res, 500, { error: e?.message || 'getRun failed' });
  }
}

async function handleAnalyzeRun(req: IncomingMessage, res: ServerResponse, runId: string) {
  if (!isSupabaseConfigured()) return send(res, 503, { error: 'Supabase not configured' });
  let body: any;
  try { body = await readJson(req); } catch { body = {}; }
  const forceReanalyze = body?.force === true;
  try {
    const { getRunById, saveAnalysis } = await import('./runs-store.js');
    const run = await getRunById(runId);
    if (!run) return send(res, 404, { error: `Run not found: ${runId}` });

    // Return cached analysis if it exists (unless force=true)
    if (run.analysis && !forceReanalyze) {
      return send(res, 200, { data: { ...run.analysis, cached: true } });
    }

    const report = (run.report || {}) as Record<string, unknown>;
    const scenarioId = run.scenario_id;
    let scenarioHints: string | undefined;
    try {
      const tpl = await getByTemplateId(scenarioId);
      if (tpl) {
        const scenario = buildScenarioFromTemplate(tpl);
        scenarioHints = scenario.analyzerHints;
      }
    } catch {}
    const result = await analyzeReport(report as any, {
      scenarioName: run.scenario_name || scenarioId,
      scenarioHints,
      model: body?.model || 'claude-opus-4-6',
      maxTokens: 3000,
    });

    // Persist the analysis so we don't re-run it every time
    try {
      await saveAnalysis(runId, result as any);
    } catch (e: any) {
      console.warn(`[sim-server] failed to save analysis (non-fatal): ${e.message}`);
    }

    return send(res, 200, { data: result });
  } catch (e: any) {
    return send(res, 500, { error: e?.message || 'analyze failed' });
  }
}

async function handleRunAll(req: IncomingMessage, res: ServerResponse) {
  if (current && !current.finishedAt) {
    return send(res, 409, { error: 'A scenario is already running — stop it first' });
  }
  let body: any;
  try { body = await readJson(req); } catch { body = {}; }
  const mode = body?.mode || 'openrouter';
  const durationMs = body?.durationMs ?? 120_000;

  // List all active scenarios
  const scenarios = await listScenarios();
  if (scenarios.length === 0) {
    return send(res, 400, { error: 'No active scenarios found' });
  }

  // Return immediately with the plan; execute in background
  send(res, 202, {
    data: {
      status: 'started',
      total: scenarios.length,
      mode,
      durationMs,
      scenarios: scenarios.map((s) => s.id),
    },
  });

  // Reset all built-in templates to their shipped defaults so stale DB rows
  // don't cause pool-mismatch failures (learned from the first batch run).
  try {
    for (const t of BUILT_INS) {
      await resetBuiltIn(t.template_id).catch(() => {});
    }
    console.log(`[sim-server] run-all: reset ${BUILT_INS.length} built-in templates`);
  } catch {}

  // Sequential execution in background
  console.log(`[sim-server] run-all: ${scenarios.length} scenarios, mode=${mode}, duration=${durationMs}ms each`);
  for (const scenario of scenarios) {
    if (current && !current.finishedAt) {
      // Wait for previous to finish
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (!current || current.finishedAt) { clearInterval(check); resolve(); }
        }, 1000);
      });
    }
    console.log(`[sim-server] run-all: starting ${scenario.id}...`);
    try {
      const handle = await startRun({
        scenarioId: scenario.id,
        mode: mode as any,
        durationMs,
      });
      const run: CurrentRun = {
        scenarioId: scenario.id,
        mode,
        styles: null,
        params: {},
        startedAt: new Date().toISOString(),
        durationMs,
        handle,
      };
      current = run;
      try {
        const result = await handle.done;
        run.result = result;
        run.finishedAt = new Date().toISOString();
        lastFinished = run;
        console.log(`[sim-server] run-all: ${scenario.id} → ${result.completedTrades} trades, $${result.totalVolume.toFixed(2)}`);
        await autoSaveRun(run);
      } catch (err: any) {
        run.error = err?.message || String(err);
        run.finishedAt = new Date().toISOString();
        lastFinished = run;
        console.error(`[sim-server] run-all: ${scenario.id} crashed: ${run.error}`);
        await autoSaveRun(run);
      }
      current = null;
    } catch (e: any) {
      console.error(`[sim-server] run-all: ${scenario.id} failed to start: ${e.message}`);
      // Save the error
      if (isSupabaseConfigured()) {
        try {
          await saveRun({
            scenarioId: scenario.id,
            scenarioName: scenario.name,
            mode,
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            durationSeconds: 0,
            error: e.message,
          });
        } catch {}
      }
    }
    // Brief pause between scenarios to let the platform settle
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log(`[sim-server] run-all: complete — ${scenarios.length} scenarios executed`);
}

async function handleResetBuiltIn(_req: IncomingMessage, res: ServerResponse, templateId: string) {
  if (!isSupabaseConfigured()) {
    return send(res, 503, { error: 'Supabase not configured on the sim sidecar' });
  }
  if (!BUILT_INS.find((t) => t.template_id === templateId)) {
    return send(res, 404, { error: `Not a built-in template: ${templateId}` });
  }
  try {
    await resetBuiltIn(templateId);
    const t = await getByTemplateId(templateId);
    return send(res, 200, { data: t });
  } catch (e: any) {
    return send(res, 500, { error: e?.message || 'reset failed' });
  }
}

// ─── Server boot ──────────────────────────────────────────────────────────

// ─── Scheduled runs ─────────────────────────────────────────────────────
let scheduleTimer: ReturnType<typeof setInterval> | null = null;
let scheduleConfig: { intervalHours: number; mode: string; durationMs: number } | null = null;

async function handleSchedule(req: IncomingMessage, res: ServerResponse) {
  let body: any;
  try { body = await readJson(req); } catch { body = {}; }
  const intervalHours = body?.intervalHours ?? 24;
  const mode = body?.mode ?? 'openrouter';
  const durationMs = body?.durationMs ?? 120_000;

  if (scheduleTimer) clearInterval(scheduleTimer);
  scheduleConfig = { intervalHours, mode, durationMs };

  scheduleTimer = setInterval(async () => {
    console.log(`[sim-server] scheduled run triggered (every ${intervalHours}h)`);
    // Synthesize a fake request to handleRunAll
    const fakeReq = { method: 'POST', url: '/run-all' } as any;
    fakeReq.on = () => fakeReq;
    fakeReq.headers = {};
    let bodyData = JSON.stringify({ mode, durationMs });
    const chunks: Buffer[] = [Buffer.from(bodyData)];
    process.nextTick(() => {
      fakeReq.emit?.('data', chunks[0]);
      fakeReq.emit?.('end');
    });
    // Just call the run-all logic directly
    try {
      const scenarios = await listScenarios();
      for (const t of BUILT_INS) { await resetBuiltIn(t.template_id).catch(() => {}); }
      for (const scenario of scenarios) {
        try {
          const handle = await startRun({ scenarioId: scenario.id, mode: mode as any, durationMs });
          const result = await handle.done;
          console.log(`[scheduled] ${scenario.id}: ${result.completedTrades} trades`);
        } catch (e: any) {
          console.error(`[scheduled] ${scenario.id}: ${e.message}`);
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
      console.log('[scheduled] batch complete');
    } catch (e: any) {
      console.error('[scheduled] batch failed:', e.message);
    }
  }, intervalHours * 60 * 60 * 1000);

  console.log(`[sim-server] scheduled: run-all every ${intervalHours}h, mode=${mode}`);
  return send(res, 200, { data: { scheduled: true, ...scheduleConfig } });
}

function handleUnschedule(_req: IncomingMessage, res: ServerResponse) {
  if (scheduleTimer) { clearInterval(scheduleTimer); scheduleTimer = null; }
  scheduleConfig = null;
  console.log('[sim-server] schedule cancelled');
  return send(res, 200, { data: { scheduled: false } });
}

function handleGetSchedule(_req: IncomingMessage, res: ServerResponse) {
  return send(res, 200, { data: { active: !!scheduleTimer, config: scheduleConfig } });
}

const server = createServer(async (req, res) => {
  const url = req.url || '/';
  const method = req.method || 'GET';

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
    return res.end();
  }

  // Health is unauthenticated so the API can ping it.
  if (method === 'GET' && url === '/health') {
    return send(res, 200, { data: { status: 'healthy', version: '0.1.0', running: !!current } });
  }

  if (!checkAuth(req)) {
    return send(res, 401, { error: 'Unauthorized' });
  }

  try {
    if (method === 'GET' && url === '/scenarios') return await handleScenarios(req, res);
    if (method === 'GET' && url === '/personas') return handlePersonas(req, res);
    if (method === 'GET' && url === '/agents') return handleAgents(req, res);
    if (method === 'GET' && url === '/status') return handleStatus(req, res);
    if (method === 'POST' && url === '/run') return await handleRun(req, res);
    if (method === 'POST' && url === '/stop') return handleStop(req, res);
    if (method === 'POST' && url === '/seed') return await handleSeed(req, res);
    if (method === 'POST' && url === '/analyze') return await handleAnalyze(req, res);

    // ─── Run history + batch + schedule ───
    if (method === 'GET' && url === '/runs') return await handleListRuns(req, res);
    if (method === 'POST' && url === '/run-all') return await handleRunAll(req, res);
    if (method === 'POST' && url === '/schedule') return handleSchedule(req, res);
    if (method === 'DELETE' && url === '/schedule') return handleUnschedule(req, res);
    if (method === 'GET' && url === '/schedule') return handleGetSchedule(req, res);
    const runMatch = url.match(/^\/runs\/([0-9a-f-]+)(\/analyze)?$/);
    if (runMatch) {
      const runId = runMatch[1];
      const action = runMatch[2];
      if (action === '/analyze' && method === 'POST') return await handleAnalyzeRun(req, res, runId);
      if (method === 'GET') return await handleGetRun(req, res, runId);
    }

    // ─── Scenario template CRUD ───
    if (method === 'GET' && url === '/templates') return await handleListTemplates(req, res);
    if (method === 'POST' && url === '/templates') return await handleCreateTemplate(req, res);
    if (method === 'POST' && url === '/templates/assist') return await handleAssistTemplate(req, res);
    const tplMatch = url.match(/^\/templates\/([a-z0-9_]+)(\/(?:reset|compile))?$/);
    if (tplMatch) {
      const templateId = tplMatch[1];
      const action = tplMatch[2];
      if (action === '/reset' && method === 'POST') return await handleResetBuiltIn(req, res, templateId);
      if (action === '/compile' && method === 'POST') return await handleCompileTemplate(req, res, templateId);
      if (method === 'GET') return await handleGetTemplate(req, res, templateId);
      if (method === 'PUT') return await handleUpdateTemplate(req, res, templateId);
      if (method === 'DELETE') return await handleDeleteTemplate(req, res, templateId);
    }

    return send(res, 404, { error: `Not found: ${method} ${url}` });
  } catch (e: any) {
    console.error('[sim-server] handler error:', e);
    return send(res, 500, { error: e?.message || 'Internal error' });
  }
});

// Refuse to boot in an obviously-unsafe deployment: binding to 0.0.0.0
// without a shared secret would expose all sim controls (run/seed/analyze)
// to anyone who can reach the port.
if (HOST === '0.0.0.0' && !SHARED_SECRET) {
  console.error(
    '[sim-server] Refusing to start: HOST=0.0.0.0 with no SIM_SHARED_SECRET. ' +
    'Set SIM_SHARED_SECRET or bind to 127.0.0.1 for local dev.'
  );
  process.exit(1);
}

server.listen(PORT, HOST, async () => {
  console.log(`[sim-server] listening on http://${HOST}:${PORT}`);
  console.log(`[sim-server] auth: ${SHARED_SECRET ? 'shared secret enabled' : 'OPEN (dev only, loopback)'}`);

  // Seed built-in scenario templates if they don't already exist.
  // Idempotent: existing rows (including any operator edits) are left alone.
  if (isSupabaseConfigured()) {
    try {
      const seedResult = await seedBuiltIns();
      if (seedResult.created.length > 0) {
        console.log(`[sim-server] seeded built-in templates: ${seedResult.created.join(', ')}`);
      }
      if (seedResult.skipped.length > 0) {
        console.log(`[sim-server] built-ins already present: ${seedResult.skipped.join(', ')}`);
      }
    } catch (e: any) {
      console.error('[sim-server] failed to seed built-in templates:', e.message);
    }
  } else {
    console.warn('[sim-server] SUPABASE_URL/SERVICE_ROLE_KEY not set — scenario templates feature disabled');
  }

  try {
    const scenarios = await listScenarios();
    console.log(`[sim-server] scenarios: ${scenarios.map((s) => s.id).join(', ') || '(none — check Supabase config)'}`);
  } catch (e: any) {
    console.error('[sim-server] could not list scenarios at startup:', e.message);
  }
});

function shutdown(signal: string) {
  console.log(`[sim-server] ${signal} received, shutting down`);
  if (current) current.handle.stop();
  server.close(() => process.exit(0));
  // Hard exit fallback
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
