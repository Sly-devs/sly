'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Clock,
  TrendingUp,
  Hand,
  Zap,
  Plus,
  Settings,
  Trash2,
  Play,
  CheckCircle,
  AlertCircle,
  XCircle,
  History,
  ChevronDown,
  X,
  Loader2,
} from 'lucide-react';
import { useApiConfig } from '@/lib/api-client';
import { toast } from 'sonner';
import { cn } from '@sly/ui';

// Types
type TriggerType = 'schedule' | 'threshold' | 'manual' | 'immediate';
type SettlementRail = 'auto' | 'ach' | 'pix' | 'spei' | 'wire' | 'usdc';
type ExecutionStatus = 'pending' | 'executing' | 'completed' | 'failed' | 'skipped';

interface SettlementRule {
  id: string;
  tenant_id: string;
  wallet_id: string | null;
  name: string;
  description: string | null;
  trigger_type: TriggerType;
  trigger_config: Record<string, unknown>;
  settlement_rail: SettlementRail;
  settlement_priority: 'standard' | 'expedited';
  minimum_amount: number | null;
  minimum_currency: string | null;
  maximum_amount: number | null;
  maximum_currency: string | null;
  enabled: boolean;
  priority: number;
  created_at: string;
  updated_at: string;
}

interface RuleExecution {
  id: string;
  rule_id: string;
  status: ExecutionStatus;
  trigger_reason: string;
  amount: number | null;
  currency: string | null;
  settlement_rail: string | null;
  error_message: string | null;
  started_at: string;
  completed_at: string | null;
}

// Trigger type info
const TRIGGER_INFO: Record<TriggerType, { icon: typeof Clock; label: string; description: string; color: string }> = {
  schedule: {
    icon: Clock,
    label: 'Schedule',
    description: 'Trigger at specific times (cron)',
    color: 'text-blue-600 dark:text-blue-400 bg-blue-100 dark:bg-blue-950',
  },
  threshold: {
    icon: TrendingUp,
    label: 'Threshold',
    description: 'Trigger when balance exceeds amount',
    color: 'text-green-600 dark:text-green-400 bg-green-100 dark:bg-green-950',
  },
  manual: {
    icon: Hand,
    label: 'Manual',
    description: 'Triggered by user request',
    color: 'text-purple-600 dark:text-purple-400 bg-purple-100 dark:bg-purple-950',
  },
  immediate: {
    icon: Zap,
    label: 'Immediate',
    description: 'Trigger on specific transfer types',
    color: 'text-orange-600 dark:text-orange-400 bg-orange-100 dark:bg-orange-950',
  },
};

const RAIL_LABELS: Record<SettlementRail, string> = {
  auto: 'Auto-select',
  ach: 'ACH (US)',
  pix: 'Pix (Brazil)',
  spei: 'SPEI (Mexico)',
  wire: 'Wire Transfer',
  usdc: 'USDC On-chain',
};

