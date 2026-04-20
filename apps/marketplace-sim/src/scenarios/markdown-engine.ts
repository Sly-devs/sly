/**
 * Markdown engine — turns a stored scenario template into a runnable
 * ScenarioDefinition.
 *
 * In Phase A the engine reads everything it needs from the YAML frontmatter:
 *   ---
 *   id: my_scenario
 *   name: My Scenario
 *   buildingBlock: bake_off
 *   requires: [honest, quality-reviewer]
 *   params: [...]               # ParamSpec[] — same shape as TS scenarios
 *   analyzerHints: |             # multi-line string
 *     ...
 *   blockConfig:                 # block-specific config (e.g. BakeOffConfig)
 *     skills: [...]
 *     defaults: { ... }
 *   ---
 *
 *   # Free-form documentation body — humans read this, the LLM compiler in
 *   # Phase B will read this to populate `blockConfig` from natural language.
 *
 * In Phase B the LLM compile step extracts blockConfig (and any other
 * structured fields) from the body and writes them into the `compiled` jsonb
 * column. The runner prefers `compiled` if present, falls back to frontmatter.
 */

import yaml from 'js-yaml';
import type { ScenarioDefinition, ScenarioContext, ScenarioResult, ParamSpec, PoolConfig } from './types.js';
import type { PersonaStyle } from '../processors/types.js';
import { runBakeOff, type BakeOffConfig } from './blocks/bake_off.js';
import { runMerchantBuy, type MerchantBuyConfig } from './blocks/merchant_buy.js';
import { runConcierge, type ConciergeConfig } from './blocks/concierge.js';
import { runResaleChain, type ResaleChainConfig } from './blocks/resale_chain.js';
import { runMerchantComparison, type MerchantComparisonConfig } from './blocks/merchant_comparison.js';
import { runOneToOne, type OneToOneConfig } from './blocks/one_to_one.js';
import { runRingTrade, type RingTradeConfig } from './blocks/ring_trade.js';
import { runMultiHop, type MultiHopConfig } from './blocks/multi_hop.js';
import { runDoubleAuction, type DoubleAuctionConfig } from './blocks/double_auction.js';
import type { TemplateRow } from '../templates/store.js';

/** Building blocks the engine knows how to dispatch. */
export const KNOWN_BLOCKS = ['bake_off', 'one_to_one', 'ring_trade', 'multi_hop', 'double_auction', 'merchant_buy', 'concierge', 'resale_chain', 'merchant_comparison'] as const;
export type KnownBlock = typeof KNOWN_BLOCKS[number];

export function isKnownBlock(s: string | null | undefined): s is KnownBlock {
  return !!s && (KNOWN_BLOCKS as readonly string[]).includes(s);
}

/**
 * Parse YAML frontmatter from a markdown document.
 * Returns { frontmatter, body }. If there is no frontmatter the whole input
 * is treated as body and frontmatter is the empty object.
 */
function parseFrontmatter(md: string): { frontmatter: Record<string, unknown>; body: string } {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { frontmatter: {}, body: md };
  const yamlText = m[1];
  const body = m[2] || '';
  try {
    const parsed = yaml.load(yamlText, { schema: yaml.JSON_SCHEMA }) as Record<string, unknown> | null;
    return { frontmatter: parsed || {}, body };
  } catch (e) {
    throw new Error(`Failed to parse YAML frontmatter: ${(e as Error).message}`);
  }
}

/**
 * Build a runnable ScenarioDefinition from a stored template row.
 *
 * In Phase A: reads everything from the frontmatter (`buildingBlock`,
 * `params`, `analyzerHints`, `blockConfig`).
 * In Phase B: prefers `template.compiled` (LLM-generated) over the
 * frontmatter for `blockConfig` and `params`.
 *
 * Throws if the buildingBlock is unknown or the config is invalid.
 */
