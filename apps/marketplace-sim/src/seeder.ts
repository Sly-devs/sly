/**
 * Persona seeder — shared between the CLI script and the HTTP /seed endpoint.
 *
 * Seeds N agents per persona template via the platform's `/admin/round/seed-agent`
 * endpoint and writes the result to tokens.json. Each instance is named
 * `sim-<NamePrefix>-<i>` and inherits the template's defaultKyaTier.
 */

import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PERSONA_TEMPLATES } from './personas/index.js';
import type { SeededAgentBook, SeededAgentRecord } from './agents/registry.js';
import type { PersonaSkill } from './processors/types.js';

export interface SeedCounts {
  honest: number;
  quality: number;
  rogue: number;
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

export interface SeedResult {
  book: SeededAgentBook;
  total: number;
  errors: string[];
}

const TOKENS_PATH = resolve(process.cwd(), 'tokens.json');

async function seedOne(
  baseUrl: string,
  adminKey: string,
  templateId: string,
  name: string,
  kyaTier: number,
): Promise<SeededAgentRecord> {
  const res = await fetch(`${baseUrl}/admin/round/seed-agent`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${adminKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name,
      description: `marketplace-sim persona: ${templateId}`,
      kyaTier,
    }),
  });

  const json = await res.json();
  if (!res.ok || !json?.data) {
    throw new Error(`seed-agent failed for ${name}: ${JSON.stringify(json)}`);
  }

  const d = json.data;
  const record: SeededAgentRecord = {
    templateId,
    agentId: d.id,
    agentName: d.name,
    tenantId: d.tenantId,
    parentAccountId: d.parentAccountId ?? null,
    token: d.token,
    walletId: d.walletId,
    balance: d.balance,
    kyaTier,
    seededAt: new Date().toISOString(),
  };

  // Epic 72: Provision Ed25519 key pair for challenge-response auth.
  // Uses the agent's own bearer token to call the auth-keys endpoint.
  // The private key is returned ONCE at creation time and stored in tokens.json.
  try {
    const keyRes = await fetch(`${baseUrl}/v1/agents/${d.id}/auth-keys`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${d.token}`,
        'Content-Type': 'application/json',
      },
    });
    if (keyRes.ok) {
      const keyJson = await keyRes.json();
      const keyData = keyJson.data ?? keyJson;
      if (keyData.privateKey) {
        record.ed25519PrivateKey = keyData.privateKey;
        record.ed25519KeyId = keyData.keyId;
      }
    }
  } catch {
    // Non-fatal — agent falls back to bearer token auth
  }

  return record;
}

/** Register skills on a freshly-seeded agent. Best-effort — failures are non-fatal. */
async function registerSkills(
  baseUrl: string,
  token: string,
  agentId: string,
  skills: PersonaSkill[],
): Promise<number> {
  let registered = 0;
  for (const skill of skills) {
    try {
      const res = await fetch(`${baseUrl}/v1/agents/${agentId}/skills`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          skill_id: skill.skill_id,
          name: skill.name,
          description: skill.description,
          base_price: skill.base_price,
          currency: 'USDC',
          tags: skill.tags || [],
          input_modes: ['text'],
          output_modes: ['text', 'data'],
          metadata: skill.estimated_cost ? { estimated_cost: skill.estimated_cost } : undefined,
        }),
      });
      if (res.ok) registered++;
    } catch { /* non-fatal */ }
  }
  return registered;
}

/**
 * Seed N agents per template, write tokens.json, return the result.
 * Existing template entries in tokens.json are *replaced* for the templates
 * we're seeding (so re-seeding with fewer agents shrinks the pool).
 * Templates we're not touching are preserved.
 */
export async function seedPersonas(
  counts: SeedCounts,
  opts: { baseUrl: string; adminKey: string; tokensPath?: string; log?: (msg: string) => void } = {} as any,
): Promise<SeedResult> {
  const baseUrl = opts.baseUrl;
  const adminKey = opts.adminKey;
  if (!baseUrl || !adminKey) throw new Error('baseUrl + adminKey required');
  const log = opts.log || (() => {});
  const tokensPath = opts.tokensPath || TOKENS_PATH;

  const errors: string[] = [];
  const plan: Array<[string, number]> = [
    ['honest-trader', counts.honest],
    ['quality-reviewer', counts.quality],
    ['rogue-disputer', counts.rogue],
    ['whale-buyer', counts.whale || 0],
    ['colluder', counts.colluder || 0],
    ['budget-trader', counts.budget || 0],
    ['specialist', counts.specialist || 0],
    ['newcomer', counts.newcomer || 0],
    ['rogue-spam', counts.rogueSpam || 0],
    ['market-maker', counts.mm || 0],
    ['conservative-buyer', counts.conservative || 0],
    ['opportunist', counts.opportunist || 0],
    ['researcher', counts.researcher || 0],
  ];

  // Preserve any non-targeted templates from existing tokens.json so a
  // partial re-seed doesn't wipe out other personas.
  const existing: SeededAgentBook = existsSync(tokensPath)
    ? (JSON.parse(readFileSync(tokensPath, 'utf-8')) as SeededAgentBook)
    : {};
  const book: SeededAgentBook = { ...existing };

  for (const [templateId, n] of plan) {
    const template = PERSONA_TEMPLATES[templateId];
    if (!template) {
      errors.push(`Unknown template ${templateId}`);
      continue;
    }
    const records: SeededAgentRecord[] = [];
    for (let i = 1; i <= n; i++) {
      const name = `sim-${template.namePrefix}-${i}`;
      try {
        log(`Seeding ${name} (kyaTier=${template.defaultKyaTier})...`);
        const record = await seedOne(baseUrl, adminKey, templateId, name, template.defaultKyaTier);
        records.push(record);
        // Register skills from the persona template
        const skillCount = template.skills?.length
          ? await registerSkills(baseUrl, record.token, record.agentId, template.skills)
          : 0;
        log(`  ✓ ${name} id=${record.agentId.slice(0, 8)} balance=$${record.balance} skills=${skillCount}`);
      } catch (e: any) {
        const msg = `${name}: ${e.message}`;
        errors.push(msg);
        log(`  ✗ ${msg}`);
      }
    }
    book[templateId] = records;
  }

  writeFileSync(tokensPath, JSON.stringify(book, null, 2));
  const total = Object.values(book).reduce((s, arr) => s + arr.length, 0);
  log(`Saved ${total} agents across ${Object.keys(book).length} templates to ${tokensPath}`);

  return { book, total, errors };
}
