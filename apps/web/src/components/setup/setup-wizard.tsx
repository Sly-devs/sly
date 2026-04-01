'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import { Input } from '@sly/ui';
import { Label } from '@sly/ui';
import { Loader2 } from 'lucide-react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';

import { SetupBackground } from './setup-background';
import { SetupProgress } from './setup-progress';
import { StepTransition } from './step-transition';
import { GlowButton } from './shared/glow-button';
import { ThemeToggleSimple } from '@/components/theme-toggle';
import { ApiKeysStep } from './steps/api-keys-step';
import { WalletsStep } from './steps/wallets-step';
import { IntegrationStep } from './steps/integration-step';

// Route API calls to the correct server based on environment
const sandboxApiUrl =
  process.env.NEXT_PUBLIC_SANDBOX_API_URL ||
  process.env.NEXT_PUBLIC_API_URL ||
  'http://localhost:4000';
const productionApiUrl =
  process.env.NEXT_PUBLIC_API_URL ||
  'http://localhost:4000';

function getApiUrl(env: 'test' | 'live'): string {
  return env === 'live' ? productionApiUrl : sandboxApiUrl;
}

interface ApiKeys {
  test: { key: string; prefix: string };
  live: { key: string; prefix: string };
}

export default function SetupWizard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlInviteCode = searchParams.get('invite_code') || '';

  // Global state
  const [loading, setLoading] = useState(true);
  const [provisioning, setProvisioning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [completedSteps, setCompletedSteps] = useState<number[]>([]);

  // Auth + org
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [apiKeys, setApiKeys] = useState<ApiKeys | null>(null);
  const [orgName, setOrgName] = useState('');
  const [inviteCode, setInviteCode] = useState(urlInviteCode);
  const [showOrgForm, setShowOrgForm] = useState(false);

  // Account ID for wallet/agent creation
  const [accountId, setAccountId] = useState<string | null>(null);

  // ---------- Provision tenant ----------
  const provision = useCallback(
    async (orgNameVal: string, inviteCodeVal?: string) => {
      setProvisioning(true);
      setError(null);

      const supabase = createSupabaseBrowserClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) {
        router.push('/auth/login');
        return;
      }

      setAuthToken(session.access_token);

      try {
        const response = await fetch(`${sandboxApiUrl}/v1/auth/provision`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            organizationName: orgNameVal,
            ...(inviteCodeVal ? { inviteCode: inviteCodeVal } : {}),
          }),
        });

        const json = await response.json();
        const data = json.data || json;

        if (!response.ok) {
          setError(data.error || json.error || 'Failed to set up organization');
          setProvisioning(false);
          return;
        }

        if (data.alreadyProvisioned) {
          router.push('/dashboard');
          return;
        }

        setOrgName(orgNameVal);
        if (data.apiKeys) {
          setApiKeys(data.apiKeys);
        }

        // Get or create the default account for wallet/agent creation
        try {
          const acctRes = await fetch(`${sandboxApiUrl}/v1/accounts?limit=1`, {
            headers: { Authorization: `Bearer ${session.access_token}` },
          });
          const acctJson = await acctRes.json();
          const accts = acctJson.data || [];
          if (accts.length > 0) {
            setAccountId(accts[0].id);
          } else {
            // Create a default account with the org name
            const createRes = await fetch(`${sandboxApiUrl}/v1/accounts`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${session.access_token}`,
              },
              body: JSON.stringify({ type: 'business', name: orgNameVal }),
            });
            const createJson = await createRes.json();
            const newAcct = createJson.data?.data || createJson.data || createJson;
            if (newAcct?.id) setAccountId(newAcct.id);
          }
        } catch {
          /* non-fatal */
        }
      } catch {
        setError('Could not connect to the server. Please try again.');
      }
      setProvisioning(false);
    },
    [router],
  );

  // ---------- Check session on mount ----------
  useEffect(() => {
    async function checkSession() {
      const supabase = createSupabaseBrowserClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) {
        if (urlInviteCode) localStorage.setItem('sly_beta_invite_code', urlInviteCode);
        router.push('/auth/login');
        return;
      }

      setAuthToken(session.access_token);
      const orgNameMeta = session.user.user_metadata?.organization_name;
      const betaInviteCode =
        new URLSearchParams(window.location.search).get('invite_code') ||
        localStorage.getItem('sly_beta_invite_code') ||
        '';
      const betaOrgName = localStorage.getItem('sly_beta_org_name') || '';

      if (orgNameMeta) {
        const metaInviteCode = session.user.user_metadata?.invite_code || betaInviteCode;
        await provision(orgNameMeta, metaInviteCode);
      } else if (betaInviteCode && betaOrgName) {
        localStorage.removeItem('sly_beta_invite_code');
        localStorage.removeItem('sly_beta_org_name');
        await provision(betaOrgName, betaInviteCode);
      } else if (betaInviteCode) {
        setInviteCode(betaInviteCode);
        localStorage.removeItem('sly_beta_invite_code');
        setShowOrgForm(true);
      } else {
        setShowOrgForm(true);
      }
      setLoading(false);
    }
    checkSession();
  }, [router, provision, urlInviteCode]);

  // ---------- API helper ----------
  // Gets a fresh token from Supabase if state is stale (avoids race conditions after provision)
  const apiCall = useCallback(
    async (method: string, path: string, body?: any, env: 'test' | 'live' = 'test') => {
      let token = authToken;
      if (!token) {
        // Fallback: get fresh token from Supabase session
        const supabase = createSupabaseBrowserClient();
        const { data: { session } } = await supabase.auth.getSession();
        token = session?.access_token || null;
        if (token) setAuthToken(token);
      }
      if (!token) throw new Error('Not authenticated');

      const res = await fetch(`${getApiUrl(env)}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'X-Environment': env,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json();
      if (!res.ok) {
        const errMsg = json.error || json.data?.error || `Request failed (${res.status})`;
        throw new Error(typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg));
      }
      return json;
    },
    [authToken],
  );

  // ---------- Ensure account exists in target environment ----------
  const ensureAccount = useCallback(
    async (env: 'test' | 'live'): Promise<string | null> => {
      try {
        const res = await apiCall('GET', '/v1/accounts?limit=1', undefined, env);
        const accts = res.data || [];
        if (accts.length > 0) return accts[0].id;
        // Create account in this environment
        const createRes = await apiCall(
          'POST',
          '/v1/accounts',
          { type: 'business', name: orgName || 'My Organization' },
          env,
        );
        const newAcct = createRes.data?.data || createRes.data || createRes;
        return newAcct?.id || null;
      } catch {
        return null;
      }
    },
    [apiCall, orgName],
  );

  // ---------- Step navigation ----------
  const goToStep2 = useCallback(() => {
    setCompletedSteps((prev) => (prev.includes(1) ? prev : [...prev, 1]));
    setError(null);
    setStep(2);
  }, []);

  const goToStep3 = useCallback(() => {
    setCompletedSteps((prev) => (prev.includes(2) ? prev : [...prev, 2]));
    setError(null);
    setStep(3);
  }, []);

  const goToDashboard = useCallback(() => {
    setCompletedSteps((prev) => (prev.includes(3) ? prev : [...prev, 3]));
    router.push('/dashboard');
  }, [router]);

  // ---------- Loading spinner ----------
  if (loading || (provisioning && !showOrgForm)) {
    return (
      <div className="relative min-h-screen flex items-center justify-center">
        <SetupBackground />
        <div className="relative z-10 text-center">
          <Loader2 className="h-8 w-8 animate-spin mx-auto mb-4 text-blue-400" />
          <p className="text-muted-foreground text-sm">Setting up your organization...</p>
        </div>
      </div>
    );
  }

  // ---------- Org name form (pre-provision) ----------
  if (showOrgForm && !apiKeys) {
    return (
      <div className="relative min-h-screen flex items-center justify-center p-4">
        <SetupBackground />
        <div className="absolute top-4 right-4 z-10">
          <ThemeToggleSimple />
        </div>
        <div className="relative z-10 w-full max-w-md">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="space-y-8"
          >
            {/* Logo */}
            <motion.div
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ delay: 0.1 }}
              className="flex items-center justify-center gap-2.5"
            >
              <div
                className="w-9 h-9 bg-blue-500"
                style={{
                  WebkitMaskImage: 'url(/sly-logo.png)',
                  WebkitMaskSize: 'contain',
                  WebkitMaskRepeat: 'no-repeat',
                  WebkitMaskPosition: 'center',
                  maskImage: 'url(/sly-logo.png)',
                  maskSize: 'contain',
                  maskRepeat: 'no-repeat',
                  maskPosition: 'center',
                }}
              />
              <span className="text-2xl font-bold text-foreground">Sly</span>
            </motion.div>

            {/* Title */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.2 }}
              className="text-center space-y-2"
            >
              <h1 className="text-3xl font-bold text-foreground">Welcome to Sly</h1>
              <p className="text-muted-foreground text-sm">
                Set up your organization to get started
              </p>
            </motion.div>

            {/* Form */}
            <motion.form
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.3 }}
              onSubmit={async (e) => {
                e.preventDefault();
                if (!orgName.trim()) {
                  setError('Organization name is required');
                  return;
                }
                const code =
                  inviteCode ||
                  new URLSearchParams(window.location.search).get('invite_code') ||
                  localStorage.getItem('sly_beta_invite_code') ||
                  '';
                await provision(orgName.trim(), code || undefined);
              }}
              className="space-y-5"
            >
              {error && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  className="p-3 text-sm text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 rounded-xl"
                >
                  {error}
                </motion.div>
              )}

              <div className="space-y-2">
                <Label htmlFor="inviteCode" className="text-muted-foreground text-sm">
                  Invite Code
                </Label>
                <Input
                  id="inviteCode"
                  placeholder="beta_..."
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value)}
                  required
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="orgName" className="text-muted-foreground text-sm">
                  Organization Name
                </Label>
                <Input
                  id="orgName"
                  placeholder="Acme Inc."
                  value={orgName}
                  onChange={(e) => setOrgName(e.target.value)}
                  required
                  autoFocus
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
                />
              </div>

              <GlowButton type="submit" className="w-full" loading={provisioning}>
                Get Started
              </GlowButton>
            </motion.form>
          </motion.div>
        </div>
      </div>
    );
  }

  // ---------- Main wizard ----------
  return (
    <div className="relative min-h-screen flex flex-col">
      <SetupBackground />

      {/* Top bar: logo + progress */}
      <div className="relative z-10 w-full px-6 pt-6 pb-4">
        <div className={`${step === 3 ? 'max-w-4xl' : 'max-w-2xl'} mx-auto flex items-center justify-between transition-all`}>
          {/* Logo */}
          <div className="flex items-center gap-2">
            <div
              className="w-7 h-7 bg-blue-500"
              style={{
                WebkitMaskImage: 'url(/sly-logo.png)',
                WebkitMaskSize: 'contain',
                WebkitMaskRepeat: 'no-repeat',
                WebkitMaskPosition: 'center',
                maskImage: 'url(/sly-logo.png)',
                maskSize: 'contain',
                maskRepeat: 'no-repeat',
                maskPosition: 'center',
              }}
            />
            <span className="text-lg font-bold text-foreground">Sly</span>
          </div>
          {/* Progress */}
          <div className="flex-1 max-w-xs ml-8">
            <SetupProgress currentStep={step} completedSteps={completedSteps} />
          </div>
          {/* Theme toggle */}
          <div className="ml-4">
            <ThemeToggleSimple />
          </div>
        </div>
      </div>

      {/* Step content */}
      <div className="relative z-10 flex-1 flex items-start justify-center px-4 pt-4 pb-12 overflow-y-auto">
        <div className={`w-full ${step === 3 ? 'max-w-4xl' : 'max-w-2xl'}`}>
          {error && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              className="p-3 mb-6 text-sm text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 rounded-xl"
            >
              {error}
            </motion.div>
          )}

          <StepTransition stepKey={step}>
            {step === 1 && apiKeys && (
              <ApiKeysStep
                apiKeys={apiKeys}
                orgName={orgName}
                onNext={goToStep2}
              />
            )}
            {step === 2 && (
              <WalletsStep
                orgName={orgName}
                apiCall={apiCall}
                ensureAccount={ensureAccount}
                onNext={goToStep3}
                onSkip={goToStep3}
              />
            )}
            {step === 3 && (
              <IntegrationStep
                apiKeys={apiKeys}
                accountId={accountId}
                onComplete={goToDashboard}
              />
            )}
          </StepTransition>
        </div>
      </div>

      {/* Footer */}
      <div className="relative z-10 text-center py-4">
        <span className="text-xs text-muted-foreground/50">Step {step} of 3</span>
      </div>
    </div>
  );
}
