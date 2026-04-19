/**
 * @sly/sdk - Unified SDK for Sly multi-protocol settlement
 *
 * This SDK provides:
 * - x402 micropayments (Coinbase/Cloudflare)
 * - AP2 agent mandates (Google)
 * - ACP checkout (Stripe/OpenAI)
 * - Direct settlement API
 * - Pix/SPEI local rails
 *
 * @example Auto-routing (environment inferred from key prefix)
 * ```ts
 * const sly = new Sly({ apiKey: 'pk_test_...' });  // → sandbox.getsly.ai
 * const sly = new Sly({ apiKey: 'pk_live_...' });   // → api.getsly.ai
 * ```
 *
 * @example Explicit environment
 * ```ts
 * const sly = new Sly({
 *   apiKey: 'pk_live_...',
 *   environment: 'production',
 *   evmPrivateKey: '0x...',
 * });
 * ```
 */

import type { SlyConfig } from './types';
import { SlyClient } from './client';
import { inferEnvironmentFromKey } from './config';
import { SlyX402Client } from './protocols/x402/client';
import { SlyX402Provider } from './protocols/x402/provider';
import { AP2Client } from './protocols/ap2/client';
import { ACPClient } from './protocols/acp/client';
import { UCPClient } from './protocols/ucp/client';
import { CapabilitiesClient } from './capabilities';
import { LangChainTools } from './langchain/tools';
import { CardsClient } from './cards';
import { A2AClient } from './protocols/a2a/client';
import { AgentWalletsClient } from './protocols/agent-wallets/client';
import { MPPClient } from './protocols/mpp/client';
import { AgentsClient } from './agents/client';

/**
 * Main Sly SDK class
 *
 * Provides unified access to all Sly settlement protocols:
 * - x402 (micropayments)
 * - AP2 (agent mandates)
 * - ACP (checkout)
 * - UCP (universal commerce - Google+Shopify)
 * - Direct settlement API
 * - Capabilities discovery for AI agents
 */
export class Sly extends SlyClient {
  /**
   * x402 protocol client
   * Create x402 payments with automatic 402 handling
   */
  public readonly x402: {
    /**
     * Create an x402 client for making payments
     */
    createClient: (config?: Partial<SlyConfig>) => SlyX402Client;

    /**
     * Create an x402 provider for accepting payments
     */
    createProvider: (routes: Record<string, { price: string; description?: string; token?: string }>) => SlyX402Provider;
  };

  /**
   * AP2 (Agent-to-Agent Protocol) client
   * Google's mandate-based payment protocol
   */
  public readonly ap2: AP2Client;

  /**
   * ACP (Agentic Commerce Protocol) client
   * Stripe/OpenAI's checkout-based payment protocol
   */
  public readonly acp: ACPClient;

  /**
   * UCP (Universal Commerce Protocol) client
   * Google+Shopify's agentic commerce protocol
   */
  public readonly ucp: UCPClient;

  /**
   * Capabilities client for tool discovery
   * Enables AI agents to discover available Sly operations
   */
  public readonly capabilities: CapabilitiesClient;

  /**
   * LangChain tools integration
   */
  public readonly langchain: LangChainTools;

  /**
   * Card network integration (Visa VIC, Mastercard Agent Pay)
   * Accept payments from AI agents using Web Bot Auth
   */
  public readonly cards: CardsClient;

  /**
   * A2A (Agent-to-Agent Protocol) client
   * Google's task-based protocol for inter-agent communication
   */
  public readonly a2a: A2AClient;

  /**
   * Agent Wallets client
   * Contract policy evaluation, exposure tracking, wallet management
   */
  public readonly agentWallets: AgentWalletsClient;

  /**
   * MPP (Machine Payments Protocol) client
   * Governed machine-to-machine payments and streaming sessions
   */
  public readonly mpp: MPPClient;

  /**
   * Agents client - KYA tier management
   * Status checks, trust profiles, upgrades, DSD declarations, kill switch
   */
  public readonly agents: AgentsClient;

  constructor(config: SlyConfig) {
    // Validate API key
    if (!config.apiKey || config.apiKey.trim() === '') {
      throw new Error('API key is required');
    }

    // Resolve environment: explicit > inferred from key > default to sandbox
    const resolvedEnvironment = config.environment
      ?? inferEnvironmentFromKey(config.apiKey)
      ?? 'sandbox';
    const resolvedConfig = { ...config, environment: resolvedEnvironment };

    super(resolvedConfig);

    // Initialize x402 protocol helpers
    this.x402 = {
      createClient: (overrides?: Partial<SlyConfig>) => {
        return new SlyX402Client({
          ...resolvedConfig,
          ...overrides,
        });
      },
      createProvider: (routes) => {
        return new SlyX402Provider({
          apiKey: config.apiKey,
          environment: resolvedEnvironment,
          routes,
          facilitatorUrl: config.facilitatorUrl,
        });
      },
    };

    // Initialize protocol clients
    this.ap2 = new AP2Client(this);
    this.acp = new ACPClient(this);
    this.ucp = new UCPClient(this);

    // Initialize capabilities client
    this.capabilities = new CapabilitiesClient(this);

    // Initialize LangChain tools
    this.langchain = new LangChainTools(this);

    // Initialize Cards client
    this.cards = new CardsClient(this);

    // Initialize A2A client
    this.a2a = new A2AClient(this);

    // Initialize Agent Wallets client (Epic 18)
    this.agentWallets = new AgentWalletsClient(this);

    // Initialize MPP client (Epic 71)
    this.mpp = new MPPClient(this);

    // Initialize Agents client (Epic 73 — KYA tier management)
    this.agents = new AgentsClient(this);
  }
}

// Backward compatibility alias
export { Sly as PayOS };

// Export types
export * from './types';
export * from './config';
export * from './client';
export * from './auth';

