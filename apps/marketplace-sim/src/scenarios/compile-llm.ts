/**
 * compile-llm — Phase B compiler.
 *
 * Takes a markdown template + a known building block and asks Claude to
 * extract a structured `blockConfig` from the natural-language body.
 * The compiler is **schema-aware**: each building block has a JSON schema
 * we hand to Claude as a tool definition, so the model is forced to return
 * conforming output (no JSON-string parsing acrobatics).
 *
 * Phase A path is preserved: if no API key is set OR the body is empty, the
 * caller falls back to frontmatter-only compilation.
 *
 * Cost model:
 *   - One messages.create call per compile (~1k in / ~1k out for typical
 *     templates) using claude-sonnet-4-6 → ~$0.018 per compile.
 *   - Hard cap from COMPILE_BUDGET_USD_CAP env (default $1) — we refuse to
 *     even start a call if the cumulative session cost is over the cap.
 */

import Anthropic from '@anthropic-ai/sdk';
import { parseFrontmatter } from './markdown-engine.js';
import type { KnownBlock } from './markdown-engine.js';

const MODEL = process.env.COMPILE_MODEL || 'claude-sonnet-4-6';

// Match the pricing table in anthropic-api.ts so cost reporting stays
// consistent across the sim.
const PRICING: Record<string, { inputPerM: number; outputPerM: number }> = {
  'claude-haiku-4-5-20251001': { inputPerM: 1.0, outputPerM: 5.0 },
  'claude-sonnet-4-6': { inputPerM: 3.0, outputPerM: 15.0 },
  'claude-opus-4-6': { inputPerM: 15.0, outputPerM: 75.0 },
};

// Module-level running total so the budget cap survives across multiple
// compile calls within a single sim sidecar process.
let cumulativeCostUsd = 0;

export interface CompileLlmResult {
  /** Extracted blockConfig (the structured config the runner needs) */
  blockConfig: Record<string, unknown>;
  /** Per-call cost — added to the cumulative session total */
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  /** Soft warnings emitted during extraction */
  warnings: Array<{ severity: 'warn' | 'error'; message: string; source?: string }>;
  /** True if the LLM was actually invoked (false if we short-circuited) */
  invoked: boolean;
}

export class CompileBudgetExceededError extends Error {
  constructor(public spent: number, public cap: number) {
    super(`Compile budget cap exceeded: spent $${spent.toFixed(4)} >= cap $${cap.toFixed(2)}`);
    this.name = 'CompileBudgetExceededError';
  }
}

/** Returns the LLM session's cumulative cost so far. */
export function getCompileSessionCost(): number {
  return cumulativeCostUsd;
}

/** Reset the cumulative cost counter — used by tests. */
export function resetCompileSessionCost(): void {
  cumulativeCostUsd = 0;
}

