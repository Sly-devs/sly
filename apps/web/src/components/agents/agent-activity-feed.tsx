'use client';

import { useState } from 'react';
import { cn, formatCurrency, formatRelativeTime } from '@sly/ui';
import type { AgentAction, AgentActionType } from '@/lib/mock-data/agent-activity';

const actionIcons: Record<AgentActionType, string> = {
  transfer: '💸',
  stream_create: '🌊',
  stream_topup: '⬆️',
  stream_pause: '⏸️',
  limit_check: '✓',
  compliance_flag: '🚩',
  rebalance: '⚖️',
  a2a_task: '🤖',
};

const actionLabels: Record<AgentActionType, string> = {
  transfer: 'Transfer',
  stream_create: 'Stream Created',
  stream_topup: 'Stream Top-up',
  stream_pause: 'Stream Paused',
  limit_check: 'Limit Check',
  compliance_flag: 'Compliance Flag',
  rebalance: 'Rebalance',
  a2a_task: 'A2A Task',
};

interface AgentActivityFeedProps {
  activities: AgentAction[];
  showFilters?: boolean;
}

export function AgentActivityFeed({ activities, showFilters = true }: AgentActivityFeedProps) {
  const [filter, setFilter] = useState<AgentActionType | 'all'>('all');

  const filteredActivities = filter === 'all' 
    ? activities 
    : activities.filter(a => a.type === filter);

  const actionTypes = Array.from(new Set(activities.map(a => a.type)));

  return (
    <div className="space-y-4">
      {/* Filters */}
      {showFilters && actionTypes.length > 1 && (
        <div className="flex flex-wrap gap-2 mb-4">
          <button
            onClick={() => setFilter('all')}
            className={cn(
              "px-3 py-1.5 text-sm font-medium rounded-full transition-colors",
              filter === 'all'
                ? "bg-gray-900 dark:bg-white text-white dark:text-gray-900"
                : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
            )}
          >
            All
          </button>
          {actionTypes.map((type) => (
            <button
              key={type}
              onClick={() => setFilter(type)}
              className={cn(
                "px-3 py-1.5 text-sm font-medium rounded-full transition-colors flex items-center gap-1",
                filter === type
                  ? "bg-gray-900 dark:bg-white text-white dark:text-gray-900"
                  : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
              )}
            >
              <span>{actionIcons[type]}</span>
              {actionLabels[type]}
            </button>
          ))}
        </div>
      )}

      {/* Activity List */}
      {filteredActivities.length === 0 ? (
        <div className="text-center py-8 text-gray-500 dark:text-gray-400">
          No activities found
        </div>
      ) : (
        <div className="space-y-3">
          {filteredActivities.map((activity) => (
            <ActivityItem key={activity.id} activity={activity} />
          ))}
        </div>
      )}
    </div>
  );
}

function ActivityItem({ activity }: { activity: AgentAction }) {
  const [showReasoning, setShowReasoning] = useState(true);

  return (
    <div 
      className={cn(
        "p-4 rounded-xl border transition-colors",
        activity.status === 'failed' && "border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30",
        activity.status === 'pending' && "border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30",
        activity.status === 'success' && "border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950",
      )}
    >
      <div className="flex items-start gap-3">
        <span className="text-xl flex-shrink-0">{actionIcons[activity.type]}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2 mb-1">
            <h4 className="font-medium text-gray-900 dark:text-white">
              {activity.description}
            </h4>
            <span className="text-xs text-gray-500 dark:text-gray-400 flex-shrink-0">
              {formatRelativeTime(activity.timestamp)}
            </span>
          </div>
          
          {/* Details */}
          {activity.details.amount && (
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {formatCurrency(activity.details.amount, activity.details.currency || 'USD')}
              {activity.details.recipient && (
                <span> → {activity.details.recipient}</span>
              )}
            </p>
          )}
          
          {/* AI Reasoning - Key differentiator */}
          {activity.reasoning && showReasoning && (
            <div className="mt-3 p-3 bg-gradient-to-r from-blue-50 to-purple-50 dark:from-blue-950/30 dark:to-purple-950/30 rounded-lg border border-blue-100 dark:border-blue-900">
              <div className="flex items-start gap-2">
                <span className="text-sm">🤖</span>
                <div>
                  <span className="text-xs font-medium text-blue-700 dark:text-blue-400 uppercase tracking-wider">
                    AI Reasoning
                  </span>
                  <p className="text-sm text-gray-700 dark:text-gray-300 mt-1">
                    {activity.reasoning}
                  </p>
                </div>
              </div>
            </div>
          )}
          
          {/* Status and Reference */}
          <div className="mt-3 flex items-center gap-3">
            <StatusBadge status={activity.status} />
            {activity.details.reference && (
              <code className="text-xs text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded">
                {activity.details.reference}
              </code>
            )}
            {activity.reasoning && (
              <button
                onClick={() => setShowReasoning(!showReasoning)}
                className="text-xs text-blue-600 dark:text-blue-400 hover:underline ml-auto"
              >
                {showReasoning ? 'Hide' : 'Show'} reasoning
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: 'success' | 'failed' | 'pending' }) {
  const styles = {
    success: 'bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-400',
    failed: 'bg-red-100 dark:bg-red-950 text-red-700 dark:text-red-400',
    pending: 'bg-amber-100 dark:bg-amber-950 text-amber-700 dark:text-amber-400',
  };

  const labels = {
    success: '✓ Success',
    failed: '✗ Failed',
    pending: '⏳ Pending',
  };

  return (
    <span className={cn('px-2 py-0.5 text-xs font-medium rounded-full', styles[status])}>
      {labels[status]}
    </span>
  );
}

