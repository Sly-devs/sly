/**
 * Scenario runner — shared between the CLI and the HTTP server.
 *
 * Loads the seeded SimAgent pool from tokens.json + the markdown templates
 * from the scenario_templates table. Builds a wired ScenarioContext and runs
 * the scenario. Exposes a stop fn so an external controller (HTTP /stop,
 * SIGINT) can halt mid-cycle.
 *
 * Templates are the canonical source for real scenarios. There are no
 * hardcoded TS scenario files anymore — see seed-builtins.ts.
 */

import { SlyClient } from './sly-client.js';
import { Narrator } from './narrator.js';
import { ScriptedProcessor } from './processors/scripted.js';
import type { TaskProcessor, SimAgent } from './processors/types.js';
import { loadSimAgents, filterByStyle } from './agents/registry.js';
import type { ScenarioDefinition, ScenarioResult, PoolConfig } from './scenarios/types.js';
import { resolveParams } from './scenarios/types.js';
import { list as listTemplates, getByTemplateId, markRun } from './templates/store.js';
import { buildScenarioFromTemplate } from './scenarios/markdown-engine.js';
import { isSupabaseConfigured } from './db.js';
import { seedPersonas } from './seeder.js';

export interface RunOptions {
  scenarioId: string;
  /** scripted | api | openrouter | subagent — passed through to the processor factory */
  mode: 'scripted' | 'api' | 'subagent';
  durationMs: number;
  /** Optional style filter — if provided, only agents of these styles are passed to the scenario */
  styles?: SimAgent['style'][];
  /** Per-run param overrides — coerced against the scenario's schema */
  params?: Record<string, unknown>;
  /**
   * Baseline mode: disables all Sly infrastructure features (reputation,
   * dynamic pricing, model differentiation) to simulate a "no infrastructure"
   * market. Used for before/after empirical comparison in the whitepaper.
   */
  baseline?: boolean;
  /** Override env vars (used by tests + the HTTP server) */
  baseUrl?: string;
  adminKey?: string;
}

export interface RunHandle {
  stop(): void;
  /** Promise resolves when the scenario fully exits */
  done: Promise<ScenarioResult>;
}

export async function makeProcessor(mode: string, opts?: { baseline?: boolean }): Promise<TaskProcessor> {
  if (mode === 'scripted') return new ScriptedProcessor();
  if (mode === 'api') {
    const { AnthropicApiProcessor } = await import('./processors/anthropic-api.js').catch(() => {
      throw new Error('AnthropicApiProcessor not available — install @anthropic-ai/sdk');
    });
    return new AnthropicApiProcessor({
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.ANTHROPIC_MODEL,
      budgetUsdCap: parseFloat(process.env.BUDGET_USD_CAP || '5'),
      forceUniformModel: opts?.baseline,
    });
  }
  if (mode === 'openrouter') {
    const { OpenRouterProcessor } = await import('./processors/openrouter.js').catch(() => {
      throw new Error('OpenRouterProcessor not available');
    });
    return new OpenRouterProcessor({
      apiKey: process.env.OPENROUTER_API_KEY,
      budgetUsdCap: parseFloat(process.env.BUDGET_USD_CAP || '5'),
    });
  }
  if (mode === 'subagent') {
    throw new Error('Subagent mode not yet implemented (phase 6).');
  }
  throw new Error(`Unknown mode: ${mode}. Use scripted | api | openrouter | subagent.`);
}

/**
 * Resolve a scenario by id. Loads the markdown template from the DB and
 * compiles it via the markdown engine. Throws if the id is unknown or the
 * template is missing/inactive.
 */
async function resolveScenario(scenarioId: string): Promise<ScenarioDefinition> {
  if (!isSupabaseConfigured()) {
    throw new Error(
      'Scenario templates require SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in apps/marketplace-sim/.env',
    );
  }
  const template = await getByTemplateId(scenarioId);
  if (!template) throw new Error(`Unknown scenario: ${scenarioId}`);
  if (!template.is_active) {
    throw new Error(`Scenario "${scenarioId}" exists but is inactive — save it from the viewer to activate.`);
  }
  return buildScenarioFromTemplate(template);
}

