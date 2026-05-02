'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Button,
  Input,
  Label,
  Badge,
} from '@sly/ui';
import {
  Radar,
  Plus,
  Copy,
  Check,
  Trash2,
  AlertTriangle,
  Loader2,
  BarChart3,
} from 'lucide-react';
import { toast } from 'sonner';
import { useScannerApi } from '@/lib/scanner-api';

type Scope = 'scan' | 'batch' | 'read' | 'tests' | 'mcp';
const ALL_SCOPES: Scope[] = ['scan', 'batch', 'read', 'tests'];

interface ScannerKey {
  id: string;
  name: string;
  key_prefix: string;
  environment: 'test' | 'live';
  scopes: Scope[];
  rate_limit_per_min: number;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export function ScannerKeysSection() {
  const scanner = useScannerApi();
  const [keys, setKeys] = useState<ScannerKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [newKeyEnv, setNewKeyEnv] = useState<'test' | 'live'>('test');
  const [newKeyScopes, setNewKeyScopes] = useState<Set<Scope>>(new Set(ALL_SCOPES));
  const [newlyCreatedKey, setNewlyCreatedKey] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const fetchKeys = useCallback(async () => {
    try {
      const res = await scanner.get('/v1/scanner/keys');
      if (!res.ok) {
        setLoading(false);
        return;
      }
      const json = await res.json();
      setKeys(Array.isArray(json.data) ? json.data : []);
    } catch {
      // non-fatal
    }
    setLoading(false);
  }, [scanner]);

  useEffect(() => {
    fetchKeys();
  }, [fetchKeys]);

  const toggleScope = (s: Scope) => {
    setNewKeyScopes((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  };

  const handleCreate = async () => {
    setCreating(true);
    try {
      const res = await scanner.post('/v1/scanner/keys', {
        name: newKeyName.trim() || `${newKeyEnv === 'test' ? 'Sandbox' : 'Production'} Scanner Key`,
        environment: newKeyEnv,
        scopes: Array.from(newKeyScopes),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error || json.message || 'Failed to create key');
        setCreating(false);
        return;
      }
      setNewlyCreatedKey(json.key);
      setShowCreateForm(false);
      setNewKeyName('');
      setNewKeyEnv('test');
      setNewKeyScopes(new Set(ALL_SCOPES));
      toast.success('Scanner API key created');
      await fetchKeys();
    } catch {
      toast.error('Failed to create key');
    }
    setCreating(false);
  };

  const handleRevoke = async (id: string) => {
    try {
      const res = await scanner.del(`/v1/scanner/keys/${id}`);
      if (!res.ok) {
        toast.error('Failed to revoke key');
        return;
      }
      toast.success('Scanner key revoked');
      await fetchKeys();
    } catch {
      toast.error('Failed to revoke key');
    }
  };

  const handleCopy = async (text: string, id: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedId(id);
    toast.success('Copied to clipboard');
    setTimeout(() => setCopiedId(null), 2000);
  };

  const activeKeys = keys.filter((k) => !k.revoked_at);
  const revokedKeys = keys.filter((k) => !!k.revoked_at);

  return (
    <div id="scanner" className="space-y-6 pt-6 border-t">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <Radar className="h-5 w-5" />
            Scanner API Keys
          </h2>
          <p className="text-sm text-muted-foreground">
            Keys for the agentic-commerce scanner. <a href="/dashboard/scanner" className="underline hover:text-foreground">Manage scanner credits →</a>
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => setShowCreateForm(!showCreateForm)}
          disabled={loading}
        >
          <Plus className="h-4 w-4 mr-2" />
          Create Scanner Key
        </Button>
      </div>

      {newlyCreatedKey && (
        <Card className="border-amber-500/50 bg-amber-50 dark:bg-amber-950/20">
          <CardContent className="pt-4 pb-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
              <div className="flex-1 space-y-2">
                <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
                  Save your scanner API key now — it won&apos;t be shown again
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 bg-amber-100 dark:bg-amber-900/40 rounded px-3 py-2 text-xs font-mono text-amber-900 dark:text-amber-100 break-all">
                    {newlyCreatedKey}
                  </code>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleCopy(newlyCreatedKey, 'new-scanner')}
                  >
                    {copiedId === 'new-scanner' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  </Button>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-amber-700 dark:text-amber-300"
                  onClick={() => setNewlyCreatedKey(null)}
                >
                  I&apos;ve saved it, dismiss
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {showCreateForm && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Create Scanner Key</CardTitle>
            <CardDescription>
              Keys authenticate against <code className="font-mono text-xs">sly-scanner.vercel.app</code>.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="scannerKeyName">Key name (optional)</Label>
              <Input
                id="scannerKeyName"
                placeholder="e.g. Prospect pipeline, MCP agent"
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Environment</Label>
              <div className="flex gap-3">
                <Button
                  type="button"
                  variant={newKeyEnv === 'test' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setNewKeyEnv('test')}
                >
                  Sandbox
                </Button>
                <Button
                  type="button"
                  variant={newKeyEnv === 'live' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setNewKeyEnv('live')}
                >
                  Production
                </Button>
              </div>
              {newKeyEnv === 'live' && (
                <p className="text-xs text-muted-foreground">
                  Production keys require owner/admin role. Request will be rejected otherwise.
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label>Scopes</Label>
              <div className="flex flex-wrap gap-2">
                {ALL_SCOPES.map((s) => (
                  <Button
                    key={s}
                    type="button"
                    variant={newKeyScopes.has(s) ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => toggleScope(s)}
                    className="capitalize"
                  >
                    {newKeyScopes.has(s) && <Check className="h-3 w-3 mr-1" />}
                    {s}
                  </Button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                <code className="font-mono">read</code> covers all GET endpoints (scans, prospects, ledger, usage).{' '}
                <code className="font-mono">scan</code>/<code className="font-mono">batch</code>/<code className="font-mono">tests</code> each gate their matching POST endpoint.
              </p>
            </div>
            <div className="flex gap-3">
              <Button onClick={handleCreate} disabled={creating || newKeyScopes.size === 0}>
                {creating ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Plus className="h-4 w-4 mr-2" />}
                Create
              </Button>
              <Button variant="ghost" onClick={() => setShowCreateForm(false)} disabled={creating}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Radar className="h-5 w-5" />
            Active Scanner Keys
          </CardTitle>
          <CardDescription>
            {loading
              ? 'Loading…'
              : activeKeys.length === 0
                ? 'No scanner keys yet. Create one above to get started.'
                : `${activeKeys.length} active key${activeKeys.length === 1 ? '' : 's'}`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : activeKeys.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground text-sm">
              <BarChart3 className="h-8 w-8 mx-auto mb-2 text-muted-foreground/40" />
              Keys unlock scanning, batch uploads, and synthetic shopping tests.
            </div>
          ) : (
            <div className="space-y-3">
              {activeKeys.map((k) => (
                <div key={k.id} className="flex items-center justify-between p-3 rounded-lg border bg-card">
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <div className="space-y-1 min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium truncate">{k.name}</span>
                        <Badge variant={k.environment === 'live' ? 'default' : 'secondary'} className="text-[10px] shrink-0">
                          {k.environment === 'live' ? 'Production' : 'Sandbox'}
                        </Badge>
                        {k.scopes?.map((s) => (
                          <Badge key={s} variant="outline" className="text-[10px] shrink-0 capitalize">
                            {s}
                          </Badge>
                        ))}
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                        <code className="font-mono">{k.key_prefix}••••</code>
                        <span>{k.rate_limit_per_min}/min</span>
                        <span>Created {new Date(k.created_at).toLocaleDateString()}</span>
                        {k.last_used_at && <span>Last used {new Date(k.last_used_at).toLocaleDateString()}</span>}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleCopy(k.key_prefix, k.id)}
                      title="Copy prefix"
                    >
                      {copiedId === k.id ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleRevoke(k.id)}
                      title="Revoke key"
                      className="text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/20"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {revokedKeys.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg text-muted-foreground">Revoked Scanner Keys</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {revokedKeys.map((k) => (
                <div key={k.id} className="flex items-center justify-between p-3 rounded-lg border border-dashed opacity-60">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium line-through">{k.name}</span>
                      <Badge variant="destructive" className="text-[10px]">Revoked</Badge>
                    </div>
                    <code className="text-xs font-mono text-muted-foreground">{k.key_prefix}••••</code>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
