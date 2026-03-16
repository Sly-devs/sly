/**
 * A2A Agent Card Generator
 *
 * Generates A2A v1.0-compliant Agent Cards for registered Sly agents.
 * Maps agent permissions to A2A skills and declares payment capabilities.
 *
 * @see Epic 57: Google A2A Protocol Integration
 */

import type { A2AAgentCard, A2ASkill, A2AExtension } from './types.js';

/** Derive base URL from the request or fall back to env / localhost. */
function resolveBaseUrl(baseUrl?: string): string {
  return baseUrl || process.env.API_BASE_URL || 'http://localhost:4000';
}

/** Derive the public base URL from a Hono request context, respecting reverse proxies. */
export function getBaseUrlFromRequest(c: { req: { url: string; header: (name: string) => string | undefined } }): string {
  const url = new URL(c.req.url);
  const forwardedProto = c.req.header('x-forwarded-proto');
  const isLocalhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  const proto = forwardedProto || (isLocalhost ? 'http' : 'https');
  return `${proto}://${url.host}`;
}

interface AgentRecord {
  id: string;
  name: string;
  description?: string;
  status: string;
  kya_tier: number;
  permissions?: Record<string, string[]>;
}

interface AccountRecord {
  id: string;
  name: string;
}

interface WalletRecord {
  id: string;
  currency: string;
}

/** DB row from agent_skills table */
export interface DbSkill {
  skill_id: string;
  name: string;
  description?: string | null;
  input_modes?: string[];
  output_modes?: string[];
  tags?: string[];
  input_schema?: Record<string, unknown> | null;
  base_price: number;
  currency: string;
}

/**
 * Generate a per-agent A2A Agent Card from a Sly agent record.
 */
export function generateAgentCard(
  agent: AgentRecord,
  account: AccountRecord,
  wallet?: WalletRecord | null,
  baseUrl?: string,
  dbSkills?: DbSkill[],
): A2AAgentCard {
  const BASE_URL = resolveBaseUrl(baseUrl);
  const skills = buildSkills(agent, dbSkills);
  const extensions = buildExtensions(agent, wallet, BASE_URL);
  const endpointUrl = `${BASE_URL}/a2a/${agent.id}`;

  return {
    id: agent.id,
    name: agent.name,
    description: agent.description || `Sly agent managed by ${account.name}`,
    url: endpointUrl,
    version: '1.0.0',
    provider: {
      organization: 'Sly',
      url: 'https://sly.dev',
      contactEmail: 'support@sly.dev',
    },
    capabilities: {
      streaming: true,
      multiTurn: true,
      stateTransition: true,
    },
    defaultInputModes: ['text'],
    defaultOutputModes: ['text', 'data'],
    skills,
    supportedInterfaces: [
      {
        protocolBinding: 'jsonrpc/http',
        protocolVersion: '1.0',
        url: endpointUrl,
        contentTypes: ['application/json', 'application/a2a+json'],
      },
    ],
    securitySchemes: {
      sly_api_key: {
        type: 'apiKey',
        in: 'header',
        name: 'Authorization',
      },
      bearer: {
        type: 'http',
        scheme: 'bearer',
      },
    },
    security: [
      { sly_api_key: [] },
      { bearer: [] },
    ],
    extensions,
  };
}

/**
 * Generate the Sly platform Agent Card (for /.well-known/agent.json).
 */