/**
 * Start a scenario run. Returns a handle with `stop()` and a `done` promise.
 * Throws synchronously on configuration errors (missing scenario, missing
 * env vars, no seeded agents). Async errors come out of `done`.
 */
export async function startRun(opts: RunOptions): Promise<RunHandle> {
  const scenario = await resolveScenario(opts.scenarioId);
  const baseUrl = opts.baseUrl || process.env.SLY_API_URL;
  const adminKey = opts.adminKey || process.env.SLY_PLATFORM_ADMIN_KEY;
  if (!baseUrl || !adminKey) {
    throw new Error('Missing SLY_API_URL or SLY_PLATFORM_ADMIN_KEY');
  }

  const sly = new SlyClient({ baseUrl, adminKey });
  // Reach the API up-front so we fail fast if it's down.
  await sly.health();

  // Load the seeded SimAgent pool. Optionally filter by style.
  let agents = loadSimAgents();
  if (agents.length === 0) {
    throw new Error('No seeded agents found in tokens.json — run `pnpm seed-personas` first.');
  }
  if (opts.styles && opts.styles.length > 0) {
    agents = filterByStyle(agents, opts.styles);
    if (agents.length === 0) {
      throw new Error(`No seeded agents matched the requested styles: ${opts.styles.join(', ')}`);
    }
  }

  // Verify the pool satisfies the scenario's `requires`. If the pool is
  // missing required styles AND the scenario declares a `pool` config,
  // auto-seed to match — so the user never has to manually re-seed.
  if (scenario.requires && scenario.requires.length > 0) {
    const poolStyles = new Set(agents.map((a) => a.style));
    const missing = scenario.requires.filter((s) => !poolStyles.has(s));
    if (missing.length > 0) {
      // Build seed counts from the template's pool config, or derive a
      // sensible default from the requires list so auto-seed always works
      // even for templates whose DB row predates the pool field.
      const STYLE_TO_SEED_KEY: Record<string, keyof typeof seedCounts> = {
        'honest': 'honest',
        'quality-reviewer': 'quality',
        'rogue-disputer': 'rogue',
        'rogue-spam': 'rogueSpam',
        'whale': 'whale',
        'colluder': 'colluder',
        'mm': 'mm',
      };
      const pool = scenario.pool || {};
      const seedCounts = {
        honest: pool.honest ?? 3,
        quality: pool.quality ?? 2,
        rogue: pool.rogue ?? 0,
        whale: pool.whale ?? 0,
        colluder: pool.colluder ?? 0,
        budget: pool.budget ?? 0,
        specialist: pool.specialist ?? 0,
        newcomer: pool.newcomer ?? 0,
        rogueSpam: pool.rogueSpam ?? 0,
        mm: pool.mm ?? 0,
        conservative: pool.conservative ?? 0,
        opportunist: pool.opportunist ?? 0,
        researcher: pool.researcher ?? 0,
      };
      // Ensure every missing style gets at least 1 agent seeded
      for (const style of missing) {
        const key = STYLE_TO_SEED_KEY[style];
        if (key && seedCounts[key] === 0) seedCounts[key] = 1;
      }
      console.log(
        `[runner] Pool missing [${missing.join(', ')}] for "${scenario.id}" — auto-seeding: ` +
        JSON.stringify(seedCounts),
      );
      try {
        await seedPersonas(seedCounts, { baseUrl, adminKey });
        agents = loadSimAgents();
      } catch (e: any) {
        throw new Error(
          `Auto-seed failed for "${scenario.id}": ${e.message}. ` +
          `Manually re-seed the pool with: ${missing.join(', ')}`,
        );
      }
      // Re-check after auto-seed
      const newPoolStyles = new Set(agents.map((a) => a.style));
      const stillMissing = scenario.requires.filter((s) => !newPoolStyles.has(s));
      if (stillMissing.length > 0) {
        throw new Error(
          `Auto-seed ran but pool is still missing: ${stillMissing.join(', ')}. ` +
          `Check persona templates for these styles.`,
        );
      }
    }
  }

  const narrator = new Narrator(sly);
  const baseline = opts.baseline ?? false;

  // In baseline mode, agents keep their diverse models (Sonnet, Gemini, etc.)
  // but lose all Sly infrastructure: no reputation, no dynamic pricing, no
  // buyer reputation context, no velocity limits awareness. The market has
  // real quality diversity but no SIGNAL to sort it — that's the lemon market.
  const processor = await makeProcessor(opts.mode as string);

  // Coerce raw params against the scenario's schema (drop unknowns,
  // clamp ranges, fall back to defaults).
  const params = resolveParams(scenario.params, opts.params);

  let stopped = false;
  const shouldStop = () => stopped;

  // Bookkeeping: mark this template as run (best-effort, doesn't block start)
  markRun(opts.scenarioId).catch(() => { /* noop */ });

  if (baseline) {
    console.log(`[runner] BASELINE mode — no reputation, no dynamic pricing, uniform model`);
  }

  // Pre-flight: drop any agent whose platform status isn't 'active' (e.g. a
  // previous run left one killed via the kill switch). Cheap admin calls,
  // parallel. Keeps the scenario block from wasting tick 0 on dead agents.
  const preflight = await Promise.all(
    agents.map(async (a) => {
      const rec = await sly.getAgent(a.agentId);
      return { agent: a, status: rec?.status ?? 'active' };
    }),
  );
  const deadAtStart = preflight.filter((p) => p.status !== 'active');
  if (deadAtStart.length > 0) {
    for (const d of deadAtStart) {
      console.log(`[runner] pre-flight: ${d.agent.name} is ${d.status}, excluding from run`);
      sly
        .milestone(`Pre-flight: ${d.agent.name} is ${d.status}, excluded from run`, {
          agentId: d.agent.agentId,
          agentName: d.agent.name,
          icon: '\u26a0',
        })
        .catch(() => {});
    }
    agents = agents.filter((a) => !deadAtStart.some((d) => d.agent.agentId === a.agentId));
    if (agents.length === 0) {
      throw new Error('Pre-flight left zero active agents — cannot run the scenario.');
    }
  }

  const done = scenario.run({
    sly,
    narrator,
    processor,
    agents,
    durationMs: opts.durationMs,
    params,
    shouldStop,
    baseline,
  });

  return {
    stop: () => {
      stopped = true;
    },
    done,
  };
}

