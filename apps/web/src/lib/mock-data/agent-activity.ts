// Mock Agent Activity Data
// Future: Replace with API call to /v1/agents/:id/activity

export type AgentActionType =
  | 'transfer'
  | 'stream_create'
  | 'stream_topup'
  | 'stream_pause'
  | 'limit_check'
  | 'compliance_flag'
  | 'rebalance'
  | 'a2a_task';

export type AgentActionStatus = 'success' | 'failed' | 'pending';

export interface AgentAction {
  id: string;
  timestamp: string;
  type: AgentActionType;
  status: AgentActionStatus;
  description: string;
  details: {
    amount?: number;
    currency?: string;
    recipient?: string;
    reference?: string;
  };
  reasoning?: string; // AI explanation
}

export const mockAgentActivity: Record<string, AgentAction[]> = {
  // Default activity for Payroll Autopilot agent
  'agent-payroll-bot': [
    {
      id: 'act-1',
      timestamp: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5 min ago
      type: 'stream_create',
      status: 'success',
      description: 'Created salary stream to Maria Garcia',
      details: {
        amount: 2000,
        currency: 'USDC',
        recipient: 'Maria Garcia',
        reference: 'stream_abc123',
      },
      reasoning: 'Scheduled payroll execution for December. Recipient verified, within daily limits.',
    },
    {
      id: 'act-2',
      timestamp: new Date(Date.now() - 6 * 60 * 1000).toISOString(), // 6 min ago
      type: 'limit_check',
      status: 'success',
      description: 'Pre-transfer limit verification',
      details: {},
      reasoning: 'Daily usage: $4,200 of $10,000 limit. Monthly: $42,000 of $100,000. Approved.',
    },
    {
      id: 'act-3',
      timestamp: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(), // 4 hours ago
      type: 'stream_topup',
      status: 'success',
      description: 'Auto top-up for Carlos Martinez stream',
      details: {
        amount: 500,
        currency: 'USDC',
        reference: 'stream_def456',
      },
      reasoning: 'Stream runway fell below 7-day threshold. Auto top-up triggered per policy.',
    },
    {
      id: 'act-4',
      timestamp: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(), // 5 hours ago
      type: 'transfer',
      status: 'success',
      description: 'Bonus payment to Carlos Martinez',
      details: {
        amount: 500,
        currency: 'USDC',
        recipient: 'Carlos Martinez',
        reference: 'txn_xyz789',
      },
      reasoning: 'Quarterly bonus scheduled. Manager approval obtained via webhook.',
    },
    {
      id: 'act-5',
      timestamp: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), // 1 day ago
      type: 'compliance_flag',
      status: 'pending',
      description: 'Flagged transaction for review',
      details: {
        amount: 8500,
        reference: 'txn_review123',
      },
      reasoning: 'Transaction exceeds single-payment threshold for T1 recipient. Escalated for manual review.',
    },
  ],
  'agent-treasury': [
    {
      id: 'act-t1',
      timestamp: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(), // 8 hours ago
      type: 'rebalance',
      status: 'success',
      description: 'Rebalanced MXN corridor',
      details: {
        amount: 5000,
        currency: 'USDC',
      },
      reasoning: 'MXN corridor utilization at 92%. Moved funds from over-funded BRL corridor (43% utilization).',
    },
    {
      id: 'act-t2',
      timestamp: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(), // 12 hours ago
      type: 'limit_check',
      status: 'success',
      description: 'Daily treasury audit completed',
      details: {},
      reasoning: 'All corridors within operational bounds. Float levels healthy.',
    },
  ],
};

// Helper to get activity for any agent (falls back to payroll bot data)
export function getAgentActivity(agentId: string): AgentAction[] {
  return mockAgentActivity[agentId] || mockAgentActivity['agent-payroll-bot'];
}

