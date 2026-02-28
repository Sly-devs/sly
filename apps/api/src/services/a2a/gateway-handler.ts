/**
 * A2A Gateway JSON-RPC Handler
 *
 * Handles JSON-RPC requests at the platform gateway level (POST /a2a).
 * Provides agent discovery via `find_agent` and `list_agents` skills,
 * and agent onboarding via `register_agent`, `update_agent`, `get_my_status`.
 *
 * @see Epic 57: Google A2A Protocol Integration
 * @see Epic 60: A2A Agent Onboarding Skills
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { A2AJsonRpcRequest, A2AJsonRpcResponse, A2APart } from './types.js';
import { JSON_RPC_ERRORS } from './types.js';
import {
  handleRegisterAgent,
  handleUpdateAgent,
  handleGetMyStatus,
} from './onboarding-handler.js';

const DEFAULT_BASE_URL = process.env.API_BASE_URL || 'http://localhost:4000';

export interface GatewayAuthContext {
  tenantId: string;
  authType: 'api_key' | 'agent';
  agentId?: string;
  apiKeyId?: string;
}

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
  authContext?: GatewayAuthContext,
): Promise<A2AJsonRpcResponse> {
  const BASE_URL = baseUrl || DEFAULT_BASE_URL;
  try {
    switch (request.method) {
      case 'message/send':
        return await handleGatewayMessage(request, supabase, BASE_URL, authContext);
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
 * Interprets the caller's intent and routes to discovery or onboarding logic.
 */
async function handleGatewayMessage(
  request: A2AJsonRpcRequest,
  supabase: SupabaseClient,
  BASE_URL: string,
  authContext?: GatewayAuthContext,
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

  switch (intent.skill) {
    case 'list_agents': {
      const agents = await queryAgents(supabase, BASE_URL);
      return buildDiscoveryResponse(request.id, intent.skill, agents);
    }
    case 'find_agent': {
      const agents = await queryAgents(supabase, BASE_URL, intent.query, intent.tags);
      return buildDiscoveryResponse(request.id, intent.skill, agents);
    }
    case 'register_agent':
      return handleRegisterAgent(request.id, intent.payload || {}, supabase, BASE_URL, authContext);
    case 'update_agent':
      return handleUpdateAgent(request.id, intent.payload || {}, supabase, BASE_URL, authContext);
    case 'get_my_status':
      return handleGetMyStatus(request.id, supabase, BASE_URL, authContext);
    default:
      // Fallback: return platform capabilities
      return buildCapabilitiesResponse(request.id, BASE_URL);
  }
}

interface Intent {
  skill: 'find_agent' | 'list_agents' | 'register_agent' | 'update_agent' | 'get_my_status' | 'unknown';
  query?: string;
  tags?: string[];
  payload?: Record<string, unknown>;
}

const ONBOARDING_SKILLS = new Set(['register_agent', 'update_agent', 'get_my_status']);

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
      if (ONBOARDING_SKILLS.has(data.skill)) {
        return {
          skill: data.skill as Intent['skill'],
          payload: data,
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
 * Searches agent name, description, permission-derived tags, AND registered skills.
 */
async function queryAgents(
  supabase: SupabaseClient,
  baseUrl: string,
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

  // Fetch registered skills for all agents to enable skill-based search
  const agentIds = results.map((a) => a.id);
  const { data: allSkills } = await supabase
    .from('agent_skills')
    .select('agent_id, skill_id, name, tags')
    .in('agent_id', agentIds)
    .eq('status', 'active');

  // Build a map of agent_id → skill info for searching
  const skillsByAgent = new Map<string, Array<{ skill_id: string; name: string; tags: string[] }>>();
  if (allSkills?.length) {
    for (const s of allSkills) {
      const list = skillsByAgent.get(s.agent_id) || [];
      list.push({ skill_id: s.skill_id, name: s.name, tags: s.tags || [] });
      skillsByAgent.set(s.agent_id, list);
    }
  }

  // Filter by text query (search name, description, permission tags, AND registered skills)
  if (query) {
    const q = query.toLowerCase();
    results = results.filter((agent) => {
      const nameMatch = agent.name?.toLowerCase().includes(q);
      const descMatch = agent.description?.toLowerCase().includes(q);
      const permTags = extractSkillTags(agent);
      const permTagMatch = permTags.some((t) => t.toLowerCase().includes(q));

      // Search registered skills by skill_id, name, and tags
      const agentSkills = skillsByAgent.get(agent.id) || [];
      const skillMatch = agentSkills.some((s) =>
        s.skill_id.toLowerCase().includes(q) ||
        s.name.toLowerCase().includes(q) ||
        s.tags.some((t) => t.toLowerCase().includes(q)),
      );

      return nameMatch || descMatch || permTagMatch || skillMatch;
    });
  }

  // Filter by explicit tags
  if (tags?.length) {
    results = results.filter((agent) => {
      const permTags = extractSkillTags(agent);
      const agentSkills = skillsByAgent.get(agent.id) || [];
      const registeredTags = agentSkills.flatMap((s) => s.tags.map((t) => t.toLowerCase()));
      const allTags = [...permTags, ...registeredTags];
      return tags.some((t) => allTags.includes(t.toLowerCase()));
    });
  }

  // Build summaries including registered skill IDs
  return results.map((agent) => {
    const summary = agentToSummary(agent, baseUrl);
    const agentSkills = skillsByAgent.get(agent.id) || [];
    if (agentSkills.length) {
      // Replace permission-inferred skills with actual registered skills
      summary.skills = agentSkills.map((s) => s.skill_id);
    }
    return summary;
  });
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
function agentToSummary(agent: DiscoverableAgent, baseUrl: string): AgentSummary {
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
    cardUrl: `${baseUrl}/a2a/${agent.id}/.well-known/agent.json`,
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
  BASE_URL?: string,
): A2AJsonRpcResponse {
  const url = BASE_URL || DEFAULT_BASE_URL;
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
                message: 'This is the Sly platform gateway. Use the skills below to interact.',
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
                  {
                    id: 'register_agent',
                    description: 'Register a new agent (requires API key auth)',
                    usage: { data: { skill: 'register_agent', name: 'My Agent', skills: [{ id: 'my_skill', name: 'My Skill' }] } },
                  },
                  {
                    id: 'update_agent',
                    description: 'Update your agent profile (requires agent token auth)',
                    usage: { data: { skill: 'update_agent', name: 'Updated Name' } },
                  },
                  {
                    id: 'get_my_status',
                    description: 'Get your agent status, wallet, and limits (requires agent token auth)',
                    usage: { data: { skill: 'get_my_status' } },
                  },
                ],
                platformCardUrl: `${url}/.well-known/agent.json`,
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
