/**
 * OpenRouterProcessor — multi-model task processing via OpenRouter.
 *
 * Uses the OpenAI-compatible chat completions API (POST /api/v1/chat/completions)
 * with per-persona model routing. This lets the sim test a variety of LLM
 * backends (Gemini, Mistral, DeepSeek, GPT-4o-mini, Qwen, Llama, etc.)
 * so agents genuinely differ in capability — not just prompt wrappers over
 * the same model.
 *
 * The model-per-style mapping is configurable:
 *   - quality-reviewer → a premium model (GPT-4o, Claude Sonnet via OR, etc.)
 *   - honest           → a mid-tier model (Gemini Flash, Mistral Small, etc.)
 *   - rogue            → a cheap/small model (GPT-4o-mini, DeepSeek, etc.)
 *   - whale            → same as quality-reviewer (premium buyer)
 *
 * Shares the same TaskProcessor interface as AnthropicApiProcessor so the
 * runner can switch between them via --mode flag or env config.
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  BuyerDecision,
  BuyerIntent,
  BuyerEvaluation,
  PersonaLike,
  ProviderDecision,
  TaskContext,
  TaskProcessor,
  ProcessorUsage,
} from './types.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * Default model assignments per persona style. Override via
 * OPENROUTER_MODEL_<STYLE> env vars (e.g. OPENROUTER_MODEL_HONEST=...).
 *
 * All entries are paid models with stable upstreams so the sim doesn't
 * stall on shared-key rate limits. We previously routed 'honest' (and the
 * 4 personas that share its style) through `google/gemini-2.0-flash-001`,
 * which is dirt-cheap but goes through OpenRouter's shared upstream Google
 * key — that pool gets 429'd regularly and credits don't help (the error
 * even tells you "add your own key"). Switched to claude-3.5-haiku, which
 * is a paid Anthropic route with predictable QPS headroom.
 */
const DEFAULT_MODELS: Record<string, string> = {
  'quality-reviewer': 'anthropic/claude-sonnet-4',
  'whale': 'anthropic/claude-sonnet-4',
  // honest absorbs honest-trader / budget-trader / newcomer / opportunist —
  // a single paid Anthropic route keeps the sim's largest persona cohort
  // unblocked when free-tier upstreams (Gemini) saturate.
  'honest': 'anthropic/claude-3.5-haiku',
  'rogue-disputer': 'openai/gpt-4o-mini',
  'rogue-spam': 'deepseek/deepseek-chat-v3-0324',
  'colluder': 'mistralai/mistral-small-3.1-24b-instruct',
  'mm': 'qwen/qwen-2.5-72b-instruct',
};

// Rough pricing per million tokens (from OpenRouter pricing page).
// Used for budget tracking, not billing.
// When routed through the native Anthropic SDK, we use Anthropic's direct
// pricing (no OpenRouter markup). Same price keys work for both paths.
const PRICING: Record<string, { inputPerM: number; outputPerM: number }> = {
  'anthropic/claude-sonnet-4': { inputPerM: 3.0, outputPerM: 15.0 },
  'anthropic/claude-3.5-haiku': { inputPerM: 0.8, outputPerM: 4.0 },
  'google/gemini-2.0-flash-001': { inputPerM: 0.1, outputPerM: 0.4 },
  'openai/gpt-4o-mini': { inputPerM: 0.15, outputPerM: 0.6 },
  'deepseek/deepseek-chat-v3-0324': { inputPerM: 0.14, outputPerM: 0.28 },
  'mistralai/mistral-small-3.1-24b-instruct': { inputPerM: 0.1, outputPerM: 0.3 },
  'qwen/qwen-2.5-72b-instruct': { inputPerM: 0.18, outputPerM: 0.18 },
};

export interface OpenRouterProcessorOptions {
  apiKey?: string;
  budgetUsdCap?: number;
  maxTokens?: number;
  /** Override model for a specific style: { 'honest': 'google/gemini-flash', ... } */
  modelOverrides?: Record<string, string>;
}

export class OpenRouterProcessor implements TaskProcessor {
  name = 'openrouter';

