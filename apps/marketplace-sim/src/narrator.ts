/**
 * Narrator — forwards scenario commentary, findings, and milestones to
 * the Sly platform so the live viewer can render them.
 *
 * This is the only "backdoor" into the viewer — everything else (task events,
 * mandates, settlements, wallet updates) flows through the real platform
 * lifecycle when marketplace-sim creates tasks via the public A2A endpoint.
 */

import type { SlyClient } from './sly-client.js';

export class Narrator {
  constructor(private sly: SlyClient, private prefix = '[sim]') {}

  async announce(scenario: string, description: string): Promise<void> {
    await this.sly.announce(scenario, description).catch((e) => {
      console.error(`${this.prefix} announce failed:`, e.message);
    });
  }

  async comment(text: string, type: 'info' | 'finding' | 'alert' | 'governance' = 'info'): Promise<void> {
    // Fire-and-forget — narrative failures shouldn't stop the scenario
    await this.sly.comment(text, type).catch((e) => {
      console.error(`${this.prefix} comment failed:`, e.message);
    });
    if (process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'info') {
      console.log(`${this.prefix} ${text}`);
    }
  }

  async milestone(
    text: string,
    opts: { agentId?: string; agentName?: string; icon?: string } = {},
  ): Promise<void> {
    await this.sly.milestone(text, opts).catch((e) => {
      console.error(`${this.prefix} milestone failed:`, e.message);
    });
    console.log(`${this.prefix} ★ ${text}`);
  }
}
