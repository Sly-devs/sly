/**
 * A2A Auto-Responder for Managed Agents
 *
 * When an A2A task arrives for a managed-mode agent that has no real backend,
 * this generates a skill-appropriate response using Claude and completes the task.
 *
 * Each agent gets a unique personality and responds based on their skills.
 * Falls back to structured responses if the Anthropic API is unavailable.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

interface PeerAgent {
  id: string;
  name: string;
  tenantId: string;
  skills: string[];
}

interface TaskContext {
  taskId: string;
  agentId: string;
  agentName: string;
  agentDescription?: string;
  skillId?: string;
  skillDescription?: string;
  messageText: string;
  callerAgentId?: string;
  callerName?: string;
  peerDirectory?: string;
  peerAgents?: PeerAgent[];
  supabase?: SupabaseClient;
}

// Agent personality profiles for richer AI responses
const AGENT_PERSONALITIES: Record<string, string> = {
  DataMiner: 'You are a data specialist who provides precise, numbers-heavy analysis. You cite sources, include confidence intervals, and present data in structured formats. You are direct and quantitative.',
  CodeSmith: 'You are a senior software engineer who writes clean, well-documented code. You explain your reasoning, flag potential issues, and suggest best practices. You are thorough and detail-oriented.',
  ResearchBot: 'You are a research analyst who synthesizes information from multiple sources. You present balanced perspectives, note limitations, and provide actionable recommendations. You are methodical.',
  TradingBot: 'You are a quantitative trader who thinks in risk/reward ratios. You provide entry/exit points, confidence levels, and position sizing. You are analytical and decisive.',
  ContentGen: 'You are a creative writer who produces compelling, brand-aligned copy. You adapt tone to the audience, suggest A/B variants, and optimize for engagement. You are creative and versatile.',
  AuditBot: 'You are a compliance auditor who is meticulous about security and regulatory requirements. You categorize findings by severity, provide remediation steps, and never cut corners. You are rigorous.',
  SupportBot: 'You are a customer support specialist who is empathetic, efficient, and solution-oriented. You diagnose issues quickly, provide clear resolution steps, and follow up. You are friendly and helpful.',
  AnalyticsBot: 'You are a business intelligence analyst who transforms raw data into actionable insights. You create clear visualizations descriptions, identify trends, and recommend actions. You are insightful.',
  SecurityBot: 'You are a cybersecurity expert who thinks like an attacker to defend better. You identify vulnerabilities, assess risk scores, and provide prioritized remediation plans. You are thorough and security-focused.',
  OpsBot: 'You are a DevOps engineer who values reliability, automation, and observability. You optimize for uptime, provide runbooks, and think about failure modes. You are systematic and pragmatic.',
};

/**
 * Generate an AI response for an incoming A2A task.
 * Uses Claude Haiku for speed and cost efficiency.
 * Falls back to structured responses if API is unavailable.
 */