export function generatePlatformCard(baseUrl?: string): A2AAgentCard {
  const BASE_URL = resolveBaseUrl(baseUrl);
  const endpointUrl = `${BASE_URL}/a2a`;

  return {
    id: 'sly-platform',
    name: 'Sly Payment Platform',
    description: 'Universal agentic payment orchestration for LATAM',
    url: endpointUrl,
    version: '1.0.0',
    provider: {
      organization: 'Sly',
      url: 'https://sly.dev',
      contactEmail: 'support@sly.dev',
    },
    capabilities: {
      streaming: true,
      multiTurn: true,
      stateTransition: true,
    },
    defaultInputModes: ['text'],
    defaultOutputModes: ['text', 'data'],
    skills: [
      {
        id: 'find_agent',
        name: 'Find Agent',
        description: 'Find a Sly agent by capability, region, or keyword',
        inputModes: ['text', 'data'],
        outputModes: ['data'],
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query (capability, region, keyword)' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Filter by skill tags' },
          },
        },
        tags: ['discovery', 'directory'],
      },
      {
        id: 'list_agents',
        name: 'List Agents',
        description: 'List all publicly discoverable Sly agents',
        inputModes: ['text'],
        outputModes: ['data'],
        tags: ['discovery', 'directory'],
      },
      {
        id: 'manage_wallet',
        name: 'Manage Wallet',
        description: 'Check balance or fund your agent wallet. Requires agent token auth.',
        inputModes: ['data'],
        outputModes: ['data'],
        inputSchema: {
          type: 'object',
          required: ['skill'],
          properties: {
            skill: { const: 'manage_wallet' },
            action: { type: 'string', enum: ['check_balance', 'fund'], description: 'Action to perform (default: check_balance)' },
            amount: { type: 'number', description: 'Amount to fund (required for fund action, max 100000)' },
            currency: { type: 'string', enum: ['USDC', 'EURC'], description: 'Currency (default: USDC)' },
          },
        },
        tags: ['wallets', 'stablecoin', 'onboarding'],
      },
      {
        id: 'register_agent',
        name: 'Register Agent',
        description: 'Register a new agent with wallet, skills, and endpoint in one shot. Requires API key auth.',
        inputModes: ['data'],
        outputModes: ['data'],
        inputSchema: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', description: 'Agent name' },
            description: { type: 'string', description: 'Agent description' },
            accountId: { type: 'string', format: 'uuid', description: 'Parent business account ID (auto-selects first if omitted)' },
            skills: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  description: { type: 'string' },
                  base_price: { type: 'number' },
                  currency: { type: 'string' },
                },
              },
              description: 'Skills to register',
            },
            endpoint: {
              type: 'object',
              properties: {
                url: { type: 'string', format: 'uri' },
                auth: { type: 'object' },
              },
              description: 'A2A endpoint configuration',
            },
          },
        },
        tags: ['onboarding', 'agents'],
      },
      {
        id: 'update_agent',
        name: 'Update Agent',
        description: 'Update your agent profile, skills, and endpoint. Requires agent token auth (self-sovereign).',
        inputModes: ['data'],
        outputModes: ['data'],
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Updated agent name' },
            description: { type: 'string', description: 'Updated description' },
            endpoint: {
              type: 'object',
              properties: {
                url: { type: 'string', format: 'uri' },
                auth: { type: 'object' },
              },
            },
            add_skills: {
              type: 'array',
              items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } },
              description: 'Skills to add or update',
            },
            remove_skills: {
              type: 'array',
              items: { type: 'string' },
              description: 'Skill IDs to remove',
            },
          },
        },
        tags: ['onboarding', 'agents'],
      },
      {
        id: 'get_my_status',
        name: 'Get My Status',
        description: 'Get your agent registration status, wallet balance, skills, and effective limits. Requires agent token auth.',
        inputModes: ['data'],
        outputModes: ['data'],
        tags: ['onboarding', 'agents'],
      },
      {
        id: 'check_task',
        name: 'Check Task',
        description: 'Poll the status of an A2A task by ID. Returns task state, message history, and artifacts. Requires agent token auth.',
        inputModes: ['data'],
        outputModes: ['data'],
        inputSchema: {
          type: 'object',
          required: ['skill', 'task_id'],
          properties: {
            skill: { const: 'check_task' },
            task_id: { type: 'string', format: 'uuid', description: 'The task ID to check' },
          },
        },
        tags: ['tasks', 'polling', 'agents'],
      },
      {
        id: 'verify_agent',
        name: 'Verify Agent',
        description: 'Upgrade agent KYA verification tier. Agent token auth = self-sovereign verification. API key auth = admin verification of any agent.',
        inputModes: ['data'],
        outputModes: ['data'],
        inputSchema: {
          type: 'object',
          required: ['skill'],
          properties: {
            skill: { const: 'verify_agent' },
            tier: { type: 'integer', minimum: 0, maximum: 3, description: 'Target KYA tier (default: 1)' },
            agent_id: { type: 'string', format: 'uuid', description: 'Agent to verify (required for API key auth, ignored for agent token)' },
          },
        },
        tags: ['onboarding', 'kya', 'verification', 'agents'],
      },
      {
        id: 'apply_for_beta',
        name: 'Apply for Beta Access',
        description: 'Apply for Sly closed beta access. Submit agent details to join the waitlist. No authentication required.',
        inputModes: ['data'],
        outputModes: ['data'],
        inputSchema: {
          type: 'object',
          required: ['name', 'email'],
          properties: {
            name: { type: 'string', description: 'Agent name' },
            email: { type: 'string', format: 'email', description: 'Contact email for the agent developer' },
            purpose: { type: 'string', description: 'What the agent does' },
            model: { type: 'string', description: 'AI model powering the agent (e.g. Claude, GPT-4)' },
          },
        },
        tags: ['onboarding', 'beta', 'agents'],
      },
    ],
    supportedInterfaces: [
      {
        protocolBinding: 'jsonrpc/http',
        protocolVersion: '1.0',
        url: endpointUrl,
        contentTypes: ['application/json', 'application/a2a+json'],
      },
    ],
    securitySchemes: {
      sly_api_key: {
        type: 'apiKey',
        in: 'header',
        name: 'Authorization',
      },
      bearer: {
        type: 'http',
        scheme: 'bearer',
      },
    },
    security: [
      { sly_api_key: [] },
      { bearer: [] },
    ],
    extensions: [
      {
        uri: 'urn:a2a:ext:agent-directory',
        data: {
          directoryEndpoint: `${BASE_URL}/a2a`,
          description: 'Send message/send to discover individual agents',
        },
      },
      {
        uri: 'urn:a2a:ext:x402',
        data: {
          currencies: ['USDC'],
          rails: ['x402', 'pix', 'spei'],
        },
      },
      {
        uri: 'urn:a2a:ext:ap2',
        data: {
          mandateEndpoint: `${BASE_URL}/v1/ap2/mandates`,
        },
      },
    ],
  };
}

