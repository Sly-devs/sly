'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Clock,
  AlertTriangle,
  HandCoins,
  Zap,
  Plus,
  ToggleLeft,
  ToggleRight,
  Loader2,
  Trash2,
  Edit,
  History,
  X,
  ChevronRight,
  ArrowLeft,
} from 'lucide-react';
import { useApiConfig } from '@/lib/api-client';
import { toast } from 'sonner';
import { cn } from '@sly/ui';
import Link from 'next/link';

// Types
type TriggerType = 'schedule' | 'threshold' | 'manual' | 'immediate';
type SettlementRail = 'auto' | 'ach' | 'pix' | 'spei' | 'wire' | 'usdc';
type SettlementPriority = 'standard' | 'expedited';

interface Wallet {
  id: string;
  name: string | null;
  currency: string;
  balance: number;
  status: string;
  owner_account_id: string | null;
}

interface SettlementRule {
  id: string;
  tenant_id: string;
  wallet_id: string | null;
  name: string;
  description: string | null;
  trigger_type: TriggerType;
  trigger_config: Record<string, unknown>;
  settlement_rail: SettlementRail;
  settlement_priority: SettlementPriority;
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
  status: 'pending' | 'executing' | 'completed' | 'failed' | 'skipped';
  trigger_reason: string;
  trigger_context: Record<string, unknown>;
  amount: number | null;
  currency: string | null;
  settlement_rail: string | null;
  settlement_id: string | null;
  error_message: string | null;
  started_at: string;
  completed_at: string | null;
}

// Trigger type metadata
const TRIGGER_TYPES: Record<TriggerType, { icon: typeof Clock; label: string; description: string; color: string }> = {
  schedule: {
    icon: Clock,
    label: 'Schedule',
    description: 'Time-based settlement (cron expression)',
    color: 'text-blue-600 dark:text-blue-400',
  },
  threshold: {
    icon: AlertTriangle,
    label: 'Threshold',
    description: 'Balance threshold exceeded',
    color: 'text-amber-600 dark:text-amber-400',
  },
  manual: {
    icon: HandCoins,
    label: 'Manual',
    description: 'User-initiated withdrawal',
    color: 'text-purple-600 dark:text-purple-400',
  },
  immediate: {
    icon: Zap,
    label: 'Immediate',
    description: 'Auto-trigger on specific transfer types',
    color: 'text-green-600 dark:text-green-400',
  },
};

const SETTLEMENT_RAILS: { value: SettlementRail; label: string }[] = [
  { value: 'auto', label: 'Auto (Best Available)' },
  { value: 'ach', label: 'ACH (US Bank Transfer)' },
  { value: 'pix', label: 'Pix (Brazil Instant)' },
  { value: 'spei', label: 'SPEI (Mexico Bank)' },
  { value: 'wire', label: 'Wire (International)' },
  { value: 'usdc', label: 'USDC (On-chain)' },
];

// API functions
async function fetchRules(authToken: string, apiUrl: string): Promise<SettlementRule[]> {
  const response = await fetch(`${apiUrl}/v1/settlement-rules`, {
    headers: {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json',
    },
  });
  if (!response.ok) throw new Error('Failed to fetch rules');
  const json = await response.json();
  return json.data?.data || json.data || [];
}

async function createRule(authToken: string, apiUrl: string, rule: Partial<SettlementRule>): Promise<SettlementRule> {
  const response = await fetch(`${apiUrl}/v1/settlement-rules`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(rule),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to create rule');
  }
  const json = await response.json();
  return json.data || json;
}

async function updateRule(authToken: string, apiUrl: string, id: string, updates: Partial<SettlementRule>): Promise<SettlementRule> {
  const response = await fetch(`${apiUrl}/v1/settlement-rules/${id}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(updates),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to update rule');
  }
  const json = await response.json();
  return json.data || json;
}

async function deleteRule(authToken: string, apiUrl: string, id: string): Promise<void> {
  const response = await fetch(`${apiUrl}/v1/settlement-rules/${id}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json',
    },
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to delete rule');
  }
}

async function fetchExecutions(authToken: string, apiUrl: string, ruleId: string): Promise<RuleExecution[]> {
  const response = await fetch(`${apiUrl}/v1/settlement-rules/${ruleId}/executions?limit=20`, {
    headers: {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json',
    },
  });
  if (!response.ok) throw new Error('Failed to fetch executions');
  const json = await response.json();
  return json.data?.data || json.data || [];
}

