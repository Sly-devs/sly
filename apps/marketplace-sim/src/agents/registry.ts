/**
 * Loads the persona agent records seeded by `pnpm seed-personas`.
 *
 * tokens.json shape:
 *   {
 *     "honest-trader": [
 *       { agentId, agentName, tenantId, parentAccountId, token, walletId, balance, ... },
 *       ...
 *     ],
 *     "quality-reviewer": [...],
 *     "rogue-disputer": [...]
 *   }
 *
 * Each entry is one Sly-registered agent. Templates can have N instances
 * so scenarios get a real population to work with.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SimAgent } from '../processors/types.js';
import { SlyClient } from '../sly-client.js';
import { PERSONA_TEMPLATES } from '../personas/index.js';

export interface SeededAgentRecord {
  /** Template id, e.g. "honest-trader" — same as the parent key */
  templateId: string;
  agentId: string;
  agentName: string;
  tenantId: string;
  parentAccountId: string | null;
  token: string;
  /** Ed25519 private key (base64) for challenge-response auth (Epic 72) */
  ed25519PrivateKey?: string;
  ed25519KeyId?: string;
  walletId?: string;
  balance: number;
  kyaTier: number;
  seededAt: string;
}

export type SeededAgentBook = Record<string, SeededAgentRecord[]>;

const TOKENS_PATH = resolve(process.cwd(), 'tokens.json');

/** Raw read of tokens.json. Throws if not seeded. */
export function loadSeededBook(): SeededAgentBook {
  if (!existsSync(TOKENS_PATH)) {
    throw new Error(
      `tokens.json not found at ${TOKENS_PATH}. Run \`pnpm seed-personas\` first.`,
    );
  }
  const raw = JSON.parse(readFileSync(TOKENS_PATH, 'utf-8'));

  // Backwards compat: legacy shape was Record<personaId, SeededAgent>.
  // Detect by checking if the first value looks like a single agent (has agentId).
  const firstValue = Object.values(raw)[0] as any;
  if (firstValue && !Array.isArray(firstValue) && typeof firstValue.agentId === 'string') {
    // Wrap each legacy single-agent into a 1-element array
    const wrapped: SeededAgentBook = {};
    for (const [k, v] of Object.entries(raw)) {
      wrapped[k] = [{ ...(v as any), templateId: k }];
    }
    return wrapped;
  }
  return raw as SeededAgentBook;
}

/**
 * Materialize the full pool of SimAgents from tokens.json.
 * Each record is enriched with its template's behavioral fields (role,
 * prompt, style) so scenarios + processors get one self-contained object.
 */
export function loadSimAgents(): SimAgent[] {
  const book = loadSeededBook();
  const out: SimAgent[] = [];
  for (const [templateId, records] of Object.entries(book)) {
    const template = PERSONA_TEMPLATES[templateId];
    if (!template) {
      console.warn(`[registry] tokens.json has template "${templateId}" not in PERSONA_TEMPLATES — skipping`);
      continue;
    }
    for (const r of records) {
      if (!r.parentAccountId) {
        console.warn(`[registry] ${r.agentName} has no parentAccountId — skipping (re-run seed-personas)`);
        continue;
      }
      out.push({
        agentId: r.agentId,
        name: r.agentName,
        templateId,
        role: template.role,
        prompt: template.prompt,
        style: template.style,
        tenantId: r.tenantId,
        parentAccountId: r.parentAccountId,
        token: r.token,
        ed25519PrivateKey: r.ed25519PrivateKey,
        ed25519KeyId: r.ed25519KeyId,
        walletId: r.walletId,
        balance: r.balance,
      });
    }
  }
  return out;
}

/** Convenience: filter the pool by one or more styles. */
export function filterByStyle(agents: SimAgent[], styles: SimAgent['style'][]): SimAgent[] {
  const set = new Set(styles);
  return agents.filter((a) => set.has(a.style));
}

/**
 * Create a SlyClient for a sim agent. Prefers Ed25519 key-pair auth (Epic 72)
 * when the agent has a provisioned private key; falls back to bearer token.
 */
/**
 * Create a SlyClient for a sim agent. Prefers Ed25519 key-pair auth (Epic 72)
 * when the agent has a provisioned private key. ALWAYS includes the bearer
 * token as fallback so auth failures don't break the scenario.
 */
export function createAgentClient(agent: SimAgent, baseUrl: string, adminKey: string): SlyClient {
  if (agent.ed25519PrivateKey) {
    return new SlyClient({
      baseUrl,
      adminKey,
      agentToken: agent.token, // fallback if Ed25519 auth fails
      agentId: agent.agentId,
      ed25519PrivateKey: agent.ed25519PrivateKey,
    });
  }
  return new SlyClient({ baseUrl, adminKey, agentToken: agent.token });
}
