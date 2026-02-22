/**
 * A2A Gateway JSON-RPC Handler
 *
 * Handles JSON-RPC requests at the platform gateway level (POST /a2a).
 * Provides agent discovery via `find_agent` and `list_agents` skills.
 * Not tenant-scoped — shows all discoverable agents across tenants.
 *
 * @see Epic 57: Google A2A Protocol Integration
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { A2AJsonRpcRequest, A2AJsonRpcResponse, A2APart } from './types.js';
import { JSON_RPC_ERRORS } from './types.js';

const DEFAULT_BASE_URL = process.env.API_BASE_URL || 'http://localhost:4000';

interface DiscoverableAgent {
  id: string;
  name: string;
  description: string | null;
  status: string;
  kya_tier: number;
  permissions: Record<string, any> | null;
  parent_account_id: string;
}

interface AgentSummary {
  id: string;
  name: string;
  description: string | null;
  cardUrl: string;
  skills: string[];
}

/**
 * Handle a JSON-RPC request at the platform gateway.
 */
export async function handleGatewayJsonRpc(
  request: A2AJsonRpcRequest,
  supabase: SupabaseClient,
  baseUrl?: string,
): Promise<A2AJsonRpcResponse> {
  const BASE_URL = baseUrl || DEFAULT_BASE_URL;
  try {
    switch (request.method) {
      case 'message/send':
        return await handleGatewayMessage(request, supabase, BASE_URL);
      default:
        return {
          jsonrpc: '2.0',
          error: {
            code: JSON_RPC_ERRORS.METHOD_NOT_FOUND,
            message: `Method not found: ${request.method}. The gateway supports message/send for agent discovery.`,
          },
          id: request.id,
        };
    }
  } catch (error: any) {
    return {
      jsonrpc: '2.0',
      error: {
        code: JSON_RPC_ERRORS.INTERNAL_ERROR,
        message: error.message || 'Internal error',
      },
      id: request.id,
    };
  }
}

/**
 * Handle message/send at the gateway level.
 * Interprets the caller's intent and routes to discovery logic.
 */
async function handleGatewayMessage(
  request: A2AJsonRpcRequest,
  supabase: SupabaseClient,
  BASE_URL: string,
): Promise<A2AJsonRpcResponse> {
  const params = request.params || {};
  const message = params.message as { parts?: A2APart[] } | undefined;

  if (!message?.parts?.length) {
    return {
      jsonrpc: '2.0',
      error: {
        code: JSON_RPC_ERRORS.INVALID_PARAMS,
        message: 'message.parts is required and must not be empty',
      },
      id: request.id,
    };
  }

  // Extract intent from parts
  const intent = extractIntent(message.parts);

  let agents: AgentSummary[];

  switch (intent.skill) {
    case 'list_agents':
      agents = await queryAgents(supabase);
      break;
    case 'find_agent':
      agents = await queryAgents(supabase, intent.query, intent.tags);
      break;
    default:
      // Fallback: return platform capabilities
      return buildCapabilitiesResponse(request.id);
  }

  return buildDiscoveryResponse(request.id, intent.skill, agents);
}

interface Intent {
  skill: 'find_agent' | 'list_agents' | 'unknown';
  query?: string;
  tags?: string[];
}

/**
 * Extract the caller's intent from message parts.
 */
function extractIntent(parts: A2APart[]): Intent {
  for (const part of parts) {
    // Check for structured data part
    if ('data' in part && part.data) {
      const data = part.data as Record<string, any>;
      if (data.skill === 'list_agents') {
        return { skill: 'list_agents' };
      }
      if (data.skill === 'find_agent') {
        return {
          skill: 'find_agent',
          query: data.query as string | undefined,
          tags: data.tags as string[] | undefined,
        };
      }
    }

    // Check for text part — treat as a search query
    if ('text' in part && part.text) {
      return {
        skill: 'find_agent',
        query: part.text,
      };
    }
  }

  return { skill: 'unknown' };
}

/**
 * Query discoverable agents, optionally filtered by search query and tags.
 */
