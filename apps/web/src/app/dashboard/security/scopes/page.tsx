/**
 * Epic 82, Story 82.5 — Dashboard: Scope Grants & Pending Requests.
 *
 * Tenant-owner surface for the elevated-permission lifecycle:
 *   - See active standing/one_shot grants with revoke
 *   - See pending agent-side scope requests with approve/deny
 *   - Issue a standing grant directly (no agent request)
 *   - Recent audit trail with agent + action filters and search
 *
 * Backed by /v1/organization/scopes (issue / list / revoke / decide / audit).
 */

'use client';

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useApiConfig, useApiFetch } from '@/lib/api-client';
import {
  Shield,
  AlertTriangle,
  Check,
  X,
  Trash2,
  Loader2,
  Bot,
  Clock,
  Plus,
  RefreshCw,
  Search,
  ChevronDown,
} from 'lucide-react';
import { toast } from 'sonner';
import { Popover, PopoverContent, PopoverTrigger } from '@sly/ui';

type Scope = 'tenant_read' | 'tenant_write' | 'treasury';
type Lifecycle = 'one_shot' | 'standing';

interface ActiveGrant {
  id: string;
  agent_id: string;
  agent_name?: string | null;
  scope: Scope;
  lifecycle: Lifecycle;
  status: 'active' | 'consumed' | 'revoked' | 'expired';
  purpose: string;
  granted_by_user_id: string | null;
  granted_at: string;
  expires_at: string;
  last_used_at: string | null;
  use_count: number;
  environment?: 'test' | 'live' | null;
}

type AuditAction =
  | 'scope_requested'
  | 'scope_granted'
  | 'scope_denied'
  | 'scope_used'
  | 'scope_expired'
  | 'scope_revoked'
  | 'scope_heartbeat';

interface AuditEvent {
  id: string;
  grant_id: string | null;
  agent_id: string | null;
  scope: Scope | null;
  action: AuditAction;
  actor_type: 'user' | 'agent' | 'system' | 'api_key';
  actor_id: string | null;
  request_summary: Record<string, unknown> | null;
  created_at: string;
}

interface AgentMini {
  id: string;
  name: string;
  environment?: 'test' | 'live';
  status?: string;
}

const SCOPE_COLORS: Record<Scope, string> = {
  tenant_read: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200',
  tenant_write: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200',
  treasury: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200',
};

const ACTION_COLORS: Record<AuditAction, string> = {
  scope_requested: 'text-slate-600 dark:text-slate-300',
  scope_granted: 'text-green-600 dark:text-green-400',
  scope_denied: 'text-red-600 dark:text-red-400',
  scope_used: 'text-blue-600 dark:text-blue-400',
  scope_expired: 'text-slate-500 dark:text-slate-400',
  scope_revoked: 'text-orange-600 dark:text-orange-400',
  scope_heartbeat: 'text-slate-400',
};

const ACTION_LABELS: Record<AuditAction, string> = {
  scope_requested: 'Requested',
  scope_granted: 'Granted',
  scope_denied: 'Denied',
  scope_used: 'Used',
  scope_expired: 'Expired',
  scope_revoked: 'Revoked',
  scope_heartbeat: 'Heartbeat',
};

const ALL_ACTIONS: AuditAction[] = [
  'scope_requested',
  'scope_granted',
  'scope_denied',
  'scope_used',
  'scope_revoked',
  'scope_expired',
];

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

