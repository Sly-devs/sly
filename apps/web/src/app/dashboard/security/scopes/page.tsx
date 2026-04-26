/**
 * Epic 82, Story 82.5 — Dashboard: Scope Grants & Pending Requests.
 *
 * Tenant-owner surface for the elevated-permission lifecycle:
 *   - See active standing/one_shot grants with revoke
 *   - See pending agent-side scope requests with approve/deny
 *   - Issue a standing grant directly (no agent request)
 *   - Recent audit trail for the tenant
 *
 * Backed by /v1/organization/scopes (issue / list / revoke / decide / audit).
 */

'use client';

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useApiConfig, useApiFetch } from '@/lib/api-client';
import { Shield, AlertTriangle, Check, X, Trash2, Loader2, Bot, Clock } from 'lucide-react';
import { toast } from 'sonner';

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
  granted_by_user_id: string;
  granted_at: string;
  expires_at: string;
  last_used_at: string | null;
  use_count: number;
}

interface AuditEvent {
  id: string;
  grant_id: string | null;
  agent_id: string | null;
  scope: Scope | null;
  action:
    | 'scope_requested'
    | 'scope_granted'
    | 'scope_denied'
    | 'scope_used'
    | 'scope_expired'
    | 'scope_revoked'
    | 'scope_heartbeat';
  actor_type: 'user' | 'agent' | 'system' | 'api_key';
  actor_id: string | null;
  request_summary: Record<string, unknown> | null;
  created_at: string;
}

const SCOPE_COLORS: Record<Scope, string> = {
  tenant_read: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200',
  tenant_write: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200',
  treasury: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200',
};

const ACTION_COLORS: Record<AuditEvent['action'], string> = {
  scope_requested: 'text-slate-600 dark:text-slate-300',
  scope_granted: 'text-green-600 dark:text-green-400',
  scope_denied: 'text-red-600 dark:text-red-400',
  scope_used: 'text-blue-600 dark:text-blue-400',
  scope_expired: 'text-slate-500 dark:text-slate-400',
  scope_revoked: 'text-orange-600 dark:text-orange-400',
  scope_heartbeat: 'text-slate-400',
};

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
  const { isConfigured, isLoading: authLoading, apiUrl } = useApiConfig();
  const queryClient = useQueryClient();

  const ready = isConfigured && !authLoading;

  // The API wraps responses in { success, data, meta }; unwrap once
  // here so the rest of the page can ignore the envelope.
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

  const events = auditQuery.data?.events ?? [];

  // Pending requests = scope_requested rows that don't have a paired
  // grant_id yet AND haven't been denied. We derive this client-side
  // because the audit feed is the source of truth — any scope_denied or
  // scope_granted (signaled by a non-null grant_id) sibling cancels it.
  const pendingRequests = useMemo(() => {
    const requested = events.filter((e) => e.action === 'scope_requested' && !e.grant_id);
    const denied = new Set(events.filter((e) => e.action === 'scope_denied').map((e) => e.agent_id));
    return requested.filter((r) => {
      // Conservative: if there's a denial AFTER the request for the same agent, treat as resolved.
      const denialAfter = events.find(
        (e) =>
          e.action === 'scope_denied' &&
          e.agent_id === r.agent_id &&
          new Date(e.created_at) > new Date(r.created_at),
      );
      return !denialAfter;
    });
  }, [events]);

  const decideMutation = useMutation({
    mutationFn: async (vars: { requestId: string; decision: 'approve' | 'deny'; reason?: string; durationMinutes?: number }) => {
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

  const grants = grantsQuery.data?.grants ?? [];

  return (
    <div className="space-y-6 p-6">
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <Shield className="h-5 w-5 text-slate-700 dark:text-slate-200" />
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-50">Scope grants</h1>
        </div>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Per-intent and standing capability tokens. Every elevation has a human approver and a complete audit trail.
        </p>
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
                      <div className="flex items-center gap-2 text-sm">
                        <Bot className="h-4 w-4 text-slate-500" />
                        <span className="font-mono text-xs text-slate-700 dark:text-slate-300">
                          {req.agent_id?.slice(0, 8)}…
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
                        onClick={() => decideMutation.mutate({ requestId: req.id, decision: 'approve' })}
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
          {grantsQuery.isLoading && <Loader2 className="h-4 w-4 animate-spin text-slate-400" />}
        </div>
        {grants.length === 0 ? (
          <div className="p-6 text-center text-sm text-slate-500 dark:text-slate-400">
            No active grants. Agents are operating at default `agent` scope.
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
                    <div className="font-medium text-slate-900 dark:text-slate-100">{g.agent_name ?? '—'}</div>
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

      {/* AUDIT TRAIL */}
      <section className="rounded-lg border border-slate-200 dark:border-slate-800">
        <div className="flex items-center justify-between border-b border-slate-200 p-4 dark:border-slate-800">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Recent activity</h2>
          {auditQuery.isLoading && <Loader2 className="h-4 w-4 animate-spin text-slate-400" />}
        </div>
        {events.length === 0 ? (
          <div className="p-6 text-center text-sm text-slate-500 dark:text-slate-400">No scope events yet.</div>
        ) : (
          <ul className="max-h-96 divide-y divide-slate-200 overflow-y-auto dark:divide-slate-800">
            {events.map((e) => (
              <li key={e.id} className="flex items-center gap-3 p-3 text-xs">
                <span className="w-16 text-slate-400">{formatRelative(e.created_at)}</span>
                <span className={`w-32 font-medium ${ACTION_COLORS[e.action]}`}>{e.action}</span>
                {e.scope && (
                  <span className={`inline-flex rounded px-1.5 py-0.5 text-[10px] font-medium ${SCOPE_COLORS[e.scope]}`}>
                    {e.scope}
                  </span>
                )}
                <span className="text-slate-500">{e.actor_type}</span>
                {e.agent_id && (
                  <span className="font-mono text-[10px] text-slate-500">{e.agent_id.slice(0, 8)}…</span>
                )}
                {e.request_summary?.purpose ? (
                  <span className="truncate text-slate-700 dark:text-slate-300">
                    {String(e.request_summary.purpose)}
                  </span>
                ) : null}
                {e.request_summary?.reason ? (
                  <span className="truncate text-red-600 dark:text-red-400">
                    {String(e.request_summary.reason)}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