/**
 * Check if a permission is enabled.
 * Permissions can be stored as:
 *   - { category: { perm: true } }  (object with boolean values)
 *   - { category: ['perm1', 'perm2'] }  (array of strings)
 */
function hasPerm(perms: Record<string, any>, category: string, perm: string): boolean {
  const cat = perms[category];
  if (!cat) return false;
  if (Array.isArray(cat)) return cat.includes(perm);
  if (typeof cat === 'object') return !!cat[perm];
  return false;
}

/**
 * Build A2A skills from DB rows only.
 * Agents must explicitly register skills — no permission-based fallback.
 * If the agent has no registered skills, the card shows an empty skill list.
 */
function buildSkills(_agent: AgentRecord, dbSkills?: DbSkill[]): A2ASkill[] {
  if (!dbSkills?.length) {
    return [];
  }

  return dbSkills.map((s) => ({
    id: s.skill_id,
    name: s.name,
    description: s.description
      ? `${s.description}${Number(s.base_price) > 0 ? ` Fee: ${s.base_price} ${s.currency}.` : ''}`
      : undefined,
    inputModes: s.input_modes || ['text'],
    outputModes: s.output_modes || ['text', 'data'],
    tags: s.tags || [],
    inputSchema: s.input_schema || undefined,
    base_price: Number(s.base_price) || 0,
    currency: s.currency || 'USDC',
  }));
}

/**
 * Build A2A extensions (payment capabilities).
 */
function buildExtensions(
  agent: AgentRecord,
  wallet?: WalletRecord | null,
  BASE_URL?: string,
): A2AExtension[] {
  const extensions: A2AExtension[] = [];

  // x402 payment extension for agents with wallets
  if (wallet) {
    extensions.push({
      uri: 'urn:a2a:ext:x402',
      data: {
        walletId: wallet.id,
        currency: wallet.currency,
        paymentEndpoint: `${BASE_URL}/v1/x402/pay`,
        verifyEndpoint: `${BASE_URL}/v1/x402/verify`,
      },
    });
  }

  // AP2 mandate extension
  extensions.push({
    uri: 'urn:a2a:ext:ap2',
    data: {
      mandateEndpoint: `${BASE_URL}/v1/ap2/mandates`,
      agentId: agent.id,
    },
  });

  return extensions;
}