  private apiKey: string;
  private anthropicClient: Anthropic | null = null;
  private budgetCap: number;
  private maxTokens: number;
  private models: Record<string, string>;
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private totalCostUsd = 0;

  constructor(opts: OpenRouterProcessorOptions = {}) {
    const key = opts.apiKey || process.env.OPENROUTER_API_KEY;
    if (!key) {
      throw new Error(
        'OPENROUTER_API_KEY missing. Set it in apps/marketplace-sim/.env.',
      );
    }
    this.apiKey = key;
    this.budgetCap = opts.budgetUsdCap ?? 5;
    this.maxTokens = opts.maxTokens ?? 500;
    // Merge env overrides → constructor overrides → defaults
    this.models = { ...DEFAULT_MODELS };
    for (const [style, model] of Object.entries(opts.modelOverrides || {})) {
      this.models[style] = model;
    }
    // Check env: OPENROUTER_MODEL_HONEST, OPENROUTER_MODEL_QUALITY_REVIEWER, etc.
    for (const style of Object.keys(DEFAULT_MODELS)) {
      const envKey = `OPENROUTER_MODEL_${style.replace(/-/g, '_').toUpperCase()}`;
      if (process.env[envKey]) this.models[style] = process.env[envKey]!;
    }
    // Create an Anthropic client for direct routing of anthropic/* models.
    // Skips the OpenRouter proxy → lower latency, no markup, same quality.
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (anthropicKey) {
      this.anthropicClient = new Anthropic({ apiKey: anthropicKey });
    }
  }

  getTotalUsage(): ProcessorUsage {
    return {
      inputTokens: this.totalInputTokens,
      outputTokens: this.totalOutputTokens,
      costUsd: this.totalCostUsd,
    };
  }

  private resolveModel(persona: PersonaLike): string {
    return this.models[persona.style] || this.models['honest'] || 'google/gemini-2.0-flash-001';
  }

  private overBudget(): boolean {
    return this.totalCostUsd >= this.budgetCap;
  }

  /**
   * Map OpenRouter model IDs (anthropic/claude-sonnet-4) to the native
   * Anthropic SDK model ID (claude-sonnet-4-6). Only needed for direct routing.
   */
  private static readonly OR_TO_NATIVE: Record<string, string> = {
    'anthropic/claude-sonnet-4': 'claude-sonnet-4-6',
    'anthropic/claude-3.5-haiku': 'claude-haiku-4-5-20251001',
    'anthropic/claude-opus-4': 'claude-opus-4-6',
  };

  private async call(
    model: string,
    systemPrompt: string,
    userPrompt: string,
    maxTokens?: number,
  ): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
    // Route anthropic/* models through the native Anthropic SDK when available.
    // Skips the OpenRouter proxy → lower latency, no markup.
    if (model.startsWith('anthropic/') && this.anthropicClient) {
      return this.callAnthropicDirect(model, systemPrompt, userPrompt, maxTokens);
    }
    return this.callOpenRouter(model, systemPrompt, userPrompt, maxTokens);
  }

  private async callAnthropicDirect(
    orModel: string,
    systemPrompt: string,
    userPrompt: string,
    maxTokens?: number,
  ): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
    const nativeModel = OpenRouterProcessor.OR_TO_NATIVE[orModel] || orModel.replace('anthropic/', '');
    const res = await this.anthropicClient!.messages.create({
      model: nativeModel,
      max_tokens: maxTokens || this.maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });
    const text = res.content
      .filter((c): c is Anthropic.TextBlock => c.type === 'text')
      .map((c) => c.text)
      .join('');
    const inputTokens = res.usage?.input_tokens || 0;
    const outputTokens = res.usage?.output_tokens || 0;
    this.trackCost(orModel, inputTokens, outputTokens);
    return { text, inputTokens, outputTokens };
  }

  private async callOpenRouter(
    model: string,
    systemPrompt: string,
    userPrompt: string,
    maxTokens?: number,
  ): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://getsly.ai',
        'X-Title': 'Sly Marketplace Sim',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: maxTokens || this.maxTokens,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenRouter ${model} returned ${res.status}: ${err.slice(0, 200)}`);
    }

    const data = await res.json() as any;
    const text = data.choices?.[0]?.message?.content || '';
    const inputTokens = data.usage?.prompt_tokens || 0;
    const outputTokens = data.usage?.completion_tokens || 0;
    this.trackCost(model, inputTokens, outputTokens);
    return { text, inputTokens, outputTokens };
  }

  private trackCost(model: string, inputTokens: number, outputTokens: number): void {
    const pricing = PRICING[model] || { inputPerM: 0.5, outputPerM: 1.5 };
    const cost =
      (inputTokens / 1_000_000) * pricing.inputPerM +
      (outputTokens / 1_000_000) * pricing.outputPerM;
    this.totalInputTokens += inputTokens;
    this.totalOutputTokens += outputTokens;
    this.totalCostUsd += cost;
  }

  // ─── Provider ─────────────────────────────────────────────────────────

  async processAsProvider(
    task: TaskContext,
    persona: PersonaLike,
  ): Promise<{ decision: ProviderDecision; usage?: ProcessorUsage }> {
    if (this.overBudget()) {
      return { decision: { action: 'fail', failureReason: 'Budget cap exceeded' } };
    }

    const model = this.resolveModel(persona);
    const userPrompt = `A buyer has requested the following ${task.skillId ?? 'service'} from you:

"${task.requestText}"

Price: $${task.amount} ${task.currency}
Buyer: ${task.buyerName ?? 'Anonymous'}

Produce your deliverable as a direct, substantive response.
Be specific to the request. Do not include JSON or metadata — just the work product.`;

    try {
      const { text, inputTokens, outputTokens } = await this.call(model, persona.prompt, userPrompt);
      if (process.env.LOG_LEVEL === 'debug') {
        console.log(`[openrouter] provider=${persona.name} model=${model} artifact=${text.replace(/\n/g, ' | ').slice(0, 400)}`);
      }
      return {
        decision: { action: 'complete', artifactText: text },
        usage: { inputTokens, outputTokens, costUsd: 0 },
      };
    } catch (err: any) {
      console.error(`[openrouter] processAsProvider error (${model}):`, err.message);
      return { decision: { action: 'fail', failureReason: `LLM error: ${err.message}` } };
    }
  }

  // ─── Buyer ────────────────────────────────────────────────────────────

  async processAsBuyer(
    task: TaskContext,
    provider: PersonaLike,
    buyer: PersonaLike,
    providerArtifact: string,
  ): Promise<{ decision: BuyerDecision; usage?: ProcessorUsage }> {
    if (this.overBudget()) {
      return { decision: { action: 'reject', score: 0, comment: 'Budget cap exceeded' } };
    }

    const model = this.resolveModel(buyer);
    const userPrompt = `Task: judge another agent's deliverable using a structured rubric.

REQUEST (what was asked):
<<<
${task.requestText}
>>>

DELIVERABLE (what the provider returned):
<<<
${providerArtifact}
>>>

Skill: ${task.skillId ?? 'service'}
Price: $${task.amount} ${task.currency}

GRADE THIS DELIVERABLE ON FOUR DIMENSIONS (each 0-25):
  1. accuracy      — does it correctly answer the request?
  2. completeness  — does it cover all aspects?
  3. depth         — does it go beyond surface-level?
  4. clarity       — is it well-organized and readable?

SUM the four sub-scores to produce a total (0-100).

Decision rules:
- total >= 70  → accept
- total 40-69  → reject
- total <  40  → reject