async function queryAgents(
  supabase: SupabaseClient,
  query?: string,
  tags?: string[],
): Promise<AgentSummary[]> {
  // Try with discoverable filter first; fall back if column doesn't exist yet
  let queryResult = await supabase
    .from('agents')
    .select('id, name, description, status, kya_tier, permissions, parent_account_id')
    .eq('status', 'active')
    .eq('discoverable', true)
    .order('name');

  // If the discoverable column doesn't exist yet, retry without it
  if (queryResult.error?.message?.includes('discoverable')) {
    queryResult = await supabase
      .from('agents')
      .select('id, name, description, status, kya_tier, permissions, parent_account_id')
      .eq('status', 'active')
      .order('name');
  }

  const { data: agents } = queryResult;

  if (!agents?.length) return [];

  let results = agents as DiscoverableAgent[];

  // Filter by text query (search name, description, and skill tags)
  if (query) {
    const q = query.toLowerCase();
    results = results.filter((agent) => {
      const nameMatch = agent.name?.toLowerCase().includes(q);
      const descMatch = agent.description?.toLowerCase().includes(q);
      const skillTags = extractSkillTags(agent);
      const tagMatch = skillTags.some((t) => t.toLowerCase().includes(q));
      return nameMatch || descMatch || tagMatch;
    });
  }

  // Filter by explicit tags
  if (tags?.length) {
    results = results.filter((agent) => {
      const skillTags = extractSkillTags(agent);
      return tags.some((t) => skillTags.includes(t.toLowerCase()));
    });
  }

  return results.map(agentToSummary);
}

/**
 * Extract skill tag strings from an agent's permissions.
 */
function extractSkillTags(agent: DiscoverableAgent): string[] {
  const tags: string[] = [];
  const perms = agent.permissions || {};

  if (perms.transactions) tags.push('payments', 'transactions');
  if (perms.streams) tags.push('streams', 'payments');
  if (perms.accounts) tags.push('accounts');
  if (perms.treasury) tags.push('treasury', 'wallets');

  return tags;
}

/**
 * Convert an agent record to a summary for discovery responses.
 */
function agentToSummary(agent: DiscoverableAgent): AgentSummary {
  const skillIds: string[] = [];
  const perms = agent.permissions || {};

  if (perms.transactions) skillIds.push('make_payment');
  if (perms.streams) skillIds.push('create_stream');
  if (perms.accounts) skillIds.push('lookup_account');
  if (perms.treasury) skillIds.push('manage_wallet');
  skillIds.push('agent_info');

  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    cardUrl: `${BASE_URL}/a2a/${agent.id}/.well-known/agent.json`,
    skills: skillIds,
  };
}

/**
 * Build a completed task response with discovery results.
 */
function buildDiscoveryResponse(
  requestId: string | number,
  skill: string,
  agents: AgentSummary[],
): A2AJsonRpcResponse {
  return {
    jsonrpc: '2.0',
    result: {
      id: crypto.randomUUID(),
      status: {
        state: 'completed',
        timestamp: new Date().toISOString(),
      },
      artifacts: [
        {
          artifactId: crypto.randomUUID(),
          name: `${skill}_results`,
          mediaType: 'application/json',
          parts: [
            {
              data: {
                agents,
                count: agents.length,
                skill,
              },
            },
          ],
        },
      ],
      history: [],
    },
    id: requestId,
  };
}

/**
 * Build a fallback response listing the gateway's capabilities.
 */
function buildCapabilitiesResponse(
  requestId: string | number,
): A2AJsonRpcResponse {
  return {
    jsonrpc: '2.0',
    result: {
      id: crypto.randomUUID(),
      status: {
        state: 'completed',
        timestamp: new Date().toISOString(),
      },
      artifacts: [
        {
          artifactId: crypto.randomUUID(),
          name: 'gateway_capabilities',
          mediaType: 'application/json',
          parts: [
            {
              data: {
                message: 'This is the Sly platform gateway. Use the skills below to discover agents.',
                availableSkills: [
                  {
                    id: 'find_agent',
                    description: 'Find agents by capability, region, or keyword',
                    usage: { data: { skill: 'find_agent', query: 'your search terms', tags: ['payments'] } },
                  },
                  {
                    id: 'list_agents',
                    description: 'List all publicly discoverable agents',
                    usage: { data: { skill: 'list_agents' } },
                  },
                ],
                platformCardUrl: `${BASE_URL}/.well-known/agent.json`,
              },
            },
          ],
        },
      ],
      history: [],
    },
    id: requestId,
  };
}