const STATUS_CONFIG: Record<ExecutionStatus, { icon: typeof CheckCircle; label: string; color: string }> = {
  pending: { icon: Clock, label: 'Pending', color: 'text-yellow-600 dark:text-yellow-400 bg-yellow-50 dark:bg-yellow-950' },
  executing: { icon: Loader2, label: 'Executing', color: 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950' },
  completed: { icon: CheckCircle, label: 'Completed', color: 'text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-950' },
  failed: { icon: XCircle, label: 'Failed', color: 'text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950' },
  skipped: { icon: AlertCircle, label: 'Skipped', color: 'text-gray-600 dark:text-gray-400 bg-gray-100 dark:bg-gray-800' },
};

// API functions
async function fetchRules(authToken: string, apiUrl: string): Promise<{ data: SettlementRule[] }> {
  const response = await fetch(`${apiUrl}/v1/settlement-rules`, {
    headers: { 'Authorization': `Bearer ${authToken}`, 'Content-Type': 'application/json' },
  });
  if (!response.ok) throw new Error('Failed to fetch rules');
  return response.json();
}

async function fetchExecutions(authToken: string, apiUrl: string): Promise<{ data: RuleExecution[] }> {
  const response = await fetch(`${apiUrl}/v1/settlement-rules/executions/all?limit=20`, {
    headers: { 'Authorization': `Bearer ${authToken}`, 'Content-Type': 'application/json' },
  });
  if (!response.ok) throw new Error('Failed to fetch executions');
  return response.json();
}

async function createRule(authToken: string, apiUrl: string, data: Partial<SettlementRule>): Promise<SettlementRule> {
  const response = await fetch(`${apiUrl}/v1/settlement-rules`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${authToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to create rule');
  }
  return response.json();
}

async function updateRule(authToken: string, apiUrl: string, id: string, data: Partial<SettlementRule>): Promise<SettlementRule> {
  const response = await fetch(`${apiUrl}/v1/settlement-rules/${id}`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${authToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to update rule');
  }
  return response.json();
}

async function deleteRule(authToken: string, apiUrl: string, id: string): Promise<void> {
  const response = await fetch(`${apiUrl}/v1/settlement-rules/${id}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${authToken}`, 'Content-Type': 'application/json' },
  });
  if (!response.ok) throw new Error('Failed to delete rule');
}

// Rule card component
function RuleCard({
  rule,
  onEdit,
  onDelete,
  onToggle,
  isDeleting,
}: {
  rule: SettlementRule;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: () => void;
  isDeleting: boolean;
}) {
  const info = TRIGGER_INFO[rule.trigger_type];
  const Icon = info.icon;

  const getTriggerSummary = () => {
    switch (rule.trigger_type) {
      case 'schedule':
        return `Cron: ${(rule.trigger_config as { cron?: string }).cron || 'Not set'}`;
      case 'threshold':
        const tc = rule.trigger_config as { amount?: number; currency?: string };
        return `Balance > ${tc.currency || 'USD'} ${((tc.amount || 0) / 100).toFixed(2)}`;
      case 'immediate':
        const types = (rule.trigger_config as { transfer_types?: string[] }).transfer_types || [];
        return `Types: ${types.join(', ') || 'None'}`;
      case 'manual':
        return 'User-initiated';
      default:
        return 'Unknown';
    }
  };

  return (
    <div className={cn(
      'bg-white dark:bg-gray-950 rounded-xl border border-gray-200 dark:border-gray-800 p-5',
      !rule.enabled && 'opacity-60'
    )}>
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3">
          <div className={cn('w-10 h-10 rounded-lg flex items-center justify-center', info.color)}>
            <Icon className="w-5 h-5" />
          </div>
          <div>
            <h3 className="font-semibold text-gray-900 dark:text-white">{rule.name}</h3>
            <span className={cn(
              'inline-flex items-center px-2 py-0.5 rounded text-xs font-medium',
              info.color
            )}>
              {info.label}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={onToggle}
            className={cn(
              'p-2 rounded-lg transition-colors',
              rule.enabled
                ? 'text-green-600 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-950/50'
                : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
            )}
            title={rule.enabled ? 'Disable rule' : 'Enable rule'}
          >
            <Play className="w-4 h-4" />
          </button>
          <button
            onClick={onEdit}
            className="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
            title="Edit rule"
          >
            <Settings className="w-4 h-4" />
          </button>
          <button
            onClick={onDelete}
            disabled={isDeleting}
            className="p-2 text-gray-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors disabled:opacity-50"
            title="Delete rule"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {rule.description && (
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">{rule.description}</p>
      )}

      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <div className="text-gray-500 dark:text-gray-400">Trigger</div>
          <div className="font-medium text-gray-900 dark:text-white">{getTriggerSummary()}</div>
        </div>
        <div>
          <div className="text-gray-500 dark:text-gray-400">Settlement Rail</div>
          <div className="font-medium text-gray-900 dark:text-white">{RAIL_LABELS[rule.settlement_rail]}</div>
        </div>
        {rule.minimum_amount && (
          <div>
            <div className="text-gray-500 dark:text-gray-400">Minimum</div>
            <div className="font-medium text-gray-900 dark:text-white">
              {rule.minimum_currency || 'USD'} {(rule.minimum_amount / 100).toFixed(2)}
            </div>
          </div>
        )}
        <div>
          <div className="text-gray-500 dark:text-gray-400">Priority</div>
          <div className="font-medium text-gray-900 dark:text-white">{rule.priority}</div>
        </div>
      </div>
    </div>
  );
}

// Create/Edit dialog
function RuleDialog({
  isOpen,
  onClose,
  onSave,
  rule,
  isSaving,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSave: (data: Partial<SettlementRule>) => void;
  rule?: SettlementRule;
  isSaving: boolean;
}) {
  const [name, setName] = useState(rule?.name || '');
  const [description, setDescription] = useState(rule?.description || '');
  const [triggerType, setTriggerType] = useState<TriggerType>(rule?.trigger_type || 'manual');
  const [triggerConfig, setTriggerConfig] = useState<Record<string, unknown>>(rule?.trigger_config || {});
  const [settlementRail, setSettlementRail] = useState<SettlementRail>(rule?.settlement_rail || 'auto');
  const [priority, setPriority] = useState(rule?.priority || 100);

  const handleSubmit = () => {
    if (!name.trim()) {
      toast.error('Name is required');
      return;
    }

    onSave({
      name,
      description: description || null,
      trigger_type: triggerType,
      trigger_config: triggerConfig,
      settlement_rail: settlementRail,
      priority,
    });
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
              {rule ? 'Edit Rule' : 'Create Settlement Rule'}
            </h2>
            <button onClick={onClose} className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg">
              <X className="w-5 h-5 text-gray-500" />
            </button>
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Name *</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., Daily Settlement"
                className="w-full px-4 py-2.5 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Description</label>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional description"
                className="w-full px-4 py-2.5 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {!rule && (
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Trigger Type *</label>
                <div className="grid grid-cols-2 gap-2">
                  {(Object.keys(TRIGGER_INFO) as TriggerType[]).map((type) => {
                    const info = TRIGGER_INFO[type];
                    const Icon = info.icon;
                    return (
                      <button
                        key={type}
                        type="button"
                        onClick={() => {
                          setTriggerType(type);
                          setTriggerConfig(type === 'manual' ? {} : type === 'schedule' ? { cron: '0 17 * * *' } : type === 'threshold' ? { amount: 100000, currency: 'USD' } : { transfer_types: ['payout'] });
                        }}
                        className={cn(
                          'flex items-center gap-2 p-3 rounded-lg border transition-colors text-left',
                          triggerType === type
                            ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/50'
                            : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
                        )}
                      >
                        <Icon className={cn('w-5 h-5', triggerType === type ? 'text-blue-600' : 'text-gray-400')} />
                        <div>
                          <div className="font-medium text-sm text-gray-900 dark:text-white">{info.label}</div>
                          <div className="text-xs text-gray-500 dark:text-gray-400">{info.description}</div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {triggerType === 'schedule' && (
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Cron Expression</label>
                <input
                  type="text"
                  value={(triggerConfig as { cron?: string }).cron || ''}
                  onChange={(e) => setTriggerConfig({ ...triggerConfig, cron: e.target.value })}
                  placeholder="0 17 * * * (5pm daily)"
                  className="w-full px-4 py-2.5 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                />
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Format: minute hour day month weekday</p>
              </div>
            )}

            {triggerType === 'threshold' && (
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Amount</label>
                  <input
                    type="number"
                    value={((triggerConfig as { amount?: number }).amount || 0) / 100}
                    onChange={(e) => setTriggerConfig({ ...triggerConfig, amount: parseFloat(e.target.value) * 100 })}
                    placeholder="1000.00"
                    className="w-full px-4 py-2.5 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Currency</label>
                  <select
                    value={(triggerConfig as { currency?: string }).currency || 'USD'}
                    onChange={(e) => setTriggerConfig({ ...triggerConfig, currency: e.target.value })}
                    className="w-full px-4 py-2.5 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="USD">USD</option>
                    <option value="BRL">BRL</option>
                    <option value="MXN">MXN</option>
                  </select>
                </div>
              </div>
            )}

            {triggerType === 'immediate' && (
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Transfer Types</label>
                <input
                  type="text"
                  value={((triggerConfig as { transfer_types?: string[] }).transfer_types || []).join(', ')}
                  onChange={(e) => setTriggerConfig({ ...triggerConfig, transfer_types: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
                  placeholder="payout, withdrawal"
                  className="w-full px-4 py-2.5 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Comma-separated list</p>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Settlement Rail</label>
              <select
                value={settlementRail}
                onChange={(e) => setSettlementRail(e.target.value as SettlementRail)}
                className="w-full px-4 py-2.5 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {(Object.keys(RAIL_LABELS) as SettlementRail[]).map((rail) => (
                  <option key={rail} value={rail}>{RAIL_LABELS[rail]}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Priority</label>
              <input
                type="number"
                value={priority}
                onChange={(e) => setPriority(parseInt(e.target.value) || 100)}
                min="0"
                max="1000"
                className="w-full px-4 py-2.5 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Lower number = higher priority</p>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 px-6 py-4 bg-gray-50 dark:bg-gray-800/50 border-t border-gray-200 dark:border-gray-700">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={isSaving || !name.trim()}
            className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isSaving ? 'Saving...' : rule ? 'Save Changes' : 'Create Rule'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Main page
export default function SettlementRulesPage() {
  const { isConfigured, isLoading: isAuthLoading, authToken, apiUrl } = useApiConfig();
  const queryClient = useQueryClient();
  const [showDialog, setShowDialog] = useState(false);
  const [editingRule, setEditingRule] = useState<SettlementRule | undefined>();
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  // Fetch rules
  const { data: rulesData, isLoading: isLoadingRules } = useQuery({
    queryKey: ['settlement-rules'],
    queryFn: () => fetchRules(authToken!, apiUrl),
    enabled: !!authToken,
  });

  // Fetch executions
  const { data: executionsData, isLoading: isLoadingExecutions } = useQuery({
    queryKey: ['settlement-executions'],
    queryFn: () => fetchExecutions(authToken!, apiUrl),
    enabled: !!authToken && showHistory,
  });

  // Create mutation
  const createMutation = useMutation({
    mutationFn: (data: Partial<SettlementRule>) => createRule(authToken!, apiUrl, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settlement-rules'] });
      toast.success('Rule created successfully');
      setShowDialog(false);
    },
    onError: (error: Error) => toast.error('Failed to create rule', { description: error.message }),
  });

  // Update mutation
  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<SettlementRule> }) => updateRule(authToken!, apiUrl, id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settlement-rules'] });
      toast.success('Rule updated successfully');
      setShowDialog(false);
      setEditingRule(undefined);
    },
    onError: (error: Error) => toast.error('Failed to update rule', { description: error.message }),
  });

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteRule(authToken!, apiUrl, id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settlement-rules'] });
      toast.success('Rule deleted');
      setDeletingId(null);
    },
    onError: (error: Error) => toast.error('Failed to delete rule', { description: error.message }),
  });

  const rules = rulesData?.data || [];
  const executions = executionsData?.data || [];

  const handleSave = (data: Partial<SettlementRule>) => {
    if (editingRule) {
      updateMutation.mutate({ id: editingRule.id, data });
    } else {
      createMutation.mutate(data);
    }
  };

  const handleEdit = (rule: SettlementRule) => {
    setEditingRule(rule);
    setShowDialog(true);
  };

  const handleToggle = (rule: SettlementRule) => {
    updateMutation.mutate({ id: rule.id, data: { enabled: !rule.enabled } });
  };

  // Stats
  const enabledCount = rules.filter(r => r.enabled).length;
  const byType = {
    schedule: rules.filter(r => r.trigger_type === 'schedule').length,
    threshold: rules.filter(r => r.trigger_type === 'threshold').length,
    manual: rules.filter(r => r.trigger_type === 'manual').length,
    immediate: rules.filter(r => r.trigger_type === 'immediate').length,
  };

  if (isAuthLoading || isLoadingRules) {
    return (
      <div className="p-8 max-w-[1600px] mx-auto">
        <div className="h-8 w-48 bg-gray-200 dark:bg-gray-800 rounded mb-8 animate-pulse" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map(i => (
            <div key={i} className="bg-white dark:bg-gray-950 rounded-xl border border-gray-200 dark:border-gray-800 p-6 animate-pulse">
              <div className="h-10 w-10 bg-gray-200 dark:bg-gray-800 rounded-lg mb-4" />
              <div className="h-5 w-32 bg-gray-200 dark:bg-gray-800 rounded mb-2" />
              <div className="h-4 w-full bg-gray-200 dark:bg-gray-800 rounded" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (!isConfigured) {
    return (
      <div className="p-8 text-center">
        <Settings className="h-12 w-12 text-gray-400 mx-auto mb-4" />
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Authentication Required</h2>
        <p className="text-gray-500 dark:text-gray-400 mt-2">Please log in to manage settlement rules.</p>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-[1600px] mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">Settlement Rules</h1>
          <p className="text-gray-600 dark:text-gray-400">Configure when and how settlements are triggered</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowHistory(!showHistory)}
            className={cn(
              'flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-colors',
              showHistory
                ? 'bg-blue-100 dark:bg-blue-950 text-blue-700 dark:text-blue-400'
                : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
            )}
          >
            <History className="h-4 w-4" />
            History
          </button>
          <button
            onClick={() => { setEditingRule(undefined); setShowDialog(true); }}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
          >
            <Plus className="h-4 w-4" />
            Create Rule
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-8">
        <div className="bg-white dark:bg-gray-950 rounded-xl border border-gray-200 dark:border-gray-800 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Total Rules</div>
          <div className="text-2xl font-bold text-gray-900 dark:text-white">{rules.length}</div>
        </div>
        <div className="bg-white dark:bg-gray-950 rounded-xl border border-gray-200 dark:border-gray-800 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Enabled</div>
          <div className="text-2xl font-bold text-green-600 dark:text-green-400">{enabledCount}</div>
        </div>
        <div className="bg-white dark:bg-gray-950 rounded-xl border border-gray-200 dark:border-gray-800 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Schedule</div>
          <div className="text-2xl font-bold text-blue-600 dark:text-blue-400">{byType.schedule}</div>
        </div>
        <div className="bg-white dark:bg-gray-950 rounded-xl border border-gray-200 dark:border-gray-800 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Threshold</div>
          <div className="text-2xl font-bold text-green-600 dark:text-green-400">{byType.threshold}</div>
        </div>
        <div className="bg-white dark:bg-gray-950 rounded-xl border border-gray-200 dark:border-gray-800 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Manual</div>
          <div className="text-2xl font-bold text-purple-600 dark:text-purple-400">{byType.manual}</div>
        </div>
      </div>

      {/* Rules Grid */}
      {rules.length === 0 ? (
        <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-12 text-center">
          <Settings className="h-16 w-16 text-gray-400 mx-auto mb-4" />
          <h3 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">No settlement rules</h3>
          <p className="text-gray-500 dark:text-gray-400 mb-6">Create your first rule to automate settlements</p>
          <button
            onClick={() => setShowDialog(true)}
            className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700"
          >
            <Plus className="h-4 w-4" />
            Create First Rule
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
          {rules.map(rule => (
            <RuleCard
              key={rule.id}
              rule={rule}
              onEdit={() => handleEdit(rule)}
              onDelete={() => deleteMutation.mutate(rule.id)}
              onToggle={() => handleToggle(rule)}
              isDeleting={deletingId === rule.id}
            />
          ))}
        </div>
      )}

      {/* Execution History */}
      {showHistory && (
        <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-800">
            <h3 className="font-semibold text-gray-900 dark:text-white">Recent Executions</h3>
          </div>
          {isLoadingExecutions ? (
            <div className="p-8 text-center">
              <Loader2 className="w-6 h-6 animate-spin mx-auto text-gray-400" />
            </div>
          ) : executions.length === 0 ? (
            <div className="p-8 text-center text-gray-500 dark:text-gray-400">
              No executions yet
            </div>
          ) : (
            <div className="divide-y divide-gray-200 dark:divide-gray-800">
              {executions.map(exec => {
                const status = STATUS_CONFIG[exec.status];
                const StatusIcon = status.icon;
                return (
                  <div key={exec.id} className="px-6 py-4 flex items-center justify-between">
                    <div className="flex items-center gap-4">
                      <span className={cn('inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium', status.color)}>
                        <StatusIcon className={cn('w-3.5 h-3.5', exec.status === 'executing' && 'animate-spin')} />
                        {status.label}
                      </span>
                      <div>
                        <div className="text-sm font-medium text-gray-900 dark:text-white">
                          {exec.trigger_reason}
                        </div>
                        <div className="text-xs text-gray-500 dark:text-gray-400">
                          {new Date(exec.started_at).toLocaleString()}
                        </div>
                      </div>
                    </div>
                    <div className="text-right">
                      {exec.amount && (
                        <div className="text-sm font-medium text-gray-900 dark:text-white">
                          {exec.currency || 'USD'} {(exec.amount / 100).toFixed(2)}
                        </div>
                      )}
                      {exec.settlement_rail && (
                        <div className="text-xs text-gray-500 dark:text-gray-400">
                          {RAIL_LABELS[exec.settlement_rail as SettlementRail] || exec.settlement_rail}
                        </div>
                      )}
                      {exec.error_message && (
                        <div className="text-xs text-red-600 dark:text-red-400">{exec.error_message}</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Create/Edit Dialog */}
      <RuleDialog
        isOpen={showDialog}
        onClose={() => { setShowDialog(false); setEditingRule(undefined); }}
        onSave={handleSave}
        rule={editingRule}
        isSaving={createMutation.isPending || updateMutation.isPending}
      />
    </div>
  );
}