export function buildScenarioFromTemplate(template: TemplateRow): ScenarioDefinition {
  const { frontmatter } = parseFrontmatter(template.markdown);

  // Compiled config (Phase B) wins over frontmatter when present.
  const compiled = (template.compiled || {}) as Record<string, unknown>;
  const buildingBlock =
    (compiled.buildingBlock as string) || (frontmatter.buildingBlock as string) || template.building_block || '';
  const requires =
    (compiled.requires as PersonaStyle[]) || (frontmatter.requires as PersonaStyle[]) || [];
  const params = (compiled.params as ParamSpec[]) || (frontmatter.params as ParamSpec[]) || [];
  // Frontmatter hints take priority — they're the source-of-truth that the
  // user edits directly. Compiled hints are a stale copy from compile-time.
  const analyzerHints = (frontmatter.analyzerHints as string) || (compiled.analyzerHints as string) || undefined;
  const pool = (compiled.pool as PoolConfig) || (frontmatter.pool as PoolConfig) || undefined;
  // Merge blockConfig: use compiled as base, but override briefs from frontmatter
  // if they contain structured objects (e.g. SkillBrief with skill_id).
  // The LLM compiler flattens YAML objects into plain strings, losing structure.
  const compiledBC = (compiled.blockConfig as Record<string, unknown>) || {};
  const frontmatterBC = (frontmatter.blockConfig as Record<string, unknown>) || {};
  const blockConfig = Object.keys(compiledBC).length > 0
    ? { ...compiledBC }
    : { ...frontmatterBC };
  // Prefer frontmatter briefs when they contain objects (skill-aware format)
  const fmBriefs = frontmatterBC.briefs as unknown[];
  if (Array.isArray(fmBriefs) && fmBriefs.length > 0 && typeof fmBriefs[0] === 'object') {
    blockConfig.briefs = fmBriefs;
  } else if (!blockConfig.briefs && Array.isArray(fmBriefs)) {
    blockConfig.briefs = fmBriefs;
  }

  if (!buildingBlock) {
    throw new Error(
      `Template "${template.template_id}" has no buildingBlock. Add "buildingBlock: bake_off" to the frontmatter.`,
    );
  }

  // Dispatch table — extend for broadcast, etc.
  const runner = (ctx: ScenarioContext): Promise<ScenarioResult> => {
    switch (buildingBlock) {
      case 'bake_off':
        return runBakeOff(ctx, {
          scenarioId: template.template_id,
          config: blockConfig as unknown as BakeOffConfig,
        });
      case 'one_to_one':
        return runOneToOne(ctx, {
          scenarioId: template.template_id,
          config: blockConfig as unknown as OneToOneConfig,
        });
      case 'ring_trade':
        return runRingTrade(ctx, {
          scenarioId: template.template_id,
          config: blockConfig as unknown as RingTradeConfig,
        });
      case 'multi_hop':
        return runMultiHop(ctx, {
          scenarioId: template.template_id,
          config: blockConfig as unknown as MultiHopConfig,
        });
      case 'double_auction':
        return runDoubleAuction(ctx, {
          scenarioId: template.template_id,
          config: blockConfig as unknown as DoubleAuctionConfig,
        });
      case 'merchant_buy':
        return runMerchantBuy(ctx, {
          scenarioId: template.template_id,
          config: blockConfig as unknown as MerchantBuyConfig,
        });
      case 'concierge':
        return runConcierge(ctx, {
          scenarioId: template.template_id,
          config: blockConfig as unknown as ConciergeConfig,
        });
      case 'resale_chain':
        return runResaleChain(ctx, {
          scenarioId: template.template_id,
          config: blockConfig as unknown as ResaleChainConfig,
        });
      case 'merchant_comparison':
        return runMerchantComparison(ctx, {
          scenarioId: template.template_id,
          config: blockConfig as unknown as MerchantComparisonConfig,
        });
      default:
        throw new Error(
          `Template "${template.template_id}" uses unknown buildingBlock "${buildingBlock}". Available: ${KNOWN_BLOCKS.join(', ')}`,
        );
    }
  };

  return {
    id: template.template_id,
    name: template.name,
    description: extractDescription(template.markdown),
    requires,
    params,
    analyzerHints,
    pool,
    run: runner,
  };
}

/**
 * Pull the first paragraph after the H1 (or just the first paragraph) as
 * the human-readable description shown in the viewer dropdown.
 */
function extractDescription(md: string): string {
  const { body } = parseFrontmatter(md);
  // Strip H1 if present
  const stripped = body.replace(/^#\s+.*\n+/, '');
  // First non-empty paragraph
  const para = stripped
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p.length > 0 && !p.startsWith('#'));
  if (!para) return '';
  // Strip markdown formatting characters and collapse whitespace
  return para
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 300)
    .trim();
}

/**
 * Run the building block in dry-run mode (no network, no LLM, one cycle).
 * Used by Phase B's compile validator.
 */
export async function dryRunTemplate(template: TemplateRow, ctx: ScenarioContext): Promise<void> {
  const { frontmatter } = parseFrontmatter(template.markdown);
  const buildingBlock = (frontmatter.buildingBlock as string) || template.building_block || '';
  const blockConfig = (frontmatter.blockConfig as Record<string, unknown>) || {};
  switch (buildingBlock) {
    case 'bake_off':
      await runBakeOff(ctx, {
        scenarioId: template.template_id,
        config: blockConfig as unknown as BakeOffConfig,
        dryRun: true,
      });
      return;
    case 'one_to_one':
      await runOneToOne(ctx, {
        scenarioId: template.template_id,
        config: blockConfig as unknown as OneToOneConfig,
        dryRun: true,
      });
      return;
    case 'ring_trade':
      await runRingTrade(ctx, {
        scenarioId: template.template_id,
        config: blockConfig as unknown as RingTradeConfig,
        dryRun: true,
      });
      return;
    case 'multi_hop':
      await runMultiHop(ctx, {
        scenarioId: template.template_id,
        config: blockConfig as unknown as MultiHopConfig,
        dryRun: true,
      });
      return;
    case 'double_auction':
      await runDoubleAuction(ctx, {
        scenarioId: template.template_id,
        config: blockConfig as unknown as DoubleAuctionConfig,
        dryRun: true,
      });
      return;
    case 'merchant_buy':
      await runMerchantBuy(ctx, {
        scenarioId: template.template_id,
        config: blockConfig as unknown as MerchantBuyConfig,
        dryRun: true,
      });
      return;
    case 'concierge':
      await runConcierge(ctx, {
        scenarioId: template.template_id,
        config: blockConfig as unknown as ConciergeConfig,
        dryRun: true,
      });
      return;
    case 'resale_chain':
      await runResaleChain(ctx, {
        scenarioId: template.template_id,
        config: blockConfig as unknown as ResaleChainConfig,
        dryRun: true,
      });
      return;
    case 'merchant_comparison':
      await runMerchantComparison(ctx, {
        scenarioId: template.template_id,
        config: blockConfig as unknown as MerchantComparisonConfig,
        dryRun: true,
      });
      return;
    default:
      throw new Error(`dryRun: unknown buildingBlock "${buildingBlock}"`);
  }
}

// Exported for tests / introspection
export { parseFrontmatter };