function formatRemaining(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'expired';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s left`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m left`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h left`;
  return `${Math.round(ms / 86_400_000)}d left`;
}

export default function ScopesPage() {
  const apiFetch = useApiFetch();
  const { isConfigured, isLoading: authLoading, apiUrl, apiEnvironment } = useApiConfig();
  const queryClient = useQueryClient();

  const ready = isConfigured && !authLoading;

  // Filter state for the audit feed.
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(new Set());
  const [selectedActions, setSelectedActions] = useState<Set<AuditAction>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [issueModalOpen, setIssueModalOpen] = useState(false);
  // Epic 82 Story 82.10 — pending typed-confirmation for elevated approve.
  const [confirmApproval, setConfirmApproval] = useState<{
    requestId: string;
    agentId: string | null;
    agentName: string;
    scope: Scope;
  } | null>(null);

  async function unwrap<T>(res: Response): Promise<T> {
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    return (json?.data ?? json) as T;
  }

  const grantsQuery = useQuery({
    queryKey: ['org', 'scopes', 'active'],
    queryFn: async () => {
      const res = await apiFetch(`${apiUrl}/v1/organization/scopes`);
      return unwrap<{ grants: ActiveGrant[] }>(res);
    },
    enabled: ready,
    refetchInterval: 30_000,
  });

  const auditQuery = useQuery({
    queryKey: ['org', 'scopes', 'audit'],
    queryFn: async () => {
      const res = await apiFetch(`${apiUrl}/v1/organization/scopes/audit?limit=100`);
      return unwrap<{ events: AuditEvent[] }>(res);
    },
    enabled: ready,
    refetchInterval: 30_000,
  });

  // Pulled once for name resolution AND the agent-filter dropdown and
  // the Issue Grant modal's agent picker. `env=all` so both test and
  // live agents resolve — the audit feed is tenant-scoped (not env-
  // scoped), so a live-env dashboard view still surfaces test agents
  // in past events. Without env=all those rows would only show as
  // truncated UUIDs.
  const agentsQuery = useQuery({
    queryKey: ['org', 'scopes', 'agents-mini'],
    queryFn: async () => {
      const res = await apiFetch(`${apiUrl}/v1/agents?limit=200&env=all`);
      return unwrap<{ data: AgentMini[] } | AgentMini[] | { agents: AgentMini[] }>(res);
    },
    enabled: ready,
    staleTime: 60_000,
  });

  // Normalize whatever shape /v1/agents returns into a flat array.
  // This is the FULL cross-env list — used purely for name resolution
  // so audit rows from any env still display readable names.
  const allAgents: AgentMini[] = useMemo(() => {
    const raw = agentsQuery.data as any;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if (Array.isArray(raw.data)) return raw.data;
    if (Array.isArray(raw.agents)) return raw.agents;
    return [];
  }, [agentsQuery.data]);

  // Filter UI + Issue Grant agent picker scope to the CURRENT env so
  // owners only see agents they're contextually managing. Audit rows
  // from the OTHER env still resolve to names via allAgents map below,
  // but you'd switch env to filter against them in the dropdown.
  const agents: AgentMini[] = useMemo(() => {
    return allAgents.filter((a) => !a.environment || a.environment === apiEnvironment);
  }, [allAgents, apiEnvironment]);

  const agentNameMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of allAgents) m.set(a.id, a.name);
    return m;
  }, [allAgents]);

  const agentLabel = (agentId: string | null | undefined): string => {
    if (!agentId) return '—';
    return agentNameMap.get(agentId) ?? `${agentId.slice(0, 8)}…`;
  };

  const events = auditQuery.data?.events ?? [];

  // Pending requests = scope_requested rows that don't have a paired
  // grant_id yet AND haven't been denied. Source of truth is the
  // audit feed — any scope_denied or scope_granted (signaled by
  // non-null grant_id) sibling cancels it.
  const pendingRequests = useMemo(() => {
    const requested = events.filter((e) => e.action === 'scope_requested' && !e.grant_id);
    return requested.filter((r) => {
      const denialAfter = events.find(
        (e) =>
          e.action === 'scope_denied' &&
          e.agent_id === r.agent_id &&
          new Date(e.created_at) > new Date(r.created_at),
      );
      return !denialAfter;
    });
  }, [events]);

  // Filtered audit events for the timeline view.
  const filteredEvents = useMemo(() => {
    return events.filter((e) => {
      if (selectedAgentIds.size > 0) {
        if (!e.agent_id || !selectedAgentIds.has(e.agent_id)) return false;
      }
      if (selectedActions.size > 0) {
        if (!selectedActions.has(e.action)) return false;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        const summary = e.request_summary as any;
        const haystack = [
          summary?.purpose,
          summary?.reason,
          summary?.route,
          e.action,
          e.scope,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [events, selectedAgentIds, selectedActions, searchQuery]);

  const decideMutation = useMutation({
    mutationFn: async (vars: {
      requestId: string;
      decision: 'approve' | 'deny';
      reason?: string;
      durationMinutes?: number;
    }) => {
      const res = await apiFetch(`${apiUrl}/v1/organization/scopes/${vars.requestId}/decide`, {
        method: 'POST',
        body: JSON.stringify({
          decision: vars.decision,
          reason: vars.reason,
          duration_minutes: vars.durationMinutes,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: (_, vars) => {
      toast.success(vars.decision === 'approve' ? 'Scope approved' : 'Scope denied');
      queryClient.invalidateQueries({ queryKey: ['org', 'scopes'] });
    },
    onError: (err: any) => toast.error(err.message ?? 'Decision failed'),
  });

  const revokeMutation = useMutation({
    mutationFn: async (grantId: string) => {
      const res = await apiFetch(`${apiUrl}/v1/organization/scopes/${grantId}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success('Grant revoked');
      queryClient.invalidateQueries({ queryKey: ['org', 'scopes'] });
    },
    onError: (err: any) => toast.error(err.message ?? 'Revoke failed'),
  });

  const issueMutation = useMutation({
    mutationFn: async (vars: {
      agentId: string;
      scope: Scope;
      lifecycle: Lifecycle;
      durationMinutes: number;
      purpose: string;
    }) => {
      const res = await apiFetch(`${apiUrl}/v1/organization/scopes`, {
        method: 'POST',
        body: JSON.stringify({
          agent_id: vars.agentId,
          scope: vars.scope,
          lifecycle: vars.lifecycle,
          duration_minutes: vars.durationMinutes,
          purpose: vars.purpose,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success('Grant issued');
      setIssueModalOpen(false);
      queryClient.invalidateQueries({ queryKey: ['org', 'scopes'] });
    },
    onError: (err: any) => toast.error(err.message ?? 'Failed to issue grant'),
  });

  const refreshAll = () => {
    queryClient.invalidateQueries({ queryKey: ['org', 'scopes'] });
    toast.message('Refreshed');
  };

  const grants = grantsQuery.data?.grants ?? [];

  const toggleAgent = (id: string) => {
    setSelectedAgentIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAction = (a: AuditAction) => {
    setSelectedActions((prev) => {
      const next = new Set(prev);
      if (next.has(a)) next.delete(a);
      else next.add(a);
      return next;
    });
  };

  const filtersActive = selectedAgentIds.size > 0 || selectedActions.size > 0 || searchQuery.trim().length > 0;

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-slate-700 dark:text-slate-200" />
            <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-50">Scope grants</h1>
          </div>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Per-intent and standing capability tokens. Every elevation has a human approver and a complete audit trail.
          </p>
        </div>
        <button
          onClick={refreshAll}
          className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
        >
          <RefreshCw className="h-3 w-3" />
          Refresh
        </button>
      </header>

      {/* PENDING REQUESTS */}
      <section className="rounded-lg border border-slate-200 dark:border-slate-800">
        <div className="flex items-center justify-between border-b border-slate-200 p-4 dark:border-slate-800">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Pending requests ({pendingRequests.length})
          </h2>
          {pendingRequests.length > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-200">
              <AlertTriangle className="h-3 w-3" /> Awaiting decision
            </span>
          )}
        </div>
        {pendingRequests.length === 0 ? (
          <div className="p-6 text-center text-sm text-slate-500 dark:text-slate-400">
            No pending requests.
          </div>
        ) : (
          <ul className="divide-y divide-slate-200 dark:divide-slate-800">
            {pendingRequests.map((req) => {
              const summary = (req.request_summary ?? {}) as any;
              return (
                <li key={req.id} className="space-y-3 p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <Bot className="h-4 w-4 text-slate-500" />
                        <span className="font-medium text-slate-900 dark:text-slate-100">
                          {agentLabel(req.agent_id)}
                        </span>
                        <span className="text-slate-400">requested</span>
                        <span className={`inline-flex rounded px-1.5 py-0.5 text-xs font-medium ${SCOPE_COLORS[req.scope as Scope]}`}>
                          {req.scope}
                        </span>
                        <span className="text-xs text-slate-500">{summary.requested_lifecycle ?? 'one_shot'}</span>
                        <Clock className="ml-2 h-3 w-3 text-slate-400" />
                        <span className="text-xs text-slate-500">{formatRelative(req.created_at)}</span>
                      </div>
                      <p className="text-sm text-slate-700 dark:text-slate-200">{summary.purpose ?? '(no purpose given)'}</p>
                      {summary.intent && (
                        <pre className="overflow-x-auto rounded bg-slate-50 p-2 text-[11px] text-slate-600 dark:bg-slate-900 dark:text-slate-300">
                          {JSON.stringify(summary.intent, null, 2)}
                        </pre>
                      )}
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <button
                        onClick={() => {
                          // Elevated scopes (tenant_write, treasury) require
                          // typed-confirmation — see Story 82.10.
                          // tenant_read stays one-click since the blast
                          // radius is read-only.
                          if (req.scope === 'tenant_write' || req.scope === 'treasury') {
                            setConfirmApproval({
                              requestId: req.id,
                              agentId: req.agent_id,
                              agentName: agentLabel(req.agent_id),
                              scope: req.scope as Scope,
                            });
                          } else {
                            decideMutation.mutate({ requestId: req.id, decision: 'approve' });
                          }
                        }}
                        disabled={decideMutation.isPending}
                        className="inline-flex items-center gap-1 rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
                      >
                        {decideMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                        Approve
                      </button>
                      <button
                        onClick={() => {
                          const reason = window.prompt('Reason for denial (shown to the agent):') ?? undefined;
                          decideMutation.mutate({ requestId: req.id, decision: 'deny', reason });
                        }}
                        disabled={decideMutation.isPending}
                        className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                      >
                        <X className="h-3 w-3" />
                        Deny
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ACTIVE GRANTS */}
      <section className="rounded-lg border border-slate-200 dark:border-slate-800">
        <div className="flex items-center justify-between border-b border-slate-200 p-4 dark:border-slate-800">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Active grants ({grants.length})
          </h2>
          <div className="flex items-center gap-2">
            {grantsQuery.isLoading && <Loader2 className="h-4 w-4 animate-spin text-slate-400" />}
            <button
              onClick={() => setIssueModalOpen(true)}
              className="inline-flex items-center gap-1 rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200"
            >
              <Plus className="h-3 w-3" />
              Issue grant
            </button>
          </div>
        </div>
        {grants.length === 0 ? (
          <div className="p-6 text-center text-sm text-slate-500 dark:text-slate-400">
            No active grants. Agents are operating at default <code className="rounded bg-slate-100 px-1 py-0.5 dark:bg-slate-800">agent</code> scope.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-900 dark:text-slate-400">
              <tr>
                <th className="p-3">Agent</th>
                <th className="p-3">Scope</th>
                <th className="p-3">Lifecycle</th>
                <th className="p-3">Purpose</th>
                <th className="p-3">Used</th>
                <th className="p-3">Expires</th>
                <th className="p-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {grants.map((g) => (
                <tr key={g.id} className="hover:bg-slate-50 dark:hover:bg-slate-900">
                  <td className="p-3">
                    <div className="font-medium text-slate-900 dark:text-slate-100">
                      {g.agent_name ?? agentNameMap.get(g.agent_id) ?? '—'}
                    </div>
                    <div className="font-mono text-[11px] text-slate-500">{g.agent_id.slice(0, 8)}…</div>
                  </td>
                  <td className="p-3">
                    <span className={`inline-flex rounded px-1.5 py-0.5 text-xs font-medium ${SCOPE_COLORS[g.scope]}`}>
                      {g.scope}
                    </span>
                  </td>
                  <td className="p-3 text-xs text-slate-600 dark:text-slate-300">{g.lifecycle}</td>
                  <td className="p-3 text-slate-700 dark:text-slate-200">{g.purpose}</td>
                  <td className="p-3 text-xs text-slate-500">
                    {g.use_count}× {g.last_used_at && `· last ${formatRelative(g.last_used_at)}`}
                  </td>
                  <td className="p-3 text-xs text-slate-500">{formatRemaining(g.expires_at)}</td>
                  <td className="p-3 text-right">
                    <button
                      onClick={() => {
                        if (window.confirm(`Revoke ${g.scope} grant for ${g.agent_name ?? g.agent_id}?`)) {
                          revokeMutation.mutate(g.id);
                        }
                      }}
                      disabled={revokeMutation.isPending}
                      className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-red-50 hover:text-red-600 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-red-950"
                    >
                      <Trash2 className="h-3 w-3" />
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* AUDIT TRAIL with filters */}
      <section className="rounded-lg border border-slate-200 dark:border-slate-800">
        <div className="flex items-center justify-between border-b border-slate-200 p-4 dark:border-slate-800">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Recent activity ({filteredEvents.length}
            {filtersActive ? ` of ${events.length}` : ''})
          </h2>
          {auditQuery.isLoading && <Loader2 className="h-4 w-4 animate-spin text-slate-400" />}
        </div>

        {/* Filter toolbar */}
        <div className="space-y-3 border-b border-slate-200 p-4 dark:border-slate-800">
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="text"
              placeholder="Search purpose, reason, route…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="min-w-[220px] flex-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-900 placeholder:text-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            />
            {filtersActive && (
              <button
                onClick={() => {
                  setSelectedAgentIds(new Set());
                  setSelectedActions(new Set());
                  setSearchQuery('');
                }}
                className="text-xs text-slate-500 hover:text-slate-900 dark:hover:text-slate-100"
              >
                Clear filters
              </button>
            )}
          </div>

          <div className="flex flex-wrap gap-1.5">
            <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Action</span>
            {ALL_ACTIONS.map((a) => {
              const active = selectedActions.has(a);
              return (
                <button
                  key={a}
                  onClick={() => toggleAction(a)}
                  className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                    active
                      ? 'border-slate-900 bg-slate-900 text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900'
                      : 'border-slate-300 text-slate-600 hover:border-slate-500 dark:border-slate-700 dark:text-slate-300'
                  }`}
                >
                  {ACTION_LABELS[a]}
                </button>
              );
            })}
          </div>

          <AgentFilterPopover
            agents={agents}
            selected={selectedAgentIds}
            onToggle={toggleAgent}
            onClear={() => setSelectedAgentIds(new Set())}
            currentEnv={apiEnvironment}
          />
          {selectedAgentIds.size > 0 && (
            <div className="flex flex-wrap gap-1.5">
              <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
                Filtering to
              </span>
              {Array.from(selectedAgentIds).map((id) => {
                const name = agentNameMap.get(id) ?? `${id.slice(0, 8)}…`;
                return (
                  <span
                    key={id}
                    className="inline-flex items-center gap-1 rounded-full border border-slate-900 bg-slate-900 px-2 py-0.5 text-[11px] text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900"
                  >
                    {name}
                    <button
                      onClick={() => toggleAgent(id)}
                      className="opacity-70 hover:opacity-100"
                      aria-label={`Remove ${name} from filter`}
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </span>
                );
              })}
            </div>
          )}
        </div>

        {filteredEvents.length === 0 ? (
          <div className="p-6 text-center text-sm text-slate-500 dark:text-slate-400">
            {filtersActive ? 'No events match the current filters.' : 'No scope events yet.'}
          </div>
        ) : (
          <ul className="max-h-[480px] divide-y divide-slate-200 overflow-y-auto dark:divide-slate-800">
            {filteredEvents.map((e) => {
              const summary = e.request_summary as any;
              return (
                <li key={e.id} className="flex flex-wrap items-center gap-3 p-3 text-xs">
                  <span className="w-16 shrink-0 text-slate-400">{formatRelative(e.created_at)}</span>
                  <span className={`w-24 shrink-0 font-medium ${ACTION_COLORS[e.action]}`}>
                    {ACTION_LABELS[e.action]}
                  </span>
                  {e.scope ? (
                    <span className={`inline-flex rounded px-1.5 py-0.5 text-[10px] font-medium ${SCOPE_COLORS[e.scope]}`}>
                      {e.scope}
                    </span>
                  ) : (
                    <span className="w-[68px]" />
                  )}
                  <span className="font-medium text-slate-700 dark:text-slate-200">
                    {agentLabel(e.agent_id)}
                  </span>
                  <span className="text-[10px] text-slate-400">via {e.actor_type}</span>
                  {summary?.purpose ? (
                    <span className="truncate text-slate-700 dark:text-slate-300">
                      {String(summary.purpose)}
                    </span>
                  ) : null}
                  {summary?.reason ? (
                    <span className="truncate text-red-600 dark:text-red-400">
                      reason: {String(summary.reason)}
                    </span>
                  ) : null}
                  {summary?.route ? (
                    <span className="font-mono text-[10px] text-slate-500">{String(summary.route)}</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {issueModalOpen && (
        <IssueGrantModal
          agents={agents}
          onClose={() => setIssueModalOpen(false)}
          onSubmit={(vars) => issueMutation.mutate(vars)}
          isPending={issueMutation.isPending}
        />
      )}

      {confirmApproval && (
        <ConfirmApprovalModal
          requestId={confirmApproval.requestId}
          agentName={confirmApproval.agentName}
          scope={confirmApproval.scope}
          onClose={() => setConfirmApproval(null)}
          onConfirm={() => {
            decideMutation.mutate(
              { requestId: confirmApproval.requestId, decision: 'approve' },
              { onSettled: () => setConfirmApproval(null) },
            );
          }}
          isPending={decideMutation.isPending}
        />
      )}
    </div>
  );
}

// ============================================================
// Issue grant modal
// ============================================================

const SCOPE_DURATION_CEILING: Record<Scope, number> = {
  tenant_read: 60,
  tenant_write: 15,
  treasury: 1, // treasury is one_shot only — duration is the validity window
};

function IssueGrantModal({
  agents,
  onClose,
  onSubmit,
  isPending,
}: {
  agents: AgentMini[];
  onClose: () => void;
  onSubmit: (vars: {
    agentId: string;
    scope: Scope;
    lifecycle: Lifecycle;
    durationMinutes: number;
    purpose: string;
  }) => void;
  isPending: boolean;
}) {
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '');
  const [scope, setScope] = useState<Scope>('tenant_read');
  const [lifecycle, setLifecycle] = useState<Lifecycle>('standing');
  const [durationMinutes, setDurationMinutes] = useState(15);
  const [purpose, setPurpose] = useState('');

  const ceiling = SCOPE_DURATION_CEILING[scope];
  // Treasury is one_shot only.
  const lifecycleLocked = scope === 'treasury';
  const effectiveLifecycle: Lifecycle = lifecycleLocked ? 'one_shot' : lifecycle;
  const submittable = agentId.length > 0 && purpose.trim().length >= 8 && durationMinutes > 0 && durationMinutes <= ceiling;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-6 shadow-xl dark:border-slate-800 dark:bg-slate-950"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-50">Issue grant</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 text-sm">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">Agent</span>
            <select
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
            >
              {agents.length === 0 && <option value="">No agents</option>}
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">Scope</span>
            <div className="flex gap-1.5">
              {(['tenant_read', 'tenant_write', 'treasury'] as Scope[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => {
                    setScope(s);
                    setDurationMinutes(Math.min(durationMinutes, SCOPE_DURATION_CEILING[s]));
                    if (s === 'treasury') setLifecycle('one_shot');
                  }}
                  className={`flex-1 rounded-md border px-3 py-1.5 text-xs ${
                    scope === s
                      ? `${SCOPE_COLORS[s]} border-current`
                      : 'border-slate-300 text-slate-600 hover:border-slate-500 dark:border-slate-700 dark:text-slate-300'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">
              Lifecycle{lifecycleLocked && <span className="ml-1 text-slate-400">(treasury is always one_shot)</span>}
            </span>
            <div className="flex gap-1.5">
              {(['one_shot', 'standing'] as Lifecycle[]).map((l) => {
                const disabled = lifecycleLocked && l === 'standing';
                const active = effectiveLifecycle === l;
                return (
                  <button
                    key={l}
                    type="button"
                    disabled={disabled}
                    onClick={() => setLifecycle(l)}
                    className={`flex-1 rounded-md border px-3 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-40 ${
                      active
                        ? 'border-slate-900 bg-slate-900 text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900'
                        : 'border-slate-300 text-slate-600 hover:border-slate-500 dark:border-slate-700 dark:text-slate-300'
                    }`}
                  >
                    {l}
                  </button>
                );
              })}
            </div>
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">
              Duration (minutes — max {ceiling})
            </span>
            <input
              type="number"
              min={1}
              max={ceiling}
              value={durationMinutes}
              onChange={(e) => setDurationMinutes(parseInt(e.target.value, 10) || 0)}
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">
              Purpose (min 8 chars)
            </span>
            <textarea
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              rows={3}
              placeholder="e.g. Approve TinaProvider to rebalance funds across siblings overnight"
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
            />
          </label>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!submittable || isPending}
            onClick={() =>
              onSubmit({
                agentId,
                scope,
                lifecycle: effectiveLifecycle,
                durationMinutes,
                purpose: purpose.trim(),
              })
            }
            className="inline-flex items-center gap-1 rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200"
          >
            {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
            Issue
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Agent filter popover — searchable multi-select scoped to current env
// ============================================================

function AgentFilterPopover({
  agents,
  selected,
  onToggle,
  onClear,
  currentEnv,
}: {
  agents: AgentMini[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onClear: () => void;
  currentEnv?: 'test' | 'live';
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    if (!query.trim()) return agents;
    const q = query.trim().toLowerCase();
    return agents.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.id.toLowerCase().includes(q),
    );
  }, [agents, query]);

  const label =
    selected.size === 0
      ? 'Filter by agent'
      : selected.size === 1
        ? '1 agent selected'
        : `${selected.size} agents selected`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
        >
          <Bot className="h-3 w-3" />
          {label}
          <ChevronDown className="h-3 w-3 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <div className="border-b border-slate-200 p-2 dark:border-slate-800">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              autoFocus
              type="text"
              placeholder={`Search ${agents.length} ${currentEnv ?? ''} agents…`.trim()}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full rounded-md border border-slate-300 bg-white py-1.5 pl-7 pr-2 text-xs text-slate-900 placeholder:text-slate-400 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            />
          </div>
          {selected.size > 0 && (
            <button
              onClick={onClear}
              className="mt-2 text-[11px] text-slate-500 hover:text-slate-900 dark:hover:text-slate-100"
            >
              Clear {selected.size} selected
            </button>
          )}
        </div>
        <div className="max-h-72 overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <div className="p-4 text-center text-xs text-slate-500">
              No agents match.
            </div>
          ) : (
            filtered.map((a) => {
              const checked = selected.has(a.id);
              const isSuspended = a.status === 'suspended';
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => onToggle(a.id)}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  <span
                    className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ${
                      checked
                        ? 'border-slate-900 bg-slate-900 text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900'
                        : 'border-slate-300 dark:border-slate-700'
                    }`}
                  >
                    {checked && <Check className="h-2.5 w-2.5" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className={`truncate font-medium text-slate-900 dark:text-slate-100 ${isSuspended ? 'line-through opacity-60' : ''}`}>
                      {a.name}
                    </div>
                    <div className="font-mono text-[10px] text-slate-400">{a.id.slice(0, 8)}…</div>
                  </div>
                  {isSuspended && (
                    <span className="rounded bg-amber-100 px-1 text-[9px] uppercase text-amber-800 dark:bg-amber-950 dark:text-amber-200">
                      suspended
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ============================================================
// Typed-confirmation modal for elevated approvals (Story 82.10)
// ============================================================

function ConfirmApprovalModal({
  requestId,
  agentName,
  scope,
  onClose,
  onConfirm,
  isPending,
}: {
  requestId: string;
  agentName: string;
  scope: Scope;
  onClose: () => void;
  onConfirm: () => void;
  isPending: boolean;
}) {
  const [typed, setTyped] = useState("");
  const matches = typed.trim() === agentName.trim() && agentName.trim().length > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-6 shadow-xl dark:border-slate-800 dark:bg-slate-950"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-50 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            Confirm elevation
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 text-sm">
          <p className="text-slate-700 dark:text-slate-200">
            You are about to grant{" "}
            <span className={`inline-flex rounded px-1.5 py-0.5 text-xs font-medium ${SCOPE_COLORS[scope]}`}>
              {scope}
            </span>{" "}
            to{" "}
            <strong className="text-slate-900 dark:text-slate-50">{agentName}</strong>.
            {scope === "treasury" && (
              <> This grant lets the agent <strong>move funds</strong> across sibling agents.</>
            )}
            {scope === "tenant_write" && (
              <> This grant lets the agent <strong>mutate sibling agent state</strong>.</>
            )}
          </p>

          <p className="text-xs text-slate-500 dark:text-slate-400">
            Type <code className="rounded bg-slate-100 px-1 py-0.5 dark:bg-slate-800">{agentName}</code> to confirm.
          </p>

          <input
            autoFocus
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={agentName}
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          />
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!matches || isPending}
            onClick={onConfirm}
            className="inline-flex items-center gap-1 rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
            Approve {scope}
          </button>
        </div>

        <p className="mt-3 text-[10px] text-slate-400">request id: {requestId}</p>
      </div>
    </div>
  );
}
