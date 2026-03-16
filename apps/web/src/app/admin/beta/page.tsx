'use client';

/* eslint-disable @typescript-eslint/no-namespace */
declare global {
  interface Window {
    google: {
      accounts: {
        id: {
          initialize: (config: any) => void;
          renderButton: (element: HTMLElement, config: any) => void;
        };
      };
    };
  }
}

import { useState, useEffect, useCallback, useRef } from 'react';
import Script from 'next/script';
import { ThemeToggleSimple } from '@/components/theme-toggle';
import { Button } from '@sly/ui';
import { Input } from '@sly/ui';
import { Label } from '@sly/ui';
import { Card, CardContent, CardHeader, CardTitle } from '@sly/ui';
import {
  Loader2, CheckCircle2, XCircle, Clock, Users, Bot,
  Key, BarChart3, Plus, Trash2, RefreshCw, Activity,
  Building2, ArrowRightLeft, Waves, Search,
} from 'lucide-react';

const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
const googleClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || '';

interface AdminSession {
  token: string;
  email: string;
  name: string;
  picture?: string;
  expiresAt: string;
}

function useAdminApi() {
  const [session, setSession] = useState<AdminSession | null>(null);

  useEffect(() => {
    const saved = sessionStorage.getItem('sly_admin_session');
    if (saved) {
      try {
        const parsed: AdminSession = JSON.parse(saved);
        // Check if session is still valid
        if (new Date(parsed.expiresAt) > new Date()) {
          setSession(parsed);
        } else {
          sessionStorage.removeItem('sly_admin_session');
        }
      } catch {
        sessionStorage.removeItem('sly_admin_session');
      }
    }
  }, []);

  const saveSession = useCallback((s: AdminSession) => {
    setSession(s);
    sessionStorage.setItem('sly_admin_session', JSON.stringify(s));
  }, []);

  const clearSession = useCallback(() => {
    setSession(null);
    sessionStorage.removeItem('sly_admin_session');
  }, []);

  const fetchAdmin = useCallback(async (path: string, opts?: RequestInit) => {
    if (!session) throw new Error('Not authenticated');
    const res = await fetch(`${apiUrl}/admin/beta${path}`, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.token}`,
        ...opts?.headers,
      },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (res.status === 403) {
        clearSession();
      }
      throw new Error(err.error || `Request failed: ${res.status}`);
    }
    const json = await res.json();
    // Unwrap response envelope if present
    if (json && typeof json === 'object' && 'success' in json && 'data' in json) {
      if ('pagination' in json) {
        return { data: json.data, pagination: json.pagination };
      }
      return json.data;
    }
    return json;
  }, [session]);

  return { session, saveSession, clearSession, fetchAdmin, isAuthenticated: !!session };
}

type Tab = 'dashboard' | 'applications' | 'codes' | 'tenants' | 'agents' | 'funnel';

export default function BetaAdminPage() {
  const { session, saveSession, clearSession, fetchAdmin, isAuthenticated } = useAdminApi();
  const [tab, setTab] = useState<Tab>('dashboard');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [gsiReady, setGsiReady] = useState(false);
  const googleButtonRef = useRef<HTMLDivElement>(null);

  // Use a ref for the callback so Google always calls the latest version
  const handleGoogleCallback = useCallback(async (response: { credential: string }) => {
    setAuthLoading(true);
    setAuthError(null);
    try {
      const res = await fetch(`${apiUrl}/admin/beta/auth/google`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: response.credential }),
      });
      const raw = await res.json();
      if (!res.ok) {
        setAuthError(raw.error || 'Authentication failed');
        return;
      }
      // Unwrap response envelope if present
      const data = (raw && 'success' in raw && 'data' in raw) ? raw.data : raw;
      saveSession({
        token: data.token,
        email: data.email,
        name: data.name,
        picture: data.picture,
        expiresAt: data.expiresAt,
      });
    } catch (err: any) {
      setAuthError(err.message || 'Authentication failed');
    } finally {
      setAuthLoading(false);
    }
  }, [saveSession]);

  const callbackRef = useRef(handleGoogleCallback);
  callbackRef.current = handleGoogleCallback;

  // Initialize Google Sign-In after script loads and button ref is available
  useEffect(() => {
    if (!gsiReady || !googleButtonRef.current) return;
    if (!window.google) return;

    window.google.accounts.id.initialize({
      client_id: googleClientId,
      callback: (response: { credential: string }) => callbackRef.current(response),
      auto_select: false,
    });
    window.google.accounts.id.renderButton(googleButtonRef.current, {
      theme: 'outline',
      size: 'large',
      width: 360,
      text: 'signin_with',
    });
  }, [gsiReady]);

  if (!isAuthenticated) {
    return (
      <>
        <Script
          src="https://accounts.google.com/gsi/client"
          strategy="afterInteractive"
          onLoad={() => setGsiReady(true)}
        />
        <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 p-4">
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle>Platform Admin</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-gray-500">
                Sign in with your <span className="font-medium">@getsly.ai</span> Google account to continue.
              </p>
              {authLoading && (
                <div className="flex justify-center py-4">
                  <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
                </div>
              )}
              {authError && (
                <p className="text-sm text-red-500">{authError}</p>
              )}
              <div ref={googleButtonRef} className="flex justify-center" />
            </CardContent>
          </Card>
        </div>
      </>
    );
  }

  const tabs: { key: Tab; label: string; icon: typeof Users }[] = [
    { key: 'dashboard', label: 'Dashboard', icon: Activity },
    { key: 'applications', label: 'Applications', icon: Users },
    { key: 'codes', label: 'Invite Codes', icon: Key },
    { key: 'tenants', label: 'Tenants', icon: Building2 },
    { key: 'agents', label: 'Agents', icon: Bot },
    { key: 'funnel', label: 'Funnel', icon: BarChart3 },
  ];

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <div className="max-w-7xl mx-auto p-6">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Platform Admin</h1>
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-500">{session?.email}</span>
            <ThemeToggleSimple />
            <Button
              variant="outline"
              size="sm"
              onClick={clearSession}
            >
              Sign Out
            </Button>
          </div>
        </div>

        <div className="flex gap-2 mb-6 border-b border-gray-200 dark:border-gray-800">
          {tabs.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                tab === key
                  ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                  : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
            >
              <Icon className="h-4 w-4" />
              {label}
            </button>
          ))}
        </div>

        {tab === 'dashboard' && <DashboardTab fetchAdmin={fetchAdmin} />}
        {tab === 'applications' && <ApplicationsTab fetchAdmin={fetchAdmin} />}
        {tab === 'codes' && <CodesTab fetchAdmin={fetchAdmin} />}
        {tab === 'tenants' && <TenantsTab fetchAdmin={fetchAdmin} />}
        {tab === 'agents' && <AgentsTab fetchAdmin={fetchAdmin} />}
        {tab === 'funnel' && <FunnelTab fetchAdmin={fetchAdmin} />}
      </div>
    </div>
  );
}

// ============================================
// Dashboard Tab
// ============================================
function DashboardTab({ fetchAdmin }: { fetchAdmin: (path: string, opts?: RequestInit) => Promise<any> }) {
  const [health, setHealth] = useState<any>(null);
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [h, s] = await Promise.all([
        fetchAdmin('/health'),
        fetchAdmin('/stats'),
      ]);
      setHealth(h);
      setStats(s);
    } catch (err: any) {
      setError(err.message);
    }
    setLoading(false);
  }, [fetchAdmin]);

  useEffect(() => { load(); }, [load]);

  function formatUptime(seconds: number): string {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

  function formatVolume(amount: number): string {
    if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(2)}M`;
    if (amount >= 1_000) return `$${(amount / 1_000).toFixed(1)}K`;
    return `$${amount.toFixed(2)}`;
  }

  if (loading) {
    return <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-gray-400" /></div>;
  }

  if (error) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-red-500">{error}</p>
        <Button variant="outline" size="sm" onClick={load}>
          <RefreshCw className="h-3.5 w-3.5 mr-1" /> Retry
        </Button>
      </div>
    );
  }

  const statCards = [
    { label: 'Tenants', value: stats?.counts?.tenants || 0, icon: Building2, color: 'text-blue-600 dark:text-blue-400' },
    { label: 'Users', value: stats?.counts?.users || 0, icon: Users, color: 'text-green-600 dark:text-green-400' },
    { label: 'Agents', value: stats?.counts?.agents || 0, icon: Bot, color: 'text-violet-600 dark:text-violet-400' },
    { label: 'Accounts', value: stats?.counts?.accounts || 0, icon: Key, color: 'text-orange-600 dark:text-orange-400' },
    { label: 'Transfers', value: stats?.counts?.transfers || 0, icon: ArrowRightLeft, color: 'text-pink-600 dark:text-pink-400' },
    { label: 'Streams', value: stats?.counts?.streams || 0, icon: Waves, color: 'text-cyan-600 dark:text-cyan-400' },
  ];

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={load}>
          <RefreshCw className="h-3.5 w-3.5 mr-1" /> Refresh
        </Button>
      </div>

      {/* Health */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">System Health</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="space-y-1">
              <span className="text-xs text-gray-500 uppercase tracking-wide">Status</span>
              <div className="flex items-center gap-2">
                <span className={`h-2.5 w-2.5 rounded-full ${health?.status === 'healthy' ? 'bg-green-500' : 'bg-red-500'}`} />
                <span className="text-sm font-medium text-gray-900 dark:text-white capitalize">{health?.status || 'unknown'}</span>
              </div>
            </div>
            <div className="space-y-1">
              <span className="text-xs text-gray-500 uppercase tracking-wide">Database</span>
              <div className="flex items-center gap-2">
                <span className={`h-2.5 w-2.5 rounded-full ${health?.database === 'healthy' ? 'bg-green-500' : 'bg-red-500'}`} />
                <span className="text-sm font-medium text-gray-900 dark:text-white capitalize">{health?.database || 'unknown'}</span>
              </div>
            </div>
            <div className="space-y-1">
              <span className="text-xs text-gray-500 uppercase tracking-wide">Uptime</span>
              <span className="text-sm font-medium text-gray-900 dark:text-white block">{health?.uptime ? formatUptime(health.uptime) : '-'}</span>
            </div>
            <div className="space-y-1">
              <span className="text-xs text-gray-500 uppercase tracking-wide">Environment</span>
              <span className={`inline-flex items-center px-2 py-0.5 text-xs rounded-full ${
                health?.environment === 'production'
                  ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                  : 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
              }`}>
                {health?.environment || 'unknown'}
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        {statCards.map(({ label, value, icon: Icon, color }) => (
          <Card key={label}>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-500">{label}</p>
                  <p className="text-2xl font-bold text-gray-900 dark:text-white">{value.toLocaleString()}</p>
                </div>
                <Icon className={`h-8 w-8 ${color} opacity-80`} />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Highlights */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-gray-500">Total Transfer Volume</p>
            <p className="text-2xl font-bold text-gray-900 dark:text-white">{formatVolume(stats?.totalVolume || 0)}</p>
            <p className="text-xs text-gray-400 mt-1">Completed transfers</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-gray-500">API Requests (24h)</p>
            <p className="text-2xl font-bold text-gray-900 dark:text-white">{(stats?.recentApiRequests || 0).toLocaleString()}</p>
            <p className="text-xs text-gray-400 mt-1">Last 24 hours</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ============================================
// Applications Tab
// ============================================
function ApplicationsTab({ fetchAdmin }: { fetchAdmin: (path: string, opts?: RequestInit) => Promise<any> }) {
  const [apps, setApps] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('pending');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchAdmin(`/applications?status=${statusFilter}`);
      setApps(data.data || []);
    } catch (err: any) {
      setError(err.message);
    }
    setLoading(false);
  }, [fetchAdmin, statusFilter]);

  useEffect(() => { load(); }, [load]);

  async function handleAction(id: string, action: 'approve' | 'reject') {
    try {
      await fetchAdmin(`/applications/${id}/${action}`, { method: 'POST' });
      load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {['pending', 'approved', 'rejected'].map((s) => (
          <Button
            key={s}
            variant={statusFilter === s ? 'default' : 'outline'}
            size="sm"
            onClick={() => setStatusFilter(s)}
          >
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </Button>
        ))}
        <Button variant="outline" size="sm" onClick={load}>
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}

      {loading ? (
        <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-gray-400" /></div>
      ) : apps.length === 0 ? (
        <p className="text-center text-gray-500 py-12">No {statusFilter} applications</p>
      ) : (
        <div className="bg-white dark:bg-gray-950 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-900">
              <tr>
                <th className="text-left p-3 font-medium text-gray-500">Email</th>
                <th className="text-left p-3 font-medium text-gray-500">Organization</th>
                <th className="text-left p-3 font-medium text-gray-500">Use Case</th>
                <th className="text-left p-3 font-medium text-gray-500">Date</th>
                <th className="text-right p-3 font-medium text-gray-500">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {apps.map((app) => (
                <tr key={app.id}>
                  <td className="p-3 text-gray-900 dark:text-white">{app.email || app.agent_name}</td>
                  <td className="p-3 text-gray-600 dark:text-gray-400">{app.organization_name || '-'}</td>
                  <td className="p-3 text-gray-600 dark:text-gray-400 max-w-xs truncate">{app.use_case || '-'}</td>
                  <td className="p-3 text-gray-500">{new Date(app.created_at).toLocaleDateString()}</td>
                  <td className="p-3 text-right">
                    {app.status === 'pending' && (
                      <div className="flex justify-end gap-1">
                        <Button size="sm" onClick={() => handleAction(app.id, 'approve')}>
                          <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Approve
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => handleAction(app.id, 'reject')}>
                          <XCircle className="h-3.5 w-3.5 mr-1" /> Reject
                        </Button>
                      </div>
                    )}
                    {app.status === 'approved' && (
                      <span className="text-green-600 flex items-center justify-end gap-1">
                        <CheckCircle2 className="h-3.5 w-3.5" /> Approved
                      </span>
                    )}
                    {app.status === 'rejected' && (
                      <span className="text-red-500 flex items-center justify-end gap-1">
                        <XCircle className="h-3.5 w-3.5" /> Rejected
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ============================================
// Codes Tab
// ============================================
function CodesTab({ fetchAdmin }: { fetchAdmin: (path: string, opts?: RequestInit) => Promise<any> }) {
  const [codes, setCodes] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  // Create form
  const [codeType, setCodeType] = useState<'single_use' | 'multi_use'>('single_use');
  const [maxUses, setMaxUses] = useState('1');
  const [partnerName, setPartnerName] = useState('');
  const [targetActorType, setTargetActorType] = useState<'human' | 'agent' | 'both'>('both');
  const [grantedMaxTeamMembers, setGrantedMaxTeamMembers] = useState('5');
  const [grantedMaxAgents, setGrantedMaxAgents] = useState('10');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchAdmin('/codes');
      setCodes(data.data || []);
    } catch (err: any) {
      setError(err.message);
    }
    setLoading(false);
  }, [fetchAdmin]);

  useEffect(() => { load(); }, [load]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      await fetchAdmin('/codes', {
        method: 'POST',
        body: JSON.stringify({
          codeType,
          maxUses: parseInt(maxUses),
          partnerName: partnerName || undefined,
          targetActorType,
          grantedMaxTeamMembers: parseInt(grantedMaxTeamMembers),
          grantedMaxAgents: parseInt(grantedMaxAgents),
        }),
      });
      setShowCreate(false);
      setPartnerName('');
      load();
    } catch (err: any) {
      setError(err.message);
    }
    setCreating(false);
  }

  async function handleRevoke(id: string) {
    try {
      await fetchAdmin(`/codes/${id}`, { method: 'DELETE' });
      load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-between">
        <Button variant="outline" size="sm" onClick={load}>
          <RefreshCw className="h-3.5 w-3.5 mr-1" /> Refresh
        </Button>
        <Button size="sm" onClick={() => setShowCreate(!showCreate)}>
          <Plus className="h-3.5 w-3.5 mr-1" /> Create Code
        </Button>
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}

      {showCreate && (
        <Card>
          <CardContent className="pt-6">
            <form onSubmit={handleCreate} className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Code Type</Label>
                <select
                  className="w-full px-3 py-2 text-sm border rounded-md bg-background"
                  value={codeType}
                  onChange={(e) => setCodeType(e.target.value as any)}
                >
                  <option value="single_use">Single Use</option>
                  <option value="multi_use">Multi Use</option>
                </select>
              </div>
              <div className="space-y-2">
                <Label>Max Uses</Label>
                <Input type="number" value={maxUses} onChange={(e) => setMaxUses(e.target.value)} min="1" />
              </div>
              <div className="space-y-2">
                <Label>Partner Name <span className="text-xs text-muted-foreground">(optional)</span></Label>
                <Input value={partnerName} onChange={(e) => setPartnerName(e.target.value)} placeholder="OpenClaw" />
              </div>
              <div className="space-y-2">
                <Label>Target Actor Type</Label>
                <select
                  className="w-full px-3 py-2 text-sm border rounded-md bg-background"
                  value={targetActorType}
                  onChange={(e) => setTargetActorType(e.target.value as any)}
                >
                  <option value="both">Both</option>
                  <option value="human">Human Only</option>
                  <option value="agent">Agent Only</option>
                </select>
              </div>
              <div className="space-y-2">
                <Label>Max Team Members</Label>
                <Input type="number" value={grantedMaxTeamMembers} onChange={(e) => setGrantedMaxTeamMembers(e.target.value)} min="1" />
              </div>
              <div className="space-y-2">
                <Label>Max Agents</Label>
                <Input type="number" value={grantedMaxAgents} onChange={(e) => setGrantedMaxAgents(e.target.value)} min="1" />
              </div>
              <div className="col-span-2 flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
                <Button type="submit" disabled={creating}>
                  {creating && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
                  Create
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {loading ? (
        <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-gray-400" /></div>
      ) : codes.length === 0 ? (
        <p className="text-center text-gray-500 py-12">No invite codes yet</p>
      ) : (
        <div className="bg-white dark:bg-gray-950 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-900">
              <tr>
                <th className="text-left p-3 font-medium text-gray-500">Code</th>
                <th className="text-left p-3 font-medium text-gray-500">Partner</th>
                <th className="text-left p-3 font-medium text-gray-500">Type</th>
                <th className="text-left p-3 font-medium text-gray-500">Usage</th>
                <th className="text-left p-3 font-medium text-gray-500">Limits</th>
                <th className="text-left p-3 font-medium text-gray-500">Status</th>
                <th className="text-right p-3 font-medium text-gray-500">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {codes.map((code) => (
                <tr key={code.id}>
                  <td className="p-3 font-mono text-xs text-gray-900 dark:text-white">{code.code}</td>
                  <td className="p-3 text-gray-600 dark:text-gray-400">{code.partner_name || '-'}</td>
                  <td className="p-3 text-gray-600 dark:text-gray-400">{code.target_actor_type}</td>
                  <td className="p-3 text-gray-600 dark:text-gray-400">{code.current_uses}/{code.max_uses}</td>
                  <td className="p-3 text-gray-600 dark:text-gray-400 text-xs">
                    {code.granted_max_team_members} members, {code.granted_max_agents} agents
                  </td>
                  <td className="p-3">
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full ${
                      code.status === 'active' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' :
                      code.status === 'exhausted' ? 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400' :
                      'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                    }`}>
                      {code.status === 'active' && <CheckCircle2 className="h-3 w-3" />}
                      {code.status === 'exhausted' && <Clock className="h-3 w-3" />}
                      {code.status === 'revoked' && <XCircle className="h-3 w-3" />}
                      {code.status}
                    </span>
                  </td>
                  <td className="p-3 text-right">
                    {code.status === 'active' && (
                      <Button size="sm" variant="outline" onClick={() => handleRevoke(code.id)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ============================================
// Tenants Tab
// ============================================
const categoryBadge: Record<string, string> = {
  beta: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
  organic: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  test: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-500',
};

const statusBadge: Record<string, string> = {
  active: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  suspended: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
};

type TenantFilter = 'all' | 'beta' | 'organic' | 'test';

function TenantsTab({ fetchAdmin }: { fetchAdmin: (path: string, opts?: RequestInit) => Promise<any> }) {
  const [tenants, setTenants] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<TenantFilter>('all');
  const [search, setSearch] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editMaxMembers, setEditMaxMembers] = useState('');
  const [editMaxAgents, setEditMaxAgents] = useState('');
  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filter !== 'all') params.set('filter', filter);
      if (search) params.set('search', search);
      const qs = params.toString();
      const data = await fetchAdmin(`/tenants${qs ? `?${qs}` : ''}`);
      setTenants(data.data || []);
    } catch (err: any) {
      setError(err.message);
    }
    setLoading(false);
  }, [fetchAdmin, filter, search]);

  useEffect(() => { load(); }, [load]);

  async function handleUpdateLimits(id: string) {
    try {
      await fetchAdmin(`/tenants/${id}/limits`, {
        method: 'PATCH',
        body: JSON.stringify({
          maxTeamMembers: parseInt(editMaxMembers),
          maxAgents: parseInt(editMaxAgents),
        }),
      });
      setEditingId(null);
      load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  const filters: { key: TenantFilter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'beta', label: 'Beta' },
    { key: 'organic', label: 'Organic' },
    { key: 'test', label: 'Test' },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {filters.map((f) => (
          <Button
            key={f.key}
            variant={filter === f.key ? 'default' : 'outline'}
            size="sm"
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </Button>
        ))}
        <div className="relative ml-auto">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
          <Input
            className="pl-8 h-8 w-48 text-sm"
            placeholder="Search tenants..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Button variant="outline" size="sm" onClick={load}>
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}

      {loading ? (
        <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-gray-400" /></div>
      ) : tenants.length === 0 ? (
        <p className="text-center text-gray-500 py-12">No tenants found</p>
      ) : (
        <div className="bg-white dark:bg-gray-950 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-900">
              <tr>
                <th className="text-left p-3 font-medium text-gray-500">ID</th>
                <th className="text-left p-3 font-medium text-gray-500">Tenant</th>
                <th className="text-left p-3 font-medium text-gray-500">Category</th>
                <th className="text-left p-3 font-medium text-gray-500">Status</th>
                <th className="text-left p-3 font-medium text-gray-500">Team Members</th>
                <th className="text-left p-3 font-medium text-gray-500">Agents</th>
                <th className="text-left p-3 font-medium text-gray-500">Created</th>
                <th className="text-right p-3 font-medium text-gray-500">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {tenants.map((t) => (
                <tr key={t.id}>
                  <td className="p-3 font-mono text-xs text-gray-500">{t.id.slice(0, 8)}</td>
                  <td className="p-3">
                    <button
                      className="text-blue-600 dark:text-blue-400 hover:underline font-medium text-left"
                      onClick={() => setSelectedTenantId(t.id)}
                    >
                      {t.name}
                    </button>
                  </td>
                  <td className="p-3">
                    <span className={`inline-flex items-center px-2 py-0.5 text-xs rounded-full ${categoryBadge[t.category] || categoryBadge.test}`}>
                      {t.category}
                    </span>
                  </td>
                  <td className="p-3">
                    <span className={`inline-flex items-center px-2 py-0.5 text-xs rounded-full ${statusBadge[t.status] || statusBadge.active}`}>
                      {t.status || 'active'}
                    </span>
                  </td>
                  <td className="p-3 text-gray-600 dark:text-gray-400">
                    {t.usage?.teamMembers?.current || 0} / {t.max_team_members || '-'}
                  </td>
                  <td className="p-3 text-gray-600 dark:text-gray-400">
                    {t.usage?.agents?.current || 0} / {t.max_agents || '-'}
                  </td>
                  <td className="p-3 text-gray-500">{new Date(t.created_at).toLocaleDateString()}</td>
                  <td className="p-3 text-right">
                    {editingId === t.id ? (
                      <div className="flex items-center justify-end gap-2">
                        <Input
                          className="w-16 h-8 text-xs"
                          type="number"
                          value={editMaxMembers}
                          onChange={(e) => setEditMaxMembers(e.target.value)}
                          placeholder="Members"
                          min="1"
                        />
                        <Input
                          className="w-16 h-8 text-xs"
                          type="number"
                          value={editMaxAgents}
                          onChange={(e) => setEditMaxAgents(e.target.value)}
                          placeholder="Agents"
                          min="1"
                        />
                        <Button size="sm" onClick={() => handleUpdateLimits(t.id)}>Save</Button>
                        <Button size="sm" variant="outline" onClick={() => setEditingId(null)}>Cancel</Button>
                      </div>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setEditingId(t.id);
                          setEditMaxMembers(String(t.max_team_members || 5));
                          setEditMaxAgents(String(t.max_agents || 10));
                        }}
                      >
                        Edit Limits
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selectedTenantId && (
        <TenantDetail
          tenantId={selectedTenantId}
          fetchAdmin={fetchAdmin}
          onClose={() => setSelectedTenantId(null)}
        />
      )}
    </div>
  );
}

// ============================================
// Tenant Detail Panel
// ============================================
function TenantDetail({
  tenantId,
  fetchAdmin,
  onClose,
}: {
  tenantId: string;
  fetchAdmin: (path: string, opts?: RequestInit) => Promise<any>;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchAdmin(`/tenants/${tenantId}`)
      .then((data) => { if (!cancelled) setDetail(data); })
      .catch((err: any) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [tenantId, fetchAdmin]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <div
        className="w-full max-w-lg bg-white dark:bg-gray-950 h-full overflow-y-auto shadow-xl border-l border-gray-200 dark:border-gray-800"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-white dark:bg-gray-950 border-b border-gray-200 dark:border-gray-800 p-4 flex items-center justify-between z-10">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Tenant Detail</h2>
          <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
        </div>

        <div className="p-4 space-y-6">
          {loading && (
            <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-gray-400" /></div>
          )}

          {error && <p className="text-sm text-red-500">{error}</p>}

          {detail && (
            <>
              {/* Tenant Info */}
              <Card>
                <CardHeader><CardTitle className="text-base">Info</CardTitle></CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-500">ID</span>
                    <span className="font-mono text-xs text-gray-900 dark:text-white select-all">{detail.tenant.id}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Name</span>
                    <span className="text-gray-900 dark:text-white">{detail.tenant.name}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Category</span>
                    <span className={`inline-flex items-center px-2 py-0.5 text-xs rounded-full ${categoryBadge[detail.tenant.category] || categoryBadge.test}`}>
                      {detail.tenant.category}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Status</span>
                    <span className={`inline-flex items-center px-2 py-0.5 text-xs rounded-full ${statusBadge[detail.tenant.status] || statusBadge.active}`}>
                      {detail.tenant.status || 'active'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Onboarded Via</span>
                    <span className="text-gray-900 dark:text-white">{detail.tenant.onboarded_via || '-'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Created</span>
                    <span className="text-gray-900 dark:text-white">{new Date(detail.tenant.created_at).toLocaleString()}</span>
                  </div>
                </CardContent>
              </Card>

              {/* Stats Grid */}
              <div className="grid grid-cols-3 gap-3">
                {[
                  { label: 'Users', value: detail.stats?.users || 0, limit: detail.tenant.max_team_members, icon: Users, color: 'text-green-600 dark:text-green-400' },
                  { label: 'Agents', value: detail.stats?.agents || 0, limit: detail.tenant.max_agents, icon: Bot, color: 'text-violet-600 dark:text-violet-400' },
                  { label: 'Accounts', value: detail.stats?.accounts || 0, icon: Key, color: 'text-orange-600 dark:text-orange-400' },
                  { label: 'Transfers', value: detail.stats?.transfers || 0, icon: ArrowRightLeft, color: 'text-pink-600 dark:text-pink-400' },
                  { label: 'Streams', value: detail.stats?.streams || 0, icon: Waves, color: 'text-cyan-600 dark:text-cyan-400' },
                  { label: 'Volume', value: detail.stats?.totalVolume || 0, isVolume: true, icon: BarChart3, color: 'text-blue-600 dark:text-blue-400' },
                ].map(({ label, value, limit, icon: Icon, color, isVolume }) => (
                  <Card key={label}>
                    <CardContent className="pt-4 pb-3 px-3">
                      <div className="flex items-start justify-between">
                        <div>
                          <p className="text-xs text-gray-500">{label}</p>
                          <p className="text-lg font-bold text-gray-900 dark:text-white">
                            {isVolume
                              ? (value >= 1_000_000 ? `$${(value / 1_000_000).toFixed(2)}M` : value >= 1_000 ? `$${(value / 1_000).toFixed(1)}K` : `$${value.toFixed(2)}`)
                              : value.toLocaleString()}
                          </p>
                          {limit && <p className="text-xs text-gray-400">max {limit}</p>}
                        </div>
                        <Icon className={`h-5 w-5 ${color} opacity-80`} />
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>

              {/* Users */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Users ({detail.users.length})</CardTitle>
                </CardHeader>
                <CardContent>
                  {detail.users.length === 0 ? (
                    <p className="text-sm text-gray-500">No users</p>
                  ) : (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-gray-500">
                          <th className="pb-2 font-medium">Name</th>
                          <th className="pb-2 font-medium">Email</th>
                          <th className="pb-2 font-medium">Role</th>
                          <th className="pb-2 font-medium">Joined</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                        {detail.users.map((u: any) => (
                          <tr key={u.id}>
                            <td className="py-1.5 text-gray-900 dark:text-white">{u.name || '-'}</td>
                            <td className="py-1.5 text-gray-600 dark:text-gray-400 text-xs">{u.email || '-'}</td>
                            <td className="py-1.5 text-gray-600 dark:text-gray-400">{u.role}</td>
                            <td className="py-1.5 text-gray-500 text-xs">{new Date(u.created_at).toLocaleDateString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </CardContent>
              </Card>

              {/* Agents */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Agents ({detail.agents.length})</CardTitle>
                </CardHeader>
                <CardContent>
                  {detail.agents.length === 0 ? (
                    <p className="text-sm text-gray-500">No agents</p>
                  ) : (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-gray-500">
                          <th className="pb-2 font-medium">Name</th>
                          <th className="pb-2 font-medium">Status</th>
                          <th className="pb-2 font-medium">KYA Tier</th>
                          <th className="pb-2 font-medium">Created</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                        {detail.agents.map((a: any) => (
                          <tr key={a.id}>
                            <td className="py-1.5 text-gray-900 dark:text-white">{a.name}</td>
                            <td className="py-1.5">
                              <span className={`inline-flex items-center px-2 py-0.5 text-xs rounded-full ${statusBadge[a.status] || statusBadge.active}`}>
                                {a.status}
                              </span>
                            </td>
                            <td className="py-1.5 text-gray-600 dark:text-gray-400">{a.kya_tier}</td>
                            <td className="py-1.5 text-gray-500 text-xs">{new Date(a.created_at).toLocaleDateString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================
// Funnel Tab
// ============================================
// ============================================
// Agents Tab — Leaderboard + Detail
// ============================================

const kyaBadge: Record<number, string> = {
  0: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  1: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  2: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400',
  3: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
};

function AgentsTab({ fetchAdmin }: { fetchAdmin: (path: string, opts?: RequestInit) => Promise<any> }) {
  const [agents, setAgents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      if (statusFilter) params.set('status', statusFilter);
      const qs = params.toString();
      const data = await fetchAdmin(`/agents${qs ? `?${qs}` : ''}`);
      setAgents(data.data || []);
    } catch (err: any) {
      setError(err.message);
    }
    setLoading(false);
  }, [fetchAdmin, search, statusFilter]);

  useEffect(() => { load(); }, [load]);

  const statusFilters = [
    { key: '', label: 'All' },
    { key: 'active', label: 'Active' },
    { key: 'suspended', label: 'Suspended' },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {statusFilters.map((f) => (
          <Button
            key={f.key}
            variant={statusFilter === f.key ? 'default' : 'outline'}
            size="sm"
            onClick={() => setStatusFilter(f.key)}
          >
            {f.label}
          </Button>
        ))}
        <div className="relative ml-auto">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
          <Input
            className="pl-8 h-8 w-48 text-sm"
            placeholder="Search agents..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Button variant="outline" size="sm" onClick={load}>
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}

      {loading ? (
        <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-gray-400" /></div>
      ) : agents.length === 0 ? (
        <p className="text-center text-gray-500 py-12">No agents found</p>
      ) : (
        <div className="bg-white dark:bg-gray-950 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-900">
              <tr>
                <th className="text-left p-3 font-medium text-gray-500 w-8">#</th>
                <th className="text-left p-3 font-medium text-gray-500">Agent</th>
                <th className="text-left p-3 font-medium text-gray-500">Tenant</th>
                <th className="text-left p-3 font-medium text-gray-500">Status</th>
                <th className="text-left p-3 font-medium text-gray-500">KYA</th>
                <th className="text-right p-3 font-medium text-gray-500">Tasks</th>
                <th className="text-right p-3 font-medium text-gray-500">Success</th>
                <th className="text-right p-3 font-medium text-gray-500">Volume</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {agents.map((a, i) => (
                <tr key={a.id} className="hover:bg-gray-50 dark:hover:bg-gray-900/50">
                  <td className="p-3 text-gray-400 font-mono text-xs">{i + 1}</td>
                  <td className="p-3">
                    <button
                      className="text-blue-600 dark:text-blue-400 hover:underline font-medium text-left"
                      onClick={() => setSelectedAgentId(a.id)}
                    >
                      {a.name}
                    </button>
                    {a.description && (
                      <p className="text-xs text-gray-500 truncate max-w-xs">{a.description}</p>
                    )}
                  </td>
                  <td className="p-3 text-gray-600 dark:text-gray-400 text-xs">{a.tenant_name}</td>
                  <td className="p-3">
                    <span className={`inline-flex items-center px-2 py-0.5 text-xs rounded-full ${statusBadge[a.status] || statusBadge.active}`}>
                      {a.status}
                    </span>
                  </td>
                  <td className="p-3">
                    <span className={`inline-flex items-center px-2 py-0.5 text-xs rounded-full ${kyaBadge[a.kya_tier] || kyaBadge[0]}`}>
                      Tier {a.kya_tier}
                    </span>
                  </td>
                  <td className="p-3 text-right font-mono text-xs">
                    <span className="text-green-600">{a.tasks?.completed || 0}</span>
                    {(a.tasks?.failed || 0) > 0 && (
                      <span className="text-red-500 ml-1">/ {a.tasks.failed}f</span>
                    )}
                    <span className="text-gray-400 ml-1">/ {a.tasks?.total || 0}</span>
                  </td>
                  <td className="p-3 text-right font-mono text-xs">
                    <span className={a.success_rate >= 80 ? 'text-green-600' : a.success_rate >= 50 ? 'text-yellow-600' : 'text-red-500'}>
                      {a.tasks?.total > 0 ? `${a.success_rate}%` : '—'}
                    </span>
                  </td>
                  <td className="p-3 text-right font-mono text-xs text-gray-600 dark:text-gray-400">
                    {a.total_volume ? `$${Number(a.total_volume).toLocaleString()}` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selectedAgentId && (
        <AgentDetail
          agentId={selectedAgentId}
          fetchAdmin={fetchAdmin}
          onClose={() => setSelectedAgentId(null)}
        />
      )}
    </div>
  );
}

function AgentDetail({ agentId, fetchAdmin, onClose }: {
  agentId: string;
  fetchAdmin: (path: string, opts?: RequestInit) => Promise<any>;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await fetchAdmin(`/agents/${agentId}`);
        setDetail(data);
      } catch (err: any) {
        setError(err.message);
      }
      setLoading(false);
    })();
  }, [agentId, fetchAdmin]);

  if (loading) {
    return (
      <Card className="mt-4">
        <CardContent className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
        </CardContent>
      </Card>
    );
  }

  if (error || !detail) {
    return (
      <Card className="mt-4">
        <CardContent className="py-6">
          <p className="text-sm text-red-500">{error || 'Failed to load agent'}</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={onClose}>Close</Button>
        </CardContent>
      </Card>
    );
  }

  const { agent, skills, wallets, recentTasks, taskStats } = detail;

  return (
    <Card className="mt-4">
      <CardHeader className="flex flex-row items-start justify-between">
        <div>
          <CardTitle className="text-lg flex items-center gap-2">
            {agent.name}
            <span className={`inline-flex items-center px-2 py-0.5 text-xs rounded-full ${statusBadge[agent.status] || statusBadge.active}`}>
              {agent.status}
            </span>
            <span className={`inline-flex items-center px-2 py-0.5 text-xs rounded-full ${kyaBadge[agent.kya_tier] || kyaBadge[0]}`}>
              KYA {agent.kya_tier}
            </span>
          </CardTitle>
          <p className="text-sm text-gray-500 mt-1">{agent.description || 'No description'}</p>
        </div>
        <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Agent Info Grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <span className="text-gray-500">ID</span>
            <p className="font-mono text-xs mt-0.5">{agent.id.slice(0, 12)}...</p>
          </div>
          <div>
            <span className="text-gray-500">Tenant</span>
            <p className="mt-0.5">{agent.tenant_name}</p>
          </div>
          <div>
            <span className="text-gray-500">Parent Account</span>
            <p className="mt-0.5">{agent.parent_account_name || '—'}</p>
          </div>
          <div>
            <span className="text-gray-500">Type</span>
            <p className="mt-0.5">{agent.type || 'standard'}</p>
          </div>
          <div>
            <span className="text-gray-500">Discoverable</span>
            <p className="mt-0.5">{agent.discoverable ? 'Yes' : 'No'}</p>
          </div>
          <div>
            <span className="text-gray-500">x402 Enabled</span>
            <p className="mt-0.5">{agent.x402_enabled ? 'Yes' : 'No'}</p>
          </div>
          <div>
            <span className="text-gray-500">Endpoint</span>
            <p className="font-mono text-xs mt-0.5 truncate max-w-[200px]" title={agent.endpoint_url || ''}>
              {agent.endpoint_url || '—'}
            </p>
          </div>
          <div>
            <span className="text-gray-500">Created</span>
            <p className="mt-0.5">{new Date(agent.created_at).toLocaleDateString()}</p>
          </div>
        </div>

        {/* Task Stats */}
        <div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-2">Task Stats</h3>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {[
              { label: 'Total', value: taskStats.total, color: 'text-gray-900 dark:text-white' },
              { label: 'Completed', value: taskStats.completed, color: 'text-green-600' },
              { label: 'Failed', value: taskStats.failed, color: 'text-red-500' },
              { label: 'Working', value: taskStats.working, color: 'text-blue-500' },
              { label: 'Avg Duration', value: taskStats.avgDurationMs ? `${taskStats.avgDurationMs}ms` : '—', color: 'text-gray-600' },
            ].map((s) => (
              <div key={s.label} className="bg-gray-50 dark:bg-gray-900 rounded-lg p-3 text-center">
                <div className={`text-xl font-bold ${s.color}`}>{s.value}</div>
                <div className="text-xs text-gray-500">{s.label}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Skills */}
        {skills.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-2">
              Skills ({skills.length})
            </h3>
            <div className="bg-gray-50 dark:bg-gray-900 rounded-lg overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-200 dark:border-gray-800">
                    <th className="text-left p-2 font-medium text-gray-500">Skill</th>
                    <th className="text-left p-2 font-medium text-gray-500">Tags</th>
                    <th className="text-right p-2 font-medium text-gray-500">Price</th>
                    <th className="text-right p-2 font-medium text-gray-500">Invocations</th>
                    <th className="text-right p-2 font-medium text-gray-500">Revenue</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
                  {skills.map((s: any) => (
                    <tr key={s.skill_id}>
                      <td className="p-2">
                        <span className="font-medium">{s.name}</span>
                        <span className="text-gray-400 ml-1">({s.skill_id})</span>
                      </td>
                      <td className="p-2">
                        {(s.tags || []).map((t: string) => (
                          <span key={t} className="inline-block bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300 rounded px-1.5 py-0.5 mr-1 text-[10px]">
                            {t}
                          </span>
                        ))}
                      </td>
                      <td className="p-2 text-right font-mono">
                        {Number(s.base_price) > 0 ? `${s.base_price} ${s.currency}` : 'Free'}
                      </td>
                      <td className="p-2 text-right font-mono">{s.total_invocations || 0}</td>
                      <td className="p-2 text-right font-mono">
                        {Number(s.total_fees_collected) > 0 ? `${s.total_fees_collected} ${s.currency}` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Wallets */}
        {wallets.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-2">
              Wallets ({wallets.length})
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {wallets.map((w: any) => (
                <div key={w.id} className="bg-gray-50 dark:bg-gray-900 rounded-lg p-3 text-sm">
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-medium">{w.currency}</span>
                    <span className={`px-2 py-0.5 text-xs rounded-full ${statusBadge[w.status] || statusBadge.active}`}>
                      {w.status}
                    </span>
                  </div>
                  <div className="text-xl font-bold">${Number(w.balance || 0).toLocaleString()}</div>
                  <div className="text-xs text-gray-500 mt-1 font-mono truncate">{w.wallet_address || '—'}</div>
                  <div className="text-xs text-gray-400 mt-0.5">{w.wallet_type} / {w.custody_type} / {w.provider || 'none'}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Recent Tasks */}
        {recentTasks.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-2">
              Recent Tasks (last 20)
            </h3>
            <div className="bg-gray-50 dark:bg-gray-900 rounded-lg overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-200 dark:border-gray-800">
                    <th className="text-left p-2 font-medium text-gray-500">ID</th>
                    <th className="text-left p-2 font-medium text-gray-500">State</th>
                    <th className="text-left p-2 font-medium text-gray-500">Direction</th>
                    <th className="text-right p-2 font-medium text-gray-500">Duration</th>
                    <th className="text-right p-2 font-medium text-gray-500">Created</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
                  {recentTasks.map((t: any) => (
                    <tr key={t.id}>
                      <td className="p-2 font-mono text-gray-500">{t.id.slice(0, 8)}</td>
                      <td className="p-2">
                        <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] ${
                          t.state === 'completed' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' :
                          t.state === 'failed' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' :
                          t.state === 'working' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' :
                          'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
                        }`}>
                          {t.state}
                        </span>
                      </td>
                      <td className="p-2 text-gray-500">{t.direction || '—'}</td>
                      <td className="p-2 text-right font-mono text-gray-500">
                        {t.processing_duration_ms ? `${t.processing_duration_ms}ms` : '—'}
                      </td>
                      <td className="p-2 text-right text-gray-500">
                        {new Date(t.created_at).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Permissions */}
        {agent.permissions && Object.keys(agent.permissions).length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-2">Permissions</h3>
            <pre className="bg-gray-50 dark:bg-gray-900 rounded-lg p-3 text-xs font-mono overflow-x-auto">
              {JSON.stringify(agent.permissions, null, 2)}
            </pre>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function FunnelTab({ fetchAdmin }: { fetchAdmin: (path: string, opts?: RequestInit) => Promise<any> }) {
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchAdmin('/funnel');
      setStats(data);
    } catch (err: any) {
      setError(err.message);
    }
    setLoading(false);
  }, [fetchAdmin]);

  useEffect(() => { load(); }, [load]);

  const funnelSteps = [
    { key: 'application_submitted', label: 'Applied', color: 'bg-blue-500' },
    { key: 'application_approved', label: 'Approved', color: 'bg-indigo-500' },
    { key: 'code_redeemed', label: 'Code Redeemed', color: 'bg-violet-500' },
    { key: 'signup_completed', label: 'Signed Up', color: 'bg-purple-500' },
    { key: 'tenant_provisioned', label: 'Provisioned', color: 'bg-fuchsia-500' },
    { key: 'first_api_call', label: 'First API Call', color: 'bg-pink-500' },
    { key: 'first_transaction', label: 'First Transaction', color: 'bg-rose-500' },
  ];

  return (
    <div className="space-y-6">
      <Button variant="outline" size="sm" onClick={load}>
        <RefreshCw className="h-3.5 w-3.5 mr-1" /> Refresh
      </Button>

      {error && <p className="text-sm text-red-500">{error}</p>}

      {loading ? (
        <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-gray-400" /></div>
      ) : !stats ? (
        <p className="text-center text-gray-500 py-12">No funnel data yet</p>
      ) : (
        <>
          {/* Overall funnel */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Overall Funnel</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {funnelSteps.map((step) => {
                  const count = stats.total?.[step.key] || 0;
                  const maxCount = stats.total?.application_submitted || 1;
                  const pct = Math.round((count / maxCount) * 100);
                  return (
                    <div key={step.key} className="flex items-center gap-3">
                      <span className="text-sm text-gray-600 dark:text-gray-400 w-36 shrink-0">
                        {step.label}
                      </span>
                      <div className="flex-1 bg-gray-100 dark:bg-gray-800 rounded-full h-6 relative overflow-hidden">
                        <div
                          className={`h-full rounded-full ${step.color} transition-all`}
                          style={{ width: `${Math.max(pct, count > 0 ? 2 : 0)}%` }}
                        />
                        <span className="absolute inset-0 flex items-center justify-center text-xs font-medium text-gray-700 dark:text-gray-300">
                          {count}
                        </span>
                      </div>
                      <span className="text-xs text-gray-400 w-12 text-right">{pct}%</span>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          {/* By partner */}
          {stats.byPartner && Object.keys(stats.byPartner).length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">By Partner</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-6">
                  {Object.entries(stats.byPartner).map(([partner, partnerStats]: [string, any]) => (
                    <div key={partner}>
                      <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-2">
                        {partner === '_organic' ? 'Organic' : partner}
                      </h3>
                      <div className="grid grid-cols-7 gap-2">
                        {funnelSteps.map((step) => (
                          <div key={step.key} className="text-center">
                            <div className="text-lg font-bold text-gray-900 dark:text-white">
                              {partnerStats[step.key] || 0}
                            </div>
                            <div className="text-xs text-gray-500 truncate">{step.label}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
