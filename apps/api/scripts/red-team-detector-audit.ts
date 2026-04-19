/**
 * Red-team audit of the collusion detector.
 *
 * Queries every sim agent that has at least one rating, fetches the
 * reputation (which now includes collusion signals + ring coefficient
 * and applies the service_quality penalty when flagged), and classifies
 * each agent as either ADVERSARIAL (persona is known to mis-behave:
 * ColluderBot, DisputeBot, SpamBot) or HONEST (everyone else).
 *
 * Outputs a confusion matrix so we can measure detector effectiveness
 * empirically and flag regressions.
 *
 * Usage:
 *   pnpm tsx apps/api/scripts/red-team-detector-audit.ts
 *   pnpm tsx apps/api/scripts/red-team-detector-audit.ts --tenant <uuid>
 *   pnpm tsx apps/api/scripts/red-team-detector-audit.ts --out docs/reports/...md
 *
 * Written 2026-04-19 after shipping v1+v2 collusion detection
 * (commits f67e2bd + 372efb4).
 */

import { config } from 'dotenv';
config();
import { createClient } from '@supabase/supabase-js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeCollusionSignals } from '../src/services/reputation/collusion-detector.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ADVERSARIAL_PREFIXES = new Set(['ColluderBot', 'DisputeBot', 'SpamBot']);

interface AgentRow {
  id: string;
  name: string;
  tenant_id: string;
}

interface AuditRow {
  name: string;
  id: string;
  expected: 'adversarial' | 'honest';
  totalRatings: number;
  uniqueRaters: number;
  topRaterShare: number;
  reciprocalRatio: number;
  ringCoefficient: number;
  flagged: boolean;
  reason: string | null;
  classification: 'TP' | 'FP' | 'FN' | 'TN';
}

function personaPrefix(name: string): string {
  return name.replace(/^sim-/, '').split('-')[0];
}

function isAdversarial(name: string): boolean {
  return ADVERSARIAL_PREFIXES.has(personaPrefix(name));
}

function cls(expected: 'adversarial' | 'honest', flagged: boolean): AuditRow['classification'] {
  if (expected === 'adversarial' && flagged)    return 'TP';
  if (expected === 'adversarial' && !flagged)   return 'FN';
  if (expected === 'honest'      && flagged)    return 'FP';
  return 'TN';
}