async function fetchWallets(authToken: string, apiUrl: string): Promise<Wallet[]> {
  const response = await fetch(`${apiUrl}/v1/wallets?limit=100`, {
    headers: {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json',
    },
  });
  if (!response.ok) throw new Error('Failed to fetch wallets');
  const json = await response.json();
  return json.data?.data || json.data || [];
}

// Rule Card Component
function RuleCard({
  rule,
  wallets,
  onEdit,
  onToggle,
  onDelete,
  onViewHistory,
  isToggling,
}: {
  rule: SettlementRule;
  wallets: Wallet[];
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
  onViewHistory: () => void;
  isToggling: boolean;
}) {
  const triggerInfo = TRIGGER_TYPES[rule.trigger_type];
  const Icon = triggerInfo.icon;

  // Find wallet name if scoped to a specific wallet
  const scopedWallet = rule.wallet_id
    ? wallets.find(w => w.id === rule.wallet_id)
    : null;

  const formatTriggerConfig = () => {
    switch (rule.trigger_type) {
      case 'schedule':
        return `Cron: ${rule.trigger_config.cron || 'Not set'}`;
      case 'threshold':
        return `When balance >= ${((rule.trigger_config.amount as number) / 100).toFixed(2)} ${rule.trigger_config.currency}`;
      case 'immediate':
        return `On: ${(rule.trigger_config.transfer_types as string[])?.join(', ') || 'all transfers'}`;
      case 'manual':
        return 'User-initiated';
      default:
        return '';
    }
  };

  return (
    <div className="bg-white dark:bg-gray-950 rounded-xl border border-gray-200 dark:border-gray-800 p-5 hover:border-gray-300 dark:hover:border-gray-700 transition-colors">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3">
          <div className={cn(
            'w-10 h-10 rounded-lg flex items-center justify-center',
            'bg-gray-100 dark:bg-gray-800'
          )}>
            <Icon className={cn('w-5 h-5', triggerInfo.color)} />
          </div>
          <div>
            <h3 className="font-medium text-gray-900 dark:text-white">{rule.name}</h3>
            <p className="text-xs text-gray-500 dark:text-gray-400">{triggerInfo.label} trigger</p>
          </div>
        </div>

        <button
          onClick={onToggle}
          disabled={isToggling}
          className={cn(
            'p-1.5 rounded-lg transition-colors',
            rule.enabled
              ? 'text-green-600 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-950/50'
              : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800',
            isToggling && 'opacity-50'
          )}
        >
          {isToggling ? (
            <Loader2 className="w-5 h-5 animate-spin" />
          ) : rule.enabled ? (
            <ToggleRight className="w-5 h-5" />
          ) : (
            <ToggleLeft className="w-5 h-5" />
          )}
        </button>
      </div>

      {rule.description && (
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">{rule.description}</p>
      )}

      {/* Wallet Scope Badge */}
      <div className="mb-3">
        {rule.wallet_id ? (
          <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800">
            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" />
              <path d="M3 5v14a2 2 0 0 0 2 2h16v-5" />
              <path d="M18 12a2 2 0 0 0 0 4h4v-4Z" />
            </svg>
            {scopedWallet?.name || scopedWallet?.id.slice(0, 8) || 'Specific Wallet'}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium bg-purple-50 dark:bg-purple-950/50 text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-800">
            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <path d="M2 12h20" />
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
            </svg>
            All Wallets (Tenant-wide)
          </span>
        )}
      </div>

      <div className="text-xs text-gray-500 dark:text-gray-400 mb-3 space-y-1">
        <div>{formatTriggerConfig()}</div>
        <div>Rail: {SETTLEMENT_RAILS.find(r => r.value === rule.settlement_rail)?.label || rule.settlement_rail}</div>
        {rule.minimum_amount && (
          <div>Min: {(rule.minimum_amount / 100).toFixed(2)} {rule.minimum_currency || 'USD'}</div>
        )}
      </div>

      <div className="flex items-center justify-between pt-3 border-t border-gray-100 dark:border-gray-800">
        <span className={cn(
          'px-2 py-0.5 rounded text-xs font-medium',
          rule.enabled
            ? 'bg-green-50 dark:bg-green-950 text-green-600 dark:text-green-400'
            : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400'
        )}>
          {rule.enabled ? 'Active' : 'Disabled'}
        </span>

        <div className="flex items-center gap-1">
          <button
            onClick={onViewHistory}
            className="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"
            title="View history"
          >
            <History className="w-4 h-4" />
          </button>
          <button
            onClick={onEdit}
            className="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"
            title="Edit rule"
          >
            <Edit className="w-4 h-4" />
          </button>
          <button
            onClick={onDelete}
            className="p-1.5 text-gray-400 hover:text-red-600 dark:hover:text-red-400 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"
            title="Delete rule"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

// Create/Edit Rule Dialog
function RuleFormDialog({
  rule,
  wallets,
  onClose,
  onSave,
  isSaving,
}: {
  rule?: SettlementRule;
  wallets: Wallet[];
  onClose: () => void;
  onSave: (data: Partial<SettlementRule>) => void;
  isSaving: boolean;
}) {
  const isEdit = !!rule;
  const [name, setName] = useState(rule?.name || '');
  const [description, setDescription] = useState(rule?.description || '');
  const [triggerType, setTriggerType] = useState<TriggerType>(rule?.trigger_type || 'manual');
  const [settlementRail, setSettlementRail] = useState<SettlementRail>(rule?.settlement_rail || 'auto');
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [walletId, setWalletId] = useState<string>(rule?.wallet_id || '');

  // Trigger config
  const [cronExpression, setCronExpression] = useState(
    rule?.trigger_type === 'schedule' ? (rule.trigger_config.cron as string) || '' : ''
  );
  const [thresholdAmount, setThresholdAmount] = useState(
    rule?.trigger_type === 'threshold' ? String((rule.trigger_config.amount as number) / 100) : ''
  );
  const [thresholdCurrency, setThresholdCurrency] = useState(
    rule?.trigger_type === 'threshold' ? (rule.trigger_config.currency as string) || 'USD' : 'USD'
  );
  const [transferTypes, setTransferTypes] = useState(
    rule?.trigger_type === 'immediate' ? (rule.trigger_config.transfer_types as string[])?.join(', ') || '' : ''
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    let triggerConfig: Record<string, unknown> = {};
    switch (triggerType) {
      case 'schedule':
        triggerConfig = { cron: cronExpression };
        break;
      case 'threshold':
        triggerConfig = { amount: Math.round(parseFloat(thresholdAmount) * 100), currency: thresholdCurrency };
        break;
      case 'immediate':
        triggerConfig = { transfer_types: transferTypes.split(',').map(t => t.trim()).filter(Boolean) };
        break;
      case 'manual':
        triggerConfig = {};
        break;
    }

    onSave({
      name,
      description: description || undefined,
      trigger_type: triggerType,
      trigger_config: triggerConfig,
      settlement_rail: settlementRail,
      enabled,
      wallet_id: walletId || null,
    });
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-gray-950 rounded-2xl w-full max-w-lg max-h-[90vh] overflow-auto">
        <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-800">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
            {isEdit ? 'Edit Rule' : 'Create Settlement Rule'}
          </h2>
          <button
            onClick={onClose}
            className="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          {/* Name */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
              Rule Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Daily Settlement"
              className="w-full px-3 py-2 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white placeholder-gray-400 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              required
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
              Description (Optional)
            </label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What does this rule do?"
              className="w-full px-3 py-2 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white placeholder-gray-400 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          {/* Wallet Scope */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
              Applies To
            </label>
            <select
              value={walletId}
              onChange={(e) => setWalletId(e.target.value)}
              className="w-full px-3 py-2 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              <option value="">All Wallets (Tenant-wide)</option>
              {wallets.map((wallet) => (
                <option key={wallet.id} value={wallet.id}>
                  {wallet.name || `Wallet ${wallet.id.slice(0, 8)}`} ({wallet.currency} • ${(wallet.balance / 100).toFixed(2)})
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-gray-500">
              {walletId
                ? 'This rule will only apply to the selected wallet'
                : 'This rule will apply to all wallets in your organization'}
            </p>
          </div>

          {/* Trigger Type */}
          {!isEdit && (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Trigger Type
              </label>
              <div className="grid grid-cols-2 gap-3">
                {(Object.entries(TRIGGER_TYPES) as [TriggerType, typeof TRIGGER_TYPES['schedule']][]).map(([type, info]) => {
                  const Icon = info.icon;
                  return (
                    <button
                      key={type}
                      type="button"
                      onClick={() => setTriggerType(type)}
                      className={cn(
                        'p-3 rounded-lg border-2 text-left transition-colors',
                        triggerType === type
                          ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/50'
                          : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
                      )}
                    >
                      <Icon className={cn('w-5 h-5 mb-1.5', info.color)} />
                      <div className="font-medium text-sm text-gray-900 dark:text-white">{info.label}</div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">{info.description}</div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Trigger Config */}
          {triggerType === 'schedule' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                Cron Expression
              </label>
              <input
                type="text"
                value={cronExpression}
                onChange={(e) => setCronExpression(e.target.value)}
                placeholder="0 17 * * * (5pm daily)"
                className="w-full px-3 py-2 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white placeholder-gray-400 focus:ring-2 focus:ring-blue-500 focus:border-transparent font-mono"
                required
              />
              <p className="mt-1 text-xs text-gray-500">Format: minute hour day month weekday</p>
            </div>
          )}

          {triggerType === 'threshold' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                  Threshold Amount
                </label>
                <input
                  type="number"
                  value={thresholdAmount}
                  onChange={(e) => setThresholdAmount(e.target.value)}
                  placeholder="1000.00"
                  step="0.01"
                  min="0"
                  className="w-full px-3 py-2 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white placeholder-gray-400 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                  Currency
                </label>
                <select
                  value={thresholdCurrency}
                  onChange={(e) => setThresholdCurrency(e.target.value)}
                  className="w-full px-3 py-2 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                >
                  <option value="USD">USD</option>
                  <option value="BRL">BRL</option>
                  <option value="MXN">MXN</option>
                  <option value="USDC">USDC</option>
                </select>
              </div>
            </div>
          )}

          {triggerType === 'immediate' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                Transfer Types
              </label>
              <input
                type="text"
                value={transferTypes}
                onChange={(e) => setTransferTypes(e.target.value)}
                placeholder="payout, withdrawal"
                className="w-full px-3 py-2 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white placeholder-gray-400 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                required
              />
              <p className="mt-1 text-xs text-gray-500">Comma-separated list of transfer types</p>
            </div>
          )}

          {/* Settlement Rail */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
              Settlement Rail
            </label>
            <select
              value={settlementRail}
              onChange={(e) => setSettlementRail(e.target.value as SettlementRail)}
              className="w-full px-3 py-2 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              {SETTLEMENT_RAILS.map((rail) => (
                <option key={rail.value} value={rail.value}>{rail.label}</option>
              ))}
            </select>
          </div>

          {/* Enabled */}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setEnabled(!enabled)}
              className={cn(
                'p-1 rounded',
                enabled ? 'text-green-600 dark:text-green-400' : 'text-gray-400'
              )}
            >
              {enabled ? <ToggleRight className="w-6 h-6" /> : <ToggleLeft className="w-6 h-6" />}
            </button>
            <span className="text-sm text-gray-700 dark:text-gray-300">
              {enabled ? 'Rule enabled' : 'Rule disabled'}
            </span>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-4 border-t border-gray-200 dark:border-gray-800">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSaving || !name}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors flex items-center gap-2"
            >
              {isSaving && <Loader2 className="w-4 h-4 animate-spin" />}
              {isEdit ? 'Save Changes' : 'Create Rule'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// Execution History Dialog
function ExecutionHistoryDialog({
  rule,
  authToken,
  apiUrl,
  onClose,
}: {
  rule: SettlementRule;
  authToken: string;
  apiUrl: string;
  onClose: () => void;
}) {
  const { data: executions, isLoading } = useQuery({
    queryKey: ['settlement-rule-executions', rule.id],
    queryFn: () => fetchExecutions(authToken, apiUrl, rule.id),
  });

  const statusColors: Record<string, string> = {
    pending: 'bg-yellow-100 dark:bg-yellow-950 text-yellow-600 dark:text-yellow-400',
    executing: 'bg-blue-100 dark:bg-blue-950 text-blue-600 dark:text-blue-400',
    completed: 'bg-green-100 dark:bg-green-950 text-green-600 dark:text-green-400',
    failed: 'bg-red-100 dark:bg-red-950 text-red-600 dark:text-red-400',
    skipped: 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400',
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-gray-950 rounded-2xl w-full max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-800">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Execution History</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">{rule.name}</p>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-6">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
            </div>
          ) : !executions || executions.length === 0 ? (
            <div className="text-center py-12">
              <History className="w-12 h-12 text-gray-300 dark:text-gray-600 mx-auto mb-3" />
              <p className="text-gray-500 dark:text-gray-400">No executions yet</p>
            </div>
          ) : (
            <div className="space-y-3">
              {executions.map((exec) => (
                <div
                  key={exec.id}
                  className="p-4 bg-gray-50 dark:bg-gray-900 rounded-lg border border-gray-100 dark:border-gray-800"
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className={cn('px-2 py-0.5 rounded text-xs font-medium', statusColors[exec.status])}>
                      {exec.status}
                    </span>
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      {new Date(exec.started_at).toLocaleString()}
                    </span>
                  </div>
                  <div className="text-sm text-gray-600 dark:text-gray-400 space-y-1">
                    <div>Reason: {exec.trigger_reason}</div>
                    {exec.amount && (
                      <div>Amount: {(exec.amount / 100).toFixed(2)} {exec.currency}</div>
                    )}
                    {exec.settlement_rail && (
                      <div>Rail: {exec.settlement_rail}</div>
                    )}
                    {exec.error_message && (
                      <div className="text-red-600 dark:text-red-400">Error: {exec.error_message}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Main Page Component
export default function SettlementRulesPage() {
  const { isConfigured, isLoading: isAuthLoading, authToken, apiUrl } = useApiConfig();
  const queryClient = useQueryClient();

  // State
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [editingRule, setEditingRule] = useState<SettlementRule | null>(null);
  const [viewingHistoryRule, setViewingHistoryRule] = useState<SettlementRule | null>(null);
  const [togglingRuleId, setTogglingRuleId] = useState<string | null>(null);
  const [deletingRuleId, setDeletingRuleId] = useState<string | null>(null);

  // Fetch rules
  const { data: rules, isLoading: isLoadingRules } = useQuery({
    queryKey: ['settlement-rules'],
    queryFn: () => fetchRules(authToken!, apiUrl),
    enabled: !!authToken,
  });

  // Fetch wallets for scoping
  const { data: wallets = [] } = useQuery({
    queryKey: ['wallets'],
    queryFn: () => fetchWallets(authToken!, apiUrl),
    enabled: !!authToken,
  });

  // Create mutation
  const createMutation = useMutation({
    mutationFn: (rule: Partial<SettlementRule>) => createRule(authToken!, apiUrl, rule),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settlement-rules'] });
      setShowCreateDialog(false);
      toast.success('Rule created successfully');
    },
    onError: (error: Error) => {
      toast.error('Failed to create rule', { description: error.message });
    },
  });

  // Update mutation
  const updateMutation = useMutation({
    mutationFn: ({ id, updates }: { id: string; updates: Partial<SettlementRule> }) =>
      updateRule(authToken!, apiUrl, id, updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settlement-rules'] });
      setEditingRule(null);
      setTogglingRuleId(null);
      toast.success('Rule updated successfully');
    },
    onError: (error: Error) => {
      setTogglingRuleId(null);
      toast.error('Failed to update rule', { description: error.message });
    },
  });

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteRule(authToken!, apiUrl, id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settlement-rules'] });
      setDeletingRuleId(null);
      toast.success('Rule deleted');
    },
    onError: (error: Error) => {
      setDeletingRuleId(null);
      toast.error('Failed to delete rule', { description: error.message });
    },
  });

  const handleToggle = (rule: SettlementRule) => {
    setTogglingRuleId(rule.id);
    updateMutation.mutate({ id: rule.id, updates: { enabled: !rule.enabled } });
  };

  const handleDelete = (rule: SettlementRule) => {
    if (window.confirm(`Delete "${rule.name}"? This action cannot be undone.`)) {
      setDeletingRuleId(rule.id);
      deleteMutation.mutate(rule.id);
    }
  };

  // Loading state
  if (isAuthLoading || isLoadingRules) {
    return (
      <div className="p-8 max-w-[1200px] mx-auto">
        <div className="flex items-center gap-4 mb-8">
          <Link
            href="/dashboard/settings"
            className="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div>
            <div className="h-8 w-48 bg-gray-200 dark:bg-gray-800 rounded-lg animate-pulse mb-2" />
            <div className="h-4 w-64 bg-gray-200 dark:bg-gray-800 rounded animate-pulse" />
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="bg-white dark:bg-gray-950 rounded-xl border border-gray-200 dark:border-gray-800 p-5 animate-pulse">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 bg-gray-200 dark:bg-gray-800 rounded-lg" />
                <div>
                  <div className="h-5 w-28 bg-gray-200 dark:bg-gray-800 rounded mb-1" />
                  <div className="h-3 w-20 bg-gray-200 dark:bg-gray-800 rounded" />
                </div>
              </div>
              <div className="h-4 w-full bg-gray-200 dark:bg-gray-800 rounded mb-2" />
              <div className="h-4 w-2/3 bg-gray-200 dark:bg-gray-800 rounded" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Auth required state
  if (!isConfigured) {
    return (
      <div className="p-8">
        <div className="text-center py-12">
          <Clock className="h-12 w-12 text-gray-400 mx-auto mb-4" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Authentication Required</h2>
          <p className="text-gray-500 dark:text-gray-400 mt-2">Please log in to manage settlement rules.</p>
        </div>
      </div>
    );
  }

  // Group rules by type
  const rulesByType = (rules || []).reduce((acc, rule) => {
    if (!acc[rule.trigger_type]) acc[rule.trigger_type] = [];
    acc[rule.trigger_type].push(rule);
    return acc;
  }, {} as Record<TriggerType, SettlementRule[]>);

  return (
    <div className="p-8 max-w-[1200px] mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-4">
          <Link
            href="/dashboard/settings"
            className="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Settlement Rules</h1>
            <p className="text-gray-500 dark:text-gray-400">Configure when and how settlements are triggered</p>
          </div>
        </div>
        <button
          onClick={() => setShowCreateDialog(true)}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors"
        >
          <Plus className="w-4 h-4" />
          Create Rule
        </button>
      </div>

      {/* Rules Grid */}
      {!rules || rules.length === 0 ? (
        <div className="bg-gray-50 dark:bg-gray-900/50 rounded-2xl border border-gray-200 dark:border-gray-800 p-12 text-center">
          <Clock className="w-16 h-16 text-gray-300 dark:text-gray-600 mx-auto mb-4" />
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">No settlement rules</h3>
          <p className="text-gray-500 dark:text-gray-400 mb-6 max-w-md mx-auto">
            Create rules to automate when settlements are triggered based on schedules, balance thresholds, or transfer types.
          </p>
          <button
            onClick={() => setShowCreateDialog(true)}
            className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors"
          >
            <Plus className="w-4 h-4" />
            Create Your First Rule
          </button>
        </div>
      ) : (
        <div className="space-y-8">
          {(Object.entries(rulesByType) as [TriggerType, SettlementRule[]][]).map(([type, typeRules]) => {
            const triggerInfo = TRIGGER_TYPES[type];
            const Icon = triggerInfo.icon;
            return (
              <div key={type}>
                <div className="flex items-center gap-2 mb-4">
                  <Icon className={cn('w-5 h-5', triggerInfo.color)} />
                  <h2 className="font-semibold text-gray-900 dark:text-white">{triggerInfo.label} Rules</h2>
                  <span className="text-sm text-gray-400">({typeRules.length})</span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {typeRules.map((rule) => (
                    <RuleCard
                      key={rule.id}
                      rule={rule}
                      wallets={wallets}
                      onEdit={() => setEditingRule(rule)}
                      onToggle={() => handleToggle(rule)}
                      onDelete={() => handleDelete(rule)}
                      onViewHistory={() => setViewingHistoryRule(rule)}
                      isToggling={togglingRuleId === rule.id}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Create Dialog */}
      {showCreateDialog && (
        <RuleFormDialog
          wallets={wallets}
          onClose={() => setShowCreateDialog(false)}
          onSave={(data) => createMutation.mutate(data)}
          isSaving={createMutation.isPending}
        />
      )}

      {/* Edit Dialog */}
      {editingRule && (
        <RuleFormDialog
          rule={editingRule}
          wallets={wallets}
          onClose={() => setEditingRule(null)}
          onSave={(data) => updateMutation.mutate({ id: editingRule.id, updates: data })}
          isSaving={updateMutation.isPending}
        />
      )}

      {/* History Dialog */}
      {viewingHistoryRule && authToken && (
        <ExecutionHistoryDialog
          rule={viewingHistoryRule}
          authToken={authToken}
          apiUrl={apiUrl}
          onClose={() => setViewingHistoryRule(null)}
        />
      )}
    </div>
  );
}