export async function generateTaskResponse(ctx: TaskContext): Promise<string> {
  // Try Claude API first
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.log(`[AutoResponder] No ANTHROPIC_API_KEY — using fallback for ${ctx.agentName}`);
      return generateFallbackResponse(ctx);
    }

    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });

    const personality = AGENT_PERSONALITIES[ctx.agentName] ||
      `You are ${ctx.agentName}, a professional AI agent in the Sly marketplace.`;

    const systemPrompt = `${personality}

You are operating as "${ctx.agentName}" in the Sly agentic economy marketplace.
${ctx.agentDescription ? `Your description: ${ctx.agentDescription}` : ''}
${ctx.skillId ? `You are responding to a request for your "${ctx.skillId}" skill.` : ''}
${ctx.skillDescription ? `Skill description: ${ctx.skillDescription}` : ''}
${ctx.peerDirectory || ''}

IMPORTANT RULES:
- Respond as if you actually performed the work. Generate realistic, detailed output.
- Include specific numbers, findings, or deliverables — not vague promises.
- Keep responses concise but substantive (150-300 words).
- Format output professionally with bullet points or sections where appropriate.
- Do not mention that you are an AI or that this is simulated.
- Respond in the context of the agentic economy — crypto, stablecoins, DeFi, Web3, agent commerce.
- If you need input from a peer agent to complete this task well, mention what you would request and from whom. For example: "I would request market_data from DataMiner to supplement this analysis."
${ctx.callerName ? `The requesting agent is "${ctx.callerName}".` : ''}`;

    // Build tool definitions for multi-hop — let Claude call peers
    const tools: any[] = [];
    if (ctx.peerAgents && ctx.peerAgents.length > 0) {
      tools.push({
        name: 'a2a_send_task',
        description: 'Send a task to another agent in the Sly marketplace and wait for their response. Use this when you need data, analysis, or work from a peer agent to complete your task.',
        input_schema: {
          type: 'object' as const,
          properties: {
            agent_name: { type: 'string', description: 'Name of the peer agent to call (e.g., "DataMiner", "CodeSmith")' },
            message: { type: 'string', description: 'The task description / request to send to the peer agent' },
          },
          required: ['agent_name', 'message'],
        },
      });
    }

    // Multi-turn tool-use loop (max 3 hops to prevent infinite chains)
    const MAX_HOPS = 3;
    let messages: any[] = [{ role: 'user', content: ctx.messageText }];
    let finalText = '';

    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: systemPrompt,
        messages,
        ...(tools.length > 0 ? { tools } : {}),
      });

      // Collect text blocks
      const textBlocks = response.content
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map(block => block.text);
      if (textBlocks.length > 0) finalText += textBlocks.join('\n');

      // Check for tool use
      const toolUseBlocks = response.content.filter((block): block is any => block.type === 'tool_use');
      if (toolUseBlocks.length === 0 || response.stop_reason !== 'tool_use') break; // No more tool calls

      // Execute tool calls and build results
      const toolResults: any[] = [];
      for (const toolCall of toolUseBlocks) {
        if (toolCall.name === 'a2a_send_task' && ctx.peerAgents) {
          const targetName = toolCall.input?.agent_name as string;
          const taskMessage = toolCall.input?.message as string;
          const peer = ctx.peerAgents.find((p: any) => p.name.toLowerCase() === targetName.toLowerCase());

          if (peer && taskMessage) {
            console.log(`[AutoResponder] ${ctx.agentName} → ${peer.name}: multi-hop task`);
            try {
              const peerResult = await executeMultiHopTask(ctx.supabase!, peer.id, peer.tenantId, taskMessage, ctx.agentId, ctx.taskId);
              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolCall.id,
                content: peerResult || 'Peer agent did not return a response.',
              });
            } catch (err: any) {
              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolCall.id,
                content: `Error calling ${targetName}: ${err.message}`,
                is_error: true,
              });
            }
          } else {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolCall.id,
              content: `Agent "${targetName}" not found in peer directory.`,
              is_error: true,
            });
          }
        }
      }

      // Add assistant response + tool results for next turn
      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });
    }

    if (finalText) {
      console.log(`[AutoResponder] Claude response for ${ctx.agentName}/${ctx.skillId} (${finalText.length} chars)`);
      return finalText;
    }

    // Empty response — fall through to fallback
    console.warn(`[AutoResponder] Empty Claude response for ${ctx.agentName}/${ctx.skillId}`);
  } catch (err: any) {
    console.error(`[AutoResponder] Claude API error for ${ctx.agentName}:`, err.message);
  }

  return generateFallbackResponse(ctx);
}

/**
 * Execute a multi-hop task: create a child task to a peer agent and wait for completion.
 * Cross-tenant: creates the task in the TARGET agent's tenant.
 */
async function executeMultiHopTask(
  supabase: SupabaseClient,
  targetAgentId: string,
  targetTenantId: string,
  messageText: string,
  callerAgentId: string,
  parentTaskId: string,
): Promise<string> {
  const { A2ATaskService } = await import('./task-service.js');
  const { taskEventBus } = await import('./task-event-bus.js');

  // Create child task in the target agent's tenant
  const taskService = new A2ATaskService(supabase, targetTenantId);
  const childTask = await taskService.createTask(
    targetAgentId,
    {
      role: 'user',
      parts: [{ text: messageText }],
      metadata: { initiatingAgentId: callerAgentId, initiatingTaskId: parentTaskId, multiHop: true },
    },
    undefined, // new context
    'inbound',
  );

  console.log(`[MultiHop] Created child task ${childTask.id.slice(0, 8)} for agent ${targetAgentId.slice(0, 8)}`);

  // Wait for child task to complete (up to 45s — longer than single-hop)
  const WAIT_TIMEOUT = 45_000;
  const TERMINAL = new Set(['completed', 'failed', 'canceled', 'rejected']);

  const finalState = await new Promise<string | null>((resolve) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) { settled = true; unsub(); resolve(null); }
    }, WAIT_TIMEOUT);

    const unsub = taskEventBus.subscribe(childTask.id, (event) => {
      if (!settled && event.type === 'status' && TERMINAL.has(event.data.state as string)) {
        settled = true;
        clearTimeout(timer);
        unsub();
        resolve(event.data.state as string);
      }
    });

    if (TERMINAL.has(childTask.status.state)) {
      settled = true; clearTimeout(timer); unsub();
      resolve(childTask.status.state);
    }
  });

  // Fetch final task with messages
  const result = await taskService.getTask(childTask.id);
  if (!result) return 'Child task not found after completion.';

  // Extract agent response text from history
  const agentMessages = result.history
    .filter((m: any) => m.role === 'agent')
    .flatMap((m: any) => m.parts)
    .filter((p: any) => p.text)
    .map((p: any) => p.text);

  if (agentMessages.length > 0) {
    return agentMessages.join('\n');
  }

  if (!finalState) return 'Peer agent did not respond within 45 seconds.';
  return `Peer task ended in state: ${finalState}`;
}

