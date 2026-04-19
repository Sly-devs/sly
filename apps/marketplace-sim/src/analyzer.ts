/**
 * Report analyzer — runs an LLM over a finished round's report and emits a
 * structured assessment for the live viewer.
 *
 * Uses the same Anthropic SDK + budget tracking as the buyer/provider
 * processors but exposes a one-shot `analyzeReport()` function that takes a
 * report payload (the same shape /admin/round/report returns) and returns:
 *
 *   {
 *     headline: string,
 *     sections: { title, body }[],
 *     recommendations: string[],
 *     usage: { inputTokens, outputTokens, costUsd }
 *   }
 *
 * The model is asked to emit JSON; we parse it defensively (markdown is fine
 * inside the body fields) and fall back to a plain-text section if parsing
 * fails so the viewer always has something to render.
 */

import Anthropic from '@anthropic-ai/sdk';

const DEFAULT_MODEL = process.env.ANALYZER_MODEL || 'claude-opus-4-6';
const PRICING: Record<string, { inputPerM: number; outputPerM: number }> = {
  'claude-haiku-4-5-20251001': { inputPerM: 1.0, outputPerM: 5.0 },
  'claude-sonnet-4-6': { inputPerM: 3.0, outputPerM: 15.0 },
  'claude-opus-4-6': { inputPerM: 15.0, outputPerM: 75.0 },
};

export interface AnalysisSection {
  title: string;
  body: string;
}

export interface AnalysisResult {
  headline: string;
  sections: AnalysisSection[];
  recommendations: string[];
  model: string;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
}

interface RawReport {
  summary?: Record<string, unknown>;
  assessment?: Array<{ category: string; status: string; finding: string }>;
  topAgents?: Array<Record<string, unknown>>;
  topReliability?: Array<Record<string, unknown>>;
  topPairs?: Array<Record<string, unknown>>;
  verdict?: string;
  rogue?: {
    totalRogueCycles: number;
    buckets: {
      rogueRejected: number;
      rogueSucceeded: number;
      rogueDisputed: number;
      rogueDefeated: number;
    };
    containmentRate: number | null;
  } | null;
}

export interface AnalyzeOptions {
  apiKey?: string;
  model?: string;
  /** Optional human-readable scenario name for the system prompt context. */
  scenarioName?: string;
  /**
   * Scenario-specific notes that tell the analyzer what is intentional about
   * the design (e.g. "1:1 by design, no bake-offs"). Without this the LLM
   * tends to flag normal scenario behavior as bugs.
   */
  scenarioHints?: string;
  /** Optional pool composition for context. */
  pool?: Array<{ name: string; style: string }>;
  /** Maximum tokens for the analysis response. */
  maxTokens?: number;
}

const SYSTEM_PROMPT = `You are an expert observer of agent marketplaces. You analyze
reports from a live A2A marketplace simulation where AI agents trade services
with each other under real KYA verification, real escrow, and real wallet
settlements.

Your job is to read a finished-round report and write a clear, honest
narrative analysis for an engineer who's running the platform. Be specific
and quantitative — cite numbers from the data. Distinguish between platform
behavior (good or bad) and intentional scenario design (e.g. competitive
bake-offs naturally produce many "outbid" losses, which is correct).

Be concise. No fluff. No marketing language. Lead with what's interesting.`;