/**
 * List the scenarios visible to this runner (for /scenarios endpoints).
 *
 * Returns the active markdown templates from the DB. The shape matches what
 * the viewer expects (id, name, description, requires, params, analyzerHints)
 * so the existing dropdown + param form code keeps working unchanged.
 *
 * Falls back to an empty list if Supabase isn't configured — the viewer will
 * just show "no real scenarios available" instead of crashing.
 */
export async function listScenarios(): Promise<
  Array<{ id: string; name: string; description: string; requires: unknown[]; params: unknown[]; analyzerHints?: string; pool?: PoolConfig }>
> {
  if (!isSupabaseConfigured()) return [];
  try {
    const templates = await listTemplates();
    const out: Array<{ id: string; name: string; description: string; requires: unknown[]; params: unknown[]; analyzerHints?: string; pool?: PoolConfig }> = [];
    for (const t of templates) {
      try {
        const scenario = buildScenarioFromTemplate(t);
        out.push({
          id: scenario.id,
          name: scenario.name,
          description: scenario.description,
          requires: scenario.requires,
          params: scenario.params || [],
          analyzerHints: scenario.analyzerHints,
          pool: scenario.pool,
        });
      } catch (e: any) {
        // A template that fails to compile (bad frontmatter, unknown block)
        // is just skipped from the list — surfaced via /templates instead.
        console.warn(`[runner] template "${t.template_id}" did not compile: ${e.message}`);
      }
    }
    return out;
  } catch (e: any) {
    console.warn(`[runner] failed to list templates: ${e.message}`);
    return [];
  }
}

/** Backwards-compat export. Exposes nothing useful — kept for callers that
 *  imported `SCENARIOS` directly. */
export const SCENARIOS: Record<string, ScenarioDefinition> = {};