/**
 * Fallback response when Claude API is unavailable.
 */
function generateFallbackResponse(ctx: TaskContext): string {
  const responses: Record<string, string> = {
    market_data: 'Market data report: BTC $68,420 (+2.1%), ETH $3,890 (+1.8%), SOL $178 (+3.2%). Total crypto market cap $2.8T. USDC supply stable at $33.2B.',
    sentiment_analysis: 'Sentiment analysis complete: Overall market sentiment is cautiously bullish (score: 72/100). Key drivers: institutional inflows (+$2.1B weekly), ETF approvals pending, regulatory clarity improving in EU.',
    code_review: 'Code review complete: 3 issues found — 1 potential SQL injection in query builder (HIGH), 1 missing input validation on amount field (MEDIUM), 1 unused import (LOW). Recommended: parameterize all queries, add Zod validation.',
    bug_fix: 'Bug fix applied: Root cause identified as race condition in concurrent wallet updates. Fix: added optimistic locking with version column check. Tests passing.',
    web_research: 'Research complete: Found 12 relevant sources. Key findings: agent-to-agent payment volume grew 340% in Q1 2026, Sly leads with 42% market share, followed by OpenClaw (28%) and PaymanAI (15%).',
    deep_analysis: 'Deep analysis report: The agentic economy is projected to reach $47B by 2028 (CAGR 89%). Key growth drivers: autonomous purchasing agents, API monetization via x402, and cross-platform settlement protocols.',
    trade_signal: 'Trade signal: BUY USDC/EURC at 0.92 (target 0.95, stop 0.90). Confidence: 78%. Based on: EUR monetary policy divergence, USDC demand from agent economy, technical breakout above 200-day MA.',
    portfolio_rebalance: 'Rebalance recommendation: Shift allocation to 60% USDC, 25% EURC, 15% stablecoins on Tempo. Rationale: reduce single-chain exposure, increase EURC for EU agent commerce growth.',
    copywriting: 'Copy delivered: "Power your AI agents with real money. Sly gives every agent a wallet, every skill a price, and every transaction on-chain settlement. Start building the agentic economy today."',
    translation: 'Translation complete (EN→ES): "Impulsa tus agentes de IA con dinero real. Sly le da a cada agente una billetera, a cada habilidad un precio, y a cada transacción liquidación en cadena."',
    contract_audit: 'Audit complete: Smart contract reviewed — 2 critical findings: (1) reentrancy vulnerability in withdraw() function, (2) missing access control on admin functions. Recommendation: implement ReentrancyGuard and role-based access.',
    risk_assessment: 'Risk assessment: Overall risk score 6.2/10 (MODERATE). Key risks: counterparty default risk (LOW), settlement delay risk (MEDIUM), regulatory risk (MEDIUM). Mitigation: escrow-based settlement, KYA verification tier 2+.',
    vulnerability_scan: 'Scan complete: 0 critical, 2 high, 5 medium vulnerabilities found. High: outdated TLS configuration (v1.1), exposed debug endpoint. Recommend: upgrade to TLS 1.3, remove /debug route in production.',
    pen_test: 'Penetration test report: Tested authentication, authorization, injection, and session management. 1 finding: API key rotation not enforced (MEDIUM). All other tests passed. Overall security posture: GOOD.',
    ticket_resolution: 'Ticket resolved: Issue was caused by stale JWT token cache. Cleared the cache and verified token refresh flow. User can now access the dashboard. Resolution time: 4 minutes.',
    escalation: 'Escalation processed: Ticket escalated to Tier 2 support. Priority: HIGH. Estimated resolution: 2 hours. Assigned to on-call engineer. Customer notified via email.',
    dashboard_report: 'Dashboard report generated: 142 transactions today ($2,847 volume), 23 active agents, 4 new registrations, avg response time 230ms. Top protocol: x402 (67% of volume).',
    data_viz: 'Visualization created: Bar chart showing agent transaction volume by protocol — x402: 67%, A2A: 18%, ACP: 10%, AP2: 5%. Trend line shows 12% week-over-week growth.',
    deploy: 'Deployment complete: v2.4.1 deployed to production. 0 downtime. Health checks passing. 3 new features: wallet payment for UCP, agent ratings, batch settlement. Rollback available.',
    monitoring: 'Monitoring setup complete: Alerts configured for >500ms p95 latency, >1% error rate, <99.5% uptime. Dashboards: API health, transaction volume, settlement pipeline. PagerDuty integration active.',
  };

  return responses[ctx.skillId || ''] || `Task "${ctx.skillId || 'general'}" processed successfully by ${ctx.agentName}. Request received and completed.`;
}

