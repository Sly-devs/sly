import type { Narrator } from '../narrator.js';
import type { PersonaStyle, SimAgent, TaskProcessor } from '../processors/types.js';
import type { SlyClient } from '../sly-client.js';

/**
 * Scenario parameter spec — drives the form rendering in the viewer and the
 * runtime values handed to the scenario via ctx.params. Per-run knobs only;
 * pool composition is a separate seed-time concern.
 */
export type ParamSpec =
  | {
      key: string;
      type: 'int';
      label: string;
      help?: string;
      default: number;
      min?: number;
      max?: number;
      step?: number;
    }
  | {
      key: string;
      type: 'bool';
      label: string;
      help?: string;
      default: boolean;
    }
  | {
      key: string;
      type: 'enum';
      label: string;
      help?: string;
      default: string;
      options: Array<{ value: string; label: string }>;
    }
  | {
      key: string;
      type: 'multi';
      label: string;
      help?: string;
      default: string[];
      options: Array<{ value: string; label: string }>;
    };

export interface ScenarioContext {
  sly: SlyClient;
  narrator: Narrator;
  processor: TaskProcessor;
  /** Full pool of seeded agents available to the scenario */
  agents: SimAgent[];
  durationMs: number;
  /** Per-run parameters — keyed by ParamSpec.key. Pre-validated against the schema. */
  params: Record<string, unknown>;
  /** Called each cycle — scenarios should check and exit cleanly */
  shouldStop: () => boolean;
  /**
   * Baseline mode: disables all Sly infrastructure layers to simulate a raw
   * market without platform protections. Agents keep their diverse models
   * (different capabilities exist) but lose all SIGNAL to sort quality:
   *   - No reputation checks or context injection (buyers are blind to history)
   *   - No dynamic pricing (agents can't adapt to market signals)
   *   - No buyer pre-filtering by reputation (random selection)
   *   - No seller self-awareness of reputation (no effort adaptation)
   * This is the "before Sly" condition for empirical comparison.
   */
  baseline?: boolean;
}

/** Ideal pool composition for auto-seeding. Keys are template IDs (honest-trader, quality-reviewer, etc.) or shorthand (honest, quality, rogue, whale). */
export interface PoolConfig {
  honest?: number;
  quality?: number;
  rogue?: number;
  whale?: number;
  colluder?: number;
  budget?: number;
  specialist?: number;
  newcomer?: number;
  rogueSpam?: number;
  mm?: number;
  conservative?: number;
  opportunist?: number;
  researcher?: number;
}

export interface ScenarioDefinition {
  id: string;
  name: string;
  description: string;
  /** Minimum styles the scenario needs in the agent pool */
  requires: PersonaStyle[];
  /** Optional per-run param schema — empty/missing = scenario takes no knobs */
  params?: ParamSpec[];
  /**
   * Optional notes for the LLM report analyzer. Each scenario uses this to
   * tell the analyzer what is INTENTIONAL about its design (e.g. "this is 1:1
   * by design, no bake-offs expected") so the LLM doesn't flag normal behavior
   * as a bug. Surfaced through /scenarios and prepended to the analyzer prompt.
   */
  analyzerHints?: string;
  /**
   * Ideal pool composition for this scenario. When present, the runner will
   * auto-seed the pool to match before starting if the current pool doesn't
   * satisfy `requires`.
   */
  pool?: PoolConfig;
  run(ctx: ScenarioContext): Promise<ScenarioResult>;
}

/**
 * Coerce a raw params dict (from JSON / form input) against a schema.
 * Unknown keys are dropped, missing keys get defaults, types are normalized.
 */
export function resolveParams(
  schema: ParamSpec[] | undefined,
  raw: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!schema) return out;
  const input = raw || {};
  for (const spec of schema) {
    const v = input[spec.key];
    switch (spec.type) {
      case 'int': {
        const n = typeof v === 'number' ? v : v != null ? parseInt(String(v), 10) : NaN;
        let val = Number.isFinite(n) ? n : spec.default;
        if (spec.min !== undefined && val < spec.min) val = spec.min;
        if (spec.max !== undefined && val > spec.max) val = spec.max;
        out[spec.key] = val;
        break;
      }
      case 'bool': {
        out[spec.key] = typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : spec.default;
        break;
      }
      case 'enum': {
        const allowed = new Set(spec.options.map((o) => o.value));
        out[spec.key] = typeof v === 'string' && allowed.has(v) ? v : spec.default;
        break;
      }
      case 'multi': {
        const allowed = new Set(spec.options.map((o) => o.value));
        const arr = Array.isArray(v) ? v.filter((x) => typeof x === 'string' && allowed.has(x)) : null;
        out[spec.key] = arr && arr.length > 0 ? arr : spec.default;
        break;
      }
    }
  }
  return out;
}

export interface ScenarioResult {
  completedTrades: number;
  totalVolume: number;
  findings: string[];
}
