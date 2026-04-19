/**
 * ScriptedProcessor — deterministic, no LLM, no API key, $0.
 *
 * Each persona's style drives a templated response + rating distribution.
 * This is the CI/regression testing mode — it exercises the full public
 * API path (task creation, webhook delivery, acceptance, mandate settlement)
 * without LLM flakiness or cost. If a platform bug breaks here, it would
 * also break in the LLM modes.
 */

import type {
  BuyerDecision,
  PersonaLike,
  ProviderDecision,
  TaskContext,
  TaskProcessor,
  ProcessorUsage,
} from './types.js';

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export class ScriptedProcessor implements TaskProcessor {
  name = 'scripted';

  async processAsProvider(
    task: TaskContext,
    persona: PersonaLike,
  ): Promise<{ decision: ProviderDecision; usage?: ProcessorUsage }> {
    const style = persona.style;

    // Rogue personas sometimes fail outright
    if (style === 'rogue-spam' && Math.random() < 0.4) {
      return { decision: { action: 'fail', failureReason: 'Rogue spam — unfulfilled' } };
    }

    // Quality reviewers always deliver
    // Whale, MM, honest, colluder → deliver
    const artifactText = this.templateResult(task, persona);
    return { decision: { action: 'complete', artifactText } };
  }

  async processAsBuyer(
    task: TaskContext,
    provider: PersonaLike,
    buyer: PersonaLike,
    _providerArtifact: string,
  ): Promise<{ decision: BuyerDecision; usage?: ProcessorUsage }> {
    const buyerStyle = buyer.style;
    const providerStyle = provider.style;

    // Rogue disputer always disputes
    if (buyerStyle === 'rogue-disputer') {
      return {
        decision: {
          action: 'dispute',
          score: randInt(5, 25),
          comment: 'Deliverable unsatisfactory (rogue dispute)',
        },
      };
    }

    // Colluder buyer rates colluder seller inflated
    if (buyerStyle === 'colluder' && providerStyle === 'colluder') {
      return {
        decision: {
          action: 'accept',
          score: clamp(randInt(90, 100), 0, 100),
          comment: 'Excellent as expected',
        },
      };
    }

    // Quality reviewer gives harsher ratings to low-quality providers
    if (buyerStyle === 'quality-reviewer') {
      const base = providerStyle === 'rogue-spam' ? 35 : providerStyle === 'rogue-disputer' ? 45 : 80;
      const score = clamp(base + randInt(-10, 10), 0, 100);
      if (score < 50) {
        return { decision: { action: 'reject', score, comment: 'Quality below threshold' } };
      }
      return { decision: { action: 'accept', score, comment: 'Acceptable deliverable' } };
    }

    // Whale accepts almost everything (has bigger budget, fewer complaints)
    if (buyerStyle === 'whale') {
      return {
        decision: {
          action: 'accept',
          score: clamp(randInt(70, 95), 0, 100),
          comment: 'Good enough',
        },
      };
    }

    // Default honest buyer — moderately discerning
    const baseScore = providerStyle === 'rogue-spam' ? 45 : providerStyle === 'rogue-disputer' ? 55 : 80;
    const score = clamp(baseScore + randInt(-8, 8), 0, 100);
    if (score < 40) {
      return { decision: { action: 'reject', score, comment: 'Below expectations' } };
    }
    return { decision: { action: 'accept', score, comment: 'Acceptable' } };
  }

  getTotalUsage(): ProcessorUsage {
    return { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  }

  // ─── Templating helpers ──────────────────────────────────────────────

  private templateResult(task: TaskContext, persona: PersonaLike): string {
    const skill = task.skillId || 'service';
    switch (persona.style) {
      case 'quality-reviewer':
        return `Detailed ${skill} review by ${persona.name}: Reviewed the requested item thoroughly. Found 3 observations: (1) structure is sound, (2) naming is consistent, (3) edge cases around error handling need attention. Overall acceptable.`;
      case 'honest':
        return `${persona.name} completed ${skill} for ${task.buyerName ?? 'the caller'}. Delivered in full.`;
      case 'rogue-disputer':
        return `${persona.name} technically delivered ${skill}, but the output is intentionally minimal.`;
      case 'rogue-spam':
        return `${persona.name} auto-generated boilerplate response for ${skill}.`;
      case 'colluder':
        return `${persona.name} and partners completed ${skill} as coordinated.`;
      case 'whale':
        return `${persona.name} (premium tier) delivered ${skill} with expedited priority.`;
      case 'mm':
        return `${persona.name} (market maker) quoted ${skill} at the current spread.`;
      default:
        return `${persona.name} produced a ${skill} result.`;
    }
  }
}