/** True if an Anthropic API key is configured. */
export function isLlmCompileAvailable(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

/**
 * Decide whether the markdown body has enough natural-language content to
 * make an LLM compile worthwhile. If the body is just whitespace or a single
 * heading, fall back to frontmatter-only.
 */
export function bodyHasSubstance(markdown: string): boolean {
  const { body } = parseFrontmatter(markdown);
  // Strip headings and whitespace, count what's left.
  const content = body
    .replace(/^#{1,6}\s+.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  return content.length >= 80;
}

/**
 * Tool schemas — one per known building block. Claude is required to call
 * the matching tool, so the result is guaranteed to fit the runner's shape.
 */
function toolForBlock(block: KnownBlock): Anthropic.Tool {
  if (block === 'bake_off') {
    return {
      name: 'set_bake_off_config',
      description:
        'Emit the structured blockConfig for a bake_off scenario. Read the markdown body to figure out what skills the buyer is shopping for, what concrete briefs to use, the auction mode, and any defaults the author specified.',
      input_schema: {
        type: 'object',
        properties: {
          skills: {
            type: 'array',
            description:
              'List of skills the buyer can request. Each skill needs an id, a fixed price in USDC, and at least 2 concrete briefs that the buyer might send. Briefs should be substantive (sentence or paragraph), not labels.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'snake_case skill id, e.g. "code_review"' },
                price: { type: 'number', description: 'Listed price per trade in USDC, > 0' },
                briefs: {
                  type: 'array',
                  description: 'Concrete request strings the buyer can send. 2-6 entries.',
                  items: { type: 'string' },
                  minItems: 2,
                },
                priceVariance: {
                  type: 'number',
                  description:
                    'Optional ± USDC variance applied per bid. Only set when the markdown describes a reverse-auction or price-discovery scenario where sellers should bid different amounts. Default 0 (every seller bids the listed price).',
                },
              },
              required: ['id', 'price', 'briefs'],
            },
            minItems: 1,
          },
          auctionMode: {
            type: 'string',
            enum: ['highest_score', 'lowest_price'],
            description:
              'How the buyer picks the winner. Use "highest_score" (the LLM judge\'s rubric wins) for normal competitive review. Use "lowest_price" for reverse-auction scenarios where the cheapest acceptable bid should win — and remember to set priceVariance on the skill so prices actually differ.',
          },
          pricingMode: {
            type: 'string',
            enum: ['static', 'dynamic'],
            description:
              'Pricing mode. "static" (default) = prices stay fixed. "dynamic" = agents adjust prices each cycle based on reputation + win rate. Only use dynamic when the markdown explicitly describes price adaptation, reputation-aware pricing, or market convergence.',
          },
          dynamicPricing: {
            type: 'object',
            description: 'Tuning for dynamic pricing. Only include when pricingMode=dynamic.',
            properties: {
              adjustmentRate: { type: 'number', description: 'Fraction to adjust per cycle (e.g. 0.05 = 5%). Default 0.05.' },
              minMultiplier: { type: 'number', description: 'Floor relative to base price (e.g. 0.5 = 50%). Default 0.5.' },
              maxMultiplier: { type: 'number', description: 'Ceiling relative to base price (e.g. 1.5 = 150%). Default 1.5.' },
              checkReputationEvery: { type: 'number', description: 'Cycles between reputation API calls. Default 3.' },
            },
          },
          defaults: {
            type: 'object',
            description:
              'Optional default values for the per-run knobs. Only include keys explicitly mentioned in the markdown.',
            properties: {
              sellersPerCycle: { type: 'number' },
              cycleSleepMs: { type: 'number' },
              styleFilter: {
                type: 'array',
                items: { type: 'string' },
                description: 'Single style list applied to BOTH buyer and seller pools. Use this when the markdown does not distinguish buyer/seller roles.',
              },
              buyerStyleFilter: {
                type: 'array',
                items: { type: 'string' },
                description: 'When the markdown specifies that buyers must come from a specific persona set (e.g. whales), set this. Takes precedence over styleFilter for the buyer pool.',
              },
              sellerStyleFilter: {
                type: 'array',
                items: { type: 'string' },
                description: 'When the markdown specifies that sellers must come from a specific persona set, set this. Takes precedence over styleFilter for the seller pool.',
              },
            },
          },
        },
        required: ['skills'],
      },
    };
  }
  if (block === 'ring_trade') {
    return {
      name: 'set_ring_trade_config',
      description:
        'Emit the structured blockConfig for a ring_trade (circular collusion) scenario. Read the markdown body to identify the per-trade price, briefs, rating inflation amount, and camouflage parameters.',
      input_schema: {
        type: 'object',
        properties: {
          pricePerTrade: { type: 'number', description: 'Per-trade price in USDC. > 0.' },
          briefs: {
            type: 'array',
            description: 'Concrete request strings rotated through the ring. 3-6 entries.',
            items: { type: 'string' },
            minItems: 3,
          },
          ratingInflation: {
            type: 'number',
            description: 'Bonus score (0-30) added to colluder↔colluder ratings. 0 = honest baseline.',
          },
          defaults: {
            type: 'object',
            properties: {
              cycleSleepMs: { type: 'number' },
              camouflageEvery: { type: 'number', description: 'Insert a non-adjacent noise trade every N cycles. 0 = off.' },
              styleFilter: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        required: ['pricePerTrade', 'briefs'],
      },
    };
  }
  if (block === 'multi_hop') {
    return {
      name: 'set_multi_hop_config',
      description:
        'Emit the structured blockConfig for a multi_hop (chain trade) scenario. Read the markdown body to identify chain length, base price, margin per hop, briefs, and demand shock parameters.',
      input_schema: {
        type: 'object',
        properties: {
          chainLength: { type: 'number', description: 'Number of hops in the chain. >= 2.' },
          basePrice: { type: 'number', description: 'Price the initiator pays for hop 1. > 0.' },
          marginPerHop: {
            type: 'number',
            description: 'Fraction (0-1) each intermediary takes as margin. E.g. 0.15 = 15% margin per hop.',
          },
          briefs: {
            type: 'array',
            description: 'Concrete request strings rotated through cycles. 3-6 entries.',
            items: { type: 'string' },
            minItems: 3,
          },
          defaults: {
            type: 'object',
            properties: {
              cycleSleepMs: { type: 'number' },
              demandShockEvery: { type: 'number', description: 'Double the base price every N cycles. 0 = off.' },
              styleFilter: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        required: ['chainLength', 'basePrice', 'marginPerHop', 'briefs'],
      },
    };
  }
  if (block === 'double_auction') {
    return {
      name: 'set_double_auction_config',
      description:
        'Emit the structured blockConfig for a double_auction (full marketplace) scenario. N buyers and M sellers each cycle, bidirectional reputation, dynamic pricing, agent exit.',
      input_schema: {
        type: 'object',
        properties: {
          buyersPerCycle: { type: 'number', description: 'Number of buyers posting tasks each cycle. Default 3.' },
          sellersPerTask: { type: 'number', description: 'Number of sellers that can bid on each task. Default 4.' },
          basePrice: { type: 'number', description: 'Starting price in USDC. > 0.' },
          exitThreshold: { type: 'number', description: 'Cumulative P&L loss at which an agent exits. Default -10.' },
          briefs: {
            type: 'array',
            description: 'Task descriptions rotated through cycles. 5-10 substantive entries.',
            items: { type: 'string' },
            minItems: 5,
          },
          pricingMode: { type: 'string', enum: ['static', 'dynamic'] },
          dynamicPricing: {
            type: 'object',
            properties: {
              adjustmentRate: { type: 'number' },
              minMultiplier: { type: 'number' },
              maxMultiplier: { type: 'number' },
              checkReputationEvery: { type: 'number' },
            },
          },
          defaults: {
            type: 'object',
            properties: {
              cycleSleepMs: { type: 'number' },
              styleFilter: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        required: ['buyersPerCycle', 'sellersPerTask', 'basePrice', 'briefs'],
      },
    };
  }
  // one_to_one
  return {
    name: 'set_one_to_one_config',
    description:
      'Emit the structured blockConfig for a one_to_one (1:1 trade) scenario. Read the markdown body to figure out the per-cycle price and what the honest baseline requests should look like.',
    input_schema: {
      type: 'object',
      properties: {
        pricePerCycle: {
          type: 'number',
          description: 'Per-trade price in USDC. > 0.',
        },
        honestRequests: {
          type: 'array',
          description:
            'Concrete brief strings the honest buyer rotates through. 3-6 substantive requests, not labels.',
          items: { type: 'string' },
          minItems: 3,
        },
        defaults: {
          type: 'object',
          description: 'Optional defaults for runtime knobs. Only include keys mentioned in the markdown.',
          properties: {
            rogueCycleEvery: { type: 'number' },
            cycleSleepMs: { type: 'number' },
            honestStyles: { type: 'array', items: { type: 'string' } },
            rogueStyles: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      required: ['pricePerCycle', 'honestRequests'],
    },
  };
}

const SYSTEM_PROMPT = `You are a scenario-config compiler for an agentic-marketplace simulation.

You will be given a markdown document describing a scenario. The frontmatter is a YAML block at the top — that block has already been parsed and is supplied for context. Your job is to read the natural-language **body** of the document and extract a structured configuration object that the simulation runner can execute.

Rules:
1. Call the provided tool exactly once. Do not write any prose response.
2. Use the markdown BODY as the source of truth for skills, briefs, prices, and defaults — not the frontmatter. The frontmatter is only there so you don't have to re-derive obvious metadata.
3. Briefs must be SUBSTANTIVE — the kinds of concrete questions a real buyer would send. Multi-sentence is fine. Never emit labels or placeholders like "Brief 1".
4. If the markdown only specifies a TYPE of work (e.g. "code review") without giving sample briefs, invent 3-5 plausible briefs in that domain. Make them vary in shape so the simulation has variety.
5. If a price isn't specified, default to 1.0 USDC.
6. Do not invent skills/requests that aren't suggested by the markdown. Stay grounded in what the author actually wrote.
7. Do not include "defaults" keys unless the markdown explicitly mentions a default value for them.`;

/**
 * Compile a markdown template via Claude. Throws CompileBudgetExceededError
 * when the cumulative session cost has reached the cap. Other errors bubble up
 * so the caller can log them and fall back to frontmatter-only.
 */
export async function compileWithLlm(
  markdown: string,
  buildingBlock: KnownBlock,
): Promise<CompileLlmResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('compile-llm: ANTHROPIC_API_KEY not set');
  }

  const cap = parseFloat(process.env.COMPILE_BUDGET_USD_CAP || '1.0');
  if (cumulativeCostUsd >= cap) {
    throw new CompileBudgetExceededError(cumulativeCostUsd, cap);
  }

  const { frontmatter, body } = parseFrontmatter(markdown);
  const tool = toolForBlock(buildingBlock);

  const userPrompt = `Building block: ${buildingBlock}

Frontmatter (already parsed, for context only):
\`\`\`json
${JSON.stringify(frontmatter, null, 2)}
\`\`\`

Markdown body (the source of truth — extract config from here):
<<<
${body}
>>>

Call ${tool.name} with the extracted configuration.`;

  const client = new Anthropic({ apiKey });
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 4000,
    system: SYSTEM_PROMPT,
    tools: [tool],
    tool_choice: { type: 'tool', name: tool.name },
    messages: [{ role: 'user', content: userPrompt }],
  });

  // Cost tracking
  const inputTokens = res.usage?.input_tokens || 0;
  const outputTokens = res.usage?.output_tokens || 0;
  const pricing = PRICING[MODEL] || { inputPerM: 3, outputPerM: 15 };
  const costUsd =
    (inputTokens / 1_000_000) * pricing.inputPerM + (outputTokens / 1_000_000) * pricing.outputPerM;
  cumulativeCostUsd += costUsd;

  const warnings: CompileLlmResult['warnings'] = [];

  // Pull the tool_use block (we forced tool_choice so it must be there)
  const toolUse = res.content.find((c): c is Anthropic.ToolUseBlock => c.type === 'tool_use');
  if (!toolUse) {
    warnings.push({
      severity: 'error',
      message: 'LLM did not call the expected tool — falling back to frontmatter',
      source: 'llm',
    });
    return { blockConfig: {}, costUsd, inputTokens, outputTokens, warnings, invoked: true };
  }

  const blockConfig = (toolUse.input as Record<string, unknown>) || {};

  // Sanity-check the shape against the building block (defensive — the tool
  // schema should already enforce this, but the model occasionally returns
  // empty arrays or stub values).
  if (buildingBlock === 'bake_off') {
    const skills = blockConfig.skills as Array<{ id?: string; briefs?: string[] }> | undefined;
    if (!Array.isArray(skills) || skills.length === 0) {
      warnings.push({ severity: 'error', message: 'LLM returned no skills', source: 'llm' });
    } else {
      for (const s of skills) {
        if (!s.id || !Array.isArray(s.briefs) || s.briefs.length < 2) {
          warnings.push({
            severity: 'warn',
            message: `Skill "${s.id || '?'}" has fewer than 2 briefs`,
            source: 'llm',
          });
        }
      }
    }
  } else if (buildingBlock === 'one_to_one') {
    const reqs = blockConfig.honestRequests as string[] | undefined;
    if (!Array.isArray(reqs) || reqs.length < 3) {
      warnings.push({
        severity: 'warn',
        message: 'LLM returned fewer than 3 honest requests',
        source: 'llm',
      });
    }
    if (typeof blockConfig.pricePerCycle !== 'number' || (blockConfig.pricePerCycle as number) <= 0) {
      warnings.push({
        severity: 'error',
        message: 'LLM returned invalid pricePerCycle',
        source: 'llm',
      });
    }
  } else if (buildingBlock === 'ring_trade') {
    const briefs = blockConfig.briefs as string[] | undefined;
    if (!Array.isArray(briefs) || briefs.length < 3) {
      warnings.push({ severity: 'warn', message: 'LLM returned fewer than 3 briefs for ring_trade', source: 'llm' });
    }
    if (typeof blockConfig.pricePerTrade !== 'number' || (blockConfig.pricePerTrade as number) <= 0) {
      warnings.push({ severity: 'error', message: 'LLM returned invalid pricePerTrade', source: 'llm' });
    }
  } else if (buildingBlock === 'multi_hop') {
    const briefs = blockConfig.briefs as string[] | undefined;
    if (!Array.isArray(briefs) || briefs.length < 3) {
      warnings.push({ severity: 'warn', message: 'LLM returned fewer than 3 briefs for multi_hop', source: 'llm' });
    }
    if (typeof blockConfig.chainLength !== 'number' || (blockConfig.chainLength as number) < 2) {
      warnings.push({ severity: 'error', message: 'LLM returned invalid chainLength (must be >= 2)', source: 'llm' });
    }
    if (typeof blockConfig.basePrice !== 'number' || (blockConfig.basePrice as number) <= 0) {
      warnings.push({ severity: 'error', message: 'LLM returned invalid basePrice', source: 'llm' });
    }
  }

  return { blockConfig, costUsd, inputTokens, outputTokens, warnings, invoked: true };
}