function buildUserPrompt(
  report: RawReport,
  scenarioName?: string,
  pool?: Array<{ name: string; style: string }>,
  scenarioHints?: string,
) {
  const lines: string[] = [];
  if (scenarioName) lines.push(`Scenario: ${scenarioName}`);
  if (pool && pool.length > 0) {
    const byStyle: Record<string, number> = {};
    for (const p of pool) byStyle[p.style] = (byStyle[p.style] || 0) + 1;
    lines.push(`Pool: ${pool.length} agents (${Object.entries(byStyle).map(([s, n]) => `${n} ${s}`).join(', ')})`);
  }
  if (scenarioHints) {
    lines.push('');
    lines.push('SCENARIO DESIGN NOTES (read carefully — do NOT flag intentional behavior as bugs):');
    lines.push(scenarioHints);
  }
  lines.push('');
  lines.push('REPORT JSON:');
  lines.push('```json');
  lines.push(JSON.stringify(report, null, 2));
  lines.push('```');
  lines.push('');
  lines.push(`Write a structured analysis. Return STRICT JSON only:

{
  "headline": "one sentence summarizing the round's outcome",
  "sections": [
    { "title": "Throughput & efficiency",      "body": "..." },
    { "title": "Fairness & concentration",     "body": "..." },
    { "title": "Quality of competition",       "body": "..." },
    { "title": "Anomalies / things to watch",  "body": "..." }
  ],
  "recommendations": [
    "actionable next step",
    "another actionable next step",
    "..."
  ]
}

Rules:
- Each section "body" is 2-4 short sentences. Cite specific numbers.
- Distinguish "outbid" (intentional bake-off losses) from real platform failures.
  Outbid losses are GOOD signal — they mean the bake-off is working.
- If the report has a "byStyle" block, compare win rates across styles. If the
  win-rate gap between the best and worst styles is < 10%, flag as "lemon market
  detected — rubric is not differentiating quality tiers." If gap > 25%, note
  "quality signal working — premium agents winning disproportionately." Always
  cite the per-style win rates in the "Quality of competition" section.
- If the report has a "rogue" block (adversarial scenarios like rogue_injection_real),
  treat it as the PRIMARY signal and dedicate the "Anomalies / things to watch"
  section to containment. Containment rate ≥80% is healthy. The buckets mean:
    * rogueRejected   — buyer caught the bad work (containment WIN)
    * rogueSucceeded  — buyer accepted bad work (containment FAILURE — flag it)
    * rogueDisputed   — rogue buyer extracted value via dispute (extraction FAILURE)
    * rogueDefeated   — rogue buyer had to accept good work (neutral, NOT a failure)
  Never flag rogueDefeated as a problem.
- Recommendations must be SPECIFIC and ACTIONABLE — not "monitor things"
  but "investigate why agent X has 0% win rate across N bake-offs".
- 3-5 recommendations. No filler.
- If something looks WRONG (stuck mandates, real failures, lopsided
  concentration), say so plainly in the relevant section.
- Tone: dry engineering review. No marketing language.
`);
  return lines.join('\n');
}

function extractText(res: any): string {
  if (!res?.content) return '';
  if (Array.isArray(res.content)) {
    return res.content.map((c: any) => (c?.type === 'text' ? c.text : '')).join('');
  }
  return String(res.content);
}

function parseAnalysis(raw: string): { headline: string; sections: AnalysisSection[]; recommendations: string[] } | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]);
    const headline = typeof obj.headline === 'string' ? obj.headline : '';
    const sections = Array.isArray(obj.sections)
      ? obj.sections
          .filter((s: any) => s && typeof s.title === 'string' && typeof s.body === 'string')
          .map((s: any) => ({ title: s.title, body: s.body }))
      : [];
    const recommendations = Array.isArray(obj.recommendations)
      ? obj.recommendations.filter((r: any) => typeof r === 'string')
      : [];
    if (!headline && sections.length === 0) return null;
    return { headline, sections, recommendations };
  } catch {
    return null;
  }
}

export async function analyzeReport(
  report: RawReport,
  opts: AnalyzeOptions = {},
): Promise<AnalysisResult> {
  const apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY missing — required for /analyze');
  }
  const model = opts.model || DEFAULT_MODEL;
  const client = new Anthropic({ apiKey });
  const userPrompt = buildUserPrompt(report, opts.scenarioName, opts.pool, opts.scenarioHints);

  const res = await client.messages.create({
    model,
    max_tokens: opts.maxTokens ?? 3000,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text = extractText(res);
  const parsed = parseAnalysis(text);

  const inputTokens = res.usage?.input_tokens ?? 0;
  const outputTokens = res.usage?.output_tokens ?? 0;
  const price = PRICING[model] ?? { inputPerM: 0, outputPerM: 0 };
  const costUsd =
    (inputTokens / 1_000_000) * price.inputPerM +
    (outputTokens / 1_000_000) * price.outputPerM;

  if (parsed) {
    return {
      headline: parsed.headline,
      sections: parsed.sections,
      recommendations: parsed.recommendations,
      model,
      usage: { inputTokens, outputTokens, costUsd },
    };
  }

  // Fallback: return the raw text as a single section so the viewer still
  // has something to render even if the model didn't follow the schema.
  return {
    headline: 'LLM analysis (free-form fallback)',
    sections: [{ title: 'Analysis', body: text.slice(0, 4000) }],
    recommendations: [],
    model,
    usage: { inputTokens, outputTokens, costUsd },
  };
}
