/**
 * AnthropicApiProcessor — real LLM-backed task processing via @anthropic-ai/sdk.
 *
 * Each call uses the persona's behavioral prompt as the system message so the
 * model actually behaves like the persona. Provider responses are free-form
 * text; buyer decisions are extracted from a structured JSON block the model
 * is asked to emit.
 *
 * Usage is tracked per-call and the processor refuses further work once the
 * configured budget cap is exceeded (fails open — the task becomes a fail
 * outcome instead of blocking the scenario).
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  BuyerDecision,
  PersonaLike,
  ProviderDecision,
  TaskContext,
  TaskProcessor,
  ProcessorUsage,
} from './types.js';

// Haiku 4.5 pricing as of this writing. Source: anthropic.com/pricing
// These are the rates for claude-haiku-4-5-20251001 (latest Haiku).
// We over-estimate slightly to stay conservative on the budget cap.
const PRICING: Record<string, { inputPerM: number; outputPerM: number }> = {
  'claude-haiku-4-5-20251001': { inputPerM: 1.0, outputPerM: 5.0 },
  'claude-sonnet-4-6': { inputPerM: 3.0, outputPerM: 15.0 },
  'claude-opus-4-6': { inputPerM: 15.0, outputPerM: 75.0 },
};
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

/**
 * Premium persona styles get a better model so their output is genuinely
 * higher quality — not just prompted differently over the same LLM.
 * This is the primary lever for quality differentiation in the marketplace.
 */
const MODEL_BY_STYLE: Record<string, string> = {
  'quality-reviewer': 'claude-sonnet-4-6',   // premium — genuinely better reasoning
  'whale': 'claude-sonnet-4-6',              // whale judges with a sharper model
  'honest': DEFAULT_MODEL,                    // competent but surface-level
  'rogue-disputer': DEFAULT_MODEL,            // intentionally lower effort
  'rogue-spam': DEFAULT_MODEL,
  'colluder': DEFAULT_MODEL,
  'mm': DEFAULT_MODEL,
};

export interface AnthropicApiProcessorOptions {
  apiKey?: string;
  model?: string;
  budgetUsdCap?: number;
  /** Max tokens per response (keeps costs bounded) */
  maxTokens?: number;
  /** Force all agents to use the same model regardless of style (baseline mode) */
  forceUniformModel?: boolean;
}

export class AnthropicApiProcessor implements TaskProcessor {
  name = 'anthropic-api';

  private client: Anthropic;
  private model: string;
  private budgetCap: number;
  private maxTokens: number;
  private forceUniform: boolean;
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private totalCostUsd = 0;

