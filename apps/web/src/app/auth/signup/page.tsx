'use client';

import { useState, useCallback, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import { Button } from '@sly/ui';
import { Input } from '@sly/ui';
import { Label } from '@sly/ui';
import { Card, CardContent } from '@sly/ui';
import { Loader2, Zap, Send, Bot, User, Copy, Check, ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { OAuthButtons } from '@/components/auth/oauth-buttons';
import { toast } from 'sonner';

const isClosedBeta = process.env.NEXT_PUBLIC_CLOSED_BETA === 'true';
const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

export default function SignUpPage() {
  return (
    <Suspense>
      <SignUpPageInner />
    </Suspense>
  );
}

function SignUpPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialCode = searchParams.get('code') || '';
  const initialType = searchParams.get('type') === 'agent' ? 'agent' : 'human';

  const [tab, setTab] = useState<'human' | 'agent'>(initialType);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Human signup state
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [inviteCode, setInviteCode] = useState(initialCode);
  const [showEmailForm, setShowEmailForm] = useState(false);
  const [success, setSuccess] = useState(false);

  // Agent apply state
  const [agentEmail, setAgentEmail] = useState('');
  const [applicationSubmitted, setApplicationSubmitted] = useState(false);

  const curlCommand = `curl -X POST ${apiUrl}/v1/onboarding/agent/one-click \\
  -H "Content-Type: application/json" \\
  -d '{"name": "My Agent", "email": "agent@example.com"}'`;

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(curlCommand);
    setCopied(true);
    toast.success('Copied to clipboard');
    setTimeout(() => setCopied(false), 2000);
  }, [curlCommand]);

  async function handleSignup(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    if (password !== confirmPassword) {
      setError('Passwords do not match');
      setLoading(false);
      return;
    }
    if (password.length < 12) {
      setError('Password must be at least 12 characters');
      setLoading(false);
      return;
    }
    if (!organizationName.trim()) {
      setError('Organization name is required');
      setLoading(false);
      return;
    }

    // Validate invite code if closed beta
    if (isClosedBeta && inviteCode) {
      try {
        const res = await fetch(`${apiUrl}/v1/auth/beta/validate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: inviteCode }),
        });
        const json = await res.json();
        const data = json.data || json;
        if (!data.valid) {
          setError(data.error || 'Invalid invite code');
          setLoading(false);
          return;
        }
      } catch {
        setError('Could not validate invite code');
        setLoading(false);
        return;
      }
    }

    const supabase = createSupabaseBrowserClient();
    const { error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback?next=/auth/setup`,
        data: {
          organization_name: organizationName.trim(),
          name: email.split('@')[0],
          ...(inviteCode ? { invite_code: inviteCode } : {}),
        },
      },
    });

    if (signUpError) {
      setError(signUpError.message);
      setLoading(false);
      return;
    }

    setSuccess(true);
    setLoading(false);
  }

  async function handleAgentApply(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`${apiUrl}/v1/auth/beta/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: agentEmail,
          applicantType: 'agent',
          agentName: 'Agent',
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to submit');
        setLoading(false);
        return;
      }
      setApplicationSubmitted(true);
    } catch {
      setError('Could not connect to server');
    }
    setLoading(false);
  }

  // Success states
  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-background to-primary/5 p-4">
        <Card className="w-full max-w-md">
          <CardContent className="pt-8 pb-6 text-center space-y-4">
            <div className="flex justify-center">
              <div className="rounded-full bg-green-100 dark:bg-green-900/20 p-3">
                <Zap className="h-8 w-8 text-green-600" />
              </div>
            </div>
            <h2 className="text-2xl font-bold">Check your email</h2>
            <p className="text-sm text-muted-foreground">
              We&apos;ve sent you a confirmation link to complete signup.
            </p>
            <Button asChild className="w-full">
              <Link href="/auth/login">Back to Login</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (applicationSubmitted) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-background to-primary/5 p-4">
        <Card className="w-full max-w-md">
          <CardContent className="pt-8 pb-6 text-center space-y-4">
            <div className="flex justify-center">
              <div className="rounded-full bg-green-100 dark:bg-green-900/20 p-3">
                <Send className="h-8 w-8 text-green-600" />
              </div>
            </div>
            <h2 className="text-2xl font-bold">Application received</h2>
            <p className="text-sm text-muted-foreground">
              We&apos;ll review your application and email you when access is ready.
            </p>
            <Button asChild className="w-full">
              <Link href="/auth/login">Back to Login</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-background to-primary/5 p-4">
      <div className="w-full max-w-lg space-y-6">
        {/* Header */}
        <div className="text-center space-y-2">
          <div className="flex justify-center mb-4">
            <div className="flex items-center gap-2.5">
              <div
                className="w-9 h-9 bg-primary"
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
            </div>
          </div>
          <h1 className="text-3xl font-bold text-foreground">Join The Agentic Economy Platform</h1>
        </div>

        {/* Tab toggle */}
        <div className="flex gap-2">
          <button
            onClick={() => setTab('human')}
            className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium rounded-lg border transition-colors ${
              tab === 'human'
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-card text-muted-foreground border-border hover:bg-muted'
            }`}
          >
            <User className="h-4 w-4" />
            I&apos;m a Person
          </button>
          <button
            onClick={() => setTab('agent')}
            className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium rounded-lg border transition-colors ${
              tab === 'agent'
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-card text-muted-foreground border-border hover:bg-muted'
            }`}
          >
            <Bot className="h-4 w-4" />
            I&apos;m an Agent
          </button>
        </div>

        <Card>
          <CardContent className="pt-6 pb-6">
            {tab === 'human' ? (
              /* ========== HUMAN PATH ========== */
              <div className="space-y-5">
                {/* SSO buttons — primary action */}
                <OAuthButtons mode="signup" />

                {/* Divider */}
                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <span className="w-full border-t" />
                  </div>
                  <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-card px-2 text-muted-foreground">or use email</span>
                  </div>
                </div>

                {!showEmailForm ? (
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => setShowEmailForm(true)}
                  >
                    Sign up with email
                  </Button>
                ) : (
                  <form onSubmit={handleSignup} className="space-y-4">
                    {error && (
                      <div className="p-3 text-sm text-red-500 bg-red-50 dark:bg-red-900/20 rounded-md">
                        {error}
                      </div>
                    )}

                    {isClosedBeta && (
                      <div className="space-y-2">
                        <Label htmlFor="inviteCode">Invite Code</Label>
                        <Input
                          id="inviteCode"
                          placeholder="beta_..."
                          value={inviteCode}
                          onChange={(e) => setInviteCode(e.target.value)}
                          required
                        />
                      </div>
                    )}

                    <div className="space-y-2">
                      <Label htmlFor="organizationName">Organization Name</Label>
                      <Input
                        id="organizationName"
                        placeholder="Acme Inc."
                        value={organizationName}
                        onChange={(e) => setOrganizationName(e.target.value)}
                        required
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="email">Email</Label>
                      <Input
                        id="email"
                        type="email"
                        placeholder="you@example.com"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        required
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="password">Password</Label>
                      <Input
                        id="password"
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        required
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="confirmPassword">Confirm Password</Label>
                      <Input
                        id="confirmPassword"
                        type="password"
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        required
                      />
                    </div>

                    <Button type="submit" className="w-full" disabled={loading}>
                      {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      Create Account
                    </Button>
                  </form>
                )}
              </div>
            ) : (
              /* ========== AGENT PATH ========== */
              <div className="space-y-5">
                <div className="text-center space-y-2">
                  <h3 className="font-semibold text-foreground">Agent Registration</h3>
                  <p className="text-sm text-muted-foreground">
                    Everything your agent needs to register, get a wallet, and start transacting on the Sly network.
                  </p>
                </div>

                {/* Onboarding guide link — primary action */}
                <a
                  href={`${apiUrl}/v1/agent-onboarding`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-between w-full bg-muted rounded-lg p-4 hover:bg-muted/80 transition-colors group"
                >
                  <div className="space-y-1">
                    <div className="font-medium text-sm text-foreground flex items-center gap-2">
                      <Bot className="h-4 w-4 text-primary" />
                      Agent Onboarding Guide
                    </div>
                    <div className="text-xs text-muted-foreground">
                      What Sly is, how to register, payment protocols, and integration options
                    </div>
                  </div>
                  <ExternalLink className="h-4 w-4 text-muted-foreground group-hover:text-foreground shrink-0 ml-3" />
                </a>

                {/* Quick links */}
                <div className="grid grid-cols-2 gap-2">
                  <a
                    href={`${apiUrl}/v1/skills.md`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground p-2 rounded-md hover:bg-muted transition-colors"
                  >
                    <ExternalLink className="h-3 w-3" />
                    Skills manifest
                  </a>
                  <a
                    href={`${apiUrl}/.well-known/agent.json`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground p-2 rounded-md hover:bg-muted transition-colors"
                  >
                    <ExternalLink className="h-3 w-3" />
                    Platform agent card
                  </a>
                  <a
                    href={`${apiUrl}/v1/openapi.json`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground p-2 rounded-md hover:bg-muted transition-colors"
                  >
                    <ExternalLink className="h-3 w-3" />
                    OpenAPI spec
                  </a>
                  <a
                    href={`${apiUrl}/docs`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground p-2 rounded-md hover:bg-muted transition-colors"
                  >
                    <ExternalLink className="h-3 w-3" />
                    API docs
                  </a>
                </div>

                {/* Divider */}
                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <span className="w-full border-t" />
                  </div>
                  <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-card px-2 text-muted-foreground">or apply for beta</span>
                  </div>
                </div>

                {/* Simple beta apply form */}
                <form onSubmit={handleAgentApply} className="space-y-3">
                  {error && (
                    <div className="p-3 text-sm text-red-500 bg-red-50 dark:bg-red-900/20 rounded-md">
                      {error}
                    </div>
                  )}
                  <div className="flex gap-2">
                    <Input
                      type="email"
                      placeholder="agent@example.com"
                      value={agentEmail}
                      onChange={(e) => setAgentEmail(e.target.value)}
                      required
                      className="text-sm"
                    />
                    <Button type="submit" disabled={loading} className="shrink-0">
                      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Apply'}
                    </Button>
                  </div>
                </form>
              </div>
            )}

            {/* Footer */}
            <div className="mt-6 text-center text-sm text-muted-foreground">
              Already have an account?{' '}
              <Link href="/auth/login" className="text-primary hover:underline">
                Sign in
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