/**
 * Process an A2A task using the auto-responder.
 * Called by the task processor for managed-mode agents.
 */
export async function autoRespondToTask(
  supabase: SupabaseClient,
  taskId: string,
  agentId: string,
  messageText: string,
  skillId?: string,
): Promise<{ success: boolean; response: string }> {
  // Look up agent details
  const { data: agent } = await supabase
    .from('agents')
    .select('name, description')
    .eq('id', agentId)
    .single();

  // Look up skill details
  let skillDescription: string | undefined;
  if (skillId) {
    const { data: skill } = await supabase
      .from('agent_skills')
      .select('description')
      .eq('agent_id', agentId)
      .eq('skill_id', skillId)
      .maybeSingle();
    skillDescription = skill?.description;
  }

  // Look up caller details
  const { data: task } = await supabase
    .from('a2a_tasks')
    .select('caller_agent_id')
    .eq('id', taskId)
    .single();

  let callerName: string | undefined;
  if (task?.caller_agent_id) {
    const { data: caller } = await supabase
      .from('agents')
      .select('name')
      .eq('id', task.caller_agent_id)
      .single();
    callerName = caller?.name;
  }

  // Build peer directory — all active agents and their skills in the marketplace
  // This gives the agent awareness of who else exists and what they offer,
  // enabling multi-hop task chains (e.g., TradingBot calls DataMiner for data)
  let peerDirectory = '';
  let peerAgents: PeerAgent[] = [];
  try {
    const { data: allSkills } = await supabase
      .from('agent_skills')
      .select('agent_id, skill_id, name, base_price, currency, description')
      .eq('status', 'active')
      .limit(100);
    const { data: allAgents } = await supabase
      .from('agents')
      .select('id, name, description, tenant_id')
      .eq('status', 'active')
      .neq('id', agentId) // exclude self
      .limit(20);

    if (allAgents && allAgents.length > 0) {
      const agentSkillMap: Record<string, { name: string; desc?: string; tenantId: string; skills: string[] }> = {};
      for (const a of allAgents) {
        agentSkillMap[a.id] = { name: a.name, desc: a.description, tenantId: a.tenant_id, skills: [] };
      }
      for (const s of (allSkills || [])) {
        if (agentSkillMap[s.agent_id]) {
          agentSkillMap[s.agent_id].skills.push(`${s.skill_id} ($${s.base_price} ${s.currency || 'USDC'})`);
        }
      }

      // Build structured peer list for tool calls
      peerAgents = Object.entries(agentSkillMap)
        .filter(([, a]) => a.skills.length > 0)
        .map(([id, a]) => ({ id, name: a.name, tenantId: a.tenantId, skills: a.skills }));

      const lines = peerAgents.map(a =>
        `- ${a.name}: ${a.skills.join(', ')}${agentSkillMap[a.id]?.desc ? ' — ' + agentSkillMap[a.id].desc!.slice(0, 60) : ''}`
      );
      if (lines.length > 0) {
        peerDirectory = `\n\nAVAILABLE PEERS you can call via the a2a_send_task tool:
${lines.join('\n')}

If you need data, analysis, or capabilities from a peer to complete this task,
use the a2a_send_task tool with agent_name and your request message.
The peer will process your request and return their output, which you should
incorporate into your final response.`;
      }
    }
  } catch { /* peer directory is best-effort */ }

  const response = await generateTaskResponse({
    taskId,
    agentId,
    agentName: agent?.name || 'Agent',
    agentDescription: agent?.description,
    skillId,
    skillDescription,
    messageText,
    callerAgentId: task?.caller_agent_id,
    callerName,
    peerDirectory,
    peerAgents,
    supabase,
  });

  return { success: true, response };
}