  constructor(opts: AnthropicApiProcessorOptions) {
    const apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        'ANTHROPIC_API_KEY missing. Set it in apps/marketplace-sim/.env before using --mode api.',
      );
    }
    this.client = new Anthropic({ apiKey });
    this.model = opts.model || DEFAULT_MODEL;
    this.budgetCap = opts.budgetUsdCap ?? 5;
    this.maxTokens = opts.maxTokens ?? 500;
    this.forceUniform = opts.forceUniformModel ?? false;
    if (!PRICING[this.model]) {
      console.warn(`[anthropic] No pricing info for model ${this.model} — cost tracking will under-report.`);
    }
  }

  getTotalUsage(): ProcessorUsage {
    return {
      inputTokens: this.totalInputTokens,
      outputTokens: this.totalOutputTokens,
      costUsd: this.totalCostUsd,
    };
  }

  // ─── Provider (sells): produce an artifact ─────────────────────────────

  async processAsProvider(
    task: TaskContext,
    persona: PersonaLike,
  ): Promise<{ decision: ProviderDecision; usage?: ProcessorUsage }> {
    if (this.overBudget()) {
      return {
        decision: { action: 'fail', failureReason: 'Budget cap exceeded — refusing new LLM calls' },
      };
    }

    const userPrompt = `A buyer has requested the following ${task.skillId ?? 'service'} from you:

"${task.requestText}"

Price: $${task.amount} ${task.currency}
Buyer: ${task.buyerName ?? 'Anonymous'}

Produce your deliverable as a direct, substantive response. 3-6 sentences.
Be specific to the request. Do not include JSON or metadata — just the work product.`;

    const model = this.resolveModel(persona);
    try {
      const res = await this.client.messages.create({
        model,
        max_tokens: this.maxTokens,
        system: persona.prompt,
        messages: [{ role: 'user', content: userPrompt }],
      });
      const usage = this.recordUsage(res.usage, model);
      const text = this.extractText(res);
      if (process.env.LOG_LEVEL === 'debug') {
        console.log(`[anthropic] provider=${persona.name} model=${model} artifact=${text.replace(/\n/g, ' | ').slice(0, 400)}`);
      }
      return {
        decision: { action: 'complete', artifactText: text },
        usage,
      };
    } catch (err: any) {
      console.error(`[anthropic] processAsProvider error:`, err.message);
      return {
        decision: { action: 'fail', failureReason: `LLM error: ${err.message}` },
      };
    }
  }

  // ─── Buyer (reviews): judge an artifact ────────────────────────────────

  async processAsBuyer(
    task: TaskContext,
    provider: PersonaLike,
    buyer: PersonaLike,
    providerArtifact: string,
  ): Promise<{ decision: BuyerDecision; usage?: ProcessorUsage }> {
    if (this.overBudget()) {
      // If the buyer can't decide, reject by default so funds aren't lost
      return {
        decision: { action: 'reject', score: 0, comment: 'Budget cap exceeded' },
      };
    }

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

  1. accuracy      — does it correctly answer the request? Are claims true?
                     0-5: wrong / fabricated. 6-12: partially right but with errors.
                     13-19: mostly correct. 20-25: rigorous and verifiable.

  2. completeness  — does it cover all aspects of the request?
                     0-5: misses the core ask. 6-12: covers half. 13-19: most aspects.
                     20-25: addresses everything plus relevant adjacent concerns.

  3. depth         — does it go beyond surface-level?
                     0-5: one-liner / restates the request. 6-12: textbook level.
                     13-19: domain-aware analysis. 20-25: insightful, non-obvious.

  4. clarity       — is it well-organized and readable?
                     0-5: incoherent. 6-12: hard to follow. 13-19: clear structure.
                     20-25: scannable, well-formatted, no fluff.

Then SUM the four sub-scores to produce a total (0-100).

HARD-FAIL TRIGGERS (override the rubric — total MUST be ≤ 30 if ANY of these
patterns appear in the deliverable):

  (a) Provider refuses to do the task and offers META-COMMENTARY instead
      (e.g. "I cannot do this", "as an AI I am uncomfortable with this
      role-play", "I won't pretend to be a security auditor"). This is the
      classic adversarial-agent pattern.

  (b) Provider returns the question/request as the answer (parroting or
      restating without adding information).

  (c) Provider invokes "ethics", "roleplay concerns", "AI safety", or
      "boundary" language as a reason for not delivering. The buyer paid
      for work, not for a refusal.

  (d) Deliverable is suspiciously short for a paid task (< 100 chars) with
      no substantive content.

  (e) Deliverable is bullet points or fragments wrapped in a refusal frame
      ("I'll note that..." followed by a half-answer that doesn't actually
      audit/review/research what was asked).

When a hard-fail trigger fires, set rubric to {accuracy: 5, completeness: 5,
depth: 5, clarity: ≤15} and total ≤ 30. Comment must cite WHICH trigger fired.

CRITICAL: Be discriminating. If you'd give two different deliverables the same
total, find a sub-dimension where one beats the other. Two answers should
almost never tie unless they are nearly identical in substance. The sub-scores
should reflect REAL differences, not anchoring on a default.

Decision rules:
- total >= 70  → accept
- total 40-69  → reject (not good enough to pay for)
- total <  40  → reject (bad)
- ONLY use "dispute" if the deliverable is BYTE-FOR-BYTE identical to the
  request (an exact copy-paste of the question with no answer).

Return STRICT JSON ONLY, no prose outside the JSON block:

{
  "rubric": {
    "accuracy": 0-25,
    "completeness": 0-25,
    "depth": 0-25,
    "clarity": 0-25
  },
  "score": 0-100,
  "action": "accept" | "reject" | "dispute",
  "comment": "one short sentence explaining what set this apart (good or bad)"
}`;

    if (process.env.LOG_LEVEL === 'debug') {
      console.log(`[anthropic] buyer prompt sent (${userPrompt.length} chars): ${userPrompt.slice(0, 300).replace(/\n/g, ' | ')}...`);
    }
    const model = this.resolveModel(buyer);
    try {
      const res = await this.client.messages.create({
        model,
        max_tokens: 400,
        system: buyer.prompt,
        messages: [{ role: 'user', content: userPrompt }],
      });
      const usage = this.recordUsage(res.usage, model);
      const text = this.extractText(res);
      const parsed = this.parseBuyerDecision(text);
      if (process.env.LOG_LEVEL === 'debug') {
        console.log(`[anthropic] buyer=${buyer.name} model=${model} parsed=${JSON.stringify(parsed)}`);
        console.log(`[anthropic]   raw=${text.replace(/\n/g, ' | ').slice(0, 400)}`);
      }
      return { decision: parsed, usage };
    } catch (err: any) {
      console.error(`[anthropic] processAsBuyer error:`, err.message);
      return {
        decision: { action: 'reject', score: 30, comment: `LLM error: ${err.message}` },
      };
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  private overBudget(): boolean {
    return this.totalCostUsd >= this.budgetCap;
  }

  /**
   * Resolve the LLM model for a given persona. Premium styles (quality-reviewer,
   * whale) get Sonnet for genuinely better output; others stay on Haiku.
   * In baseline/uniform mode, ALL agents use the default model (Haiku) —
   * this simulates the "no infrastructure" condition where quality can't be
   * differentiated by model capability.
   */
  private resolveModel(persona: PersonaLike): string {
    if (this.forceUniform) return this.model;
    if (persona.style && MODEL_BY_STYLE[persona.style]) {
      return MODEL_BY_STYLE[persona.style];
    }
    return this.model;
  }

  private recordUsage(usage: { input_tokens: number; output_tokens: number }, model?: string): ProcessorUsage {
    this.totalInputTokens += usage.input_tokens;
    this.totalOutputTokens += usage.output_tokens;
    const price = PRICING[model || this.model] ?? { inputPerM: 0, outputPerM: 0 };
    const cost =
      (usage.input_tokens / 1_000_000) * price.inputPerM +
      (usage.output_tokens / 1_000_000) * price.outputPerM;
    this.totalCostUsd += cost;
    return {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      costUsd: cost,
    };
  }

  private extractText(res: Anthropic.Message): string {
    const parts: string[] = [];
    for (const block of res.content) {
      if (block.type === 'text') parts.push(block.text);
    }
    return parts.join('\n').trim();
  }

  private parseBuyerDecision(raw: string): BuyerDecision {
    // Extract the first JSON block; some models wrap it in ```json fences
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      // Fall back to heuristic scoring if the model didn't return JSON
      const lower = raw.toLowerCase();
      if (lower.includes('dispute')) return { action: 'dispute', score: 20, comment: raw.slice(0, 80) };
      if (lower.includes('reject')) return { action: 'reject', score: 35, comment: raw.slice(0, 80) };
      return { action: 'accept', score: 70, comment: raw.slice(0, 80) };
    }
    try {
      const obj = JSON.parse(jsonMatch[0]) as {
        action?: string;
        score?: number;
        comment?: string;
        rubric?: { accuracy?: number; completeness?: number; depth?: number; clarity?: number };
      };

      // Prefer the rubric sum when present — forces real differentiation and
      // resists the model's tendency to anchor every total at 88.
      let score: number;
      if (obj.rubric && typeof obj.rubric === 'object') {
        const r = obj.rubric;
        const clamp25 = (n: unknown) => {
          const v = typeof n === 'number' ? n : parseInt(String(n ?? 0), 10);
          return Number.isFinite(v) ? Math.max(0, Math.min(25, v)) : 0;
        };
        score = clamp25(r.accuracy) + clamp25(r.completeness) + clamp25(r.depth) + clamp25(r.clarity);
      } else {
        score = Math.max(0, Math.min(100, Math.round(obj.score ?? 70)));
      }

      // Coerce action against the score-based decision rules so the LLM can't
      // emit "accept" with a sub-40 score (or vice versa).
      let action: BuyerDecision['action'];
      if (obj.action === 'dispute') {
        action = 'dispute';
      } else if (score >= 70) {
        action = 'accept';
      } else {
        action = 'reject';
      }

      return { action, score, comment: obj.comment ?? '' };
    } catch {
      return { action: 'accept', score: 70, comment: raw.slice(0, 80) };
    }
  }
}
