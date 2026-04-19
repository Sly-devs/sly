#!/usr/bin/env node
/**
 * marketplace-sim CLI
 *
 * Usage:
 *   pnpm sim run <scenario> [--mode <mode>] [--duration <time>] [--styles <list>]
 *
 * Examples:
 *   pnpm sim run competitive_review_real --mode api --duration 2m
 *   pnpm sim run rogue_injection_real --mode api --duration 3m
 *   pnpm sim run competitive_review_real --styles honest,quality-reviewer
 *
 * The agent pool comes from tokens.json — re-seed with `pnpm seed-personas`
 * to change pool counts.
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { Command } from 'commander';
import { PERSONA_TEMPLATES } from './personas/index.js';
import { SCENARIOS, startRun } from './runner.js';
import { loadSimAgents } from './agents/registry.js';
import type { SimAgent } from './processors/types.js';

// ─── Duration parsing ─────────────────────────────────────────────────────

function parseDuration(input: string): number {
  const m = input.match(/^(\d+)\s*(s|m|h|ms)?$/);
  if (!m) throw new Error(`Invalid duration: ${input}. Try 30s, 2m, 1h.`);
  const n = parseInt(m[1], 10);
  const unit = m[2] || 's';
  return unit === 'ms' ? n : unit === 's' ? n * 1000 : unit === 'm' ? n * 60000 : n * 3600000;
}

// ─── Main command ─────────────────────────────────────────────────────────

const program = new Command();

program
  .name('sim')
  .description('External marketplace simulation + validation runner for Sly')
  .version('0.1.0');

program
  .command('list')
  .description('List available scenarios')
  .action(() => {
    console.log('\nAvailable scenarios:\n');
    for (const [id, s] of Object.entries(SCENARIOS)) {
      console.log(`  ${id}`);
      console.log(`    ${s.description}`);
      console.log(`    requires: ${s.requires.join(', ')}\n`);
    }
  });

program
  .command('templates')
  .description('List available persona templates')
  .action(() => {
    console.log('\nAvailable persona templates:\n');
    for (const t of Object.values(PERSONA_TEMPLATES)) {
      console.log(`  ${t.id.padEnd(20)} ${t.role} (kyaTier ${t.defaultKyaTier})`);
    }
  });

program
  .command('agents')
  .description('List the seeded agent pool from tokens.json')
  .action(() => {
    try {
      const agents = loadSimAgents();
      console.log(`\nSeeded pool: ${agents.length} agents\n`);
      for (const a of agents) {
        console.log(`  ${a.name.padEnd(28)} ${a.style.padEnd(18)} $${a.balance} ${a.agentId.slice(0, 8)}`);
      }
    } catch (e: any) {
      console.error(e.message);
      process.exit(1);
    }
  });

program
  .command('run <scenario>')
  .description('Run a scenario against the configured Sly API')
  .option('-m, --mode <mode>', 'processor mode (scripted | api | subagent)', 'scripted')
  .option('-d, --duration <time>', 'how long to run (e.g. 30s, 2m, 5m)', '2m')
  .option(
    '-s, --styles <list>',
    'optional comma-separated style filter (honest,quality-reviewer,rogue-disputer,...)',
  )
  .action(async (scenarioId: string, opts: { mode: string; duration: string; styles?: string }) => {
    const scenario = SCENARIOS[scenarioId];
    if (!scenario) {
      console.error(`Unknown scenario: ${scenarioId}`);
      console.error(`Available: ${Object.keys(SCENARIOS).join(', ')}`);
      process.exit(1);
    }

    const durationMs = parseDuration(opts.duration);
    const styles = opts.styles
      ? (opts.styles.split(',').map((s) => s.trim()) as SimAgent['style'][])
      : undefined;

    let handle;
    try {
      handle = await startRun({
        scenarioId,
        mode: opts.mode as 'scripted' | 'api' | 'subagent',
        durationMs,
        styles,
      });
    } catch (e: any) {
      console.error(e.message);
      process.exit(1);
    }

    // Graceful shutdown on SIGINT
    let stopRequested = false;
    process.on('SIGINT', () => {
      if (stopRequested) {
        console.error('\nForce exit');
        process.exit(1);
      }
      console.error('\nStopping scenario gracefully (Ctrl+C again to force)...');
      stopRequested = true;
      handle.stop();
    });

    console.log(`\nsly: ${process.env.SLY_API_URL}`);
    console.log(`scenario: ${scenario.id} (${scenario.name})`);
    console.log(`mode: ${opts.mode}`);
    console.log(`duration: ${opts.duration} (${durationMs}ms)`);
    if (styles) console.log(`styles: ${styles.join(', ')}`);
    console.log();

    const result = await handle.done;

    console.log('\n─── Result ──────────────────────────────');
    console.log(`  completed trades: ${result.completedTrades}`);
    console.log(`  total volume:     $${result.totalVolume.toFixed(2)}`);
    console.log(`  findings:`);
    for (const f of result.findings) console.log(`    - ${f}`);
    console.log();
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
