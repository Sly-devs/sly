'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import { Button } from '@sly/ui';
import { Input } from '@sly/ui';
import { Label } from '@sly/ui';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@sly/ui';
import { Loader2, Zap, Copy, Check, AlertCircle } from 'lucide-react';

interface ApiKeys {
  test: { key: string; prefix: string };
  live: { key: string; prefix: string };
}

export default function SetupPage() {
  return (
    <Suspense>
      <SetupPageInner />
    </Suspense>
  );
}

function SetupPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlInviteCode = searchParams.get('invite_code') || '';
  const [organizationName, setOrganizationName] = useState('');
  const [loading, setLoading] = useState(true);
  const [provisioning, setProvisioning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [apiKeys, setApiKeys] = useState<ApiKeys | null>(null);
  const [showOrgForm, setShowOrgForm] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [inviteCode, setInviteCode] = useState(urlInviteCode);

  const isClosedBeta = process.env.NEXT_PUBLIC_CLOSED_BETA === 'true';

  const provision = useCallback(async (orgName: string, inviteCodeParam?: string) => {
    setProvisioning(true);
    setError(null);

    const supabase = createSupabaseBrowserClient();
    const { data: { session } } = await supabase.auth.getSession();

    if (!session?.access_token) {
      router.push('/auth/login');
      return;
    }

    const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
    try {
      const response = await fetch(`${apiUrl}/v1/auth/provision`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          organizationName: orgName,
          ...(inviteCodeParam ? { inviteCode: inviteCodeParam } : {}),
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || 'Failed to set up organization');
        setProvisioning(false);
        return;
      }

      if (data.alreadyProvisioned) {
        // Tenant already exists — go straight to dashboard
        router.push('/dashboard');
        return;
      }

      // Show API keys once
      if (data.apiKeys) {
        setApiKeys(data.apiKeys);
      }
    } catch {
      setError('Could not connect to the server. Please try again.');
    }
    setProvisioning(false);
  }, [router]);

  useEffect(() => {
    async function checkSession() {
      const supabase = createSupabaseBrowserClient();
      const { data: { session } } = await supabase.auth.getSession();

      if (!session) {
        // Preserve invite code for after login
        if (urlInviteCode) {
          localStorage.setItem('sly_beta_invite_code', urlInviteCode);
        }
        router.push('/auth/login');
        return;
      }

      // Check user_metadata for organization name (from email signup)
      const orgName = session.user.user_metadata?.organization_name;

      // Check for invite code from URL (Google SSO beta signup) or localStorage
      const betaInviteCode = new URLSearchParams(window.location.search).get('invite_code')
        || localStorage.getItem('sly_beta_invite_code') || '';
      const betaOrgName = localStorage.getItem('sly_beta_org_name') || '';

      if (orgName) {
        // Auto-provision with the org name from signup
        const metaInviteCode = session.user.user_metadata?.invite_code || betaInviteCode;
        await provision(orgName, metaInviteCode);
      } else if (betaInviteCode && betaOrgName) {
        // Google SSO from beta signup — we have both code and org from localStorage
        localStorage.removeItem('sly_beta_invite_code');
        localStorage.removeItem('sly_beta_org_name');
        await provision(betaOrgName, betaInviteCode);
      } else if (betaInviteCode) {
        // Have code but need org name
        setInviteCode(betaInviteCode);
        localStorage.removeItem('sly_beta_invite_code');
        setShowOrgForm(true);
      } else {
        // OAuth flow — need to ask for org name
        setShowOrgForm(true);
      }
      setLoading(false);
    }

    checkSession();
  }, [router, provision]);

  async function handleCopy(key: string, label: string) {
    await navigator.clipboard.writeText(key);
    setCopiedKey(label);
    setTimeout(() => setCopiedKey(null), 2000);
  }

  async function handleOrgSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!organizationName.trim()) {
      setError('Organization name is required');
      return;
    }
    await provision(organizationName.trim(), inviteCode || undefined);
  }

  // Loading state
  if (loading || (provisioning && !showOrgForm)) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-background to-primary/5 p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="space-y-1 text-center">
            <div className="flex justify-center mb-4">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
            <CardTitle className="text-2xl font-bold">Setting up your account</CardTitle>
            <CardDescription>
              Creating your organization and API keys...
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  // API keys display (shown once after provisioning)
  if (apiKeys) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-background to-primary/5 p-4">
        <Card className="w-full max-w-lg">
          <CardHeader className="space-y-1 text-center">
            <div className="flex justify-center mb-4">
              <div className="rounded-full bg-green-100 dark:bg-green-900/20 p-3">
                <Zap className="h-8 w-8 text-green-600" />
              </div>
            </div>
            <CardTitle className="text-2xl font-bold">You're all set!</CardTitle>
            <CardDescription>
              Save your API keys now — they won't be shown again.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-md border bg-amber-50 dark:bg-amber-900/10 border-amber-200 dark:border-amber-800 p-3 text-sm text-amber-800 dark:text-amber-200 flex gap-2">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>These API keys are shown only once. Copy and store them securely.</span>
            </div>

            {apiKeys.test.key && (
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Test Key</Label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 rounded bg-muted px-3 py-2 text-xs font-mono break-all">
                    {apiKeys.test.key}
                  </code>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleCopy(apiKeys.test.key, 'test')}
                  >
                    {copiedKey === 'test' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
            )}

            {apiKeys.live.key && (
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Live Key</Label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 rounded bg-muted px-3 py-2 text-xs font-mono break-all">
                    {apiKeys.live.key}
                  </code>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleCopy(apiKeys.live.key, 'live')}
                  >
                    {copiedKey === 'live' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
            )}

            <Button className="w-full mt-4" onClick={() => router.push('/dashboard')}>
              Go to Dashboard
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Organization name form (OAuth flow)
  if (showOrgForm) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-background to-primary/5 p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="space-y-1 text-center">
            <div className="flex justify-center mb-4">
              <div className="rounded-full bg-primary/10 p-3">
                <Zap className="h-8 w-8 text-primary" />
              </div>
            </div>
            <CardTitle className="text-2xl font-bold">Set up your organization</CardTitle>
            <CardDescription>
              One last step — give your organization a name.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleOrgSubmit} className="space-y-4">
              {error && (
                <div className="p-3 text-sm text-red-500 bg-red-50 dark:bg-red-900/20 rounded-md">
                  {error}
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="inviteCode">Invite Code</Label>
                <Input
                  id="inviteCode"
                  type="text"
                  placeholder="beta_..."
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="orgName">Organization Name</Label>
                <Input
                  id="orgName"
                  type="text"
                  placeholder="Acme Inc."
                  value={organizationName}
                  onChange={(e) => setOrganizationName(e.target.value)}
                  required
                  autoFocus
                />
              </div>
              <Button type="submit" className="w-full" disabled={provisioning}>
                {provisioning && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Create Organization
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Error fallback
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-background to-primary/5 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-1 text-center">
          <CardTitle className="text-2xl font-bold">Something went wrong</CardTitle>
          <CardDescription>{error || 'Please try again.'}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Button className="w-full" onClick={() => window.location.reload()}>
            Retry
          </Button>
          <Button variant="outline" className="w-full" onClick={() => router.push('/auth/login')}>
            Back to Login
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