async function main() {
  const args = process.argv.slice(2);
  const tenantIdx = args.indexOf('--tenant');
  const outIdx = args.indexOf('--out');
  const tenantId = tenantIdx >= 0 ? args[tenantIdx + 1] : null;
  // Resolve the output path relative to the monorepo root so the script
  // works no matter which directory it's run from.
  const repoRoot = resolve(__dirname, '../../..');
  const rawOut = outIdx >= 0 ? args[outIdx + 1] : 'docs/reports/red-team-detector-audit.md';
  const outPath = resolve(repoRoot, rawOut);
  mkdirSync(dirname(outPath), { recursive: true });

  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  // 1. Gather sim agents that actually have ratings.
  let query = supabase
    .from('agents')
    .select('id, name, tenant_id')
    .ilike('name', 'sim-%')
    .eq('status', 'active');
  if (tenantId) query = query.eq('tenant_id', tenantId);

  const { data: agents } = await (query as any);
  const all = (agents ?? []) as AgentRow[];

  if (all.length === 0) {
    console.error('no sim agents found');
    process.exit(1);
  }

  console.log(`Scanning ${all.length} sim agents...`);
  console.log('Running collusion signals for each (skipping 0-rating agents)...\n');

  // Run the detector for every sim agent. Filter to those with ≥1 rating
  // from the signals themselves — doing it this way avoids the PostgREST
  // row-limit truncation that hid low-rating ColluderBots in our first cut.
  const rows: AuditRow[] = [];
  for (const a of all) {
    const signals = await computeCollusionSignals(supabase as any, a.id);
    if (signals.totalRatings === 0) continue;
    const expected = isAdversarial(a.name) ? 'adversarial' : 'honest';
    rows.push({
      name: a.name,
      id: a.id,
      expected,
      totalRatings: signals.totalRatings,
      uniqueRaters: signals.uniqueRaters,
      topRaterShare: signals.topRaterShare,
      reciprocalRatio: signals.reciprocalRatio,
      ringCoefficient: signals.ringCoefficient,
      flagged: signals.flagged,
      reason: signals.reason,
      classification: cls(expected, signals.flagged),
    });
  }
  console.log(`Agents with ≥1 rating: ${rows.length} / ${all.length}`);
  rows.sort((a, b) => (a.expected === b.expected ? a.name.localeCompare(b.name) : a.expected.localeCompare(b.expected)));

  // 3. Confusion matrix
  const summary = { TP: 0, FP: 0, FN: 0, TN: 0 };
  for (const r of rows) summary[r.classification]++;

  const adversarialRated = summary.TP + summary.FN;
  const honestRated = summary.FP + summary.TN;
  const recall    = adversarialRated > 0 ? summary.TP / adversarialRated : 0;
  const precision = (summary.TP + summary.FP) > 0 ? summary.TP / (summary.TP + summary.FP) : 0;
  const fpr       = honestRated > 0 ? summary.FP / honestRated : 0;

  console.log(`── Confusion matrix ──`);
  console.log(`  TP ${summary.TP}  FP ${summary.FP}`);
  console.log(`  FN ${summary.FN}  TN ${summary.TN}`);
  console.log(`  recall    = ${(recall * 100).toFixed(1)}%`);
  console.log(`  precision = ${(precision * 100).toFixed(1)}%`);
  console.log(`  FP rate   = ${(fpr * 100).toFixed(1)}%`);

  // 4. Markdown report
  const dateStr = new Date().toISOString().slice(0, 10);
  let md = `# Red-Team Detector Audit (${dateStr})\n\n`;
  md += `Empirical validation of the collusion detector (v1 + v2) shipped in commits \`f67e2bd\` and \`372efb4\`.\n\n`;
  md += `## Methodology\n\n`;
  md += `- Queried every \`sim-*\` agent with at least one row in \`a2a_task_feedback\` as the rated party.\n`;
  md += `- Classified by persona name: \`ColluderBot\`, \`DisputeBot\`, \`SpamBot\` = **adversarial** (expected to be flagged).\n`;
  md += `- Everything else (\`HonestBot\`, \`QualityReviewer\`, \`BudgetBot\`, ...) = **honest** (expected NOT flagged).\n`;
  md += `- Ran \`computeCollusionSignals\` for each and compared the \`flagged\` verdict to the expected label.\n\n`;

  md += `## Confusion matrix\n\n`;
  md += `| | **Flagged** | **Not flagged** |\n`;
  md += `|---|---|---|\n`;
  md += `| **Adversarial** | ${summary.TP} (TP) | ${summary.FN} (FN — missed) |\n`;
  md += `| **Honest**       | ${summary.FP} (FP — false flag) | ${summary.TN} (TN) |\n\n`;
  md += `- **Recall**    = ${(recall * 100).toFixed(1)}% (${summary.TP}/${adversarialRated} adversarial agents caught)\n`;
  md += `- **Precision** = ${(precision * 100).toFixed(1)}% (${summary.TP}/${summary.TP + summary.FP} flagged agents were truly adversarial)\n`;
  md += `- **FP rate**   = ${(fpr * 100).toFixed(1)}% (${summary.FP}/${honestRated} honest agents flagged in error)\n\n`;

  md += `## Per-agent results\n\n`;
  md += `| Agent | Expected | Ratings | Uniq / Top% / Recip% / Ring% | Flagged | Class | Reason |\n`;
  md += `|---|---|---|---|---|---|---|\n`;
  for (const r of rows) {
    md += `| \`${r.name}\` | ${r.expected} | ${r.totalRatings} |`;
    md += ` ${r.uniqueRaters} / ${Math.round(r.topRaterShare * 100)}% / ${Math.round(r.reciprocalRatio * 100)}% / ${Math.round(r.ringCoefficient * 100)}% |`;
    md += ` ${r.flagged ? '🚨' : '—'} | ${r.classification} |`;
    md += ` ${r.reason ?? ''} |\n`;
  }

  md += `\n## Known limitations\n\n`;
  md += `- **Name-based ground truth**: we assume persona prefix predicts intent. Fine for sim personas we control.\n`;
  md += `- **One-hop graph only**: ring coefficient looks at raters-of-raters. Multi-hop rings (A→B→C→A) aren't fully detected until a v3 Louvain/SCC pass.\n`;
  md += `- **Time-blind**: sudden rating-bomb spikes aren't caught yet.\n`;
  md += `- **Needs volume**: agents with 0–1 ratings are excluded from the audit.\n`;
  md += `\nRe-run this after each scenario round to track drift.\n`;

  writeFileSync(outPath, md);
  console.log(`\nReport written to ${outPath}`);
}

main().catch(err => {
  console.error('audit failed:', err);
  process.exit(1);
});
