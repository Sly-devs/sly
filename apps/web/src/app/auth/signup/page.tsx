'use client';

import { useState, useCallback, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import { Button } from '@sly/ui';
import { Input } from '@sly/ui';
import { Label } from '@sly/ui';
import { Card, CardContent } from '@sly/ui';
import { Loader2, Send, Bot, User, ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { OAuthButtons } from '@/components/auth/oauth-buttons';
import { toast } from 'sonner';

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

  // Apply state
  const [applyEmail, setApplyEmail] = useState('');
  const [applied, setApplied] = useState(false);

  // "Already have access?" state
  const [showAccess, setShowAccess] = useState(!!initialCode);
  const [inviteCode, setInviteCode] = useState(initialCode);
  const [showEmailForm, setShowEmailForm] = useState(false);

  // Email signup state
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [success, setSuccess] = useState(false);

  async function handleApply(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`${apiUrl}/v1/auth/beta/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: applyEmail,
          applicantType: tab,
          ...(tab === 'agent' ? { agentName: 'Agent' } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to submit');
        setLoading(false);
        return;
      }
      setApplied(true);
    } catch {
      setError('Could not connect to server');
    }
    setLoading(false);
  }

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

    // Validate invite code
    if (inviteCode) {
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
          organization_name: organizationName.trim() || email.split('@')[0],
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

  // Success states
  if (applied) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-background to-primary/5 p-4">
        <Card className="w-full max-w-md">
          <CardContent className="pt-8 pb-6 text-center space-y-4">
            <div className="flex justify-center">
              <div className="rounded-full bg-green-100 dark:bg-green-900/20 p-3">
                <Send className="h-8 w-8 text-green-600" />
              </div>
            </div>
            <h2 className="text-2xl font-bold">You&apos;re on the list</h2>
            <p className="text-sm text-muted-foreground">
              We&apos;ll review your request and email you when access is ready.
            </p>
            <Button asChild variant="outline" className="w-full">
              <Link href="/auth/login">Back to Login</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-background to-primary/5 p-4">
        <Card className="w-full max-w-md">
          <CardContent className="pt-8 pb-6 text-center space-y-4">
            <div className="flex justify-center">
              <div className="rounded-full bg-green-100 dark:bg-green-900/20 p-3">
                <Send className="h-8 w-8 text-green-600" />
              </div>
            </div>
            <h2 className="text-2xl font-bold">Check your email</h2>
            <p className="text-sm text-muted-foreground">
              We&apos;ve sent you a confirmation link to complete signup.
            </p>
            <Button asChild variant="outline" className="w-full">
              <Link href="/auth/login">Back to Login</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-background to-primary/5 p-4">
      <div className="w-full max-w-md space-y-6">
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
            onClick={() => { setTab('human'); setError(null); }}
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
            onClick={() => { setTab('agent'); setError(null); }}
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
                {/* Primary: Apply for access */}
                {!showAccess && (
                  <>
                    <div className="text-center space-y-1">
                      <h3 className="font-semibold text-foreground">Request Access</h3>
                      <p className="text-xs text-muted-foreground">
                        Enter your email and we&apos;ll let you know when you&apos;re in.
                      </p>
                    </div>

                    <form onSubmit={handleApply} className="space-y-3">
                      {error && (
                        <div className="p-3 text-sm text-red-500 bg-red-50 dark:bg-red-900/20 rounded-md">
                          {error}
                        </div>
                      )}
                      <Input
                        type="email"
                        placeholder="you@example.com"
                        value={applyEmail}
                        onChange={(e) => setApplyEmail(e.target.value)}
                        required
                      />
                      <Button type="submit" className="w-full" disabled={loading}>
                        {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        Request Access
                      </Button>
                    </form>

                    {/* Already have access? */}
                    <div className="relative">
                      <div className="absolute inset-0 flex items-center">
                        <span className="w-full border-t" />
                      </div>
                      <div className="relative flex justify-center text-xs uppercase">
                        <span className="bg-card px-2 text-muted-foreground">already have access?</span>
                      </div>
                    </div>

                    <Button
                      variant="outline"
                      className="w-full"
                      onClick={() => setShowAccess(true)}
                    >
                      Sign in with invite
                    </Button>
                  </>
                )}

                {/* Secondary: SSO + email signup (for users with access) */}
                {showAccess && (
                  <>
                    <OAuthButtons mode="signup" />

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

                    <button
                      onClick={() => { setShowAccess(false); setShowEmailForm(false); setError(null); }}
                      className="w-full text-center text-xs text-muted-foreground hover:text-foreground"
                    >
                      &larr; Back to request access
                    </button>
                  </>
                )}
              </div>
            ) : (
              /* ========== AGENT PATH ========== */
              <div className="space-y-5">
                <div className="text-center space-y-2">
                  <h3 className="font-semibold text-foreground">Agent Registration</h3>
                  <p className="text-sm text-muted-foreground">
                    Read the onboarding guide — it has everything you need to register, get a wallet, and start transacting.
                  </p>
                </div>

                {/* Onboarding guide link — primary action */}
                <a
                  href={`${apiUrl}/v1/agent-onboarding`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-between w-full bg-primary text-primary-foreground rounded-lg p-4 hover:bg-primary/90 transition-colors group"
                >
                  <div className="space-y-0.5">
                    <div className="font-medium text-sm">Agent Onboarding Guide</div>
                    <div className="text-xs opacity-80">
                      Registration, wallets, payments, integration
                    </div>
                  </div>
                  <ExternalLink className="h-4 w-4 opacity-70 group-hover:opacity-100 shrink-0 ml-3" />
                </a>

                {/* Quick links */}
                <div className="grid grid-cols-3 gap-2">
                  <a
                    href={`${apiUrl}/v1/skills.md`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex flex-col items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground p-2 rounded-md hover:bg-muted transition-colors text-center"
                  >
                    <ExternalLink className="h-3 w-3" />
                    Skills
                  </a>
                  <a
                    href={`${apiUrl}/.well-known/agent.json`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex flex-col items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground p-2 rounded-md hover:bg-muted transition-colors text-center"
                  >
                    <ExternalLink className="h-3 w-3" />
                    Agent Card
                  </a>
                  <a
                    href={`${apiUrl}/v1/openapi.json`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex flex-col items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground p-2 rounded-md hover:bg-muted transition-colors text-center"
                  >
                    <ExternalLink className="h-3 w-3" />
                    API Spec
                  </a>
                </div>
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