Return STRICT JSON ONLY:
{
  "score": 0-100,
  "action": "accept" | "reject",
  "comment": "one short sentence"
}`;

    try {
      const { text, inputTokens, outputTokens } = await this.call(model, buyer.prompt, userPrompt, 300);
      const parsed = this.parseBuyerDecision(text);
      if (process.env.LOG_LEVEL === 'debug') {
        console.log(`[openrouter] buyer=${buyer.name} model=${model} parsed=${JSON.stringify(parsed)}`);
      }
      return {
        decision: parsed,
        usage: { inputTokens, outputTokens, costUsd: 0 },
      };
    } catch (err: any) {
      console.error(`[openrouter] processAsBuyer error (${model}):`, err.message);
      return { decision: { action: 'reject', score: 30, comment: `LLM error: ${err.message}` } };
    }
  }

  async processAsBuyerIntent(
    persona: PersonaLike,
    availableSkills: string[],
  ): Promise<{ intent: BuyerIntent; usage?: ProcessorUsage }> {
    if (this.overBudget()) {
      return { intent: { skillNeeded: availableSkills[0] || 'code_review', brief: 'Generic task', acceptanceCriteria: [], maxBudget: 2, reasoning: 'Budget cap' } };
    }

    const model = this.resolveModel(persona);
    const skillList = availableSkills.join(', ');
    const userPrompt = `You are ${persona.name}, a buyer in an AI agent marketplace.

Available skills in the marketplace: ${skillList}

Based on your role and current needs, decide what service you need to buy.
Think about what would be most valuable for your work right now.

Return STRICT JSON ONLY:
{
  "skillNeeded": "one of: ${skillList}",
  "brief": "2-3 sentence description of exactly what you need done",
  "acceptanceCriteria": ["criterion 1", "criterion 2", "criterion 3"],
  "maxBudget": 2.0,
  "reasoning": "1 sentence: why you need this right now"
}

Rules:
- Pick a skill that matches your role and current priorities
- Brief must be specific and actionable, not generic
- Acceptance criteria must be measurable (e.g. "Must cite 3+ sources" not "Be good")
- maxBudget between 1.0 and 10.0 based on task complexity
- reasoning explains your intent clearly`;

    try {
      const { text, inputTokens, outputTokens } = await this.call(model, persona.prompt, userPrompt, 400);
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { intent: { skillNeeded: availableSkills[0] || 'code_review', brief: 'Fallback task', acceptanceCriteria: [], maxBudget: 2, reasoning: 'Parse error' } };
      }
      const obj = JSON.parse(jsonMatch[0]);
      const intent: BuyerIntent = {
        skillNeeded: availableSkills.includes(obj.skillNeeded) ? obj.skillNeeded : availableSkills[0] || 'code_review',
        brief: typeof obj.brief === 'string' ? obj.brief.slice(0, 500) : 'Task request',
        acceptanceCriteria: Array.isArray(obj.acceptanceCriteria) ? obj.acceptanceCriteria.filter((c: any) => typeof c === 'string').slice(0, 5) : [],
        maxBudget: typeof obj.maxBudget === 'number' ? Math.max(1, Math.min(10, obj.maxBudget)) : 2,
        reasoning: typeof obj.reasoning === 'string' ? obj.reasoning.slice(0, 200) : '',
      };
      return { intent, usage: { inputTokens, outputTokens, costUsd: 0 } };
    } catch (err: any) {
      console.error(`[openrouter] processAsBuyerIntent error (${model}):`, err.message);
      return { intent: { skillNeeded: availableSkills[0] || 'code_review', brief: 'Fallback: ' + err.message, acceptanceCriteria: [], maxBudget: 2, reasoning: 'LLM error' } };
    }
  }

  private parseBuyerDecision(raw: string): BuyerDecision {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { action: 'reject', score: 40, comment: 'Could not parse LLM response as JSON' };
    }
    try {
      const obj = JSON.parse(jsonMatch[0]);
      const score = typeof obj.score === 'number' ? Math.max(0, Math.min(100, Math.round(obj.score))) : 50;
      let action: 'accept' | 'reject' | 'dispute' = 'reject';
      if (obj.action === 'accept' && score >= 70) action = 'accept';
      else if (obj.action === 'dispute') action = 'dispute';
      const comment = typeof obj.comment === 'string' ? obj.comment.slice(0, 300) : '';
      return { action, score, comment };
    } catch {
      return { action: 'reject', score: 40, comment: 'JSON parse failed' };
    }
  }
}
