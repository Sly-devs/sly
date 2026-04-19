/**
 * TaskProcessor interface — the pluggable "brain" for an agent worker.
 *
 * When a persona agent's worker polls and finds a task assigned to it,
 * the worker hands the task + the agent's persona to the configured
 * TaskProcessor, which returns what the agent should do with it.
 *
 * Three implementations:
 *   - ScriptedProcessor    — templated branching, no LLM, no API key, $0
 *   - AnthropicApiProcessor — real LLM inference via @anthropic-ai/sdk
 *   - ClaudeSubagentProcessor — delegates to a Claude Code subagent via work queue
 *
 * All three must talk only through the SlyClient / HTTP — no DB access.
 */

/** Behavior style — drives processor branching and scenario filtering. */
export type PersonaStyle =
  | 'honest'
  | 'rogue-disputer'
  | 'rogue-spam'
  | 'colluder'
  | 'quality-reviewer'
  | 'whale'
  | 'mm';

/**
 * Persona template — a behavioral archetype. The marketplace can instantiate
 * many SimAgents from a single template (e.g. 5 honest traders all sharing
 * the same prompt + style but with distinct agent IDs and wallets).
 */
/** Skill to register on the agent via POST /v1/agents/:id/skills */
export interface PersonaSkill {
  skill_id: string;
  name: string;
  description: string;
  base_price: number;
  /** Estimated LLM inference cost per invocation (USD). Derived from model pricing. */
  estimated_cost?: number;
  tags?: string[];
}

export interface PersonaTemplate {
  /** Template identifier, e.g. "honest-trader" */
  id: string;
  /** Used as the prefix when minting agent names: sim-<namePrefix>-<i> */
  namePrefix: string;
  /** Role description shown in prompts and the feed */
  role: string;
  /** Full behavioral prompt (loaded from markdown file) */
  prompt: string;
  /** Rough expected behavior — used by the scripted processor for branching */
  style: PersonaStyle;
  /** Skills to register on the agent during seeding */
  skills?: PersonaSkill[];
  /**
   * KYA tier this template should be seeded at by default.
   * Honest/quality-reviewer: 1+ (can transact). Rogue: 0 (intentionally
   * unverified — exercises the platform's KYA gate as a real defense).
   */
  defaultKyaTier: number;
}

/**
 * SimAgent — a single runtime actor in a scenario. Combines a persona
 * template (shared behavior) with the seeded agent identity (its own wallet,
 * bearer token, parent account). All scenarios operate on these.
 */
export interface SimAgent {
  // Identity
  agentId: string;
  /** Display name, e.g. "sim-HonestBot-3" */
  name: string;
  // Persona behavior (delegated from template)
  templateId: string;
  role: string;
  prompt: string;
  style: PersonaStyle;
  // Auth + funding
  tenantId: string;
  parentAccountId: string;
  token: string;
  /** Ed25519 private key (base64) for challenge-response auth (Epic 72) */
  ed25519PrivateKey?: string;
  ed25519KeyId?: string;
  walletId?: string;
  balance: number;
}

/**
 * Minimal interface used by the processors. Both SimAgent and PersonaTemplate
 * satisfy it; this lets the processors stay agnostic to whether they're
 * looking at a template or a live agent instance.
 */
export interface PersonaLike {
  name: string;
  role: string;
  prompt: string;
  style: PersonaStyle;
}

/**
 * Backwards-compat alias — older code paths used `Persona` to mean either a
 * template or an instance. Going forward use SimAgent for instances and
 * PersonaTemplate for templates. This alias keeps the call sites compiling
 * during the migration.
 */
export type Persona = PersonaLike & { id: string };

export interface TaskContext {
  taskId: string;
  skillId?: string;
  requestText: string;
  amount: number;
  currency: string;
  buyerName?: string;
  sellerName?: string;
}

export type ProcessorRole = 'provider' | 'buyer';

export interface ProviderDecision {
  /** What the provider produces as a result */
  action: 'complete' | 'fail';
  /** Free-form artifact the provider returns (usually a text response) */
  artifactText?: string;
  /** Explanation for a failure */
  failureReason?: string;
}

export interface BuyerDecision {
  /** What the buyer does with the provider's output */
  action: 'accept' | 'reject' | 'dispute';
  /** Quality rating 0-100 */
  score: number;
  /** Free-form comment shown in the feed */
  comment?: string;
}

/** LLM-generated buyer intent — what the buyer needs and why */
export interface BuyerIntent {
  skillNeeded: string;
  brief: string;
  acceptanceCriteria: string[];
  maxBudget: number;
  reasoning: string;
}

/** Structured buyer evaluation against acceptance criteria */
export interface BuyerEvaluation {
  score: number;
  criteriaResults: Array<{ criterion: string; met: boolean; comment: string }>;
  comment: string;
  action: 'accept' | 'reject' | 'dispute';
}

export interface ProcessorUsage {
  /** Tokens used by this decision (if applicable) */
  inputTokens?: number;
  outputTokens?: number;
  /** USD cost of this decision (if applicable) */
  costUsd?: number;
}

export interface TaskProcessor {
  /** Unique identifier for logging and reports */
  name: string;

  /** Persona produces a result for an incoming task (provider side). */
  processAsProvider(
    task: TaskContext,
    persona: PersonaLike,
  ): Promise<{ decision: ProviderDecision; usage?: ProcessorUsage }>;

  /** Persona decides how to handle a delivered result (buyer side). */
  processAsBuyer(
    task: TaskContext,
    provider: PersonaLike,
    buyer: PersonaLike,
    providerArtifact: string,
  ): Promise<{ decision: BuyerDecision; usage?: ProcessorUsage }>;

  /** Buyer generates intent — what skill it needs, why, and acceptance criteria. */
  processAsBuyerIntent?(
    persona: PersonaLike,
    availableSkills: string[],
  ): Promise<{ intent: BuyerIntent; usage?: ProcessorUsage }>;

  /** Return aggregated cost / usage since the processor was constructed. */
  getTotalUsage(): ProcessorUsage;
}
